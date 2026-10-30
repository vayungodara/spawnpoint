import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { PATHS, loadSettings, saveSettings } from '../config.js';
import { craftyApi } from '../clients/crafty-adapter.js';
import { loadAutobackup, saveAutobackup, type AutobackupConfig } from '../services/autobackup.js';
import { authed, createToken, hashPin, listTokens, login, pinConfigured, revokeToken, sessionCookie, throttled, PIN_RULE, PIN_RULE_TEXT, SCOPES, type Scope } from '../auth.js';
import { cancelConnect, connectSupported, credentialStatus, finishConnect, setCredential, startConnect, testCredential } from '../services/geniecredential.js';

export default async function settingsRoutes(app: FastifyInstance) {
  app.get('/api/auth/check', async (req) => {
    const access = authed(req.headers);
    return { required: true, pinSet: pinConfigured(), ok: access !== null, scope: access?.scope ?? null };
  });

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
      craftyConnected: existsSync(PATHS.craftyTokenFile),
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

  // scoped API tokens (owner only): the token is in this one response, never again
  app.get('/api/tokens', async () => ({ tokens: listTokens().map(({ hash: _hash, ...t }) => t) }));
  app.post<{ Body: { name?: string; scope?: Scope; confirmApprove?: boolean } }>('/api/tokens', async (req, reply) => {
    const name = String(req.body?.name ?? '').trim().slice(0, 40);
    const scope = req.body?.scope as Scope;
    if (!name || !SCOPES.includes(scope)) return reply.code(400).send({ error: 'a name and a scope (read, control or approve) are required' });
    if (scope === 'approve' && req.body.confirmApprove !== true) return reply.code(400).send({ error: 'an approve token counts as your consent to mod changes, undo and world restore; confirm that explicitly' });
    if (listTokens().length >= 50) return reply.code(409).send({ error: 'revoke an old token first (50 at most)' });
    reply.header('cache-control', 'no-store');
    return createToken(name, scope);
  });
  app.delete<{ Params: { tokenId: string } }>('/api/tokens/:tokenId', async (req, reply) =>
    revokeToken(req.params.tokenId) ? { ok: true } : reply.code(404).send({ error: 'no such token' }));

  // genie credential: status, test, paste, and the one-click Claude connect
  app.get('/api/genie/credential', async () => ({ ...credentialStatus(), connectSupported: connectSupported() }));
  app.post('/api/genie/credential/test', async () => ({ ...(await testCredential()), connectSupported: connectSupported() }));
  app.put<{ Body: { value?: string | null } }>('/api/genie/credential', async (req, reply) => {
    const v = req.body?.value;
    if (v !== null && (typeof v !== 'string' || !/^sk-ant-[A-Za-z0-9_-]{20,300}$/.test(v.trim()))) {
      return reply.code(400).send({ error: 'paste a Claude token (sk-ant-oat…) or an Anthropic API key (sk-ant-api…)' });
    }
    return { ...(await setCredential(v)), connectSupported: connectSupported() };
  });
  app.post('/api/genie/connect/start', async (_req, reply) => {
    const r = await startConnect();
    return 'error' in r ? reply.code(409).send(r) : r;
  });
  app.post<{ Body: { code?: string } }>('/api/genie/connect/finish', async (req, reply) => {
    const r = await finishConnect(String(req.body?.code ?? ''));
    return 'error' in r ? reply.code(400).send(r) : { ...r, connectSupported: connectSupported() };
  });
  app.post('/api/genie/connect/cancel', async () => { cancelConnect(); return { ok: true }; });

  app.get('/api/autobackup', async () => loadAutobackup());
  app.put<{ Body: Partial<AutobackupConfig> }>('/api/autobackup', async (req) =>
    saveAutobackup(req.body ?? {}),
  );
}
