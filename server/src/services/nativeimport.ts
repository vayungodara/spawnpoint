import { existsSync, lchownSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { PATHS, loadSettings } from '../config.js';
import { connect } from 'node:net';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lookup } from 'node:dns/promises';
import { craftyApi as source } from '../clients/crafty-adapter.js';
import { giveToSupervisor, nativeRecord, nativeRoot, nativeServers, serviceAccount, supervisor, transferRecord, type Transfer } from './native.js';
import { packFiles, revisionState, verifyActiveRevision, verifyRevision, withRuntimeFence, withStoppedRevision } from './revisions.js';
import { serverDir } from './servers.js';
import { beginMaintenance, endMaintenance } from './maintenance.js';
import { ROOT_PANEL, giveTree, portListening, writeFileAtomic } from './platform.js';
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

const parentPid = (pid: number | string): number => Number(readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '').split(' ')[1]);

function accountName(uid: number): string {
  try {
    const line = readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.split(':')[2] === String(uid));
    if (line) return line.split(':')[0];
  } catch { /* not a passwd host */ }
  return `user ${uid}`;
}

interface Owner { uid: number; gid: number; account: string }
async function serviceOwner(): Promise<Owner | null> {
  const account = await serviceAccount();
  return account && { ...account, account: accountName(account.uid) };
}
const hostingDir = (): string => join(PATHS.data, 'pack-hosting');

/** Refuse early when this panel cannot hand the tree to the supervisor. */
function handOverBlocker(path: string, owner: Owner | null): string | null {
  if (!owner || ROOT_PANEL) return null;
  let foreign: string | null = null;
  const walk = (p: string): void => {
    const s = lstatSync(p);
    if (s.uid !== owner.uid && !foreign) foreign = p;
    if (s.isDirectory() && !foreign) for (const name of readdirSync(p)) walk(join(p, name));
  };
  walk(path);
  if (!foreign) return null;
  return `This server's files belong to ${accountName(lstatSync(foreign).uid)}, but Spawnpoint's supervisor runs as ${owner.account}, `
    + `and this panel runs as ${accountName(process.getuid!())}, so it cannot hand them over. Import it from a panel started as root.`;
}

/** That account itself, not a permission model, must confirm a start can write everything. */
async function writableBlocker(path: string, owner: Owner | null): Promise<string | null> {
  if (!owner) return null;
  const blocked = await supervisor<string | null>('access', { paths: [path, hostingDir()] });
  if (!blocked) return null;
  return `Spawnpoint's supervisor runs as ${owner.account} and cannot write ${relative(path, blocked) || blocked} `
    + `(owned by ${accountName(lstatSync(blocked).uid)}). ${ROOT_PANEL ? 'Correct that path, then try again.' : 'Import it from a panel started as root.'}`;
}

/** True when this panel sees every process on the host: root, sharing PID
    and cgroup namespaces with a host systemd that sits in /init.scope. A
    container's own PID 1 does not satisfy this, so visibility stays unknown. */
function seesEveryProcess(): boolean {
  if (process.platform !== 'linux' || !ROOT_PANEL) return false;
  try {
    return readlinkSync('/proc/self/ns/pid') === readlinkSync('/proc/1/ns/pid')
      && readlinkSync('/proc/self/ns/cgroup') === readlinkSync('/proc/1/ns/cgroup')
      && readFileSync('/proc/1/comm', 'utf8').trim() === 'systemd'
      && readFileSync('/proc/1/cgroup', 'utf8').trim() === '0::/init.scope'
      && readdirSync('/proc/1/fd').length >= 0;
  } catch { return false; }
}
const pids = (): number[] => readdirSync('/proc').filter((e) => /^\d+$/.test(e)).map(Number);

/** Crafty's processes: `python main.py`, from its venv or under `sudo -u crafty`. */
function craftyPids(): number[] {
  return pids().filter((pid) => {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (!/^python[\d.]*$/.test(basename(argv[0])) || basename(argv[1] ?? '') !== 'main.py') return false;
      return /crafty/i.test(`${argv.join(' ')} ${readlinkSync(`/proc/${pid}/cwd`)} ${readFileSync(`/proc/${parentPid(pid)}/cmdline`, 'utf8')}`);
    } catch { return false; }
  });
}

/** The cgroup v2 groups holding Crafty and every worker it started (a systemd
    unit or a container), or null when they cannot be frozen safely. */
function craftyGroups(): string[] | null {
  if (!seesEveryProcess() || !existsSync('/sys/fs/cgroup/cgroup.controllers')) return null;
  const group = (pid: number | 'self'): string | null => /^0::(\/.*)$/m.exec(readFileSync(`/proc/${pid}/cgroup`, 'utf8'))?.[1] ?? null;
  const mine = group('self');
  const groups = [...new Set(craftyPids().map(group))];
  if (!mine || !groups.length || groups.some((g) => !g || g === '/' || mine === g || mine.startsWith(`${g}/`))) return null;
  if (spawnSync('systemd-run', ['--version'], { stdio: 'ignore' }).status !== 0) return null;
  return (groups as string[]).every((g) => existsSync(join('/sys/fs/cgroup', g, 'cgroup.freeze'))) ? groups as string[] : null;
}

const thawRecord = (): string => join(nativeRoot, 'crafty-frozen.json');
const thaw = (groups: string[]): void => { for (const g of groups) { try { writeFileSync(join('/sys/fs/cgroup', g, 'cgroup.freeze'), '0'); } catch { /* group gone */ } } };
const unitDone = (unit: string): boolean => ['inactive', 'failed'].includes(
  spawnSync('systemctl', ['show', '--property=ActiveState', '--value', `${unit}.service`], { encoding: 'utf8', timeout: 10_000 }).stdout?.trim() ?? '');
const procStart = (pid: number): string => readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '').split(' ')[19];
const helper = (): string => fileURLToPath(new URL('./supervisor.py', import.meta.url));

/** A pause recorded by a panel that died mid-move: thaw it once its move
    unit has fully stopped (systemd then has already thawed it, too). */
export function thawAbandonedCrafty(): void {
  let record: { groups: string[]; unit: string };
  try { record = JSON.parse(readFileSync(thawRecord(), 'utf8')); } catch { return; }
  if (!unitDone(record.unit)) return;
  thaw(record.groups);
  rmSync(thawRecord(), { force: true });
}

/** Scan for writers and rename src to dst. With Crafty's cgroups, the scan
    and rename run frozen inside one transient unit (see supervisor.py
    freeze_move); without them, as a plain child. Returns 'moved', the
    writers found, or null when a process could not be inspected. */
let moveQueue: Promise<unknown> = Promise.resolve();
function scanAndMove(groups: string[] | null, src: string, dst: string): Promise<'moved' | 'timeout' | string[] | null> {
  // One pause of Crafty at a time: an overlapping import must neither reclaim
  // nor thaw a pause whose caller is still in flight.
  const run = moveQueue.then(() => scanAndMoveNow(groups, src, dst));
  moveQueue = run.catch(() => undefined);
  return run;
}

async function scanAndMoveNow(groups: string[] | null, src: string, dst: string): Promise<'moved' | 'timeout' | string[] | null> {
  const spec = Buffer.from(JSON.stringify({ groups: groups ?? [], src, dst, panel: process.pid, start: procStart(process.pid) })).toString('base64');
  let argv = ['python3', helper(), '--freeze-move', spec];
  let unit: string | null = null;
  if (groups) {
    if (existsSync(thawRecord())) thawAbandonedCrafty();
    if (existsSync(thawRecord())) throw new Error('an earlier pause of Crafty is still being recovered; try again shortly');
    unit = `spawnpoint-move-${process.pid}-${Date.now()}`;
    writeFileAtomic(thawRecord(), JSON.stringify({ groups, unit }));
    const thawCmd = groups.map((g) => `echo 0 > ${join('/sys/fs/cgroup', g, 'cgroup.freeze')}`).join('; ');
    // SIGKILL first and wait forever: a process stuck in a rename keeps Crafty
    // frozen rather than thawing early.
    argv = ['systemd-run', '--wait', '--pipe', '--quiet', '--collect', `--unit=${unit}`, '-p', 'RuntimeMaxSec=10', '-p', 'KillSignal=SIGKILL',
      '-p', 'TimeoutStopSec=infinity', '-p', `ExecStopPost=/bin/sh -c "${thawCmd}"`, ...argv];
  }
  const out = await new Promise<string>((resolve) => execFile(argv[0], argv.slice(1), { timeout: 0, maxBuffer: 1024 * 1024 }, (_e, stdout) => resolve(String(stdout))));
  if (unit && groups) {
    for (let i = 0; !unitDone(unit); i++) await new Promise((r) => setTimeout(r, i < 100 ? 100 : 1000));
    thaw(groups);
    try { if (JSON.parse(readFileSync(thawRecord(), 'utf8')).unit === unit) rmSync(thawRecord(), { force: true }); } catch { /* already gone */ }
  }
  // A killed helper may or may not have renamed: the filesystem decides.
  if (!existsSync(src) && existsSync(dst)) return 'moved';
  let result: { writers?: string[] | null } = {};
  try { result = JSON.parse(out.trim().split('\n').pop() ?? '{}'); } catch { /* killed */ }
  return 'writers' in result ? result.writers ?? null : 'timeout';
}

/** Whether this server can move while Crafty keeps running its others. */
export function singleServerMove(): boolean {
  return craftyGroups() !== null;
}

/** Whether the whole local Crafty service is offline, for the fallback. */
export async function craftyOffline(): Promise<{ port: 'closed' | 'open' | 'unknown'; processes: string[] | null }> {
  const port = await sourceOffline().then(() => 'closed' as const, (e: Error) => /unknown/.test(e.message) ? 'unknown' as const : 'open' as const);
  return { port, processes: seesEveryProcess() ? craftyPids().map((pid) => `pid ${pid}`) : null };
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
    const blocker = handOverBlocker(path, await serviceOwner());
    if (blocker) throw new Error(blocker);
    const plan: Transfer = { id, phase: 'preparing', source: server, path, destination,
      identity: { device: String(identity.dev), inode: String(identity.ino) }, revision, owner: { uid: Number(identity.uid), gid: Number(identity.gid) } };
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

/** Commit ownership. With full process visibility as root on Linux only
    this server moves: Crafty's cgroup is frozen while no other process may
    keep a working directory, directory or writable file inside the tree and
    the tree is renamed away, so Crafty can no longer reach it. Otherwise the
    entire local Crafty service must be offline. */
export async function commitCraftyImport(id: string, revision: string, craftyStopped = false): Promise<{ account?: string; crafty: 'running' | 'stopped' }> {
  const plan = transferRecord(id);
  if (!plan || plan.revision !== revision || plan.phase === 'preparing') throw new Error('approve the exact prepared import revision');
  return withRuntimeFence(id, async () => {
    const groups = craftyGroups();
    if (!groups) {
      const offline = await craftyOffline();
      if (offline.port !== 'closed') throw new Error('stop the entire Crafty service or container first; its web port still answers');
      if (offline.processes ? offline.processes.length : !craftyStopped) throw new Error(offline.processes ? `Crafty is still running (${offline.processes.join(', ')}); wait for it to exit` : 'confirm the entire Crafty service or container and its workers have exited; a closed web port alone is not proof');
    }
    const moved = plan.phase === 'committing' && existsSync(plan.destination);
    if (!moved && existsSync(plan.destination)) throw new Error('native destination appeared after preparation; inspect it before committing');
    const validate = async (): Promise<void> => {
      const current = statSync(serverDir(id), { bigint: true });
      if (String(current.dev) !== plan.identity.device || String(current.ino) !== plan.identity.inode) throw new Error('transfer directory identity changed; inspect recovery before proceeding');
      const port = Number(readProperties(id)['server-port']);
      if (!Number.isInteger(port) || await portListening(port)) throw new Error('the Minecraft listener must be confirmed stopped');
      await verifyRevision(id, revision, true);
      // Properties and worlds are outside the pack lock and can change after
      // preparation. Recheck confinement at commit, including forward recovery.
      checkImportTree(id);
    };
    // Never act on a directory that is not the prepared one, not even to roll back.
    const current = statSync(serverDir(id), { bigint: true });
    if (String(current.dev) !== plan.identity.device || String(current.ino) !== plan.identity.inode) throw new Error('transfer directory identity changed; inspect recovery before proceeding');
    // An interrupted, unregistered move validates its contents below, then retries forward.
    if (!moved) await validate();
    const owner = await serviceOwner();
    const early = handOverBlocker(serverDir(id), owner);
    if (early) throw new Error(early);
    plan.phase = 'committing';
    writeFileAtomic(file(id), JSON.stringify(plan));
    writeFileAtomic(join(serverDir(id), '.spawnpoint-mutation'), 'ownership transfer recovery required\n');
    const unmark = (why: string): never => {
      rmSync(join(plan.path, '.spawnpoint-mutation'), { force: true });
      plan.phase = 'prepared';
      writeFileAtomic(file(id), JSON.stringify(plan));
      throw new Error(why);
    };
    if (!moved) {
      const made = mkdirSync(nativeServers, { recursive: true });
      if (made && owner && ROOT_PANEL) lchownSync(made, owner.uid, owner.gid);
      // Atomic same-volume relocation cuts off Crafty's old queued writers.
      // EXDEV refuses safely; never copy a live world or guess at a partial copy.
      if (groups || seesEveryProcess()) {
        let outcome: 'moved' | 'timeout' | string[] | null = null;
        // Crafty's stats thread can briefly walk the old tree; let it finish.
        for (let i = 0; i < (groups ? 10 : 1); i++) {
          outcome = await scanAndMove(groups, plan.path, plan.destination);
          if (!Array.isArray(outcome) || !outcome.length) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (outcome === 'timeout') unmark('checking for open files took too long while Crafty was paused; try again, or stop Crafty completely');
        if (outcome === null) unmark(`a process could not be inspected; try again${groups ? ', or stop Crafty completely' : ''}`);
        if (outcome !== 'moved') unmark(`${(outcome as string[]).join(', ')} still has this server's files open. Wait for it to finish (or stop it), then move again.`);
      } else renameSync(plan.path, plan.destination);
    }
    // Until the registry write below, the move is still undoable: the source
    // stays frozen in Crafty, so returning the directory re-enables nothing.
    const back = (why: string): never => {
      if (plan.owner && ROOT_PANEL) giveTree(plan.owner.uid, plan.owner.gid, plan.destination);
      renameSync(plan.destination, plan.path);
      return unmark(why);
    };
    const owned = nativeRecord(id);
    if (!owned) {
      try {
        // Writers allowed to finish before the move may have changed bytes.
        await validate();
        // After commit the supervisor's account runs this server: its world,
        // session.lock, configs and AutoModpack state.
        giveToSupervisor(plan.destination, owner);
        const blocked = await writableBlocker(plan.destination, owner);
        if (blocked) throw new Error(blocked);
      } catch (error) {
        // Forward recovery stays forward: fix the reported problem and retry.
        if (moved) throw error;
        back(error instanceof Error ? error.message : String(error));
      }
      // This one registry write is the ownership commit. On interrupted import,
      // a committed registration recovers forward, never re-enables Crafty.
      await supervisor('register', { server: { ...plan.source, path: plan.destination, auto_start: false } });
    } else if (owned.path !== plan.destination || owned.execution_command !== plan.source.execution_command) throw new Error('native registration differs from the transfer journal');
    rmSync(join(plan.destination, '.spawnpoint-mutation'), { force: true });
    rmSync(file(id));
    endMaintenance(id, 'runtime transfer');
    return { account: owner?.account, crafty: groups ? 'running' : 'stopped' };
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
