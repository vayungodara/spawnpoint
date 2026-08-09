import type { FastifyInstance } from 'fastify';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS, loadSettings, saveSettings } from '../config.js';
import { craftyApi } from '../clients/crafty.js';
import { loadAutobackup, saveAutobackup, type AutobackupConfig } from '../services/autobackup.js';

// PIN gate (2026-07-22 pre-publish hardening):
// - the PIN is stored HASHED (legacy plaintext auto-migrates on first read)
// - the cookie is an HMAC over a RANDOM PER-INSTALL secret — a captured
//   cookie can't be brute-forced back to the PIN offline, and two installs
//   with the same PIN never share a cookie value. Changing the PIN (or
//   deleting data/session-secret) still invalidates every session at once.
// - all comparisons are constant-time; login attempts rate-limit per IP.
const SALT = 'spawnpoint-v1';
export const pinHash = (pin: string): string => createHash('sha256').update(pin + SALT).digest('hex');

let secretCache: string | null = null;
function sessionSecret(): string {
  if (secretCache) return secretCache;
  const p = join(PATHS.data, 'session-secret');
  try {
    secretCache = readFileSync(p, 'utf8').trim();
    if (!secretCache) throw new Error('empty');
  } catch {
    secretCache = randomBytes(32).toString('hex');
    writeFileSync(p, secretCache, { mode: 0o600 });
  }
  return secretCache;
}

/** The stored PIN hash — migrating a legacy plaintext `pin` field the first
    time it is seen (the plaintext never survives another read). */
function storedPinHash(): string | null {
  const s = loadSettings();
  if (s.pin) {
    const h = pinHash(s.pin);
    saveSettings({ ...s, pin: null, pinHash: h });
    return h;
  }
  return s.pinHash ?? null;
}

export const cookieToken = (hash: string): string =>
  createHmac('sha256', sessionSecret()).update(`sp-auth:${hash}`).digest('hex');

const tsEq = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Whether this install has a PIN at all. Distinct from cookieAuthed(): "no
    PIN" means the gate is off for LOCAL use, never that the network may
    administer the panel. */
export function pinConfigured(): boolean {
  return !!storedPinHash();
}

export function cookieAuthed(cookieHeader: string | undefined): boolean {
  const hash = storedPinHash();
  if (!hash) return true; // gate disabled
  const m = /(?:^|;\s*)sp_auth=([a-f0-9]{64})/.exec(cookieHeader ?? '');
  return !!m && tsEq(m[1], cookieToken(hash));
}

// brute-force throttle: 5 free tries per IP, then doubling lockout (30s → 15min
// cap). In-memory on purpose — a panel restart forgiving the counter is fine.
const pinAttempts = new Map<string, { fails: number; lockedUntil: number }>();
// bounded on purpose: /api/auth sits outside the gate, so an attacker with
// many source addresses (a /64 of IPv6 is free) could otherwise grow this map
// until the panel is OOM-killed. Dropping the oldest entries only forgives
// lockouts, which the doubling backoff re-earns in seconds.
const MAX_TRACKED_IPS = 4096;
function rememberAttempt(ip: string, a: { fails: number; lockedUntil: number }): void {
  if (!pinAttempts.has(ip) && pinAttempts.size >= MAX_TRACKED_IPS) {
    const oldest = pinAttempts.keys().next();
    if (!oldest.done) pinAttempts.delete(oldest.value);
  }
  pinAttempts.set(ip, a);
}

export default async function settingsRoutes(app: FastifyInstance) {
  app.get('/api/auth/check', async (req) => ({
    required: !!storedPinHash(),
    ok: cookieAuthed(req.headers.cookie),
  }));

  app.post<{ Body: { pin: string } }>('/api/auth', async (req, reply) => {
    const hash = storedPinHash();
    if (!hash) return { ok: true };
    const a = pinAttempts.get(req.ip) ?? { fails: 0, lockedUntil: 0 };
    if (Date.now() < a.lockedUntil) {
      return reply.code(429).send({ error: `too many attempts — wait ${Math.ceil((a.lockedUntil - Date.now()) / 1000)}s` });
    }
    if (!tsEq(pinHash(String(req.body?.pin ?? '')), hash)) {
      a.fails += 1;
      if (a.fails >= 5) a.lockedUntil = Date.now() + Math.min(15 * 60_000, 2 ** (a.fails - 5) * 30_000);
      rememberAttempt(req.ip, a);
      return reply.code(401).send({ error: 'wrong PIN' });
    }
    pinAttempts.delete(req.ip);
    reply.header(
      'set-cookie',
      `sp_auth=${cookieToken(hash)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`,
    );
    return { ok: true };
  });

  app.get('/api/settings/summary', async () => {
    const s = loadSettings();
    let craftyOk = false;
    let craftyServers = 0;
    try {
      craftyServers = (await craftyApi.listServers()).length;
      craftyOk = true;
    } catch { /* crafty down or bad token */ }
    return {
      root: PATHS.root,
      pinEnabled: !!(s.pinHash || s.pin),
      curseforgeKeySet: !!s.curseforgeApiKey,
      anthropicKeySet: !!s.anthropicApiKey,
      vercelTokenSet: !!s.vercelToken,
      craftyUrl: s.craftyUrl,
      craftyOk,
      craftyServers,
      autobackup: loadAutobackup(),
    };
  });

  // set to a string to change, null to clear, omit to leave alone
  app.put<{ Body: { pin?: string | null; curseforgeApiKey?: string | null; anthropicApiKey?: string | null; vercelToken?: string | null } }>(
    '/api/settings',
    async (req, reply) => {
      const s = loadSettings();
      if ('pin' in req.body) {
        const pin = req.body.pin === null ? null : String(req.body.pin).trim();
        if (pin !== null && !/^\d{4,8}$/.test(pin)) {
          return reply.code(400).send({ error: 'PIN must be 4-8 digits' });
        }
        s.pin = null; // plaintext never stored
        s.pinHash = pin === null ? null : pinHash(pin);
      }
      if ('curseforgeApiKey' in req.body) {
        const key = req.body.curseforgeApiKey === null ? null : String(req.body.curseforgeApiKey).trim();
        s.curseforgeApiKey = key || null;
      }
      if ('anthropicApiKey' in req.body) {
        const key = req.body.anthropicApiKey === null ? null : String(req.body.anthropicApiKey).trim();
        s.anthropicApiKey = key || null;
      }
      if ('vercelToken' in req.body) {
        const t = req.body.vercelToken === null ? null : String(req.body.vercelToken).trim();
        s.vercelToken = t || null;
      }
      saveSettings(s);
      // fresh PIN -> log this browser in immediately, with the SAME HMAC
      // cookie /api/auth would issue. (The old guard checked s.pin — which
      // the plaintext-never-stored rule had just nulled — and minted the
      // bare sha256 instead of cookieToken(); the wizard's PIN step made
      // the dead branch matter.)
      if (typeof req.body.pin === 'string' && s.pinHash) {
        reply.header(
          'set-cookie',
          `sp_auth=${cookieToken(s.pinHash)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`,
        );
      }
      return { ok: true };
    },
  );

  app.get('/api/autobackup', async () => loadAutobackup());
  app.put<{ Body: Partial<AutobackupConfig> }>('/api/autobackup', async (req) =>
    saveAutobackup(req.body ?? {}),
  );
}
