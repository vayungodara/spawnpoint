// CI wizard E2E: prove a stranger's first run end-to-end on an EMPTY layout —
// wizard reports active, a one-shot Crafty admin login mints and persists the
// token (against a stub Crafty), the wizard turns itself off, its mutating
// route refuses afterwards, and the PIN step logs the browser in with a
// cookie that actually validates.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const PORT = 25573;
const CRAFTY_PORT = 8949;
const ADMIN = { username: 'admin', password: 'hunter2' };
const MINTED = 'stub-crafty-token-abc123';

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
      if (j.username === ADMIN.username && j.password === ADMIN.password) {
        res.end(JSON.stringify({ status: 'ok', data: { token: MINTED, user_id: '1' } }));
      } else {
        res.statusCode = 401;
        res.end(JSON.stringify({ status: 'error' }));
      }
      return;
    }
    if (req.url === '/api/v2/servers') {
      if (req.headers.authorization === `Bearer ${MINTED}`) {
        res.end(JSON.stringify({ status: 'ok', data: [{ server_id: 's1' }, { server_id: 's2' }] }));
      } else {
        res.statusCode = 401;
        res.end(JSON.stringify({ status: 'error' }));
      }
      return;
    }
    res.end(JSON.stringify({ status: 'ok', data: {} }));
  });
});
await new Promise((r) => crafty.listen(CRAFTY_PORT, '127.0.0.1', r));

// ---- empty layout + panel -------------------------------------------------
const root = mkdtempSync(join(tmpdir(), 'spawnpoint-wizard-'));
mkdirSync(join(root, 'Spawnpoint', 'data'), { recursive: true });
writeFileSync(join(root, 'Spawnpoint', 'data', 'settings.json'), JSON.stringify({ port: PORT }));

const child = spawn(process.execPath, ['server/dist/index.js'], {
  env: { ...process.env, SPAWNPOINT_ROOT: root },
  stdio: 'ignore',
});
const die = (why) => { console.error(why); try { child.kill(); } catch {} crafty.close(); process.exit(1); };
child.on('exit', (code) => { if (!done) die(`panel exited early (code ${code})`); });
let done = false;

const base = `http://127.0.0.1:${PORT}`;
const deadline = Date.now() + 90_000;
for (;;) {
  if (Date.now() > deadline) die('panel never served /api/health');
  try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* booting */ }
  await new Promise((r) => setTimeout(r, 1000));
}

// ---- the flow -------------------------------------------------------------
let st = await (await fetch(`${base}/api/wizard/status`)).json();
check('fresh layout: wizard active', st.active === true);
check('fresh layout: no jdk detected', st.hasJdk === false);

let r = await fetch(`${base}/api/wizard/crafty-login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: ADMIN.username, password: 'wrong', url: `http://127.0.0.1:${CRAFTY_PORT}` }),
});
check('wrong password rejected with 401', r.status === 401);
check('no token written on failure', !existsSync(join(root, 'Shared', 'crafty-token.txt')));

// SSRF guard: the setup window must never aim the panel at a public host
r = await fetch(`${base}/api/wizard/crafty-login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ...ADMIN, url: 'http://example.com:8443' }),
});
check('public crafty url refused (SSRF guard)', r.status === 400);
r = await fetch(`${base}/api/wizard/crafty-login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ...ADMIN, url: 'file:///etc/passwd' }),
});
check('non-http scheme refused', r.status === 400);

// a Crafty address that answers with HTML (wrong port / web UI) must produce
// a readable error, not a raw parser crash
const htmlStub = createServer((_q, s) => { s.setHeader('content-type', 'text/html'); s.end('<html>login</html>'); });
await new Promise((res2) => htmlStub.listen(CRAFTY_PORT + 1, '127.0.0.1', res2));
r = await fetch(`${base}/api/wizard/crafty-login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ...ADMIN, url: `http://127.0.0.1:${CRAFTY_PORT + 1}` }),
});
const htmlErr = await r.json();
check('html response yields a readable error', r.status === 502 && /web page/.test(htmlErr.error ?? ''));
htmlStub.close();

r = await fetch(`${base}/api/wizard/crafty-login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ...ADMIN, url: `http://127.0.0.1:${CRAFTY_PORT}` }),
});
const login = await r.json();
check('crafty login succeeds', r.ok && login.ok === true);
check('reports server count from crafty', login.servers === 2);
const tokenFile = join(root, 'Shared', 'crafty-token.txt');
check('token file written', existsSync(tokenFile) && readFileSync(tokenFile, 'utf8').trim() === MINTED);
const saved = JSON.parse(readFileSync(join(root, 'Spawnpoint', 'data', 'settings.json'), 'utf8'));
check('custom crafty url persisted', saved.craftyUrl === `http://127.0.0.1:${CRAFTY_PORT}`);
const codeFile = join(root, 'Spawnpoint', 'data', 'setup-code.txt');
check('setup claim code cleared after setup', !existsSync(codeFile) || readFileSync(codeFile, 'utf8').trim() === '');

st = await (await fetch(`${base}/api/wizard/status`)).json();
check('wizard deactivates itself', st.active === false);

r = await fetch(`${base}/api/wizard/crafty-login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ...ADMIN, url: `http://127.0.0.1:${CRAFTY_PORT}` }),
});
check('mutating route refuses once configured (403)', r.status === 403);

// PIN step: setting a fresh PIN must hand back a VALID session cookie
r = await fetch(`${base}/api/settings`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ pin: '4321' }),
});
const setCookie = r.headers.get('set-cookie') ?? '';
check('setting a PIN issues a session cookie', /sp_auth=[a-f0-9]{64}/.test(setCookie));
const cookie = /sp_auth=[a-f0-9]{64}/.exec(setCookie)?.[0] ?? '';
const auth = await (await fetch(`${base}/api/auth/check`, { headers: { cookie } })).json();
check('that cookie validates', auth.required === true && auth.ok === true);
const noCookie = await (await fetch(`${base}/api/auth/check`)).json();
check('no cookie means locked', noCookie.ok === false);

done = true;
child.kill();
crafty.close();
if (fails.length) { console.error(`\n${fails.length} check(s) failed`); process.exit(1); }
console.log(`\nwizard E2E passed on ${process.platform}`);
