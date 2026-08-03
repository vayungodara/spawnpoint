import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../config.js';
import { craftyApi } from '../clients/crafty.js';
import { rconBatch } from '../clients/rcon.js';
import { serverPhase } from './phase.js';
import { tpsHistory } from './tpsmonitor.js';

// In-game server HUD, pure vanilla (no client mods): a SPAWNPOINT boss bar
// at the top of the screen — verdict · TPS · tick time · RAM · CPU, fill =
// % of the 50ms tick budget in use, color = green/yellow/red. Hidden for
// everyone by default; each player opts in or out with /trigger hud
// (membership in team sp_show).
//
// THE VERDICT IS TICK-DRIVEN. The old one compared process RSS against -Xmx,
// which is not a health signal at all: a modded JVM idles ~1.5GB above heap,
// and with Aikar's -Xms=-Xmx+AlwaysPreTouch the heap is FULLY committed at
// boot — the HUD would scream STRESSED forever on a server ticking in 4ms.
// Tick time is the one number that IS server performance; memory/CPU are
// shown as info but judge nothing. Samples come from tpsmonitor (multi-source:
// tick query / forge tps / bukkit tps / spark), refreshed every 20s.
//
// All commands for a tick ride ONE RCON connection (rconBatch): vanilla logs
// two console lines per connection, so per-command connections drowned the
// server log. Command feedback comes back over RCON, not the console.

const CONFIG_FILE = join(PATHS.data, 'ingamehud.json');
const BAR_ID = 'spawnpoint:stats';
const POLL_MS = 5_000;

export interface HudConfig {
  enabled: boolean;
}

const DEFAULTS: HudConfig = { enabled: false };

export function loadHud(): HudConfig {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, ''));
    return { enabled: !!raw.enabled };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveHud(cfg: HudConfig): HudConfig {
  const clean: HudConfig = { enabled: !!cfg.enabled };
  mkdirSync(PATHS.data, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}

// per-server in-memory state (dies with the panel; surfaces are rebuilt)
const toggleLive = new Set<string>(); // /trigger hud plumbing installed
const barLive = new Set<string>();
const lastBar = new Map<string, { name: string; color: string; value: number }>();

function heapGbFromCommand(cmd: string): number | null {
  const m = /-Xmx(\d+)([GgMm])/.exec(cmd);
  if (!m) return null;
  return m[2].toLowerCase() === 'g' ? +m[1] : Math.round(+m[1] / 1024);
}

interface Snapshot {
  memBytes: number | null;
  allocGb: number | null;
  cpu: number;
  mspt: number | null;
  tps: number | null;
  fill: number; // bossbar value: % of tick budget used (fallback: cpu)
  verdict: string;
  color: string;
}

const TICK_BUDGET_MS = 50;

async function snapshot(id: string, execCmd: string, stats: Awaited<ReturnType<typeof craftyApi.getStats>>): Promise<Snapshot> {
  const memBytes = typeof stats.mem === 'number' ? stats.mem : null;
  const allocGb = heapGbFromCommand(execCmd);
  const cpu = Math.round(stats.cpu ?? 0);

  // hard red flag: the server itself said it's behind, recently
  let behind = false;
  try {
    const lines = (await craftyApi.getLogs(id)).slice(-120);
    const now = new Date();
    for (const ln of lines) {
      if (!ln.includes("Can't keep up")) continue;
      const m = ln.match(/^\[(\d\d):(\d\d):(\d\d)\]/);
      if (!m) continue;
      const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), +m[1], +m[2], +m[3]).getTime();
      if (now.getTime() - t < 2 * 60_000 && now.getTime() - t >= 0) behind = true;
    }
  } catch { /* logs unavailable */ }

  // freshest tick sample the monitor has (20s cadence; 90s = stale/boot)
  const samples = tpsHistory(id);
  const last = samples[samples.length - 1];
  const fresh = last && Date.now() - last.t < 90_000 ? last : null;
  const mspt = fresh?.mspt ?? null;
  const tps = fresh?.tps ?? null;

  let verdict: string;
  let color: string;
  if (behind) {
    [verdict, color] = ['LAGGING', 'red'];
  } else if (mspt !== null) {
    if (mspt >= TICK_BUDGET_MS) [verdict, color] = ['LAGGING', 'red'];
    else if (mspt >= TICK_BUDGET_MS * 0.8) [verdict, color] = ['BUSY', 'yellow'];
    else [verdict, color] = ['SMOOTH', 'green'];
  } else if (tps !== null) {
    // bukkit/spark report TPS without mspt — TPS only sags once the budget is
    // ALREADY blown, so grade tighter
    if (tps < 15) [verdict, color] = ['LAGGING', 'red'];
    else if (tps < 19.5) [verdict, color] = ['BUSY', 'yellow'];
    else [verdict, color] = ['SMOOTH', 'green'];
  } else {
    // no tick source at all (just booted, or an old server without one) —
    // never invent a verdict from memory; CPU is the only honest hint left
    [verdict, color] = cpu > 90 ? ['BUSY', 'yellow'] : ['MEASURING', 'blue'];
  }

  const fill =
    mspt !== null
      ? Math.min(100, Math.max(1, Math.round((mspt / TICK_BUDGET_MS) * 100)))
      : tps !== null
        ? Math.min(100, Math.max(1, Math.round((1 - Math.min(tps, 20) / 20) * 100)))
        : Math.min(100, Math.max(1, cpu));

  return { memBytes, allocGb, cpu, mspt, tps, fill, verdict, color };
}

/** Per-player opt-IN: `/trigger hud` flips your membership in team sp_show.
    The boss bar only targets @a[team=sp_show], so by default nobody sees
    anything. T, ↑, Enter = almost a keybind. */
function pumpToggle(cmds: string[], id: string): void {
  if (!toggleLive.has(id)) {
    // sweep surfaces from earlier HUD versions (sidebar + opt-out design)
    cmds.push(
      `scoreboard objectives remove sp_toggle`,
      `scoreboard objectives remove sp_hud`,
      `team remove sp_view`,
      `team remove sp_hidden`,
      ...Array.from({ length: 8 }, (_, i) => `team remove sp_ln${i}`),
      `scoreboard objectives add hud trigger`,
      `scoreboard objectives add sp_state dummy`,
      `team add sp_show`,
    );
  }
  cmds.push(
    `execute as @a[scores={hud=1..},team=sp_show] run scoreboard players set @s sp_state 1`,
    `tellraw @a[scores={hud=1..},team=!sp_show] {"text":"⚑ SPAWNPOINT HUD on — /trigger hud to hide","color":"green"}`,
    `execute as @a[scores={hud=1..},team=!sp_show] run team join sp_show @s`,
    `execute as @a[scores={sp_state=1..}] run team leave @s`,
    `tellraw @a[scores={sp_state=1..}] {"text":"⚑ SPAWNPOINT HUD off","color":"gray"}`,
    `scoreboard players reset @a hud`,
    `scoreboard players reset @a sp_state`,
    // enable LAST: reset also clears the enabled flag, so enabling at the
    // start of the cycle would leave the trigger dead between ticks
    `scoreboard players enable @a hud`,
  );
}

function pumpBossbar(cmds: string[], id: string, s: Snapshot): void {
  // NARROW on purpose: long bossbar names stretch under client minimaps
  // (owner request 2026-07-18; RAM re-added same day, compact form). Fill bar
  // already carries tick-budget %.
  const ram = s.memBytes ? ` · ${(s.memBytes / 1e9).toFixed(1)}G` : '';
  const perf =
    s.mspt !== null
      ? ` · ${s.mspt.toFixed(1)}ms`
      : s.tps !== null
        ? ` · TPS ${s.tps.toFixed(1)}`
        : '';
  const name = `✦ ${s.verdict}${perf}${ram} · CPU ${s.cpu}%`;
  const value = s.fill;
  const prev = lastBar.get(id);
  if (!barLive.has(id)) {
    cmds.push(
      `bossbar add ${BAR_ID} "${name}"`,
      `bossbar set ${BAR_ID} max 100`,
      `bossbar set ${BAR_ID} visible true`,
    );
    lastBar.delete(id);
  }
  if (prev?.name !== name) cmds.push(`bossbar set ${BAR_ID} name "${name}"`);
  if (prev?.color !== s.color) cmds.push(`bossbar set ${BAR_ID} color ${s.color}`);
  if (prev?.value !== value) cmds.push(`bossbar set ${BAR_ID} value ${value}`);
  cmds.push(`bossbar set ${BAR_ID} players @a[team=sp_show]`); // opt-ins only
  lastBar.set(id, { name, color: s.color, value });
}

async function tick(log: (msg: string) => void): Promise<void> {
  const cfg = loadHud();
  const servers = await craftyApi.listServers();
  for (const srv of servers) {
    const id = srv.server_id;
    let stats;
    try {
      stats = await craftyApi.getStats(id);
    } catch {
      continue;
    }
    if (!stats.running) {
      // surfaces die with the server; rebuild next boot
      barLive.delete(id); lastBar.delete(id); toggleLive.delete(id);
      continue;
    }
    try {
      if ((await serverPhase(id, true)) !== 'ready') continue;

      if (!cfg.enabled) {
        if (barLive.has(id)) {
          await rconBatch(id, [`bossbar remove ${BAR_ID}`]);
          barLive.delete(id); lastBar.delete(id);
        }
        continue;
      }

      const cmds: string[] = ['list'];
      const [listOut] = await rconBatch(id, cmds);
      const m = /There are (\d+)/i.exec(listOut);
      if (!m || +m[1] < 1) continue; // empty server — stay silent

      const batch: string[] = [];
      const hadSetup = toggleLive.has(id);
      const hadBar = barLive.has(id);
      pumpToggle(batch, id);
      const s = await snapshot(id, srv.execution_command, stats);
      pumpBossbar(batch, id, s);
      await rconBatch(id, batch);
      if (!hadSetup) toggleLive.add(id);
      if (!hadBar) barLive.add(id);
    } catch (e) {
      log(`ingamehud: update failed for ${srv.server_name}: ${String(e)}`);
      barLive.delete(id); lastBar.delete(id);
    }
  }
}

let hudBusy = false;
export function startIngameHud(log: (msg: string) => void): void {
  const timer = setInterval(() => {
    // a slow Crafty response can outlast the 5s interval — overlapping ticks
    // raced the shared bar-state maps and left stale bossbar text on screen
    if (hudBusy) return;
    hudBusy = true;
    tick(log)
      .catch((e) => log(`ingamehud: tick failed: ${String(e)}`))
      .finally(() => { hudBusy = false; });
  }, POLL_MS);
  timer.unref();
}
