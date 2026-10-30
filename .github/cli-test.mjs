// CLI contract: the `spawnpoint` client against a stub panel. Exit codes,
// plain output off a TTY, risky actions refused without --yes before any
// write reaches the panel, exact-revision approval, token handling, and the
// MCP tool surface. Runs the real CLI as a child process on every OS.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'cli', 'spawnpoint.mjs');
const ID = '0b7f4c1e-2d3a-4b5c-8d9e-0123456789ab';
const REV = '2026-10-30T12-00-00-000Z-42';
const ADMIN = 'admin-token-for-tests';
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}${ok || !extra ? '' : `\n    ${String(extra).replace(/\n/g, '\n    ')}`}`);
  if (!ok) fails.push(name);
};

// ---- stub panel: just enough state to drive the change flow ---------------
const state = { online: ['Steve'], writes: [], seenAuth: [], candidate: null };
const candidate = (over = {}) => ({
  txn: 't1', status: 'needs-approval', detail: 'the client test could not run', revision: REV,
  files: [{ file: 'ferritecore-7.0.2.jar', to: 'mods', replaces: 'ferritecore-7.0.3.jar', entry: { title: 'FerriteCore', versionNumber: '7.0.2', via: 'direct' } }],
  server: { result: 'passed', detail: 'booted', seconds: 31 },
  client: { result: 'unverified', detail: 'no display' },
  consent: ['replaces FerriteCore 7.0.3 with 7.0.2'], updatedAt: new Date().toISOString(), ...over,
});
const routes = {
  'GET /api/health': () => ({ ok: true, name: 'spawnpoint', version: '0.1.0' }),
  'GET /api/auth/check': (req) => ({ ok: !!req.headers.authorization, scope: req.headers.authorization ? 'admin' : null }),
  'GET /api/servers': () => ({ servers: [{ id: ID, name: 'Survival', port: 25565, detection: { loader: 'fabric', mc: '1.21.1' } }], active: null }),
  [`GET /api/servers/${ID}/stats`]: () => ({ running: true, phase: 'ready', online: state.online.length, max: 20, cpu: 12, mem: 2.1e9, maintenance: null, server_id: { huge: 'x'.repeat(2000) } }),
  [`GET /api/servers/${ID}/players/live`]: () => ({ online: state.online.length, max: 20, players: state.online }),
  [`GET /api/servers/${ID}/candidate`]: () => ({ candidate: state.candidate, promotion: null }),
  [`POST /api/servers/${ID}/candidate/apply`]: (_req, body) => { state.candidate = candidate({ status: 'ready', detail: 'passed; waits for a restart', consent: undefined }); return { candidate: state.candidate, body }; },
  [`GET /api/servers/${ID}/revisions/${REV}`]: () => ({ lock: {}, report: { tests: state.report ?? {} } }),
  [`POST /api/servers/${ID}/action`]: () => ({ ok: true }),
  [`GET /api/servers/${ID}/logs`]: () => ({ lines: ['[10:00:00] [Server thread/INFO]: Done (3.1s)!'] }),
  [`POST /api/servers/${ID}/files/delete`]: () => ({ ok: true }),
  [`POST /api/servers/${ID}/backups/restore`]: () => ({ ok: true }),
  'POST /api/tokens': () => ({ token: 'spt_deadbeef_SECRETSECRETSECRETSECRETSECRETSE', info: { id: 'deadbeef', name: 'x', scope: 'read' } }),
  'GET /api/chatgenie': () => { const e = new Error('scope'); e.status = 403; throw e; },
};
const panel = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    const path = req.url.split('?')[0];
    const key = `${req.method} ${path}`;
    state.seenAuth.push(req.headers.authorization ?? '');
    if (req.method !== 'GET') state.writes.push(key);
    res.setHeader('content-type', 'application/json');
    if (!req.headers.authorization && !['/api/health', '/api/auth/check'].includes(path)) { res.statusCode = 401; return res.end('{"error":"PIN required"}'); }
    const h = routes[key];
    if (!h) { res.statusCode = 404; return res.end(JSON.stringify({ error: `no stub for ${key}` })); }
    try { res.end(JSON.stringify(h(req, raw ? JSON.parse(raw) : undefined))); } catch (e) {
      res.statusCode = e.status ?? 500;
      res.end(JSON.stringify({ error: 'this API token has read scope; control is needed', hint: 'create a token with control scope in Panel settings' }));
    }
  });
});
await new Promise((r) => panel.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${panel.address().port}`;

// a layout with an admin token, as on the panel machine
const home = mkdtempSync(join(tmpdir(), 'spawnpoint-cli-'));
const root = join(home, 'layout');
mkdirSync(join(root, 'Spawnpoint', 'data'), { recursive: true });
writeFileSync(join(root, 'Spawnpoint', 'data', 'admin-token'), ADMIN);
const baseEnv = { ...process.env, SPAWNPOINT_ROOT: root, SPAWNPOINT_CONFIG: join(home, 'cli.json'), SPAWNPOINT_URL: url, FORCE_COLOR: '1' };
delete baseEnv.SPAWNPOINT_TOKEN;
delete baseEnv.SPAWNPOINT_SERVER;

const cli = (args, { env = {}, input } = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, ...args], { env: { ...baseEnv, ...env } });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => resolve({ code, out, err }));
  p.stdin.end(input ?? '');
});
const writesDuring = async (args, opts) => {
  const before = state.writes.length;
  const r = await cli(args, opts);
  return { ...r, writes: state.writes.slice(before) };
};

// ---- output -----------------------------------------------------------------
let r = await cli(['status']);
check('status is compact plain text with no ANSI off a TTY', r.code === 0 && !r.out.includes('\u001b[') && r.out.split('\n').length <= 4 && /Survival\s+running\s+1\/20 online/.test(r.out), r.out + r.err);
check('status leaves out raw API noise', !r.out.includes('xxxx') && r.out.length < 200, r.out);
r = await cli(['status', '--json']);
check('--json is exact data', r.code === 0 && JSON.parse(r.out).servers[0].stats.server_id.huge.length === 2000);
check('the local admin token is used on loopback', state.seenAuth.includes(`Bearer ${ADMIN}`));

// ---- risky actions need --yes, and nothing is written without it ------------
r = await writesDuring(['stop']);
check('stop with players online exits 6 and writes nothing', r.code === 6 && r.writes.length === 0 && /Steve/.test(r.err) && /next: /.test(r.err), r.err);
r = await writesDuring(['stop', '--yes', '--no-wait']);
check('stop --yes goes through', r.code === 0 && r.writes.includes(`POST /api/servers/${ID}/action`), r.err);
r = await writesDuring(['files', 'rm', 'config/x.toml']);
check('deleting a file needs --yes', r.code === 6 && r.writes.length === 0);
r = await writesDuring(['backups', 'restore', 'world-1.zip']);
check('world restore needs --yes', r.code === 6 && r.writes.length === 0);
r = await writesDuring(['send', 'stop']);
check('send refuses stop (use the stop command)', r.code === 2 && r.writes.length === 0);

// ---- the change flow: exact revision, and test gaps need --accept-gaps -------
state.candidate = candidate();
r = await cli(['change']);
check('change shows the plan, tests, consent and the exact next command', r.code === 0
  && /client unverified: no display/.test(r.out) && /replaces FerriteCore/.test(r.out) && r.out.includes(`change approve ${REV} --accept-gaps`), r.out);
r = await writesDuring(['change', 'approve', '2026-10-30T11-00-00-000Z-41', '--accept-gaps']);
check('approving a different revision is refused before any write', r.code === 5 && r.writes.length === 0 && r.err.includes(REV), r.err);
r = await writesDuring(['change', 'approve', REV]);
check('approving untested gaps without --accept-gaps exits 6', r.code === 6 && r.writes.length === 0 && /client unverified/.test(r.err), r.err);
r = await writesDuring(['change', 'approve', REV, '--accept-gaps']);
check('approve sends consent for exactly that revision', r.code === 0 && r.writes.length === 1 && /status\s+ready/.test(r.out), r.out + r.err);

state.candidate = candidate({ server: undefined, client: undefined, detail: 'the sandbox could not be set up' });
r = await writesDuring(['change', 'approve', REV]);
check('a missing test verdict also needs --accept-gaps', r.code === 6 && r.writes.length === 0 && /server not run/.test(r.err), r.err);

state.candidate = candidate({ client: undefined, detail: 'approve the listed replacements' });
state.report = { client: { result: 'skipped', detail: 'AutoModpack is not configured; friend synchronization was not tested' } };
r = await writesDuring(['change', 'approve', REV]);
check('a client test that does not apply (no AutoModpack) is not a gap', r.code === 0 && r.writes.length === 1, r.err);
state.report = undefined;

// ---- access ------------------------------------------------------------------
r = await cli(['genie']);
check('a scope refusal exits 3 and says which scope', r.code === 3 && /control is needed/.test(r.err) && /next: create a token/.test(r.err), r.err);
r = await cli(['status'], { env: { SPAWNPOINT_ROOT: join(home, 'nowhere') } });
check('no token exits 3 and points at login', r.code === 3 && /spawnpoint login/.test(r.err), r.err);
r = await cli(['status', '--url', url.replace('127.0.0.1', 'localhost.invalid')]);
check('an unreachable panel exits 7', r.code === 7 && /cannot reach/.test(r.err), r.err);
r = await writesDuring(['token', 'create', 'agent', '--scope', 'read']);
check('a new token is never printed into a pipe', r.code === 2 && r.writes.length === 0 && !r.out.includes('spt_'));
r = await cli(['token', 'create', 'agent', '--scope', 'read', '--out', join(home, 'tok')]);
check('token create --out writes the token to a file, not stdout', r.code === 0 && !r.out.includes('SECRET') && readFileSync(join(home, 'tok'), 'utf8').includes('SECRET'));

r = await writesDuring(['token', 'create', 'agent', '--scope', 'read', '--out', join(home, 'tok')]);
check('token create never overwrites an existing file', r.code === 2 && r.writes.length === 0);
r = await writesDuring(['api', 'POST', '/api/%74okens', '{"name":"x","scope":"read"}']);
check('the raw api command cannot mint tokens', r.code === 2 && r.writes.length === 0);
for (const path of ['/api/./tokens', '/api/x/../tokens', '//api//tokens', '/api/%2e/tokens', '/API/Tokens']) {
  r = await writesDuring(['api', 'POST', path, '{"name":"x","scope":"read"}']);
  check(`the raw api command cannot mint tokens via ${path}`, r.code === 2 && r.writes.length === 0, r.err);
}

// a saved token is sent only to the panel it was saved for
r = await cli(['login', '--token-file', join(home, 'tok')]);
check('login saves the URL and token', r.code === 0 && JSON.parse(readFileSync(join(home, 'cli.json'), 'utf8')).url === url, r.err);
check('login does not echo the token', !r.out.includes('SECRET') && !r.err.includes('SECRET'));
const { access } = await import(`file://${CLI.replace(/\\/g, '/')}`);
const cfg = { url, token: 'saved' };
check('the saved token goes only to its own URL', access({}, cfg).token === 'saved' && access({ url: 'http://other.example:25570' }, cfg).token !== 'saved');
process.env.SPAWNPOINT_TOKEN = 'from-env';
process.env.SPAWNPOINT_URL = url;
check('SPAWNPOINT_TOKEN goes only to SPAWNPOINT_URL', access({}, {}).token === 'from-env' && access({ url: 'http://other.example:25570' }, {}).token !== 'from-env');
delete process.env.SPAWNPOINT_TOKEN;
delete process.env.SPAWNPOINT_URL;
check('the admin token never goes to a remote URL', access({ url: 'http://192.0.2.1:25570' }, { root }).token === null && access({ url }, { root }).token === ADMIN);

// ---- agent guide and MCP -----------------------------------------------------
r = await cli(['help', '--agent']);
check('help --agent is a compact guide', r.code === 0 && /Exit: 0 ok/.test(r.out) && r.out.length < 9000 && r.out.includes('change approve'), `${r.out.length} chars`);
// launched with --url, every call goes to that panel, and a call cannot change it
const mcp = spawn(process.execPath, [CLI, 'mcp', '--url', url], { env: { ...baseEnv, SPAWNPOINT_URL: 'http://127.0.0.1:9', SPAWNPOINT_CONFIG: join(home, 'none.json') } });
const replies = [];
let buf = '';
mcp.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { replies.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
const rpc = async (id, method, params) => {
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  const end = Date.now() + 15_000;
  while (Date.now() < end) { const hit = replies.find((x) => x.id === id); if (hit) return hit; await new Promise((res) => setTimeout(res, 50)); }
  return null;
};
const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
check('mcp initialize answers with instructions', init?.result?.serverInfo?.name === 'spawnpoint' && /Exit: 0 ok/.test(init.result.instructions));
mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
const list = await rpc(2, 'tools/list', {});
const names = list?.result?.tools?.map((t) => t.name) ?? [];
check('mcp exposes one tool per command group, no admin tools', ['status', 'power', 'mods', 'change', 'files'].every((n) => names.includes(n)) && !names.includes('admin'), names.join(','));
const call = await rpc(3, 'tools/call', { name: 'status', arguments: {} });
check('mcp status runs the CLI command', call?.result?.isError === false && /Survival/.test(call.result.content[0].text), JSON.stringify(call));
const before = state.writes.length;
const risky = await rpc(4, 'tools/call', { name: 'power', arguments: { args: 'stop' } });
check('mcp keeps the --yes rule', risky?.result?.isError === true && /exit 6/.test(risky.result.content[0].text) && state.writes.length === before);
const moved = await rpc(5, 'tools/call', { name: 'status', arguments: { args: 'status --url http://evil.example' } });
check('mcp refuses a per-call --url', moved?.result?.isError === true && /fixed/.test(moved.result.content[0].text));
mcp.kill();

panel.close();
check('no stray config was written', !existsSync(join(home, 'none.json')));
if (fails.length) { console.error(`\n${fails.length} check(s) failed`); process.exit(1); }
console.log(`\nCLI contract passed on ${process.platform}`);
