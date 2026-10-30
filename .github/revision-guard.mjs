// Cross-platform contract checks for the shipped pre-JVM gate. Real Fabric
// promotion proof uses .github/setup-integration.mjs and the panel API.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, renameSync, statSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { portListening } from '../server/dist/services/platform.js';

const dir = mkdtempSync(join(tmpdir(), 'spawnpoint-guard-'));
const python = process.platform === 'win32' ? 'python' : 'python3';
const script = resolve('server/dist/services/launchguard.py');
const hash = (bytes) => createHash('sha512').update(bytes).digest('hex');
let checks = 0;
let running;
const check = (name, condition) => { assert.ok(condition, name); checks++; console.log(`PASS: ${name}`); };
try {
  const listener = createServer();
  await new Promise((r) => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port;
  try { check('stopped-server check detects a real TCP listener', await portListening(port)); }
  finally { await new Promise((r) => listener.close(r)); }
  check('stopped-server check confirms the closed TCP port', !await portListening(port));
  mkdirSync(join(dir, 'config'));
  mkdirSync(join(dir, 'mods'));
  mkdirSync(join(dir, 'automodpack'));
  const paused = '{\n  "modpackHost": false,\n  "name": "café 世界"\n}';
  const original = paused.replace('false', 'true');
  const runner = join(dir, 'run.mjs');
  writeFileSync(runner, "import{writeFileSync}from'node:fs';writeFileSync('started','yes');process.stdin.resume();");
  const args = [process.execPath, runner];
  const gate = {
    revision: 'test', command: ['python', '.spawnpoint-launch.py', ...args].map((s) => JSON.stringify(s)).join(' '),
    roots: ['config', 'mods'],
    java: { executable: process.execPath, sha512: hash(readFileSync(process.execPath)), files: [] },
    hosting: { original, paused },
    files: [{ path: 'config/example.json', size: 2, sha512: hash('{}') }, { path: 'automodpack/automodpack-server.json', size: Buffer.byteLength(paused), sha512: hash(paused) }],
  };
  writeFileSync(join(dir, '.spawnpoint-revision.json'), JSON.stringify(gate));
  writeFileSync(join(dir, 'config/example.json'), '{}');
  const run = (extra = args) => spawnSync(python, [script, ...extra], { cwd: dir, input: '', encoding: 'utf8', timeout: 10000 });
  const reset = () => { writeFileSync(join(dir, 'automodpack/automodpack-server.json'), original); rmSync(join(dir, 'started'), { force: true }); };
  reset();
  check('valid sealed invocation starts the runtime', run().status === 0 && existsSync(join(dir, 'started')));
  check('paused configuration is exact UTF-8 bytes without newline translation', readFileSync(join(dir, 'automodpack/automodpack-server.json')).equals(Buffer.from(paused)));

  // Repaired commands use forward slashes so shlex preserves Windows paths.
  // Exercise the actual manifest writer and the unchanged copied guard.
  process.env.SPAWNPOINT_ROOT = join(dir, 'layout');
  const { writeLaunchGate, setRevisionState, revisionDir } = await import('../server/dist/services/revisions.js');
  const id = randomUUID(), server = join(process.env.SPAWNPOINT_ROOT, 'Crafty', 'servers', id);
  mkdirSync(join(server, 'config'), { recursive: true });
  mkdirSync(join(server, 'automodpack'));
  writeFileSync(join(server, 'config/example.json'), '{}');
  writeFileSync(join(server, 'automodpack/automodpack-server.json'), paused);
  const forwardArgs = [process.execPath.replaceAll('\\', '/'), runner];
  const forwardCommand = ['python', '.spawnpoint-launch.py', ...forwardArgs].map((s) => JSON.stringify(s)).join(' ');
  mkdirSync(revisionDir(id, 'forward'), { recursive: true });
  writeFileSync(join(revisionDir(id, 'forward'), 'lock.json'), JSON.stringify({ schema: 1, id: 'forward', command: forwardCommand,
    java: { ...gate.java, executable: forwardArgs[0] }, files: gate.files.map((f) => ({ ...f, location: 'server' })) }));
  setRevisionState(id, { active: 'forward' });
  writeLaunchGate(id);
  const forward = spawnSync(python, [script, ...forwardArgs], { cwd: server, input: '', encoding: 'utf8', timeout: 10000 });
  check('a forward-slash repaired command launches through the real manifest writer and guard', forward.status === 0 && existsSync(join(server, 'started')));

  reset();
  writeFileSync(join(dir, 'config/example.json'), '{"changed":true}');
  check('changed locked config refuses the runtime', run().status !== 0 && !existsSync(join(dir, 'started')));
  writeFileSync(join(dir, 'config/example.json'), '{}');
  writeFileSync(join(dir, 'config/unlisted.json'), '{}');
  check('an unlisted non-client config refuses the runtime', run().status !== 0 && !existsSync(join(dir, 'started')));
  rmSync(join(dir, 'config/unlisted.json'));
  writeFileSync(join(dir, '.spawnpoint-mutation'), 'interrupted');
  check('an interrupted journal blocks direct starts', run().status !== 0 && !existsSync(join(dir, 'started')));
  rmSync(join(dir, '.spawnpoint-mutation'));
  check('different invocation arguments refuse the runtime', run([...args, 'extra']).status !== 0 && !existsSync(join(dir, 'started')));
  reset();
  running = spawn(python, [script, ...args], { cwd: dir, stdio: ['pipe', 'ignore', 'pipe'] });
  const closed = once(running, 'close');
  for (let i = 0; !existsSync(join(dir, 'started')); i++) {
    assert.ok(i < 100 && running.exitCode === null, 'runtime must start');
    await new Promise((r) => setTimeout(r, 50));
  }
  check('a live runtime excludes a second direct start', run().status !== 0);
  check('a live runtime excludes stopped pack mutations', run(['--fence']).status !== 0);
  running.stdin.end();
  await closed;
  running = undefined;
  check('the runtime releases its fence after exit', run(['--fence']).status === 0);
  running = spawn(python, [script, '--fence'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  const fenceClosed = once(running, 'close');
  await once(running.stdout, 'data');
  reset();
  check('a stopped mutation excludes direct starts', run().status !== 0 && !existsSync(join(dir, 'started')));
  running.stdin.end();
  await fenceClosed;
  running = undefined;
  check('a completed mutation releases its fence', run().status === 0 && existsSync(join(dir, 'started')));
  const sourceParent = join(dir, 'crafty'), destinationParent = join(dir, 'native');
  mkdirSync(sourceParent);
  mkdirSync(destinationParent);
  const movable = join(sourceParent, 'server'), moved = join(destinationParent, 'server');
  mkdirSync(movable);
  running = spawn(python, [script, '--fence', movable], { cwd: dir, stdio: ['pipe', 'pipe', 'inherit'] });
  const transferClosed = once(running, 'close');
  await Promise.race([once(running.stdout, 'data'), transferClosed.then(([code]) => { throw new Error(`transfer fence exited before readiness: ${code}`); })]);
  const fenceIdentity = statSync(join(movable, '.spawnpoint-runtime.lock'), { bigint: true });
  check('a stopped transfer excludes a concurrent stopped acquisition', run(['--fence', movable]).status !== 0);
  renameSync(movable, moved);
  const movedFence = () => spawnSync(python, [script, '--fence'], { cwd: moved, input: '', encoding: 'utf8', timeout: 10000 });
  check('a stopped transfer retains the exclusive fence through directory relocation', movedFence().status !== 0);
  const movedIdentity = statSync(join(moved, '.spawnpoint-runtime.lock'), { bigint: true });
  check('relocation preserves the canonical fence identity', movedIdentity.ino === fenceIdentity.ino && movedIdentity.dev === fenceIdentity.dev);
  if (process.platform === 'win32') {
    // Name replacement is forbidden by the writer protocol, not by Windows
    // sharing (nor POSIX flock). native-runtime exercises the HTTP boundary.
    writeFileSync(join(dir, 'replacement.lock'), 'unrelated fence');
  }
  running.stdin.end();
  await transferClosed;
  running = undefined;
  check('a relocated directory releases the same fence after transfer', movedFence().status === 0);
  if (process.platform === 'win32') {
    running = spawn(python, [script, '--fence'], { cwd: moved, stdio: ['pipe', 'pipe', 'inherit'] });
    const canonicalClosed = once(running, 'close');
    await Promise.race([once(running.stdout, 'data'), canonicalClosed.then(([code]) => { throw new Error(`canonical fence exited before readiness: ${code}`); })]);
    check('an unchanged canonical guard excludes acquisition by file ID', run(['--fence', moved]).status !== 0);
    running.stdin.end();
    await canonicalClosed;
    running = spawn(python, [script, '--fence', moved], { cwd: dir, stdio: ['pipe', 'pipe', 'inherit'] });
    const relocatedClosed = once(running, 'close');
    await Promise.race([once(running.stdout, 'data'), relocatedClosed.then(([code]) => { throw new Error(`relocated fence exited before readiness: ${code}`); })]);
    check('a destination file-ID holder retains exclusive fencing', movedFence().status !== 0);
    running.kill('SIGKILL');
    await relocatedClosed;
    running = undefined;
    check('a killed file-ID holder releases its fence for a later stopped acquisition', run(['--fence', moved]).status === 0 && movedFence().status === 0);
    linkSync(join(moved, '.spawnpoint-runtime.lock'), join(sourceParent, '.server.spawnpoint-runtime.lock'));
    check('a multiply linked legacy fence requires owner recovery', run(['--fence', moved]).status !== 0);
    mkdirSync(movable);
    const reused = join(movable, '.spawnpoint-runtime.lock');
    writeFileSync(reused, 'new source identity');
    check('a reused source path refuses its stale alias without replacing either fence', run(['--fence', movable]).status !== 0
      && readFileSync(reused, 'utf8') === 'new source identity' && statSync(join(moved, '.spawnpoint-runtime.lock'), { bigint: true }).ino === fenceIdentity.ino);
    const wrong = join(sourceParent, 'wrong');
    mkdirSync(wrong);
    writeFileSync(join(wrong, '.spawnpoint-runtime.lock'), 'canonical identity');
    linkSync(join(dir, 'replacement.lock'), join(sourceParent, '.wrong.spawnpoint-runtime.lock'));
    check('a wrong existing alias refuses without modifying either file', run(['--fence', wrong]).status !== 0
      && readFileSync(join(wrong, '.spawnpoint-runtime.lock'), 'utf8') === 'canonical identity'
      && readFileSync(join(dir, 'replacement.lock'), 'utf8') === 'unrelated fence');
    const identityChecks = spawnSync(python, ['-c', `
import importlib.util, json, pathlib, subprocess, sys, _winapi
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('guard', sys.argv[1])
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
root = pathlib.Path.cwd()
record = root / '.spawnpoint-runtime.json'
child = subprocess.Popen([sys.executable, '-c', 'import sys; sys.stdin.buffer.read()'], stdin=subprocess.PIPE)
process = _winapi.OpenProcess(0x101000, False, child.pid)
identity = {'pid': child.pid, 'created': guard.windows_creation(process)}
try:
    record.write_text(json.dumps(identity))
    try:
        guard.lock_runtime(root).close()
    except BlockingIOError:
        print('PASS: a live recorded runtime excludes mutation without an inherited fence', flush=True)
    else:
        raise AssertionError('live identity was ignored')
    record.write_text(json.dumps({**identity, 'created': identity['created'] + 1}))
    guard.lock_runtime(root).close()
    assert child.poll() is None and not record.exists()
    print('PASS: PID reuse does not fence or terminate an unrelated process', flush=True)
    for interrupted in ['{"starting":true}', '{', 'null', '{"pid":1,"created":"invalid"}',
                        json.dumps({**identity, 'created': 2**64}), json.dumps({**identity, 'pid': 2**32})]:
        record.write_text(interrupted)
        try:
            guard.lock_runtime(root).close()
        except ValueError:
            assert record.exists()
        else:
            raise AssertionError('interrupted identity was ignored')
    print('PASS: interrupted runtime identity publication fails closed', flush=True)
    with patch.object(pathlib.Path, 'exists', return_value=False), patch.object(pathlib.Path, 'read_bytes', side_effect=PermissionError('denied')):
        try:
            guard.lock_runtime(root).close()
        except PermissionError:
            pass
        else:
            raise AssertionError('inaccessible identity was treated as absent')
    print('PASS: inaccessible runtime identity fails closed', flush=True)
    record.write_text(json.dumps(identity))
    child.stdin.close()
    child.wait()
    guard.lock_runtime(root).close()
    assert not record.exists()
    print('PASS: a confirmed exited runtime releases the identity fence', flush=True)
finally:
    if child.poll() is None:
        child.kill()
    child.wait()
    _winapi.CloseHandle(process)
    record.unlink(missing_ok=True)
`, script], { cwd: dir, encoding: 'utf8', timeout: 10000 });
    process.stdout.write(identityChecks.stdout);
    if (identityChecks.stderr) process.stderr.write(identityChecks.stderr);
    check('Windows process-identity exit barrier and interrupted publication', identityChecks.status === 0);
  }
  // This runtime ignores stdin/EOF: a killed Windows guard must terminate
  // it through its Job, not accidentally through a closed console pipe.
  writeFileSync(runner, "import{writeFileSync}from'node:fs';writeFileSync('started',String(process.pid));setInterval(()=>{},1000);");
  reset();
  running = spawn(python, [script, ...args], { cwd: dir, stdio: ['pipe', 'ignore', 'pipe'] });
  const killed = once(running, 'close');
  for (let i = 0; !existsSync(join(dir, 'started')); i++) {
    assert.ok(i < 100 && running.exitCode === null, 'runtime must start before its supervisor is killed');
    await new Promise((r) => setTimeout(r, 50));
  }
  const pid = Number(readFileSync(join(dir, 'started'), 'utf8'));
  let contender;
  let contenderClosed;
  if (process.platform === 'win32') {
    contender = spawn(python, ['-c', `
import importlib.util, pathlib, sys, time, _winapi
spec = importlib.util.spec_from_file_location('guard', sys.argv[1])
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
process = _winapi.OpenProcess(0x100000, False, int(sys.argv[2]))
print('armed', flush=True)
deadline = time.monotonic() + 5
while True:
    try:
        fence = guard.lock_runtime(pathlib.Path.cwd())
        break
    except OSError:
        if time.monotonic() > deadline: raise
        time.sleep(0.001)
assert _winapi.WaitForSingleObject(process, 0) == 0, 'fence released while runtime alive'
fence.close()
_winapi.CloseHandle(process)
`, script, String(pid)], { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] });
    contenderClosed = once(contender, 'close');
    await Promise.race([once(contender.stdout, 'data'), contenderClosed.then(() => { throw Error('fence contender exited before arming'); })]);
  }
  running.kill('SIGKILL');
  await killed;
  running = undefined;
  if (contenderClosed) check('Windows fence excludes mutation continuously during guard death', (await contenderClosed)[0] === 0);
  let alive = true;
  for (let i = 0; i < 100 && alive; i++) {
    try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 50)); } catch { alive = false; }
  }
  if (alive) process.kill(pid, 'SIGKILL');
  check('supervisor death cannot leave a runtime running without its fence', !alive);
  check('a killed runtime releases the stopped mutation fence', run(['--fence']).status === 0);
  // AutoModpack writes its missing defaults into its config on its first boot.
  // A never-started server's baseline probe must return exactly what that boot
  // leaves, so the sealed baseline matches every later live boot. The stand-in
  // loader does what AutoModpack does and keeps a copy of its output.
  const { dryBoot } = await import('../server/dist/services/preflight.js');
  const loader = `import json, pathlib, sys
p = pathlib.Path('automodpack/automodpack-server.json')
cfg = json.loads(p.read_text('utf-8'))
full = {'DO_NOT_CHANGE_IT': 2, 'modpackHost': True, 'syncedFiles': ['/mods/*.jar'], 'bindPort': -1, 'nagMessage': 'caf\u00e9 \u4e16\u754c', **cfg}
out = json.dumps(full, indent=2, ensure_ascii=False).encode('utf-8')
p.write_bytes(out)
pathlib.Path(sys.argv[2]).write_bytes(out)
print(sys.argv[1], flush=True)
for line in sys.stdin:
    if line.strip() == 'stop': break
`;
  const provisioned = JSON.stringify({ DO_NOT_CHANGE_IT: 2, modpackName: '', modpackHost: true, generateModpackOnStart: true, selfUpdater: false, acceptedLoaders: ['fabric'] }, null, 2);
  const probe = async (kind, config, opts) => {
    const source = join(dir, `first-boot-${kind}-${checks}`), output = join(dir, `first-boot-${kind}-${checks}.json`);
    mkdirSync(join(source, 'automodpack'), { recursive: true });
    if (kind === 'forge') mkdirSync(join(source, 'libraries/net/minecraftforge/forge/1.20.1-47.4.28'), { recursive: true });
    writeFileSync(join(source, 'fabric.jar'), 'stand-in');
    writeFileSync(join(source, 'loader.py'), loader);
    writeFileSync(join(source, 'automodpack/automodpack-server.json'), config);
    const lock = { files: ['fabric.jar', 'loader.py', 'automodpack/automodpack-server.json'].map((path) => ({ path, location: 'server' })),
      arguments: ['loader.py', kind === 'forge' ? 'Done (1.0s)! For help, type "help"' : 'You need to agree to the EULA in order to run the server.', output],
      java: { executable: python } };
    const verdict = await dryBoot(randomUUID(), [], () => {}, source, lock, opts);
    return { verdict, booted: existsSync(output) ? readFileSync(output, 'utf8') : undefined };
  };
  const fabric = await probe('fabric', provisioned, { autoModpackDefaults: true });
  check('a first boot that fills in AutoModpack defaults is returned byte for byte', fabric.verdict.result === 'passed'
    && fabric.booted !== provisioned && fabric.verdict.autoModpackConfig === fabric.booted);
  const settled = await probe('fabric', fabric.booted, { autoModpackDefaults: true });
  check('a config AutoModpack has already completed is left alone', settled.verdict.result === 'passed' && settled.booted === fabric.booted
    && settled.verdict.autoModpackConfig === undefined);
  const candidateTest = await probe('fabric', provisioned, {});
  check('ordinary candidate tests do not propose AutoModpack config writes', candidateTest.verdict.result === 'passed' && candidateTest.verdict.autoModpackConfig === undefined);
  const forge = await probe('forge', provisioned, { autoModpackDefaults: true });
  check('the Forge test copy runs with hosting off, yet the owner\'s publication settings are what is kept', forge.verdict.result === 'passed'
    && JSON.parse(forge.booted).modpackHost === false
    && assert.deepStrictEqual(JSON.parse(forge.verdict.autoModpackConfig), { ...JSON.parse(forge.booted), modpackHost: true, generateModpackOnStart: true, selfUpdater: false }) === undefined);
  console.log(`${checks} revision guard checks passed on ${process.platform}`);
} finally {
  if (running) { const closed = once(running, 'close'); running.stdin.end(); await closed; }
  rmSync(dir, { recursive: true, force: true });
}
