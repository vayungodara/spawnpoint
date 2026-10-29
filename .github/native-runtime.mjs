// Public panel contract against the real independent Python owner and shipped
// guard. Node stands in for Java here; actual Minecraft acceptance is separate.
// --service also exercises the packaged native OS installer/containment in CI.
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, readdirSync, statSync, renameSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir, userInfo, homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'spawnpoint-owner-'));
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
let panel, owner, installed = false, cookie = '';
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
      if (process.platform === 'linux') command('sudo', ...args, '--system', '--user', userInfo().username);
      else command(...args);
      installed = true;
    } else if (process.platform === 'linux') system('start');
    else if (process.platform === 'win32') command('sc.exe', 'start', 'SpawnpointSupervisor');
    else command('launchctl', 'bootstrap', 'gui/' + process.getuid(), join(homedir(), 'Library/LaunchAgents/com.spawnpoint.supervisor.plist'));
  } else owner = spawn(python, ['server/dist/services/supervisor.py'], { stdio: 'ignore' });
  await until(async () => (await supervisor('health')).ok, 'owner health timeout');
}
async function stopOwner() {
  if (!service) return stopChild(owner);
  if (!installed) return;
  if (process.platform === 'linux') system('stop');
  else if (process.platform === 'win32') {
    command('sc.exe', 'stop', 'SpawnpointSupervisor');
    await until(() => /STOPPED/.test(command('sc.exe', 'query', 'SpawnpointSupervisor').toString()), 'SCM stop timeout');
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
  if (service && process.platform === 'darwin') {
    const previous = (await supervisor('health')).pid;
    command(python, script, 'install', '--root', root, '--node', process.execPath);
    check('reinstalling a loaded LaunchAgent waits for the previous owner to exit', (await supervisor('health')).pid !== previous);
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
  await supervisor('register', { server: { server_id: id, server_name: 'Owner contract', path: dir, execution_command, executable: 'fixture.mjs', type: 'minecraft_java', server_port: 25575, server_ip: '127.0.0.1', auto_start: false } });
  await api('/servers/active', { id });
  check('fresh standalone layout can select its registered server', (await api('/servers')).active === id);
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
  console.error('Primary failure:', error);
  console.error('Failure evidence:', await supervisor('stats', { id }).catch(String), await supervisor('logs', { id }).then((lines) => lines.slice(-5), String));
  throw error;
} finally {
  await stopChild(panel);
  try { await stopOwner(); } finally {
    if (installed) {
      if (process.platform === 'linux') {
        system('disable'); command('sudo', 'rm', '/etc/systemd/system/spawnpoint-supervisor.service'); command('sudo', 'systemctl', 'daemon-reload');
      } else if (process.platform === 'win32') command('sc.exe', 'delete', 'SpawnpointSupervisor');
      else {
        rmSync(join(homedir(), 'Library/LaunchAgents/com.spawnpoint.supervisor.plist'));
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}
