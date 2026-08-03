import type { FastifyInstance } from 'fastify';
import { readProperties, patchProperties } from '../services/properties.js';
import { listPlayers, upsertPlayer, removePlayer } from '../services/players.js';
import { applyModePreset, setOnlineMode, getJvmHeap, setJvmHeap } from '../services/presets.js';
import { restartFlags } from '../services/restartFlags.js';
import { craftyApi } from '../clients/crafty.js';
import { rconCommand } from '../clients/rcon.js';
import { portAudit, reportServer, suggestGamePort } from '../services/ports.js';

export default async function configRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/api/servers/:id/properties', async (req) => ({
    properties: readProperties(req.params.id),
    restartRequired: restartFlags.has(req.params.id),
  }));

  app.patch<{ Params: { id: string }; Body: Record<string, string> }>(
    '/api/servers/:id/properties',
    async (req) => {
      patchProperties(req.params.id, req.body);
      restartFlags.set(req.params.id);
      return { ok: true, restartRequired: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { preset: 'hardcore' | 'survival'; keepOps?: boolean } }>(
    '/api/servers/:id/preset',
    async (req, reply) => {
      // the preset now applies across a stop (level.dat can only be patched
      // while the server is down) and restarts itself if it was running
      const res = await applyModePreset(req.params.id, req.body.preset, req.body.keepOps ?? false);
      if (res.error) return reply.code(409).send({ ok: false, error: res.error });
      if (!res.restarted) restartFlags.set(req.params.id);
      return { ok: true, restartRequired: !res.restarted, restarted: res.restarted };
    },
  );

  app.post<{ Params: { id: string }; Body: { online: boolean } }>(
    '/api/servers/:id/online-mode',
    async (req) => {
      setOnlineMode(req.params.id, req.body.online);
      restartFlags.set(req.params.id);
      return { ok: true, restartRequired: true };
    },
  );

  // getJvmHeap now reports the heap the JVM will REALLY get (Forge reads
  // user_jvm_args.txt and ignores the command's -Xmx; a "8GB" Forge server was
  // silently running on the JVM default because of exactly this)
  app.get<{ Params: { id: string } }>('/api/servers/:id/jvm', async (req) => getJvmHeap(req.params.id));

  app.put<{ Params: { id: string }; Body: { gb: number } }>('/api/servers/:id/jvm', async (req) => {
    const { gb } = req.body;
    if (!gb || gb < 1 || gb > 12) throw new Error('heap must be 1-12 GB on this machine');
    const res = await setJvmHeap(req.params.id, gb);
    restartFlags.set(req.params.id);
    return { ok: true, restartRequired: true, appliedTo: res.source };
  });

  app.get<{ Params: { id: string } }>('/api/servers/:id/players', async (req) => ({
    players: listPlayers(req.params.id),
  }));

  app.post<{ Params: { id: string }; Body: { name: string; whitelist?: boolean; op?: boolean } }>(
    '/api/servers/:id/players',
    async (req) => {
      const p = upsertPlayer(req.params.id, req.body.name.trim(), {
        whitelist: req.body.whitelist ?? true,
        op: req.body.op ?? false,
      });
      // apply live if the server is up (harmless if not)
      try {
        await rconCommand(req.params.id, 'whitelist reload');
      } catch {
        /* offline or RCON disabled — applies on next restart */
      }
      return { ok: true, player: p };
    },
  );

  app.delete<{ Params: { id: string; name: string } }>(
    '/api/servers/:id/players/:name',
    async (req) => {
      removePlayer(req.params.id, req.params.name);
      try {
        await rconCommand(req.params.id, 'whitelist reload');
      } catch { /* applies on restart */ }
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>('/api/servers/:id/apply-restart', async (req) => {
    await craftyApi.action(req.params.id, 'restart_server');
    restartFlags.clear(req.params.id);
    return { ok: true };
  });

  // Fleet-wide port collision audit (game + rcon), for the Config banner.
  app.get('/api/ports/audit', async () => portAudit());

  // Suggested next free port when the user opens the "change port" control.
  app.get<{ Params: { id: string } }>('/api/servers/:id/port/suggest', async (req) => ({
    port: await suggestGamePort(req.params.id),
  }));

  // Move a server to a new game port (rcon.port + query.port follow). Refuses a
  // running server; keeps a .bak and syncs Crafty. 409 on any rejection.
  app.post<{ Params: { id: string }; Body: { port: number; force?: boolean } }>(
    '/api/servers/:id/port',
    async (req, reply) => {
      const res = await reportServer(req.params.id, Number(req.body?.port), { force: req.body?.force });
      if (!res.ok) return reply.code(409).send(res);
      restartFlags.set(req.params.id);
      return { ...res, restartRequired: true };
    },
  );
}
