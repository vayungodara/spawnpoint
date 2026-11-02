import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { PATHS } from '../config.js';
import { craftyApi } from '../clients/crafty.js';
import { transferRecord } from './native.js';
import { detect, loaderVersion } from './detect.js';
import { serverDir, toolsJava } from './servers.js';
import { ensureJdk } from './temurin.js';
import { fetchRecipe, resolveRecipe } from './recipes.js';
import { GUARD, certifiedFml, revisionState, withStoppedRevision } from './revisions.js';
import { candidate, exclusive, liveChanged } from './packtxn.js';
import { beginMaintenance, createStoppedBackup, endMaintenance, isRunningSafe } from './maintenance.js';
import { dryBoot, type Verdict } from './preflight.js';
import { IS_WIN, ROOT_PANEL, giveTree, writeFileAtomic } from './platform.js';

// CHANGE AN FML SERVER'S LOADER BUILD to the one certified recipe for its
// Minecraft release (Forge 1.20.1 / 47.4.28, NeoForge 1.21.1 / 21.1.219).
//
//   test()     the official installer, checked against Maven, installs into
//              panel data; a copy of the live pack boots on the old and on
//              the new loader and their mod IDs and ERROR lines are compared
//   apply()    owner-approved, stopped and fenced: world backup, then a
//              journaled swap of libraries/ and the launch command
//   rollback() the old libraries/, root files and command, while no locked
//              revision depends on the new loader
//
// Each swap step is decided by which directories exist, so an interrupted
// apply or rollback finishes on the next attempt. While the files move, the
// launch command refuses to start Java, also for starts outside the panel.

export interface BootSummary { result: Verdict['result']; detail: string; seconds?: number; mods: string[]; errors: string[]; excerpt?: string[] }
export interface Comparison {
  result: 'passed' | 'failed' | 'inconclusive';
  detail: string;
  baseline: BootSummary;
  candidate: BootSummary;
  added: string[];
  removed: string[];
  newErrors: string[];
}
export interface LoaderChange {
  loader: 'forge' | 'neoforge';
  mc: string;
  from: string;
  to: string;
  stage: 'testing' | 'failed' | 'needs-approval' | 'applying' | 'applied' | 'rolling-back' | 'rolled-back';
  detail: string;
  /** Changes on every test; approval names it. */
  token: string;
  installer?: { url: string; algo: string; hash: string };
  command?: { before: string; after: string };
  jvmArgs?: { before: string | null; after: string };
  /** JVM arguments the certified recipe does not accept. */
  dropped?: string[];
  /** What the test ran against: approval refuses once this changes. */
  fingerprint?: string;
  test?: Comparison;
  /** Root files the old installer wrote, restored by rollback. */
  files?: Record<string, string | null>;
  backup?: string | null;
  at: string;
}

const run = promisify(execFile);
const base = (id: string): string => { serverDir(id); return join(PATHS.data, 'loaderchange', id); };
const stateFile = (id: string): string => join(base(id), 'state.json');
const ROOT_FILES = ['run.sh', 'run.bat'];
const HOLD = `"${IS_WIN ? 'python' : 'python3'}" -c "raise SystemExit('Use Spawnpoint: a loader change is in progress')"`;
const heap = (arg: string): boolean => /^-Xm[sx]\d+[kKmMgG]$/.test(arg);
const running = new Set<string>();

export function loaderChange(id: string): LoaderChange | null {
  let s: LoaderChange;
  try { s = JSON.parse(readFileSync(stateFile(id), 'utf8')); } catch { return null; }
  // A test cut short by a panel restart has no verdict to approve.
  if (s.stage === 'testing' && !running.has(id)) return { ...s, stage: 'failed', detail: 'the test was cut short by a panel restart; test again' };
  return s;
}
const save = (id: string, s: LoaderChange): void => writeFileAtomic(stateFile(id), JSON.stringify(s, null, 2));

/** What the server runs and what it would change to, or null when it already
    runs the certified build with a certified command, or has no such build. */
export async function loaderOffer(id: string): Promise<{ loader: 'forge' | 'neoforge'; mc: string; from: string; to: string; reason: string } | null> {
  const dir = serverDir(id);
  const det = detect(dir, id);
  if (det.loader !== 'forge' && det.loader !== 'neoforge') return null;
  const target = certifiedFml(det.loader, det.mc);
  const from = loaderVersion(dir, det);
  if (!target || !from || revisionState(id).active) return null;
  const name = det.loader === 'forge' ? 'Forge' : 'NeoForge';
  if (from !== target.version) return { loader: det.loader, mc: det.mc!, from, to: target.version, reason: `Tested changes and Move need ${name} ${target.version}; this server runs ${from}.` };
  const command = (await craftyApi.getServer(id)).execution_command;
  return certifiedShape(command, target.argfile, readUserJvmArgs(dir)) ? null
    : { loader: det.loader, mc: det.mc!, from, to: target.version, reason: `${name} ${from} is certified, but its launch command is not the certified recipe.` };
}

const readUserJvmArgs = (dir: string): string | null => { try { return readFileSync(join(dir, 'user_jvm_args.txt'), 'utf8'); } catch { return null; } };
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function certifiedShape(command: string, argfile: string, userJvmArgs: string | null): boolean {
  const flags = (userJvmArgs ?? '').replace(/#[^\r\n]*/g, '').split(/\s+/).filter(Boolean);
  return new RegExp(`^(?:${escape(GUARD)})?"[^"]+[\\\\/]Tools[\\\\/]jdk-21[^"]*[\\\\/]bin[\\\\/]java(?:\\.exe)?"(?: (?:-Xm[sx]\\d+[kKmMgG]|@user_jvm_args\\.txt))* @${escape(argfile)} nogui$`).test(command)
    && flags.every(heap);
}

/** The certified invocation for an existing command: the old effective heap
    (later flags win, as in Java), the locked Java and the argfile. Every other
    argument is dropped and reported. */
export function certifiedLaunch(argv: string[], userJvmArgs: string | null, java: string, argfile: string, guarded = false):
  { command: string; userJvmArgs: string; dropped: string[] } {
  const tokens = argv.slice(1).flatMap((arg) => arg === '@user_jvm_args.txt' ? (userJvmArgs ?? '').replace(/#[^\r\n]*/g, '').split(/\s+/).filter(Boolean) : [arg]);
  let xms: string | undefined, xmx: string | undefined;
  const dropped: string[] = [];
  for (const arg of tokens) {
    if (heap(arg)) { if (arg.startsWith('-Xms')) xms = arg; else xmx = arg; }
    // the loader's own target, the console flag and run.sh's "$@"
    else if (arg !== 'nogui' && arg !== '--nogui' && arg !== '$@' && !/^@libraries\/[^\s]+_args\.txt$/.test(arg)) dropped.push(arg);
  }
  return {
    command: `${guarded ? GUARD : ''}${JSON.stringify(java.replaceAll('\\', '/'))} @user_jvm_args.txt @${argfile} nogui`,
    userJvmArgs: `# Heap flags only: the certified ${argfile.includes('neoforged') ? 'NeoForge' : 'Forge'} recipe accepts nothing else here.\n${[xms, xmx].filter(Boolean).join('\n')}\n`,
    dropped,
  };
}

/** The mod IDs a booted server listed (`forge mods` / `neoforge mods`). */
export function modIds(output: string): string[] {
  const list = /Mod List: *\r?\n((?:•[^\n]*\n)+)/.exec(output)?.[1] ?? '';
  return [...new Set(list.split('\n').map((l) => / : (\S+) \(/.exec(l)?.[1]).filter((m): m is string => !!m))].sort();
}

/** ERROR lines before the server stopped, without time, thread or scratch path. */
export function errorLines(output: string): string[] {
  const end = output.search(/Stopping the server/);
  return (end < 0 ? output : output.slice(0, end)).split(/\r?\n/).flatMap((line) => {
    const m = /^\[[\d:.]+\] \[[^\]]*\/ERROR\] (.*)$/.exec(line);
    return m ? [m[1].replace(/\S*[\\/]sandbox[\\/]preflight-[^\\/\s]+/g, '<server>').replace(/@[0-9a-f]{6,}\b/g, '@…').slice(0, 300)] : [];
  });
}

const summary = (v: Verdict): BootSummary => ({ result: v.result, detail: v.detail, seconds: v.seconds, mods: modIds(v.output ?? ''), errors: errorLines(v.output ?? ''), excerpt: v.excerpt });

/** The new loader must boot what the old one boots: the same mod IDs, and
    no ERROR line the old loader did not also log. */
export function compareBoots(baseline: BootSummary, next: BootSummary): Comparison {
  const added = next.mods.filter((m) => !baseline.mods.includes(m));
  const removed = baseline.mods.filter((m) => !next.mods.includes(m));
  const left = [...baseline.errors];
  const newErrors = next.errors.filter((e) => { const i = left.indexOf(e); if (i < 0) return true; left.splice(i, 1); return false; });
  const base = { baseline, candidate: next, added, removed, newErrors };
  if (baseline.result !== 'passed' || !baseline.mods.length) return { ...base, result: 'inconclusive', detail: `the current loader did not boot a copy for comparison: ${baseline.detail}` };
  if (next.result === 'unverified') return { ...base, result: 'inconclusive', detail: next.detail };
  if (next.result !== 'passed') return { ...base, result: 'failed', detail: `the new loader did not boot: ${next.detail}` };
  if (added.length || removed.length) return { ...base, result: 'failed', detail: `the mod list differs (${[...removed.map((m) => `missing ${m}`), ...added.map((m) => `new ${m}`)].join(', ')})` };
  if (newErrors.length) return { ...base, result: 'failed', detail: `${newErrors.length} ERROR line${newErrors.length === 1 ? '' : 's'} appear only on the new loader` };
  return { ...base, result: 'passed', detail: `both reached Done with the same ${next.mods.length} mod IDs${next.errors.length ? ` and the same ${next.errors.length} ERROR line${next.errors.length === 1 ? '' : 's'}` : ' and no ERROR lines'}` };
}

/** rename(), or across volumes a complete copy published by rename before
    the source is removed. A leftover part copy is never trusted. */
function moveTree(src: string, dst: string): void {
  rmSync(`${dst}.spawnpoint-part`, { recursive: true, force: true });
  try { renameSync(src, dst); return; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e; }
  cpSync(src, `${dst}.spawnpoint-part`, { recursive: true, verbatimSymlinks: true });
  renameSync(`${dst}.spawnpoint-part`, dst);
  rmSync(src, { recursive: true, force: true });
}

/** Put new/libraries live and keep the live one in old/. Safe to repeat. */
export function swapIn(dir: string, work: string): void {
  const live = join(dir, 'libraries'), fresh = join(work, 'new', 'libraries'), old = join(work, 'old', 'libraries');
  if (!existsSync(fresh)) return;
  if (!existsSync(old)) {
    if (!existsSync(live)) throw new Error('this server has no libraries folder to back up');
    mkdirSync(join(work, 'old'), { recursive: true });
    moveTree(live, old);
  } else rmSync(live, { recursive: true, force: true }); // an old leftover or a copy of the new one
  moveTree(fresh, live);
}

/** Put old/libraries back live. Also finishes or reverses an interrupted swapIn. */
export function swapBack(dir: string, work: string): void {
  const live = join(dir, 'libraries'), old = join(work, 'old', 'libraries');
  rmSync(`${old}.spawnpoint-part`, { recursive: true, force: true });
  if (!existsSync(old)) return;
  rmSync(live, { recursive: true, force: true });
  moveTree(old, live);
}

/** What a test result depends on: the live jars, the loader files and the command. */
async function fingerprint(id: string): Promise<string> {
  const dir = serverDir(id), h = createHash('sha256');
  const mods = join(dir, 'mods');
  for (const f of existsSync(mods) ? readdirSync(mods).filter((f) => f.endsWith('.jar')).sort() : []) h.update(`${f}\0`).update(readFileSync(join(mods, f))).update('\0');
  const det = detect(dir, id);
  h.update(`${loaderVersion(dir, det)}\0${(await craftyApi.getServer(id)).execution_command}\0${readUserJvmArgs(dir) ?? ''}`);
  return h.digest('hex');
}

const liveJars = (id: string): string[] => {
  const mods = join(serverDir(id), 'mods');
  return existsSync(mods) ? readdirSync(mods).filter((f) => f.endsWith('.jar')).map((f) => join(mods, f)) : [];
};

/** Who must own the files the panel writes into this server. */
function owner(id: string): { uid: number; gid: number } | null {
  if (IS_WIN) return null;
  const { uid, gid } = statSync(serverDir(id));
  if (uid === process.getuid!()) return null;
  if (!ROOT_PANEL) throw new Error(`this server's files belong to another account (uid ${uid}); change its loader from a panel started as root or as that account`);
  return { uid, gid };
}

function assertChangeable(id: string): void {
  if (transferRecord(id)) throw new Error('finish or cancel the ownership transfer first');
  if (revisionState(id).active) throw new Error('this server has a locked revision; its loader files are sealed');
  const c = candidate(id);
  if (c && ['collecting', 'testing', 'activating', 'ready'].includes(c.status)) throw new Error('a mod change is open on this server; finish or discard it first');
}

/** Install the certified build into panel data and compare test boots. */
export async function testLoaderChange(id: string, log: (m: string) => void): Promise<LoaderChange> {
  if (running.has(id)) throw new Error('a loader test is already running');
  const prior = loaderChange(id);
  if (prior && ['applying', 'applied', 'rolling-back'].includes(prior.stage)) throw new Error(prior.stage === 'applied' ? 'the loader was already changed; roll it back before testing another change' : 'finish the interrupted loader change first');
  assertChangeable(id);
  owner(id);
  const offer = await loaderOffer(id);
  if (!offer) throw new Error('this server already runs its certified loader recipe, or none exists for its Minecraft version');
  const s: LoaderChange = { loader: offer.loader, mc: offer.mc, from: offer.from, to: offer.to, stage: 'testing', detail: 'resolving the official installer', token: randomBytes(12).toString('hex'), at: new Date().toISOString() };
  rmSync(base(id), { recursive: true, force: true });
  running.add(id);
  save(id, s);
  void (async () => {
    const status = (detail: string): void => { s.detail = detail; save(id, s); };
    try {
      const recipe = await resolveRecipe(offer.loader, offer.mc);
      const target = certifiedFml(offer.loader, offer.mc)!;
      if (recipe.build !== target.version || !('url' in recipe.download)) throw new Error(`upstream resolved ${recipe.build}, not the certified ${target.version}`);
      s.installer = { url: recipe.download.url, algo: recipe.download.algo, hash: recipe.download.hash };
      status(`downloading Java ${recipe.java} and the official installer`);
      if (!await ensureJdk(recipe.java, () => {})) throw new Error(`could not install Java ${recipe.java}`);
      const java = toolsJava(recipe.java)!;
      const part = join(base(id), 'new.part');
      rmSync(part, { recursive: true, force: true });
      mkdirSync(part, { recursive: true });
      writeFileSync(join(part, 'installer.jar'), await fetchRecipe(recipe));
      status(`installing ${offer.loader} ${target.version} into a copy`);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(java, ['-Xmx1G', '-jar', 'installer.jar', '--installServer'], { cwd: part, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        const keep = (b: Buffer): void => { out = (out + b.toString()).slice(-200_000); };
        child.stdout.on('data', keep); child.stderr.on('data', keep);
        const timer = setTimeout(() => child.kill(), 15 * 60_000);
        child.once('error', reject);
        child.once('close', (code) => { clearTimeout(timer); writeFileSync(join(base(id), 'installer.log'), out); if (code === 0) resolve(); else reject(new Error(`the installer exited with ${code}; see data/loaderchange/${id}/installer.log`)); });
      });
      const args = join(part, target.argfile);
      if (!existsSync(args) || createHash('sha512').update(readFileSync(args)).digest('hex') !== target.sha512) throw new Error('the installer did not produce the certified argument file');
      // Only loader files go live: libraries/ and the installer's run scripts.
      for (const f of readdirSync(part)) if (f !== 'libraries' && !ROOT_FILES.includes(f)) rmSync(join(part, f), { recursive: true, force: true });
      renameSync(part, join(base(id), 'new'));

      const dir = serverDir(id);
      const before = (await craftyApi.getServer(id)).execution_command;
      const guarded = before.startsWith(GUARD);
      const parsed = await run(IS_WIN ? 'python' : 'python3', ['-c', 'import json,shlex,sys; print(json.dumps(shlex.split(sys.argv[1])))', guarded ? before.slice(GUARD.length) : before]);
      const jvmBefore = readUserJvmArgs(dir);
      const next = certifiedLaunch(JSON.parse(parsed.stdout), jvmBefore, java, target.argfile, guarded);
      Object.assign(s, { command: { before, after: next.command }, jvmArgs: { before: jvmBefore, after: next.userJvmArgs }, dropped: next.dropped, fingerprint: await fingerprint(id) });

      const jars = liveJars(id);
      const probe = `${offer.loader} mods`;
      status(`boot-testing a copy on ${offer.loader} ${offer.from} for the baseline`);
      const old = summary(await dryBoot(id, jars, status, dir, undefined, { probe }));
      status(`boot-testing a copy on ${offer.loader} ${target.version}`);
      const fresh = summary(await dryBoot(id, jars, status, dir, undefined, { probe, loaderDir: join(base(id), 'new') }));
      s.test = compareBoots(old, fresh);
      s.stage = s.test.result === 'passed' ? 'needs-approval' : 'failed';
      s.detail = s.test.detail;
      if (await fingerprint(id) !== s.fingerprint) Object.assign(s, { stage: 'failed', detail: 'the server changed during the test; test again' });
    } catch (e) {
      Object.assign(s, { stage: 'failed', detail: String((e as Error).message ?? e).slice(0, 300) });
      log(`loader change ${id}: ${s.detail}`);
    } finally {
      running.delete(id);
      save(id, s);
    }
  })();
  return s;
}

/** Approved: back up the world, swap the loader files and the command. */
export async function applyLoaderChange(id: string, token: string): Promise<LoaderChange> {
  const s = loaderChange(id);
  if (!s || s.token !== token || !['needs-approval', 'applying'].includes(s.stage)) throw new Error('approve the loader change you reviewed; it changed or was not tested');
  return fenced(id, 'loader change', async () => {
    assertChangeable(id);
    const ownedBy = owner(id);
    if (s.stage === 'needs-approval') {
      if (await fingerprint(id) !== s.fingerprint) throw new Error('the server changed since it was tested; test again');
      const dir = serverDir(id);
      s.files = Object.fromEntries(ROOT_FILES.map((f) => [f, existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : null]));
      s.backup = await createStoppedBackup(id, `loader-${s.token}`);
      Object.assign(s, { stage: 'applying', detail: 'switching the loader files' });
      save(id, s);
    }
    await setCommand(id, HOLD);
    const dir = serverDir(id), work = base(id);
    swapIn(dir, work);
    if (ownedBy) giveTree(ownedBy.uid, ownedBy.gid, join(dir, 'libraries'));
    for (const f of ROOT_FILES) if (existsSync(join(work, 'new', f))) writeFileAtomic(join(dir, f), readFileSync(join(work, 'new', f)));
    writeFileAtomic(join(dir, 'user_jvm_args.txt'), s.jvmArgs!.after);
    await setCommand(id, s.command!.after);
    Object.assign(s, { stage: 'applied', detail: `now runs ${s.loader} ${s.to}`, at: new Date().toISOString() });
    save(id, s);
    return s;
  });
}

/** The old libraries, root files and command, before a revision seals the new ones. */
export async function rollbackLoaderChange(id: string): Promise<LoaderChange> {
  const s = loaderChange(id);
  if (!s || !['applying', 'applied', 'rolling-back'].includes(s.stage)) throw new Error('there is no loader change to roll back');
  return fenced(id, 'loader rollback', async () => {
    assertChangeable(id);
    const ownedBy = owner(id);
    Object.assign(s, { stage: 'rolling-back', detail: 'restoring the old loader files' });
    save(id, s);
    await setCommand(id, HOLD);
    const dir = serverDir(id);
    swapBack(dir, base(id));
    if (ownedBy) giveTree(ownedBy.uid, ownedBy.gid, join(dir, 'libraries'));
    for (const [f, bytes] of Object.entries(s.files ?? {})) {
      if (bytes === null) rmSync(join(dir, f), { force: true });
      else writeFileAtomic(join(dir, f), bytes);
    }
    if (s.jvmArgs?.before === null) rmSync(join(dir, 'user_jvm_args.txt'), { force: true });
    else if (s.jvmArgs) writeFileAtomic(join(dir, 'user_jvm_args.txt'), s.jvmArgs.before);
    await setCommand(id, s.command!.before);
    rmSync(join(base(id), 'new'), { recursive: true, force: true });
    Object.assign(s, { stage: 'rolled-back', detail: `back on ${s.loader} ${s.from}`, at: new Date().toISOString() });
    save(id, s);
    return s;
  });
}

/** Forget a test that was not applied. */
export function discardLoaderChange(id: string): void {
  const s = loaderChange(id);
  if (running.has(id) || (s && ['applying', 'applied', 'rolling-back'].includes(s.stage))) throw new Error('this loader change is live or running; roll it back instead');
  rmSync(base(id), { recursive: true, force: true });
}

async function setCommand(id: string, command: string): Promise<void> {
  if ((await craftyApi.getServer(id)).execution_command === command) return;
  await craftyApi.patchServer(id, { execution_command: command });
  if ((await craftyApi.getServer(id)).execution_command !== command) throw new Error('the runtime did not acknowledge the new launch command');
}

/** One live-folder writer, a stopped server and its runtime fence. */
async function fenced<T>(id: string, op: string, fn: () => Promise<T>): Promise<T> {
  if (await isRunningSafe(id)) throw new Error('stop the server first');
  const busy = beginMaintenance(id, op);
  if (busy) throw new Error(busy);
  try {
    return await exclusive(id, () => withStoppedRevision(id, fn));
  } finally {
    endMaintenance(id, op);
    liveChanged(id);
  }
}
