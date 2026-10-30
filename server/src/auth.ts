import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS, loadSettings, saveSettings } from './config.js';

// Panel access. Every /api route except health, login and the setup wizard
// needs either a session cookie (from the PIN) or the admin token (for
// scripts on the panel's machine). There is no trusted address: a reverse
// proxy or tunnel on the same host would make every visitor look local.

const SESSION_DAYS = 30;
export const PIN_RULE = /^\d{6,12}$/;
export const PIN_RULE_TEXT = 'PIN must be 6 to 12 digits';

const tsEq = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** A 0600 secret under data/, created on first use. */
function secretFile(name: string, bytes: number): () => string {
  let cache: string | null = null;
  return () => {
    if (cache) return cache;
    const p = join(PATHS.data, name);
    try {
      cache = readFileSync(p, 'utf8').trim() || null;
    } catch { /* first use */ }
    if (!cache) {
      cache = randomBytes(bytes).toString('hex');
      mkdirSync(PATHS.data, { recursive: true });
      writeFileSync(p, cache, { mode: 0o600 });
    }
    return cache;
  };
}
const sessionSecret = secretFile('session-secret', 32);
/** Bearer token for scripts on the panel's machine (data/admin-token). */
export const adminToken = secretFile('admin-token', 24);

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(pin, salt, 32).toString('hex')}`;
}

/** Checks a PIN against the stored hash. Hashes from before scrypt (plain
    sha256 with a fixed salt) still verify, and are upgraded on success. */
function pinMatches(pin: string, stored: string): boolean {
  const [kind, salt, hash] = stored.split('$');
  if (kind === 'scrypt' && salt && hash) return tsEq(scryptSync(pin, Buffer.from(salt, 'hex'), 32).toString('hex'), hash);
  return tsEq(createHash('sha256').update(`${pin}spawnpoint-v1`).digest('hex'), stored);
}

/** The stored PIN hash; a legacy plaintext `pin` field is hashed on first read. */
function storedPinHash(): string | null {
  const s = loadSettings();
  if (s.pin) {
    const h = hashPin(s.pin);
    saveSettings({ ...s, pin: null, pinHash: h });
    return h;
  }
  return s.pinHash ?? null;
}

export const pinConfigured = (): boolean => !!storedPinHash();

/** Session cookie: issue time plus an HMAC over it and the PIN hash, so a PIN
    change ends every session and old cookies expire on the server too. */
export function sessionCookie(pinHash: string): string {
  const issued = Date.now().toString(36);
  const mac = createHmac('sha256', sessionSecret()).update(`${issued}:${pinHash}`).digest('hex');
  return `sp_auth=${issued}.${mac}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}`;
}

function cookieValid(cookieHeader: string | undefined): boolean {
  const hash = storedPinHash();
  const m = /(?:^|;\s*)sp_auth=([0-9a-z]+)\.([a-f0-9]{64})/.exec(cookieHeader ?? '');
  if (!hash || !m) return false;
  const age = Date.now() - parseInt(m[1], 36);
  if (!(age >= 0 && age < SESSION_DAYS * 86_400_000)) return false;
  return tsEq(m[2], createHmac('sha256', sessionSecret()).update(`${m[1]}:${hash}`).digest('hex'));
}

// Scoped API tokens for agents and remote scripts, created in Panel settings.
// Only a SHA-256 of each token is stored; the token itself is shown once.
// Scopes nest: read < control < approve. An approve token counts as the
// owner's consent, so it is only created with an explicit confirmation.
export const SCOPES = ['read', 'control', 'approve'] as const;
export type Scope = (typeof SCOPES)[number];
export interface ApiToken { id: string; name: string; scope: Scope; hash: string; created: string; lastUsed?: string }
const RANK: Record<Scope | 'admin', number> = { read: 0, control: 1, approve: 2, admin: 3 };
const TOKENS_FILE = (): string => join(PATHS.data, 'api-tokens.json');
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export function listTokens(): ApiToken[] {
  try { return JSON.parse(readFileSync(TOKENS_FILE(), 'utf8')) as ApiToken[]; } catch { return []; }
}
function saveTokens(tokens: ApiToken[]): void {
  mkdirSync(PATHS.data, { recursive: true });
  writeFileSync(TOKENS_FILE(), JSON.stringify(tokens, null, 2), { mode: 0o600 });
}
/** Returns the new token once; only its hash is kept. */
export function createToken(name: string, scope: Scope): { token: string; info: Omit<ApiToken, 'hash'> } {
  const id = randomBytes(4).toString('hex');
  const token = `spt_${id}_${randomBytes(24).toString('base64url')}`;
  const t: ApiToken = { id, name, scope, hash: sha256(token), created: new Date().toISOString() };
  saveTokens([...listTokens(), t]);
  return { token, info: { id, name, scope, created: t.created } };
}
export function revokeToken(id: string): boolean {
  const all = listTokens();
  const rest = all.filter((t) => t.id !== id);
  if (rest.length !== all.length) saveTokens(rest);
  return rest.length !== all.length;
}
function scopedToken(bearer: string): ApiToken | null {
  const id = /^spt_([0-9a-f]{8})_[\w-]{32}$/.exec(bearer)?.[1];
  const t = id ? listTokens().find((x) => x.id === id) : undefined;
  if (!t || !tsEq(sha256(bearer), t.hash)) return null;
  // last use is shown in settings; written at most once a minute
  if (!t.lastUsed || Date.now() - Date.parse(t.lastUsed) > 60_000) {
    saveTokens(listTokens().map((x) => (x.id === t.id ? { ...x, lastUsed: new Date().toISOString() } : x)));
  }
  return t;
}

/** Who is asking: the owner (PIN session or admin token) or a scoped token. */
export interface Access { by: 'token' | 'session' | 'api'; scope: Scope | 'admin'; name?: string }

/** How the request is authenticated, or null when it is not. */
export function authed(headers: { cookie?: string; authorization?: string }): Access | null {
  const bearer = /^Bearer (\S+)$/.exec(headers.authorization ?? '')?.[1];
  if (bearer) {
    if (tsEq(bearer, adminToken())) return { by: 'token', scope: 'admin' };
    const t = scopedToken(bearer);
    return t ? { by: 'api', scope: t.scope, name: t.name } : null;
  }
  return cookieValid(headers.cookie) ? { by: 'session', scope: 'admin' } : null;
}

// Routes above their method's default scope. Reads default to `read` and
// writes to `control`. Reads that return file bytes can expose RCON
// passwords or keys, so they need `control`, except server and crash logs.
const NEEDS: Record<string, Scope | 'admin'> = {
  'GET /api/servers/:id/files/content': 'control',
  'GET /api/servers/:id/files/download': 'control',
  'GET /api/servers/:id/configs/file': 'control',
  'GET /api/servers/:id/candidate/config': 'control',
  'GET /api/servers/:id/bobby/download': 'control',
  'POST /api/servers/:id/candidate/apply': 'approve',
  'POST /api/servers/:id/revision/first': 'approve',
  'POST /api/servers/:id/last-change/undo': 'approve',
  'POST /api/servers/:id/backups/restore': 'approve',
  'POST /api/servers/:id/worlds/reset': 'approve',
  'POST /api/servers/:id/version/apply': 'approve',
  'POST /api/servers/:id/version/rollback': 'approve',
  'POST /api/servers/:id/reset-players': 'approve',
  'DELETE /api/servers/:id/backups': 'approve',
  'GET /api/tokens': 'admin',
  'POST /api/tokens': 'admin',
  'DELETE /api/tokens/:tokenId': 'admin',
  'PUT /api/settings': 'admin',
  'POST /api/runtime': 'admin',
  'POST /api/admin/exit': 'admin',
  'DELETE /api/servers/:id': 'admin',
  'POST /api/servers/:id/runtime/import': 'admin',
  // the genie's AI account is the owner's subscription or API key
  'PUT /api/genie/credential': 'admin',
  'POST /api/genie/credential/test': 'admin',
  'POST /api/genie/connect/start': 'admin',
  'POST /api/genie/connect/finish': 'admin',
  'POST /api/genie/connect/cancel': 'admin',
};
const LOG_PATH = /^(logs|crash-reports)\/[\w-][\w.-]*$/;

/** The scope a request needs, by its matched route. */
export function requiredScope(method: string, route: string, query: unknown): Scope | 'admin' {
  const m = method === 'HEAD' ? 'GET' : method; // HEAD runs the GET handler
  const need = NEEDS[`${m} ${route}`];
  if (need === 'control' && route.endsWith('/files/content') && LOG_PATH.test(String((query as { path?: string })?.path ?? ''))) return 'read';
  return need ?? (m === 'GET' ? 'read' : 'control');
}
export const allows = (a: Access, need: Scope | 'admin'): boolean => RANK[a.scope] >= RANK[need];

// Wrong guesses: 5 free per address, then a doubling lockout (30 s to 15
// min). A global cap stops an attacker who rotates addresses. Both reset
// when the panel restarts.
const perIp = new Map<string, { fails: number; until: number }>();
let recentFails: number[] = [];
const GLOBAL_WINDOW = 10 * 60_000;
const GLOBAL_MAX = 30;

/** Seconds until this address may try again, or 0. */
export function throttled(ip: string): number {
  recentFails = recentFails.filter((t) => Date.now() - t < GLOBAL_WINDOW);
  const globalWait = recentFails.length >= GLOBAL_MAX ? recentFails[0] + GLOBAL_WINDOW - Date.now() : 0;
  const a = perIp.get(ip);
  return Math.ceil(Math.max(globalWait, a ? a.until - Date.now() : 0, 0) / 1000);
}

export function recordFailure(ip: string): void {
  recentFails.push(Date.now());
  const a = perIp.get(ip) ?? { fails: 0, until: 0 };
  a.fails += 1;
  if (a.fails >= 5) a.until = Date.now() + Math.min(15 * 60_000, 2 ** (a.fails - 5) * 30_000);
  if (!perIp.has(ip) && perIp.size >= 4096) perIp.delete(perIp.keys().next().value!);
  perIp.set(ip, a);
}

/** Log in with a PIN. Returns the Set-Cookie value, or null when wrong. */
export function login(pin: string, ip: string): string | null {
  const stored = storedPinHash();
  if (!stored || !pinMatches(pin, stored)) {
    recordFailure(ip);
    return null;
  }
  perIp.delete(ip);
  let hash = stored;
  if (!stored.startsWith('scrypt$')) {
    hash = hashPin(pin);
    saveSettings({ ...loadSettings(), pinHash: hash });
  }
  return sessionCookie(hash);
}
