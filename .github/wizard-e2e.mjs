// CI wizard E2E: a stranger's first run on an EMPTY layout. The wizard is
// open, every unauthenticated write needs the setup code, a pasted Crafty key
// is verified (against a stub Crafty) and saved, the PIN step logs the
// browser in, and afterwards the API refuses anyone without a session or
// the admin token, on loopback too.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const PORT = 25573;
const CRAFTY_PORT = 8949;
const ADMIN = { username: 'admin', password: 'stub-password' };
const MINTED = 'stub-crafty-token-abc123';
const SERVER_ID = '0b7f4c1e-2d3a-4b5c-8d9e-0123456789ab';

const fails = [];
const check = (name, ok) => {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}`);
  if (!ok) fails.push(name);
};

// ---- stub Crafty ----------------------------------------------------------
const crafty = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/api/v2/auth/login') {
      const j = JSON.parse(body || '{}');
      const ok = j.username === ADMIN.username && j.password === ADMIN.password;
      res.statusCode = ok ? 200 : 401;
      res.end(JSON.stringify(ok ? { status: 'ok', data: { token: MINTED, user_id: '1' } } : { status: 'error' }));
      return;
    }
    if (req.url === '/api/v2/servers') {
      const ok = req.headers.authorization === `Bearer ${MINTED}`;
      res.statusCode = ok ? 200 : 401;
      res.end(JSON.stringify(ok ? { status: 'ok', data: [{ server_id: SERVER_ID }, { server_id: 's2' }] } : { status: 'error' }));
      return;
    }
    res.end(JSON.stringify({ status: 'ok', data: {} }));
  });
});
await new Promise((r) => crafty.listen(CRAFTY_PORT, '127.0.0.1', r));

// ---- empty layout + panel -------------------------------------------------
const root = mkdtempSync(join(tmpdir(), 'spawnpoint-wizard-'));
const data = join(root, 'Spawnpoint', 'data');
mkdirSync(data, { recursive: true });
writeFileSync(join(data, 'settings.json'), JSON.stringify({ port: PORT }));

let done = false;
const child = spawn(process.execPath, ['server/dist/index.js'], {
  env: { ...process.env, SPAWNPOINT_ROOT: root },
  stdio: 'ignore',
});
const die = (why) => { console.error(why); try { child.kill(); } catch {} crafty.close(); process.exit(1); };
child.on('exit', (code) => { if (!done) die(`panel exited early (code ${code})`); });

const base = `http://127.0.0.1:${PORT}`;
const deadline = Date.now() + 90_000;
for (;;) {
  if (Date.now() > deadline) die('panel never served /api/health');
  try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* booting */ }
  await new Promise((r) => setTimeout(r, 1000));
}
const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const craftyUrl = `http://127.0.0.1:${CRAFTY_PORT}`;
const code = readFileSync(join(data, 'setup-code.txt'), 'utf8').trim();
const tokenFile = join(root, 'Shared', 'crafty-token.txt');

// ---- before setup: the wizard is open, nothing else is -------------------
let st = await (await fetch(`${base}/api/wizard/status`)).json();
check('fresh layout: wizard active', st.active === true);
check('fresh layout: no jdk detected', st.hasJdk === false);
check('setup code printed to the data dir', code.length >= 16);
check('pre-setup: the API refuses loopback callers too', (await fetch(`${base}/api/settings/summary`)).status === 401);
check('pre-setup: a percent-encoded path cannot dodge the gate', (await fetch(`${base}/%61pi/settings/summary`)).status === 401);
check('pre-setup: nobody can set the first PIN through Settings',
  (await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '482915' }) })).status === 401);

// ---- connect Crafty -------------------------------------------------------
let r = await post('/api/wizard/crafty-login', { token: MINTED, url: craftyUrl });
check('connecting without the setup code is refused, even from loopback', r.status === 403);
r = await post('/api/wizard/crafty-login', { token: MINTED, url: craftyUrl, code: 'DEADBEEFDEADBEEFDEAD' });
check('a wrong setup code is refused', r.status === 403);
check('no token written by refused attempts', !existsSync(tokenFile));

r = await post('/api/wizard/crafty-login', { ...ADMIN, password: 'wrong', url: craftyUrl, code });
check('wrong Crafty password rejected with 401', r.status === 401);
r = await post('/api/wizard/crafty-login', { ...ADMIN, url: 'http://example.com:8443', code });
check('public crafty url refused (SSRF guard)', r.status === 400);
r = await post('/api/wizard/crafty-login', { ...ADMIN, url: 'file:///etc/passwd', code });
check('non-http scheme refused', r.status === 400);

// a Crafty address that answers with HTML (wrong port / web UI) must produce
// a readable error, not a raw parser crash
const htmlStub = createServer((_q, s) => { s.setHeader('content-type', 'text/html'); s.end('<html>login</html>'); });
await new Promise((res2) => htmlStub.listen(CRAFTY_PORT + 1, '127.0.0.1', res2));
r = await post('/api/wizard/crafty-login', { ...ADMIN, url: `http://127.0.0.1:${CRAFTY_PORT + 1}`, code });
check('html response yields a readable error', r.status === 502 && /web page/.test((await r.json()).error ?? ''));
htmlStub.close();

r = await post('/api/wizard/crafty-login', { token: 'not-a-real-key', url: craftyUrl, code });
check('bad pasted API key rejected with 401', r.status === 401);
r = await post('/api/wizard/crafty-login', { url: craftyUrl, code });
check('neither key nor credentials yields 400', r.status === 400);
check('no token written for a bad key', !existsSync(tokenFile));

r = await post('/api/wizard/crafty-login', { token: MINTED, url: craftyUrl, code });
const login = await r.json();
check('pasted API key accepted', r.ok && login.ok === true);
check('reports server count from crafty', login.servers === 2);
check('token file written', existsSync(tokenFile) && readFileSync(tokenFile, 'utf8').trim() === MINTED);
const saved = JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8'));
check('custom crafty url persisted', saved.craftyUrl === craftyUrl);
r = await post('/api/wizard/crafty-login', { token: MINTED, url: craftyUrl, code });
check('connecting again is refused once Crafty is connected', r.status === 403);

// ---- PIN step -------------------------------------------------------------
st = await (await fetch(`${base}/api/wizard/status`)).json();
check('wizard stays open until a PIN exists', st.active === true && st.craftyConnected === true && st.pinSet === false);
r = await post('/api/wizard/finish', { pin: '482915' });
check('finish without the setup code is refused', r.status === 403);
r = await post('/api/wizard/finish', { pin: '4321', code });
check('a 4-digit PIN is refused', r.status === 400);
r = await post('/api/wizard/finish', { pin: '482915', code });
const setCookie = r.headers.get('set-cookie') ?? '';
const cookie = /sp_auth=[0-9a-z]+\.[a-f0-9]{64}/.exec(setCookie)?.[0] ?? '';
check('finish sets the PIN and issues a session cookie', r.ok && !!cookie);
check('setup code cleared once setup completes', !existsSync(join(data, 'setup-code.txt')));
st = await (await fetch(`${base}/api/wizard/status`)).json();
check('wizard deactivates itself', st.active === false);
r = await post('/api/wizard/finish', { pin: '111111', code });
check('finish refuses once a PIN exists', r.status === 403);

// ---- after setup: sessions, the admin token, and nothing else --------------
const auth = await (await fetch(`${base}/api/auth/check`, { headers: { cookie } })).json();
check('the session cookie validates', auth.required === true && auth.ok === true);
check('no cookie means locked', (await (await fetch(`${base}/api/auth/check`)).json()).ok === false);
check('guarded route refuses a caller with no cookie', (await fetch(`${base}/api/settings/summary`)).status === 401);
check('guarded route accepts the session cookie', (await fetch(`${base}/api/settings/summary`, { headers: { cookie } })).ok);
const forged = `sp_auth=${Date.now().toString(36)}.${'0'.repeat(64)}`;
check('guarded route rejects a forged cookie', (await fetch(`${base}/api/settings/summary`, { headers: { cookie: forged } })).status === 401);
const adminToken = readFileSync(join(data, 'admin-token'), 'utf8').trim();
check('the admin token works for scripts', (await fetch(`${base}/api/settings/summary`, { headers: { authorization: `Bearer ${adminToken}` } })).ok);
check('a wrong bearer token is refused', (await fetch(`${base}/api/settings/summary`, { headers: { authorization: 'Bearer nope' } })).status === 401);
r = await fetch(`${base}/api/settings`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', cookie, origin: 'https://evil.example' },
  body: JSON.stringify({}),
});
check('a cross-site write with the session cookie is refused', r.status === 403);
r = await post('/api/auth', { pin: '000000' });
check('a wrong PIN is refused', r.status === 401);
r = await post('/api/auth', { pin: '482915' });
check('the right PIN logs in', r.ok && /sp_auth=/.test(r.headers.get('set-cookie') ?? ''));

// one id check guards every /api/servers/:id route (ids become folder paths)
const bearer = { authorization: `Bearer ${adminToken}` };
r = await fetch(`${base}/api/servers/..%2f..%2fetc/installed`, { headers: bearer });
check('a server id that is not a UUID is refused', r.status === 400);
mkdirSync(join(root, 'Crafty', 'servers', SERVER_ID), { recursive: true });
r = await fetch(`${base}/api/servers/${SERVER_ID}/files/content?path=../../../../etc/passwd`, { headers: bearer });
check('a file path outside the server folder is refused', r.status === 400 && /escapes/.test((await r.json()).error ?? ''));
// a dangling symlink must not be written through to its target
const outside = join(root, 'outside-target.txt');
let linked = true;
try { symlinkSync(outside, join(root, 'Crafty', 'servers', SERVER_ID, 'dangling')); } catch { linked = false; } // Windows without symlink rights
if (linked) {
  r = await fetch(`${base}/api/servers/${SERVER_ID}/files/content`, {
    method: 'PUT',
    headers: { ...bearer, 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'dangling', content: 'x' }),
  });
  check('a dangling symlink is not written through', r.status === 400 && !existsSync(outside));
  // deleting a link removes the link, never what it points at
  const srv = join(root, 'Crafty', 'servers', SERVER_ID);
  mkdirSync(join(srv, 'world'), { recursive: true });
  writeFileSync(join(srv, 'world', 'level.dat'), 'x');
  symlinkSync(join(srv, 'world'), join(srv, 'world-link'));
  const del = (path) => fetch(`${base}/api/servers/${SERVER_ID}/files/delete`, {
    method: 'POST',
    headers: { ...bearer, 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  r = await del('world-link');
  check('deleting a symlink keeps its target', r.ok && !existsSync(join(srv, 'world-link')) && existsSync(join(srv, 'world', 'level.dat')));
  r = await del('./world/');
  check('the world folder cannot be deleted under another spelling', r.status === 400 && existsSync(join(srv, 'world', 'level.dat')));
}

// ---- scoped API tokens: read < control < approve, owner-only management ----
const srvDir = join(root, 'Crafty', 'servers', SERVER_ID);
writeFileSync(join(srvDir, 'server.properties'), 'enable-rcon=true\nrcon.password=hunter2\nmotd=hi\n');
const hhmmss = (d) => d.toTimeString().slice(0, 8);
mkdirSync(join(srvDir, 'logs'), { recursive: true });
writeFileSync(join(srvDir, 'logs', 'latest.log'), [
  `[${hhmmss(new Date(Date.now() - 2 * 3600_000))}] [Server thread/INFO]: old line`,
  `[${hhmmss(new Date(Date.now() - 5_000))}] [Server thread/ERROR]: new line`,
  '\tat some.Stack.frame(Frame.java:1)',
].join('\n'));
const mint = (scope, extra = {}) => post('/api/tokens', { name: `agent-${scope}`, scope, ...extra }, bearer);
check('an approve token needs explicit confirmation', (await mint('approve')).status === 400);
const tok = {};
for (const s of ['read', 'control', 'approve']) tok[s] = (await (await mint(s, s === 'approve' ? { confirmApprove: true } : {})).json()).token;
check('scoped tokens are issued once', ['read', 'control', 'approve'].every((s) => /^spt_[0-9a-f]{8}_[\w-]{32}$/.test(tok[s] ?? '')));
check('only token hashes are stored', !readFileSync(join(data, 'api-tokens.json'), 'utf8').includes(tok.read.slice(14)));
const as = async (scope, method, path, body) => (await fetch(`${base}${path}`, {
  method,
  headers: { authorization: `Bearer ${tok[scope]}`, ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body && JSON.stringify(body),
})).status;
const sp = `/api/servers/${SERVER_ID}`;
check('read can read settings', await as('read', 'GET', '/api/chatgenie') === 200);
check('read cannot change settings', await as('read', 'PUT', '/api/chatgenie', {}) === 403);
check('control can change settings', await as('control', 'PUT', '/api/chatgenie', {}) === 200);
check('read can read server logs', await as('read', 'GET', `${sp}/files/content?path=logs/latest.log`) === 200);
check('read cannot read other files', await as('read', 'GET', `${sp}/files/content?path=server.properties`) === 403);
check('read cannot climb out of logs/', await as('read', 'GET', `${sp}/files/content?path=logs/../server.properties`) === 403);
check('control can read files', await as('control', 'GET', `${sp}/files/content?path=server.properties`) === 200);
const props = async (h) => (await (await fetch(`${base}${sp}/properties`, { headers: h })).json()).properties;
check('scoped tokens never see the RCON password', (await props({ authorization: `Bearer ${tok.approve}` }))['rcon.password'] === '(hidden)');
check('the owner still sees it', (await props(bearer))['rcon.password'] === 'hunter2');
check('control cannot approve a mod change', await as('control', 'POST', `${sp}/candidate/apply`, { consent: true }) === 403);
check('control cannot restore a world', await as('control', 'POST', `${sp}/backups/restore`, { file: 'x.zip' }) === 403);
check('approve reaches the approval route', ![401, 403].includes(await as('approve', 'POST', `${sp}/candidate/apply`, { consent: true })));
check('no scoped token manages tokens', await as('approve', 'GET', '/api/tokens') === 403 && await as('approve', 'POST', '/api/tokens', { name: 'x', scope: 'read' }) === 403);
check('no scoped token changes the PIN', await as('approve', 'PUT', '/api/settings', { pin: '123456' }) === 403);
check('no scoped token deletes a server', await as('approve', 'DELETE', sp, { confirmName: 'x' }) === 403);
check('HEAD follows the GET scope', (await fetch(`${base}/api/tokens`, { method: 'HEAD', headers: { authorization: `Bearer ${tok.approve}` } })).status === 403);
check('control cannot wipe player data', await as('control', 'POST', `${sp}/reset-players`) === 403);
let logLink = true;
try { symlinkSync(join(srvDir, 'server.properties'), join(srvDir, 'logs', 'props.log')); } catch { logLink = false; }
if (logLink) check('read cannot follow a link in logs/', await as('read', 'GET', `${sp}/files/content?path=logs/props.log`) === 403);
const since = await (await fetch(`${base}${sp}/logs?file=latest&since=60`, { headers: { authorization: `Bearer ${tok.read}` } })).json();
check('logs --since keeps recent lines and their stack frames', since.lines?.length === 2 && /new line/.test(since.lines[0]));
const listed = (await (await fetch(`${base}/api/tokens`, { headers: bearer })).json()).tokens;
check('the owner sees tokens and their last use, never hashes', listed.length === 3 && listed.every((t) => !('hash' in t)) && !!listed.find((t) => t.scope === 'read')?.lastUsed);
const readId = tok.read.split('_')[1];
check('a tampered token is refused', await as('read', 'GET', '/api/chatgenie') === 200
  && (await fetch(`${base}/api/chatgenie`, { headers: { authorization: `Bearer spt_${readId}_${'A'.repeat(32)}` } })).status === 401);
check('the owner can revoke a token', (await fetch(`${base}/api/tokens/${readId}`, { method: 'DELETE', headers: bearer })).ok);
check('a revoked token stops working at once', await as('read', 'GET', '/api/chatgenie') === 401);

done = true;
child.kill();
crafty.close();
if (fails.length) { console.error(`\n${fails.length} check(s) failed`); process.exit(1); }
console.log(`\nwizard E2E passed on ${process.platform}`);
