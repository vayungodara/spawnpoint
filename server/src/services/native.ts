import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../config.js';
import { ROOT_PANEL, giveTree } from './platform.js';
import type { CraftyServer } from '../clients/crafty-adapter.js';

export interface NativeServer extends CraftyServer {
  schema: 1;
  desired: boolean;
  attempts: number[];
  attempt?: { id: string; at: number; revision?: string };
  blocked?: string;
}
export const nativeRoot = join(PATHS.data, 'runtime');
export const nativeServers = join(PATHS.root, 'Servers');
export interface Transfer {
  id: string;
  phase: 'preparing' | 'prepared' | 'committing';
  source: CraftyServer & { crash_detection: boolean; update_watcher: boolean };
  path: string;
  destination: string;
  identity: { device: string; inode: string };
  revision: string;
  /** Crafty's owner of the directory, restored if the move is undone. */
  owner?: { uid: number; gid: number };
}
export function transferRecord(id: string): Transfer | null {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('invalid server id');
  const path = join(nativeRoot, 'transfers', `${id}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Transfer : null;
}
export function transferRecords(): Transfer[] {
  const dir = join(nativeRoot, 'transfers');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => transferRecord(f.slice(0, -5))!) : [];
}
export function nativeRecord(id: string): NativeServer | null {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('invalid server id');
  const path = join(nativeRoot, 'servers', `${id}.json`);
  if (!existsSync(path)) return null;
  const record = JSON.parse(readFileSync(path, 'utf8')) as NativeServer;
  if (record.schema !== 1 || record.server_id !== id || !record.path || !record.execution_command) throw new Error('invalid native ownership record; recovery required');
  return record;
}
export function nativeRecords(): NativeServer[] {
  const dir = join(nativeRoot, 'servers');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => nativeRecord(f.slice(0, -5))!) : [];
}
/** Loopback IPC is authenticated with a fresh owner-only capability on each
    supervisor start. It is never sent to a browser or logged. */
export async function supervisor<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
  const path = join(nativeRoot, 'endpoint.json');
  if (!existsSync(path)) throw new Error('Spawnpoint supervisor is offline. Install or start the OS service, then retry.');
  const endpoint = JSON.parse(readFileSync(path, 'utf8')) as { port: number; token: string };
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || typeof endpoint.token !== 'string') throw new Error('invalid supervisor endpoint');
  const res = await fetch(`http://127.0.0.1:${endpoint.port}/rpc`, {
    method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ op, ...args }), signal: AbortSignal.timeout(15_000),
  }).catch(() => { throw new Error('Spawnpoint supervisor is unavailable. Start the OS service, then retry.'); });
  const body = await res.json() as { result: T; error?: string };
  if (!res.ok) throw new Error(body.error ?? 'supervisor refused request');
  return body.result;
}

/** The account the supervisor runs Java as; null on Windows, where the
    installer grants its virtual account the layout instead. */
export async function serviceAccount(): Promise<{ uid: number; gid: number } | null> {
  const { uid, gid } = await supervisor<{ uid?: number | null; gid?: number | null }>('health');
  return typeof uid === 'number' && typeof gid === 'number' ? { uid, gid } : null;
}

/** A root panel writes for the supervisor's account: hand it a native server
    tree and the shared hosting state it rewrites on every start. Inodes,
    including the runtime fence, are kept. */
export function giveToSupervisor(path: string, account: { uid: number; gid: number } | null): void {
  if (!ROOT_PANEL || !account || account.uid === 0) return;
  const hosting = join(PATHS.data, 'pack-hosting');
  mkdirSync(hosting, { recursive: true });
  giveTree(account.uid, account.gid, path, hosting);
}

/** Discover owner-initiated boots while connected, and reconcile the newest
    attempt after a panel restart. Publication still belongs to the panel. */
export function startNativeWatcher(log: (message: string) => void): void {
  const seen = new Set<string>();
  let busy = false;
  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const { finishNativeInstalls } = await import('./nativeinstall.js');
      void finishNativeInstalls(log);
      for (const record of nativeRecords()) {
        if (!record.attempt || seen.has(record.attempt.id)) continue;
        const stats = await supervisor<{ running: boolean; waiting_start: boolean; stopping: boolean }>('stats', { id: record.server_id });
        if (!stats.running || stats.waiting_start || stats.stopping) continue;
        const { watchStart } = await import('./promote.js');
        watchStart(record.server_id, record.attempt.at);
        seen.add(record.attempt.id);
      }
    } catch (error) { log(`native owner reconciliation: ${String(error)}`); }
    finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, 3_000);
  timer.unref();
  void tick();
}
