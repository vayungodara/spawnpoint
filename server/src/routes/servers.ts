import type { FastifyInstance } from 'fastify';
import { craftyApi, CraftyError } from '../clients/crafty.js';
import { rconCommand } from '../clients/rcon.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { listServers, setActiveUuid, getActiveUuid, serverDir } from '../services/servers.js';
import { readProperties, patchProperties } from '../services/properties.js';
import { setOverride } from '../services/detect.js';
import { serverPhase } from '../services/phase.js';
import { loadSettings } from '../config.js';
import { getJoinAddress } from '../clients/playit.js';
import { markRunning } from '../services/bootrestore.js';
import { applyPending, listPending } from '../services/pendingmods.js';
import { derivedRcon } from '../services/ports.js';
import { deleteServer } from '../services/serverdelete.js';

/** Wait for the JVM to actually let go of its jars, then apply what the player
 *  queued. Crafty reports "stopped" the moment the process exits, but Windows can
 *  hold the file handles a beat longer — so retry rather than trusting one shot. */
async function applyWhenDown(id: string, timeoutMs = 90_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let applied = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    let running = true;
    try {
      running = (await craftyApi.getStats(id)).running;
    } catch {
      running = true; // can't tell => assume it's still up rather than fight the lock
    }
    if (running) continue;
    const res = applyPending(id);
    applied += res.applied.length;
    if (res.stillLocked.length === 0) return applied;
  }
  return applied;
}

export default async function serverRoutes(app: FastifyInstance) {
  app.get('/api/servers', async () => ({ servers: await listServers(), active: getActiveUuid() }));

  app.post<{ Body: { id: string } }>('/api/servers/active', async (req) => {
    setActiveUuid(req.body.id);
    return { ok: true, active: req.body.id };
  });

  app.get<{ Params: { id: string } }>('/api/servers/:id/stats', async (req) => {
    const stats = await craftyApi.getStats(req.params.id);
    const phase = await serverPhase(req.params.id, !!stats.running);
    return { ...stats, phase };
  });

  app.get<{ Params: { id: string }; Querystring: { tail?: string } }>(
    '/api/servers/:id/logs',
    async (req) => {
      const lines = await craftyApi.getLogs(req.params.id);
      const tail = Math.min(parseInt(req.query.tail ?? '200', 10), 1000);
      // hide the panel's own RCON plumbing (HUD/auto-stop polling) — vanilla
      // logs two thread lines per connection and echoes command feedback
      const clean = lines.filter((l) => !/RCON (Listener|Client)|\[Rcon:/.test(l));
      return { lines: clean.slice(-tail) };
    },
  );

  // full server deletion — the last operation that needed the Crafty UI.
  // Stopped servers only; requires the exact server name as confirmation;
  // world gets a final backup zip before anything is removed (skippable —
  // owner's toggle for throwaway servers whose worlds zip for minutes).
  app.delete<{ Params: { id: string }; Body: { confirmName?: string; skipBackup?: boolean } }>(
    '/api/servers/:id',
    async (req, reply) => {
      const SERVER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!SERVER_UUID.test(req.params.id)) return reply.code(400).send({ error: 'bad server id' });
      const r = await deleteServer(req.params.id, String(req.body?.confirmName ?? ''), !!req.body?.skipBackup);
      if (!r.ok) return reply.code(400).send(r);
      if (getActiveUuid() === req.params.id) setActiveUuid(''); // empty file = no active server
      return r;
    },
  );

  app.post<{ Params: { id: string }; Body: { action: 'start' | 'stop' | 'restart' } }>(
    '/api/servers/:id/action',
    async (req) => {
      // Mod changes the player made while the server was running were queued
      // (Windows locks loaded jars). The server is down NOW, so apply them
      // before it comes back up — a disable requested mid-game takes effect on
      // exactly the restart the player expected it to.
      if (req.body.action !== 'stop') {
        try {
          const { applied } = applyPending(req.params.id);
          if (applied.length) app.log.info(`applied ${applied.length} queued mod change(s) before start`);
        } catch { /* never block a start over this */ }
      }

      // first boots die instantly on an unaccepted Minecraft EULA, and Crafty
      // only surfaces its accept dialog in its own UI — starting from
      // Spawnpoint counts as the user accepting it, so write the file here
      if (req.body.action !== 'stop') {
        try {
          const eula = join(serverDir(req.params.id), 'eula.txt');
          if (!existsSync(eula) || !/^\s*eula\s*=\s*true/im.test(readFileSync(eula, 'utf8'))) {
            // EXACTLY the 9 bytes "eula=true" — no comment line, NO TRAILING
            // NEWLINE. Crafty compares this file's contents literally; any
            // extra byte makes it decide the EULA is not accepted, and it then
            // ABORTS the launch silently: it logs "Launching Server …", spawns
            // no process, prints no error, and the panel sits on "starting"
            // forever. Three servers were unbootable because of a `\n`.
            writeFileSync(eula, 'eula=true', 'utf8');
          }
        } catch { /* dir not on disk yet — Crafty will complain instead */ }
        // RCON powers exact joinable detection + the in-game HUD; Crafty
        // creates servers without it, so provision it (unique port, random
        // password) on every start. Loader-independent by design.
        try {
          const props = readProperties(req.params.id);
          if (props['enable-rcon'] !== 'true' || !props['rcon.password']) {
            const gamePort = parseInt(props['server-port'] ?? '25565', 10);
            patchProperties(req.params.id, {
              'enable-rcon': 'true',
              'rcon.port': String(derivedRcon(gamePort)), // unique per server (game + 10000)
              'rcon.password': props['rcon.password'] || randomBytes(9).toString('base64url'),
              'broadcast-rcon-to-ops': 'false',
            });
          }
        } catch { /* no server.properties yet — first boot will create one */ }
      }
      const id = req.params.id;
      const pending = listPending(id).length;

      // A RESTART with queued mod changes cannot use Crafty's restart_server:
      // that stops and starts in one motion, and the jars are only free in the
      // gap between — which we never get to see. Drive it ourselves: stop, wait
      // for the process to actually let go, apply, then start.
      if (req.body.action === 'restart' && pending > 0) {
        await craftyApi.action(id, 'stop_server');
        void (async () => {
          try {
            const applied = await applyWhenDown(id);
            app.log.info(`restart: applied ${applied} queued mod change(s) while the server was down`);
          } catch (e) {
            app.log.error(`restart: could not apply queued mod changes: ${String(e)}`);
          } finally {
            await craftyApi.action(id, 'start_server').catch(() => {});
          }
        })();
        return { ok: true, appliedPending: pending };
      }

      const map = { start: 'start_server', stop: 'stop_server', restart: 'restart_server' } as const;
      await craftyApi.action(id, map[req.body.action]);
      // record the intent NOW — boot-restore must never resurrect a server the
      // owner stopped seconds before an update-reboot
      markRunning(id, req.body.action !== 'stop');

      // On a plain STOP, flush the queue as soon as the jars are released, so
      // the change is already done next time the player looks.
      if (req.body.action === 'stop' && pending > 0) {
        void applyWhenDown(id).catch(() => {});
      }

      return { ok: true, ...(pending > 0 ? { appliedPending: pending } : {}) };
    },
  );

  app.post<{ Params: { id: string }; Body: { cmd: string } }>(
    '/api/servers/:id/command',
    async (req, reply) => {
      const { id } = req.params;
      const { cmd } = req.body;
      if (!cmd || cmd.length > 500) return reply.code(400).send({ error: 'bad command' });
      try {
        await craftyApi.sendStdin(id, cmd);
        return { ok: true, via: 'crafty' };
      } catch (e) {
        if (e instanceof CraftyError && e.status === 404) {
          const out = await rconCommand(id, cmd);
          return { ok: true, via: 'rcon', output: out };
        }
        throw e;
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { loader?: string; mc?: string } }>(
    '/api/servers/:id/detection-override',
    async (req) => {
      setOverride(req.params.id, req.body as never);
      return { ok: true };
    },
  );

  // Crafty runs on this same box, so hand the browser whatever host it used
  // to reach the panel (Tailscale IP, LAN IP, hostname — all work). The old
  // hardcoded Tailscale IP went stale the day the box was reinstalled.
  app.get('/api/crafty/url', async (req) => {
    const host = String(req.headers.host ?? '').split(':')[0] || 'localhost';
    return { url: loadSettings().craftyUrl.replace('localhost', host) };
  });

  app.get('/api/playit/address', async () => ({ address: await getJoinAddress() }));
}
