import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS, craftyToken } from '../config.js';
import { craftyApi } from '../clients/crafty.js';
import { rconCommand } from '../clients/rcon.js';

// CRAFTY WATCHDOG — on 2026-07-20 Crafty wedged silently: port 8443 kept
// listening but its accept queue filled (129/128) and every panel command
// timed out; a "stopped" server ran on for hours. Zero-noise rule: that
// failure class gets a self-healing watcher, not a surprised owner.
//
//  - probe: listServers with a hard 8s cap, every 60s
//  - 3 consecutive failures = wedged (one blip is a busy box, not a patient)
//  - NEVER restart Crafty while anyone is in-game: the MC servers are its
//    children and die with it. Player check goes over RCON, which does not
//    pass through Crafty — RCON is truth, especially when Crafty is the liar.
//  - 15 min cooldown between restarts so a truly broken Crafty cannot flap.

const PROBE_MS = 60_000;
const PROBE_TIMEOUT_MS = 8_000;
const FAILS_TO_ACT = 3;
const COOLDOWN_MS = 15 * 60_000;

let consecutiveFails = 0;
let lastRestartAt = 0;

async function probe(): Promise<boolean> {
  // pre-wizard install: no token means "not connected yet", not "wedged" —
  // a doctor must not restart a Crafty the panel was never introduced to
  if (!craftyToken()) return true;
  try {
    await Promise.race([
      craftyApi.listServers(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('probe timeout')), PROBE_TIMEOUT_MS)),
    ]);
    return true;
  } catch {
    return false;
  }
}

/** true if ANY server answers RCON with players online. Unreachable RCON =
    server not running = not a blocker. */
async function anyPlayersOnline(): Promise<boolean> {
  let ids: string[] = [];
  try {
    ids = readdirSync(PATHS.craftyServers).filter((d) => existsSync(join(PATHS.craftyServers, d, 'server.properties')));
  } catch {
    return false;
  }
  for (const id of ids) {
    try {
      const res = await rconCommand(id, 'list', { timeout: 4000 });
      const m = /There are (\d+)/i.exec(res);
      if (m && parseInt(m[1], 10) > 0) return true;
    } catch { /* not running — fine */ }
  }
  return false;
}

export function startCraftyDoctor(log: (msg: string) => void): void {
  const tick = async (): Promise<void> => {
    if (await probe()) {
      if (consecutiveFails >= FAILS_TO_ACT) log('craftydoctor: Crafty is answering again');
      consecutiveFails = 0;
      return;
    }
    consecutiveFails++;
    if (consecutiveFails < FAILS_TO_ACT) return;
    if (Date.now() - lastRestartAt < COOLDOWN_MS) {
      log(`craftydoctor: Crafty still wedged (${consecutiveFails} fails) — in cooldown, not restarting`);
      return;
    }
    if (await anyPlayersOnline()) {
      log('craftydoctor: Crafty is wedged but players are ONLINE — waiting (a restart would kick them)');
      return;
    }
    log(`craftydoctor: Crafty unresponsive ${consecutiveFails}x and nobody online — restarting crafty.service`);
    lastRestartAt = Date.now();
    consecutiveFails = 0;
    if (process.platform !== 'linux') {
      log('craftydoctor: Crafty looks wedged but auto-restart only knows systemd — restart Crafty manually');
      return;
    }
    try {
      execFileSync('systemctl', ['restart', 'crafty'], { timeout: 60_000 });
      log('craftydoctor: crafty.service restarted');
    } catch (e) {
      log(`craftydoctor: restart FAILED: ${String(e).slice(0, 150)}`);
    }
  };
  const timer = setInterval(() => {
    tick().catch(() => {});
  }, PROBE_MS);
  timer.unref();
}
