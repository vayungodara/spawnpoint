// Disposable orb fixture, never a production installer. No credential files
// are read: reset the disposable admin to a generated password, log in once,
// and keep credentials out of output. Requires the orb setup and services.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Agent, request } from 'undici';

if (process.env.SPAWNPOINT_ROOT !== '/srv/sp' || process.env.AMP_ORB !== '1') throw new Error('only the disposable /srv/sp orb fixture is supported');
if (existsSync('/srv/sp/Shared/crafty-token.txt')) throw new Error('fixture already connected; refusing to reset an existing connection');
const password = randomBytes(32).toString('hex');
const reset = spawnSync('sudo', ['docker', 'exec', '-i', 'crafty', '.venv/bin/python', '-'], {
  input: `import sqlite3\nfrom argon2 import PasswordHasher\ndb = sqlite3.connect('app/config/db/crafty.sqlite')\ndb.execute('UPDATE users SET password=? WHERE username=?', (PasswordHasher().hash('${password}'), 'admin'))\ndb.commit()\n`,
  encoding: 'utf8',
});
if (reset.status) throw new Error(`disposable password reset failed: ${reset.stderr}`);
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const response = await request('https://localhost:8443/api/v2/auth/login', {
  method: 'POST', dispatcher: agent, headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password }),
});
const login = await response.body.json();
if (!login.data?.token) throw new Error(`disposable Crafty login failed (${response.statusCode})`);
mkdirSync('/srv/sp/Shared', { recursive: true });
writeFileSync('/srv/sp/Shared/crafty-token.txt', login.data.token, { mode: 0o600 });
const { hashPin } = await import('../server/dist/auth.js');
const { loadSettings, saveSettings } = await import('../server/dist/config.js');
saveSettings({ ...loadSettings(), pin: null, pinHash: hashPin('814207') });
console.log('Disposable Crafty connected; fixture panel PIN: 814207');
// Crafty's HTTP listener comes up before its public jar catalog is cached.
// Creating earlier fails with a misleading executable_update_url SQL error.
for (let attempt = 0; ; attempt++) {
  let ready = false;
  try { ready = !!JSON.parse(readFileSync('/srv/sp/Crafty/config/bigbucket.json', 'utf8')).categories?.mc_java_servers?.types?.fabric?.versions?.['1.21.1']?.url?.[0]; } catch { /* catalog not written yet */ }
  if (ready) break;
  if (attempt >= 120) throw new Error('Crafty did not populate its public Fabric jar catalog');
  await new Promise((r) => setTimeout(r, 1000));
}
const { startCreateServer, getJob } = await import('../server/dist/services/servercreate.js');
const { jobId } = await startCreateServer({ name: 'B1 Fabric proof', loader: 'fabric', mc: '1.21.1', memGb: 2 });
let id;
for (;;) {
  const job = getJob(jobId);
  if (job.done) {
    if (job.error) throw new Error(job.error);
    id = job.serverId;
    break;
  }
  console.log(job.status);
  await new Promise((r) => setTimeout(r, 5000));
}
const { install } = await import('../server/dist/services/installer.js');
// Exact tested versions. The last four projects go to the client shelf by
// their declared side. ImmediatelyFast is not part of this xvfb fixture.
for (const [projectId, versionId] of [
  ['k68glP2e', 'jD0L1VwY'], ['P7dR8mSH', 'Mys3P7lK'],
  ['uXXizFIs', 'sOzRw3CG'], ['gvQqBUqZ', 'N08Z8wog'],
  ['nmDcB62a', 'NnNX8LBn'], ['fALzjamp', 'RVFHfo1D'],
  ['EsAfCjCV', 'b5ZiCjAr'], ['9s6osm5g', 'HpMb5wGb'],
  ['eXts2L7r', 'U5bhVym2'], ['AANobbMI', 'SMxNOGZ6'],
  ['PtjYWJkn', 'CmiqMBZT'], ['Bh37bMuy', 'XtuPOKUN'], ['g96Z4WVZ', 'S2qthD5S'],
]) {
  const result = await install(id, { projectId, versionId, type: 'mod', direct: true });
  if (result.error) throw new Error(result.error);
  console.log(`Seeded ${projectId} ${versionId}`);
}
const { join } = await import('node:path');
const { serverDir } = await import('../server/dist/services/servers.js');
const { patchProperties } = await import('../server/dist/services/properties.js');
const { writeFileAtomic } = await import('../server/dist/services/platform.js');
const { craftyApi } = await import('../server/dist/clients/crafty.js');
const { publishPack } = await import('../server/dist/services/automodpack.js');
const { detect, loaderVersion } = await import('../server/dist/services/detect.js');
const { stopAndWait, waitForReady } = await import('../server/dist/services/maintenance.js');
patchProperties(id, { 'enable-rcon': 'true', 'rcon.port': '25575', 'rcon.password': randomBytes(24).toString('hex') });
const cfg = join(serverDir(id), 'automodpack', 'automodpack-server.json');
writeFileAtomic(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), modpackHost: true, selfUpdater: false, generateModpackOnStart: true, requireAutoModpackOnClient: true }, null, 2));
await publishPack(id);
const since = Date.now();
await craftyApi.action(id, 'start_server');
if (!await waitForReady(id, 300, since)) throw new Error('fixture did not reach ready');
if (loaderVersion(serverDir(id), detect(serverDir(id), id)) !== '0.20.1') throw new Error('fixture loader drifted from Fabric 0.20.1; pin the test launcher before continuing');
if (!await stopAndWait(id)) throw new Error('fixture did not stop');
writeFileSync('/srv/sp/test-server-id', id);
console.log(`Fabric fixture ready and stopped: ${id}`);
await agent.close();
process.exit(0);
