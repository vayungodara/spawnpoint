import { FastifyInstance, FastifyRequest } from 'fastify';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { Agent, request } from 'undici';
import { PATHS, loadSettings, saveSettings } from '../config.js';
import { chownToDirOwner } from '../services/platform.js';
import { pinHash, cookieToken } from './settingsRoutes.js';

// FIRST-RUN WIZARD — active exactly while Shared/crafty-token.txt is absent.
// A configured install (the file exists) never sees any of this: /status says
// {active:false} and the mutating route refuses. The goal is that a stranger's
// first browser visit is one form, not a docs page: the panel logs into
// Crafty's own /api/v2/auth/login ONCE with the admin credentials the user
// already knows, mints its own API token, and writes the file itself — the
// user never handles the word "token".
export function wizardActive(): boolean {
  return !existsSync(PATHS.craftyTokenFile);
}

// SETUP CLAIM CODE — the setup window is the one moment the panel accepts an
// unauthenticated write, and it listens on 0.0.0.0. Without a claim, anyone
// who can reach the port during that window could point the panel at a Crafty
// they control and own the install. So: requests from the machine itself need
// nothing (the overwhelmingly common case — you're at the box you just
// installed on), and every REMOTE setup request must present the code that
// install.sh printed. The code lives beside the other runtime state and is
// deleted the moment setup completes.
const CODE_FILE = join(PATHS.data, 'setup-code.txt');

export function setupCode(): string {
  try {
    const c = readFileSync(CODE_FILE, 'utf8').trim();
    if (c) return c;
  } catch { /* missing/unreadable — mint one below */ }
  // 80 bits: this endpoint can be reachable from a LAN (or a tailnet) while
  // setup is open, so the code has to survive sustained guessing on its own,
  // not just because of the throttle below
  const code = randomBytes(10).toString('hex').toUpperCase();
  mkdirSync(PATHS.data, { recursive: true });
  // wx = first writer wins: two panel processes sharing a layout must not
  // print different codes than the one actually stored
  try {
    writeFileSync(CODE_FILE, `${code}\n`, { mode: 0o600, flag: 'wx' });
    return code;
  } catch {
    try {
      const existing = readFileSync(CODE_FILE, 'utf8').trim();
      if (existing) return existing;
    } catch { /* fall through */ }
    writeFileSync(CODE_FILE, `${code}\n`, { mode: 0o600 });
    return code;
  }
}

// wrong-code throttle, same shape as the PIN gate's: 5 free tries then a
// doubling lockout. Bounded so it cannot be grown into a memory DoS.
const codeAttempts = new Map<string, { fails: number; lockedUntil: number }>();
function codeThrottled(ip: string): number {
  const a = codeAttempts.get(ip);
  return a && Date.now() < a.lockedUntil ? Math.ceil((a.lockedUntil - Date.now()) / 1000) : 0;
}
function codeFailed(ip: string): void {
  const a = codeAttempts.get(ip) ?? { fails: 0, lockedUntil: 0 };
  a.fails += 1;
  if (a.fails >= 5) a.lockedUntil = Date.now() + Math.min(15 * 60_000, 2 ** (a.fails - 5) * 30_000);
  if (!codeAttempts.has(ip) && codeAttempts.size >= 2048) {
    const oldest = codeAttempts.keys().next();
    if (!oldest.done) codeAttempts.delete(oldest.value);
  }
  codeAttempts.set(ip, a);
}

function isLocal(req: FastifyRequest): boolean {
  return req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
}

function claimOk(req: FastifyRequest, given: string): boolean {
  if (isLocal(req)) return true;
  const want = Buffer.from(setupCode());
  const got = Buffer.from(String(given ?? '').trim().toUpperCase());
  return want.length === got.length && timingSafeEqual(want, got);
}

// Crafty must live on this machine or the local network — the wizard is not a
// general-purpose HTTP client, and refusing public hosts keeps an
// unauthenticated setup request from being aimed at the internet.
function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.localhost')) return true;
  if (/^fd[0-9a-f]{2}:/.test(h) || h.startsWith('fe80:')) return true; // ULA / link-local
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
  if ([a, b, parseInt(m[3], 10), parseInt(m[4], 10)].some((n) => isNaN(n) || n > 255)) return false;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127); // CGNAT — Tailscale's range
}

// Crafty ships a self-signed cert; the panel's runtime client (clients/crafty.ts)
// tolerates it, so the wizard must too or it would reject the very setups the
// panel then runs happily. Scope is the same one that reaches the API at all:
// private hosts only, never a public peer.
const insecureLocalAgent = new Agent({ connect: { rejectUnauthorized: false } });
function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\./.test(h);
}
/** Crafty on THIS machine can't be MITM'd, so its self-signed cert is fine.
    Anything else on the LAN gets real verification unless the user explicitly
    accepts the risk — the admin password is in that request body, and a
    hijacked `.local` name or an ARP-poisoned LAN IP would otherwise hand it to
    whoever answered. */
function dispatcherFor(url: string, allowInsecure = false): Agent | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return undefined;
    return isLoopbackHost(u.hostname) || allowInsecure ? insecureLocalAgent : undefined;
  } catch {
    return undefined;
  }
}
const CERT_ERR = /certificate|self.signed|SELF_SIGNED|DEPTH_ZERO|UNABLE_TO_VERIFY|ERR_TLS/i;

/** True when a machine-wide Claude Code login exists — the genie can then run
    on the subscription the owner already pays for, with no key to paste. */
function claudeCliReady(): { installed: boolean; loggedIn: boolean } {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const bins = [join(home, '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/usr/bin/claude', '/opt/homebrew/bin/claude'];
  const installed = bins.some((b) => existsSync(b))
    || (process.env.PATH ?? '').split(/[:;]/).some((d) => d && existsSync(join(d, 'claude')));
  const loggedIn = !!home && (existsSync(join(home, '.claude', '.credentials.json')) || !!process.env.ANTHROPIC_API_KEY);
  return { installed, loggedIn };
}

let probeCache = { at: 0, ok: false };

export default async function wizardRoutes(app: FastifyInstance) {
  app.get('/api/wizard/status', async (req) => {
    if (!wizardActive()) return { active: false };
    const s = loadSettings();
    // the probe is cached: this route is unauthenticated during setup, and one
    // outbound connection per poll is an amplifier a stranger should not have
    let craftyReachable = probeCache.ok;
    if (Date.now() - probeCache.at > 5000) {
      craftyReachable = false;
      try {
        const res = await request(`${s.craftyUrl}/api/v2`, {
          dispatcher: dispatcherFor(s.craftyUrl, true),
          signal: AbortSignal.timeout(3000),
        });
        await res.body.dump();
        craftyReachable = true;
      } catch { /* nothing listening — the wizard says so instead of guessing */ }
      probeCache = { at: Date.now(), ok: craftyReachable };
    }
    const tools = join(PATHS.root, 'Tools');
    const hasJdk = existsSync(tools) && readdirSync(tools).some((d) => d.startsWith('jdk-'));
    return {
      active: true,
      craftyUrl: s.craftyUrl,
      craftyReachable,
      hasJdk,
      pinSet: !!(s.pinHash || s.pin),
      // a browser on the panel's own machine finishes setup with no code
      needsCode: !isLocal(req),
      claude: claudeCliReady(),
    };
  });

  app.post<{ Body: { username?: string; password?: string; token?: string; url?: string; code?: string; allowInsecure?: boolean } }>(
    '/api/wizard/crafty-login',
    async (req, reply) => {
      if (!wizardActive()) return reply.code(403).send({ error: 'setup is already complete' });
      const wait = isLocal(req) ? 0 : codeThrottled(req.ip);
      if (wait) return reply.code(429).send({ error: `too many wrong setup codes — wait ${wait}s` });
      if (!claimOk(req, String(req.body?.code ?? ''))) {
        codeFailed(req.ip);
        return reply.code(403).send({
          error: 'setup code required — it was printed by the installer (or run: cat <layout>/Spawnpoint/data/setup-code.txt on the panel machine)',
        });
      }
      const allowInsecure = req.body?.allowInsecure === true;
      const username = String(req.body?.username ?? '').trim();
      const password = String(req.body?.password ?? '');
      // Preferred path (Crafty team's request): a pasted API key, ideally from
      // a dedicated limited account — the panel then never sees or stores
      // anything that can unlock the superuser. Login-and-mint is the fallback.
      const pastedToken = String(req.body?.token ?? '').trim();
      if (!pastedToken && (!username || !password)) {
        return reply.code(400).send({ error: 'paste a Crafty API key, or give username and password' });
      }
      const url = (String(req.body?.url ?? '').trim() || loadSettings().craftyUrl).replace(/\/+$/, '');
      let host: string;
      try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
        host = u.hostname;
      } catch {
        return reply.code(400).send({ error: `not a usable address: ${url}` });
      }
      if (!isPrivateHost(host)) {
        return reply.code(400).send({
          error: 'Crafty must be on this machine or your local network (localhost, 10.x, 172.16-31.x, 192.168.x, or a Tailscale address)',
        });
      }

      // 1. log into Crafty exactly like its own web UI does. The credentials
      //    are used for this one request and never stored or logged.
      //    (skipped entirely when the user pasted an API key)
      let token: string;
      if (pastedToken) {
        token = pastedToken;
      } else try {
        const res = await request(`${url}/api/v2/auth/login`, {
          method: 'POST',
          dispatcher: dispatcherFor(url, allowInsecure),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username, password }),
          signal: AbortSignal.timeout(10_000),
        });
        const text = await res.body.text();
        if (res.statusCode === 401) return reply.code(401).send({ error: 'Crafty rejected that username/password' });
        if (res.statusCode >= 400) {
          return reply.code(502).send({ error: `Crafty answered ${res.statusCode} — is ${url} the right address?` });
        }
        let j: { status?: string; data?: { token?: string } };
        try {
          j = JSON.parse(text) as typeof j;
        } catch {
          return reply.code(502).send({ error: `${url} answered with a web page, not the Crafty API — check the address` });
        }
        if (j.status !== 'ok' || !j.data?.token) {
          return reply.code(502).send({ error: 'Crafty login did not return a token — check the credentials' });
        }
        token = j.data.token;
      } catch (e) {
        // a cert failure is a DECISION for the user, not a dead end: Crafty's
        // default cert is self-signed, and the alternative to asking is
        // silently shipping their admin password to an unverified peer
        if (CERT_ERR.test(String((e as { cause?: unknown })?.cause ?? e))) {
          return reply.code(495).send({
            error: `${url} presented a certificate this panel cannot verify (Crafty's default cert is self-signed). Connect anyway only if you trust this network.`,
            certUntrusted: true,
          });
        }
        return reply.code(502).send({ error: `could not reach Crafty at ${url} — is it running?` });
      }

      // 2. prove the minted token actually works before writing anything
      let servers = 0;
      try {
        const res = await request(`${url}/api/v2/servers`, {
          dispatcher: dispatcherFor(url, allowInsecure),
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        });
        const j = JSON.parse(await res.body.text()) as { status?: string; data?: unknown[] };
        if (res.statusCode >= 400 || j.status !== 'ok') {
          return reply.code(pastedToken ? 401 : 502).send({
            error: pastedToken
              ? 'Crafty refused that API key — check it was copied whole and the account can see your servers'
              : 'Crafty issued a token the API then refused — check the account',
          });
        }
        servers = Array.isArray(j.data) ? j.data.length : 0;
      } catch {
        return reply.code(502).send({ error: 'minted a token but the Crafty API did not answer with it' });
      }

      // 3. persist — settings FIRST, because the token file is the wizard's
      //    own off-switch: writing it before the URL could leave a configured
      //    install pointing at the wrong Crafty with no wizard left to fix it
      try {
        const s = loadSettings();
        if (url !== s.craftyUrl) {
          s.craftyUrl = url;
          saveSettings(s);
        }
      } catch {
        return reply.code(500).send({ error: 'could not save settings — check write permissions on the data folder' });
      }
      // the awaits above took seconds; a second setup request could have
      // completed meanwhile. wx makes the token file first-writer-wins so a
      // late arrival can never repoint a configured install.
      mkdirSync(dirname(PATHS.craftyTokenFile), { recursive: true });
      try {
        writeFileSync(PATHS.craftyTokenFile, `${token}\n`, { mode: 0o600, flag: 'wx' });
      } catch {
        return reply.code(409).send({ error: 'setup was already completed by another browser' });
      }
      await chownToDirOwner(dirname(PATHS.craftyTokenFile));
      // the claim code stays valid until the PIN step below closes setup —
      // a remote browser still needs it for /finish
      return { ok: true, servers };
    },
  );

  // FINISH — sets the PIN (and optional keys). This route exists because real
  // API access is loopback-only until a PIN is configured: a remote browser
  // finishing setup cannot reach PUT /api/settings yet, and the claim code is
  // what stands in for the session it does not have. Accepted only while no
  // PIN exists; afterwards Settings is the only way to change anything.
  app.post<{ Body: { pin?: string; code?: string; curseforgeApiKey?: string; anthropicApiKey?: string } }>(
    '/api/wizard/finish',
    async (req, reply) => {
      const s = loadSettings();
      if (s.pinHash || s.pin) return reply.code(403).send({ error: 'this panel already has a PIN — change it in Settings' });
      const wait = isLocal(req) ? 0 : codeThrottled(req.ip);
      if (wait) return reply.code(429).send({ error: `too many wrong setup codes — wait ${wait}s` });
      if (!claimOk(req, String(req.body?.code ?? ''))) {
        codeFailed(req.ip);
        return reply.code(403).send({ error: 'setup code required' });
      }
      const pin = String(req.body?.pin ?? '').trim();
      if (!/^\d{4,8}$/.test(pin)) return reply.code(400).send({ error: 'PIN must be 4-8 digits' });
      s.pin = null;
      s.pinHash = pinHash(pin);
      if (req.body?.curseforgeApiKey) s.curseforgeApiKey = String(req.body.curseforgeApiKey).trim() || null;
      if (req.body?.anthropicApiKey) s.anthropicApiKey = String(req.body.anthropicApiKey).trim() || null;
      saveSettings(s);
      // setup is over — the claim code has no further purpose
      try { writeFileSync(CODE_FILE, '', { mode: 0o600 }); } catch { /* best effort */ }
      reply.header(
        'set-cookie',
        `sp_auth=${cookieToken(s.pinHash)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`,
      );
      return { ok: true };
    },
  );
}
