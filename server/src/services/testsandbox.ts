import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { delimiter, dirname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { PATHS } from '../config.js';
import { IS_WIN, ROOT_PANEL, giveTree, killTree, KILLABLE_SPAWN_OPTS } from './platform.js';

// CANDIDATE SANDBOX. Mods are code: every test JVM that loads a staged
// candidate (server boot, client boot, join) runs here, never as the panel.
// A test process sees its own scratch copy, the Java and launcher it needs
// and the OS's own libraries. Panel data, settings and tokens, other servers,
// worlds, the home folder and the panel and supervisor ports are out of reach.
//
//   Linux    bubblewrap: private user, PID, IPC, UTS, cgroup and network
//            namespaces (loopback only) over read-only /usr plus the listed
//            directories. A root panel first drops to the dedicated
//            `spawnpoint-sandbox` account, and a systemd scope caps memory,
//            CPU and tasks.
//   macOS    sandbox-exec: the layout and home folder are unreadable, writes
//            go only to scratch, connections only to the test's loopback
//            ports. Same account as the panel; memory is bounded by the heap.
//   Windows  an AppContainer without network capabilities (loopback only
//            among its own processes, files only where granted) in a Job
//            Object that caps memory and CPU.
// Where a sandbox cannot be created, candidate execution is refused.
//
// Processes that share a box (the join's server copy and client) share
// loopback, but each still sees only its own scratch: the panel writes the
// client's config while the server copy runs, and a link planted there must
// not redirect that write.

export const SANDBOX_ROOT = join(PATHS.root, 'Spawnpoint', 'sandbox');
const ACCOUNT = 'spawnpoint-sandbox';
// An administrator can give this dedicated copy a nesting-capable AppArmor
// profile without weakening the distro policy for every use of bwrap.
const BWRAP = existsSync('/usr/local/libexec/spawnpoint-bwrap') ? '/usr/local/libexec/spawnpoint-bwrap' : 'bwrap';

export interface SandboxSpec {
  /** Scratch trees the test may write. They live under SANDBOX_ROOT. */
  scratch: string[];
  /** Installations the test may read: Java homes, the launcher's tools. */
  runtimes: string[];
  /** Memory cap for the whole test, every process included. */
  memGb: number;
  /** Loopback ports the test may connect to (macOS states them; elsewhere the namespace is private). */
  ports?: number[];
  /** TCP loopback listeners permitted on macOS, separately from connects. */
  bindPorts?: number[];
  /** A real desktop window is needed (not Xvfb). */
  display?: boolean;
}

/** How a test ran. `passed` means candidate code was confined as described. */
export interface Isolation { result: 'passed' | 'inconclusive'; detail: string; renderer: 'none' }

/** One sandboxed process, with stdout and stderr merged. */
export interface BoxProcess {
  output: Readable;
  stdin: Writable | null;
  exited: Promise<number | null>;
  /** True only after all descendants are confirmed gone. */
  outputsSafe(): boolean;
  kill(): void;
}

/** Processes that reach each other on loopback, each with its own scratch. */
export interface Box {
  isolation: Isolation;
  /** `scratch` must be one of the box's scratch trees. */
  run(argv: string[], cwd: string, scratch: string): BoxProcess;
  close(): Promise<boolean>;
}

/** A fresh, private scratch tree for one test process. */
export function scratchDir(name: string): string {
  mkdirSync(SANDBOX_ROOT, { recursive: true });
  // The sandbox account may traverse the parent, never list it.
  try { chmodSync(SANDBOX_ROOT, 0o711); } catch { /* Windows */ }
  if (!/^[a-zA-Z0-9-]+$/.test(name)) throw new Error('invalid scratch name');
  return mkdtempSync(join(SANDBOX_ROOT, `${name}-`));
}

/** Resolve before confinement: a host-side alias may not exist inside it. */
export function runtimeExecutable(executable: string): string {
  let real = executable;
  if (!isAbsolute(real)) {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      const hit = [real, ...(IS_WIN ? [`${real}.exe`] : [])].map((n) => join(dir, n)).find((p) => dir && existsSync(p));
      if (hit) { real = hit; break; }
    }
  }
  try { real = realpathSync(real); } catch { /* not installed yet */ }
  return real;
}

/** The installation holding an executable (…/bin/java → …). */
export function runtimeHome(executable: string): string {
  return dirname(dirname(runtimeExecutable(executable)));
}

const resolved = (p: string): string => { try { return realpathSync(p); } catch { return p; } };
const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** Readable runtime trees. Anything under Tools/ shares one mount. */
function runtimeDirs(spec: SandboxSpec): string[] {
  const tools = resolved(join(PATHS.root, 'Tools'));
  const out = new Set<string>();
  for (const dir of spec.runtimes) {
    if (!isAbsolute(dir) || !existsSync(dir)) continue;
    const real = resolved(dir);
    out.add(existsSync(tools) && inside(real, tools) ? tools : real);
  }
  return [...out];
}

/** The only variables a test inherits: panel secrets in its environment stay behind. */
function testEnv(scratch: string): Record<string, string> {
  const keep = IS_WIN ? ['SystemRoot', 'SystemDrive', 'windir', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PATHEXT', 'ComSpec'] : ['LANG', 'LC_ALL', 'TZ'];
  const env: Record<string, string> = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!;
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  env.PATH = IS_WIN ? `${root}\\System32;${root}` : '/usr/bin:/bin';
  env.HOME = scratch;
  if (IS_WIN) Object.assign(env, { TEMP: scratch, TMP: scratch, USERPROFILE: scratch, APPDATA: scratch, LOCALAPPDATA: scratch });
  else env.TMPDIR = process.platform === 'darwin' ? scratch : '/tmp';
  // Seatbelt's localhost filter does not match Java's IPv4-mapped IPv6
  // binds on macOS 26. Keep the test's sockets on its declared IPv4 loopback.
  if (process.platform === 'darwin') env.JAVA_TOOL_OPTIONS = '-Djava.net.preferIPv4Stack=true';
  return env;
}

// ---- Linux -----------------------------------------------------------------

type LinuxReady = { ok: true; uid?: number; gid?: number; scope: string[] | null; account: string };
let linux: LinuxReady | { ok: false; why: string } | undefined;

/** The dedicated account a root panel runs tests as, created on first use. */
function sandboxAccount(): { uid: number; gid: number } | null {
  const id = (): { uid: number; gid: number } | null => {
    const u = spawnSync('id', ['-u', ACCOUNT], { encoding: 'utf8' }), g = spawnSync('id', ['-g', ACCOUNT], { encoding: 'utf8' });
    return u.status === 0 && g.status === 0 ? { uid: Number(u.stdout), gid: Number(g.stdout) } : null;
  };
  if (!id()) spawnSync('/usr/sbin/useradd', ['--system', '--user-group', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', ACCOUNT], { stdio: 'ignore' });
  const found = id();
  return found && found.uid > 0 ? found : null;
}

function linuxState(): NonNullable<typeof linux> {
  if (linux) return linux;
  if (spawnSync(BWRAP, ['--version'], { stdio: 'ignore' }).status !== 0) return (linux = { ok: false, why: 'bubblewrap (bwrap) is not installed' });
  const acct = ROOT_PANEL ? sandboxAccount() : null;
  if (ROOT_PANEL && !acct) return (linux = { ok: false, why: `the ${ACCOUNT} account could not be created` });
  const base: LinuxReady = { ok: true, uid: acct?.uid, gid: acct?.gid, account: acct ? `the ${ACCOUNT} account` : 'the panel\'s account', scope: null };
  // Probe with a real scratch tree and the Tools mount: a root panel's
  // account must be able to reach both through the layout's directories.
  let failure = '';
  const works = (state: LinuxReady, nested: boolean): boolean => {
    const dir = scratchDir('probe');
    try {
      linux = state;
      const spec = { scratch: [dir], runtimes: [join(PATHS.root, 'Tools')], memGb: 1 };
      handOver(spec);
      const inner = nested ? [BWRAP, ...bwrapArgs(spec, dir, true), '/usr/bin/true'] : ['/usr/bin/true'];
      const argv = linuxArgv(state, spec, inner, dir, !nested);
      const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 20_000 });
      failure = result.error?.message ?? result.stderr.trim().slice(-500);
      return result.status === 0;
    } catch { return false; } finally { linux = undefined; rmSync(dir, { recursive: true, force: true }); }
  };
  if (!works(base, false)) return (linux = { ok: false, why: `bubblewrap could not create user and network namespaces here: ${failure}` });
  if (!works(base, true)) return (linux = { ok: false, why: `bubblewrap could not nest a sandbox for each test process: ${failure}` });
  const scope = { ...base, scope: ROOT_PANEL ? ['systemd-run', '--scope', '--quiet', '--collect'] : ['systemd-run', '--user', '--scope', '--quiet', '--collect'] };
  return (linux = works(scope, false) ? scope : base);
}

/** A minimal root: /usr, the merged-/usr links and a few files from /etc. */
function linuxRoot(): string[] {
  const args = ['--ro-bind', '/usr', '/usr'];
  for (const d of ['bin', 'sbin', 'lib', 'lib32', 'lib64', 'libx32']) {
    const p = `/${d}`;
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink()) args.push('--symlink', realpathSync(p), p);
      else if (st.isDirectory()) args.push('--ro-bind', p, p);
    } catch { /* absent */ }
  }
  // What the dynamic loader, Java, fonts and Xvfb read; never the whole /etc.
  for (const f of ['ld.so.cache', 'ld.so.conf', 'ld.so.conf.d', 'alternatives', 'fonts', 'localtime', 'nsswitch.conf', 'passwd', 'group', 'X11']) {
    args.push('--ro-bind-try', `/etc/${f}`, `/etc/${f}`);
  }
  return args;
}

/** One bubblewrap layer. Candidate processes never get to create namespaces. */
function bwrapArgs(spec: SandboxSpec, cwd: string, disableUserns: boolean, shareNet = false): string[] {
  const args = ['--unshare-all', ...(shareNet ? ['--share-net'] : []), '--unshare-user', ...(disableUserns ? ['--disable-userns'] : []), '--die-with-parent', '--new-session', '--clearenv',
    ...Object.entries(testEnv(spec.scratch[0] ?? '/tmp')).flatMap(([k, v]) => ['--setenv', k, v]),
    ...linuxRoot(), '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/dev/shm', '--tmpfs', '/tmp', '--tmpfs', '/var/tmp',
    ...runtimeDirs(spec).flatMap((d) => ['--ro-bind', d, d]),
    ...spec.scratch.flatMap((d) => ['--bind', d, d])];
  // Xvfb is started inside this namespace. Never expose the host display:
  // an X client can read other windows and inject input into the desktop.
  args.push('--chdir', cwd, '--');
  return args;
}

function linuxArgv(state: LinuxReady, spec: SandboxSpec, argv: string[], cwd: string, disableUserns = true): string[] {
  const cpu = Math.max(1, Math.floor(cpus().length / 2)) * 100;
  const scope = state.scope ? [...state.scope, '-p', `MemoryMax=${Math.ceil(spec.memGb * 1024)}M`, '-p', 'MemorySwapMax=0', '-p', `CPUQuota=${cpu}%`, '-p', 'TasksMax=1024', '--'] : [];
  const drop = state.uid !== undefined ? ['setpriv', `--reuid=${state.uid}`, `--regid=${state.gid}`, '--clear-groups', '--inh-caps=-all', '--bounding-set=-all', '--no-new-privs', '--'] : [];
  return [...scope, ...drop, BWRAP, ...bwrapArgs(spec, cwd, disableUserns), ...argv];
}

// A box: one outer bubblewrap owns the shared loopback network and runs this
// trusted helper, which starts each test process in its own nested
// bubblewrap that mounts only that process's scratch. Output goes to a
// numbered descriptor. Closing stdin (or killing bubblewrap) ends them all.
const LINUX_BOX = `import json, os, subprocess, sys, threading
ctl = os.fdopen(3, "w", buffering=1)
lock = threading.Lock()
procs = []
def say(msg):
    with lock:
        ctl.write(json.dumps(msg) + "\\n")
def watch(i, p):
    say({"exit": i, "code": p.wait()})
for line in sys.stdin:
    req = json.loads(line)
    i = len(procs)
    try:
        p = subprocess.Popen(req["argv"], cwd="/", stdin=subprocess.DEVNULL, stdout=req["fd"], stderr=req["fd"])
    except OSError as e:
        os.write(req["fd"], ("could not start: %s\\n" % e).encode())
        procs.append(None)
        say({"exit": i, "code": 127})
        continue
    procs.append(p)
    threading.Thread(target=watch, args=(i, p), daemon=True).start()
for p in procs:
    if p and p.poll() is None:
        p.kill()
`;

const SLOTS = 2;

function linuxBox(state: LinuxReady, spec: SandboxSpec, isolation: Isolation): Box {
  const argv = linuxArgv(state, spec, ['/usr/bin/python3', '-I', '-c', LINUX_BOX], '/', false);
  const helper = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'ignore', 'pipe', 'pipe', ...Array<'pipe'>(SLOTS).fill('pipe')], ...KILLABLE_SPAWN_OPTS });
  const exits = new Map<number, (code: number | null) => void>();
  let buffered = '';
  (helper.stdio[3] as Readable).on('data', (d: Buffer) => {
    buffered += d.toString();
    for (let nl = buffered.indexOf('\n'); nl >= 0; nl = buffered.indexOf('\n')) {
      const msg = JSON.parse(buffered.slice(0, nl)) as { exit: number; code: number | null };
      buffered = buffered.slice(nl + 1);
      exits.get(msg.exit)?.(msg.code);
    }
  });
  let errors = '';
  helper.stderr!.on('data', (d: Buffer) => { errors += d.toString(); });
  const gone = new Promise<void>((resolve) => {
    helper.once('error', (e) => { errors += e.message; resolve(); });
    helper.once('close', () => resolve());
  });
  const end = (): void => { try { killTree(helper.pid!); } catch { /* gone */ } };
  let next = 0;
  return {
    isolation,
    run(cmd, cwd, scratch) {
      const i = next++;
      if (i >= SLOTS || !spec.scratch.includes(scratch)) throw new Error('not a scratch tree of this sandbox');
      handOver({ ...spec, scratch: [scratch] });
      const output = new PassThrough();
      (helper.stdio[4 + i] as Readable).pipe(output);
      const exited = new Promise<number | null>((resolve) => {
        exits.set(i, resolve);
        void gone.then(() => resolve(null));
      });
      void exited.then(() => { if (errors.trim()) output.write(`\n[sandbox] ${errors.trim().slice(-400)}\n`); });
      const inner = [BWRAP, ...bwrapArgs({ ...spec, scratch: [scratch] }, cwd, true, true), ...cmd];
      helper.stdin!.write(`${JSON.stringify({ argv: inner, fd: 4 + i })}\n`);
      // Linux processes of one box share its PID namespace: ending one ends the box.
      return { output, stdin: null, exited, outputsSafe: () => helper.exitCode !== null || helper.signalCode !== null, kill: end };
    },
    async close() { try { helper.stdin!.end(); } catch { /* gone */ } end(); await gone; return true; },
  };
}

// ---- macOS -----------------------------------------------------------------

const sb = (p: string): string => JSON.stringify(p);

function macProfile(spec: SandboxSpec): string {
  const scratch = spec.scratch.map(resolved);
  return [
    '(version 1)',
    '(deny default)',
    // Native threads are allowed; creating subprocesses is not. A candidate
    // must not detach a descendant from the process group used for cleanup.
    '(allow process-exec sysctl-read)',
    '(allow process-info* (target self))',
    '(allow signal (target same-sandbox))',
    '(allow file-read-metadata)',
    '(allow file-read-data (literal "/"))',
    // /System itself includes /System/Volumes/Data, an alias for user files.
    `(allow file-read* ${['/System/Library', '/usr/lib', '/usr/share', '/usr/bin', '/bin', ...runtimeDirs(spec).map(resolved), ...scratch].map((p) => `(subpath ${sb(p)})`).join(' ')} (literal "/dev/random") (literal "/dev/urandom") (literal "/private/etc/localtime") (literal "/private/etc/hosts"))`,
    `(allow file-write* ${scratch.map((p) => `(subpath ${sb(p)})`).join(' ')})`,
    '(allow file-read* file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper"))',
    '(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.system.notification_center"))',
    ...(spec.bindPorts ?? []).map((port) => `(allow network-bind network-inbound (local tcp "localhost:${port}"))`),
    ...(spec.ports ?? []).map((port) => `(allow network-outbound (remote tcp "localhost:${port}"))`),
    '',
  ].join('\n');
}

// ---- Windows ---------------------------------------------------------------

const WIN_HELPER = fileURLToPath(new URL('./testsandbox.py', import.meta.url));

function winContainer(name: string, remove = false): void {
  const result = spawnSync('python', ['-I', WIN_HELPER, remove ? '--delete-container' : '--create-container', name],
    { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  if (result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim().slice(-1000);
    if (remove) console.warn(`Test container cleanup failed: ${detail}`);
    else throw new Error(`Test container creation failed: ${detail}`);
  }
}

/** All processes of one box share the AppContainer (and so its loopback);
    each one's scratch is granted to a capability only its token carries. */
function winArgv(spec: SandboxSpec, argv: string[], cwd: string, name: string, control?: string): string[] {
  return ['python', '-I', WIN_HELPER, '--name', name, '--capability', `spawnpointScratch${randomUUID()}`, '--mem-mb', String(Math.ceil(spec.memGb * 1024)),
    '--cwd', cwd, ...(control ? ['--control', control] : []), ...spec.scratch.flatMap((d) => ['--write', d]), ...runtimeDirs(spec).flatMap((d) => ['--read', d]), '--', ...argv];
}

// ---- common ------------------------------------------------------------------

const probed = new Map<string, Isolation>();
let probeFailure = '';

function probe(kind: 'darwin' | 'win32'): boolean {
  const dir = scratchDir('probe');
  const name = `Spawnpoint.Probe.${randomUUID()}`;
  let created = false;
  try {
    if (kind === 'win32') { winContainer(name); created = true; }
    const python = kind === 'win32' ? runtimeExecutable('python') : '';
    const runtime = dirname(python);
    if (kind === 'win32' && (!isAbsolute(python) || [resolved(PATHS.data), resolved(homedir())].some((p) => inside(p, runtime)))) {
      throw new Error('Python must have its own runtime directory for the sandbox probe');
    }
    const spec = { scratch: [dir], runtimes: kind === 'win32' ? [runtime] : [], memGb: 1 };
    const argv = kind === 'darwin' ? ['/usr/bin/sandbox-exec', '-p', macProfile(spec), '/usr/bin/true']
      : winArgv(spec, [python, '-I', '-S', '-c', [
        'import socket',
        'with socket.socket() as listener, socket.socket() as client:',
        ' listener.settimeout(3); client.settimeout(3)',
        ' listener.bind(("127.0.0.1", 0)); listener.listen(1)',
        ' client.connect(listener.getsockname())',
        ' peer, _ = listener.accept()',
        ' with peer:',
        '  peer.settimeout(3); peer.sendall(b"control")',
        '  with client.makefile("rb") as incoming: assert incoming.read(7) == b"control"',
      ].join('\n')], dir, name);
    const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    probeFailure = result.error?.message ?? (result.stderr.trim() || `probe exited ${result.status}`).slice(-1000);
    return result.status === 0;
  } catch (error) { probeFailure = String(error); return false; }
  finally { if (created) winContainer(name, true); rmSync(dir, { recursive: true, force: true }); }
}

/** What this host's sandbox confines. Probed once per display choice. */
export function sandboxIsolation(spec: Pick<SandboxSpec, 'display'> = {}): Isolation {
  const key = spec.display ? 'display' : 'plain';
  const cached = probed.get(key);
  if (cached) return cached;
  const unisolated = (why: string): Isolation => ({ result: 'inconclusive', renderer: 'none',
    detail: `Not isolated: ${why}. Candidate code was not run` });
  let iso: Isolation;
  if (process.env.SPAWNPOINT_UNSANDBOXED === '1') iso = unisolated('SPAWNPOINT_UNSANDBOXED=1 turned the sandbox off');
  else if (process.platform === 'linux' && spec.display) iso = unisolated('the host desktop cannot be shared with candidate code; install xvfb');
  else if (process.platform === 'linux' && [resolved(PATHS.root), resolved(homedir())].some((path) =>
    ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/etc'].some((base) => inside(path, base)))) {
    iso = unisolated('the layout or home overlaps the sandbox\'s OS read-only mounts');
  }
  else if (process.platform === 'linux') {
    const s = linuxState();
    iso = !s.ok ? unisolated(s.why) : { result: 'passed', renderer: 'none', detail: [
      `Ran as ${s.account} in private namespaces: only this test's copy, Java and test tools were visible and the network was its own loopback`,
      s.scope ? 'a systemd scope capped memory, CPU and processes' : 'memory was bounded only by the Java heap (no systemd scope for this account)',
    ].join('; ') };
  } else if (process.platform === 'darwin' && ROOT_PANEL) iso = unisolated('run the macOS panel as an unprivileged user');
  else if (process.platform === 'darwin') {
    iso = !existsSync('/usr/bin/sandbox-exec') || !probe('darwin') ? unisolated('sandbox-exec is unavailable')
      : { result: 'passed', renderer: 'none', detail: 'Ran under a default-deny macOS sandbox: only OS libraries, declared runtimes and this process\'s scratch were readable; writes stayed in scratch and network access was limited to test loopback ports. Memory was bounded only by the Java heap' };
  } else if (IS_WIN) {
    iso = !probe('win32') ? unisolated(`the AppContainer runtime and private-loopback probe failed: ${probeFailure}`)
      : { result: 'passed', renderer: 'none', detail: 'Ran in a low-privilege AppContainer: files only where explicitly granted and no network beyond its own loopback; a Job Object capped memory, CPU and processes' };
  } else iso = unisolated(`no sandbox for ${process.platform}`);
  probed.set(key, iso);
  return iso;
}

/** argv and environment for one sandboxed process. */
function sandboxed(spec: SandboxSpec, argv: string[], cwd: string, capability: string, control?: string): { argv: string[]; env: Record<string, string>; isolation: Isolation } {
  const isolation = sandboxIsolation(spec);
  const env = testEnv(spec.scratch[0] ?? cwd);
  if (isolation.result !== 'passed') throw new Error(isolation.detail);
  handOver(spec);
  if (process.platform === 'linux') {
    // systemd-run needs its caller's session bus. These belong only to the
    // trusted wrapper: bubblewrap clears the environment before Java runs.
    const wrapper = { ...env };
    for (const key of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) if (process.env[key]) wrapper[key] = process.env[key]!;
    return { argv: linuxArgv(linux as LinuxReady, spec, argv, cwd), env: wrapper, isolation };
  }
  if (process.platform === 'darwin') return { argv: ['/usr/bin/sandbox-exec', '-p', macProfile(spec), ...argv], env, isolation };
  // The helper itself is trusted and needs PATH to find Python.
  return { argv: winArgv(spec, argv, cwd, capability, control), env: { ...env, PATH: process.env.PATH ?? env.PATH }, isolation };
}

/** Spawn one sandboxed process with piped stdin and merged output. */
export function sandboxSpawn(spec: SandboxSpec, argv: string[], cwd: string, capability?: string): BoxProcess & { isolation: Isolation; child: ChildProcess } {
  // Never grant the candidate this sibling directory. Only the trusted
  // Windows helper can acknowledge that its Job has no remaining processes.
  const control = IS_WIN ? scratchDir('control') : undefined;
  const name = capability ?? `Spawnpoint.Test.${randomUUID()}`;
  let ownsContainer = false;
  let s: ReturnType<typeof sandboxed>;
  try {
    s = sandboxed(spec, argv, cwd, name, control);
    if (IS_WIN && !capability) { winContainer(name); ownsContainer = true; }
  } catch (error) { if (control) rmSync(control, { recursive: true, force: true }); throw error; }
  const child = spawn(s.argv[0], s.argv.slice(1), { cwd, env: s.env, stdio: ['pipe', 'pipe', 'pipe'], ...KILLABLE_SPAWN_OPTS });
  const output = new PassThrough();
  child.stdout!.on('data', (d: Buffer) => output.write(d));
  child.stderr!.on('data', (d: Buffer) => output.write(d));
  let closed = false, safe = false;
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', (e) => { output.write(`could not launch the test: ${e.message}\n`); resolve(null); });
    child.once('close', (code) => {
      closed = true;
      safe = !control || existsSync(join(control, 'closed'));
      if (ownsContainer && safe) winContainer(name, true);
      if (control) rmSync(control, { recursive: true, force: true });
      resolve(code);
    });
  });
  return { child, output, stdin: child.stdin, exited, outputsSafe: () => safe, isolation: s.isolation, kill: () => {
    if (closed) return;
    if (control) writeFileSync(join(control, 'cancel'), '');
    else { try { if (child.pid) killTree(child.pid); } catch { /* gone */ } }
  } };
}

/** A sandbox for processes that must reach each other on loopback. */
export function sandboxBox(spec: SandboxSpec): Box {
  const isolation = sandboxIsolation(spec);
  if (isolation.result !== 'passed') throw new Error(isolation.detail);
  if (process.platform === 'linux' && isolation.result === 'passed') {
    handOver(spec);
    return linuxBox(linux as LinuxReady, spec, isolation);
  }
  const procs: BoxProcess[] = [];
  const name = `Spawnpoint.Test.${randomUUID()}`;
  if (IS_WIN) winContainer(name);
  return {
    isolation,
    run(argv, cwd, scratch) {
      if (!spec.scratch.includes(scratch)) throw new Error('not a scratch tree of this sandbox');
      const p = sandboxSpawn({ ...spec, scratch: [scratch] }, argv, cwd, name);
      p.stdin?.end();
      procs.push(p);
      return p;
    },
    async close() {
      for (const p of procs) p.kill();
      await Promise.all(procs.map((p) => p.exited));
      const safe = procs.every((p) => p.outputsSafe());
      if (IS_WIN && safe) winContainer(name, true);
      return safe;
    },
  };
}

/** A root panel hands scratch trees to the sandbox account before a launch. */
function handOver(spec: SandboxSpec): void {
  const s = linux;
  if (process.platform !== 'linux' || !s?.ok || s.uid === undefined) return;
  for (const dir of spec.scratch) {
    giveTree(s.uid, s.gid!, dir);
    chownSync(dir, s.uid, s.gid!);
  }
}

/** Read a file a test wrote. The test controls its scratch tree, so any link
    in the path could point at panel secrets: refuse links, never follow. */
export function readOutput(root: string, rel: string): Buffer {
  const result = spawnSync(IS_WIN ? 'python' : 'python3', ['-I', WIN_HELPER, '--read-output', root, rel],
    { maxBuffer: 256 * 1024 * 1024, timeout: 30_000, windowsHide: true });
  if (result.status !== 0) throw new Error(`unsafe or unreadable test output: ${rel}`);
  return result.stdout;
}

/** List regular outputs without following links in any directory component. */
export function listOutput(root: string, rel: string): string[] {
  const result = spawnSync(IS_WIN ? 'python' : 'python3', ['-I', WIN_HELPER, '--list-output', root, rel],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000, windowsHide: true });
  if (result.status !== 0) throw new Error(`unsafe or unreadable test output directory: ${rel}`);
  return JSON.parse(result.stdout) as string[];
}

/** Copy a test output out of its scratch tree without following links. */
export function copyOutput(root: string, rel: string, dst: string): void {
  const bytes = readOutput(root, rel);
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, bytes);
}
