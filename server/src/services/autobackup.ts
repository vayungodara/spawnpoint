import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../config.js';
import { craftyApi } from '../clients/crafty.js';
import { serverDir } from './servers.js';
import { createBackup, listBackups } from './maintenance.js';

// Nightly automatic world backups, storage-conscious by design:
//  - world-only zips (mods/configs are re-downloadable; the world is not)
//  - a server is only backed up when its world actually CHANGED since the
//    newest backup (level.dat mtime) — idle servers cost zero bytes
//  - hard retention per server (default 3) on top of manual backups

const CONFIG_FILE = join(PATHS.data, 'autobackup.json');

export interface AutobackupConfig {
  enabled: boolean;
  hour: number; // local hour 0-23 to run at
  keep: number; // newest N zips kept per server
  lastRunDay?: string; // YYYY-MM-DD guard so one firing per day
}

const DEFAULTS: AutobackupConfig = { enabled: false, hour: 4, keep: 3 };

export function loadAutobackup(): AutobackupConfig {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, ''));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveAutobackup(cfg: Partial<AutobackupConfig>): AutobackupConfig {
  const cur = loadAutobackup();
  const clean: AutobackupConfig = {
    enabled: !!(cfg.enabled ?? cur.enabled),
    hour: Math.min(23, Math.max(0, Math.round(Number(cfg.hour ?? cur.hour) || 4))),
    keep: Math.min(10, Math.max(1, Math.round(Number(cfg.keep ?? cur.keep) || 3))),
    lastRunDay: cur.lastRunDay,
  };
  mkdirSync(PATHS.data, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}

function markRan(day: string): void {
  const cfg = loadAutobackup();
  cfg.lastRunDay = day;
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

function worldChangedSince(uuid: string, sinceIso: string | null): boolean {
  const level = join(serverDir(uuid), 'world', 'level.dat');
  if (!existsSync(level)) return false; // no world -> nothing to back up
  if (!sinceIso) return true; // never backed up
  return statSync(level).mtime.toISOString() > sinceIso;
}

function trim(uuid: string, keep: number): void {
  const dir = join(PATHS.root, 'Backups', 'panel', uuid);
  for (const old of listBackups(uuid).slice(keep)) {
    try { unlinkSync(join(dir, old.file)); } catch { /* locked - next round */ }
  }
}

async function runOnce(log: (msg: string) => void): Promise<void> {
  const cfg = loadAutobackup();
  const servers = await craftyApi.listServers();
  for (const srv of servers) {
    const id = srv.server_id;
    try {
      const newest = listBackups(id)[0]?.createdAt ?? null;
      if (!worldChangedSince(id, newest)) continue; // idle since last backup
      const res = await createBackup(id);
      if ('error' in res) log(`autobackup: ${srv.server_name}: ${res.error}`);
      else log(`autobackup: ${srv.server_name} -> ${res.file} (${res.sizeMb} MB)`);
      trim(id, cfg.keep);
    } catch (e) {
      log(`autobackup: ${srv.server_name} failed: ${String(e)}`);
    }
  }
}

export function startAutobackup(log: (msg: string) => void): void {
  const timer = setInterval(() => {
    const cfg = loadAutobackup();
    if (!cfg.enabled) return;
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getHours() !== cfg.hour || cfg.lastRunDay === day) return;
    markRan(day);
    runOnce(log).catch((e) => log(`autobackup: run failed: ${String(e)}`));
  }, 5 * 60_000);
  timer.unref();
}
