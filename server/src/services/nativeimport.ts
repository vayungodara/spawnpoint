import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { connect } from 'node:net';
import { lookup } from 'node:dns/promises';
import { loadSettings } from '../config.js';
import { craftyApi as source } from '../clients/crafty-adapter.js';
import { nativeRecord, nativeRoot, nativeServers, supervisor, transferRecord, type Transfer } from './native.js';
import { packFiles, revisionState, verifyActiveRevision, verifyRevision, withRuntimeFence, withStoppedRevision } from './revisions.js';
import { serverDir } from './servers.js';
import { beginMaintenance, endMaintenance } from './maintenance.js';
import { portListening, writeFileAtomic } from './platform.js';
import { readProperties } from './properties.js';

const file = (id: string): string => join(nativeRoot, 'transfers', `${id}.json`);
const REFUSAL = `"${process.platform === 'win32' ? 'python' : 'python3'}" -c "raise SystemExit('Use Spawnpoint: ownership transfer in progress')"`;

function checkImportTree(id: string): void {
  const path = serverDir(id);
  // The shared editor supports plain keys, not Java's escaped keys, alternate
  // separators or continuations. Refuse ambiguous syntax instead of guessing
  // which level-name the JVM would read after relocation.
  for (const line of readFileSync(join(path, 'server.properties'), 'utf8').split(/\r?\n/)) {
    if (line.includes('\r') || (!/^[\t ]*(?:[#!]|$)/.test(line)
      && (!/^[\t ]*[a-zA-Z0-9_.-]+[\t ]*=/.test(line) || line.endsWith('\\')))) throw new Error('import requires plain key=value properties without escaped keys or continuations');
  }
  const level = readProperties(id)['level-name'] ?? 'world';
  if (!/^[a-zA-Z0-9 _-]+$/.test(level)) throw new Error('import requires the world inside this server directory, not an external level-name');
  packFiles(path); // refuse linked world/config trees, not just linked jars
}

/** Capture exact guarded recipes while Crafty is reachable. Worlds are neither
    restored nor rewritten; commit relocates the stopped directory intact.
    Crafty's task-list API cannot prove queued writer quiescence on 4.x, so
    committing the import additionally requires its local service OFFLINE. */
export async function prepareCraftyImport(id: string): Promise<Transfer> {
  if (nativeRecord(id)) throw new Error('already owned by Spawnpoint');
  const old = transferRecord(id);
  if (old) return old;
  const refused = beginMaintenance(id, 'runtime transfer');
  if (refused) throw new Error(refused);
  try {
    await source.listServers(); // populate the container/host path mapping
    const server = await source.getServer(id) as Transfer['source'] & { status: { updating: boolean; backing_up: boolean } };
    const stats = await source.getStats(id) as Awaited<ReturnType<typeof source.getStats>> & { importing: boolean; updating: boolean };
    if (stats.running || stats.waiting_start || stats.importing !== false || stats.updating !== false
      || server.status?.updating !== false || server.status?.backing_up !== false) throw new Error('stop the server and finish every Crafty install/update/backup before transfer');
    const revision = revisionState(id).active;
    if (!revision) throw new Error('adopt and certify this server with the revision guard before importing it');
    await verifyActiveRevision(id);
    const path = serverDir(id), destination = join(nativeServers, id);
    const within = relative(path, destination);
    if (existsSync(destination) || (!within.startsWith('..') && !isAbsolute(within)) || lstatSync(path).isSymbolicLink()) throw new Error('native destination must be a new directory outside the Crafty source');
    checkImportTree(id);
    const identity = statSync(path, { bigint: true });
    const plan: Transfer = { id, phase: 'preparing', source: server, path, destination,
      identity: { device: String(identity.dev), inode: String(identity.ino) }, revision };
    writeFileAtomic(file(id), JSON.stringify(plan));
    await withStoppedRevision(id, async () => {
      await source.setTransferSource(id, { execution_command: REFUSAL, auto_start: false, crash_detection: false, update_watcher: false });
      const frozen = await source.getServer(id) as Transfer['source'];
      if (frozen.execution_command !== REFUSAL || frozen.auto_start || frozen.crash_detection || frozen.update_watcher) throw new Error('Crafty did not acknowledge the source freeze');
      plan.phase = 'prepared';
      writeFileAtomic(file(id), JSON.stringify(plan));
    });
    return plan;
  } catch (error) {
    if (!transferRecord(id)) endMaintenance(id, 'runtime transfer');
    throw error;
  }
}

async function sourceOffline(): Promise<void> {
  const url = new URL(loadSettings().craftyUrl);
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!addresses.length || addresses.some((a) => !(a.address === '::1' || a.address.startsWith('127.')))) throw new Error('offline Crafty import requires the source service on this same host');
  for (const address of addresses) {
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ host: address.address, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) });
      socket.setTimeout(2_000);
      socket.once('connect', () => { socket.destroy(); reject(new Error('stop the Crafty service before committing the import; queued writers must be quiescent')); });
      socket.once('timeout', () => { socket.destroy(); reject(new Error('Crafty source state is unknown, not confirmed offline')); });
      socket.once('error', (error: NodeJS.ErrnoException) => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
    });
  }
}

export async function commitCraftyImport(id: string, revision: string): Promise<void> {
  const plan = transferRecord(id);
  if (!plan || plan.revision !== revision || plan.phase === 'preparing') throw new Error('approve the exact prepared import revision');
  await withRuntimeFence(id, async () => {
    await sourceOffline();
    const moved = plan.phase === 'committing' && existsSync(plan.destination);
    if (!moved && existsSync(plan.destination)) throw new Error('native destination appeared after preparation; inspect it before committing');
    const current = statSync(serverDir(id), { bigint: true });
    if (String(current.dev) !== plan.identity.device || String(current.ino) !== plan.identity.inode) throw new Error('transfer directory identity changed; inspect recovery before proceeding');
    const port = Number(readProperties(id)['server-port']);
    if (!Number.isInteger(port) || await portListening(port)) throw new Error('the Minecraft listener must be confirmed stopped');
    await verifyRevision(id, revision, true);
    // Properties and worlds are outside the pack lock and can change after
    // preparation. Recheck confinement at commit, including forward recovery.
    checkImportTree(id);
    plan.phase = 'committing';
    writeFileAtomic(file(id), JSON.stringify(plan));
    writeFileAtomic(join(serverDir(id), '.spawnpoint-mutation'), 'ownership transfer recovery required\n');
    if (!moved) {
      mkdirSync(nativeServers, { recursive: true });
      // Atomic same-volume relocation cuts off Crafty's old queued writers.
      // EXDEV refuses safely; never copy a live world or guess at a partial copy.
      renameSync(plan.path, plan.destination);
    }
    // This one registry write is the ownership commit. On interrupted import,
    // a committed registration recovers forward, never re-enables Crafty.
    const owned = nativeRecord(id);
    if (!owned) await supervisor('register', { server: { ...plan.source, path: plan.destination, auto_start: false } });
    else if (owned.path !== plan.destination || owned.execution_command !== plan.source.execution_command) throw new Error('native registration differs from the transfer journal');
    rmSync(join(plan.destination, '.spawnpoint-mutation'), { force: true });
    rmSync(file(id));
    endMaintenance(id, 'runtime transfer');
  });
}

export async function abortCraftyImport(id: string): Promise<void> {
  const plan = transferRecord(id);
  if (!plan) return;
  if (nativeRecord(id) || plan.phase === 'committing') throw new Error('commit has begun; complete forward recovery, never reactivate Crafty');
  await withStoppedRevision(id, async () => {
    await source.setTransferSource(id, { execution_command: plan.source.execution_command,
      auto_start: plan.source.auto_start, crash_detection: plan.source.crash_detection, update_watcher: plan.source.update_watcher });
    rmSync(file(id));
    endMaintenance(id, 'runtime transfer');
  });
}
