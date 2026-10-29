import { createHash } from 'node:crypto';
import { chownSync, closeSync, createReadStream, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, constants } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PATHS } from '../config.js';
import { craftyApi } from '../clients/crafty.js';
import { detect, loaderVersion } from './detect.js';
import { clientShelfDir, javaFor, serverDir } from './servers.js';
import { ledgerEntries, type LedgerEntry } from './ledger.js';
import { writeFileAtomic } from './platform.js';
import { hostingHold } from './automodpack.js';
import { parse } from 'smol-toml';

// A lock is an inventory, never a fresh interpretation of the current pack.
// Snapshots own real copies. Test JVMs and live folders never share writable
// inodes with them. Worlds, credentials and generated runtime files stay out.
export interface LockedFile {
  path: string;
  side: 'server' | 'client' | 'both';
  location: 'server' | 'shelf' | 'extra';
  sha512: string;
  sha1: string;
  size: number;
  source: { kind: 'modrinth' | 'curseforge' | 'local'; projectId?: string; versionId?: string };
  requested: boolean;
}
export interface TestResult {
  result: 'passed' | 'failed' | 'skipped' | 'inconclusive';
  detail: string;
  renderer?: 'xvfb' | 'window' | 'headless' | 'none';
}
export interface RevisionLock {
  schema: 1;
  id: string;
  minecraft: string;
  loader: string;
  loaderVersion: string;
  java: { executable: string; version: string; sha512: string; files: { path: string; sha512: string; size: number }[] };
  command: string;
  arguments: string[];
  files: LockedFile[];
  requested: string[];
  dependencies: string[];
}
export interface RevisionReport {
  tests: Record<string, TestResult>;
  approved?: { at: string; reasons: string[] };
  backup?: string;
}
export interface RevisionInput {
  src: string;
  path: string;
  side: LockedFile['side'];
  location: LockedFile['location'];
  entry?: LedgerEntry;
}
const run = promisify(execFile);
export const PACK_ROOTS = ['mods', 'config', 'defaultconfigs', 'kubejs', 'emotes', 'libraries', 'versions', '.fabric/server'];
const root = (id: string): string => { serverDir(id); return join(PATHS.data, 'locked-revisions', id); };
export const revisionDir = (id: string, revision: string): string => {
  if (!/^[a-zA-Z0-9_-]+$/.test(revision)) throw new Error('invalid revision');
  return join(root(id), revision);
};
export const lockedPath = (id: string, revision: string, f: Pick<LockedFile, 'location' | 'path'>): string =>
  join(revisionDir(id, revision), 'files', f.location, safePath(f.path));
export function safePath(path: string): string {
  if (!path || path.includes('\\') || path.startsWith('/') || path.includes(':') || path.split('/').some((p) => !p || p === '.' || p === '..' || /^\.env(?:\.|$)|\.(?:key|pem|p12|pfx)$/i.test(p))) throw new Error(`unsafe revision path: ${path}`);
  return path;
}
/** Pack locks can never adopt world files, even if a third-party manifest
    requests them. The location is part of the boundary, not just the path. */
export function packPath(path: string, location: LockedFile['location']): string {
  safePath(path);
  if (!['server', 'shelf', 'extra'].includes(location)) throw new Error('invalid pack location');
  const roots = location === 'server' ? PACK_ROOTS : location === 'shelf' ? ['mods'] : ['mods', 'config', 'kubejs', 'emotes', 'resourcepacks', 'shaderpacks'];
  const special = location === 'server' && ['fabric.jar', 'user_jvm_args.txt', '.spawnpoint-launch.py', 'automodpack/automodpack-server.json'].includes(path);
  if (!special && !roots.some((root) => path.startsWith(`${root}/`))) throw new Error(`not a pack-owned path: ${location}/${path}`);
  if (location === 'shelf' && path !== `mods/${basename(path)}`) throw new Error('shelf files must be direct mods/ children');
  return path;
}
export async function hashes(path: string): Promise<{ sha512: string; sha1: string; size: number }> {
  if (!lstatSync(path).isFile()) throw new Error(`not a regular file: ${path}`);
  const sha512 = createHash('sha512');
  const sha1 = createHash('sha1');
  let size = 0;
  for await (const bytes of createReadStream(path)) { sha512.update(bytes); sha1.update(bytes); size += bytes.length; }
  return { sha512: sha512.digest('hex'), sha1: sha1.digest('hex'), size };
}
/** Walk only explicitly pack-owned roots, refusing links rather than following
    them into a world or credential directory. */
export function packFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  if (!lstatSync(dir).isDirectory()) throw new Error(`not a regular pack directory: ${dir}`);
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name);
    const st = lstatSync(path);
    if (st.isSymbolicLink()) throw new Error(`pack contains a symlink: ${path}`);
    return st.isDirectory() ? packFiles(path) : st.isFile() ? [path] : [];
  });
}
export function readLock(id: string, revision: string): RevisionLock {
  const lock = JSON.parse(readFileSync(join(revisionDir(id, revision), 'lock.json'), 'utf8')) as RevisionLock;
  if (lock.schema !== 1 || lock.id !== revision) throw new Error('invalid revision lock');
  for (const f of lock.files) packPath(f.path, f.location);
  return lock;
}
export function revisionReport(id: string, revision: string): RevisionReport {
  return JSON.parse(readFileSync(join(revisionDir(id, revision), 'report.json'), 'utf8')) as RevisionReport;
}
export function reportRevision(id: string, revision: string, patch: Partial<RevisionReport>): void {
  const before = revisionReport(id, revision);
  writeFileAtomic(join(revisionDir(id, revision), 'report.json'), JSON.stringify({ ...before, ...patch, tests: { ...before.tests, ...patch.tests } }, null, 2));
}
export function revisionState(id: string): { active?: string; published?: string; managedHosting?: boolean } {
  const file = join(root(id), 'state.json');
  // A corrupt pointer must block starts, not silently drop back to legacy mode.
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}
export function setRevisionState(id: string, patch: ReturnType<typeof revisionState>): void {
  writeFileAtomic(join(root(id), 'state.json'), JSON.stringify({ ...revisionState(id), ...patch }, null, 2));
}
/** Legacy writers must not silently invalidate an immutable active pack. */
export function assertUnsealed(id: string): void {
  if (revisionState(id).active) throw new Error('this server has a locked revision; direct pack/config/runtime edits are refused. Stage a tested mod change instead');
}
export function assertPackPathWritable(id: string, path: string): void {
  const { active } = revisionState(id);
  if (!active) return;
  const rel = relative(serverDir(id), path).replace(/\\/g, '/');
  if (!rel || rel.startsWith('.spawnpoint-') || [...PACK_ROOTS, 'automodpack'].some((p) => rel === p || rel.startsWith(`${p}/`) || p.startsWith(`${rel}/`)) || readLock(id, active).files.some((f) => f.location === 'server' && (f.path === rel || f.path.startsWith(`${rel}/`)))) assertUnsealed(id);
}
/** The same OS lock is held for the JVM's entire lifetime by Crafty's guard.
    Kernel locks survive neither process death nor namespace boundaries: a
    crashed panel releases its lock, while the persisted marker blocks starts
    until journal recovery has finished. */
export async function withStoppedRevision<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const dir = serverDir(id);
  // Provision once and retain the inode: Crafty and the panel may run as
  // different users. Replacing it would split their kernel locks.
  const fence = join(dir, '.spawnpoint-runtime.lock');
  closeSync(openSync(fence, 'a'));
  if (process.platform !== 'win32' && process.getuid?.() === 0) {
    const { uid, gid } = statSync(dir);
    chownSync(fence, uid, gid);
  }
  const child = spawn(process.platform === 'win32' ? 'python' : 'python3', [fileURLToPath(new URL('./launchguard.py', import.meta.url)), '--fence'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', (b: Buffer) => { errors += b.toString(); });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error(`the stopped-server fence is unavailable: ${errors.slice(0, 160)}`)));
    child.stdout.once('data', () => resolve());
  });
  const marker = join(dir, '.spawnpoint-mutation');
  try {
    const { fullyStopped } = await import('./maintenance.js');
    if (!await fullyStopped(id)) throw new Error('revision mutation requires a confirmed stopped server');
    writeFileAtomic(marker, 'journal recovery required before starting\n');
    const result = await fn();
    rmSync(marker, { force: true });
    return result;
  } finally {
    child.stdin.end();
    await closed;
  }
}
const GUARD = `"${process.platform === 'win32' ? 'python' : 'python3'}" ".spawnpoint-launch.py" `;
/** Called only after the owner explicitly approves changing Crafty's launch
    recipe. The wrapper is mandatory even for starts outside the panel. */
export async function installLaunchGuard(id: string): Promise<void> {
  const { command } = await launchSpec(id); // validate before any side effect
  writeFileAtomic(join(serverDir(id), '.spawnpoint-launch.py'), readFileSync(new URL('./launchguard.py', import.meta.url)));
  if (!command.startsWith(GUARD)) await craftyApi.patchServer(id, { execution_command: GUARD + command });
  setRevisionState(id, { managedHosting: true });
}
/** A container can read the bind-mounted server, but not the panel's private
    data directory. Give its pre-JVM guard the lock's exact runtime inventory.
    Shelf files are verified in their published mirror, not host-only paths. */
export function writeLaunchGate(id: string): void {
  const { active } = revisionState(id);
  if (!active) return;
  const lock = readLock(id, active);
  const hold = hostingHold(id);
  const files = lock.files.map((f) => {
    const path = f.location === 'server' ? f.path : `automodpack/host-modpack/main/${f.path}`;
    const bytes = f.path === 'automodpack/automodpack-server.json' && hold?.paused;
    return { path, sha512: bytes ? createHash('sha512').update(bytes).digest('hex') : f.sha512, size: bytes ? Buffer.byteLength(bytes) : f.size };
  });
  writeFileAtomic(join(serverDir(id), '.spawnpoint-revision.json'), JSON.stringify({ revision: active, java: lock.java, command: lock.command, files, roots: [...PACK_ROOTS, 'automodpack/host-modpack/main'], hosting: hold }, null, 2));
}
/** Seal the exact launch specification as well as the files. A bare java or
    shell wrapper cannot certify which runtime Crafty will execute. */
export async function sealRevision(id: string, revision: string, inputs: RevisionInput[]): Promise<RevisionLock> {
  const dest = revisionDir(id, revision);
  if (existsSync(join(dest, 'lock.json'))) throw new Error('a sealed revision is immutable');
  const { det, loader, command, executable, argv } = await launchSpec(id);
  const version = await run(executable, ['-version']);
  const javaFiles = [];
  // Only executable runtime inputs, never the JDK certificate/trust stores.
  for (const file of readdirSync(dirname(dirname(executable)), { recursive: true, withFileTypes: true })) {
    const path = join(file.parentPath, file.name);
    if (file.isFile() && /(?:[\\/]modules|\.(?:so|dylib|dll))$/.test(path)) javaFiles.push({ path, ...await hashes(path) });
  }
  const java = { executable, version: (version.stderr || version.stdout).trim(), sha512: (await hashes(executable)).sha512, files: javaFiles };
  const part = `${dest}.part`;
  rmSync(part, { recursive: true, force: true });
  mkdirSync(part, { recursive: true });
  try {
    const files: LockedFile[] = [];
    const keys = new Set<string>();
    for (const input of inputs) {
      packPath(input.path, input.location);
      const key = `${input.location}/${input.path}`;
      if (keys.has(key)) throw new Error(`duplicate pack path: ${key}`);
      keys.add(key);
      if (!lstatSync(input.src).isFile()) throw new Error(`not a regular file: ${input.src}`);
      const copy = join(part, 'files', key);
      await mkdir(dirname(copy), { recursive: true });
      const held = input.path === 'automodpack/automodpack-server.json' && hostingHold(id);
      if (held) await writeFile(copy, held.original);
      else await copyFile(input.src, copy, constants.COPYFILE_FICLONE);
      const sum = await hashes(copy);
      if (input.entry?.sha1 && input.entry.sha1 !== sum.sha1) throw new Error(`source hash differs: ${input.path}`);
      files.push({ path: input.path, side: input.side, location: input.location, ...sum,
        source: input.entry ? { kind: input.entry.source, projectId: input.entry.projectId, versionId: input.entry.versionId } : { kind: 'local' },
        requested: input.entry?.via !== 'dependency',
      });
    }
    const sealed = await launchSpec(id, join(part, 'files', 'server'));
    if (sealed.command !== command || JSON.stringify(sealed.argv) !== JSON.stringify(argv) || sealed.det.mc !== det.mc || sealed.det.loader !== det.loader || sealed.loader !== loader) throw new Error('launch inputs changed while sealing the revision');
    files.sort((a, b) => `${a.location}/${a.path}`.localeCompare(`${b.location}/${b.path}`));
    const identity = (f: LockedFile): string => f.source.projectId ? `${f.source.kind}:${f.source.projectId}` : `${f.location}/${f.path}`;
    const lock: RevisionLock = { schema: 1, id: revision, minecraft: det.mc, loader: det.loader, loaderVersion: loader, java, command, arguments: argv.slice(1), files,
      requested: files.filter((f) => f.requested && f.path.startsWith('mods/') && f.path.endsWith('.jar')).map(identity),
      dependencies: files.filter((f) => !f.requested && f.path.startsWith('mods/') && f.path.endsWith('.jar')).map(identity) };
    writeFileAtomic(join(part, 'lock.json'), JSON.stringify(lock, null, 2));
    writeFileAtomic(join(part, 'report.json'), JSON.stringify({ tests: Object.fromEntries(['server', 'client', 'clientBoot', 'join', 'handshake', 'rendering', 'liveBoot', 'publication'].map((test) => [test, { result: 'skipped', detail: 'not run yet', renderer: 'none' }])) }));
    renameSync(part, dest);
    return lock;
  } catch (e) {
    rmSync(part, { recursive: true, force: true });
    throw e;
  }
}
/** One validator for adoption and sealing: refuse unsupported recipes before
    changing Crafty. Arbitrary agents, @files and --universe can escape tests. */
async function launchSpec(id: string, dir = serverDir(id)) {
  const det = detect(dir, id);
  const loader = loaderVersion(dir, det);
  if (!det.mc || !loader) throw new Error('Minecraft and loader versions must be known before sealing a revision');
  if (det.loader !== 'fabric' && !(det.loader === 'forge' && det.mc === '1.20.1' && loader === '47.4.28')) throw new Error('locked revisions support Fabric and the certified Forge 1.20.1 / 47.4.28 recipe');
  const command = (await craftyApi.getServer(id)).execution_command;
  const javaCommand = command.startsWith(GUARD) ? command.slice(GUARD.length) : command;
  const executable = /^"([^"]+)"|^(\S+)/.exec(javaCommand)?.slice(1).find(Boolean);
  if (!executable || executable !== javaFor(det.mc, det.loader)) throw new Error('the server and test must use the same explicit Tools/ Java runtime');
  const parsed = await run(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import json,shlex,sys; print(json.dumps(shlex.split(sys.argv[1])))', javaCommand]);
  let argv = JSON.parse(parsed.stdout) as string[];
  const heap = (arg: string): boolean => /^-Xm[sx]\d+[kKmMgG]$/.test(arg);
  if (det.loader === 'fabric') {
    const jar = argv.indexOf('-jar');
    if (argv[0] !== executable || jar < 1 || argv.slice(1, jar).some((a) => !heap(a)) || argv.slice(jar).join(' ') !== '-jar fabric.jar nogui') throw new Error('unsupported Fabric launch recipe; revision tests require only heap flags and -jar fabric.jar nogui');
  } else {
    const fml = join(dir, 'config', 'fml.toml');
    if (existsSync(fml)) {
      const config = parse(readFileSync(fml, 'utf8'));
      if (config.defaultConfigPath !== undefined && config.defaultConfigPath !== 'defaultconfigs') throw new Error('Forge defaultConfigPath overrides are not supported by locked revisions');
    }
    const autoModpack = join(dir, 'automodpack', 'automodpack-server.json');
    const mods = join(dir, 'mods');
    const hasAutoModpack = existsSync(mods) && readdirSync(mods).some((file) => /^automodpack.*\.jar$/i.test(file));
    if (hasAutoModpack && !existsSync(autoModpack)) throw new Error('Locked Forge AutoModpack requires an explicit managed-publication config before testing');
    if (existsSync(autoModpack)) {
      const held = dir === serverDir(id) && hostingHold(id);
      const cfg = JSON.parse(held ? held.original : readFileSync(autoModpack, 'utf8'));
      if (cfg.DO_NOT_CHANGE_IT !== 2 || cfg.modpackHost !== true || cfg.generateModpackOnStart !== true || cfg.selfUpdater !== false) throw new Error('Locked Forge AutoModpack requires a version 2 managed-publication config with hosting and generation enabled, and selfUpdater:false');
    }
    const name = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
    const argfile = `libraries/net/minecraftforge/forge/${det.mc}-${loader}/${name}`;
    const index = argv.indexOf(`@${argfile}`);
    const prefix = argv.slice(1, index);
    if (argv[0] !== executable || index < 1 || argv.slice(index).join(' ') !== `@${argfile} nogui`
      || prefix.filter((arg) => arg === '@user_jvm_args.txt').length > 1 || prefix.some((arg) => arg !== '@user_jvm_args.txt' && !heap(arg))) throw new Error('unsupported Forge launch recipe; only heap flags, @user_jvm_args.txt and the certified loader argfile are allowed');
    // Exact official installer data, not an allowlist that could admit agents,
    // absolute classpaths, nested @files, a different target or world options.
    const bytes = readFileSync(join(dir, argfile));
    const expected = name === 'win_args.txt'
      ? 'f86ee984b4577121b7fcbc41f4c5db5457370e7037841e97ceb348b9f9e928fcd5d9fae8320e3ce8399a1e8e46737d62044be5ce2bbe29cfb9fedc1b856c8e30'
      : '667b0896ec529f99355eaf05761c6d0411c9b14b5c92a2eb9ba1dc3fbff82d1c6f60c27ac07e00f78ceeb40b705bad66ce3e5a64b0aac3c767849e4fb05094e5';
    if (createHash('sha512').update(bytes).digest('hex') !== expected) throw new Error('Forge loader arguments differ from the certified official installer');
    const flags = prefix.flatMap((arg) => arg !== '@user_jvm_args.txt' ? [arg]
      : readFileSync(join(dir, 'user_jvm_args.txt'), 'utf8').replace(/#[^\r\n]*/g, '').split(/\s+/).filter(Boolean));
    if (flags.some((arg) => !heap(arg))) throw new Error('Forge user_jvm_args.txt must contain only heap flags and comments');
    // The sandbox uses the sealed expansion, so its smaller heap cannot be
    // overridden by an @file. Crafty's invocation and both files stay locked.
    argv = [executable, ...flags, ...bytes.toString('utf8').trim().split(/\s+/), 'nogui'];
  }
  return { det: { ...det, mc: det.mc }, loader, command, executable, argv };
}
export function livePath(id: string, f: Pick<LockedFile, 'path' | 'location'>): string {
  packPath(f.path, f.location);
  return f.location === 'shelf' ? join(clientShelfDir(id), basename(f.path))
    : join(f.location === 'server' ? serverDir(id) : join(serverDir(id), 'automodpack', 'host-modpack', 'main'), f.path);
}
export async function verifyRevision(id: string, revision: string, live = false): Promise<RevisionLock> {
  const lock = readLock(id, revision);
  for (const f of lock.files) {
    const path = live ? livePath(id, f) : lockedPath(id, revision, f);
    const sum = await hashes(path);
    // Managed hosting changes exactly one operational flag, with owner
    // consent. No other configuration drift is exempted from the lock.
    if (live && f.path === 'automodpack/automodpack-server.json') {
      const hold = hostingHold(id);
      if (hold && readFileSync(path, 'utf8') === hold.paused && createHash('sha512').update(hold.original).digest('hex') === f.sha512) continue;
    }
    if (sum.sha512 !== f.sha512 || sum.size !== f.size) throw new Error(`revision ${revision}: different bytes for ${f.location}/${f.path}`);
  }
  if (live) {
    const det = detect(serverDir(id), id);
    const srv = await craftyApi.getServer(id);
    if (det.mc !== lock.minecraft || det.loader !== lock.loader || loaderVersion(serverDir(id), det) !== lock.loaderVersion || srv.execution_command !== lock.command || (await hashes(lock.java.executable)).sha512 !== lock.java.sha512) throw new Error('the launch runtime differs from the revision lock');
    for (const f of lock.java.files) if ((await hashes(f.path)).sha512 !== f.sha512) throw new Error(`Java runtime file changed: ${f.path}`);
    for (const [location, dir, prefix] of [...PACK_ROOTS.map((name) => ['server', join(serverDir(id), name), name] as const), ['shelf', clientShelfDir(id), 'mods'], ['extra', join(serverDir(id), 'automodpack', 'host-modpack', 'main'), '']] as const) {
      const expected = new Set(lock.files.filter((f) => f.location === location).map((f) => f.path));
      for (const path of packFiles(dir)) {
        const rel = [prefix, relative(dir, path).replace(/\\/g, '/')].filter(Boolean).join('/');
        // The shelf mirror is verified against the client inventory at publication.
        if (location === 'extra' && rel.startsWith('mods/') && lock.files.some((f) => f.location === 'shelf' && f.path === rel)) continue;
        if (!expected.has(rel)) throw new Error(`revision ${revision}: unlisted file ${location}/${rel}`);
      }
    }
  }
  return lock;
}
/** Materialize an entire sealed inventory through the existing move journal.
    Altered/removed files stay in a location-namespaced archive, including
    configs a failed boot rewrote. This never walks or restores a world. */
export async function revisionMoves(id: string, revision: string, archive: string): Promise<[string, string][]> {
  const lock = await verifyRevision(id, revision);
  const desired = new Map<string, { src: string; bytes?: string; sha512: string; key: string }>();
  for (const f of lock.files) {
    const paused = f.path === 'automodpack/automodpack-server.json' ? hostingHold(id)?.paused : undefined;
    const item = { src: lockedPath(id, revision, f), bytes: paused, sha512: paused ? createHash('sha512').update(paused).digest('hex') : f.sha512, key: `${f.location}/${f.path}` };
    desired.set(livePath(id, f), item);
    if (f.location === 'shelf' && f.path.endsWith('.jar')) desired.set(join(serverDir(id), 'automodpack', 'host-modpack', 'main', f.path), { ...item, key: `mirror/${f.path}` });
  }
  const current = new Map<string, string>();
  const dir = serverDir(id);
  for (const name of [...PACK_ROOTS, 'automodpack/host-modpack/main']) for (const file of packFiles(join(dir, name))) current.set(file, `server/${safePath(relative(dir, file).replace(/\\/g, '/'))}`);
  for (const file of packFiles(clientShelfDir(id))) current.set(file, `shelf/mods/${safePath(relative(clientShelfDir(id), file).replace(/\\/g, '/'))}`);
  for (const [file, item] of desired) current.set(file, item.key);
  const moves: [string, string][] = [];
  for (const [file, key] of current) {
    const wanted = desired.get(file);
    if (wanted && existsSync(file) && (await hashes(file)).sha512 === wanted.sha512) continue;
    const before = join(archive, 'before', key);
    const after = join(archive, 'after', key);
    if (existsSync(before)) throw new Error(`revision archive already exists: ${key}`);
    if (existsSync(file)) moves.push([file, before]);
    if (wanted) {
      await mkdir(dirname(after), { recursive: true });
      if (wanted.bytes !== undefined) await writeFile(after, wanted.bytes);
      else await copyFile(wanted.src, after, constants.COPYFILE_FICLONE);
      moves.push([after, file]);
    }
  }
  return moves;
}
/** Additional pack-owned inputs shared by the two tests. No broad root walk. */
export function revisionInputs(id: string): RevisionInput[] {
  const dir = serverDir(id);
  const ledger = ledgerEntries(id);
  const inputs: RevisionInput[] = [];
  for (const name of ['config', 'defaultconfigs', 'kubejs', 'emotes']) for (const src of packFiles(join(dir, name))) inputs.push({ src, path: relative(dir, src).replace(/\\/g, '/'), side: 'server', location: 'server' });
  const amConfig = join(dir, 'automodpack', 'automodpack-server.json');
  if (existsSync(amConfig)) inputs.push({ src: amConfig, path: 'automodpack/automodpack-server.json', side: 'server', location: 'server' });
  // Remap caches and processed mods are generated outputs, not launch inputs.
  // The downloaded Minecraft jar under .fabric/server is a launch input.
  for (const name of ['.spawnpoint-launch.py', 'fabric.jar', 'user_jvm_args.txt', 'libraries', 'versions', '.fabric/server']) {
    const src = join(dir, name);
    if (!existsSync(src)) continue;
    for (const file of lstatSync(src).isDirectory() ? packFiles(src) : [src]) inputs.push({ src: file, path: relative(dir, file).replace(/\\/g, '/'), side: 'server', location: 'server' });
  }
  for (const src of packFiles(join(dir, 'mods'))) inputs.push({ src, path: `mods/${relative(join(dir, 'mods'), src).replace(/\\/g, '/')}`, location: 'server', side: src.endsWith('.jar') ? 'both' : 'server', entry: ledger.find((e) => e.file === basename(src)) });
  return inputs;
}

/** Public starts use the same gate as promotion. Legacy servers have no
    active lock until their first revision; they keep their existing behavior. */
export async function verifyActiveRevision(id: string): Promise<void> {
  const { active } = revisionState(id);
  if (active) await verifyRevision(id, active, true);
}
