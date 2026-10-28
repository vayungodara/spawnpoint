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

/** How the request is authenticated: the admin token, a PIN session, or not at all. */
export function authed(headers: { cookie?: string; authorization?: string }): 'token' | 'session' | null {
  const bearer = /^Bearer (\S+)$/.exec(headers.authorization ?? '')?.[1];
  if (bearer) return tsEq(bearer, adminToken()) ? 'token' : null;
  return cookieValid(headers.cookie) ? 'session' : null;
}

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
