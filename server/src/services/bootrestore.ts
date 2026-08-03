import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { PATHS } from '../config.js';
import { craftyApi } from '../clients/crafty.js';
import { isUnderMaintenance } from './maintenance.js';

// BOOT RESTORE — after the machine reboots (update-manager restarts, power
// cuts), bring back every Minecraft server that was running before it went
// down. Crafty's own per-server autostart is deliberately off (a crashed
// server must not boot-loop on a broken world), so the panel owns this:
//   - a 30s poller records which servers are running (data/runstate.json)
//   - panel actions update the record IMMEDIATELY (so "stop, then reboot
//     within 30s" never resurrects a server the owner just stopped)
//   - on panel startup, after a settle delay, any server recorded running but
//     found stopped is started again
// Panel DEPLOYS are safe by construction: a deploy restarts only the panel,
// the MC servers keep running, so the restore check finds them running and
// does nothing. Only a real machine reboot (or server crash while the panel
// was down) produces the recorded-running-but-stopped mismatch.
//
// Sleep needs no handling: suspended processes resume where they were.

const FILE = join(PATHS.data, 'runstate.json');
const POLL_MS = 30_000;
const RESTORE_DELAY_MS = 45_000; // let Crafty finish loading its server list
const MAX_STATE_AGE_MS = 48 * 3600_000; // ignore a record from another era

interface RunState {
  servers: Record<string, boolean>; // id -> was running
  updatedAt: string;
}

function loadState(): RunState | null {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    return { servers: raw.servers ?? {}, updatedAt: raw.updatedAt ?? '' };
  } catch {
    return null;
  }
}

function saveState(st: RunState): void {
  mkdirSync(PATHS.data, { recursive: true });
  writeFileSync(FILE, JSON.stringify(st, null, 2), 'utf8');
}

/** Called by the action route the moment the panel starts/stops a server, so
    the record is never 30s stale when it matters most. */
export function markRunning(id: string, running: boolean): void {
  recentMarks.set(id, { running, at: Date.now() });
  const st = loadState() ?? { servers: {}, updatedAt: '' };
  st.servers[id] = running;
  st.updatedAt = new Date().toISOString();
  saveState(st);
}

// explicit panel start/stop marks made while a poll pass was mid-flight — the
// poll re-applies them before saving so its stale snapshot can't clobber them
const recentMarks = new Map<string, { running: boolean; at: number }>();

async function poll(): Promise<void> {
  const pollStart = Date.now();
  const servers = await craftyApi.listServers();
  const st: RunState = { servers: {}, updatedAt: new Date().toISOString() };
  for (const srv of servers) {
    try {
      st.servers[srv.server_id] = (await craftyApi.getStats(srv.server_id)).running === true;
    } catch {
      // unknown state: keep the previous record rather than inventing one
      const prev = loadState();
      if (prev && srv.server_id in prev.servers) st.servers[srv.server_id] = prev.servers[srv.server_id];
    }
  }
  // a mark placed AFTER this pass started is fresher than anything we read
  for (const [id, m] of recentMarks) {
    if (m.at >= pollStart) st.servers[id] = m.running;
    else recentMarks.delete(id);
  }
  saveState(st);
}

async function restore(st: RunState | null, log: (m: string) => void): Promise<void> {
  if (!st) return; // first ever run — nothing recorded yet
  if (st.updatedAt && Date.now() - new Date(st.updatedAt).getTime() > MAX_STATE_AGE_MS) {
    log('bootrestore: run state too old — not restoring from it');
    return;
  }
  // ONLY a real machine reboot may restore. A record written AFTER this
  // machine booted means the panel merely restarted (deploy) — and the
  // stopped-but-marked case there is NOT a crash to heal, it's the ≤30s
  // stale window around an autostop: restoring from it resurrected a server
  // the box had just put to sleep (live 2026-07-20, main started itself).
  const bootTime = Date.now() - os.uptime() * 1000;
  if (st.updatedAt && new Date(st.updatedAt).getTime() > bootTime + 60_000) {
    return; // panel restart, not a reboot — the servers are as they should be
  }
  const wanted = Object.entries(st.servers).filter(([, r]) => r).map(([id]) => id);
  if (!wanted.length) return;

  let servers;
  try {
    servers = await craftyApi.listServers();
  } catch {
    log('bootrestore: Crafty not reachable yet — skipping restore this boot');
    return;
  }
  const known = new Set(servers.map((s) => s.server_id));
  for (const id of wanted) {
    if (!known.has(id) || isUnderMaintenance(id)) continue;
    try {
      const stats = await craftyApi.getStats(id);
      if (stats.running) continue; // deploy restart, not a reboot — leave it be
      const name = servers.find((s) => s.server_id === id)?.server_name ?? id;
      log(`bootrestore: "${name}" was running before the shutdown — starting it again`);
      await craftyApi.action(id, 'start_server');
    } catch (e) {
      log(`bootrestore: could not restore ${id}: ${String(e).slice(0, 120)}`);
    }
  }
}

export function startBootRestore(log: (msg: string) => void): void {
  // CAPTURE THE PRE-BOOT RECORD SYNCHRONOUSLY, before the first poll can
  // overwrite it. The original code read the file inside restore() at t=45s —
  // by which time the t=30s poll had already recorded every server as stopped,
  // so restore never restored anything (caught in code review, never in a
  // real reboot: the one path this module exists for was the one untested).
  const preBoot = loadState();
  const once = setTimeout(() => {
    restore(preBoot, log).catch((e) => log(`bootrestore: restore failed: ${String(e)}`));
  }, RESTORE_DELAY_MS);
  once.unref();
  const timer = setInterval(() => {
    poll().catch(() => {});
  }, POLL_MS);
  timer.unref();
}
