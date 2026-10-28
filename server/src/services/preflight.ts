import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, basename } from 'node:path';
import { PATHS } from '../config.js';
import { serverDir, javaFor } from './servers.js';
import { detect, type Detection } from './detect.js';
import { IS_WIN, sandboxLink, linkOrCopy, withMemory } from './platform.js';

// SERVER BOOT TEST. The loader is the only honest judge of whether a mod set
// boots, so the panel does not model compatibility: it boots the real thing.
// A sandbox gets the server's loader and libraries, the mod jars under test
// and eula=false, and is launched for real. The loader resolves dependencies,
// applies mixins and runs every mod's init; then the vanilla EULA check stops
// it before it opens a port or writes a world. "You need to agree to the
// EULA" in the log means this exact set of jars boots on this server.

export interface Verdict {
  result: 'passed' | 'failed' | 'unverified';
  detail: string;
  /** the loader's own words, cause lines first */
  excerpt?: string[];
  seconds?: number;
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

/** Link the loader's own files (never its mods, config or world) into a sandbox. */
export function linkLoader(dir: string, sandbox: string): void {
  for (const item of ['fabric.jar', 'libraries', 'versions', '.fabric']) {
    const src = join(dir, item);
    if (existsSync(src)) sandboxLink(src, join(sandbox, item));
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
export function dryBoot(serverId: string, jars: string[], onStatus: (d: string) => void = () => {}): Promise<Verdict> {
  const test = async (): Promise<Verdict> => {
    // a mods-only boot stays well under 1 GB; the live server keeps its share
    let waited = false;
    const v = await withMemory(1, 'the server test', (d) => { waited = true; onStatus(d); }, () => {
      if (waited) onStatus('boot-testing the server with this change');
      return dryBootInner(serverId, jars);
    });
    return typeof v === 'string' ? { result: 'unverified', detail: v } : v;
  };
  const run = chain.then(test, test);
  chain = run.catch(() => {});
  return run;
}

async function dryBootInner(serverId: string, jars: string[]): Promise<Verdict> {
  const dir = serverDir(serverId);
  const det = detect(dir, serverId);
  const launchArgs = loaderLaunchArgs(dir, det, '-Xmx2G');
  if (!launchArgs) return { result: 'unverified', detail: `Spawnpoint cannot boot-test ${det.loader} servers yet` };
  const java = javaFor(det.mc, det.loader);
  if (!java) return { result: 'unverified', detail: 'no JDK for this Minecraft version yet; it downloads the first time the server starts' };

  const sandbox = join(PATHS.data, 'preflight', serverId);
  rmSync(sandbox, { recursive: true, force: true });
  mkdirSync(join(sandbox, 'mods'), { recursive: true });
  linkLoader(dir, sandbox);
  for (const jar of jars) linkOrCopy(jar, join(sandbox, 'mods', basename(jar)));
  writeFileSync(join(sandbox, 'eula.txt'), 'eula=false\n', 'utf8');

  const started = Date.now();
  return await new Promise<Verdict>((resolve) => {
    const [cmd, args] = IS_WIN ? [java, launchArgs] : ['nice', ['-n', '19', java, ...launchArgs]];
    const child = spawn(cmd, args, { cwd: sandbox, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let settled = false;
    const finish = (v: Verdict): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(killer);
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      // the log outlives the sandbox wipe so the panel can show it
      try { writeFileSync(join(PATHS.data, 'preflight', `${serverId}.log`), out, 'utf8'); } catch { /* diagnostics only */ }
      rmSync(sandbox, { recursive: true, force: true });
      resolve({ ...v, seconds: Math.round((Date.now() - started) / 1000) });
    };
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    // the JVM lingers on non-daemon threads after the EULA line, so the
    // verdict comes from the log and the process is killed, not awaited
    const poll = setInterval(() => {
      if (PASS_RE.test(out)) finish({ result: 'passed', detail: `the server booted with ${jars.length} mods` });
      else if (FAIL_RE.test(out)) finish({ result: 'failed', detail: 'the loader rejected this mod set', excerpt: excerptOf(out) });
    }, 1000);
    child.on('exit', (code) => {
      setTimeout(() => {
        if (PASS_RE.test(out)) finish({ result: 'passed', detail: `the server booted with ${jars.length} mods` });
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
