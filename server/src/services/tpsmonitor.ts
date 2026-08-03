import { craftyApi } from '../clients/crafty.js';
import { rconCommand } from '../clients/rcon.js';
import { serverPhase } from './phase.js';
import { detect } from './detect.js';
import { serverDir } from './servers.js';
import { atLeast } from './mcversion.js';
import { isPluginLoader } from '../clients/modrinth.js';

// TPS / MSPT history, sampled over RCON while a server is joinable.
//
// THERE IS NO SINGLE COMMAND THAT WORKS EVERYWHERE.
//   `tick query`  vanilla, but ONLY from 1.20.3 — on 1.20.1 it answers
//                 "Unknown or incomplete command" and we sampled nothing, forever.
//                 That is why the TPS row was permanently empty on the Forge
//                 1.20.1 server: one hardcoded command for a 6-year version range.
//   `forge tps`   Forge/NeoForge, every version.
//   `tps`         Bukkit family (paper/spigot/purpur/folia), every version.
//   `spark tps`   only if the Spark mod/plugin is installed. Last resort.
//
// So: pick candidates from the server's real loader + MC version, probe them in
// order, and remember which one answered. If none do, say so — an empty chart
// with no explanation is the panel lying by omission.

interface Sample { t: number; mspt: number | null; tps: number }
type Source = 'tick' | 'forge' | 'bukkit' | 'spark';

const HISTORY = new Map<string, Sample[]>();
const SOURCE = new Map<string, Source | 'none'>();
const MAX_SAMPLES = 90; // 90 × 20s = 30 minutes
const SAMPLE_MS = 20_000;

export function tpsHistory(id: string): Sample[] {
  return HISTORY.get(id) ?? [];
}

/** What the panel is reading TPS from, so the UI can explain an empty chart
 *  instead of just showing a blank box. */
export function tpsSource(id: string): { source: Source | 'none' | 'unknown'; reason?: string } {
  const s = SOURCE.get(id);
  if (!s) return { source: 'unknown' };
  if (s === 'none') {
    return {
      source: 'none',
      reason:
        'This Minecraft version has no built-in tick command (`tick query` arrived in 1.20.3) and no TPS source was found. Install the Spark mod to see TPS here.',
    };
  }
  return { source: s };
}

/** Minecraft prints numbers in the SERVER's locale. Forge on this box answers
 *  "Mean tick time: 0,518 ms. Mean TPS: 20,000" — comma as the DECIMAL point.
 *  Number("0,518") is NaN and parseFloat("20,000") is 20, so a naive parse either
 *  drops the sample or reads 0.518ms as 518ms. Handle both conventions: the LAST
 *  separator is the decimal point, anything before it is digit grouping. */
export function parseLocaleNumber(raw: string | undefined): number {
  if (!raw) return NaN;
  const s = raw.trim();
  const dec = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
  if (dec < 0) return Number(s);
  const whole = s.slice(0, dec).replace(/[.,\s]/g, '');
  return Number(`${whole || '0'}.${s.slice(dec + 1)}`);
}

const strip = (s: string) => s.replace(/§./g, ''); // Bukkit colours its output

const UNKNOWN = /Unknown or incomplete command|Unknown command|Incorrect argument/i;

/** Which commands could plausibly answer on this server, best first. */
function candidates(mc: string | null, loader: string | undefined): Source[] {
  const list: Source[] = [];
  if (atLeast(mc, '1.20.3')) list.push('tick'); // vanilla, works on every loader
  if (loader === 'forge' || loader === 'neoforge') list.push('forge');
  if (isPluginLoader(loader)) list.push('bukkit');
  if (!atLeast(mc, '1.20.3')) list.push('tick'); // detection may be wrong; try anyway
  list.push('spark'); // present or not, it costs one probe
  return [...new Set(list)];
}

/** Ask one source. Returns null if that source is not available here. */
async function read(id: string, src: Source): Promise<Sample | null> {
  const out = strip(await rconCommand(id, CMD[src]));
  if (!out || UNKNOWN.test(out)) return null;

  if (src === 'tick') {
    // "Target tick rate: 20.0 per second. Average time per tick: 3.2ms (Target: 50.0ms)"
    const mspt = parseLocaleNumber(/Average time per tick:\s*([\d.,]+)\s*ms/i.exec(out)?.[1]);
    const target = parseLocaleNumber(/Target tick rate:\s*([\d.,]+)/i.exec(out)?.[1]) || 20;
    if (!Number.isFinite(mspt)) return null;
    return { t: Date.now(), mspt, tps: Math.min(target, 1000 / Math.max(mspt, 1000 / target / 4)) };
  }

  if (src === 'forge') {
    // "Overall: Mean tick time: 0,518 ms. Mean TPS: 20,000"  (VERIFIED on 1.20.1)
    const m = /Overall:\s*Mean tick time:\s*([\d.,]+)\s*ms.*?Mean TPS:\s*([\d.,]+)/is.exec(out);
    if (!m) return null;
    const mspt = parseLocaleNumber(m[1]);
    const tps = parseLocaleNumber(m[2]);
    if (!Number.isFinite(tps)) return null;
    return { t: Date.now(), mspt: Number.isFinite(mspt) ? mspt : null, tps };
  }

  // bukkit: "TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0"
  // spark:  "TPS from last 5s, 10s, 1m, 5m, 15m: 20.0, 20.0, ..."
  const tps = parseLocaleNumber(/TPS from last[^:]*:\s*\*?([\d.,]+)/i.exec(out)?.[1]);
  if (!Number.isFinite(tps)) return null;
  // Neither prints MSPT here. Do NOT derive it from TPS: at a healthy 20 TPS that
  // yields a flat 50ms, which is the tick BUDGET, not the tick TIME — a made-up
  // number that looks like a measurement. Report it as unknown.
  return { t: Date.now(), mspt: null, tps };
}

const CMD: Record<Source, string> = {
  tick: 'tick query',
  forge: 'forge tps',
  bukkit: 'tps',
  spark: 'spark tps',
};

async function sample(id: string): Promise<void> {
  const known = SOURCE.get(id);
  if (known === 'none') return; // already established there is nothing to read

  let s: Sample | null = null;
  if (known) {
    s = await read(id, known).catch(() => null);
    if (!s) SOURCE.delete(id); // it stopped answering (mod removed, version switched) — re-probe
  }

  if (!s) {
    const { loader, mc } = detect(serverDir(id), id);
    for (const src of candidates(mc, loader)) {
      s = await read(id, src).catch(() => null);
      if (s) {
        SOURCE.set(id, src);
        break;
      }
    }
    if (!s) {
      SOURCE.set(id, 'none');
      return;
    }
  }

  const arr = HISTORY.get(id) ?? [];
  arr.push({
    t: s.t,
    mspt: s.mspt === null ? null : Math.round(s.mspt * 10) / 10,
    tps: Math.round(s.tps * 10) / 10,
  });
  if (arr.length > MAX_SAMPLES) arr.splice(0, arr.length - MAX_SAMPLES);
  HISTORY.set(id, arr);
}

async function tick(log: (m: string) => void): Promise<void> {
  // sample every server the panel is actively watching (genie-enabled or not —
  // any running+ready server gets a pulse)
  let servers;
  try {
    servers = await craftyApi.listServers();
  } catch {
    return;
  }
  for (const srv of servers) {
    const id = srv.server_id;
    try {
      const stats = await craftyApi.getStats(id);
      if (!stats.running) {
        HISTORY.delete(id);
        SOURCE.delete(id); // a restart may change version/mods — re-probe next time
        continue;
      }
      if ((await serverPhase(id, true)) !== 'ready') continue;
      await sample(id);
    } catch {
      /* sampling is best-effort */
    }
  }
}

export function startTpsMonitor(log: (msg: string) => void): void {
  const timer = setInterval(() => {
    tick(log).catch(() => {});
  }, SAMPLE_MS);
  timer.unref();
}
