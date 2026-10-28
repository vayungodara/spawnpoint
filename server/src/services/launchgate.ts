import { existsSync, mkdirSync, rmSync, copyFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { join, basename, dirname } from 'node:path';
import { PATHS } from '../config.js';
import { serverDir, javaFor } from './servers.js';
import { detect, loaderVersion, type Detection } from './detect.js';
import { killTree, IS_WIN, KILLABLE_SPAWN_OPTS, linkOrCopy } from './platform.js';
import { loaderLaunchArgs, linkLoader, excerptOf, type Verdict } from './preflight.js';

// CLIENT BOOT TEST. AutoModpack mirrors whatever the server has; it does not
// check that the result runs. So before a change reaches friends, this boots
// a real Minecraft client (HeadlessMC + mc-runtime-test) with the exact
// client set, then boots a throwaway copy of the server and has the client
// join it. Singleplayer proves the pack launches; the join proves a player
// gets in (some mods kick every client on join while booting fine).
//
// Display modes, checked in order:
//   'xvfb'     Linux with xvfb-run: real rendering on a virtual display.
//   'window'   macOS, Windows or a Linux desktop: a small real window.
//   'headless' anywhere else: HeadlessMC stubs out LWJGL. Mod loading,
//              mixins and init are tested; GPU-specific crashes are not.
// The client runs in HeadlessMC's offline mode, its documented mode for
// automated tests.

type GateMode = 'xvfb' | 'window' | 'headless';
let modeState: GateMode | undefined;
function gateMode(): GateMode {
  if (modeState) return modeState;
  if (process.platform === 'linux' && spawnSync('which', ['xvfb-run'], { stdio: 'ignore' }).status === 0) modeState = 'xvfb';
  else if (IS_WIN || process.platform === 'darwin' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) modeState = 'window';
  else modeState = 'headless';
  return modeState;
}

// Mods that crash only under Xvfb's software GL while working on real GPUs.
// They are left out of xvfb-mode boots; every entry is a hole in the test.
const ENV_SKIP = ['immediatelyfast']; // FontSet.resetTextures NPE under Mesa

const HMC = join(PATHS.root, 'Tools', 'headlessmc');
const HMC_VERSION = '2.10.0';
const LAUNCHER = join(HMC, `headlessmc-launcher-${HMC_VERSION}.jar`);
const LAUNCHER_SHA256 = '52bd5006f478377b3893011d458562977d38c65ead6d2b31089beb4d614f13cd';
const RUNTIME_TEST_VERSION = '4.5.1';
const RUN_TIMEOUT_MS = 15 * 60_000;

/** The newest JDK under Tools/ runs the launcher (numeric sort: jdk-8 < jdk-25). */
function gateJava(): string | null {
  const tools = join(PATHS.root, 'Tools');
  if (!existsSync(tools)) return null;
  const jdks = readdirSync(tools).filter((x) => x.startsWith('jdk-'))
    .sort((a, b) => (parseInt(b.slice(4), 10) || 0) - (parseInt(a.slice(4), 10) || 0));
  for (const d of jdks) {
    const p = join(tools, d, 'bin', IS_WIN ? 'java.exe' : 'java');
    if (existsSync(p)) return p;
  }
  return null;
}

const NICE = IS_WIN ? [] : ['nice', '-n', '19'];
const NICE_IO = process.platform === 'linux' ? ['nice', '-n', '19', 'ionice', '-c3'] : NICE;

/** Download the pinned HeadlessMC launcher on first use (13 MB, sha-checked). */
async function ensureHeadlessMc(): Promise<void> {
  if (existsSync(LAUNCHER)) return;
  mkdirSync(HMC, { recursive: true });
  const res = await fetch(`https://github.com/headlesshq/headlessmc/releases/download/${HMC_VERSION}/headlessmc-launcher-${HMC_VERSION}.jar`, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HeadlessMC download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (createHash('sha256').update(buf).digest('hex') !== LAUNCHER_SHA256) throw new Error('HeadlessMC download failed its checksum');
  writeFileSync(`${LAUNCHER}.part`, buf);
  renameSync(`${LAUNCHER}.part`, LAUNCHER);
}

/** Point HeadlessMC at its own Minecraft dir, the gate's JDK and this run's game dir. */
function writeHmcConfig(gamedir: string): void {
  const dir = join(HMC, 'HeadlessMC');
  mkdirSync(dir, { recursive: true });
  // .properties escaping eats backslashes; the JVM accepts forward slashes everywhere
  const fwd = (p: string): string => p.replace(/\\/g, '/');
  writeFileSync(join(dir, 'config.properties'), [
    `hmc.mcdir=${fwd(join(HMC, 'mc'))}`,
    `hmc.gamedir=${fwd(gamedir)}`,
    `hmc.java.versions=${fwd(gateJava() ?? '')}`,
    'hmc.offline=true',
    '',
  ].join('\n'), 'utf8');
}

/** argv for a gate client boot in the current display mode. */
function clientArgv(gameArgs: string, version: string, heap: string): string[] {
  const mode = gateMode();
  const props = [...(mode === 'xvfb' ? ['-Dhmc.check.xvfb=true'] : []),
    ...(gameArgs || mode === 'window' ? [`-Dhmc.gameargs=${[gameArgs, mode === 'window' ? '--width 640 --height 360' : ''].filter(Boolean).join(' ')}`] : [])];
  return [
    ...NICE_IO,
    ...(mode === 'xvfb' ? ['xvfb-run', '-a'] : []),
    gateJava()!,
    // LWJGL on macOS must create its window on the first thread
    ...(process.platform === 'darwin' ? ['-XstartOnFirstThread'] : []),
    ...props,
    '-jar', LAUNCHER,
    '--command', 'launch', version, '-offline',
    ...(mode === 'headless' ? ['-lwjgl'] : []),
    '--jvm', heap,
  ];
}

const execFileP = promisify(execFile);
async function hmcCmd(args: string[]): Promise<void> {
  const argv = [...NICE, gateJava()!, '-jar', LAUNCHER, '--command', ...args];
  await execFileP(argv[0], argv.slice(1), { cwd: HMC, timeout: 8 * 60_000, maxBuffer: 32 * 1024 * 1024 });
}

/** Install this MC version with the server's own loader version into
    HeadlessMC (once) and return the installed version's name. */
async function ensureVersion(mc: string, loader: 'fabric' | 'forge', uid: string | null): Promise<string> {
  const versions = join(HMC, 'mc', 'versions');
  const wanted = (d: string): boolean => loader === 'fabric'
    ? d.startsWith(`fabric-loader-${uid ?? ''}`) && d.endsWith(`-${mc}`)
    : d.startsWith(`${mc}-forge-${uid ?? ''}`);
  const find = (): string | undefined => (existsSync(versions) ? readdirSync(versions).find(wanted) : undefined);
  const have = find();
  if (have) return have;
  await hmcCmd(['download', mc]);
  await hmcCmd([loader, mc, '--java', parseInt(mc.split('.')[0], 10) >= 26 ? '25' : '21', ...(uid ? ['--uid', uid] : [])]);
  const installed = find();
  if (!installed) throw new Error(`HeadlessMC did not install ${loader} ${uid ?? ''} for ${mc}`);
  return installed;
}

/** The mc-runtime-test jar for this MC (asset names use the version, then its minor family). */
async function runtimeTestJar(mc: string, loader: 'fabric' | 'forge'): Promise<string | null> {
  const assetLoader = loader === 'forge' ? 'lexforge' : 'fabric';
  const names = [mc, mc.split('.').slice(0, 2).join('.')]
    .map((v) => `mc-runtime-test-${v}-${RUNTIME_TEST_VERSION}-${assetLoader}-release.jar`);
  for (const name of names) if (existsSync(join(HMC, name))) return join(HMC, name);
  for (const name of names) {
    const res = await fetch(`https://github.com/headlesshq/mc-runtime-test/releases/download/${RUNTIME_TEST_VERSION}/${name}`, { redirect: 'follow' });
    if (!res.ok) continue;
    writeFileSync(join(HMC, name), Buffer.from(await res.arrayBuffer()));
    return join(HMC, name);
  }
  return null;
}

/** Hold the test while anyone is playing on any server: a client boot costs
    cores and gigabytes, and the live game comes first. */
async function waitForQuiet(onStatus: (d: string) => void): Promise<void> {
  const { craftyApi } = await import('../clients/crafty.js');
  for (;;) {
    let online = 0;
    try {
      for (const s of await craftyApi.listServers()) {
        const st = await craftyApi.getStats(s.server_id).catch(() => null);
        if (st?.running) online += st.online ?? 0;
      }
    } catch { return; }
    if (online === 0) return;
    onStatus(`waiting for ${online} player(s) to log off before the client test`);
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

/** The files a client receives and the jars the server runs, for one test. */
export interface ClientSet {
  /** absolute source path + path relative to the client's game dir */
  files: { src: string; rel: string }[];
  serverJars: string[];
  /** names this run's log file: <label>-client.log */
  label: 'candidate' | 'live';
  /** file names this change adds; a change the test must leave out is untested */
  changed: string[];
}

/** Why the client test cannot run for this server, or null when it can. */
export function clientGateBlocker(serverId: string): string | null {
  const det = detect(serverDir(serverId), serverId);
  if ((det.loader !== 'fabric' && det.loader !== 'forge') || !det.mc) return `the client test supports Fabric and Forge, not ${det.loader}`;
  if (!gateJava()) return 'the client test needs a JDK under Tools/; one downloads the first time a server starts';
  return null;
}

// a client test costs several gigabytes, so only one runs at a time
let chain: Promise<unknown> = Promise.resolve();

/** Boot a real client with `set`, then join a throwaway copy of the server. Serialized globally. */
export function clientGate(serverId: string, set: ClientSet, onStatus: (d: string) => void, log: (m: string) => void): Promise<Verdict> {
  const run = chain.then(() => clientGateInner(serverId, set, onStatus, log), () => clientGateInner(serverId, set, onStatus, log));
  chain = run.catch(() => {});
  return run;
}

async function clientGateInner(serverId: string, set: ClientSet, onStatus: (d: string) => void, log: (m: string) => void): Promise<Verdict> {
  const blocker = clientGateBlocker(serverId);
  if (blocker) return { result: 'unverified', detail: blocker };
  const det = detect(serverDir(serverId), serverId) as Detection & { mc: string; loader: 'fabric' | 'forge' };
  await waitForQuiet(onStatus);
  onStatus('preparing the test client (the first run downloads Minecraft)');
  const work = join(PATHS.data, 'launchgate', serverId);
  const rundir = join(work, 'run');
  let version: string;
  try {
    await ensureHeadlessMc();
    writeHmcConfig(rundir); // before any HeadlessMC command, or it installs into ~/.minecraft
    version = await ensureVersion(det.mc, det.loader, loaderVersion(serverDir(serverId), det));
  } catch (e) {
    return { result: 'unverified', detail: `could not prepare the test client: ${String(e).slice(0, 140)}` };
  }
  const testJar = await runtimeTestJar(det.mc, det.loader);
  if (!testJar) return { result: 'unverified', detail: `mc-runtime-test has no build for ${det.mc}` };

  const skipped = (name: string): boolean => gateMode() === 'xvfb' && ENV_SKIP.some((s) => name.toLowerCase().includes(s));
  const untestable = set.changed.filter(skipped);
  if (untestable.length) return { result: 'unverified', detail: `${untestable.join(', ')} cannot run on the virtual display, so the client test cannot cover it` };
  rmSync(rundir, { recursive: true, force: true });
  mkdirSync(join(rundir, 'mods'), { recursive: true });
  let mods = 0;
  const left: string[] = [];
  for (const f of set.files) {
    if (skipped(basename(f.rel))) { left.push(basename(f.rel)); continue; }
    const dst = join(rundir, f.rel);
    mkdirSync(dirname(dst), { recursive: true });
    // jars never change, so a link is safe; configs a mod rewrites must not write through to the live pack
    if (f.rel.endsWith('.jar')) linkOrCopy(f.src, dst);
    else copyFileSync(f.src, dst);
    if (f.rel.startsWith('mods/')) mods++;
  }
  copyFileSync(testJar, join(rundir, 'mods', basename(testJar)));

  onStatus(`booting a ${det.mc} client with ${mods} mods (takes a few minutes)`);
  log(`launchgate: booting ${det.mc} client with ${mods} mods for ${serverId} (${gateMode()} mode)`);
  const heap = mods > 150 ? '-Xmx4G' : '-Xmx2G';
  const started = Date.now();

  const sp = await new Promise<Verdict>((resolve) => {
    const argv = clientArgv('', version, heap);
    const child = spawn(argv[0], argv.slice(1), { cwd: HMC, stdio: ['ignore', 'pipe', 'pipe'], ...KILLABLE_SPAWN_OPTS });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    const killer = setTimeout(() => { try { killTree(child.pid!); } catch { /* gone */ } }, RUN_TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(killer);
      const seconds = Math.round((Date.now() - started) / 1000);
      writeFileSync(join(work, `${set.label}-client.log`), out.slice(-40_000), 'utf8');
      if (code === 0 && /exited with code: 0/.test(out)) {
        resolve({ result: 'passed', detail: `a client booted into a world with ${mods} mods`, seconds });
        return;
      }
      const crash = /Crash report saved to:.*?(\S+\.txt)/.exec(out)?.[1];
      // the launcher failing before Minecraft ran says nothing about the pack
      if (!crash && !/Minecraft exited with code|Loading \d+ mods|ModLauncher running/.test(out)) {
        const last = out.trim().split('\n').pop()?.trim().slice(0, 160) ?? '';
        resolve({ result: 'unverified', detail: `the test client did not start (${last || `exit ${code}`})`, seconds });
        return;
      }
      // stubbed graphics cannot run every pack (rendering mods call real GL)
      if (gateMode() === 'headless' && /This issue is likely caused by HeadlessMc/i.test(out)) {
        resolve({ result: 'unverified', detail: 'the test client has no display and its stubbed graphics cannot run this pack; install xvfb to test it', seconds, excerpt: excerptOf(out) });
        return;
      }
      // killed by our timeout after the client reached the interactive phase:
      // a mod's modal screen or spawn hook blocked the automated play-test.
      // Load failures crash with an exit code, so the boot itself is proven.
      if (code === null && !crash && /(Screen not yet null:|Waiting for player to load)/.test(out)) {
        resolve({ result: 'passed', detail: `a client booted with ${mods} mods; a mod's screen blocked the automated play-test`, seconds });
        return;
      }
      resolve({
        result: 'failed', seconds,
        detail: `the client crashed with exit code ${code}${crash ? ` (${basename(crash)})` : ''}`,
        excerpt: excerptOf(out),
      });
    });
  });
  if (sp.result !== 'passed') return sp;

  await waitForQuiet(onStatus);
  onStatus('joining a throwaway copy of the server');
  const join_ = await joinTest(serverId, det, version, set.serverJars, rundir, log)
    .catch((e): Verdict => ({ result: 'unverified', detail: `the join test errored: ${String(e).slice(0, 140)}` }));
  if (join_.result !== 'passed') return { ...join_, detail: `${sp.detail}, but ${join_.detail}` };
  const stubbed = gateMode() === 'headless' ? ' (graphics stubbed: install xvfb to test rendering too)'
    : left.length ? ` (${left.join(', ')} left out: it cannot run on the virtual display)` : '';
  return { result: 'passed', detail: `${sp.detail}, then ${join_.detail}${stubbed}`, seconds: Math.round((Date.now() - started) / 1000) };
}

// The join test boots a throwaway server (the candidate's jars, a fresh flat
// world, offline mode, a side port) and quick-plays the client into it. The
// verdict comes from the server's log: "joined the game" plus a quiet dwell
// passes; "lost connection: Internal Exception" fails. AutoModpack is left
// out on both sides: the sandbox would host a pack with a new fingerprint
// and kick the test client as unsynced.
const JOIN_PORT = 25999;
const JOIN_DWELL_MS = 25_000;

async function joinTest(
  serverId: string,
  det: Detection & { mc: string; loader: 'fabric' | 'forge' },
  version: string,
  serverJars: string[],
  rundir: string,
  log: (m: string) => void,
): Promise<Verdict> {
  const [maj, min] = det.mc.split('.').map((n) => parseInt(n, 10));
  if (maj === 1 && min < 20) return { result: 'unverified', detail: 'the join could not be tested (clients before 1.20 have no quick-play)' };
  const big = serverJars.length > 200;
  const launchArgs = loaderLaunchArgs(serverDir(serverId), det, big ? '-Xmx4G' : '-Xmx2G');
  const java = javaFor(det.mc, det.loader);
  if (!launchArgs || !java) return { result: 'unverified', detail: 'no boot recipe for this server' };
  const serverUpMs = (big ? 8 : 4) * 60_000;
  const totalMs = (big ? 20 : 8) * 60_000;

  const srv = join(PATHS.data, 'joingate', serverId);
  rmSync(srv, { recursive: true, force: true });
  mkdirSync(join(srv, 'mods'), { recursive: true });
  linkLoader(serverDir(serverId), srv);
  for (const jar of serverJars) if (!/automodpack/i.test(basename(jar))) linkOrCopy(jar, join(srv, 'mods', basename(jar)));
  writeFileSync(join(srv, 'eula.txt'), 'eula=true\n', 'utf8');
  writeFileSync(join(srv, 'server.properties'), [
    `server-port=${JOIN_PORT}`, 'enable-rcon=false', 'online-mode=false', 'white-list=false',
    'level-type=flat', 'generate-structures=false', 'spawn-protection=0', 'view-distance=4',
    'max-players=3', 'motd=spawnpoint join test', 'sync-chunk-writes=false', '',
  ].join('\n'), 'utf8');
  // Simple Voice Chat binds its own UDP port; -1 rides the game port instead
  // of colliding with the real server's voice port
  mkdirSync(join(srv, 'config', 'voicechat'), { recursive: true });
  writeFileSync(join(srv, 'config', 'voicechat', 'voicechat-server.properties'), 'port=-1\n', 'utf8');
  // the singleplayer driver would force its own flow; AutoModpack would demand a sync
  for (const jar of readdirSync(join(rundir, 'mods'))) {
    if (/mc-runtime-test|automodpack/i.test(jar)) rmSync(join(rundir, 'mods', jar), { force: true });
  }

  const started = Date.now();
  return await new Promise<Verdict>((resolve) => {
    let srvOut = '';
    let cli: ReturnType<typeof spawn> | null = null;
    let settled = false;
    let joined = false;
    let dwell: NodeJS.Timeout | null = null;
    const srvArgv = [...NICE, java, ...launchArgs];
    const srvChild = spawn(srvArgv[0], srvArgv.slice(1), { cwd: srv, stdio: ['ignore', 'pipe', 'pipe'], ...KILLABLE_SPAWN_OPTS });
    const finish = (v: Verdict): void => {
      if (settled) return;
      settled = true;
      if (dwell) clearTimeout(dwell);
      clearTimeout(totalKiller);
      clearInterval(upPoll);
      try { if (cli?.pid) killTree(cli.pid); } catch { /* gone */ }
      try { if (srvChild.pid) killTree(srvChild.pid); } catch { /* gone */ }
      try { writeFileSync(join(PATHS.data, 'launchgate', serverId, 'join.log'), srvOut.slice(-30_000), 'utf8'); } catch { /* diagnostics */ }
      setTimeout(() => rmSync(srv, { recursive: true, force: true }), 2000);
      resolve(v);
    };
    // A client that never even tried to connect proves nothing either way:
    // the join is untested. Real join failures leave evidence on the server
    // (a kick line, an encoder exception, a crash) and fail the test.
    const inconclusive = (why: string): void => {
      if (/Done \(/.test(srvOut) && !/lost connection|logged in|joined the game/i.test(srvOut)) {
        finish({ result: 'unverified', detail: `the join could not be tested (${why})` });
      } else finish({ result: 'failed', detail: why });
    };
    const totalKiller = setTimeout(() => inconclusive(`no join verdict in ${totalMs / 60_000} min`), totalMs);
    // after the join, any disconnect is a failure: the test client never leaves on its own
    const kicked = (): string | null => {
      const m = /lost connection: (.*)/i.exec(srvOut);
      return m ? m[1].slice(0, 160) : null;
    };
    const onLine = (): void => {
      const kick = joined ? kicked() : null;
      if (kick) { finish({ result: 'failed', detail: `a player was kicked on join: ${kick}` }); return; }
      if (!joined && /joined the game/.test(srvOut)) {
        joined = true;
        log(`launchgate: join test client joined ${serverId}'s copy, dwelling ${JOIN_DWELL_MS / 1000}s`);
        dwell = setTimeout(() => {
          const k = kicked();
          finish(k ? { result: 'failed', detail: `a player was kicked after joining: ${k}` } : { result: 'passed', detail: 'joined a copy of the server and stayed connected' });
        }, JOIN_DWELL_MS);
      }
    };
    srvChild.stdout!.on('data', (d: Buffer) => { srvOut += d.toString(); onLine(); });
    srvChild.stderr!.on('data', (d: Buffer) => { srvOut += d.toString(); onLine(); });
    srvChild.on('exit', (code) => finish({ result: 'failed', detail: `the server copy exited (code ${code}) ${joined ? 'with the player connected' : 'before the client joined'}` }));
    const upPoll = setInterval(() => {
      if (settled || cli) return;
      if (!/Done \(/.test(srvOut)) {
        if (Date.now() - started > serverUpMs) finish({ result: 'unverified', detail: 'the join could not be tested (the server copy did not finish starting in time)' });
        return;
      }
      const argv = clientArgv(`--quickPlayMultiplayer 127.0.0.1:${JOIN_PORT}`, version, big ? '-Xmx4G' : '-Xmx2G');
      cli = spawn(argv[0], argv.slice(1), { cwd: HMC, stdio: ['ignore', 'pipe', 'pipe'], ...KILLABLE_SPAWN_OPTS });
      cli.on('exit', (code) => {
        if (!joined) inconclusive(`the client exited (code ${code}) before joining`);
        else finish({ result: 'failed', detail: `the client exited (code ${code}) after joining` });
      });
    }, 2000);
  });
}

