// Cross-platform contract checks for the shipped pre-JVM gate. Real Fabric
// promotion proof uses .github/setup-integration.mjs and the panel API.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, renameSync } from 'node:fs';
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
  const movable = join(dir, 'movable'), moved = join(dir, 'native');
  mkdirSync(movable);
  running = spawn(python, [script, '--fence', movable], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  const transferClosed = once(running, 'close');
  await once(running.stdout, 'data');
  renameSync(movable, moved);
  const movedFence = () => spawnSync(python, [script, '--fence'], { cwd: moved, input: '', encoding: 'utf8', timeout: 10000 });
  check('a stopped transfer retains the exclusive fence through directory relocation', movedFence().status !== 0);
  running.stdin.end();
  await transferClosed;
  running = undefined;
  check('a relocated directory releases the same fence after transfer', movedFence().status === 0);
  if (process.platform === 'win32') {
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
  console.log(`${checks} revision guard checks passed on ${process.platform}`);
} finally {
  if (running) { const closed = once(running, 'close'); running.stdin.end(); await closed; }
  rmSync(dir, { recursive: true, force: true });
}
