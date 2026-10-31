// Publication contract with real HTTP/RCON transports and the shipped OS
// fence. Native AutoModpack completion is controlled; live proof is separate.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as httpServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'spawnpoint-publication-'));
process.env.SPAWNPOINT_ROOT = root;
const id = randomUUID(), dir = join(root, 'Crafty', 'servers', id);
const data = join(root, 'Spawnpoint', 'data');
const config = join(dir, 'automodpack', 'automodpack-server.json');
const log = join(dir, 'logs', 'latest.log');
const mutex = join(dir, '.spawnpoint-publication');
for (const path of [join(dir, 'automodpack'), join(dir, 'mods'), join(dir, 'logs'), data, join(root, 'Shared')]) mkdirSync(path, { recursive: true });
writeFileSync(join(dir, 'mods', 'automodpack-mc1.21.1-fabric-4.0.7.jar'), '');
const original = JSON.stringify({ modpackHost: true, generateModpackOnStart: true, selfUpdater: false });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async predicate => {
  for (let n = 0; !predicate(); n++) { assert.ok(n < 100, 'command must arrive'); await pause(50); }
};
let commands = [], stopped = false, stopping = false;
const sockets = new Set();
const rcon = tcpServer(socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  let pending = Buffer.alloc(0);
  socket.on('data', bytes => {
    pending = Buffer.concat([pending, bytes]);
    while (pending.length >= 4 && pending.length >= pending.readInt32LE(0) + 4) {
      const length = pending.readInt32LE(0) + 4, packet = pending.subarray(0, length);
      pending = pending.subarray(length);
      const response = Buffer.alloc(14);
      response.writeInt32LE(10, 0); response.writeInt32LE(packet.readInt32LE(4), 4);
      response.writeInt32LE(packet.readInt32LE(8) === 3 ? 2 : 0, 8);
      socket.write(response);
    }
  });
});
const crafty = httpServer(async (req, res) => {
  let body = ''; for await (const bytes of req) body += bytes;
  if (req.url.endsWith('/stdin')) commands.push(body);
  else if (req.url.endsWith('/action/stop_server')) {
    stopping = true;
    // An in-flight native reload can still save enabled bytes during stop.
    setTimeout(() => { writeFileSync(config, original); stopped = true; }, 250);
  } else assert.ok(req.url.endsWith('/stats'), req.url);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ status: 'ok', data: { running: !stopped, waiting_start: false } }));
});
await new Promise(resolve => rcon.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => crafty.listen(0, '127.0.0.1', resolve));
const gamePort = tcpServer();
await new Promise(resolve => gamePort.listen(0, '127.0.0.1', resolve));
const port = gamePort.address().port;
await new Promise(resolve => gamePort.close(resolve));
writeFileSync(join(data, 'settings.json'), JSON.stringify({ craftyUrl: `http://127.0.0.1:${crafty.address().port}` }));
writeFileSync(join(root, 'Shared', 'crafty-token.txt'), 'disposable-fixture-token');
writeFileSync(join(dir, 'server.properties'), `enable-rcon=true\nrcon.password=fixture\nrcon.port=${rcon.address().port}\nserver-port=${port}\nbroadcast-rcon-to-ops=false\n`);
const { holdHosting, hostingHold, releaseHosting, recoverHosting } = await import('../server/dist/services/automodpack.js');
const { setRevisionState } = await import('../server/dist/services/revisions.js');
setRevisionState(id, { managedHosting: true });
writeFileSync(config, original); holdHosting(id);
const paused = hostingHold(id).paused;
const feedback = (message, forge = false) => appendFileSync(log, `[12:00:00] [Worker-Main-1/INFO]${forge ? ' [minecraft/MinecraftServer]' : ''}: ${message}\n`);
const reset = () => { commands = []; stopped = stopping = false; writeFileSync(config, paused); writeFileSync(log, ''); };
try {
  for (const forge of [false, true]) {
    reset();
    feedback('AutoModpack server config reloaded!', forge); // stale success
    let released = false;
    const publication = releaseHosting(id, async () => {}).then(() => { released = true; });
    await waitFor(() => commands.length === 1);
    feedback('<Alex> [x] [y/INFO]: AutoModpack server config reloaded!', forge);
    await pause(1200);
    assert.deepEqual(commands, ['automodpack config reload']);
    assert.equal(readFileSync(config, 'utf8'), original);
    assert.ok(existsSync(mutex));
    feedback('AutoModpack server config reloaded!', forge);
    await waitFor(() => commands.length === 2);
    assert.equal(readFileSync(config, 'utf8'), paused);
    feedback('<Alex> [x] [y/INFO]: Modpack hosting started!', forge);
    feedback('Hosting modpack on Minecraft port 25565', forge);
    await pause(1200);
    assert.equal(released, false); assert.ok(existsSync(mutex));
    feedback(forge ? 'Modpack hosting is already running!' : 'Modpack hosting started!', forge);
    await publication;
    assert.equal(readFileSync(config, 'utf8'), paused);
    assert.equal(existsSync(mutex), false); assert.equal(stopping, false);
    console.log(`PASS: ${forge ? 'Forge' : 'Fabric'} console completion publishes; stale/chat/intermediate messages cannot authorize it`);
  }
  reset();
  const refused = assert.rejects(releaseHosting(id, async () => {}), /refused the publication command/);
  await waitFor(() => commands.length === 1);
  feedback('Error while reloading config file!');
  await waitFor(() => stopping);
  assert.ok(existsSync(mutex));
  await refused;
  assert.equal(readFileSync(config, 'utf8'), paused);
  assert.equal(existsSync(mutex), false); assert.equal(stopped, true);
  assert.deepEqual(commands, ['automodpack config reload']);
  console.log('PASS: failed async completion stops before restoring paused bytes or releasing publication fence');
  reset();
  const dead = spawnSync(process.execPath, ['-e', ''], { timeout: 10000 });
  assert.equal(dead.status, 0);
  mkdirSync(mutex); writeFileSync(join(mutex, 'owner.json'), JSON.stringify({ pid: dead.pid }));
  writeFileSync(config, original);
  const recovery = recoverHosting(id);
  await waitFor(() => stopping);
  assert.ok(existsSync(mutex));
  await recovery;
  assert.equal(readFileSync(config, 'utf8'), paused);
  assert.equal(existsSync(mutex), false); assert.equal(stopped, true);
  console.log('PASS: dead publisher recovery proves stopped runtime before reclaiming its fence');
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => rcon.close(resolve));
  crafty.closeAllConnections(); await new Promise(resolve => crafty.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
