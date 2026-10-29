// Public panel contract against the real independent Python owner and shipped
// guard. Node stands in for Java here; actual Minecraft acceptance is separate.
// --service also exercises the packaged native OS installer/containment in CI.
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { channel } from 'node:diagnostics_channel';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, readdirSync, statSync, renameSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir, userInfo, homedir } from 'node:os';
import { join, resolve } from 'node:path';

// The dedicated service account cannot use a layout inside a private user Temp.
mkdirSync('.amp/in', { recursive: true });
const root = mkdtempSync(process.platform === 'win32' ? resolve('.amp/in/spawnpoint-owner-') : join(tmpdir(), 'spawnpoint-owner-'));
process.env.SPAWNPOINT_ROOT = root;
process.env.SPAWNPOINT_NODE = process.execPath;
const data = join(root, 'Spawnpoint/data'), runtime = join(data, 'runtime');
mkdirSync(data, { recursive: true });
writeFileSync(join(data, 'settings.json'), JSON.stringify({ port: 25574 }));
const accessFile = join(data, 'existing-access-probe.txt');
writeFileSync(accessFile, 'before installation', { mode: 0o600 });
const python = process.platform === 'win32' ? 'python' : 'python3';
const service = process.argv.includes('--service');
const script = resolve('server/dist/services/nativeservice.py');
const id = randomUUID(), dir = join(root, 'Servers', id);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const { supervisor } = await import('../server/dist/services/native.js');
if (service && process.platform === 'linux') assert.ok(!existsSync('/etc/systemd/system/spawnpoint-supervisor.service'), 'never replace an installed service in a test');
if (service && process.platform === 'darwin') assert.ok(!existsSync(join(homedir(), 'Library/LaunchAgents/com.spawnpoint.supervisor.plist')), 'never replace an installed service in a test');
if (service && process.platform === 'win32') assert.equal(spawnSync('sc.exe', ['query', 'SpawnpointSupervisor']).status, 1060, 'never replace an installed service in a test');
let panel, owner, failure, previousAgent, installed = false, cookie = '';
channel('undici:request:error').subscribe(({ error }) => console.error('HTTP transport failure:', error.code ?? error.cause?.code));
let checks = 0;
const check = (name, condition) => { assert.ok(condition, name); checks++; console.log('PASS:', name); };
const command = (...args) => execFileSync(args[0], args.slice(1), { stdio: 'pipe', timeout: 90_000 });
const system = (...args) => command('sudo', 'systemctl', ...args, 'spawnpoint-supervisor.service');
async function until(probe, message, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const result = await probe(); if (result) return result; } catch { /* settling */ }
    await pause(200);
  }
  throw new Error(message);
}
async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const closed = once(child, 'close');
  child.kill();
  await closed;
}
async function startPanel() {
  panel = spawn(process.execPath, ['server/dist/index.js'], { stdio: 'ignore' });
  await until(async () => (await fetch('http://127.0.0.1:25574/api/health', { headers: { connection: 'close' } })).ok, 'panel health timeout');
}
async function api(path, body, method = body ? 'POST' : 'GET', expected = 200) {
  const response = await fetch('http://127.0.0.1:25574/api' + path, {
    method, headers: { cookie, 'content-type': 'application/json', connection: 'close' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  assert.equal(response.status, expected, JSON.stringify(result));
  return result;
}
async function startOwner() {
  if (service) {
    if (!installed) {
      const args = [python, script, 'install', '--root', root, '--node', process.execPath];
      installed = true; // A failed installer may already have created the unit.
      if (process.platform === 'linux') command('sudo', ...args, '--system', '--user', userInfo().username);
      else command(...args);
    } else if (process.platform === 'linux') system('start');
    else if (process.platform === 'win32') command('sc.exe', 'start', 'SpawnpointSupervisor');
    else command('launchctl', 'bootstrap', 'gui/' + process.getuid(), join(homedir(), 'Library/LaunchAgents/com.spawnpoint.supervisor.plist'));
  } else owner = spawn(python, ['-c', `
import os, runpy, socket, sys
sys.path.insert(0, os.path.dirname(sys.argv[1]))
def unavailable(*args):
    raise AssertionError('loopback IPC must not perform reverse DNS')
socket.gethostbyaddr = unavailable
runpy.run_path(sys.argv[1], run_name='__main__')
`, resolve('server/dist/services/supervisor.py')], { stdio: 'ignore' });
  await until(async () => (await supervisor('health')).ok, 'owner health timeout');
}
async function stopOwner() {
  if (!service) return stopChild(owner);
  if (!installed) return;
  if (process.platform === 'linux') system('stop');
  else if (process.platform === 'win32') {
    const output = command('powershell', '-NoProfile', '-Command', `
$ErrorActionPreference = 'Stop'
$service = Get-Service -Name SpawnpointSupervisor
if ($service.Status -eq 'StartPending') { $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(90)) }
$processId = (Get-CimInstance Win32_Service -Filter "Name='SpawnpointSupervisor'").ProcessId
if (-not $processId) { throw 'SCM owner identity unavailable; retain the layout for inspection' }
$owner = [System.Diagnostics.Process]::GetProcessById($processId)
[void]$owner.get_Handle()
$service.Refresh()
if ($service.Status -eq 'Running') {
  try { $service.Stop() } catch {
    $service.Refresh()
    if ($service.Status -notin @('Stopped', 'StopPending')) { throw }
    $reason = $_.Exception.GetBaseException()
    Write-Output "SCM stop control: $($reason.GetType().FullName), native=$($reason.NativeErrorCode), state=$($service.Status): $($reason.Message)"
  }
}
elseif ($service.Status -notin @('Stopped', 'StopPending')) { throw "Unexpected SCM state: $($service.Status)" }
$service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(90))
if (-not $owner.WaitForExit(90000)) { throw 'SCM owner process did not exit' }
`).toString().trim();
    if (output) console.log(output);
  } else {
    const target = 'gui/' + process.getuid() + '/com.spawnpoint.supervisor';
    command('launchctl', 'bootout', target);
    await until(() => spawnSync('launchctl', ['print', target], { stdio: 'ignore' }).status !== 0, 'launchd stop timeout', 90_000);
  }
}
const stats = () => api(`/servers/${id}/stats`);
const action = (action) => api(`/servers/${id}/action`, { action });
const logs = () => api(`/servers/${id}/logs?tail=1000`);
async function ready() {
  return until(async () => { const s = await stats(); return s.running && s.pid && !s.waiting_start && s; }, 'guarded fixture did not start');
}
try {
  await startPanel();
  await startOwner();
  if (!service) check('authenticated loopback IPC becomes ready without reverse DNS', (await supervisor('health')).pid === owner.pid);
  if (service && process.platform === 'darwin') {
    previousAgent = (await supervisor('health')).pid;
    console.log('LaunchAgent owner before reinstall:', previousAgent);
    command(python, script, 'install', '--root', root, '--node', process.execPath);
    check('reinstalling a loaded LaunchAgent waits for the previous owner to exit', (await supervisor('health')).pid !== previousAgent);
  }
  assert.equal(readFileSync(accessFile, 'utf8'), 'before installation');
  writeFileSync(accessFile, 'panel write');
  check('standalone wizard refuses missing setup consent', (await fetch('http://127.0.0.1:25574/api/wizard/standalone', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status === 403);
  // This is a generated, disposable test layout, never an installed credential.
  const code = readFileSync(join(data, 'setup-code.txt'), 'utf8').trim();
  await api('/wizard/standalone', { code });
  const finish = await fetch('http://127.0.0.1:25574/api/wizard/finish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, pin: '641278' }) });
  assert.equal(finish.status, 200);
  cookie = finish.headers.get('set-cookie').split(';')[0];
  check('standalone setup completes without Crafty or a fabricated Crafty token', !(await api('/wizard/status')).active && !existsSync(join(root, 'Shared/crafty-token.txt')));
  check('standalone lists its native inventory without contacting Crafty', (await api('/servers')).servers.length === 0);
  const transferId = randomUUID(), sourcePath = join(root, 'Crafty/servers', transferId), destination = join(root, 'Servers', transferId);
  mkdirSync(join(sourcePath, 'world'), { recursive: true }); mkdirSync(destination, { recursive: true });
  writeFileSync(join(sourcePath, 'world/sentinel'), 'original world'); writeFileSync(join(sourcePath, 'server.properties'), 'server-port=25576\n');
  writeFileSync(join(destination, 'unrelated'), 'another directory');
  const identity = statSync(sourcePath, { bigint: true });
  const transfer = { id: transferId, phase: 'prepared', path: sourcePath, destination, revision: 'import-contract',
    identity: { device: String(identity.dev), inode: String(identity.ino) },
    source: { server_id: transferId, server_name: 'Import contract', path: sourcePath, execution_command: process.execPath, auto_start: false } };
  mkdirSync(join(runtime, 'transfers')); writeFileSync(join(runtime, 'transfers', transferId + '.json'), JSON.stringify(transfer));
  const revision = join(data, 'locked-revisions', transferId, 'import-contract'); mkdirSync(revision, { recursive: true });
  writeFileSync(join(revision, 'lock.json'), JSON.stringify({ schema: 1, id: 'import-contract', minecraft: null, loader: 'unknown', loaderVersion: null,
    command: process.execPath, files: [], java: { executable: process.execPath, sha512: createHash('sha512').update(readFileSync(process.execPath)).digest('hex'), files: [] } }));
  await api('/settings', { craftyUrl: 'http://127.0.0.1:1' }, 'PUT');
  const importBody = { action: 'commit', approve: true, craftyStopped: true, revision: 'import-contract' };
  const conflict = await api(`/servers/${transferId}/runtime/import`, importBody, 'POST', 409);
  assert.match(conflict.error, /destination appeared/);
  transfer.phase = 'committing'; writeFileSync(join(runtime, 'transfers', transferId + '.json'), JSON.stringify(transfer));
  const recoveryConflict = await api(`/servers/${transferId}/runtime/import`, importBody, 'POST', 409);
  assert.match(recoveryConflict.error, /directory identity changed/);
  check('prepared and recovering imports never adopt an unrelated destination', !existsSync(join(runtime, 'servers', transferId + '.json'))
    && readFileSync(join(sourcePath, 'world/sentinel'), 'utf8') === 'original world' && readFileSync(join(destination, 'unrelated'), 'utf8') === 'another directory');
  rmSync(destination, { recursive: true });
  const outside = join(root, 'outside-world'); mkdirSync(outside); writeFileSync(join(outside, 'sentinel'), 'external world');
  for (const phase of ['prepared', 'committing']) {
    transfer.phase = phase; writeFileSync(join(runtime, 'transfers', transferId + '.json'), JSON.stringify(transfer));
    if (phase === 'committing') renameSync(sourcePath, destination);
    const current = phase === 'prepared' ? sourcePath : destination;
    await api(`/servers/${transferId}/properties`, { 'level-name': '../outside-world' }, 'PATCH');
    const escaped = await api(`/servers/${transferId}/runtime/import`, importBody, 'POST', 409);
    assert.match(escaped.error, /external level-name/);
    await api(`/servers/${transferId}/properties`, { 'level-name': 'world' }, 'PATCH');
    const properties = readFileSync(join(current, 'server.properties'));
    await api(`/servers/${transferId}/properties`, { 'level\\u002dname': '../outside-world' }, 'PATCH');
    const escapedKey = await api(`/servers/${transferId}/runtime/import`, importBody, 'POST', 409);
    assert.match(escapedKey.error, /plain key=value properties/);
    writeFileSync(join(current, 'server.properties'), properties);
    renameSync(join(current, 'world'), join(current, 'saved-world'));
    symlinkSync(outside, join(current, 'world'), process.platform === 'win32' ? 'junction' : 'dir');
    const linked = await api(`/servers/${transferId}/runtime/import`, importBody, 'POST', 409);
    assert.match(linked.error, /symlink/);
    unlinkSync(join(current, 'world')); renameSync(join(current, 'saved-world'), join(current, 'world'));
    check(`${phase} imports recheck changed world paths and links before committing`, !existsSync(join(runtime, 'servers', transferId + '.json'))
      && JSON.parse(readFileSync(join(runtime, 'transfers', transferId + '.json'))).phase === phase
      && existsSync(sourcePath) === (phase === 'prepared') && readFileSync(join(current, 'world/sentinel'), 'utf8') === 'original world'
      && readFileSync(join(outside, 'sentinel'), 'utf8') === 'external world');
  }
  rmSync(join(runtime, 'transfers', transferId + '.json')); rmSync(destination, { recursive: true });
  mkdirSync(join(dir, 'mods'), { recursive: true });
  copyFileSync('server/dist/services/launchguard.py', join(dir, '.spawnpoint-launch.py'));
  const runner = join(dir, 'fixture.mjs');
  writeFileSync(runner, `import {createInterface} from 'node:readline';import{once}from'node:events';import{spawn}from'node:child_process';import{readFileSync,writeFileSync}from'node:fs';
console.log('Existing access: '+readFileSync(${JSON.stringify(accessFile)},'utf8'));writeFileSync(${JSON.stringify(accessFile)},'service write');
console.log('Fixture console ready');
createInterface({input:process.stdin}).on('line',async line=>{
  if(line==='stop')process.exit(0);
  if(line==='crash')process.exit(17);
  if(line==='orphan'){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});await once(child,'spawn');writeFileSync('orphan.pid',String(child.pid));process.exit(17);}
  if(line==='flood'){for(let i=0;i<5000;i++)if(!process.stdout.write('x'.repeat(8192)+'\\n'))await once(process.stdout,'drain');console.log('FLOOD FINISHED');}
  else console.log('ACK '+line);
});`);
  const args = [process.execPath, runner];
  const execution_command = [python, '.spawnpoint-launch.py', ...args].map((s) => JSON.stringify(s)).join(' ');
  writeFileSync(join(dir, '.spawnpoint-revision.json'), JSON.stringify({ revision: 'contract', command: execution_command,
    roots: ['mods'], files: [], java: { executable: process.execPath, sha512: createHash('sha512').update(readFileSync(process.execPath)).digest('hex'), files: [] } }));
  const aliasedServers = join(root, 'Servers-alias');
  symlinkSync(join(root, 'Servers'), aliasedServers, 'junction');
  await supervisor('register', { server: { server_id: id, server_name: 'Owner contract', path: join(aliasedServers, id), execution_command, executable: 'fixture.mjs', type: 'minecraft_java', server_port: 25575, server_ip: '127.0.0.1', auto_start: false } });
  await api('/servers/active', { id });
  check('fresh standalone layout can select its registered server', (await api('/servers')).active === id);
  const { revisionDir, setRevisionState } = await import('../server/dist/services/revisions.js');
  mkdirSync(revisionDir(id, 'control-paths'), { recursive: true });
  writeFileSync(join(revisionDir(id, 'control-paths'), 'lock.json'), JSON.stringify({ schema: 1, id: 'control-paths', files: [] }));
  const controlNames = ['.spawnpoint-runtime.lock', '.SPAWNPOINT-RUNTIME.LOCK'];
  for (const name of controlNames) writeFileSync(join(dir, name), 'internal fence');
  writeFileSync(join(dir, 'ordinary.txt'), 'ordinary file');
  const identities = controlNames.map((name) => statSync(join(dir, name), { bigint: true }));
  const aliases = [];
  if (process.platform === 'win32') {
    const short = execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${join(dir, controlNames[0])}") do @echo %~snxI`], { windowsVerbatimArguments: true, encoding: 'utf8', timeout: 10000 }).trim();
    const identity = statSync(join(dir, short), { bigint: true });
    assert.equal(identity.ino, identities[0].ino); assert.equal(identity.dev, identities[0].dev);
    if (!/^\.spawnpoint-/i.test(short)) aliases.push(short);
    console.log('Windows fence short-name alias:', aliases.length ? short : 'not assigned by this filesystem');
  } else {
    symlinkSync(controlNames[0], join(dir, 'control-alias'));
    aliases.push('control-alias');
  }
  for (const active of [undefined, 'control-paths']) {
    setRevisionState(id, { active });
    for (const [index, name] of controlNames.entries()) {
      for (const [route, body, method] of [
        ['files/delete', { path: name }],
        ['files/rename', { from: name, to: 'moved.txt' }],
        ['files/rename', { from: 'ordinary.txt', to: name }],
        ['files/content', { path: name, content: 'replaced' }, 'PUT'],
        ['files/mkdir', { path: name + '-directory/child' }],
        ['packfile/create-server', { path: name }],
      ]) {
        const result = await api(`/servers/${id}/${route}`, body, method, 400);
        assert.match(result.error, /Spawnpoint control files are managed internally/);
      }
      const upload = await fetch(`http://127.0.0.1:25574/api/servers/${id}/files/upload-stream?filename=${encodeURIComponent(name)}`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream', connection: 'close' }, body: 'replacement bytes',
      });
      assert.equal(upload.status, 400);
      assert.match((await upload.json()).error, /Spawnpoint control files are managed internally/);
      const identity = statSync(join(dir, name), { bigint: true });
      assert.equal(identity.ino, identities[index].ino); assert.equal(identity.dev, identities[index].dev);
      assert.equal(readFileSync(join(dir, name), 'utf8'), 'internal fence');
    }
    for (const name of aliases) {
      const edit = await api(`/servers/${id}/files/content`, { path: name, content: 'alias replacement' }, 'PUT', 400);
      const remove = await api(`/servers/${id}/files/delete`, { path: name }, 'POST', 400);
      assert.match(edit.error, /Spawnpoint control files are managed internally/);
      assert.match(remove.error, /Spawnpoint control files are managed internally/);
    }
    await api(`/servers/${id}/files/content`, { path: 'ordinary.txt', content: 'ordinary edit' }, 'PUT');
    check(`${active ? 'sealed' : 'unsealed'} HTTP writers preserve reserved control names and permit ordinary edits`, readFileSync(join(dir, 'ordinary.txt'), 'utf8') === 'ordinary edit'
      && readFileSync(join(dir, controlNames[0]), 'utf8') === 'internal fence'
      && !existsSync(join(dir, 'moved.txt')) && !existsSync(join(dir, controlNames[0] + '-directory')) && !existsSync(join(dir, controlNames[1] + '-directory')));
  }
  setRevisionState(id, { active: undefined });
  mkdirSync(join(dir, 'config'));
  symlinkSync(dir, join(dir, 'config/control'), 'junction');
  const configRefused = await api(`/servers/${id}/configs/file`, { path: 'config/control/.spawnpoint-runtime.lock', content: 'config replacement' }, 'PUT', 500);
  assert.match(configRefused.message, /Spawnpoint control files are managed internally/);
  unlinkSync(join(dir, 'config/control'));
  writeFileSync(join(dir, 'config/ordinary.json'), '{}');
  await api(`/servers/${id}/configs/file`, { path: 'config/ordinary.json', content: '{"ordinary":true}' }, 'PUT');
  check('unsealed config edits reserve aliased control targets while preserving ordinary edits and backups', readFileSync(join(dir, controlNames[0]), 'utf8') === 'internal fence'
    && readFileSync(join(dir, 'config/ordinary.json'), 'utf8') === '{"ordinary":true}' && readFileSync(join(dir, 'config/ordinary.json.bak'), 'utf8') === '{}');
  if (process.platform !== 'win32') {
    unlinkSync(join(dir, 'config/ordinary.json.bak'));
    for (const name of [controlNames[0], '.spawnpoint-mutation']) {
      symlinkSync('../' + name, join(dir, 'config/ordinary.json.bak'));
      const backupRefused = await api(`/servers/${id}/configs/file`, { path: 'config/ordinary.json', content: 'must not land' }, 'PUT', 500);
      assert.match(backupRefused.message, name === controlNames[0] ? /Spawnpoint control files are managed internally/ : /ENOENT/);
      check(`an aliased config backup cannot write ${name} or apply the edit`, readFileSync(join(dir, controlNames[0]), 'utf8') === 'internal fence'
        && !existsSync(join(dir, '.spawnpoint-mutation')) && readFileSync(join(dir, 'config/ordinary.json'), 'utf8') === '{"ordinary":true}');
      unlinkSync(join(dir, 'config/ordinary.json.bak'));
    }
  }
  const holder = spawn(python, [resolve('server/dist/services/launchguard.py'), '--fence', dir], { cwd: root, stdio: ['pipe', 'pipe', 'inherit'] });
  const holderClosed = once(holder, 'close');
  try {
    await Promise.race([once(holder.stdout, 'data'), holderClosed.then(([code]) => { throw new Error(`HTTP contract fence exited before readiness: ${code}`); })]);
    const refused = await api(`/servers/${id}/files/delete`, { path: controlNames[0] }, 'POST', 400);
    assert.match(refused.error, /Spawnpoint control files are managed internally/);
    const contender = spawnSync(python, [resolve('server/dist/services/launchguard.py'), '--fence'], { cwd: dir, input: '', encoding: 'utf8', timeout: 10000 });
    const held = statSync(join(dir, controlNames[0]), { bigint: true });
    check('HTTP deletion cannot split a held fence or admit a competing guard', holder.exitCode === null && contender.status !== null && contender.status !== 0
      && held.ino === identities[0].ino && held.dev === identities[0].dev);
  } finally {
    if (holder.exitCode === null) holder.stdin.end();
    await holderClosed;
  }
  mkdirSync(join(runtime, 'installs'), { recursive: true });
  const unfinished = join(runtime, 'installs', id + '.json');
  writeFileSync(unfinished, JSON.stringify({ id, phase: 'failed', done: true, error: 'incomplete configuration' }));
  await api(`/servers/${id}/action`, { action: 'start' }, 'POST', 409);
  check('unfinished native creation refuses public Start before runtime launch', !(await stats()).running);
  rmSync(unfinished);
  await action('start');
  const first = await ready();
  check('service installation preserves panel and runtime access to existing private files', await until(async () => readFileSync(accessFile, 'utf8') === 'service write'
    && (await logs()).lines.includes('Existing access: panel write'), 'runtime could not read and update the pre-install private file'));
  check('guarded independent runtime exposes its actual PID and RSS', first.mem > 0 && first.pid > 0);
  await api(`/servers/${id}/command`, { cmd: 'say before-panel-exit' });
  await until(async () => (await logs()).lines.some((l) => l === 'ACK say before-panel-exit'), 'stdin did not reach runtime');
  await stopChild(panel);
  await startPanel();
  const second = await ready();
  check('panel exit preserves runtime PID and boot attempt', first.pid === second.pid && first.attempt.id === second.attempt.id);
  await api(`/servers/${id}/command`, { cmd: 'say after-panel-exit' });
  check('restarted panel reconnects to durable console/stdin', await until(async () => (await logs()).lines.some((l) => l === 'ACK say after-panel-exit'), 'console did not reconnect'));
  await assert.rejects(supervisor('stdin', { id, attempt: 'old-boot', cmd: 'stop' }), /attempt changed/);
  await assert.rejects(supervisor('stdin', { id, cmd: 'say injected\nstop' }), /one console command/);
  check('stale and multiline commands cannot stop the current boot', (await stats()).running);
  await api(`/servers/${id}/command`, { cmd: 'flood' });
  await until(async () => (await logs()).lines.includes('FLOOD FINISHED'), 'console backpressure stalled runtime');
  const files = readdirSync(join(runtime, 'logs')).filter((f) => f.startsWith(id));
  check('no-viewer log flood drains with bounded tail and disk retention', (await logs()).lines.length <= 1000 && files.length <= 3 && files.reduce((sum, f) => sum + statSync(join(runtime, 'logs', f)).size, 0) <= 24 * 1024 * 1024);
  for (let i = 0; i < 3; i++) {
    const previous = await ready();
    await api(`/servers/${id}/command`, { cmd: 'crash' });
    if (i < 2) await until(async () => { const s = await ready(); return s.attempt.id !== previous.attempt.id; }, 'crash did not restart');
  }
  await until(async () => { const s = await stats(); return !s.running && /three starts/.test(s.desc); }, 'restart budget did not stop crash loop');
  check('three starts per ten minutes stop a crash loop', !(await stats()).running);
  await stopChild(panel);
  await startPanel();
  check('panel restart cannot reset the independent crash budget', !(await stats()).running);
  await action('start'); await ready(); await action('stop');
  await until(async () => !(await stats()).running, 'explicit stop failed');
  await pause(11_000);
  check('explicit stop is durable and never crash-restarted', !(await stats()).running);
  await api(`/servers/${id}/runtime`, { autoStart: true }, 'PUT');
  await stopOwner(); await startOwner();
  await ready();
  check('native service startup honors explicit autostart', (await stats()).running);
  if (service) {
    const before = await ready(), previousOwner = (await supervisor('health')).pid;
    if (process.platform === 'win32') command('taskkill.exe', '/F', '/PID', String(previousOwner));
    else process.kill(previousOwner, 'SIGKILL');
    await until(async () => (await supervisor('health')).pid !== previousOwner, 'native service did not recover abrupt owner death');
    const after = await until(async () => { const s = await ready(); return s.attempt.id !== before.attempt.id && s; }, 'runtime did not recover after owner death');
    let alive = true;
    try { process.kill(before.pid, 0); } catch { alive = false; }
    check('abrupt service death reaps the old runtime before a replacement takes its fence', !alive && after.pid !== before.pid);
    await action('stop');
    await until(async () => !(await stats()).running, 'stop before orphan test');
    await action('start');
    const parent = await ready(), orphanOwner = (await supervisor('health')).pid;
    await api(`/servers/${id}/command`, { cmd: 'orphan' });
    const orphan = await until(() => existsSync(join(dir, 'orphan.pid')) && Number(readFileSync(join(dir, 'orphan.pid'), 'utf8')), 'runtime did not create its child');
    if (process.platform !== 'win32') await until(async () => (await supervisor('health')).pid !== orphanOwner, 'Unix owner did not contain the orphaned runtime child');
    await until(async () => { const s = await ready(); return s.attempt.id !== parent.attempt.id; }, 'runtime did not recover after descendant cleanup');
    let childAlive = true;
    try { process.kill(orphan, 0); } catch { childAlive = false; }
    check('runtime parent exit cannot leave a child overlapping the replacement boot', !childAlive);
  }
  await api(`/servers/${id}/runtime`, { autoStart: false }, 'PUT');
  await action('stop');
  await until(async () => !(await stats()).running, 'autostart fixture did not stop');
  await stopOwner(); await startOwner();
  check('disabled autostart plus explicit stop remains stopped after owner restart', !(await stats()).running);
  writeFileSync(join(dir, 'mods', 'unexpected.jar'), 'not sealed');
  await action('start');
  await until(async () => (await stats()).crashed, 'changed sealed bytes were not blocked');
  check('owner refuses unexpected locked inputs before executing the runtime', !(await stats()).running);
  if (service && process.platform === 'darwin') {
    const { ensureJdk } = await import('../server/dist/services/temurin.js');
    const { javaFor } = await import('../server/dist/services/servers.js');
    assert.ok(await ensureJdk(21, console.log), 'real macOS JDK download/extraction must succeed');
    const java = spawnSync(javaFor('1.20.1', 'forge'), ['-version'], { encoding: 'utf8' });
    check('a real macOS Temurin bundle installs and executes from the shared Tools recipe', java.status === 0 && /version "21\./.test(java.stderr));
  }
  console.log(`native runtime contract: ${checks} checks passed on ${process.platform}${service ? ' with the native OS service' : ''}`);
} catch (error) {
  failure = error;
  console.error('Primary failure:', error);
  try {
    console.error('Failure evidence:', await supervisor('stats', { id }).catch(String), await supervisor('logs', { id }).then((lines) => lines.slice(-100), String));
    if (service) {
      const args = process.platform === 'win32' ? ['sc.exe', 'queryex', 'SpawnpointSupervisor']
        : process.platform === 'darwin' ? ['launchctl', 'print', 'gui/' + process.getuid() + '/com.spawnpoint.supervisor']
          : ['systemctl', 'show', '-p', 'MainPID,ActiveState,SubState,Result,ExecMainStatus', 'spawnpoint-supervisor.service'];
      const state = spawnSync(args[0], args.slice(1), { encoding: 'utf8' });
      const output = process.platform === 'darwin'
        ? (state.stdout || '').split('\n').filter((line) => /^\s*(state|pid|runs|last exit code|program|path) =/.test(line)).join('\n') : state.stdout;
      console.error('OS service metadata:', state.status, output, state.stderr);
      if (process.platform === 'darwin') {
        const pid = state.stdout?.match(/\bpid = (\d+)/)?.[1];
        const executable = state.stdout?.match(/^\s*program = (.+)$/m)?.[1];
        const commands = [
          ['lsof', '-nP', join(runtime, 'owner', '.spawnpoint-runtime.lock')],
          ...(pid ? [
            ['ps', '-p', [previousAgent, pid].filter(Boolean).join(','), '-o', 'pid,ppid,state,etime,command'],
            ['sample', pid, '1', '1'],
          ] : []),
          ...(executable ? [[executable, '-VV']] : []),
        ];
        for (const args of commands) {
          const detail = spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 10_000 });
          console.error('Owner diagnostic:', args[0], detail.status,
            (detail.stdout || '').split('\n').slice(0, 160).join('\n'),
            (detail.stderr || '').split('\n').slice(0, 10).join('\n'));
        }
      }
      const log = join(runtime, 'service.log');
      if (existsSync(log)) console.error('Owner service log:', readFileSync(log, 'utf8').split('\n').slice(-100).join('\n'));
    }
  } catch (diagnosticError) { console.error('Diagnostic failure:', diagnosticError); }
  throw error;
} finally {
  try {
    await stopChild(panel);
    await stopOwner(); // Never remove a live owner's service or layout.
    if (installed) {
      if (process.platform === 'linux') {
        system('disable'); command('sudo', 'rm', '/etc/systemd/system/spawnpoint-supervisor.service'); command('sudo', 'systemctl', 'daemon-reload');
      } else if (process.platform === 'win32') command('sc.exe', 'delete', 'SpawnpointSupervisor');
      else {
        rmSync(join(homedir(), 'Library/LaunchAgents/com.spawnpoint.supervisor.plist'));
      }
    }
    rmSync(root, { recursive: true, force: true });
  } catch (cleanupError) {
    console.error('Cleanup failure:', cleanupError);
    if (!failure) throw cleanupError;
  }
}
