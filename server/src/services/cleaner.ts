import { existsSync, readdirSync, statSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { craftyApi } from '../clients/crafty.js';
import { serverDir } from './servers.js';

// Storage cleaner: reclaims ONLY regenerable or dead data — render caches,
// loader caches, rotated logs, crash reports. It never touches world/, mods,
// configs, or anything a running server needs. Scan first (dry run with
// sizes), then clean exactly what the scan showed.

interface Target { key: string; label: string; paths: string[]; files?: string[] }

function dirSize(p: string): number {
  let total = 0;
  try {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const f = join(p, e.name);
      try {
        if (e.isDirectory()) total += dirSize(f);
        else total += statSync(f).size;
      } catch { /* transient file — skip */ }
    }
  } catch { /* unreadable dir — count as 0 */ }
  return total;
}

/** What is reclaimable on one server, and how big each piece is. */
function targetsFor(id: string): Target[] {
  const dir = serverDir(id);
  const t: Target[] = [];

  // map-render tiles: 100% regenerable image cache (BlueMap, Dynmap, squaremap)
  for (const name of ['bluemap', 'dynmap', 'squaremap']) {
    if (existsSync(join(dir, name))) {
      t.push({ key: `${name}`, label: `${name} map tiles (regenerable render cache)`, paths: [join(dir, name)] });
    }
  }

  // loader/download caches — rebuilt on next boot
  if (existsSync(join(dir, 'cache'))) {
    t.push({ key: 'cache', label: 'loader cache (rebuilt on next start)', paths: [join(dir, 'cache')] });
  }

  // rotated logs: latest.log stays, the .gz archive goes
  const logsDir = join(dir, 'logs');
  if (existsSync(logsDir)) {
    const gz = readdirSync(logsDir).filter((f) => f.endsWith('.gz')).map((f) => join(logsDir, f));
    if (gz.length > 0) t.push({ key: 'logs', label: `${gz.length} archived log files`, paths: [], files: gz });
  }

  // crash reports: useful for ~a day, dead weight after
  if (existsSync(join(dir, 'crash-reports'))) {
    t.push({ key: 'crash', label: 'crash reports', paths: [join(dir, 'crash-reports')] });
  }

  // debug profiling dumps some mods leave behind
  if (existsSync(join(dir, 'debug'))) {
    t.push({ key: 'debug', label: 'debug dumps', paths: [join(dir, 'debug')] });
  }

  return t;
}

export interface ScanItem { key: string; label: string; bytes: number }
export interface ServerScan { serverId: string; serverName: string; running: boolean; items: ScanItem[]; totalBytes: number }

export async function scanAll(): Promise<{ servers: ServerScan[]; totalBytes: number }> {
  const servers = await craftyApi.listServers();
  const out: ServerScan[] = [];
  for (const srv of servers) {
    const id = srv.server_id;
    let running = false;
    try {
      running = !!(await craftyApi.getStats(id)).running;
    } catch { /* unknown — treat as running to be safe */ running = true; }
    const items: ScanItem[] = [];
    for (const tgt of targetsFor(id)) {
      let bytes = 0;
      for (const p of tgt.paths) bytes += dirSize(p);
      for (const f of tgt.files ?? []) {
        try { bytes += statSync(f).size; } catch { /* gone already */ }
      }
      if (bytes > 0) items.push({ key: tgt.key, label: tgt.label, bytes });
    }
    if (items.length > 0) {
      out.push({
        serverId: id,
        serverName: srv.server_name,
        running,
        items,
        totalBytes: items.reduce((a, b) => a + b.bytes, 0),
      });
    }
  }
  return { servers: out, totalBytes: out.reduce((a, b) => a + b.totalBytes, 0) };
}

/** Delete the scanned categories on one server. Running servers only lose
    truly-safe targets (map tiles, crash reports, archived logs) — the live
    loader cache is left alone until the server is off. */
export async function clean(id: string, keys: string[]): Promise<{ freedBytes: number; skipped: string[] }> {
  let running = false;
  try {
    running = !!(await craftyApi.getStats(id)).running;
  } catch { running = true; }
  const unsafeWhileRunning = new Set(['cache']);
  let freed = 0;
  const skipped: string[] = [];
  for (const tgt of targetsFor(id)) {
    if (!keys.includes(tgt.key)) continue;
    if (running && unsafeWhileRunning.has(tgt.key)) {
      skipped.push(tgt.key);
      continue;
    }
    for (const p of tgt.paths) {
      freed += dirSize(p);
      rmSync(p, { recursive: true, force: true });
    }
    for (const f of tgt.files ?? []) {
      try {
        freed += statSync(f).size;
        unlinkSync(f);
      } catch { /* already gone */ }
    }
  }
  return { freedBytes: freed, skipped };
}
