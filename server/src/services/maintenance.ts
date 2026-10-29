import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../config.js';
import { serverDir } from './servers.js';
import { craftyApi } from '../clients/crafty.js';
import { readProperties } from './properties.js';
import { serverPhase, forgetReady, bootedSince } from './phase.js';
import { moveDir, portListening, stageAndZipWorld, unzipTo, writeFileAtomic } from './platform.js';

async function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** True only when Crafty says stopped AND nothing listens on the MC port. */
export async function fullyStopped(uuid: string): Promise<boolean> {
  try {
    const stats = await craftyApi.getStats(uuid);
    if (stats.running || stats.waiting_start) return false;
  } catch {
    return false;
  }
  try {
    // belt-and-braces: check the server's OWN port really closed (java can
    // outlive Crafty's "stopped"). This was hardcoded to 25565 — so for any
    // server on another port it actually polled whoever held 25565 (usually the
    // running main server) and reported "still up" forever, making stopAndWait
    // time out on EVERY non-25565 server (version switch, player reset, world
    // switch all inherited it). Read the port from the server's own properties.
    const port = parseInt(readProperties(uuid)['server-port'] ?? '25565', 10) || 25565;
    return !(await portListening(port));
  } catch {
    return false; // no listener proof means no permission to mutate the pack
  }
}

// A server under maintenance (preset patch, world switch/reset, restore) is
// mid-surgery with its files moving around. The scheduler and autostop MUST
// NOT start or stop it in that window — a scheduled start once booted a server
// while its level.dat patch was still pending, and the running server rewrote
// the file from memory on shutdown, silently undoing the change.
// The set is kept on disk: an entry left by an earlier panel process means
// that operation was cut short, and the server stays fenced until the owner
// has looked at it and cleared it (or the operation resumes itself).
// One operation holds a server at a time: beginMaintenance refuses while
// another holds it, and endMaintenance only ends the caller's own fence.
export interface Maintenance {
  op: string;
  since: string;
  pid: number;
  /** why the operation stopped part-way and left the server for the owner */
  note?: string;
}
const MAINTENANCE_FILE = join(PATHS.data, 'maintenance.json');
const underMaintenance: Map<string, Maintenance> = (() => {
  try { return new Map(Object.entries(JSON.parse(readFileSync(MAINTENANCE_FILE, 'utf8')) as Record<string, Maintenance>)); } catch { return new Map(); }
})();
const saveMaintenance = (): void => writeFileAtomic(MAINTENANCE_FILE, JSON.stringify(Object.fromEntries(underMaintenance), null, 1));

/** Fence a server for `op`. Returns why not when another operation holds it. */
export function beginMaintenance(uuid: string, op: string): string | null {
  const busy = busyReason(uuid);
  if (busy) return busy;
  underMaintenance.set(uuid, { op, since: new Date().toISOString(), pid: process.pid });
  saveMaintenance();
  return null;
}
/** End `op`'s fence. A fence another operation holds stays. */
export function endMaintenance(uuid: string, op: string): void {
  if (underMaintenance.get(uuid)?.op === op && underMaintenance.delete(uuid)) saveMaintenance();
}
/** `op` could not finish safely: keep the server fenced until the owner has looked. */
export function strandMaintenance(uuid: string, op: string, note: string): void {
  const m = underMaintenance.get(uuid);
  if (m?.op !== op) return;
  underMaintenance.set(uuid, { ...m, note });
  saveMaintenance();
}
/** The owner checked a server an operation left part-way. False while it still runs. */
export function clearInterrupted(uuid: string): boolean {
  if (!maintenanceOf(uuid)?.interrupted) return false;
  underMaintenance.delete(uuid);
  saveMaintenance();
  return true;
}
export function isUnderMaintenance(uuid: string): boolean { return underMaintenance.has(uuid); }
/** The operation a server is fenced for; `interrupted` when it stopped part-way
    (a panel restart cut it short, or it gave up) and waits for the owner. */
export function maintenanceOf(uuid: string): (Maintenance & { interrupted: boolean }) | null {
  const m = underMaintenance.get(uuid);
  return m ? { ...m, interrupted: m.pid !== process.pid || !!m.note } : null;
}
/** Why the server cannot be started, stopped or changed right now, or null. */
export function busyReason(uuid: string): string | null {
  const m = maintenanceOf(uuid);
  if (!m) return null;
  return m.interrupted
    ? `a ${m.op} ${m.note ? `stopped part-way (${m.note})` : 'was cut short by a panel restart'}; check the server, then clear the warning on the dashboard`
    : `the server is busy (${m.op}); try again in a minute`;
}

/** Is the server running? FAIL-SAFE: a Crafty API error answers "yes".
    Every destructive path (world reset, restore, player wipe, level.dat patch)
    asks this before touching files. The old `.catch(() => false)` treated a
    Crafty hiccup as "stopped" and would have deleted the world out from under
    a LIVE server. When in doubt, assume the server is up and refuse. */
export async function isRunningSafe(uuid: string): Promise<boolean> {
  try {
    const s = await craftyApi.getStats(uuid);
    return !!(s.running || s.waiting_start);
  } catch {
    return true;
  }
}

/** After a start: true once players can join, false if the server died or
    did not come up within the timeout. With `since` (when the start was
    sent), only proof from that boot counts (see bootedSince). */
export async function waitForReady(uuid: string, timeoutSec: number, since?: number): Promise<boolean> {
  forgetReady(uuid); // "ready" from before the restart says nothing about this boot
  const started = Date.now();
  const latestLog = join(serverDir(uuid), 'logs', 'latest.log');
  while (Date.now() - started < timeoutSec * 1000) {
    await pause(5000);
    try {
      const stats = await craftyApi.getStats(uuid);
      // Crafty can report stopped for a few seconds before the process shows up
      if (!stats.running && !stats.waiting_start && Date.now() - started > 30_000) return false;
      if (!stats.running) continue;
      if (since === undefined ? (await serverPhase(uuid, true)) === 'ready' : await bootedSince(uuid, latestLog, since)) return true;
    } catch { /* keep waiting */ }
  }
  return false;
}

/** Stop a server and WAIT until the java process is genuinely gone. */
export async function stopAndWait(uuid: string, timeoutSec = 90): Promise<boolean> {
  await craftyApi.action(uuid, 'stop_server').catch(() => {});
  for (let i = 0; i < timeoutSec / 3; i++) {
    await pause(3000);
    if (await fullyStopped(uuid)) {
      forgetReady(uuid);
      await pause(4000); // final file-flush grace period
      return true;
    }
  }
  return false;
}

export interface ResetResult {
  ok: boolean;
  wiped: string[];
  restarted: boolean;
  error?: string;
}

/** Wipe all player progress (inventories, XP, position, advancements, stats).
    Terrain, seed, structures and mods are untouched. */
export async function resetPlayers(uuid: string): Promise<ResetResult> {
  const world = join(serverDir(uuid), 'world');
  if (!existsSync(world))
    return { ok: false, wiped: [], restarted: false, error: 'no world exists yet — start the server once to generate it first' };
  const busy = beginMaintenance(uuid, 'player reset');
  if (busy) return { ok: false, wiped: [], restarted: false, error: busy };
  try {
    const wasRunning = await isRunningSafe(uuid);
    if (wasRunning) {
      const stopped = await stopAndWait(uuid);
      if (!stopped) return { ok: false, wiped: [], restarted: false, error: 'server would not stop — try again' };
    }

    const wiped: string[] = [];
    for (const d of ['playerdata', 'advancements', 'stats', 'players']) {
      const p = join(world, d);
      if (existsSync(p)) {
        rmSync(p, { recursive: true, force: true });
        wiped.push(d);
      }
    }

    if (wasRunning) await craftyApi.action(uuid, 'start_server').catch(() => {});
    return { ok: true, wiped, restarted: wasRunning };
  } finally {
    endMaintenance(uuid, 'player reset');
  }
}

// ---------------- backups ----------------

export interface BackupInfo {
  file: string;
  sizeMb: number;
  createdAt: string;
  /** set when this zip is a parked world slot, not the live world */
  slot?: number;
  /** false for slot zips: they cannot be restored straight into world/ */
  restorable?: boolean;
}

function backupDir(uuid: string): string {
  const d = join(PATHS.root, 'Backups', 'panel', uuid);
  mkdirSync(d, { recursive: true });
  return d;
}

/** The archive's top-level folder. A backup of the LIVE world has root
    `world/` and can be restored in place; a slot zip (`worlds/slot-2`) has
    root `slot-2/` and restoring it would extract beside the world instead of
    over it — the old code did exactly that, deleted its safety copy anyway,
    and reported success. */
function archiveRoot(zipPath: string): string | null {
  // AdmZip refuses files > 2 GiB (a full world backup is ~2.7 GB), so read
  // the first local file header straight off the file instead: signature
  // PK\x03\x04, name length at offset 26, name at offset 30. Every zip this
  // panel makes (zip -r / Compress-Archive) puts a real entry first.
  try {
    const fd = openSync(zipPath, 'r');
    try {
      const head = Buffer.alloc(30);
      if (readSync(fd, head, 0, 30, 0) !== 30 || head.readUInt32LE(0) !== 0x04034b50) return null;
      const nameLen = head.readUInt16LE(26);
      if (nameLen === 0 || nameLen > 4096) return null;
      const name = Buffer.alloc(nameLen);
      if (readSync(fd, name, 0, nameLen, 30) !== nameLen) return null;
      const entry = name.toString('utf8').replace(/\\/g, '/');
      if (!entry.trim()) return null;
      return entry.split('/')[0] || null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function listBackups(uuid: string): BackupInfo[] {
  const dir = backupDir(uuid);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.zip'))
    .map((f) => {
      const st = statSync(join(dir, f));
      const slot = /^world-slot(\d+)-/.exec(f);
      return {
        file: f,
        sizeMb: Math.round((st.size / 1e6) * 10) / 10,
        createdAt: st.mtime.toISOString(),
        // a slot zip is NOT restorable in place — the UI labels it and the
        // restore route refuses it
        slot: slot ? Number(slot[1]) : undefined,
        restorable: !slot,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Zip the world folder. Safe while running: flushes chunks via console first. */
export async function createBackup(uuid: string): Promise<BackupInfo | { error: string }> {
  const world = join(serverDir(uuid), 'world');
  if (!existsSync(world))
    return { error: 'no world exists yet — this world was reset and regenerates on the next Start. Start the server once, then back up.' };

  if (backingUp.has(uuid)) return { error: 'a backup is already running for this server' };
  backingUp.add(uuid);
  try {
    return await doBackup(uuid);
  } finally {
    backingUp.delete(uuid);
  }
}

/** Promotion snapshots are not rotated with manual backups. An interrupted
    copy is rebuilt, never mistaken for a complete backup after a restart. */
export async function createStoppedBackup(uuid: string, txn: string): Promise<string | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(txn)) throw new Error('invalid backup revision');
  if (!await fullyStopped(uuid)) throw new Error('world backup requires a confirmed stopped server');
  const level = readProperties(uuid)['level-name'] ?? 'world';
  // The restore UI currently accepts world/-rooted archives only. Refuse a
  // custom world name rather than silently backing up the wrong directory.
  if (level !== 'world') throw new Error('promotion backup currently requires level-name=world; no pack files were changed');
  const world = join(serverDir(uuid), level);
  if (!existsSync(world)) return null;
  const dest = join(backupDir(uuid), `revision-${txn}.zip`);
  if (existsSync(dest)) return dest;
  const part = `${dest}.part.zip`;
  try {
    rmSync(part, { force: true });
    await stageAndZipWorld(world, join(backupDir(uuid), `_revision-${txn}`, 'world'), part);
    if (!await fullyStopped(uuid)) throw new Error('the server started during the world backup');
    if (archiveRoot(part) !== 'world' || statSync(part).size === 0) throw new Error('world backup is invalid');
    // Atomic publication of a completed snapshot; world restore is NEVER
    // part of automatic pack rollback.
    const { renameSync } = await import('node:fs');
    renameSync(part, dest);
    return dest;
  } finally {
    rmSync(part, { force: true });
    rmSync(join(backupDir(uuid), `_revision-${txn}`), { recursive: true, force: true });
  }
}

// one backup per server at a time: concurrent ones would share the _staging dir
const backingUp = new Set<string>();

async function doBackup(uuid: string): Promise<BackupInfo | { error: string }> {
  const world = join(serverDir(uuid), 'world');
  const running = await isRunningSafe(uuid);
  if (running) {
    // flush pending chunks to disk so the zip is consistent
    await craftyApi.sendStdin(uuid, 'save-all flush').catch(() => {});
    await pause(4000);
  }

  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const file = `world-${stamp}.zip`;
  const dest = join(backupDir(uuid), file);
  // session.lock is exclusively held by the running server and would abort the
  // zip - stage a copy first (the mirror step skips it), then compress the
  // stage at low priority so the game stays lag-free.
  const stage = join(backupDir(uuid), '_staging');
  await stageAndZipWorld(world, join(stage, 'world'), dest);
  const st = statSync(dest);
  // retention: keep the newest 10 LIVE-WORLD backups. Slot zips (the "even a
  // reset is recoverable" copies) are never auto-deleted: they may be the
  // only copy of a reset world.
  const rotatable = listBackups(uuid).filter((b) => b.restorable && !b.file.startsWith('revision-'));
  for (const old of rotatable.slice(10)) unlinkSync(join(backupDir(uuid), old.file));
  return { file, sizeMb: Math.round((st.size / 1e6) * 10) / 10, createdAt: st.mtime.toISOString() };
}

/** Restore a backup: stop -> replace world -> restart.
    Guarded three ways, because getting this wrong DESTROYS the live world:
    (1) the archive must have a `world/` root — a slot zip is refused;
    (2) the extraction must actually produce a world/level.dat;
    (3) the safety copy is only deleted after (2) passes. */
export async function restoreBackup(uuid: string, file: string): Promise<{ ok: boolean; error?: string }> {
  const src = join(backupDir(uuid), file.replace(/[\\/]/g, ''));
  if (!existsSync(src)) return { ok: false, error: 'backup not found' };
  const dir = serverDir(uuid);
  const world = join(dir, 'world');

  const root = archiveRoot(src);
  if (root !== 'world') {
    return {
      ok: false,
      error: root
        ? `this zip holds "${root}", not a live world — it is a parked world slot. Switch to that slot from the Worlds card instead of restoring it here.`
        : 'could not read that zip — refusing to restore rather than risk the live world',
    };
  }

  if (restoring.has(uuid)) return { ok: false, error: 'a restore is already running for this server' };
  const busy = beginMaintenance(uuid, 'backup restore');
  if (busy) return { ok: false, error: busy };
  restoring.add(uuid);
  try {
    const wasRunning = await isRunningSafe(uuid);
    if (wasRunning) {
      const stopped = await stopAndWait(uuid);
      if (!stopped) return { ok: false, error: 'server would not stop — try again' };
    }

    // keep a safety copy of the current world until the restore is PROVEN good
    const safety = join(dir, 'world-pre-restore');
    rmSync(safety, { recursive: true, force: true });
    if (existsSync(world)) {
      await moveDir(world, safety);
    }
    try {
      await unzipTo(src, dir);
      // extraction can "succeed" having written nothing useful
      if (!existsSync(join(world, 'level.dat'))) throw new Error('archive produced no world/level.dat');
      rmSync(safety, { recursive: true, force: true });
    } catch (e) {
      rmSync(world, { recursive: true, force: true });
      if (existsSync(safety)) await moveDir(safety, world);
      return { ok: false, error: `restore failed, world rolled back: ${String(e)}` };
    }

    // the restored world is a different world as far as pregen is concerned:
    // the DONE record and the Bobby fallback zip describe chunks that may not
    // exist in it (dynamic imports — chunky.ts imports this module)
    try {
      const [{ clearPregenHistory }, { clearFallback }] = await Promise.all([
        import('./chunky.js'), import('./bobbyfallback.js'),
      ]);
      clearPregenHistory(uuid);
      clearFallback(uuid);
    } catch { /* never fail a good restore over bookkeeping */ }

    if (wasRunning) await craftyApi.action(uuid, 'start_server').catch(() => {});
    return { ok: true };
  } finally {
    restoring.delete(uuid);
    endMaintenance(uuid, 'backup restore');
  }
}

// two concurrent restores shared the same `world-pre-restore` path: B's cleanup
// deleted A's safety copy, so a failure in A had nothing to roll back to
const restoring = new Set<string>();

export function deleteBackup(uuid: string, file: string): void {
  const p = join(backupDir(uuid), file.replace(/[\\/]/g, ''));
  if (existsSync(p)) unlinkSync(p);
}
