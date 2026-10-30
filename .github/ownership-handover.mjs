// A root panel moves a server owned by a separate Crafty account to an
// unprivileged supervisor account, and every path a start writes must then
// belong to that account. Linux only; run as root (sudo -E). Node stands in
// for Java. Real Crafty/Minecraft acceptance is separate (AGENTS.md).
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, chownSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.platform !== 'linux') { console.log('ownership handover: Linux only, skipped'); process.exit(0); }
assert.equal(process.getuid(), 0, 'run as root: sudo -E node .github/ownership-handover.mjs');
const users = ['sp-crafty-test', 'sp-owner-test'];
for (const name of users) {
  try { execFileSync('id', [name], { stdio: 'ignore' }); throw new Error(`${name} already exists; refusing to reuse an account`); }
  catch (error) { if (error.message.includes('already exists')) throw error; }
}
for (const name of users) execFileSync('/usr/sbin/useradd', ['--system', '--no-create-home', '--shell', '/usr/sbin/nologin', name]);
const ids = (name) => ({ uid: Number(execFileSync('id', ['-u', name], { encoding: 'utf8' })), gid: Number(execFileSync('id', ['-g', name], { encoding: 'utf8' })) });
const crafty = ids(users[0]), owner = ids(users[1]);
const root = mkdtempSync(join(tmpdir(), 'spawnpoint-handover-'));
chmodSync(root, 0o755);
const data = join(root, 'Spawnpoint/data');
mkdirSync(data, { recursive: true });
for (const dir of [root, join(root, 'Spawnpoint'), data]) chownSync(dir, owner.uid, owner.gid); // the Core layout
chmodSync(data, 0o700);
process.env.SPAWNPOINT_ROOT = root;
const port = 25578;
let checks = 0;
const check = (name, condition) => { assert.ok(condition, name); checks++; console.log('PASS:', name); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(probe, message, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const result = await probe(); if (result) return result; } catch { /* settling */ }
    await pause(200);
  }
  throw new Error(message);
}
const children = [];
const tree = (dir) => [dir, ...(lstatSync(dir).isDirectory() ? readdirSync(dir).flatMap((n) => tree(join(dir, n))) : [])];

// A Crafty-owned server, with the root-owned file and private directory seen on Core.
const id = randomUUID();
const source = join(root, 'Crafty/servers', id), destination = join(root, 'Servers', id);
mkdirSync(join(source, 'world'), { recursive: true });
mkdirSync(join(source, 'automodpack/.private'), { recursive: true });

writeFileSync(join(source, 'world/level.dat'), 'original level');
writeFileSync(join(source, 'world/session.lock'), '');
writeFileSync(join(source, 'ops.json'), '[]');
writeFileSync(join(source, 'automodpack/.private/key'), 'private');
writeFileSync(join(source, '.spawnpoint-runtime.lock'), '');
writeFileSync(join(source, 'writer.mjs'), `import { openSync, writeSync, closeSync, writeFileSync, mkdirSync } from 'node:fs';
for (const f of ['world/level.dat', 'world/session.lock', 'ops.json', 'server.properties']) { const fd = openSync(f, 'r+'); writeSync(fd, 'x'); closeSync(fd); }
writeFileSync('automodpack/.private/key', 'rotated');
mkdirSync('logs', { recursive: true }); writeFileSync('logs/latest.log', 'Done');
writeFileSync(${JSON.stringify(join(data, 'pack-hosting', 'probe.json'))}, '{}');
console.log('WRITES OK as ' + process.getuid());
setInterval(() => {}, 1000);
process.stdin.on('data', (b) => { if (String(b).trim() === 'stop') process.exit(0); });
`);
for (const path of tree(join(root, 'Crafty'))) chownSync(path, crafty.uid, crafty.gid);
writeFileSync(join(source, 'server.properties'), `server-port=${port + 1}\nlevel-name=world\n`); // root:root 0644
chmodSync(join(source, 'automodpack/.private'), 0o700);
const fenceInode = statSync(join(source, '.spawnpoint-runtime.lock')).ino;
// A stand-in Java under Tools/, as native starts require.
const java = join(root, 'Tools/jdk-21-test/bin/java');
mkdirSync(resolve(java, '..'), { recursive: true });
copyFileSync(process.execPath, java);
chmodSync(java, 0o755);
const command = `"${java}" writer.mjs`;
writeFileSync(join(data, 'settings.json'), JSON.stringify({ port, craftyUrl: 'http://127.0.0.1:1', runtime: 'crafty' }), { mode: 0o600 });

try {
  const { hashPin } = await import('../server/dist/auth.js');
  writeFileSync(join(data, 'settings.json'), JSON.stringify({ port, craftyUrl: 'http://127.0.0.1:1', runtime: 'crafty', pinHash: hashPin('520731') }), { mode: 0o600 });
  // The supervisor runs as its own unprivileged account; the panel as root.
  const supervisor = spawn('python3', [resolve('server/dist/services/supervisor.py')], { uid: owner.uid, gid: owner.gid, env: { ...process.env, SPAWNPOINT_NODE: process.execPath, HOME: root }, stdio: 'inherit' });
  children.push(supervisor);
  await until(() => existsSync(join(data, 'runtime/endpoint.json')), 'supervisor did not start');
  const panel = spawn(process.execPath, ['server/dist/index.js'], { stdio: 'ignore' });
  children.push(panel);
  await until(async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).ok, 'panel did not start');
  const auth = await fetch(`http://127.0.0.1:${port}/api/auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '520731' }) });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const api = async (path, body, expected = 200, method = body ? 'POST' : 'GET') => {
    const response = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  };

  // A prepared transfer and an exact lock, as prepareCraftyImport leaves them.
  const identity = statSync(source, { bigint: true });
  const transfer = { id, phase: 'prepared', path: source, destination, revision: 'handover', owner: { uid: crafty.uid, gid: crafty.gid },
    identity: { device: String(identity.dev), inode: String(identity.ino) },
    source: { server_id: id, server_name: 'Handover', path: source, execution_command: command, executable: 'writer.mjs', type: 'minecraft_java',
      server_ip: '127.0.0.1', server_port: port + 1, auto_start: false, crash_detection: false, update_watcher: false } };
  mkdirSync(join(data, 'runtime/transfers'), { recursive: true });
  writeFileSync(join(data, 'runtime/transfers', `${id}.json`), JSON.stringify(transfer));
  const lock = join(data, 'locked-revisions', id, 'handover');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'lock.json'), JSON.stringify({ schema: 1, id: 'handover', minecraft: null, loader: 'unknown', loaderVersion: null, command, files: [],
    java: { executable: java, sha512: createHash('sha512').update(readFileSync(java)).digest('hex'), files: [] } }));
  const body = { action: 'commit', approve: true, revision: 'handover' };
  // A second prepared server, to overlap two moves.
  const id2 = randomUUID(), source2 = join(root, 'Crafty/servers', id2);
  cpSync(source, source2, { recursive: true });
  writeFileSync(join(source2, 'server.properties'), `server-port=${port + 2}\nlevel-name=world\n`);
  for (const path of tree(source2)) chownSync(path, crafty.uid, crafty.gid);
  const identity2 = statSync(source2, { bigint: true });
  writeFileSync(join(data, 'runtime/transfers', `${id2}.json`), JSON.stringify({ ...transfer, id: id2, path: source2, destination: join(root, 'Servers', id2),
    identity: { device: String(identity2.dev), inode: String(identity2.ino) }, source: { ...transfer.source, server_id: id2, path: source2, server_port: port + 2 } }));
  cpSync(lock, join(data, 'locked-revisions', id2, 'handover'), { recursive: true });

  // A stand-in Crafty (`python main.py` in its own systemd scope) keeps running.
  const app = join(root, 'crafty-app');
  mkdirSync(app);
  writeFileSync(join(app, 'main.py'), 'import time\nwhile True: time.sleep(1)\n');
  const craftyUnit = `sp-handover-crafty-${process.pid}`;
  const fake = spawn('systemd-run', ['--scope', '--quiet', `--unit=${craftyUnit}`, `--uid=${crafty.uid}`, `--gid=${crafty.gid}`, 'python3', join(app, 'main.py'), '-d'], { stdio: 'ignore' });
  children.push(fake);
  const scope = `/sys/fs/cgroup/system.slice/${craftyUnit}.scope`;
  await until(() => existsSync(join(scope, 'cgroup.freeze')), 'stand-in Crafty scope did not start');
  check('the panel offers a single-server move while Crafty runs', (await api(`/servers/${id}/runtime`)).move === 'single');

  // A Crafty-side process still working inside the folder blocks the move,
  // and the folder goes back to Crafty unchanged.
  const busy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: source, uid: crafty.uid, gid: crafty.gid, stdio: 'ignore' });
  const busy2 = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: source2, uid: crafty.uid, gid: crafty.gid, stdio: 'ignore' });
  children.push(busy, busy2);
  await Promise.all([once(busy, 'spawn'), once(busy2, 'spawn')]);
  let frozenSeen = 0; // sampled from outside while the move unit runs
  const sampler = setInterval(() => { try { if (/^frozen 1$/m.test(readFileSync(join(scope, 'cgroup.events'), 'utf8'))) frozenSeen++; } catch { /* gone */ } }, 2);
  const [refused, refused2] = await Promise.all([api(`/servers/${id}/runtime/import`, body, 409), api(`/servers/${id2}/runtime/import`, body, 409)]);
  clearInterval(sampler);
  check('overlapping moves of two servers take turns pausing Crafty, and each gets its own answer',
    refused2.error.includes(`pid ${busy2.pid}`) && existsSync(source2) && readFileSync(join(scope, 'cgroup.freeze'), 'utf8').trim() === '0');
  busy2.kill();
  check('Crafty with every worker is frozen while the panel scans for writers', frozenSeen > 0);
  console.log('refusal:', refused.error);
  check('a foreign process with its working directory inside blocks a single-server move', /still has this server's files open/.test(refused.error) && refused.error.includes(`pid ${busy.pid}`));
  check('a refused move returns the folder to Crafty with Crafty ownership', existsSync(source) && !existsSync(destination)
    && tree(source).filter((p) => !p.endsWith('server.properties')).every((p) => lstatSync(p).uid === crafty.uid)
    && JSON.parse(readFileSync(join(data, 'runtime/transfers', `${id}.json`))).phase === 'prepared' && !existsSync(join(source, '.spawnpoint-mutation')));
  busy.kill();
  await once(busy, 'exit');

  const moved = await api(`/servers/${id}/runtime/import`, body);
  check('a root panel commits the move while Crafty is not stopped', moved.crafty === 'running' && moved.account === users[1]);
  check('Crafty is running again, not left frozen', readFileSync(join(scope, 'cgroup.freeze'), 'utf8').trim() === '0' && fake.exitCode === null);
  check('no move unit or pause record is left behind', !execFileSync('systemctl', ['list-units', '--all', '--plain', '--no-legend', 'spawnpoint-move-*'], { encoding: 'utf8' }).trim()
    && !existsSync(join(data, 'runtime/crafty-frozen.json')));
  // A panel killed mid-move: the next panel start thaws Crafty once the move
  // unit has fully stopped, and never while it is still running.
  const group = scope.slice('/sys/fs/cgroup'.length);
  const record = (unit) => writeFileSync(join(data, 'runtime/crafty-frozen.json'), JSON.stringify({ groups: [group], unit }));
  const restart = async (previous) => {
    previous.kill('SIGKILL');
    await once(previous, 'exit');
    const next = spawn(process.execPath, ['server/dist/index.js'], { stdio: 'ignore' });
    children.push(next);
    await until(async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).ok, 'panel did not restart');
    return next;
  };
  const liveUnit = `spawnpoint-move-handover-${process.pid}`;
  execFileSync('systemd-run', ['--quiet', '--collect', `--unit=${liveUnit}`, 'sleep', '120']);
  record(liveUnit);
  writeFileSync(join(scope, 'cgroup.freeze'), '1');
  const second = await restart(panel);
  check('startup leaves Crafty frozen while its move unit still runs', readFileSync(join(scope, 'cgroup.freeze'), 'utf8').trim() === '1');
  execFileSync('systemctl', ['stop', `${liveUnit}.service`]);
  await restart(second);
  check('startup thaws a Crafty whose move unit has stopped', readFileSync(join(scope, 'cgroup.freeze'), 'utf8').trim() === '0' && !existsSync(join(data, 'runtime/crafty-frozen.json')));
  check('the whole tree, including root-owned and private files, belongs to the supervisor account',
    tree(destination).every((p) => lstatSync(p).uid === owner.uid && lstatSync(p).gid === owner.gid));
  check('owner write and traverse bits are present everywhere', tree(destination).every((p) => (lstatSync(p).mode & (lstatSync(p).isDirectory() ? 0o700 : 0o600)) === (lstatSync(p).isDirectory() ? 0o700 : 0o600)));
  check('the runtime fence keeps its inode', statSync(join(destination, '.spawnpoint-runtime.lock')).ino === fenceInode);
  check('shared hosting state belongs to the supervisor account', statSync(join(data, 'pack-hosting')).uid === owner.uid);

  // Root writes after the move inherit the server's owner: atomic replacements
  // (AutoModpack publication) and directories they create.
  const { writeFileAtomic } = await import('../server/dist/services/platform.js');
  writeFileAtomic(join(destination, 'automodpack/automodpack-server.json'), '{}');
  writeFileAtomic(join(destination, 'logs/new/nested/file.json'), '{}');
  check('root atomic writes and new directories take the server owner', ['automodpack/automodpack-server.json', 'logs/new', 'logs/new/nested', 'logs/new/nested/file.json']
    .every((p) => statSync(join(destination, p)).uid === owner.uid));
  chownSync(join(destination, 'ops.json'), 0, 0); // a stray root write before a start

  await api(`/servers/${id}/action`, { action: 'start_server' });
  const logs = await until(async () => { const l = JSON.stringify(await api(`/servers/${id}/logs`)); return l.includes('WRITES OK') && l; }, 'the server could not write its files');
  check('a start as the supervisor account writes the world, session.lock, configs, AutoModpack state and pack-hosting',
    logs.includes(`WRITES OK as ${owner.uid}`) && readFileSync(join(destination, 'world/level.dat'), 'utf8').startsWith('x'));
  await api(`/servers/${id}/action`, { action: 'stop_server' });
  await until(async () => !(await api(`/servers/${id}/stats`)).running, 'the server did not stop');
  // A server's own account cannot steer root through a swapped link.
  const outside = join(root, 'outside');
  mkdirSync(outside); writeFileSync(join(outside, 'secret'), 'root only'); chmodSync(join(outside, 'secret'), 0o600);
  const { symlinkSync } = await import('node:fs');
  symlinkSync(outside, join(destination, 'logs/escape'));
  await api(`/servers/${id}/action`, { action: 'start_server' });
  await until(async () => (await api(`/servers/${id}/stats`)).running, 'the server did not start again');
  check('handing a tree over never follows a link out of it', statSync(join(outside, 'secret')).uid === 0 && lstatSync(join(destination, 'logs/escape')).uid === owner.uid);
  await api(`/servers/${id}/action`, { action: 'stop_server' });
  await until(async () => !(await api(`/servers/${id}/stats`)).running, 'the server did not stop');
  console.log(`ownership handover: ${checks} checks passed`);
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  try { execFileSync('systemctl', ['stop', `sp-handover-crafty-${process.pid}.scope`], { stdio: 'ignore' }); } catch { /* not started */ }
  await pause(500);
  for (const name of users) try { execFileSync('/usr/sbin/userdel', [name]); } catch { /* cleanup */ }
  rmSync(root, { recursive: true, force: true });
}
