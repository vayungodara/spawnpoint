import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { once } from 'node:events';

// The entire layout and home canary belong to this test. No real secret is
// read and no panel API is called, including in the unconfined control.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'spawnpoint-boundary-')));
chmodSync(root, 0o711); // a root panel's dedicated sandbox account must traverse the layout
const home = mkdtempSync(join(homedir(), 'spawnpoint-boundary-'));
process.env.SPAWNPOINT_ROOT = root;
process.env.SPAWNPOINT_BOUNDARY_CANARY = 'disposable-boundary-control';
const { sandboxIsolation, sandboxSpawn, sandboxBox, scratchDir, runtimeExecutable, runtimeHome, readOutput, listOutput } = await import('../server/dist/services/testsandbox.js');
const java = runtimeExecutable(process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
  : execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['java'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]);
const javac = join(dirname(java), process.platform === 'win32' ? 'javac.exe' : 'javac');
console.log('Probe runtime:', java, 'resolved:', realpathSync(java), 'home:', runtimeHome(java));
const host = createServer((socket) => socket.end(Buffer.from([42])));
host.listen(0, '127.0.0.1'); await once(host, 'listening');
const hostPort = host.address().port;
const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
const ownPort = reserve.address().port; await new Promise((r) => reserve.close(r));
const outside = join(root, 'outside.txt'), panel = join(root, 'Spawnpoint/data'), homeFile = join(home, 'canary.txt');
const sibling = scratchDir('sibling'), siblingFile = join(sibling, 'canary.txt');
mkdirSync(panel, { recursive: true });
for (const file of [outside, homeFile, siblingFile, join(panel, 'canary.txt')]) writeFileSync(file, 'boundary control');
const compiled = join(root, 'compiled'); mkdirSync(compiled);
execFileSync(javac, ['-d', compiled, resolve('.github/fixtures/sandbox/BoundaryProbe.java')], { stdio: 'pipe' });
const runtimeFile = join(compiled, 'canary.txt'); writeFileSync(runtimeFile, 'runtime control');
if (process.platform === 'win32') {
  // A normal AppContainer would inherit these ambient grants. LPAC must
  // ignore them, even on files whose integrity label allows lowbox writes.
  for (const file of [outside, runtimeFile]) {
    execFileSync('icacls', [file, '/grant', '*S-1-15-2-1:(M)', '/setintegritylevel', 'L'], { stdio: 'pipe' });
  }
}
const prepare = (name) => { const dir = scratchDir(name); for (const file of ['BoundaryProbe.class', 'BoundaryProbe$Attempt.class']) copyFileSync(join(compiled, file), join(dir, file)); return dir; };
const outsideAlias = process.platform === 'darwin' ? `/System/Volumes/Data${outside}` : process.platform === 'win32' ? `\\\\?\\${outside}` : `/proc/self/root${outside}`;
const args = (mode, peer = siblingFile) => [java, '-Xmx128m', '-XX:-UsePerfData', '-cp', '.', 'BoundaryProbe', mode, outside, panel, homeFile, peer, String(hostPort), String(ownPort), runtimeFile, outsideAlias];
const spec = (scratch) => ({ scratch, runtimes: [runtimeHome(java), compiled], memGb: 1, ports: [ownPort], bindPorts: [ownPort] });
const denied = ['outside-read', 'outside-alias-read', 'outside-write', 'panel-list', 'home-read', 'sibling-read', 'sibling-write', 'runtime-write', 'runtime-hardlink-write', 'host-port', 'environment', 'symlink-read'];
if (process.platform === 'linux') denied.push('namespace-create');
function verify(output) {
  for (const name of denied) assert.match(output, new RegExp(`^ACCESS ${name} DENIED$`, 'm'), output);
  for (const name of ['scratch-write', 'own-port', 'runtime-read']) assert.match(output, new RegExp(`^ACCESS ${name} ALLOWED$`, 'm'), output);
}
async function collect(child) {
  let output = ''; child.output.on('data', (d) => { output += d; });
  const timeout = setTimeout(() => child.kill(), 30000);
  try { assert.equal(await child.exited, 0, output); return output; } finally { clearTimeout(timeout); }
}
async function ready(child, marker) {
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`not ready: ${output}`)), 15000);
    child.output.on('data', (d) => { output += d; if (output.includes(marker)) { clearTimeout(timer); resolve(); } });
    child.exited.then((code) => { clearTimeout(timer); reject(new Error(`exited ${code}: ${output}`)); });
  });
}
let box;
try {
  const control = prepare('control');
  // Spawn asynchronously: the host listener must be serviced during the probe.
  const { spawn } = await import('node:child_process');
  const unconfined = spawn(java, args('solo').slice(1), { cwd: control });
  let controlOutput = ''; unconfined.stdout.on('data', (d) => { controlOutput += d; });
  assert.equal((await once(unconfined, 'close'))[0], 0);
  for (const name of denied.filter((n) => n !== 'symlink-read')) assert.match(controlOutput, new RegExp(`^ACCESS ${name} ALLOWED$`, 'm'), controlOutput);
  console.log('PASS: unconfined controls can reach the disposable files, environment and listener');
  for (const file of [outside, homeFile, siblingFile, runtimeFile]) writeFileSync(file, 'boundary control');
  const iso = sandboxIsolation(); console.log(JSON.stringify(iso));
  assert.equal(iso.result, 'passed', 'this host must exercise real confinement, not skip it');
  if (process.platform === 'win32') {
    // Temporary loader diagnostic: only inspect public runtime libraries.
    const diagnostic = scratchDir('library-probe');
    const executable = join(diagnostic, 'LibraryProbe.exe');
    copyFileSync(join(process.env.RUNNER_TEMP, 'spawnpoint-library-probe.exe'), executable);
    const child = sandboxSpawn(spec([diagnostic]), [executable, dirname(java)], diagnostic);
    console.log(await collect(child));
  }
  const solo = prepare('solo');
  const soloProcess = sandboxSpawn(spec([solo]), args(process.platform === 'win32' ? 'profile' : 'solo'), solo);
  let profile;
  if (process.platform === 'win32') {
    const name = soloProcess.child.spawnargs[soloProcess.child.spawnargs.indexOf('--name') + 1];
    assert.match(name, /^Spawnpoint\.Test\./);
    // Inspect only the disposable profile this process just created.
    profile = execFileSync('python', ['-I', '-c', `
import ctypes as c, sys
api = c.WinDLL('userenv')
sid, folder = c.c_void_p(), c.c_wchar_p()
api.DeriveAppContainerSidFromAppContainerName.argtypes = [c.c_wchar_p, c.POINTER(c.c_void_p)]
assert api.DeriveAppContainerSidFromAppContainerName(sys.argv[1], c.byref(sid)) == 0
adv = c.WinDLL('advapi32')
text = c.c_wchar_p()
adv.ConvertSidToStringSidW.argtypes = [c.c_void_p, c.POINTER(c.c_wchar_p)]
assert adv.ConvertSidToStringSidW(sid, c.byref(text))
api.GetAppContainerFolderPath.argtypes = [c.c_wchar_p, c.POINTER(c.c_wchar_p)]
assert api.GetAppContainerFolderPath(text, c.byref(folder)) == 0
print(folder.value)
`, name], { encoding: 'utf8' }).trim();
    writeFileSync(join(profile, 'boundary-canary.txt'), 'profile control');
    assert.equal(readFileSync(join(profile, 'boundary-canary.txt'), 'utf8'), 'profile control');
    writeFileSync(join(solo, 'profile-target.txt'), profile);
  }
  const output = await collect(soloProcess);
  assert.equal(soloProcess.outputsSafe(), true);
  verify(output); console.log(output.trim());
  if (profile) {
    for (const name of ['profile-read', 'profile-write', 'profile-list']) assert.match(output, new RegExp(`^ACCESS ${name} DENIED$`, 'm'));
    assert.equal(existsSync(profile), false, 'temporary AppContainer profile must be removed');
    console.log('PASS: AppContainer profile denies candidate access and is removed after shutdown');
  }
  assert.equal(readOutput(solo, 'control.txt').toString(), 'scratch control');
  assert.deepEqual(listOutput(solo, 'outputs'), ['outputs/nested/control.txt']);
  assert.throws(() => readOutput(solo, 'config/link'));
  assert.throws(() => readOutput(solo, '../outside.txt'));
  // A parent-directory link must be rejected too, independently of whether
  // this host lets Java create file symlinks.
  symlinkSync(panel, join(solo, 'directory-link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readOutput(solo, 'directory-link/canary.txt'));
  assert.throws(() => listOutput(solo, 'directory-link'));
  console.log('PASS: standalone JVM and no-follow output reader');

  const descendants = prepare('descendants');
  const descendantOutput = await collect(sandboxSpawn(spec([descendants]), args('spawn'), descendants));
  if (process.platform === 'darwin') assert.match(descendantOutput, /^ACCESS descendant DENIED$/m, descendantOutput);
  else {
    verify(descendantOutput);
    assert.match(descendantOutput, /^ACCESS descendant ALLOWED$/m, descendantOutput);
  }
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(existsSync(join(descendants, 'late-write.txt')), false, 'descendant survived the sandbox');
  console.log('PASS: descendants are denied or confined and reaped, including Unix session detachment');

  const cancellation = prepare('cancellation');
  const held = sandboxSpawn(spec([cancellation]), args('hold'), cancellation);
  await ready(held, 'HOLD READY');
  held.kill();
  await held.exited;
  assert.equal(held.outputsSafe(), true, 'forced stop must acknowledge descendant shutdown');
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(existsSync(join(cancellation, 'late-write.txt')), false, 'descendant survived forced stop');
  console.log('PASS: explicit cancellation reaps descendants before accepting outputs');

  const server = prepare('pair-server'), client = prepare('pair-client');
  writeFileSync(join(server, 'canary.txt'), 'server control');
  box = sandboxBox(spec([server, client]));
  const listener = box.run([java, '-Xmx128m', '-cp', '.', 'BoundaryProbe', 'listen', String(ownPort)], server, server);
  await ready(listener, 'READY');
  verify(await collect(box.run(args('pair', join(server, 'canary.txt')), client, client)));
  await box.close(); box = null;
  assert.equal(readFileSync(join(server, 'canary.txt'), 'utf8'), 'server control');
  for (const file of [outside, homeFile, siblingFile, runtimeFile]) assert.equal(readFileSync(file, 'utf8'), 'boundary control');
  console.log('PASS: separate process scratch and shared private loopback');
  const disabled = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {sandboxIsolation,sandboxSpawn} from './server/dist/services/testsandbox.js';
    assert.equal(sandboxIsolation().result,'inconclusive');
    assert.throws(()=>sandboxSpawn(${JSON.stringify(spec([solo]))},${JSON.stringify([java, '-version'])},${JSON.stringify(solo)}),/Not isolated/);
  `], { env: { ...process.env, SPAWNPOINT_UNSANDBOXED: '1' }, encoding: 'utf8' });
  assert.equal(disabled.status, 0, disabled.stderr);
  console.log('PASS: unavailable sandbox refuses execution');
  if (process.platform === 'linux') {
    const overlap = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import {sandboxIsolation} from './server/dist/services/testsandbox.js';
      assert.match(sandboxIsolation().detail, /Not isolated:.*overlaps/);
    `], { env: { ...process.env, SPAWNPOINT_ROOT: '/usr/local/spawnpoint-boundary-layout' }, encoding: 'utf8' });
    assert.equal(overlap.status, 0, overlap.stderr);
    console.log('PASS: layouts inside ambient OS mounts refuse execution');
  }
  console.log(`sandbox boundaries passed on ${process.platform}`);
} finally {
  await box?.close();
  host.close();
  rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
}
