import { existsSync, mkdirSync, rmSync, copyFileSync, writeFileSync, readdirSync, renameSync, readFileSync, realpathSync, cpSync, constants } from 'node:fs';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { join, basename, dirname, relative, isAbsolute } from 'node:path';
import { PATHS } from '../config.js';
import { serverDir, javaFor } from './servers.js';
import { detect, loaderVersion, type Detection } from './detect.js';
import { killTree, IS_WIN, KILLABLE_SPAWN_OPTS, linkOrCopy, withMemory } from './platform.js';
import { loaderLaunchArgs, lockedLaunchArgs, linkLoader, excerptOf, classVersionFailure, type Verdict } from './preflight.js';
import { packFiles, type RevisionLock } from './revisions.js';

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

export type GateMode = 'xvfb' | 'window' | 'headless';
let modeState: GateMode | undefined;
/** Set for one serialized retry in a real window after a virtual-display crash. */
let modeOverride: GateMode | undefined;
function gateMode(): GateMode {
  if (modeOverride) return modeOverride;
  if (modeState) return modeState;
  if (process.platform === 'linux' && spawnSync('which', ['xvfb-run'], { stdio: 'ignore' }).status === 0) modeState = 'xvfb';
  else if (IS_WIN || process.platform === 'darwin' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) modeState = 'window';
  else modeState = 'headless';
  return modeState;
}

// Mods seen crashing only under Xvfb's software GL. They are always tried
// first; only a crash that names one of them leads to a real-window retry or
// a run without it, and the verdict then says exactly what went unproven.
const ENV_SENSITIVE = [{ name: /immediatelyfast/i, frames: /net\.raphimc\.immediatelyfast|\[ImmediatelyFast[^\]]*\.jar/i }];

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
function writeHmcConfig(gamedir: string, java = gateJava()): void {
  const dir = join(HMC, 'HeadlessMC');
  mkdirSync(dir, { recursive: true });
  // .properties escaping eats backslashes; the JVM accepts forward slashes everywhere
  const fwd = (p: string): string => p.replace(/\\/g, '/');
  writeFileSync(join(dir, 'config.properties'), [
    `hmc.mcdir=${fwd(join(HMC, 'mc'))}`,
    `hmc.gamedir=${fwd(gamedir)}`,
    `hmc.java.versions=${fwd(java ?? '')}`,
    'hmc.java.use.current=false',
    'hmc.auto.download.java=false',
    'hmc.java.require.exact=true',
    'hmc.jvmargs=-XshowSettings:properties',
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
async function ensureVersion(mc: string, loader: 'fabric' | 'forge' | 'neoforge', uid: string | null, java: string): Promise<string> {
  const versions = join(HMC, 'mc', 'versions');
  const wanted = (d: string): boolean => loader === 'fabric'
    ? uid ? d === `fabric-loader-${uid}-${mc}` : d.startsWith('fabric-loader-') && d.endsWith(`-${mc}`)
    : loader === 'neoforge' ? uid ? d === `neoforge-${uid}` : d.startsWith('neoforge-')
      : uid ? d === `${mc}-forge-${uid}` : d.startsWith(`${mc}-forge-`);
  const find = (): string | undefined => (existsSync(versions) ? readdirSync(versions).find(wanted) : undefined);
  const runtime = await execFileP(java, ['-XshowSettings:properties', '-version'], { timeout: 5_000 });
  const major = Number(/^\s*java.specification.version = (\d+)\s*$/m.exec(runtime.stderr)?.[1]);
  if (!major) throw new Error('Could not identify the locked client Java runtime');
  // Only the harness's launcher recipes change, never the pack or runtime.
  // Forge's installer selects Java from the vanilla parent and ignores --java.
  const pinJava = (version: string): void => {
    const path = join(versions, version, `${version}.json`);
    const metadata = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...metadata, javaVersion: { ...metadata.javaVersion, majorVersion: major } }));
  };
  if (!find()) {
    await hmcCmd(['download', mc, '-noredownload']);
    pinJava(mc);
    await hmcCmd([loader, mc, ...(uid ? ['--uid', uid] : [])]);
  }
  const installed = find();
  if (!installed) throw new Error(`HeadlessMC did not install ${loader} ${uid ?? ''} for ${mc}`);
  // A cached Java 17 must not silently win over the locked Java 21.
  pinJava(installed);
  return installed;
}

/** Observe the game JVM itself, not the Java process running HeadlessMC. */
function clientUsesJava(output: string, java: string): boolean {
  const home = /^\s*java.home = (.+)$/m.exec(output)?.[1].trim();
  try { return !!home && realpathSync(join(home, 'bin', IS_WIN ? 'java.exe' : 'java')) === realpathSync(java); }
  catch { return false; }
}

/** The mc-runtime-test jar for this MC (asset names use the version, then its minor family). */
async function runtimeTestJar(mc: string, loader: 'fabric' | 'forge' | 'neoforge'): Promise<string | null> {
  const assetLoader = loader === 'forge' ? 'lexforge' : loader;
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
    let unknown = false;
    try {
      for (const s of await craftyApi.listServers()) {
        const st = await craftyApi.getStats(s.server_id).catch(() => null);
        if (!st) unknown = true;
        if (st?.running) {
          if (st.online < 0) unknown = true;
          else online += st.online ?? 0;
        }
      }
      if (craftyApi.listingError) unknown = true;
    } catch { unknown = true; }
    if (online === 0 && !unknown) return;
    onStatus(unknown ? 'waiting for a known player count before the client test' : `waiting for ${online} player(s) to log off before the client test`);
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
  /** Sealed server/config inputs for this revision; absent for legacy callers. */
  sourceDir?: string;
  lock?: RevisionLock;
}

/** Why the client test cannot run for this server, or null when it can. */
export function clientGateBlocker(serverId: string): string | null {
  const det = detect(serverDir(serverId), serverId);
  if (!['fabric', 'forge', 'neoforge'].includes(det.loader) || !det.mc) return `the client test supports Fabric, Forge and NeoForge, not ${det.loader}`;
  if (!gateJava()) return 'the client test needs a JDK under Tools/; one downloads the first time a server starts';
  return null;
}

// a client test costs several gigabytes, so only one runs at a time
let chain: Promise<unknown> = Promise.resolve();

/** Boot a real client with `set`, then join a throwaway copy of the server. Serialized globally. */
export function clientGate(serverId: string, set: ClientSet, onStatus: (d: string) => void, log: (m: string) => void): Promise<Verdict> {
  const run = chain.then(() => clientGateFallback(serverId, set, onStatus, log), () => clientGateFallback(serverId, set, onStatus, log));
  chain = run.catch(() => {});
  return run;
}

/** What a client log proves about rendering. A display mode is not evidence:
    offline HeadlessMC without xvfb silently switches on its LWJGL stubs and
    the game then reports empty driver and device strings. Only a named
    backend and device count, and software or paravirtual devices are not
    real-hardware proof. */
export function renderingEvidence(out: string, mode: GateMode): { result: 'passed' | 'inconclusive' | 'skipped'; detail: string; stubbed: boolean } {
  if (mode === 'headless' || /game will start in headless mode/i.test(out)) return { result: 'skipped', detail: 'LWJGL was stubbed; nothing was rendered', stubbed: true };
  const backend = /Using graphics backend (\S+), using drivers: *(\S[^\r\n]*)/.exec(out);
  const device = /Using graphics device: *([^\r\n]*?) *$/m.exec(out)?.[1];
  // Older clients do not log the device; Sodium logs the GL renderer it uses.
  const legacy = /OpenGL Renderer: *(\S[^\r\n]*)/.exec(out)?.[1];
  const named = device && !/^\(?\s*\)?$/.test(device) ? device : legacy;
  if (!named || (backend === null && !legacy)) return { result: 'inconclusive', detail: 'The client did not report a GL or Vulkan driver and device, so rendering is unproven', stubbed: false };
  const where = backend ? `${backend[1]} ${backend[2].trim()} on ${named}` : `OpenGL on ${named}`;
  if (/llvmpipe|softpipe|swiftshader|software|paravirtual|basic render|virgl|svga3d/i.test(named)) {
    return { result: 'passed', detail: `Rendered with ${where}: a software or virtual device, so rendering was not verified on real hardware`, stubbed: false };
  }
  return { result: 'passed', detail: `Rendered with ${where}; one GPU and driver, not every player's`, stubbed: false };
}

/** The env-sensitive jar a virtual-display client crash names, if any. */
function displayCulprit(serverId: string, set: ClientSet): { file: string; cause: string } | null {
  const work = join(PATHS.data, 'launchgate', serverId);
  const out = ['client.log', 'join-client.log'].map((f) => { try { return readFileSync(join(work, f === 'client.log' ? `${set.label}-client.log` : f), 'utf8'); } catch { return ''; } }).join('\n');
  for (const f of set.files) {
    const name = basename(f.rel);
    const known = ENV_SENSITIVE.find((m) => m.name.test(name));
    if (!known || !known.frames.test(out)) continue;
    const cause = /Caused by: ([^\n]{1,160})/.exec(out.slice(out.search(known.frames)))?.[1] ?? 'see the client log';
    return { file: name, cause };
  }
  return null;
}

async function clientGateFallback(serverId: string, set: ClientSet, onStatus: (d: string) => void, log: (m: string) => void): Promise<Verdict> {
  const first = await clientGateInner(serverId, set, onStatus, log, []);
  const culprit = gateMode() === 'xvfb' && first.result === 'failed' ? displayCulprit(serverId, set) : null;
  if (!culprit) return { ...first, renderer: gateMode() };
  const why = `${culprit.file} crashed the test client on the virtual display (${culprit.cause})`;
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    log(`launchgate: ${why}; retrying in a real window`);
    modeOverride = 'window';
    try {
      const real = await clientGateInner(serverId, set, onStatus, log, []);
      return { ...real, detail: `${why}; in a real window: ${real.detail}`, renderer: 'window' };
    } finally { modeOverride = undefined; }
  }
  log(`launchgate: ${why}; testing the rest of the pack without it`);
  onStatus(`${culprit.file} cannot run on the virtual display; testing the rest of the pack without it`);
  const rest = await clientGateInner(serverId, set, onStatus, log, [culprit.file]);
  // Never a pass: the friend pack that includes this jar was not handshaken.
  return { ...rest, result: rest.result === 'passed' ? 'unverified' : rest.result, detail: `${why}. Without it: ${rest.detail}`, renderer: gateMode() };
}

async function clientGateInner(serverId: string, set: ClientSet, onStatus: (d: string) => void, log: (m: string) => void, leaveOut: string[]): Promise<Verdict> {
  const blocker = clientGateBlocker(serverId);
  if (blocker) return { result: 'unverified', detail: blocker };
  const sourceDir = set.sourceDir ?? serverDir(serverId);
  const det = detect(sourceDir, serverId) as Detection & { mc: string; loader: 'fabric' | 'forge' | 'neoforge' };
  await waitForQuiet(onStatus);
  onStatus('preparing the test client (the first run downloads Minecraft)');
  const work = join(PATHS.data, 'launchgate', serverId);
  const rundir = join(work, 'run');
  let version: string;
  const java = set.lock?.java.executable ?? javaFor(det.mc, det.loader);
  if (!java) return { result: 'unverified', detail: 'No known client Java runtime' };
  try {
    await ensureHeadlessMc();
    writeHmcConfig(rundir, java); // before any HeadlessMC command, or it installs into ~/.minecraft
    version = await ensureVersion(det.mc, det.loader, loaderVersion(sourceDir, det), java);
  } catch (e) {
    return { result: 'unverified', detail: `could not prepare the test client: ${String(e).slice(0, 140)}` };
  }
  const testJar = await runtimeTestJar(det.mc, det.loader);
  if (!testJar) return { result: 'unverified', detail: `mc-runtime-test has no build for ${det.mc}` };

  const skipped = (name: string): boolean => leaveOut.includes(name);
  // AutoModpack's handshake needs the client to hold the exact pack, so it
  // cannot run once a mod has to be left out for the virtual display; the
  // join then runs without AutoModpack and the verdict says so.
  const amJar = set.serverJars.find((p) => /^automodpack.*\.jar$/i.test(basename(p)));
  const handshakeOff = !!amJar && set.files.some((f) => skipped(basename(f.rel)));
  const tested: AutoModpackFile[] | null = amJar && !handshakeOff ? [] : null;
  if (tested && !set.files.some((f) => f.rel.startsWith('mods/') && /^automodpack.*\.jar$/i.test(basename(f.rel))
    && readFileSync(f.src).equals(readFileSync(amJar as string)))) {
    return { result: 'unverified', detail: 'AutoModpack handshake needs the server\'s own AutoModpack jar in the tested client set' };
  }
  rmSync(rundir, { recursive: true, force: true });
  mkdirSync(join(rundir, 'mods'), { recursive: true });
  let mods = 0;
  const left: string[] = [];
  for (const f of set.files) {
    if (skipped(basename(f.rel))) { left.push(basename(f.rel)); continue; }
    const dst = join(rundir, f.rel);
    mkdirSync(dirname(dst), { recursive: true });
    // AutoModpack can overwrite jars during an update. Clone/copy its inputs
    // rather than letting the updater write through a hardlink into the live pack.
    if (f.rel.endsWith('.jar') && !tested) linkOrCopy(f.src, dst);
    else copyFileSync(f.src, dst, constants.COPYFILE_FICLONE);
    // Snapshot the bytes actually booted, not the manifest the server will generate later.
    // AutoModpack itself is a bootstrap mod and is deliberately absent from its served list.
    if (tested && !(f.rel.startsWith('mods/') && /^automodpack.*\.jar$/i.test(basename(f.rel)))) {
      const bytes = readFileSync(dst);
      tested.push({ file: `/${f.rel.replace(/\\/g, '/')}`, sha1: createHash('sha1').update(bytes).digest('hex'),
        size: String(bytes.length), type: f.rel.startsWith('mods/') ? 'mod' : 'other', editable: false, forceCopy: false });
      // Keep pristine pack inputs: singleplayer can rewrite loose config files.
      const packFile = join(rundir, 'automodpack', 'modpacks', 'spawnpoint-join-test', f.rel);
      mkdirSync(dirname(packFile), { recursive: true });
      if (f.rel.endsWith('.jar')) linkOrCopy(dst, packFile);
      else copyFileSync(dst, packFile);
    }
    if (f.rel.startsWith('mods/')) mods++;
  }
  copyFileSync(testJar, join(rundir, 'mods', basename(testJar)));
  if (tested) {
    mkdirSync(join(rundir, 'automodpack'), { recursive: true });
    writeFileSync(join(rundir, 'automodpack', 'automodpack-client.json'), JSON.stringify({ DO_NOT_CHANGE_IT: 2,
      selectedModpack: '', installedModpacks: {}, updateSelectedModpackOnLaunch: false,
      selfUpdater: false, syncAutoModpackVersion: false, syncLoaderVersion: false,
    }));
  }

  // measured: a 20-mod client and a server copy each settle near 0.75 GB
  const needGb = mods > 150 ? { client: 4.5, join: 8 } : mods > 50 ? { client: 2, join: 3.5 } : { client: 1, join: 2 };
  const heap = mods > 150 ? '-Xmx4G' : '-Xmx2G';
  const started = Date.now();

  const sp = await withMemory(needGb.client, 'the client test', onStatus, () => new Promise<Verdict>((resolve) => {
    onStatus(`booting a ${det.mc} client with ${mods} mods (takes a few minutes)`);
    log(`launchgate: booting ${det.mc} client with ${mods} mods for ${serverId} (${gateMode()} mode)`);
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
      if (!clientUsesJava(out, java)) {
        resolve({ result: 'unverified', detail: 'The game JVM did not prove it used the locked Java executable', seconds });
        return;
      }
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
        javaFailure: classVersionFailure(out),
      });
    });
  }));
  if (typeof sp === 'string') return { result: 'unverified', detail: sp, checks: { clientBoot: { result: 'inconclusive', detail: sp, renderer: gateMode() } } };
  let clientOut = '';
  try { clientOut = readFileSync(join(work, `${set.label}-client.log`), 'utf8'); } catch { /* no log: no evidence */ }
  const seen = renderingEvidence(clientOut, gateMode());
  const checks: NonNullable<Verdict['checks']> = {
    clientBoot: { result: sp.result === 'unverified' ? 'inconclusive' : sp.result, detail: sp.detail, renderer: gateMode() },
    rendering: left.length ? { result: 'skipped', detail: `Not loaded or rendered: ${left.join(', ')}`, renderer: gateMode() }
      : sp.result !== 'passed' ? { result: 'inconclusive', detail: 'The client did not complete its rendering check', renderer: gateMode() }
        : { result: seen.result, detail: seen.detail, renderer: gateMode() },
  };
  if (sp.result !== 'passed') return { ...sp, checks };

  await waitForQuiet(onStatus);
  // the join runs a client and a copy of the server at once
  const join_ = await withMemory(needGb.join, 'the join test', onStatus, () => {
    onStatus('joining a throwaway copy of the server');
    return joinTest(serverId, det, version, set, rundir, tested, log)
      .catch((e): Verdict => ({ result: 'unverified', detail: `the join test errored: ${String(e).slice(0, 140)}` }));
  });
  if (typeof join_ === 'string') return { result: 'unverified', detail: `${sp.detail}, but the join could not be tested: ${join_}`, checks: { ...checks, join: { result: 'inconclusive', detail: join_, renderer: gateMode() } } };
  if (join_.result !== 'passed') return { ...join_, detail: `${sp.detail}, but ${join_.detail}`, checks: { ...checks, join: { result: join_.result === 'unverified' ? 'inconclusive' : join_.result, detail: join_.detail, renderer: gateMode() }, handshake: { result: tested ? 'inconclusive' : 'skipped', detail: 'The complete AutoModpack handshake and inventory check did not pass', renderer: gateMode() } } };
  const notes = [
    seen.stubbed && (gateMode() === 'headless' ? 'graphics stubbed: install xvfb to test rendering too' : 'the launcher stubbed graphics, so rendering was not tested'),
    gateMode() !== 'headless' && left.length && `${left.join(', ')} left out${handshakeOff ? ', so AutoModpack\'s handshake and the exact friend download were not proven' : ''}`,
  ].filter(Boolean);
  return { result: notes.length ? 'unverified' : 'passed', detail: `${sp.detail}, then ${join_.detail}${notes.length ? ` (${notes.join('; ')})` : ''}`, seconds: Math.round((Date.now() - started) / 1000),
    checks: {
      ...checks,
      join: { result: 'passed', detail: join_.detail, renderer: gateMode() },
      handshake: { result: tested ? 'passed' : 'skipped', detail: tested ? 'AutoModpack handshake and exact client inventory verified'
        : handshakeOff ? `AutoModpack handshake was not run: ${left.join(', ')} had to be left out of the client` : 'AutoModpack handshake was not run', renderer: gateMode() },
    } };
}

// The join test boots a throwaway server (the candidate's jars, a fresh flat
// world, offline mode, a side port) and quick-plays the client into it. The
// verdict comes from the server's log: "joined the game" plus a quiet dwell
// passes; "lost connection: Internal Exception" fails. AutoModpack 4.x
// also needs an exact served-file match and the real login sync acknowledgement.
// Trust only the copy's logged fingerprint; never copy the live server's keys.
const JOIN_PORT = 25999;
const JOIN_DWELL_MS = 25_000;

interface AutoModpackFile {
  file: string;
  sha1: string;
  size: string;
  type: string;
  editable: boolean;
  forceCopy: boolean;
}

/** Reproduce publishPack's shelf overlay, keeping hand-placed extras and the
    server's own sync/exclusion rules. Do not manufacture the host pack from
    the tested list: that would hide files AutoModpack serves but we never booted. */
function prepareAutoModpack(serverId: string, srv: string, set: ClientSet): void {
  const live = set.sourceDir ?? serverDir(serverId);
  const am = join(live, 'automodpack');
  const cfgPath = join(am, 'automodpack-server.json');
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
  if (cfg.DO_NOT_CHANGE_IT !== undefined && cfg.DO_NOT_CHANGE_IT !== 2) throw new Error('AutoModpack needs a version 2 server config');
  if (cfg.modpackHost === false) throw new Error('AutoModpack hosting is disabled');
  // Copy the roots of synced globs (not worlds, libraries or credentials).
  // A broad root glob cannot be safely reproduced without copying the whole server.
  for (const pattern of cfg.syncedFiles ?? ['/mods/*.jar', '/kubejs/**', '!/kubejs/server_scripts/**', '/emotes/*']) {
    if (typeof pattern !== 'string') throw new Error('invalid AutoModpack syncedFiles');
    if (pattern.startsWith('!')) continue;
    const root = pattern.replace(/^\//, '').split('/')[0];
    if (!root || /[\\*?[\]{}]/.test(root) || root.startsWith('.') || pattern.split('/').includes('..') || /^(automodpack|world.*|libraries|versions|logs|backups)$/i.test(root)) {
      throw new Error(`cannot safely copy AutoModpack sync rule ${pattern}`);
    }
    if (root !== 'mods' && existsSync(join(live, root))) cpSync(join(live, root), join(srv, root), { recursive: true });
  }
  const extras = join(srv, 'automodpack', 'host-modpack', 'main');
  if (!set.sourceDir && existsSync(join(am, 'host-modpack', 'main'))) cpSync(join(am, 'host-modpack', 'main'), extras, { recursive: true });
  mkdirSync(join(extras, 'mods'), { recursive: true });
  const record = join(am, '.spawnpoint-bridged.json');
  const bridged: string[] = existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : [];
  for (const jar of bridged) rmSync(join(extras, 'mods', basename(jar)), { force: true });
  // Candidate shelf files can live in staging, not yet in data/clientmods/.
  for (const f of set.files) {
    const rel = relative(join(am, 'host-modpack', 'main'), f.src);
    const fromExtras = !isAbsolute(rel) && !rel.startsWith('..');
    if (!set.serverJars.includes(f.src) && (set.sourceDir || (f.rel.startsWith('mods/') && !fromExtras))) {
      mkdirSync(dirname(join(extras, f.rel)), { recursive: true });
      copyFileSync(f.src, join(extras, f.rel));
    }
  }
  mkdirSync(join(srv, 'automodpack'), { recursive: true });
  writeFileSync(join(srv, 'automodpack', 'automodpack-server.json'), JSON.stringify({ ...cfg,
    // Regenerate as publishPack will, but host only on the copy's game port.
    modpackName: 'spawnpoint-join-test', generateModpackOnStart: true, selfUpdater: false,
    bindAddress: '127.0.0.1', bindPort: -1, addressToSend: '127.0.0.1', portToSend: -1,
    disableInternalTLS: false, updateIpsOnEveryStart: false,
  }, null, 2), 'utf8');
}

async function joinTest(
  serverId: string,
  det: Detection & { mc: string; loader: 'fabric' | 'forge' | 'neoforge' },
  version: string,
  set: ClientSet,
  rundir: string,
  tested: AutoModpackFile[] | null,
  log: (m: string) => void,
): Promise<Verdict> {
  const { serverJars } = set;
  const [maj, min] = det.mc.split('.').map((n) => parseInt(n, 10));
  if (maj === 1 && min < 20) return { result: 'unverified', detail: 'the join could not be tested (clients before 1.20 have no quick-play)' };
  const big = serverJars.length > 200;
  const heap = big ? '-Xmx4G' : '-Xmx2G';
  const launchArgs = set.lock ? lockedLaunchArgs(set.lock, heap) : loaderLaunchArgs(set.sourceDir ?? serverDir(serverId), det, heap);
  const java = set.lock?.java.executable ?? javaFor(det.mc, det.loader);
  if (!launchArgs || !java) return { result: 'unverified', detail: 'no boot recipe for this server' };
  const serverUpMs = (big ? 8 : 4) * 60_000;
  const totalMs = (big ? 20 : 8) * 60_000;

  const srv = join(PATHS.data, 'joingate', serverId);
  rmSync(srv, { recursive: true, force: true });
  mkdirSync(join(srv, 'mods'), { recursive: true });
  linkLoader(set.sourceDir ?? serverDir(serverId), srv, set.lock);
  for (const jar of serverJars) if (tested || !/automodpack/i.test(basename(jar))) linkOrCopy(jar, join(srv, 'mods', basename(jar)));
  if (tested) {
    try { prepareAutoModpack(serverId, srv, set); }
    catch (e) {
      rmSync(srv, { recursive: true, force: true });
      return { result: 'unverified', detail: `AutoModpack handshake could not be prepared: ${String(e)}` };
    }
  }
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
  // The singleplayer driver would force its own flow. Retain the sync client
  // only when the join will exercise its real handshake.
  for (const jar of readdirSync(join(rundir, 'mods'))) {
    if (/mc-runtime-test/i.test(jar) || (!tested && /automodpack/i.test(jar))) rmSync(join(rundir, 'mods', jar), { force: true });
  }

  const started = Date.now();
  const expected = new Map(set.files.map((f) => [f.rel, createHash('sha512').update(readFileSync(f.src)).digest('hex')]));
  const inventoryDifference = (): string | null => {
    try {
      const pack = join(rundir, 'automodpack', 'modpacks', 'spawnpoint-join-test');
      for (const [rel, sha512] of expected) {
        const copies = [join(rundir, rel), join(pack, rel)].filter(existsSync);
        if (!copies.length || copies.some((p) => createHash('sha512').update(readFileSync(p)).digest('hex') !== sha512)) return rel;
      }
      for (const base of [rundir, pack]) for (const file of packFiles(join(base, 'mods')).filter((f) => f.endsWith('.jar'))) {
        const rel = relative(base, file).replace(/\\/g, '/');
        if (!expected.has(rel)) return `${rel} (unexpected executable input)`;
      }
      return null;
    } catch { return 'unreadable client inventory'; }
  };
  return await new Promise<Verdict>((resolve) => {
    let srvOut = '';
    let cliOut = '';
    let differences: string[] = [];
    let cli: ReturnType<typeof spawn> | null = null;
    let settled = false;
    let joined = false;
    let dwell: NodeJS.Timeout | null = null;
    const srvArgv = [...NICE, java, ...launchArgs];
    const srvChild = spawn(srvArgv[0], srvArgv.slice(1), { cwd: srv, stdio: ['ignore', 'pipe', 'pipe'], ...KILLABLE_SPAWN_OPTS });
    const finish = (v: Verdict): void => {
      if (settled) return;
      settled = true;
      if (v.result === 'passed' && !clientUsesJava(cliOut, java)) v = { result: 'unverified', detail: 'The join client did not prove it used the locked Java executable' };
      if (dwell) clearTimeout(dwell);
      clearTimeout(totalKiller);
      clearInterval(upPoll);
      try { if (cli?.pid) killTree(cli.pid); } catch { /* gone */ }
      try { if (srvChild.pid) killTree(srvChild.pid); } catch { /* gone */ }
      const work = join(PATHS.data, 'launchgate', serverId);
      try {
        writeFileSync(join(work, 'join.log'), srvOut.slice(-30_000), 'utf8');
        writeFileSync(join(work, 'join-client.log'), cliOut.slice(-40_000), 'utf8');
      } catch { /* diagnostics */ }
      setTimeout(() => rmSync(srv, { recursive: true, force: true }), 2000);
      resolve({ ...v, javaFailure: v.result === 'failed' ? classVersionFailure(cliOut) ?? classVersionFailure(srvOut) : undefined, seconds: Math.round((Date.now() - started) / 1000) });
    };
    // A client that never even tried to connect proves nothing either way:
    // the join is untested. Real join failures leave evidence on the server
    // (a kick line, an encoder exception, a crash) and fail the test.
    const inconclusive = (why: string): void => {
      if (tested && !/has installed whole modpack/.test(srvOut)) {
        finish({ result: 'unverified', detail: `AutoModpack handshake was not verified (${why})`, excerpt: excerptOf(cliOut || srvOut) });
        return;
      }
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
      if (settled) return;
      if (tested) {
        if (/Modpack .* requires update!|Found file marked for deletion|Install\/Update modpack to join|has not installed modpack/.test(cliOut + srvOut)) {
          finish({ result: 'failed', detail: `AutoModpack requires a download/update${differences.length ? `: ${differences.join(', ')}` : ' (see join-client.log)'}`, excerpt: differences });
          return;
        }
        if (/Error while getting server modpack content|Error while handling data packet|Received untrusted certificate|Host server error|Failed to generate modpack|Error while initializing modpack updater/.test(cliOut + srvOut)) {
          finish({ result: 'unverified', detail: 'AutoModpack handshake errored (see join-client.log and join.log)', excerpt: excerptOf(cliOut || srvOut) });
          return;
        }
      }
      const kick = joined ? kicked() : null;
      if (kick) { finish({ result: 'failed', detail: `a player was kicked on join: ${kick}` }); return; }
      if (!joined && /joined the game/.test(srvOut)) {
        joined = true;
        log(`launchgate: join test client joined ${serverId}'s copy, dwelling ${JOIN_DWELL_MS / 1000}s`);
        dwell = setTimeout(() => {
          const k = kicked();
          const handshake = cliOut.indexOf('Modpack address:');
          const altered = tested ? inventoryDifference() : null;
          if (tested && (handshake < 0 || !/Modpack .* is up to date!/.test(cliOut.slice(handshake)) || !/has installed whole modpack/.test(srvOut))) {
            finish({ result: 'unverified', detail: 'the player joined, but AutoModpack did not verify its client handshake' });
          } else if (altered) {
            finish({ result: 'failed', detail: `AutoModpack client inputs differ from the tested bytes: ${altered}` });
          } else if (tested && differences.length) {
            finish({ result: 'failed', detail: `AutoModpack serves different files: ${differences.join(', ')}`, excerpt: differences });
          } else finish(k ? { result: 'failed', detail: `a player was kicked after joining: ${k}` }
            : { result: 'passed', detail: `joined a copy of the server and stayed connected${tested ? '; AutoModpack verified the exact tested pack' : ''}` });
        }, JOIN_DWELL_MS);
      }
    };
    srvChild.stdout!.on('data', (d: Buffer) => { srvOut += d.toString(); onLine(); });
    srvChild.stderr!.on('data', (d: Buffer) => { srvOut += d.toString(); onLine(); });
    srvChild.on('exit', (code) => finish({ result: 'failed', detail: `the server copy exited (code ${code}) ${joined ? 'with the player connected' : 'before the client joined'}` }));
    const upPoll = setInterval(() => {
      if (settled || cli) return;
      // AutoModpack starts its TLS host AFTER Minecraft's Done line.
      const fingerprint = /Certificate fingerprint: ([a-f0-9]{64})/.exec(srvOut)?.[1];
      if (!/Done \(/.test(srvOut) || (tested && !fingerprint)) {
        if (Date.now() - started > serverUpMs) finish({ result: 'unverified', detail: `the join could not be tested (${tested ? 'the server copy or AutoModpack host' : 'the server copy'} did not finish starting in time)` });
        return;
      }
      if (tested) {
        try {
          // Read the freshly generated host list, never an old live manifest.
          const manifest = JSON.parse(readFileSync(join(srv, 'automodpack', 'host-modpack', 'automodpack-content.json'), 'utf8'));
          if (!manifest.automodpackVersion?.startsWith('4.') || !fingerprint || !Array.isArray(manifest.list)) throw new Error('no AutoModpack 4.x manifest or TLS fingerprint');
          const expected = new Map(tested.map((f) => [f.file, f]));
          const served = new Map<string, AutoModpackFile>();
          for (const f of manifest.list as AutoModpackFile[]) {
            if (!f.file?.startsWith('/') || f.file.includes('\\') || f.file.split('/').includes('..') || !/^[a-f0-9]{40}$/.test(f.sha1)) throw new Error('invalid AutoModpack file list');
            served.set(f.file, f);
          }
          differences = [...new Set([...expected.keys(), ...served.keys()])].sort().flatMap((path) => {
            const a = expected.get(path), b = served.get(path);
            return !a ? [`${path} (server only)`] : !b ? [`${path} (tested only)`] : a.sha1 !== b.sha1 || a.size !== String(b.size) ? [`${path} (different bytes)`] : [];
          });
          const pack = join(rundir, 'automodpack', 'modpacks', 'spawnpoint-join-test');
          mkdirSync(pack, { recursive: true });
          const localFiles = [...expected.values()].map((f) => ({ ...f, ...served.get(f.file), sha1: f.sha1, size: f.size }));
          for (const f of localFiles) {
            if (f.file.startsWith('/mods/') && !f.forceCopy) rmSync(join(rundir, f.file.slice(1)), { force: true });
          }
          // Seed the tested hashes, NOT the served hashes. No saved secret means
          // prelaunch loads this local pack; login must fetch and verify the host.
          writeFileSync(join(pack, 'automodpack-content.json'), JSON.stringify({ ...manifest, list: localFiles, nonModpackFilesToDelete: [] }), 'utf8');
          // A fresh game dir's welcome screen blocks quick-play. Do not override
          // options supplied by the pack; only set the harness's own defaults.
          const options = join(rundir, 'options.txt');
          if (!expected.has('/options.txt') && !existsSync(options)) writeFileSync(options, 'onboardAccessibility:false\n', 'utf8');
          const address = `127.0.0.1:${JOIN_PORT}`;
          writeFileSync(join(rundir, 'automodpack', 'automodpack-client.json'), JSON.stringify({ DO_NOT_CHANGE_IT: 2,
            selectedModpack: 'spawnpoint-join-test', installedModpacks: { 'spawnpoint-join-test': { hostAddress: address, serverAddress: address, requiresMagic: true } },
            updateSelectedModpackOnLaunch: true, selfUpdater: false, syncAutoModpackVersion: false, syncLoaderVersion: false,
          }), 'utf8');
          const privateDir = join(rundir, 'automodpack', '.private');
          mkdirSync(privateDir, { recursive: true });
          writeFileSync(join(privateDir, 'automodpack-known-hosts.json'), JSON.stringify({ hosts: { '127.0.0.1': fingerprint } }), 'utf8');
          copyFileSync(join(srv, 'automodpack', 'host-modpack', 'automodpack-content.json'), join(PATHS.data, 'launchgate', serverId, 'join-pack.json'));
          log(`launchgate: AutoModpack host has ${served.size} files; ${differences.length} differ from the tested pack${differences.length ? `: ${differences.join(', ')}` : ''}`);
        } catch (e) {
          finish({ result: 'unverified', detail: `AutoModpack handshake could not be prepared: ${String(e)}` });
          return;
        }
      }
      const argv = clientArgv(`--quickPlayMultiplayer 127.0.0.1:${JOIN_PORT}`, version, big ? '-Xmx4G' : '-Xmx2G');
      cli = spawn(argv[0], argv.slice(1), { cwd: HMC, stdio: ['ignore', 'pipe', 'pipe'], ...KILLABLE_SPAWN_OPTS });
      cli.on('error', (e) => finish({ result: 'unverified', detail: `the join client could not start: ${e.message}` }));
      cli.stdout!.on('data', (d: Buffer) => { cliOut += d.toString(); onLine(); });
      cli.stderr!.on('data', (d: Buffer) => { cliOut += d.toString(); onLine(); });
      cli.on('exit', (code) => {
        if (!joined) inconclusive(`the client exited (code ${code}) before joining`);
        else finish({ result: 'failed', detail: `the client exited (code ${code}) after joining` });
      });
    }, 2000);
  });
}
