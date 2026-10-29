import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync, cpSync, copyFileSync, constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, basename, dirname, relative } from 'node:path';
import { PATHS } from '../config.js';
import { serverDir, javaFor } from './servers.js';
import { detect, type Detection } from './detect.js';
import { IS_WIN, withMemory } from './platform.js';
import { hashes, packFiles, packPath, type RevisionLock } from './revisions.js';

// SERVER BOOT TEST. The loader is the only honest judge of whether a mod set
// boots, so the panel does not model compatibility: it boots the real thing.
// A sandbox gets the server's loader and libraries, the mod jars under test
// and is launched for real. Fabric initializes before the EULA check. Forge
// initializes after it, so Forge must reach Done in a fresh disposable world
// on a loopback-only ephemeral port, then stop before outputs are captured.

export interface Verdict {
  result: 'passed' | 'failed' | 'unverified';
  detail: string;
  /** the loader's own words, cause lines first */
  excerpt?: string[];
  seconds?: number;
  renderer?: 'xvfb' | 'window' | 'headless' | 'none';
  checks?: Record<string, import('./revisions.js').TestResult>;
  /** Disposable boot outputs, proposed for a new test, never live edits. */
  configs?: { path: string; src?: string; remove?: boolean }[];
}

export const FORGE_ARGFILE = IS_WIN ? 'win_args.txt' : 'unix_args.txt';

// Short-lived JVM flags: C1-only JIT, ParallelGC and no perf-data mmap cut
// cold-start time without changing what loads or how it fails.
const FAST_BOOT = ['-XX:TieredStopAtLevel=1', '-XX:+UseParallelGC', '-XX:-UsePerfData'];

/** JVM arguments that boot this server's loader from inside its directory,
    or null when the loader has no boot recipe. Shared with the join test. */
export function loaderLaunchArgs(dir: string, det: Detection, heap: string): string[] | null {
  if (det.loader === 'fabric') return existsSync(join(dir, 'fabric.jar')) ? [heap, ...FAST_BOOT, '-jar', 'fabric.jar', 'nogui'] : null;
  if (det.loader !== 'forge' && det.loader !== 'neoforge') return null;
  const rel = det.loader === 'forge' ? ['net', 'minecraftforge', 'forge'] : ['net', 'neoforged', 'neoforge'];
  const fdir = join(dir, 'libraries', ...rel);
  const ver = existsSync(fdir) ? readdirSync(fdir)[0] : null;
  const argfile = ver ? ['libraries', ...rel, ver, FORGE_ARGFILE].join('/') : null;
  return argfile && existsSync(join(dir, argfile)) ? [heap, ...FAST_BOOT, `@${argfile}`, 'nogui'] : null;
}

/** Clone the loader and pack-owned config into a disposable sandbox. Never
    share writable links with the live server or an immutable revision. */
export function linkLoader(dir: string, sandbox: string, lock?: RevisionLock): void {
  if (lock) {
    for (const f of lock.files.filter((f) => f.location === 'server' && !f.path.startsWith('mods/'))) {
      const target = join(sandbox, f.path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(dir, f.path), target, constants.COPYFILE_FICLONE);
    }
    return;
  }
  for (const item of ['fabric.jar', 'libraries', 'versions', '.fabric', 'config', 'defaultconfigs', 'kubejs', 'emotes']) {
    const src = join(dir, item);
    if (existsSync(src)) cpSync(src, join(sandbox, item), { recursive: true, mode: constants.COPYFILE_FICLONE });
  }
}

const PASS_RE = /You need to agree to the EULA/i;
const FAIL_RE = /Incompatible mods found|Mod resolution failed|Missing or unsupported mandatory dependencies|Error during pre-launch|Failed to start the minecraft server|Exception in thread "main"/i;
const TIMEOUT_MS = 150_000;

/** The loader's own verdict lines first (which mod needs or breaks which),
    then "Caused by" lines deepest first, then error lines, then the raw tail. */
export function excerptOf(out: string): string[] {
  const lines = out.split('\n');
  const verdict = lines.filter((l) => /Missing or unsupported|requires .* of|Replace mod|which is missing!|Mod ID: |is incompatible with/i.test(l) && !/recommends/i.test(l));
  const cause = [...verdict, ...lines.filter((l) => /Caused by/.test(l)).reverse()];
  if (cause.length) return cause.slice(0, 8).map((l) => l.trim().slice(0, 220));
  const bad = lines.filter((l) => /incompatible|error|exception|missing|install /i.test(l) && !/\tat |recommends/i.test(l));
  return (bad.length ? bad : lines).slice(-8).map((l) => l.trim().slice(0, 220));
}

// a boot test costs about 2 GB, so only one runs at a time
let chain: Promise<unknown> = Promise.resolve();

/** Boot this server's loader with exactly `jars` (absolute paths) as its
    mods folder. Serialized globally. */
export function dryBoot(serverId: string, jars: string[], onStatus: (d: string) => void = () => {}, sourceDir = serverDir(serverId), lock?: RevisionLock): Promise<Verdict> {
  const test = async (): Promise<Verdict> => {
    // a mods-only boot stays well under 1 GB; the live server keeps its share
    let waited = false;
    const v = await withMemory(1, 'the server test', (d) => { waited = true; onStatus(d); }, () => {
      if (waited) onStatus('boot-testing the server with this change');
      return dryBootInner(serverId, jars, sourceDir, lock);
    });
    return typeof v === 'string' ? { result: 'unverified', detail: v } : v;
  };
  const run = chain.then(test, test);
  chain = run.catch(() => {});
  return run;
}

async function dryBootInner(serverId: string, jars: string[], dir: string, lock?: RevisionLock): Promise<Verdict> {
  const det = detect(dir, serverId);
  const launchArgs = lock ? lockedLaunchArgs(lock, '-Xmx1G') : loaderLaunchArgs(dir, det, '-Xmx2G');
  if (!launchArgs) return { result: 'unverified', detail: `Spawnpoint cannot boot-test ${det.loader} servers yet` };
  const java = lock?.java.executable ?? javaFor(det.mc, det.loader);
  if (!java) return { result: 'unverified', detail: 'no JDK for this Minecraft version yet; it downloads the first time the server starts' };

  const sandbox = join(PATHS.data, 'preflight', serverId);
  rmSync(sandbox, { recursive: true, force: true });
  mkdirSync(join(sandbox, 'mods'), { recursive: true });
  linkLoader(dir, sandbox, lock);
  for (const jar of jars) copyFileSync(jar, join(sandbox, 'mods', basename(jar)), constants.COPYFILE_FICLONE);
  const fullBoot = det.loader === 'forge' || det.loader === 'neoforge';
  const pass = fullBoot ? /Done \([\d.]+s\)!/ : PASS_RE;
  writeFileSync(join(sandbox, 'eula.txt'), `eula=${fullBoot}\n`, 'utf8');
  if (fullBoot) {
    writeFileSync(join(sandbox, 'server.properties'), 'server-ip=127.0.0.1\nserver-port=0\nenable-rcon=false\nonline-mode=false\nlevel-type=flat\ngenerate-structures=false\nview-distance=2\nsimulation-distance=2\nsync-chunk-writes=false\n');
    const config = join(sandbox, 'automodpack', 'automodpack-server.json');
    if (existsSync(config)) writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), modpackHost: false, generateModpackOnStart: false, selfUpdater: false }));
  }

  const started = Date.now();
  return await new Promise<Verdict>((resolve) => {
    const [cmd, args] = IS_WIN ? [java, launchArgs] : ['nice', ['-n', '19', java, ...launchArgs]];
    const child = spawn(cmd, args, { cwd: sandbox, stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    let out = '';
    let settled = false;
    const finish = async (v: Verdict): Promise<void> => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(killer);
      const shutdown = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 10_000);
      if (fullBoot && v.result === 'passed') child.stdin.end('stop\n');
      else try { child.kill('SIGKILL'); } catch { /* already dead */ }
      await closed; // no JVM can keep writing while outputs are captured
      clearTimeout(shutdown);
      try {
        if (lock && v.result === 'passed') {
          const before = new Map(lock.files.filter((f) => f.location === 'server' && f.path.startsWith('config/')).map((f) => [f.path, f.sha512]));
          const configs: NonNullable<Verdict['configs']> = [];
          for (const src of packFiles(join(sandbox, 'config'))) {
            const path = packPath(relative(sandbox, src).replace(/\\/g, '/'), 'server');
            if ((await hashes(src)).sha512 !== before.get(path)) {
              const dest = join(PATHS.data, 'preflight', `${serverId}-outputs`, path);
              mkdirSync(dirname(dest), { recursive: true });
              copyFileSync(src, dest, constants.COPYFILE_FICLONE);
              configs.push({ path, src: dest });
            }
            before.delete(path);
          }
          for (const path of before.keys()) configs.push({ path, remove: true });
          if (configs.length) v = { ...v, configs };
        }
      } catch (e) { v = { result: 'unverified', detail: `could not capture generated configs: ${String(e)}` }; }
      // the log outlives the sandbox wipe so the panel can show it
      try { writeFileSync(join(PATHS.data, 'preflight', `${serverId}.log`), out, 'utf8'); } catch { /* diagnostics only */ }
      rmSync(sandbox, { recursive: true, force: true });
      resolve({ ...v, seconds: Math.round((Date.now() - started) / 1000) });
    };
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('error', (e) => { void finish({ result: 'unverified', detail: `could not launch the server test: ${e.message}` }); });
    // Reap the JVM before capturing outputs. Forge's EULA line alone says
    // nothing about mod construction and can never pass this check.
    const poll = setInterval(() => {
      if (pass.test(out)) finish({ result: 'passed', detail: `the server booted with ${jars.length} mods${fullBoot ? ' into a disposable world' : ''}` });
      else if (FAIL_RE.test(out)) finish({ result: 'failed', detail: 'the loader rejected this mod set', excerpt: excerptOf(out) });
    }, 1000);
    child.on('exit', (code) => {
      setTimeout(() => {
        if (pass.test(out)) finish({ result: 'passed', detail: `the server booted with ${jars.length} mods${fullBoot ? ' into a disposable world' : ''}` });
        else finish({ result: 'failed', detail: `the server exited (code ${code}) before it finished loading mods`, excerpt: excerptOf(out) });
      }, 300);
    });
    const killer = setTimeout(() => {
      finish({ result: 'failed', detail: `the boot test gave no verdict within ${TIMEOUT_MS / 1000}s`, excerpt: excerptOf(out) });
    }, TIMEOUT_MS);
  });
}

/** The last boot test's log, for support and debugging. */
export function lastBootLog(serverId: string): string | null {
  try { return readFileSync(join(PATHS.data, 'preflight', `${serverId}.log`), 'utf8').slice(-20_000); } catch { return null; }
}

/** Keep the sealed invocation; only the test's resource budget differs. */
export function lockedLaunchArgs(lock: RevisionLock, heap: string): string[] {
  return [heap, ...lock.arguments.filter((arg) => !/^-Xm[sx]/.test(arg))];
}
