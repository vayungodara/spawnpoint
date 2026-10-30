import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS, loadSettings, saveSettings } from '../config.js';
import { claudePath, credentialEnv, dropTo, genieDir, resetGenieWarm, spawnClaude } from './chatgenie.js';
import { KILLABLE_SPAWN_OPTS, killTree, IS_WIN } from './platform.js';

// The genie's model credential, from the owner's side: what kind it is, whether
// it works right now, and a one-click way to connect a Claude subscription.
// Secrets never leave settings.json (0600): status, logs and API replies only
// carry the kind, a state and a human sentence.

export type CredentialKind = 'subscription' | 'api-key' | 'local-login' | 'none';
export type CredentialState = 'connected' | 'expired' | 'invalid' | 'rate-limited' | 'unavailable' | 'untested';
export interface CredentialStatus {
  kind: CredentialKind;
  state: CredentialState;
  detail: string;
  checkedAt: string | null;
  /** when a subscription token was connected through the panel (they last a year) */
  connectedAt: string | null;
  /** subscription usage windows, as Claude Code last reported them */
  usage: { window: string; percent: number; resetsAt: string }[] | null;
}

/** Claude Code's rate_limit_event payload (subscriptions report usage windows). */
export interface RateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }>;
}

const STATUS_FILE = join(PATHS.data, 'genie-credential.json');

export function credentialKind(): CredentialKind {
  const key = loadSettings().anthropicApiKey;
  if (key) return key.startsWith('sk-ant-oat') ? 'subscription' : 'api-key';
  return credentialEnv() ? 'local-login' : 'none';
}

interface Stored { state: CredentialState; detail: string; checkedAt: string; connectedAt?: string | null; kind?: CredentialKind; usage?: CredentialStatus['usage'] }
function loadStored(): Stored | null {
  try { return JSON.parse(readFileSync(STATUS_FILE, 'utf8')) as Stored; } catch { return null; }
}

export function credentialStatus(): CredentialStatus {
  const kind = credentialKind();
  const s = loadStored();
  // a status recorded for a different credential (replaced or removed since) says nothing
  const fresh = s && s.kind === kind ? s : null;
  if (kind === 'none') {
    return { kind, state: 'untested', detail: 'Not connected. The genie stays off until you connect an AI account.', checkedAt: null, connectedAt: null, usage: null };
  }
  return {
    kind,
    state: fresh?.state ?? 'untested',
    detail: fresh?.detail ?? 'Not checked yet.',
    checkedAt: fresh?.checkedAt ?? null,
    connectedAt: kind === 'subscription' ? (s?.connectedAt ?? null) : null,
    usage: fresh?.usage ?? null,
  };
}

function store(patch: Partial<Stored>): void {
  const prev = loadStored();
  const kind = credentialKind();
  const keep = prev?.kind === kind ? prev : null;
  mkdirSync(PATHS.data, { recursive: true });
  writeFileSync(STATUS_FILE, JSON.stringify({
    state: 'untested', detail: '', checkedAt: new Date().toISOString(),
    ...keep, connectedAt: prev?.connectedAt ?? null, kind, ...patch,
  }, null, 2));
}

export function recordStatus(state: CredentialState, detail: string): void {
  store({ state, detail, checkedAt: new Date().toISOString() });
}

/** Keep the latest subscription usage windows (no secrets in them). */
export function recordRateLimit(info: RateLimitInfo): void {
  const names: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly', seven_day_opus: 'weekly (Opus)' };
  const usage = Object.entries(info.unifiedWindows ?? {})
    .filter(([, w]) => typeof w.utilization === 'number')
    .map(([k, w]) => ({ window: names[k] ?? k.replace(/_/g, ' '), percent: Math.round((w.utilization ?? 0) * 100), resetsAt: new Date((w.resetsAt ?? 0) * 1000).toISOString() }));
  if (!usage.length) return;
  const prev = loadStored();
  if (JSON.stringify(prev?.usage) === JSON.stringify(usage)) return;
  store({ usage });
}

/** Classify Claude Code's own error output (it prints these to stdout and
 *  exits non-zero). Returns null for anything that is not a credential or
 *  capacity problem. The player-facing text never includes the raw output. */
export function classifyCliError(text: string): { state: CredentialState; detail: string; player: string } | null {
  const t = text.slice(0, 2000);
  if (/expired|token has been revoked|refresh token/i.test(t) && /oauth|token|login/i.test(t)) {
    return { state: 'expired', detail: 'The Claude token expired or was revoked. Reconnect it.', player: "the genie's AI login expired — ask the owner to reconnect it in Settings" };
  }
  if (/Failed to authenticate|401|Invalid API key|invalid x-api-key|authentication_error|OAuth access token is invalid|Not logged in|Please run \/login/i.test(t)) {
    return { state: 'invalid', detail: 'The credential was rejected. Reconnect it or paste a new one.', player: "the genie's AI login was rejected — ask the owner to reconnect it in Settings" };
  }
  if (/usage limit|limit reached|rate.?limit|429|too many requests|credit balance is too low|out of credits|quota/i.test(t)) {
    const reset = /resets?\s+(?:at\s+)?([^\n.|·]{1,40})/i.exec(t)?.[1]?.trim();
    const credits = /credit balance|out of credits|quota/i.test(t);
    const detail = credits
      ? 'The API account is out of credits.'
      : `Usage limit reached${reset ? `, resets ${reset}` : ''}. The genie works again when it resets.`;
    return { state: 'rate-limited', detail, player: credits ? 'the AI account is out of credits — tell the owner' : `the AI usage limit is reached${reset ? ` (resets ${reset})` : ''} — try again later` };
  }
  if (/overloaded|529|503|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network|fetch failed|socket hang up/i.test(t)) {
    return { state: 'unavailable', detail: 'Claude could not be reached (network or overloaded). It usually recovers by itself.', player: "the AI is unreachable right now — try again in a minute" };
  }
  return null;
}

let testing: Promise<CredentialStatus> | null = null;
/** One tiny real request with the genie's exact spawn path (same user, same
 *  flags, same environment), so "connected" means the genie itself works. */
export function testCredential(): Promise<CredentialStatus> {
  testing ??= (async () => {
    try {
      if (credentialKind() === 'none') return credentialStatus();
      let child: ChildProcessWithoutNullStreams;
      try { child = spawnClaude(false); } catch (e) {
        recordStatus('unavailable', String((e as Error).message ?? e).slice(0, 200));
        return credentialStatus();
      }
      const t0 = Date.now();
      const res = await new Promise<{ code: number | null; out: string; spawnErr?: string }>((resolve) => {
        let out = '';
        const timer = setTimeout(() => { if (child.pid) killTree(child.pid); }, 60_000);
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, spawnErr: String(e.message ?? e) }); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
        child.stdin.end('Reply with exactly the word OK and nothing else.');
      });
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (res.spawnErr) {
        recordStatus('unavailable', /ENOENT/.test(res.spawnErr) ? 'Claude Code is not installed on this machine: npm i -g @anthropic-ai/claude-code' : res.spawnErr.slice(0, 200));
      } else {
        // stdout is stream-json; pick out the final result and any usage report
        let reply = '';
        let isError = res.code !== 0;
        for (const line of res.out.split('\n')) {
          try {
            const ev = JSON.parse(line) as { type?: string; result?: string; is_error?: boolean; rate_limit_info?: RateLimitInfo };
            if (ev.type === 'result') { reply = ev.result ?? ''; isError ||= !!ev.is_error; }
            if (ev.type === 'rate_limit_event' && ev.rate_limit_info) recordRateLimit(ev.rate_limit_info);
          } catch { if (line.trim()) reply ||= line; }
        }
        if (!isError && /\bOK\b/.test(reply)) {
          recordStatus('connected', `Working. A test reply took ${secs}s.`);
          return credentialStatus();
        }
        const c = classifyCliError(reply || res.out);
        recordStatus(c?.state ?? 'unavailable', c?.detail ?? (res.code === null ? 'The test timed out after 60s.' : 'The test request failed. Check that Claude Code runs on this machine.'));
      }
      return credentialStatus();
    } finally {
      testing = null;
    }
  })();
  return testing;
}

/** Save (or clear) the credential and test it straight away. */
let saving: Promise<unknown> = Promise.resolve();
export function setCredential(value: string | null, connected = false): Promise<CredentialStatus> {
  // one save-and-test at a time, so a test can never report on a credential
  // that was replaced while it ran
  const run = saving.catch(() => null).then(() => saveAndTest(value, connected));
  saving = run;
  return run;
}

async function saveAndTest(value: string | null, connected: boolean): Promise<CredentialStatus> {
  // a test already running (Test button) is for the old credential: let it land first
  await testing?.catch(() => null);
  const s = loadSettings();
  s.anthropicApiKey = value?.trim() || null;
  saveSettings(s);
  const prev = loadStored();
  mkdirSync(PATHS.data, { recursive: true });
  writeFileSync(STATUS_FILE, JSON.stringify({
    kind: credentialKind(), state: 'untested', detail: 'Checking…', checkedAt: new Date().toISOString(),
    connectedAt: connected ? new Date().toISOString() : s.anthropicApiKey === null ? null : prev?.connectedAt ?? null,
    usage: null,
  }, null, 2));
  resetGenieWarm();
  if (!s.anthropicApiKey && credentialKind() === 'none') return credentialStatus();
  return testCredential();
}

// ---- One-click Claude subscription connect.
// `claude setup-token` is Claude Code's own flow for a long-lived (1 year)
// subscription token: it prints a sign-in URL, the user approves in their
// browser, the page shows a code, and pasting the code back prints the token.
// It needs a terminal, so a tiny Python helper (Python is already required
// for the supervisor) gives it a wide pseudo-terminal. The panel shows the URL,
// takes the code, captures the token straight into settings.json and never
// logs or returns it. Windows has no pty module: the UI falls back to pasting.

const PTY_HELPER = String.raw`
import os, pty, sys, select, struct, fcntl, termios
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', 60, 2000, 0, 0))
    os.execv(sys.argv[1], sys.argv[1:])
while True:
    try:
        r, _, _ = select.select([fd, 0], [], [])
    except InterruptedError:
        continue
    if fd in r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
    if 0 in r:
        data = os.read(0, 4096)
        if not data:
            break
        os.write(fd, data)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, 'waitstatus_to_exitcode') else 0)
`;

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = [
  new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g'), // OSC
  new RegExp(`${ESC}\\[[0-9;?<>=]*[ -/]*[@-~]`, 'g'), // CSI
  new RegExp(`${ESC}[()][A-Z0-9]`, 'g'), // charset
];
const strip = (s: string): string => ANSI.reduce((t, re) => t.replace(re, ''), s);
const URL_RE = /https:\/\/(?:claude\.com|claude\.ai|console\.anthropic\.com|platform\.claude\.com)\/\S*oauth\/authorize\?\S+/;
// terminated by whitespace: a pty chunk can split the token, and a prefix is not a token
const TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]{40,}(?=\s)/;

interface Session { child: ChildProcessWithoutNullStreams; out: string; url: string | null; started: number; timer: NodeJS.Timeout }
let session: Session | null = null;
/** End one connect session (default: the current one). A stale caller can
 *  only end its own session, never a newer replacement. */
function endSession(which: Session | null = session): void {
  if (!which) return;
  clearTimeout(which.timer);
  if (which.child.pid) { try { killTree(which.child.pid); } catch { /* gone */ } }
  if (session === which) session = null;
}

export function connectSupported(): boolean {
  return !IS_WIN;
}

/** Start `claude setup-token` and return the sign-in URL it prints. */
export async function startConnect(): Promise<{ url: string } | { error: string }> {
  if (!connectSupported()) return { error: 'one-click connect needs Linux or macOS here; run claude setup-token yourself and paste the token' };
  endSession();
  const env: Record<string, string> = {};
  for (const k of ['PATH', 'LANG', 'LC_ALL', 'TMPDIR']) if (process.env[k]) env[k] = process.env[k]!;
  env.HOME = dropTo ? genieDir().home : process.env.HOME ?? genieDir().home;
  env.TERM = 'xterm-256color';
  // the sign-in happens in the user's browser, not on the panel machine
  env.BROWSER = '/bin/true';
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn('python3', ['-c', PTY_HELPER, claudePath(), 'setup-token'], {
      cwd: genieDir().cwd, ...KILLABLE_SPAWN_OPTS, ...dropTo, env,
    });
  } catch (e) {
    return { error: `could not start Claude Code: ${String((e as Error).message ?? e).slice(0, 120)}` };
  }
  child.stdin.on('error', () => {});
  const s: Session = { child, out: '', url: null, started: Date.now(), timer: setTimeout(() => endSession(s), 10 * 60_000) };
  s.timer.unref?.();
  session = s;
  child.stdout.on('data', (d) => { s.out += strip(String(d)); });
  child.stderr.on('data', (d) => { s.out += strip(String(d)); });
  const exited = new Promise<void>((r) => child.on('close', () => r()));
  child.on('error', () => {});
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && session === s) {
    const m = URL_RE.exec(s.out);
    if (m) { s.url = m[0]; return { url: m[0] }; }
    if (await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 250))])) break;
  }
  const why = /not found|ENOENT/i.test(s.out) ? 'Claude Code is not installed on this machine: npm i -g @anthropic-ai/claude-code' : 'Claude Code did not show a sign-in link. Try again, or paste a token instead.';
  endSession(s);
  return { error: why };
}

/** Hand the code from the browser to `claude setup-token`; on success the
 *  token goes straight into settings and is tested. */
export async function finishConnect(code: string): Promise<CredentialStatus | { error: string }> {
  const s = session;
  if (!s?.url) return { error: 'the sign-in expired — press Connect again' };
  const clean = code.trim();
  if (!/^[A-Za-z0-9_#\-.~]{10,512}$/.test(clean)) return { error: 'that does not look like the code from the Claude page — copy it again' };
  const before = s.out.length;
  s.child.stdin.write(clean);
  await new Promise((r) => setTimeout(r, 150));
  s.child.stdin.write('\r');
  const deadline = Date.now() + 45_000;
  let exited = false;
  s.child.on('close', () => { exited = true; });
  while (Date.now() < deadline) {
    // cancelled or replaced meanwhile: this session's result no longer counts
    if (session !== s) return { error: 'the sign-in was cancelled — press Connect again' };
    const tail = s.out.slice(before).replace(/\s+/g, ' ');
    const tok = TOKEN_RE.exec(s.out.slice(before));
    if (tok) {
      endSession(s);
      return setCredential(tok[0], true);
    }
    if (/invalid|error|failed|expired/i.test(tail) && !/Pastecode|Paste code/i.test(tail.slice(-60))) {
      endSession(s);
      return { error: 'Claude did not accept that code. Press Connect and try once more (codes work only once).' };
    }
    if (exited) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  endSession(s);
  return { error: 'Claude Code did not return a token. Press Connect and try again.' };
}

export function cancelConnect(): void {
  endSession();
}

process.on('exit', () => endSession());
