#!/usr/bin/env node
// Spawnpoint CLI: a thin client over the panel's HTTP API for people and
// coding agents. Plain text by default, --json for exact API data, no
// colour or prompts off a TTY, bounded output and documented exit codes.
// No dependencies, so it starts in tens of milliseconds.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, createReadStream, createWriteStream, chmodSync, openSync, writeSync, closeSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename, posix } from 'node:path';
import { pipeline } from 'node:stream/promises';

export const VERSION = '0.1.0';
export const EXIT = { ok: 0, fail: 1, usage: 2, auth: 3, notFound: 4, refused: 5, confirm: 6, unreachable: 7, timeout: 8 };

export class CliError extends Error {
  constructor(code, message, hint) { super(message); this.code = code; this.hint = hint; }
}
const usage = (msg, hint) => new CliError(EXIT.usage, msg, hint);
const confirm = (msg, hint) => new CliError(EXIT.confirm, msg, hint);

// ---- arguments --------------------------------------------------------------

const BOOL = new Set(['json', 'yes', 'wait', 'all', 'accept-gaps', 'follow', 'op', 'help', 'agent', 'details', 'updates', 'crash', 'skip-backup', 'confirm-approve', 'list', 'quiet']);
const SHORT = { s: 'server', n: 'lines', y: 'yes', j: 'json', f: 'follow', h: 'help', q: 'quiet' };

export function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    let key, val;
    if (/^--[a-z]/.test(a)) [key, val] = a.slice(2).split(/=(.*)/s);
    else if (/^-[a-z]$/.test(a) && SHORT[a[1]]) key = SHORT[a[1]];
    else { pos.push(a); continue; }
    if (key.startsWith('no-') && BOOL.has(key.slice(3))) { flags[key.slice(3)] = false; continue; }
    if (BOOL.has(key)) { flags[key] = val === undefined ? true : !/^(false|0|no|off)$/.test(val); continue; }
    if (val === undefined) {
      val = argv[++i];
      if (val === undefined) throw usage(`--${key} needs a value`);
    }
    flags[key] = val;
  }
  return { pos, flags };
}

/** "90s", "10m", "2h", "1d" or plain seconds. */
export function seconds(v, name = 'duration') {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/.exec(String(v).trim());
  if (!m) throw usage(`--${name} takes a duration like 90s, 10m or 2h`);
  return Math.round(Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] ?? 's']);
}
const int = (v, name, min = 0) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw usage(`--${name} takes a whole number${min ? ` of at least ${min}` : ''}`);
  return n;
};

/** Splits an MCP args string like a shell would (quotes, no expansion). */
export function words(s) {
  const out = [];
  let cur = '', q = null, any = false;
  for (const ch of String(s ?? '')) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; any = true; continue; }
    if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    cur += ch;
  }
  if (q) throw usage('unclosed quote in arguments');
  if (cur || any) out.push(cur);
  return out;
}

// ---- configuration and access -------------------------------------------------

const env = process.env;
export const configPath = () => env.SPAWNPOINT_CONFIG
  ?? (process.platform === 'win32'
    ? join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'spawnpoint', 'cli.json')
    : join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'spawnpoint', 'cli.json'));
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
const loadConfig = () => readJson(configPath()) ?? {};
function saveConfig(cfg) {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* Windows */ }
}

/** The layout root on this machine, for the local admin token and port. */
function layoutRoot(cfg) {
  if (env.SPAWNPOINT_ROOT) return env.SPAWNPOINT_ROOT;
  if (cfg.root) return cfg.root;
  const guesses = [join(homedir(), 'minecraft'), process.platform === 'win32' ? 'C:\\MinecraftServers' : '/srv/minecraft'];
  return guesses.find((g) => existsSync(join(g, 'Spawnpoint', 'data'))) ?? guesses[0];
}
const isLoopback = (url) => { try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname); } catch { return false; } };

/** URL and bearer token. A saved token only goes to the URL it was saved
    for, and the admin token never leaves this machine. */
export function access(flags, cfg = loadConfig()) {
  const root = layoutRoot(cfg);
  const port = readJson(join(root, 'Spawnpoint', 'data', 'settings.json'))?.port ?? 25570;
  const fallback = String(env.SPAWNPOINT_URL ?? cfg.url ?? `http://127.0.0.1:${port}`).replace(/\/+$/, '');
  const url = flags.url ? String(flags.url).replace(/\/+$/, '') : fallback;
  // SPAWNPOINT_TOKEN pairs with SPAWNPOINT_URL; --url elsewhere does not get it
  if (env.SPAWNPOINT_TOKEN && url === String(env.SPAWNPOINT_URL ?? fallback).replace(/\/+$/, '')) return { url, token: env.SPAWNPOINT_TOKEN.trim(), via: 'SPAWNPOINT_TOKEN' };
  if (cfg.token && cfg.url === url) return { url, token: cfg.token, via: 'saved token' };
  if (isLoopback(url)) {
    try { return { url, token: readFileSync(join(root, 'Spawnpoint', 'data', 'admin-token'), 'utf8').trim(), via: 'local admin token' }; } catch { /* not the panel machine, or no read access */ }
  }
  return { url, token: null, via: 'none' };
}

// ---- HTTP -------------------------------------------------------------------

let agents = null;
async function request(acc, method, path, { body, stream, timeout = 30_000, auth = true, raw = false } = {}) {
  const url = new URL(path, acc.url + '/');
  const mod = url.protocol === 'https:' ? await import('node:https') : await import('node:http');
  agents ??= {};
  const agent = (agents[url.protocol] ??= new mod.Agent({ keepAlive: true }));
  const headers = { accept: 'application/json', 'user-agent': `spawnpoint-cli/${VERSION}` };
  if (auth && acc.token) headers.authorization = `Bearer ${acc.token}`;
  let payload = null;
  if (body !== undefined) { payload = Buffer.from(JSON.stringify(body)); headers['content-type'] = 'application/json'; }
  if (stream) headers['content-type'] = 'application/octet-stream';
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method, headers, agent }, (res) => {
      if (raw && res.statusCode < 300) return resolve({ status: res.statusCode, res });
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(timeout, () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => reject(new CliError(e.code === 'ETIMEDOUT' ? EXIT.timeout : EXIT.unreachable,
      e.code === 'ETIMEDOUT' ? `the panel did not answer within ${Math.round(timeout / 1000)} s (${method} ${url.pathname})` : `cannot reach the panel at ${acc.url} (${e.code ?? e.message})`,
      e.code === 'ETIMEDOUT' ? 'it may still be working; check with `spawnpoint status`' : 'start the panel, or point at it with --url or SPAWNPOINT_URL')));
    if (stream) stream.pipe(req);
    else req.end(payload);
  });
}

export async function api(acc, method, path, body, opts = {}) {
  const r = await request(acc, method, path, { ...opts, body });
  if (opts.raw && r.res) return r.res;
  let j = null;
  try { j = r.text ? JSON.parse(r.text) : null; } catch { j = { error: r.text.slice(0, 300) }; }
  if (r.status < 300) return j;
  const why = j?.error ?? j?.message ?? `HTTP ${r.status}`;
  if (r.status === 401) {
    throw new CliError(EXIT.auth, acc.token ? `the panel refused this token (${why})` : `not signed in to ${acc.url}`,
      acc.token && acc.via === 'local admin token' ? 'the admin token file is stale; restart the panel or run `spawnpoint login`' : 'create a token in Panel settings → API tokens, then run `spawnpoint login`');
  }
  if (r.status === 403) throw new CliError(EXIT.auth, why, j?.hint);
  if (r.status === 404) throw new CliError(EXIT.notFound, why);
  if (r.status === 409) throw new CliError(EXIT.refused, why, j?.hint);
  if (r.status === 400) throw new CliError(EXIT.usage, why);
  throw new CliError(EXIT.fail, `${why} (HTTP ${r.status})`);
}

// ---- formatting ---------------------------------------------------------------

const clip = (s, n = 100) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
function ago(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 90 ? `${Math.round(s)}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
}
const mb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${Math.round(n)} MB`);
const bytes = (n) => (n >= 1 << 20 ? mb(n / (1 << 20)) : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const short = (id) => String(id).slice(0, 8);
const table = (rows) => {
  const w = [];
  for (const r of rows) r.forEach((c, i) => { w[i] = Math.max(w[i] ?? 0, String(c).length); });
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? String(c) : String(c).padEnd(w[i]))).join('  ').trimEnd());
};

/** One word for a server's state, from its stats. */
function stateOf(st) {
  if (st.maintenance) return st.maintenance.interrupted ? 'locked' : `busy:${st.maintenance.op}`;
  if (st.crashed) return 'crashed';
  if (!st.running) return 'stopped';
  return st.phase === 'ready' ? 'running' : 'starting';
}

const OPEN = ['collecting', 'testing', 'needs-approval', 'ready', 'activating'];
const FIRST_CONSENT = 'owner consent is required to manage revision-checked starts and publication';
/** Tests that did not pass. A missing verdict is a gap too, except a client
    test the revision report marks as not applicable (no AutoModpack). */
const gaps = (c, report) => {
  const noClient = (report?.tests?.client?.detail ?? '').startsWith('AutoModpack is not configured') && report.tests.client.result === 'skipped';
  return [['server', c.server], ['client', noClient ? { result: 'passed' } : c.client]]
    .filter(([, v]) => !v || v.result !== 'passed').map(([k, v]) => (v ? `${k} ${v.result}: ${clip(v.detail, 120)}` : `${k} not run`));
};
/** The report of the revision waiting for approval, for gaps(). */
const pendingReport = async (ctx, s, c) => (c?.status === 'needs-approval' && c.revision
  ? (await ctx.api('GET', `${sid(s)}/revisions/${encodeURIComponent(c.revision)}`).catch(() => null))?.report : undefined);
/** What `change approve` takes: the exact revision, or "guard" for the
    one-time launch-guard consent that comes before the first revision. */
const revOf = (c) => c.revision ?? (c.detail === FIRST_CONSENT ? 'guard' : null);
const titleOf = (f) => f.entry?.title ?? f.path ?? f.file;
function planSummary(c) {
  const s = c.solver;
  if (!s) return 'files staged as uploaded';
  if (s.status === 'ok') return 'feasible, fewest changes';
  if (s.status === 'conflict') return 'conflict: no pack satisfies every constraint';
  return s.tentative ? 'feasible, fewest changes not proved' : `inconclusive: ${clip(s.reason, 120)}`;
}
function promotionLine(p, server) {
  if (!p) return null;
  const what = p.action === 'undo' ? 'undo' : 'change';
  if (p.restarting) return `${what} going in: the server is restarting`;
  if (p.stopped) return `${what} goes in on the next start → spawnpoint start${server}`;
  if (p.choice) return `${what} waits for restart (${p.choice})`;
  if (p.unknown) return `${what} waits for restart; player count unknown → spawnpoint change restart now${server} --yes`;
  return `${what} waits for restart: ${p.players ?? 0} online → spawnpoint change restart now|when-empty${server}`;
}

// ---- context ----------------------------------------------------------------

function makeCtx(argv, io = {}) {
  const { pos, flags } = parseArgs(argv);
  const cfg = loadConfig();
  const ctx = {
    pos, flags, cfg, io,
    acc: access(flags, cfg),
    tty: io.tty ?? !!process.stdout.isTTY,
    api: (m, p, b, o) => api(ctx.acc, m, p, b, o),
    /** -s for the command hint, when the user chose a server explicitly */
    sflag: '',
    async server() {
      if (ctx._server) return ctx._server;
      const want = flags.server ?? env.SPAWNPOINT_SERVER ?? cfg.server;
      const { servers, active } = await ctx.api('GET', '/api/servers');
      if (!servers.length) throw new CliError(EXIT.notFound, 'there are no servers yet', 'create one: spawnpoint create --loader fabric --mc 1.21.1');
      let s;
      if (want) s = pick(servers, String(want));
      else if (servers.length === 1) s = servers[0];
      else s = servers.find((x) => x.id === active);
      if (!s) throw usage(`${servers.length} servers; say which with -s NAME (${servers.map((x) => x.name).join(', ')})`, 'or set a default: spawnpoint use NAME');
      if (flags.server) ctx.sflag = ` -s ${/\s/.test(s.name) ? short(s.id) : s.name}`;
      ctx._server = s;
      return s;
    },
    /** stdin, a file or --content, for commands that write text */
    async input(name = 'content') {
      if (flags[name] !== undefined) return String(flags[name]);
      if (flags.from) return readFileSync(flags.from, 'utf8');
      if (io.stdin === false || process.stdin.isTTY) throw usage(`pass the text with --${name} TEXT, --from FILE, or on stdin`);
      const chunks = [];
      for await (const c of process.stdin) chunks.push(c);
      return Buffer.concat(chunks).toString('utf8');
    },
  };
  return ctx;
}

function pick(servers, want) {
  const w = want.toLowerCase();
  const tiers = [
    (s) => s.id === want || s.name.toLowerCase() === w,
    (s) => w.length >= 4 && s.id.startsWith(w),
    (s) => s.name.toLowerCase().startsWith(w),
  ];
  for (const t of tiers) {
    const hit = servers.filter(t);
    if (hit.length === 1) return hit[0];
    if (hit.length > 1) throw usage(`"${want}" matches ${hit.map((s) => s.name).join(', ')}; use more of the name or the id`);
  }
  throw new CliError(EXIT.notFound, `no server called "${want}" (${servers.map((s) => s.name).join(', ')})`);
}

const sid = (s) => `/api/servers/${s.id}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until done(value) or the timeout, for --wait. */
async function until(fetch, done, timeoutS, what) {
  const end = Date.now() + timeoutS * 1000;
  for (;;) {
    const v = await fetch();
    if (done(v)) return v;
    if (Date.now() > end) throw new CliError(EXIT.timeout, `${what} after ${timeoutS} s`, 'run the same command again to keep waiting');
    await sleep(2500);
  }
}

async function onlinePlayers(ctx, s) {
  const live = await ctx.api('GET', `${sid(s)}/players/live`);
  return live.offline ? null : live;
}

// ---- commands -----------------------------------------------------------------
// Each command: group (MCP tool), usage, about, run(ctx) → { text, data }.

const commands = {};
const cmd = (name, group, usageLine, about, run) => { commands[name] = { name, group, usage: usageLine, about, run }; };

cmd('health', 'status', 'health', 'panel reachability, version and your access level', async (ctx) => {
  const h = await ctx.api('GET', '/api/health', undefined, { auth: false });
  const a = await ctx.api('GET', '/api/auth/check').catch(() => null);
  const scope = a?.ok ? a.scope : null;
  const data = { ...h, url: ctx.acc.url, scope, via: scope ? ctx.acc.via : null };
  return { data, text: `panel ok · spawnpoint ${h.version} · ${ctx.acc.url}\naccess ${scope ? `${scope} (${ctx.acc.via})` : 'none → spawnpoint login'}` };
});

cmd('status', 'status', 'status', 'every server: state, players, open mod change; start here', async (ctx) => {
  const [h, list] = await Promise.all([ctx.api('GET', '/api/health', undefined, { auth: false }), ctx.api('GET', '/api/servers')]);
  const def = ctx.flags.server ?? env.SPAWNPOINT_SERVER ?? ctx.cfg.server ?? list.active;
  const rows = await Promise.all(list.servers.map(async (s) => {
    const [stats, change] = await Promise.all([ctx.api('GET', `${sid(s)}/stats`).catch((e) => ({ error: e.message })), ctx.api('GET', `${sid(s)}/candidate`).catch(() => ({}))]);
    return { server: s, stats, change };
  }));
  const lines = [`spawnpoint ${h.version} · ${ctx.acc.url} · ${list.servers.length} server${list.servers.length === 1 ? '' : 's'}`];
  if (list.warning) lines.push(`warning: ${clip(list.warning, 160)}`);
  for (const { server: s, stats: st, change: ch } of rows) {
    const mark = def && (s.id === def || s.name === def || s.id.startsWith(def)) ? '*' : ' ';
    const head = `${mark} ${s.name}  ${st.error ? `unknown (${clip(st.error, 60)})` : stateOf(st)}`;
    const bits = [];
    if (st.running) {
      bits.push(`${st.online ?? 0}${st.max ? `/${st.max}` : ''} online`, `cpu ${Math.round(st.cpu ?? 0)}%`);
      // bytes when the runtime measures it, Crafty's own text otherwise
      if (st.mem) bits.push(`mem ${typeof st.mem === 'number' ? mb(st.mem / 2 ** 20) : st.mem}`);
    }
    bits.push(`${s.detection.loader} ${s.detection.mc ?? '?'}`, `:${s.port}`);
    lines.push(`${head}  ${bits.join(' · ')}`);
    const c = ch.candidate, flag = list.servers.length > 1 ? ` -s ${/\s/.test(s.name) ? short(s.id) : s.name}` : '';
    if (c && OPEN.includes(c.status)) lines.push(`    change ${c.status}: ${clip(c.detail, 90)} → spawnpoint change${flag}`);
    const p = promotionLine(ch.promotion, flag);
    if (p && c?.status !== 'needs-approval') lines.push(`    ${p}`);
    if (st.maintenance?.interrupted) lines.push(`    locked: ${st.maintenance.op} stopped part-way${st.maintenance.note ? ` (${clip(st.maintenance.note, 80)})` : ''} → check it, then spawnpoint unlock${flag} --yes`);
  }
  return { data: { version: h.version, url: ctx.acc.url, warning: list.warning, servers: rows }, text: lines.join('\n') };
});

cmd('servers', 'servers', 'servers', 'list servers with id, loader and port', async (ctx) => {
  const { servers, active } = await ctx.api('GET', '/api/servers');
  return { data: { servers, active }, text: servers.length ? table(servers.map((s) => [s.name, short(s.id), `${s.detection.loader} ${s.detection.mc ?? '?'}`, `:${s.port}`])).join('\n') : 'no servers yet → spawnpoint create --loader fabric --mc 1.21.1' };
});

cmd('use', 'servers', 'use SERVER', 'make SERVER the default for this CLI (stored locally)', async (ctx) => {
  const want = ctx.pos[0];
  if (!want) throw usage('which server? spawnpoint use NAME');
  ctx.flags.server = want;
  const s = await ctx.server();
  saveConfig({ ...loadConfig(), server: s.id });
  return { data: { server: s }, text: `default server: ${s.name} (${short(s.id)})` };
});

cmd('create', 'servers', 'create --loader L --mc V [--name N] [--mem GB] | --modpack ID [--version V] [--source curseforge] | --list [--loader L]',
  'create a server (waits until installed; --no-wait to return at once)', async (ctx) => {
    const f = ctx.flags;
    if (f.list) {
      if (!f.loader) {
        const { loaders } = await ctx.api('GET', '/api/loaders');
        return { data: { loaders }, text: `loaders: ${loaders.join(', ')}\nversions: spawnpoint create --list --loader fabric` };
      }
      const { versions } = await ctx.api('GET', `/api/loaders/versions?loader=${encodeURIComponent(f.loader)}`);
      return { data: { versions }, text: `${f.loader}: ${versions.slice(0, 15).join(', ')}${versions.length > 15 ? ` … ${versions.length - 15} more (--json)` : ''}` };
    }
    const memGb = f.mem === undefined ? undefined : int(f.mem, 'mem', 1);
    let job;
    if (f.modpack) job = await ctx.api('POST', '/api/servers/create-from-modpack', { projectId: f.modpack, versionId: f.version, source: f.source ?? 'modrinth', name: f.name, memGb }, { timeout: 120_000 });
    else {
      if (!f.loader || !f.mc) throw usage('say what to create: --loader fabric --mc 1.21.1 (see spawnpoint create --list)');
      job = await ctx.api('POST', '/api/servers/create', { loader: f.loader, mc: f.mc, name: f.name, memGb }, { timeout: 120_000 });
    }
    if (job.error) throw new CliError(EXIT.refused, job.error);
    const id = job.jobId ?? job.id;
    if (f.wait === false) return { data: job, text: `creating (job ${id}) → spawnpoint api GET /api/create-jobs/${id}` };
    const done = await until(() => ctx.api('GET', `/api/create-jobs/${id}`), (j) => j.done, seconds(f.timeout ?? '20m', 'timeout'), `server creation (job ${id}) is still running`);
    if (done.error) throw new CliError(EXIT.fail, `creation failed: ${done.error}`, 'the job stays stopped for inspection in the panel');
    const warn = done.warnings?.length ? `\nwarnings: ${done.warnings.map((w) => clip(w, 120)).join('; ')}` : '';
    return { data: done, text: `created ${done.packName ?? f.name ?? 'server'} (${short(done.serverId)}) · stopped → spawnpoint start -s ${short(done.serverId)}${warn}` };
  });

cmd('delete', 'servers', 'delete -s SERVER --yes [--skip-backup]', 'delete a stopped server (final world backup first); owner only', async (ctx) => {
  const s = await ctx.server();
  if (!ctx.flags.yes) throw confirm(`deleting ${s.name} removes the server folder for good`, `add --yes to delete it${ctx.flags['skip-backup'] ? '' : ' (a final world backup is kept)'}`);
  const r = await ctx.api('DELETE', sid(s), { confirmName: s.name, skipBackup: !!ctx.flags['skip-backup'] }, { timeout: 30 * 60_000 });
  return { data: r, text: `deleted ${s.name}` };
});

for (const action of ['start', 'stop', 'restart']) {
  cmd(action, 'power', `${action} [-s SERVER]${action === 'start' ? '' : ' [--yes]'} [--no-wait] [--timeout 5m]`,
    action === 'start' ? 'start; waits until joinable (a waiting mod change goes in first)' : `${action}; --yes when players are online`, async (ctx) => {
      const s = await ctx.server();
      if (action !== 'start') {
        const live = await onlinePlayers(ctx, s);
        if (live?.online && !ctx.flags.yes) throw confirm(`${live.online} player${live.online === 1 ? '' : 's'} online on ${s.name}: ${live.players.join(', ')}`, `warn them first (spawnpoint send say ...), then add --yes`);
      }
      const r = await ctx.api('POST', `${sid(s)}/action`, { action }, { timeout: 120_000 });
      const extra = [r.promoting && 'a waiting mod change goes in first', r.appliedPending && `${r.appliedPending} queued mod change(s) applied`].filter(Boolean).join('; ');
      if (ctx.flags.wait === false) return { data: r, text: `${action} sent to ${s.name}${extra ? ` (${extra})` : ''}` };
      const t0 = Date.now();
      const want = action === 'stop' ? (st) => !st.running : (st) => st.running && st.phase === 'ready' && !st.maintenance;
      await sleep(2000);
      // a crash flag only counts once this start had time to clear an old one
      const st = await until(() => ctx.api('GET', `${sid(s)}/stats`), (x) => want(x) || (action !== 'stop' && x.crashed && !x.running && Date.now() - t0 > 20_000), seconds(ctx.flags.timeout ?? (r.promoting ? '12m' : '5m'), 'timeout'), `${s.name} is not ${action === 'stop' ? 'stopped' : 'ready'} yet`);
      if (st.crashed) throw new CliError(EXIT.fail, `${s.name} crashed while starting`, `see why: spawnpoint logs${ctx.sflag} --lines 40 (or --crash)`);
      const sec = Math.round((Date.now() - t0) / 1000);
      return { data: { ...r, stats: st }, text: `${s.name} ${action === 'stop' ? 'stopped' : 'ready'} in ${sec}s${extra ? ` (${extra})` : ''}` };
    });
}

cmd('autostart', 'power', 'autostart [on|off] [-s SERVER]', 'show or set start-on-boot (Spawnpoint-owned servers)', async (ctx) => {
  const s = await ctx.server();
  const v = ctx.pos[0];
  if (v === undefined) {
    const r = await ctx.api('GET', `${sid(s)}/runtime`);
    return { data: r, text: `${s.name}: owner ${r.owner}${r.owner === 'standalone' ? ` · autostart ${r.autoStart ? 'on' : 'off'}` : ' (Crafty manages autostart)'}` };
  }
  if (!/^(on|off)$/.test(v)) throw usage('autostart on or autostart off');
  const r = await ctx.api('PUT', `${sid(s)}/runtime`, { autoStart: v === 'on' });
  return { data: r, text: `${s.name}: autostart ${v}` };
});

cmd('unlock', 'power', 'unlock [-s SERVER] --yes', 'clear the lock an interrupted operation left, after you checked the server', async (ctx) => {
  const s = await ctx.server();
  if (!ctx.flags.yes) throw confirm(`unlocking ${s.name} lets starts and changes run again`, 'check the server first (spawnpoint logs, spawnpoint change), then add --yes');
  const r = await ctx.api('POST', `${sid(s)}/maintenance/clear`);
  return { data: r, text: `${s.name} unlocked` };
});

/** Console or latest.log lines with --lines, --since and --grep applied. */
async function logLines(ctx, s, file) {
  const n = int(ctx.flags.lines ?? (file ? 60 : 40), 'lines', 1);
  const re = ctx.flags.grep ? new RegExp(ctx.flags.grep, 'i') : null;
  const q = new URLSearchParams({ tail: String(re ? (file ? 5000 : 1000) : n) });
  if (ctx.flags.since) q.set('since', String(seconds(ctx.flags.since, 'since')));
  if (file) q.set('file', 'latest');
  const { lines } = await ctx.api('GET', `${sid(s)}/logs?${q}`);
  return (re ? lines.filter((l) => re.test(l)) : lines).slice(-n);
}

cmd('console', 'console', 'console [-n 40] [--since 10m] [--grep RE] [--follow --timeout 2m]', 'live console tail; bounded by default', async (ctx) => {
  const s = await ctx.server();
  const lines = await logLines(ctx, s, false);
  if (!ctx.flags.follow) return { data: { lines }, text: lines.length ? lines.join('\n') : '(no console lines in range)' };
  if (ctx.io.mcp) throw usage('--follow is not available over MCP; use --since instead');
  const write = (l) => process.stdout.write(`${l}\n`);
  lines.forEach(write);
  let last = lines;
  const end = ctx.flags.timeout ? Date.now() + seconds(ctx.flags.timeout, 'timeout') * 1000 : Infinity;
  while (Date.now() < end) {
    await sleep(2000);
    const { lines: now } = await ctx.api('GET', `${sid(s)}/logs?tail=200`);
    const fresh = newLines(last, now);
    const re = ctx.flags.grep ? new RegExp(ctx.flags.grep, 'i') : null;
    fresh.filter((l) => !re || re.test(l)).forEach(write);
    if (fresh.length) last = now;
  }
  return { streamed: true };
});

/** Lines in `after` that came after the end of `before`. */
export function newLines(before, after) {
  if (!before.length) return after;
  const k = Math.min(3, before.length), tail = before.slice(-k).join('\n');
  for (let i = after.length - k; i >= 0; i--) if (after.slice(i, i + k).join('\n') === tail) return after.slice(i + k);
  return after;
}

cmd('send', 'console', 'send COMMAND... [-s SERVER] [--quiet]', 'run a console command; prints the reply and new console lines', async (ctx) => {
  const s = await ctx.server();
  const line = ctx.pos.join(' ').trim();
  if (!line) throw usage('what to send? e.g. spawnpoint send say hello');
  if (/^\/?stop\b/i.test(line)) throw usage('use spawnpoint stop, which checks for players and records the stop');
  const before = ctx.flags.quiet ? null : (await ctx.api('GET', `${sid(s)}/logs?tail=200`)).lines;
  const r = await ctx.api('POST', `${sid(s)}/command`, { cmd: line.replace(/^\//, '') });
  let fresh = [];
  if (before) {
    await sleep(1500);
    fresh = newLines(before, (await ctx.api('GET', `${sid(s)}/logs?tail=200`)).lines).slice(-20);
  }
  const text = [r.output && r.output.trim(), ...fresh].filter(Boolean).join('\n') || 'sent';
  return { data: { ...r, lines: fresh }, text };
});

cmd('logs', 'console', 'logs [-n 60] [--since 1h] [--grep RE] | --crash', 'logs/latest.log (whole boot), or the newest crash report', async (ctx) => {
  const s = await ctx.server();
  if (ctx.flags.crash) {
    const { entries } = await ctx.api('GET', `${sid(s)}/files?path=crash-reports`).catch(() => ({ entries: [] }));
    const newest = entries.filter((e) => !e.dir).sort((a, b) => b.mtime - a.mtime)[0];
    if (!newest) return { data: { crash: null }, text: 'no crash reports' };
    const r = await ctx.api('GET', `${sid(s)}/files/content?path=${encodeURIComponent(`crash-reports/${newest.name}`)}`);
    const n = int(ctx.flags.lines ?? 60, 'lines', 1);
    const lines = String(r.content ?? '').split(/\r?\n/);
    return { data: { file: newest.name, mtime: newest.mtime, content: r.content }, text: [`${newest.name} (${ago(new Date(newest.mtime).toISOString())})`, ...lines.slice(0, n), ...(lines.length > n ? [`… ${lines.length - n} more lines (--lines ${lines.length})`] : [])].join('\n') };
  }
  const lines = await logLines(ctx, s, true);
  return { data: { lines }, text: lines.length ? lines.join('\n') : '(no log lines in range)' };
});

cmd('players', 'players', 'players [add|remove NAME [--op] | kick|ban|op|deop|msg NAME [TEXT]] [--yes for ban]', 'who is online, the whitelist and ops; manage players', async (ctx) => {
  const s = await ctx.server();
  const [sub, name, ...rest] = ctx.pos;
  if (!sub) {
    const [live, { players }] = await Promise.all([onlinePlayers(ctx, s), ctx.api('GET', `${sid(s)}/players`)]);
    const known = players.map((p) => `${p.name}${p.op ? ' (op)' : ''}${p.whitelisted ? '' : ' (not whitelisted)'}`);
    return { data: { live, players }, text: `${live ? `online ${live.online}/${live.max}${live.players.length ? `: ${live.players.join(', ')}` : ''}` : 'online: unknown (server stopped or RCON silent)'}\nwhitelist/ops: ${known.join(', ') || 'none'}` };
  }
  if (!name || !/^[A-Za-z0-9_]{1,16}$/.test(name)) throw usage(`players ${sub} NAME (a Minecraft name)`);
  if (sub === 'add') {
    const r = await ctx.api('POST', `${sid(s)}/players`, { name, whitelist: true, op: !!ctx.flags.op });
    return { data: r, text: `${name} whitelisted${ctx.flags.op ? ' and op' : ''}` };
  }
  if (sub === 'remove') {
    const r = await ctx.api('DELETE', `${sid(s)}/players/${encodeURIComponent(name)}`);
    return { data: r, text: `${name} removed from whitelist and ops` };
  }
  if (!['kick', 'ban', 'op', 'deop', 'msg'].includes(sub)) throw usage('players add|remove|kick|ban|op|deop|msg NAME');
  if (sub === 'ban' && !ctx.flags.yes) throw confirm(`banning ${name} keeps them out until unbanned`, 'add --yes to ban');
  const r = await ctx.api('POST', `${sid(s)}/players/act`, { name, action: sub, arg: rest.join(' ') });
  return { data: r, text: clip(r.out, 200) || `${sub} ${name}: done` };
});

// -- mods

const PLUGIN_LOADERS = ['paper', 'spigot', 'bukkit', 'purpur', 'folia'];
const contentType = (s) => (PLUGIN_LOADERS.includes(s.detection.loader) ? 'plugin' : 'mod');
const tested = (s) => ['fabric', 'forge', 'neoforge'].includes(s.detection.loader);

async function installed(ctx, s) { return ctx.api('GET', `${sid(s)}/installed`, undefined, { timeout: 60_000 }); }
function findItem(items, want) {
  const w = want.toLowerCase();
  const hit = items.filter((i) => i.file.toLowerCase() === w || i.file.toLowerCase() === `${w}.jar` || (i.title ?? '').toLowerCase() === w || i.projectId === want);
  if (hit.length === 1) return hit[0];
  const loose = hit.length ? hit : items.filter((i) => i.file.toLowerCase().includes(w) || (i.title ?? '').toLowerCase().includes(w));
  if (loose.length === 1) return loose[0];
  if (!loose.length) throw new CliError(EXIT.notFound, `no installed mod matches "${want}"`, 'list them: spawnpoint mods');
  throw usage(`"${want}" matches ${loose.slice(0, 6).map((i) => i.file).join(', ')}; use the file name`);
}

/** What happened to the change after a staging call, in one line. */
function stagedText(r, flag) {
  const c = r.candidate;
  if (!c) return null;
  return c.status === 'collecting' ? `change collecting: tests start ~12 s after the last edit → spawnpoint change --wait${flag}` : `change ${c.status}: ${clip(c.detail, 100)} → spawnpoint change${flag}`;
}

cmd('mods', 'mods', 'mods [--updates]', 'installed mods (or plugins), the open change, available updates', async (ctx) => {
  const s = await ctx.server();
  const r = await installed(ctx, s);
  if (ctx.flags.updates) {
    const { updates } = await ctx.api('GET', `${sid(s)}/installed/updates`, undefined, { timeout: 120_000 });
    return { data: { updates }, text: updates.length ? [...updates.map((u) => `${u.title} ${u.from} → ${u.to}`), `→ spawnpoint mods update --all${ctx.sflag}, or mods update NAME`].join('\n') : 'everything is up to date' };
  }
  const items = r.items.filter((i) => !i.kind);
  const client = items.filter((i) => i.clientOnly).length;
  const lines = [`${items.length} ${contentType(s)}s on ${s.name} (${s.detection.loader} ${s.detection.mc ?? '?'}): ${items.length - client} server, ${client} client-only`];
  for (const i of items) lines.push(`${i.title ?? i.file} ${i.versionNumber ?? ''}${i.clientOnly ? ' [client]' : ''}${i.enabled ? '' : ' [disabled]'}${i.pending ? ` [${i.pending} queued]` : ''}${i.via === 'dependency' ? ' (dep)' : ''}`.replace(/\s+\[/g, ' [').replace(/ +$/, ''));
  const c = r.candidate;
  if (c && OPEN.includes(c.status)) lines.push(`change ${c.status}: ${clip(c.detail, 90)} → spawnpoint change${ctx.sflag}`);
  if (r.rejections?.length) lines.push(`rejected recently: ${r.rejections.slice(0, 3).map((x) => clip(x.reason ?? x.detail ?? JSON.stringify(x), 80)).join('; ')}`);
  return { data: r, text: lines.join('\n') };
});

cmd('mods search', 'mods', 'mods search QUERY [-n 8] [--source curseforge] [--type mod|plugin|datapack|resourcepack|shader|modpack]', 'search Modrinth (or CurseForge) for this server\'s version', async (ctx) => {
  const s = await ctx.server();
  const q = ctx.pos.join(' ');
  if (!q) throw usage('mods search QUERY');
  const n = int(ctx.flags.lines ?? 8, 'lines', 1);
  const params = new URLSearchParams({ q, type: ctx.flags.type ?? contentType(s) });
  if (s.detection.mc) params.set('mc', s.detection.mc);
  if (s.detection.loader !== 'unknown' && !['datapack', 'resourcepack', 'shader'].includes(ctx.flags.type)) params.set('loader', s.detection.loader);
  if (ctx.flags.source) params.set('source', ctx.flags.source);
  const r = await ctx.api('GET', `/api/content/search?${params}`, undefined, { timeout: 60_000 });
  const hits = r.hits.slice(0, n);
  const k = (d) => (d >= 1e6 ? `${(d / 1e6).toFixed(1)}M` : d >= 1e3 ? `${Math.round(d / 1e3)}k` : String(d));
  return { data: { ...r, hits }, text: hits.length ? [...hits.map((h) => `${ctx.flags.source === 'curseforge' ? h.project_id : h.slug} · ${h.title} · ${k(h.downloads)} · ${clip(h.description, 70)}`), `→ spawnpoint mods add ${ctx.flags.source === 'curseforge' ? 'ID --source curseforge' : 'SLUG'}${ctx.sflag}`].join('\n') : `nothing found for "${q}" on ${s.detection.loader} ${s.detection.mc}` };
});

cmd('mods add', 'mods', 'mods add PROJECT[@VERSION]... [--source curseforge] [--type T]', 'stage mods into the tested change (Modrinth slug or id; CurseForge id)', async (ctx) => {
  const s = await ctx.server();
  if (!ctx.pos.length) throw usage('mods add SLUG (find one with spawnpoint mods search)');
  const out = [], results = [];
  for (const spec of ctx.pos) {
    const [project, version] = spec.split('@');
    const body = { projectId: project, versionId: version, type: ctx.flags.type ?? contentType(s), source: ctx.flags.source };
    if (ctx.flags.source !== 'curseforge') {
      const p = await ctx.api('GET', `/api/content/project/${encodeURIComponent(project)}`, undefined, { timeout: 60_000 }).catch((e) => {
        throw e.code === EXIT.notFound || e.code === EXIT.fail ? new CliError(EXIT.notFound, `Modrinth has no project "${project}" (${clip(e.message, 80)})`, 'find it: spawnpoint mods search NAME') : e;
      });
      body.projectId = p.id;
      if (version) {
        const q = new URLSearchParams(s.detection.mc ? { mc: s.detection.mc, loader: s.detection.loader } : {});
        const { versions } = await ctx.api('GET', `/api/content/project/${encodeURIComponent(p.id)}/versions?${q}`, undefined, { timeout: 60_000 });
        const v = versions.find((x) => x.id === version || x.version_number === version);
        if (!v) throw new CliError(EXIT.notFound, `${p.title} has no version "${version}" for ${s.detection.loader} ${s.detection.mc}`, `pick one of: ${versions.slice(0, 6).map((x) => x.version_number).join(', ')}`);
        body.versionId = v.id;
      }
    }
    const r = await ctx.api('POST', `${sid(s)}/install`, body, { timeout: 10 * 60_000 });
    results.push(r);
    if (r.error) throw new CliError(EXIT.refused, clip(r.error, 400), r.manualDownloads?.length ? `download by hand: ${r.manualDownloads.map((m) => m.url).join(' ')}` : undefined);
    const deps = r.installed.length - 1;
    out.push(r.installed.length ? `staged ${r.installed[0].title} ${r.installed[0].version}${deps > 0 ? ` (+${deps} more: ${r.installed.slice(1, 5).map((i) => i.title).join(', ')}${deps > 4 ? ', …' : ''})` : ''}` : `nothing new staged for ${spec}${r.skipped?.length ? `: ${clip(r.skipped.map((x) => x.reason).join('; '), 120)}` : ''}`);
    for (const w of r.warnings ?? []) out.push(`warning: ${clip(w, 140)}`);
    if (r.untested) out.push(`went live without a test: ${clip(r.untested, 120)}`);
  }
  const last = stagedText(results.at(-1), ctx.sflag);
  if (last) out.push(last);
  return { data: results.length === 1 ? results[0] : results, text: out.join('\n') };
});

cmd('mods remove', 'mods', 'mods remove MOD [--yes on untested loaders]', 'stage removing a mod (refused while another mod needs it)', async (ctx) => {
  const s = await ctx.server();
  if (!ctx.pos[0]) throw usage('mods remove NAME|FILE');
  const item = findItem((await installed(ctx, s)).items, ctx.pos.join(' '));
  if (!tested(s) && !ctx.flags.yes) throw confirm(`${s.detection.loader} changes are not tested first: ${item.file} is deleted from the live server`, 'add --yes to delete it');
  const r = await ctx.api('DELETE', `${sid(s)}/installed?file=${encodeURIComponent(item.file)}`);
  return { data: r, text: [`removing ${item.title ?? item.file}`, stagedText(r, ctx.sflag) ?? (r.pending ? 'queued: applies when the server stops' : 'removed')].join('\n') };
});

for (const [verb, want] of [['enable', true], ['disable', false]]) {
  cmd(`mods ${verb}`, 'mods', `mods ${verb} MOD`, `${verb} an installed mod (staged and tested on locked servers)`, async (ctx) => {
    const s = await ctx.server();
    if (!ctx.pos[0]) throw usage(`mods ${verb} NAME|FILE`);
    const item = findItem((await installed(ctx, s)).items, ctx.pos.join(' '));
    if (item.enabled === want) return { data: { item }, text: `${item.title ?? item.file} is already ${verb}d` };
    const r = await ctx.api('POST', `${sid(s)}/installed/toggle`, { file: item.file });
    return { data: r, text: [`${verb === 'enable' ? 'enabling' : 'disabling'} ${item.title ?? item.file}`, stagedText(r, ctx.sflag) ?? (r.pending ? 'queued: applies when the server stops' : 'done')].join('\n') };
  });
}

cmd('mods update', 'mods', 'mods update [MOD | --all]', 'list updates, or stage one or all of them into the change', async (ctx) => {
  const s = await ctx.server();
  if (ctx.flags.all) {
    const r = await ctx.api('POST', `${sid(s)}/installed/update-all`, undefined, { timeout: 15 * 60_000 });
    return { data: r, text: [r.updated.length ? `staged ${r.updated.length} update(s): ${r.updated.join('; ')}` : 'nothing to update', ...r.warnings.map((w) => `warning: ${clip(w, 140)}`), stagedText(r, ctx.sflag)].filter(Boolean).join('\n') };
  }
  const { updates } = await ctx.api('GET', `${sid(s)}/installed/updates`, undefined, { timeout: 120_000 });
  if (!ctx.pos[0]) return { data: { updates }, text: updates.length ? [...updates.map((u) => `${u.title} ${u.from} → ${u.to}`), `→ spawnpoint mods update NAME${ctx.sflag} (or --all)`].join('\n') : 'everything is up to date' };
  const w = ctx.pos.join(' ').toLowerCase();
  const u = updates.find((x) => x.file.toLowerCase() === w || x.title.toLowerCase() === w) ?? updates.find((x) => x.title.toLowerCase().includes(w));
  if (!u) throw new CliError(EXIT.notFound, `no update available for "${ctx.pos.join(' ')}"`, 'see spawnpoint mods --updates');
  const r = await ctx.api('POST', `${sid(s)}/install`, { projectId: u.projectId, versionId: u.versionId, type: contentType(s), source: u.source }, { timeout: 10 * 60_000 });
  if (r.error) throw new CliError(EXIT.refused, clip(r.error, 400));
  return { data: r, text: [`staged ${u.title} ${u.from} → ${u.to}`, stagedText(r, ctx.sflag)].filter(Boolean).join('\n') };
});

// -- the change flow

function changeText(c, p, ctx, details, report) {
  const f = ctx.sflag;
  if (!c || !OPEN.includes(c.status)) {
    const lines = [c ? `no open change (last: ${c.status}, ${clip(c.detail, 100)})` : 'no open change'];
    const pl = promotionLine(p, f);
    if (pl) lines.push(pl);
    if (p?.action === 'undo' && !p.restarting) lines.push(`cancel it: spawnpoint change cancel-undo${f}`);
    return lines.join('\n');
  }
  const asked = c.files.filter((x) => x.entry?.via !== 'dependency' && !x.path);
  const count = { add: 0, replace: 0, remove: 0, config: 0 };
  for (const x of c.files) count[x.path ? 'config' : x.remove ? 'remove' : x.replaces ? 'replace' : 'add']++;
  const v = (k, x) => (x ? `${k} ${x.result}${x.seconds ? ` ${x.seconds}s` : ''}${x.skipped ? ' (join skipped: Linux with xvfb only)' : x.result === 'passed' ? '' : `: ${clip(x.detail, 100)}`}` : `${k} ${c.status === 'testing' ? 'running' : c.detail === FIRST_CONSENT ? 'runs after approval' : 'not run'}`);
  const lines = [
    `status   ${c.status}: ${clip(c.detail, 140)}`,
    c.revision && `revision ${c.revision}`,
    `asked    ${(asked.length ? asked : c.files).slice(0, 8).map((x) => `${titleOf(x)}${x.entry?.versionNumber ? ` ${x.entry.versionNumber.replace(/\+.*$/, '')}` : ''}`).join(', ')}${asked.length > 8 ? ', …' : ''}`,
    `plan     ${planSummary(c)} · ${Object.entries(count).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ') || 'no file changes'}`,
    `tests    ${v('server', c.server)} · ${v('client', c.client)}`,
  ];
  if (c.repairs?.length) lines.push(`repairs  ${c.repairs.map((r) => `${r.kind}: ${clip(r.detail, 80)}`).join('; ')}`);
  if (c.java) lines.push(`java     tested with ${c.java}`);
  if (c.consent?.length) lines.push(c.status === 'needs-approval' ? 'approving:' : 'approved:', ...c.consent.map((x) => `  - ${clip(x, 600)}`));
  if (details) {
    lines.push('files:', ...c.files.map((x) => `  ${x.path ? 'config' : x.remove ? 'remove' : x.replaces ? 'replace' : 'add'} ${x.path ?? x.file}${x.replaces ? ` (replaces ${x.replaces})` : ''}${x.to === 'shelf' ? ' [client]' : ''}${x.entry?.via === 'dependency' ? ' (dep)' : ''}`));
    const ex = c.client?.excerpt?.length ? c.client.excerpt : c.server?.excerpt ?? [];
    if (ex.length) lines.push('loader said:', ...ex.slice(0, 12).map((l) => `  ${clip(l, 200)}`));
    if (c.solver?.status === 'conflict') lines.push('conflict:', ...c.solver.explanation.map((e) => `  ${clip(e, 200)}`));
  } else if (c.files.length) lines.push(`(files and loader lines: spawnpoint change --details${f})`);
  if (c.status === 'needs-approval') {
    const g = c.detail === FIRST_CONSENT ? [] : gaps(c, report);
    lines.push(`next     spawnpoint change approve ${revOf(c) ?? '(retest first)'}${g.length ? ' --accept-gaps' : ''}${f} · change retest · change discard`);
  } else if (c.status === 'collecting' || c.status === 'testing') lines.push(`next     spawnpoint change --wait${f}`);
  const pl = promotionLine(p, f);
  if (pl) lines.push(`restart  ${pl}`);
  return lines.filter(Boolean).join('\n');
}

cmd('change', 'change', 'change [--wait --timeout 10m] [--details]', 'the open mod change: plan, test results, what approval covers', async (ctx) => {
  const s = await ctx.server();
  const get = () => ctx.api('GET', `${sid(s)}/candidate`);
  const r = ctx.flags.wait
    ? await until(get, (x) => !['collecting', 'testing', 'activating'].includes(x.candidate?.status) && !x.promotion?.restarting, seconds(ctx.flags.timeout ?? '10m', 'timeout'), 'the change is still being tested')
    : await get();
  return { data: r, text: changeText(r.candidate, r.promotion, ctx, ctx.flags.details, await pendingReport(ctx, s, r.candidate)) };
});

cmd('change approve', 'change', 'change approve REVISION|guard [--accept-gaps]', 'approve exactly the revision you reviewed (guard: the one-time launch guard); counts as the owner\'s consent', async (ctx) => {
  const s = await ctx.server();
  const rev = ctx.pos[0];
  if (!rev) throw usage('change approve REVISION (the revision line of spawnpoint change)');
  const { candidate: c } = await ctx.api('GET', `${sid(s)}/candidate`);
  if (!c || c.status !== 'needs-approval') throw new CliError(EXIT.refused, `nothing waits for approval (${c ? c.status : 'no change'})`, `see spawnpoint change${ctx.sflag}`);
  if (revOf(c) !== rev) throw new CliError(EXIT.refused, `the change is now revision ${revOf(c) ?? '(none: test it again)'}, not ${rev}`, `review it again: spawnpoint change${ctx.sflag}`);
  const g = c.detail === FIRST_CONSENT ? [] : gaps(c, await pendingReport(ctx, s, c));
  if (g.length && !ctx.flags['accept-gaps']) throw confirm(`not fully tested: ${g.join('; ')}`, 'approve anyway with --accept-gaps (hash checks cannot be waived), or change retest / change discard');
  const r = await ctx.api('POST', `${sid(s)}/candidate/apply`, { consent: true, revision: c.revision }, { timeout: 5 * 60_000 });
  const after = await ctx.api('GET', `${sid(s)}/candidate`);
  return { data: r, text: `approved ${rev}\n${changeText(after.candidate, after.promotion, ctx, false)}` };
});

cmd('change discard', 'change', 'change discard', 'drop the open change; live files never changed', async (ctx) => {
  const s = await ctx.server();
  const r = await ctx.api('DELETE', `${sid(s)}/candidate`);
  return { data: r, text: 'change discarded' };
});

cmd('change retest', 'change', 'change retest', 'test the open change again (after fixing what blocked a test)', async (ctx) => {
  const s = await ctx.server();
  const r = await ctx.api('POST', `${sid(s)}/candidate/retest`);
  return { data: r, text: `testing again → spawnpoint change --wait${ctx.sflag}` };
});

cmd('change restart', 'change', 'change restart now|when-empty [--yes]', 'when a waiting change restarts the server; now warns and counts down 30 s', async (ctx) => {
  const s = await ctx.server();
  const choice = ctx.pos[0];
  if (choice !== 'now' && choice !== 'when-empty') throw usage('change restart now or change restart when-empty');
  if (choice === 'now' && !ctx.flags.yes) {
    const live = await onlinePlayers(ctx, s);
    if (!live || live.online) throw confirm(live ? `${live.online} player(s) online: ${live.players.join(', ')}` : 'the player count is unknown', 'they get a 30 s countdown; add --yes to restart now, or use when-empty');
  }
  const r = await ctx.api('POST', `${sid(s)}/promotion`, { choice });
  return { data: r, text: promotionLine(r.promotion, ctx.sflag) ?? 'nothing waits for a restart' };
});

cmd('change undo', 'change', 'change undo --yes', 'put back the files the last change replaced (the world is not touched)', async (ctx) => {
  const s = await ctx.server();
  const { change: m } = await ctx.api('GET', `${sid(s)}/last-change`);
  if (!m) throw new CliError(EXIT.refused, 'there is no mod change to undo');
  const what = `${m.added?.length ?? 0} file(s) leave, ${m.replaced?.length ?? 0} come back (change ${m.txn})`;
  if (!ctx.flags.yes) throw confirm(`undo: ${what}`, 'add --yes to undo the last change');
  const r = await ctx.api('POST', `${sid(s)}/last-change/undo`, undefined, { timeout: 5 * 60_000 });
  return { data: r, text: r.waiting ? `undo waiting: ${promotionLine(r.promotion, ctx.sflag)}` : `undone: ${what}` };
});

cmd('change cancel-undo', 'change', 'change cancel-undo', 'cancel an undo that waits for a restart', async (ctx) => {
  const s = await ctx.server();
  const r = await ctx.api('DELETE', `${sid(s)}/promotion`);
  return { data: r, text: 'undo cancelled' };
});

const testsLine = (tests = {}) => {
  const ran = Object.entries(tests).filter(([, v]) => v.result !== 'skipped');
  const bad = ran.filter(([, v]) => v.result !== 'passed');
  return !ran.length ? 'no tests recorded' : bad.length ? bad.map(([k, v]) => `${k} ${v.result}`).join(', ') : `all ${ran.length} passed`;
};

cmd('change history', 'change', 'change history [-n 5]', 'locked revisions, newest first, with test results and approvals', async (ctx) => {
  const s = await ctx.server();
  const r = await ctx.api('GET', `${sid(s)}/revisions`);
  const n = int(ctx.flags.lines ?? 5, 'lines', 1);
  const rows = r.revisions.slice(0, n).map((v) => `${v.id}${v.id === r.active ? ' [active]' : ''}${v.id === r.published ? ' [published]' : ''} · ${v.files} files · ${testsLine(v.tests)}${v.approved ? ` · approved${v.approved.by ? ` via ${v.approved.by}` : ''}` : ''}`);
  return { data: r, text: rows.length ? [...rows, ...(r.revisions.length > n ? [`… ${r.revisions.length - n} older (-n ${r.revisions.length})`] : [])].join('\n') : 'no locked revisions yet' };
});

cmd('change show', 'change', 'change show REVISION', 'one revision: versions, Java, every test result, approval', async (ctx) => {
  const s = await ctx.server();
  if (!ctx.pos[0]) throw usage('change show REVISION (ids from spawnpoint change history)');
  const r = await ctx.api('GET', `${sid(s)}/revisions/${encodeURIComponent(ctx.pos[0])}`);
  const { lock, report } = r;
  const where = {};
  for (const x of lock.files) where[x.location] = (where[x.location] ?? 0) + 1;
  const lines = [
    `${ctx.pos[0]} · minecraft ${lock.minecraft} · ${lock.loader} ${lock.loaderVersion} · java ${lock.java?.executable ?? '?'}`,
    `files ${lock.files.length} (${Object.entries(where).map(([k, n]) => `${n} ${k}`).join(', ')}) · requested ${lock.requested.length} · dependencies ${lock.dependencies.length}`,
    ...Object.entries(report?.tests ?? {}).map(([k, v]) => `${k.padEnd(12)} ${v.result}${v.renderer && v.renderer !== 'none' ? ` (${v.renderer})` : ''}: ${clip(v.detail, 140)}`),
  ];
  if (report?.approved) lines.push(`approved ${ago(report.approved.at)}${report.approved.by ? ` via ${report.approved.by}` : ''}: ${report.approved.reasons.map((x) => clip(x, 100)).join('; ')}`);
  if (report?.backup) lines.push(`backup ${report.backup}`);
  return { data: r, text: lines.join('\n') };
});

// -- backups and worlds

cmd('backups', 'backups', 'backups [create | restore FILE --yes | delete FILE --yes]', 'world backups; restore replaces the live world', async (ctx) => {
  const s = await ctx.server();
  const [sub, file] = ctx.pos;
  if (!sub) {
    const { backups } = await ctx.api('GET', `${sid(s)}/backups`);
    return { data: { backups }, text: backups.length ? table(backups.map((b) => [b.file, mb(b.sizeMb), ago(b.createdAt), b.slot ? `slot ${b.slot} (not restorable here)` : ''])).join('\n') : 'no backups yet → spawnpoint backups create' };
  }
  if (sub === 'create') {
    const r = await ctx.api('POST', `${sid(s)}/backups`, undefined, { timeout: 60 * 60_000 });
    if (r.error) throw new CliError(EXIT.refused, r.error);
    return { data: r, text: `backed up: ${r.file} (${mb(r.sizeMb)})` };
  }
  if (!file) throw usage(`backups ${sub} FILE (names from spawnpoint backups)`);
  if (sub === 'restore') {
    if (!ctx.flags.yes) throw confirm(`restoring ${file} replaces ${s.name}'s live world`, 'add --yes to restore it (the current world is kept as a safety copy)');
    const r = await ctx.api('POST', `${sid(s)}/backups/restore`, { file }, { timeout: 60 * 60_000 });
    if (r.ok === false) throw new CliError(EXIT.refused, r.error ?? 'restore refused');
    return { data: r, text: `world restored from ${file}` };
  }
  if (sub === 'delete') {
    if (!ctx.flags.yes) throw confirm(`deleting ${file} cannot be undone`, 'add --yes to delete it');
    const r = await ctx.api('DELETE', `${sid(s)}/backups?file=${encodeURIComponent(file)}`);
    return { data: r, text: `deleted ${file}` };
  }
  throw usage('backups, backups create, backups restore FILE --yes, backups delete FILE --yes');
});

// -- server.properties, memory, mod configs

const KEY_PROPS = ['motd', 'server-port', 'max-players', 'gamemode', 'difficulty', 'hardcore', 'pvp', 'white-list', 'online-mode', 'view-distance', 'simulation-distance', 'spawn-protection', 'level-name', 'level-seed'];

cmd('config', 'config', 'config [KEY...] [--all] | config set KEY=VALUE... | config memory [GB] | config files | config read PATH | config write PATH', 'server.properties, heap and mod configs', async (ctx) => {
  const s = await ctx.server();
  const [sub, ...rest] = ctx.pos;
  if (sub === 'set') {
    if (!rest.length) throw usage('config set KEY=VALUE ...');
    const patch = {};
    for (const kv of rest) {
      const m = /^([\w.-]+)=(.*)$/s.exec(kv);
      if (!m) throw usage(`"${kv}" is not KEY=VALUE`);
      patch[m[1]] = m[2];
    }
    const r = await ctx.api('PATCH', `${sid(s)}/properties`, patch);
    return { data: r, text: `set ${Object.keys(patch).join(', ')} · applies on restart → spawnpoint restart${ctx.sflag}` };
  }
  if (sub === 'memory') {
    if (!rest[0]) {
      const r = await ctx.api('GET', `${sid(s)}/jvm`);
      return { data: r, text: `heap ${r.minGb ?? '?'}–${r.maxGb ?? '?'} GB (from ${r.source})` };
    }
    const r = await ctx.api('PUT', `${sid(s)}/jvm`, { gb: int(rest[0], 'memory', 1) });
    return { data: r, text: `heap set to ${rest[0]} GB · applies on restart → spawnpoint restart${ctx.sflag}` };
  }
  if (sub === 'files') {
    const { files } = await ctx.api('GET', `${sid(s)}/configs`);
    return { data: { files }, text: files.length ? files.map((x) => `${x.path} (${x.sizeKb} KB)`).join('\n') : 'no mod configs' };
  }
  if (sub === 'read') {
    if (!rest[0]) throw usage('config read PATH (from config files)');
    const r = await ctx.api('GET', `${sid(s)}/configs/file?path=${encodeURIComponent(rest[0])}`);
    if (r.tooBig) throw new CliError(EXIT.refused, `${rest[0]} is too large to show`, 'use spawnpoint files get');
    return { data: r, text: r.content.replace(/\r?\n$/, '') };
  }
  if (sub === 'write') {
    if (!rest[0]) throw usage('config write PATH (text on stdin, --content or --from)');
    const r = await ctx.api('PUT', `${sid(s)}/configs/file`, { path: rest[0], content: await ctx.input() });
    return { data: r, text: r.staged ? `staged ${rest[0]} into the change → spawnpoint change --wait${ctx.sflag}` : `wrote ${rest[0]}${r.backup ? ` (old copy ${r.backup})` : ''}` };
  }
  const { properties: p, restartRequired } = await ctx.api('GET', `${sid(s)}/properties`);
  const keys = ctx.pos.length ? ctx.pos : ctx.flags.all ? Object.keys(p).sort() : KEY_PROPS.filter((k) => k in p);
  const lines = keys.map((k) => `${k}=${p[k] ?? '(unset)'}`);
  if (!ctx.pos.length && !ctx.flags.all) lines.push(`(${Object.keys(p).length - keys.length} more: --all)`);
  if (restartRequired) lines.push(`restart pending to apply edits → spawnpoint restart${ctx.sflag}`);
  return { data: { properties: ctx.pos.length ? Object.fromEntries(keys.map((k) => [k, p[k] ?? null])) : p, restartRequired }, text: lines.join('\n') };
});

// -- files

cmd('files', 'files', 'files [ls PATH | cat PATH | find TEXT | put PATH | get PATH [--out F] | mv FROM TO | mkdir PATH | rm PATH --yes]', 'the server folder (confined to it); jars put in mods/ join the change', async (ctx) => {
  const s = await ctx.server();
  let [sub, a, b] = ctx.pos;
  if (!sub || !['ls', 'cat', 'find', 'put', 'get', 'mv', 'mkdir', 'rm'].includes(sub)) { a = sub; sub = 'ls'; }
  const enc = encodeURIComponent;
  if (sub === 'ls') {
    const { entries } = await ctx.api('GET', `${sid(s)}/files?path=${enc(a ?? '')}`);
    const n = int(ctx.flags.lines ?? 100, 'lines', 1);
    return { data: { entries }, text: [...entries.slice(0, n).map((e) => (e.dir ? `${e.name}/` : `${e.name}  ${bytes(e.size)}`)), ...(entries.length > n ? [`… ${entries.length - n} more (-n ${entries.length})`] : [])].join('\n') || '(empty)' };
  }
  if (!a) throw usage(`files ${sub} PATH`);
  if (sub === 'find') {
    const { results } = await ctx.api('GET', `${sid(s)}/files/search?q=${enc(a)}`);
    return { data: { results }, text: results.map((x) => (x.dir ? `${x.path}/` : x.path)).join('\n') || 'no matches' };
  }
  if (sub === 'cat') {
    const r = await ctx.api('GET', `${sid(s)}/files/content?path=${enc(a)}`);
    if (r.binary || r.tooLarge) throw new CliError(EXIT.refused, `${a} is ${r.binary ? 'binary' : 'over 2 MB'} (${bytes(r.size)})`, `download it: spawnpoint files get ${a}`);
    const n = int(ctx.flags.lines ?? 200, 'lines', 1);
    const lines = r.content.split(/\r?\n/);
    return { data: r, text: lines.length > n ? [...lines.slice(0, n), `… ${lines.length - n} more lines (-n ${lines.length})`].join('\n') : r.content.replace(/\r?\n$/, '') };
  }
  if (sub === 'put') {
    const norm = a.replace(/\\/g, '/'), dir = posix.dirname(norm), name = posix.basename(norm);
    const stream = ctx.flags.from ? createReadStream(ctx.flags.from) : Buffer.from(await ctx.input());
    const { Readable } = await import('node:stream');
    const r = await api(ctx.acc, 'POST', `${sid(s)}/files/upload-stream?path=${enc(dir === '.' ? '' : dir)}&filename=${enc(name)}`, undefined, { stream: Buffer.isBuffer(stream) ? Readable.from([stream]) : stream, timeout: 30 * 60_000 });
    return { data: r, text: r.candidate ? `${name} joined the change → spawnpoint change --wait${ctx.sflag}` : `wrote ${a}` };
  }
  if (sub === 'get') {
    const out = ctx.flags.out ?? basename(a);
    if (ctx.io.mcp && !ctx.flags.out) throw usage('pass --out PATH for downloads over MCP');
    if (existsSync(out) && !ctx.flags.yes) throw confirm(`${out} exists`, 'add --yes to overwrite it, or choose --out');
    const res = await api(ctx.acc, 'GET', `${sid(s)}/files/download?path=${enc(a)}`, undefined, { raw: true, timeout: 30 * 60_000 });
    await pipeline(res, createWriteStream(out));
    return { data: { path: out, size: statSync(out).size }, text: `saved ${out} (${bytes(statSync(out).size)})` };
  }
  if (sub === 'mv') {
    if (!b) throw usage('files mv FROM TO');
    return { data: await ctx.api('POST', `${sid(s)}/files/rename`, { from: a, to: b }), text: `moved ${a} → ${b}` };
  }
  if (sub === 'mkdir') return { data: await ctx.api('POST', `${sid(s)}/files/mkdir`, { path: a }), text: `created ${a}/` };
  if (!ctx.flags.yes) throw confirm(`deleting ${a} (and everything under it) cannot be undone`, 'add --yes to delete it; worlds are managed by backups and the Worlds tab');
  return { data: await ctx.api('POST', `${sid(s)}/files/delete`, { path: a }), text: `deleted ${a}` };
});

// -- genie

cmd('genie', 'genie', 'genie [on|off | players A,B | policy no-admin|full | server on|off | wish TEXT [--player P]]', 'the in-game chat genie\'s settings; credential lives in Panel settings', async (ctx) => {
  const [sub, ...rest] = ctx.pos;
  const put = (body) => ctx.api('PUT', '/api/chatgenie', body);
  let g;
  if (!sub) g = await ctx.api('GET', '/api/chatgenie');
  else if (sub === 'on' || sub === 'off') g = await put({ enabled: sub === 'on' });
  else if (sub === 'players') g = await put({ players: rest.join(',').split(',').map((x) => x.trim()).filter(Boolean) });
  else if (sub === 'policy') {
    if (!['no-admin', 'full'].includes(rest[0])) throw usage('genie policy no-admin|full');
    g = await put({ commandPolicy: rest[0] });
  } else if (sub === 'server') {
    if (!/^(on|off)$/.test(rest[0] ?? '')) throw usage('genie server on|off [-s SERVER]');
    const s = await ctx.server();
    g = await put({ servers: { [s.id]: rest[0] === 'on' } });
  } else if (sub === 'wish') {
    const s = await ctx.server();
    if (!rest.length) throw usage('genie wish TEXT');
    await ctx.api('POST', '/api/chatgenie/testwish', { serverId: s.id, player: ctx.flags.player, wish: rest.join(' ') });
    return { data: { ok: true }, text: `wish queued on ${s.name} → spawnpoint console${ctx.sflag} --since 1m` };
  } else throw usage('genie, genie on|off, genie players A,B, genie policy no-admin|full, genie server on|off, genie wish TEXT');
  const [{ servers }, busy, sum] = await Promise.all([ctx.api('GET', '/api/servers'), ctx.api('GET', '/api/chatgenie/busy'), ctx.api('GET', '/api/settings/summary').catch(() => null)]);
  const on = servers.filter((x) => g.servers?.[x.id]).map((x) => x.name);
  return { data: { ...g, busy, credential: sum?.anthropicKeySet ?? null }, text: `genie ${g.enabled ? 'on' : 'off'} · policy ${g.commandPolicy ?? 'no-admin'} · credential ${sum ? (sum.anthropicKeySet ? 'set' : 'missing (Panel settings)') : 'unknown'}\nplayers: ${g.players.join(', ') || 'none'}\nservers: ${on.join(', ') || 'none'}${busy.busy ? `\nbusy: ${busy.running} running, ${busy.queued} queued` : ''}` };
});

// -- tokens and sign-in

cmd('token', 'admin', 'token [list | create NAME --scope read|control|approve [--confirm-approve] [--out FILE] | revoke ID]', 'scoped API tokens (owner only); a token is shown once', async (ctx) => {
  const [sub = 'list', arg] = ctx.pos;
  if (sub === 'list') {
    const { tokens } = await ctx.api('GET', '/api/tokens');
    return { data: { tokens }, text: tokens.length ? table(tokens.map((t) => [t.id, t.scope, t.name, `created ${ago(t.created)}`, t.lastUsed ? `used ${ago(t.lastUsed)}` : 'never used'])).join('\n') : 'no API tokens → spawnpoint token create NAME --scope read' };
  }
  if (sub === 'revoke') {
    if (!arg) throw usage('token revoke ID (from token list)');
    await ctx.api('DELETE', `/api/tokens/${encodeURIComponent(arg)}`);
    return { data: { ok: true }, text: `revoked ${arg}` };
  }
  if (sub !== 'create') throw usage('token list, token create NAME --scope S, token revoke ID');
  if (!arg || !ctx.flags.scope) throw usage('token create NAME --scope read|control|approve');
  if (!ctx.flags.out && (!ctx.tty || ctx.io.mcp)) throw usage('refusing to print a token into a pipe or agent log', 'pass --out FILE (written owner-only), or run this in a terminal');
  if (ctx.flags.scope === 'approve' && !ctx.flags['confirm-approve']) throw confirm('an approve token can approve mod changes, undo them and restore worlds as you', 'add --confirm-approve if that is what you want');
  // a new private file, never an existing one or a link, before anything is minted
  let fd = null;
  if (ctx.flags.out) {
    try { fd = openSync(ctx.flags.out, 'wx', 0o600); } catch (e) { throw usage(`cannot create ${ctx.flags.out} (${e.code}); choose a new file`); }
  }
  let r;
  try { r = await ctx.api('POST', '/api/tokens', { name: arg, scope: ctx.flags.scope, confirmApprove: !!ctx.flags['confirm-approve'] }); } catch (e) {
    if (fd !== null) { closeSync(fd); rmSync(ctx.flags.out, { force: true }); }
    throw e;
  }
  if (fd !== null) {
    writeSync(fd, `${r.token}\n`);
    closeSync(fd);
    return { data: r.info, text: `token ${r.info.id} (${r.info.scope}) saved to ${ctx.flags.out}; on the other machine: spawnpoint login --url URL --token-file ${basename(ctx.flags.out)}` };
  }
  return { data: r.info, text: `token ${r.info.id} (${r.info.scope}), shown once:\n${r.token}` };
});

cmd('login', 'admin', 'login [--url URL] [--token-file FILE]', 'save a panel URL and API token for this machine (token from stdin or a file)', async (ctx) => {
  let token;
  if (ctx.flags['token-file']) token = readFileSync(ctx.flags['token-file'], 'utf8');
  else if (!process.stdin.isTTY) { const c = []; for await (const x of process.stdin) c.push(x); token = Buffer.concat(c).toString('utf8'); }
  else token = await hiddenPrompt('API token (from Panel settings → API tokens): ');
  token = token.trim();
  if (!token) throw usage('no token given');
  const acc = { url: ctx.acc.url, token, via: 'login' };
  const a = await api(acc, 'GET', '/api/auth/check');
  if (!a?.ok) throw new CliError(EXIT.auth, `the panel at ${acc.url} refused this token`, 'check it was not revoked, and that --url points at the right panel');
  saveConfig({ ...loadConfig(), url: acc.url, token });
  return { data: { url: acc.url, scope: a.scope }, text: `signed in to ${acc.url} · scope ${a.scope} · saved in ${configPath()}` };
});

cmd('logout', 'admin', 'logout', 'forget the saved token', async () => {
  const cfg = loadConfig();
  delete cfg.token;
  saveConfig(cfg);
  return { data: { ok: true }, text: 'saved token removed (revoke it in Panel settings if it may have leaked)' };
});

async function hiddenPrompt(q) {
  process.stderr.write(q);
  process.stdin.setRawMode?.(true);
  let s = '';
  for await (const chunk of process.stdin) {
    for (const ch of chunk.toString('utf8')) {
      if (ch === '\r' || ch === '\n') { process.stdin.setRawMode?.(false); process.stderr.write('\n'); process.stdin.pause(); return s; }
      if (ch === '\u0003') process.exit(130);
      s = ch === '\u007f' ? s.slice(0, -1) : s + ch;
    }
  }
  return s;
}

cmd('api', 'api', 'api METHOD PATH [JSON | -]', 'raw panel API for anything without a command (scopes still apply)', async (ctx) => {
  const [method, path, json] = ctx.pos;
  if (!method || !path?.startsWith('/api/')) throw usage('api GET /api/servers, or api POST /api/... \'{"key":"value"}\'');
  // judge the path the request will actually use: dot segments resolved, escapes decoded
  let plain = new URL(path, 'http://x/').pathname;
  try { plain = decodeURIComponent(plain); } catch { /* leave as resolved */ }
  plain = new URL(plain.replace(/\\/g, '/'), 'http://x/').pathname.replace(/\/{2,}/g, '/');
  if (/^\/api\/tokens(\/|$)/i.test(plain) && method.toUpperCase() !== 'GET') throw usage('tokens are managed with spawnpoint token, which never prints a token into a pipe');
  const body = json === undefined ? undefined : JSON.parse(json === '-' ? await ctx.input() : json);
  const r = await ctx.api(method.toUpperCase(), path, body, { timeout: 10 * 60_000 });
  return { data: r, text: JSON.stringify(r) };
});

// ---- help -------------------------------------------------------------------

const GROUPS = { status: 'Overview', servers: 'Servers', power: 'Power', console: 'Console and logs', players: 'Players', mods: 'Mods', change: 'Mod changes (tested before they go live)', backups: 'Backups and world restore', config: 'Settings', files: 'Files', genie: 'Chat genie', admin: 'Access and setup', api: 'Anything else' };

/** `rulesOnly` drops the command list, for MCP where each tool lists its own. */
export function helpText(agent, rulesOnly = false) {
  const lines = [];
  if (agent) {
    lines.push(
      `spawnpoint ${VERSION}: control Minecraft servers through the Spawnpoint panel. Read once.`,
      'Output: short plain text, summary first. Add --json for the exact API data. Never interactive.',
      'Server: -s NAME|ID-PREFIX, or SPAWNPOINT_SERVER, or `spawnpoint use NAME`; with one server it is implied.',
      'Exit: 0 ok · 1 failed · 2 bad usage · 3 auth/scope · 4 not found · 5 refused or busy (read the message) · 6 needs --yes or --accept-gaps · 7 panel unreachable · 8 timed out (rerun to keep waiting).',
      'Errors print "error: ..." and "next: ..." on stderr. Do what next: says; do not retry blindly.',
      'Safety: --yes is the owner\'s explicit go-ahead for stopping with players online, ban, world restore, file deletion and undo. Ask the owner before passing --yes or --accept-gaps unless they already said so.',
      'Mod changes never touch the live server until tested: mods add → change --wait → change approve REVISION (only if the owner wants it) → the panel restarts the server when it is safe.',
      'Approve-scope tokens are needed for change approve, change undo and backups restore; they act as the owner.',
      'Bound output with --lines N and --since 10m; avoid --follow.',
      '',
    );
  } else lines.push(`spawnpoint ${VERSION}: run your Minecraft servers from a terminal or a coding agent.`, '');
  if (rulesOnly) return lines.join('\n').trim();
  for (const [group, title] of Object.entries(GROUPS)) {
    lines.push(agent ? `# ${title}` : `${title}:`);
    for (const c of Object.values(commands).filter((x) => x.group === group)) lines.push(agent ? `${c.usage} — ${c.about}` : `  spawnpoint ${c.usage}\n      ${c.about}`);
  }
  if (agent) {
    lines.push('', 'Typical: status → mods search sodium → mods add sodium → change --wait → (owner ok) change approve R → status.',
      'Debug a crash: status → logs --since 30m --grep "ERROR|Exception" → logs --crash.');
  } else {
    lines.push('', 'Global: --json  -s SERVER  --url URL  --lines N  --since 10m  --yes', 'Agents: spawnpoint help --agent · MCP server: spawnpoint mcp', 'Env: SPAWNPOINT_URL, SPAWNPOINT_TOKEN, SPAWNPOINT_SERVER, SPAWNPOINT_ROOT, SPAWNPOINT_CONFIG');
  }
  return lines.join('\n');
}

cmd('help', 'admin', 'help [COMMAND] [--agent]', 'this help; --agent prints a compact guide for coding agents', async (ctx) => {
  const name = ctx.pos.join(' ');
  if (name) {
    const hits = Object.values(commands).filter((c) => c.name === name || c.name.startsWith(`${name} `));
    if (!hits.length) throw usage(`no command "${name}"`, 'spawnpoint help');
    return { data: hits.map(({ name: n, usage: u, about }) => ({ name: n, usage: u, about })), text: hits.map((c) => `spawnpoint ${c.usage}\n  ${c.about}`).join('\n') };
  }
  return { data: Object.values(commands).map(({ name: n, group, usage: u, about }) => ({ name: n, group, usage: u, about })), text: helpText(!!ctx.flags.agent) };
});

cmd('mcp', 'admin', 'mcp [--url URL] [-s SERVER]', 'run as an MCP server over stdio (one tool per command group)', async (ctx) => {
  const { serve } = await import('./mcp.mjs');
  // every tool call uses the panel and default server chosen at launch
  const base = [...(ctx.flags.url ? ['--url', ctx.flags.url] : []), ...(ctx.flags.server ? ['-s', ctx.flags.server] : [])];
  await serve({ commands, GROUPS, VERSION, helpText, run: (argv, io) => run([...base, ...argv], io), words, baseUrl: !!ctx.flags.url });
  return { streamed: true };
});

// ---- entry ----------------------------------------------------------------------

/** Resolves argv to a command: two words first ("mods add"), then one. */
export function resolve(argv) {
  // indexes of positional words, skipping flag values the way parseArgs does
  const at = [];
  for (let i = 0; i < argv.length && at.length < 2; i++) {
    const a = argv[i];
    if (a === '--') break;
    const key = /^--[a-z]/.test(a) ? a.slice(2) : /^-[a-z]$/.test(a) ? SHORT[a[1]] ?? null : null;
    if (key === null) { at.push(i); continue; }
    if (!key.includes('=') && !BOOL.has(key) && !(key.startsWith('no-') && BOOL.has(key.slice(3)))) i++;
  }
  const without = (...idx) => argv.filter((_, i) => !idx.includes(i));
  const [a, b] = at.map((i) => argv[i]);
  if (at.length === 2 && commands[`${a} ${b}`]) return { command: commands[`${a} ${b}`], rest: without(...at) };
  if (a && commands[a]) return { command: commands[a], rest: without(at[0]) };
  return { command: null, rest: argv };
}

/** Runs one invocation; returns { code, stdout, stderr } without exiting. */
export async function run(argv, io = {}) {
  try {
    if (!argv.length || argv[0] === '--help' || argv[0] === '-h') argv = ['help', ...argv.slice(1)];
    if (argv[0] === '--version' || argv[0] === '-v') return { code: 0, stdout: VERSION };
    const { command, rest } = resolve(argv);
    if (!command) throw usage(`unknown command "${argv.find((a) => !a.startsWith('-')) ?? argv[0]}"`, 'spawnpoint help (agents: spawnpoint help --agent)');
    if (rest.includes('--help') || rest.includes('-h')) return run(['help', ...command.name.split(' ')], io);
    if (io.mcp && command.group === 'admin' && !['help'].includes(command.name)) throw usage(`${command.name} is not available over MCP`);
    if (io.mcp && rest.filter((a) => /^--url(=|$)/.test(a)).length > (io.baseUrl ? 1 : 0)) throw usage('the panel URL is fixed when the MCP server starts');
    const ctx = makeCtx(rest, io);
    const r = await command.run(ctx);
    if (r.streamed) return { code: 0, stdout: '' };
    const pretty = ctx.tty && !io.mcp;
    return { code: 0, stdout: ctx.flags.json ? JSON.stringify(r.data, null, pretty ? 2 : 0) : r.text };
  } catch (e) {
    if (e instanceof CliError) return { code: e.code, stderr: `error: ${e.message}${e.hint ? `\nnext: ${e.hint}` : ''}` };
    if (e instanceof SyntaxError) return { code: EXIT.usage, stderr: `error: ${e.message}` };
    return { code: EXIT.fail, stderr: `error: ${e?.message ?? e}` };
  } finally {
    if (!io.keepAlive) for (const a of Object.values(agents ?? {})) a.destroy();
    agents = io.keepAlive ? agents : null;
  }
}

export { commands, GROUPS };

// run as a program (directly, through an npm shim or a symlink), not when imported
if (/^spawnpoint(\.mjs)?$/.test(basename(process.argv[1] ?? ''))) {
  const r = await run(process.argv.slice(2));
  if (r.stdout) process.stdout.write(`${r.stdout}\n`);
  if (r.stderr) process.stderr.write(`${r.stderr}\n`);
  process.exitCode = r.code;
}
