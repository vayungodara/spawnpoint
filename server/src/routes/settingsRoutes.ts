import type { FastifyInstance } from 'fastify';
import { PATHS, loadSettings, saveSettings } from '../config.js';
import { craftyApi } from '../clients/crafty-adapter.js';
import { loadAutobackup, saveAutobackup, type AutobackupConfig } from '../services/autobackup.js';
import { authed, hashPin, login, pinConfigured, sessionCookie, throttled, PIN_RULE, PIN_RULE_TEXT } from '../auth.js';

export default async function settingsRoutes(app: FastifyInstance) {
  app.get('/api/auth/check', async (req) => ({
    required: true,
    pinSet: pinConfigured(),
    ok: authed(req.headers) !== null,
  }));

  app.post<{ Body: { pin: string } }>('/api/auth', async (req, reply) => {
    if (!pinConfigured()) return reply.code(409).send({ error: 'no PIN yet: finish setup first' });
    const wait = throttled(req.ip);
    if (wait) return reply.code(429).send({ error: `too many attempts, wait ${wait}s` });
    const cookie = login(String(req.body?.pin ?? ''), req.ip);
    if (!cookie) return reply.code(401).send({ error: 'wrong PIN' });
    reply.header('set-cookie', cookie);
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
      curseforgeKeySet: !!s.curseforgeApiKey,
      anthropicKeySet: !!s.anthropicApiKey,
      craftyUrl: s.craftyUrl,
      craftyOk,
      craftyServers,
      autobackup: loadAutobackup(),
    };
  });

  // keys: a string sets, null clears, omitted leaves alone. The PIN can be
  // changed but never removed.
  app.put<{ Body: { pin?: string; curseforgeApiKey?: string | null; anthropicApiKey?: string | null } }>(
    '/api/settings',
    async (req, reply) => {
      const s = loadSettings();
      if (req.body.pin !== undefined) {
        const pin = String(req.body.pin).trim();
        if (!PIN_RULE.test(pin)) return reply.code(400).send({ error: PIN_RULE_TEXT });
        s.pin = null;
        s.pinHash = hashPin(pin);
      }
      if ('curseforgeApiKey' in req.body) {
        const key = req.body.curseforgeApiKey === null ? null : String(req.body.curseforgeApiKey).trim();
        s.curseforgeApiKey = key || null;
      }
      if ('anthropicApiKey' in req.body) {
        const key = req.body.anthropicApiKey === null ? null : String(req.body.anthropicApiKey).trim();
        s.anthropicApiKey = key || null;
      }
      saveSettings(s);
      // a new PIN ends every session; keep this browser signed in
      if (req.body.pin !== undefined && s.pinHash) reply.header('set-cookie', sessionCookie(s.pinHash));
      return { ok: true };
    },
  );

  app.get('/api/autobackup', async () => loadAutobackup());
  app.put<{ Body: Partial<AutobackupConfig> }>('/api/autobackup', async (req) =>
    saveAutobackup(req.body ?? {}),
  );
}
