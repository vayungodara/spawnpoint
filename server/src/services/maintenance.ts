import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../config.js';
import { serverDir } from './servers.js';
import { craftyApi } from '../clients/crafty.js';
import { readProperties } from './properties.js';
import { moveDir, portListening, stageAndZipWorld, unzipTo } from './platform.js';

async function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** True only when Crafty says stopped AND nothing listens on the MC port. */
async function fullyStopped(uuid: string): Promise<boolean> {
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
    return true;
  }
}

// A server under maintenance (preset patch, world switch/reset, restore) is
// mid-surgery with its files moving around. The scheduler and autostop MUST
// NOT start or stop it in that window — a scheduled start once booted a server
// while its level.dat patch was still pending, and the running server rewrote
// the file from memory on shutdown, silently undoing the change.
const underMaintenance = new Set<string>();
export function beginMaintenance(uuid: string): void { underMaintenance.add(uuid); }
export function endMaintenance(uuid: string): void { underMaintenance.delete(uuid); }
export function isUnderMaintenance(uuid: string): boolean { return underMaintenance.has(uuid); }

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

/** Stop a server and WAIT until the java process is genuinely gone. */
export async function stopAndWait(uuid: string, timeoutSec = 90): Promise<boolean> {
  await craftyApi.action(uuid, 'stop_server').catch(() => {});
  for (let i = 0; i < timeoutSec / 3; i++) {
    await pause(3000);
    if (await fullyStopped(uuid)) {
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

// concurrent backups shared one _staging dir: one's Remove-Item raced the
// other's Compress-Archive (a double-click on Reset World hit this in prod)
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
  // reset is recoverable" copies) are never auto-deleted — ten routine backups
  // used to silently purge the only copy of a reset world.
  const rotatable = listBackups(uuid).filter((b) => b.restorable);
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
  restoring.add(uuid);
  beginMaintenance(uuid);
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
    endMaintenance(uuid);
  }
}

// two concurrent restores shared the same `world-pre-restore` path: B's cleanup
// deleted A's safety copy, so a failure in A had nothing to roll back to
const restoring = new Set<string>();

export function deleteBackup(uuid: string, file: string): void {
  const p = join(backupDir(uuid), file.replace(/[\\/]/g, ''));
  if (existsSync(p)) unlinkSync(p);
}
