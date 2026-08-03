import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { PATHS } from '../config.js';
import { serverDir } from './servers.js';
import { detect } from './detect.js';
import { isPluginLoader } from '../clients/modrinth.js';

// WHY THIS EXISTS
// ---------------
// Windows will not rename or delete a file the running JVM holds open, so every
// mod disable/delete fails with EBUSY while the server is up. Refusing with a
// tidy error message is honest but useless: the player still cannot do the thing
// they asked for, and "stop the server, do it, start it again" is exactly the
// chore a control panel is supposed to remove.
//
// So we QUEUE the change and apply it the moment the jars are free — on the next
// stop, or just before the next start. The intent survives a panel restart
// (it is a file, not memory), and the UI shows the mod as pending so nobody is
// left wondering whether the click registered.

export type PendingAction = 'disable' | 'enable' | 'delete';
export interface PendingChange { file: string; action: PendingAction; at: string }
type Queue = Record<string, PendingChange[]>; // serverUuid -> changes

const FILE = join(PATHS.data, 'pending-mods.json');

function load(): Queue {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')) as Queue;
  } catch {
    return {};
  }
}

function save(q: Queue): void {
  mkdirSync(PATHS.data, { recursive: true });
  writeFileSync(FILE, JSON.stringify(q, null, 2), 'utf8');
}

/** Where this server's jars live (Bukkit-family use plugins/, not mods/). */
function jarDir(uuid: string): string {
  const dir = serverDir(uuid);
  return isPluginLoader(detect(dir, uuid).loader) ? join(dir, 'plugins') : join(dir, 'mods');
}

/** Queue a change for when the server is next down. A newer intent for the same
 *  file REPLACES the older one — clicking disable then enable must not leave a
 *  stale disable queued behind it. */
export function queueChange(uuid: string, file: string, action: PendingAction): PendingChange {
  const q = load();
  const clean = basename(file); // no path traversal
  const list = (q[uuid] ??= []).filter((c) => c.file !== clean);
  const change: PendingChange = { file: clean, action, at: new Date().toISOString() };
  list.push(change);
  q[uuid] = list;
  save(q);
  return change;
}

export function listPending(uuid: string): PendingChange[] {
  return load()[uuid] ?? [];
}

export function cancelPending(uuid: string, file: string): void {
  const q = load();
  q[uuid] = (q[uuid] ?? []).filter((c) => c.file !== basename(file));
  save(q);
}

/** Apply everything queued for this server. Call it whenever the jars might be
 *  free (server observed stopped, and immediately before a start). Safe to call
 *  at any time: anything still locked simply stays queued for the next attempt. */
export function applyPending(uuid: string): { applied: PendingChange[]; stillLocked: PendingChange[] } {
  const q = load();
  const queued = q[uuid] ?? [];
  if (queued.length === 0) return { applied: [], stillLocked: [] };

  const dir = jarDir(uuid);
  const applied: PendingChange[] = [];
  const stillLocked: PendingChange[] = [];

  for (const c of queued) {
    const jar = join(dir, c.file);
    const disabled = `${jar}.disabled`;
    try {
      if (c.action === 'disable') {
        if (existsSync(jar)) renameSync(jar, disabled);
      } else if (c.action === 'enable') {
        if (existsSync(disabled)) renameSync(disabled, jar);
      } else {
        // delete: remove whichever form is on disk
        if (existsSync(jar)) unlinkSync(jar);
        if (existsSync(disabled)) unlinkSync(disabled);
      }
      applied.push(c);
    } catch (e) {
      // still held open (server came back up, or never went down) — keep it queued
      if (/EBUSY|EPERM|EACCES/i.test(String((e as NodeJS.ErrnoException).code ?? e))) stillLocked.push(c);
      else applied.push(c); // a missing file is not a reason to retry forever
    }
  }

  if (stillLocked.length) q[uuid] = stillLocked;
  else delete q[uuid];
  save(q);
  return { applied, stillLocked };
}
