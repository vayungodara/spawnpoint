import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../config.js';
import { craftyApi } from '../clients/crafty.js';
import { rconCommand } from '../clients/rcon.js';
import { serverPhase } from './phase.js';
import { isUnderMaintenance } from './maintenance.js';

// Stops any running server that has sat empty (0 players) for idleMinutes.
// Timers are in-memory; the enabled/threshold config persists in data/.

const CONFIG_FILE = join(PATHS.data, 'autostop.json');
const POLL_MS = 30_000;

export interface AutostopConfig {
  enabled: boolean;
  idleMinutes: number;
}

const DEFAULTS: AutostopConfig = { enabled: true, idleMinutes: 5 };

export function loadAutostop(): AutostopConfig {
  if (!existsSync(CONFIG_FILE)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, '')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveAutostop(cfg: AutostopConfig): AutostopConfig {
  const clean: AutostopConfig = {
    enabled: !!cfg.enabled,
    idleMinutes: Math.min(120, Math.max(1, Math.round(cfg.idleMinutes) || DEFAULTS.idleMinutes)),
  };
  mkdirSync(PATHS.data, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(clean, null, 2), 'utf8');
  if (!clean.enabled) emptySince.clear();
  return clean;
}

// server uuid -> epoch ms when we first saw it running with 0 players
const emptySince = new Map<string, number>();

export interface AutostopStatus extends AutostopConfig {
  // countdown info for the UI, per idle server
  idle: { id: string; emptyForSec: number; stopsInSec: number }[];
}

export function autostopStatus(): AutostopStatus {
  const cfg = loadAutostop();
  const now = Date.now();
  const idle = [...emptySince.entries()].map(([id, since]) => {
    const emptyForSec = Math.floor((now - since) / 1000);
    return { id, emptyForSec, stopsInSec: Math.max(0, cfg.idleMinutes * 60 - emptyForSec) };
  });
  return { ...cfg, idle };
}

async function tick(log: (msg: string) => void): Promise<void> {
  const cfg = loadAutostop();
  if (!cfg.enabled) {
    emptySince.clear();
    return;
  }
  const servers = await craftyApi.listServers();
  const seen = new Set<string>();
  for (const s of servers) {
    const id = s.server_id;
    seen.add(id);
    // a server mid-surgery (world switch, preset patch, restore) must not be
    // stopped from under the operation
    if (isUnderMaintenance(id)) {
      emptySince.delete(id);
      continue;
    }
    let stats;
    try {
      stats = await craftyApi.getStats(id);
    } catch {
      emptySince.delete(id);
      continue;
    }
    if (!stats.running || stats.waiting_start || stats.online > 0) {
      emptySince.delete(id);
      continue;
    }
    // Crafty's online count lags ~30s and reads 0 right after someone joins —
    // that once stopped a server WITH players on it. Trust only a live
    // answer from the server itself, and never count during boot.
    if ((await serverPhase(id, true)) !== 'ready') {
      emptySince.delete(id);
      continue;
    }
    try {
      const m = /There are (\d+)/i.exec(await rconCommand(id, 'list'));
      if (!m || +m[1] > 0) {
        emptySince.delete(id);
        continue;
      }
    } catch {
      emptySince.delete(id); // can't verify emptiness -> never stop on a guess
      continue;
    }
    const since = emptySince.get(id);
    if (since === undefined) {
      emptySince.set(id, Date.now());
    } else if (Date.now() - since >= cfg.idleMinutes * 60_000) {
      emptySince.delete(id);
      log(`autostop: "${s.server_name}" empty for ${cfg.idleMinutes} min — stopping`);
      await craftyApi.action(id, 'stop_server').catch((e) => log(`autostop: stop failed: ${String(e)}`));
    }
  }
  // forget servers that were deleted from Crafty
  for (const id of emptySince.keys()) if (!seen.has(id)) emptySince.delete(id);
}

export function startAutostopWatcher(log: (msg: string) => void): void {
  const timer = setInterval(() => {
    tick(log).catch((e) => log(`autostop: tick failed: ${String(e)}`));
  }, POLL_MS);
  timer.unref(); // never keep the process alive just for this
}
