import type { FastifyInstance } from 'fastify';
import { craftyApi, CraftyError } from '../clients/crafty.js';
import { rconCommand } from '../clients/rcon.js';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { listServers, setActiveUuid, getActiveUuid, serverDir, pinJavaFor } from '../services/servers.js';
import { readProperties, patchProperties } from '../services/properties.js';
import { setOverride, detect } from '../services/detect.js';
import { serverPhase } from '../services/phase.js';
import { loadSettings, saveSettings } from '../config.js';
import { markRunning } from '../services/bootrestore.js';
import { applyPending, listPending } from '../services/pendingmods.js';
import { derivedRcon } from '../services/ports.js';
import { deleteServer } from '../services/serverdelete.js';
import { maintenanceOf, busyReason, clearInterrupted, beginMaintenance, endMaintenance } from '../services/maintenance.js';
import { restartServer, startServer } from '../services/promote.js';
import { nativeRecord, nativeRecords, supervisor, transferRecord } from '../services/native.js';
import { nativeInstallJob } from '../services/nativeinstall.js';
import { prepareCraftyImport, commitCraftyImport, abortCraftyImport } from '../services/nativeimport.js';

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

/** The last 2 MB of logs/latest.log as lines, with its modification time.
    Links are not followed: Minecraft writes a plain file there. */
function latestLog(id: string): { lines: string[]; mtime: Date } {
  const dir = join(serverDir(id), 'logs'), p = join(dir, 'latest.log');
  const st = lstatSync(p, { throwIfNoEntry: false });
  if (!st?.isFile() || lstatSync(dir).isSymbolicLink()) return { lines: [], mtime: new Date() };
  const max = 2 * 1024 * 1024;
  const fd = openSync(p, 'r');
  try {
    const want = Math.min(st.size, max);
    const buf = Buffer.alloc(want);
    const got = readSync(fd, buf, 0, want, st.size - want);
    const lines = buf.subarray(0, got).toString('utf8').split(/\r?\n/);
    if (st.size > max) lines.shift(); // a partial first line
    return { lines: lines.at(-1) === '' ? lines.slice(0, -1) : lines, mtime: st.mtime };
  } finally { closeSync(fd); }
}

/** Lines from the last `seconds`, by their [HH:MM:SS] stamps in local time.
    `newest` is when the last line was written (the file's mtime for a log
    file). Threads may log a second out of order; only a jump of an hour or
    more counts as crossing midnight. Untimed lines (stack frames) follow the
    line before them; a log with no stamps at all is returned whole. */
function linesSince(lines: string[], seconds: number, newest = new Date()): string[] {
  const cutoff = Date.now() - seconds * 1000;
  let later = newest.getTime() + 60_000, first = lines.length, stamped = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\[(\d{2}):(\d{2}):(\d{2})/.exec(lines[i]);
    if (!m) continue;
    stamped = true;
    const d = new Date(newest);
    d.setHours(+m[1], +m[2], +m[3], 0);
    let t = d.getTime();
    while (t > later + 3_600_000) t -= 86_400_000;
    if (t < cutoff) break;
    later = Math.min(later, t);
    first = i;
  }
  return stamped ? lines.slice(first) : lines;
}

export default async function serverRoutes(app: FastifyInstance) {
  app.get('/api/servers', async (_req, reply) => {
    try {
      return { servers: await listServers(), active: getActiveUuid(), warning: craftyApi.listingError };
    } catch (e) {
      // pre-setup there is no Crafty token yet — that's a state, not a 500
      if (String(e).includes('No Crafty API token')) {
        return reply.code(503).send({ error: 'Crafty is not connected yet — finish setup in the browser' });
      }
      throw e;
    }
  });

  app.post<{ Body: { id: string } }>('/api/servers/active', async (req) => {
    setActiveUuid(req.body.id);
    return { ok: true, active: req.body.id };
  });

  app.get<{ Params: { id: string } }>('/api/servers/:id/stats', async (req) => {
    const stats = await craftyApi.getStats(req.params.id);
    const phase = await serverPhase(req.params.id, !!stats.running);
    return { ...stats, phase, maintenance: maintenanceOf(req.params.id) };
  });

  // an operation a panel restart cut short keeps the server fenced until the owner has looked
  app.post<{ Params: { id: string } }>('/api/servers/:id/maintenance/clear', async (req, reply) => {
    const m = maintenanceOf(req.params.id);
    if (m && !clearInterrupted(req.params.id)) return reply.code(409).send({ error: `${m.op} is still running` });
    return { ok: true };
  });

  // the live console tail, or logs/latest.log with `file=latest`; `since`
  // (seconds) is judged on the server's own clock, which log times use
  app.get<{ Params: { id: string }; Querystring: { tail?: string; since?: string; file?: string } }>(
    '/api/servers/:id/logs',
    async (req) => {
      const { lines, mtime } = req.query.file === 'latest' ? latestLog(req.params.id) : { lines: await craftyApi.getLogs(req.params.id), mtime: new Date() };
      const tail = Math.min(parseInt(req.query.tail ?? '200', 10) || 200, req.query.file === 'latest' ? 5000 : 1000);
      // hide the panel's own RCON plumbing (HUD/auto-stop polling) — vanilla
      // logs two thread lines per connection and echoes command feedback
      const clean = lines.filter((l) => !/RCON (Listener|Client)|\[Rcon:/.test(l));
      const since = parseInt(req.query.since ?? '', 10);
      return { lines: (since > 0 ? linesSince(clean, since, mtime) : clean).slice(-tail) };
    },
  );

  // full server deletion — the last operation that needed the Crafty UI.
  // Stopped servers only; requires the exact server name as confirmation;
  // world gets a final backup zip before anything is removed (skippable —
  // owner's toggle for throwaway servers whose worlds zip for minutes).
  app.delete<{ Params: { id: string }; Body: { confirmName?: string; skipBackup?: boolean } }>(
    '/api/servers/:id',
    async (req, reply) => {
      const r = await deleteServer(req.params.id, String(req.body?.confirmName ?? ''), !!req.body?.skipBackup);
      if (!r.ok) return reply.code(400).send(r);
      if (getActiveUuid() === req.params.id) setActiveUuid(''); // empty file = no active server
      return r;
    },
  );

  app.post<{ Params: { id: string }; Body: { action: 'start' | 'stop' | 'restart' } }>(
    '/api/servers/:id/action',
    async (req, reply) => {
      const busy = busyReason(req.params.id);
      if (busy) return reply.code(409).send({ error: busy });
      const install = nativeInstallJob(req.params.id);
      if (req.body.action !== 'stop' && install && install.phase !== 'done') return reply.code(409).send({ error: 'finish or recover the complete server installation before starting it' });
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
      if (req.body.action !== 'stop') {
        const det = detect(serverDir(id), id);
        await pinJavaFor(id, det.mc, det.loader).catch(() => false);
      }
      const pending = listPending(id).length;

      // A RESTART with queued mod changes cannot use Crafty's restart_server:
      // that stops and starts in one motion, and the jars are only free in the
      // gap between — which we never get to see. Drive it ourselves: stop, wait
      // for the process to actually let go, apply, then start.
      // Queued changes go first; a mod change waiting for a restart is retested
      // against them (liveChanged) and goes in on a later restart.
      if (req.body.action === 'restart' && pending > 0) {
        const refused = beginMaintenance(id, 'restart');
        if (refused) return reply.code(409).send({ error: refused });
        void (async () => {
          try {
            await craftyApi.action(id, 'stop_server');
            const applied = await applyWhenDown(id);
            app.log.info(`restart: applied ${applied} queued mod change(s) while the server was down`);
          } catch (e) {
            app.log.error(`restart: could not apply queued mod changes: ${String(e)}`);
          } finally {
            await craftyApi.action(id, 'start_server').catch(() => {});
            endMaintenance(id, 'restart');
          }
        })();
        return { ok: true, appliedPending: pending };
      }

      // starts and restarts put a waiting mod change in and check its boot;
      // both refuse if another operation took the server meanwhile
      if (req.body.action === 'stop') {
        await craftyApi.action(id, 'stop_server');
      } else {
        try {
          const { promoting } = await (req.body.action === 'start' ? startServer : restartServer)(id, (m) => app.log.info(m));
          markRunning(id, true);
          if (promoting) return { ok: true, promoting };
        } catch (e) {
          return reply.code(409).send({ error: (e as Error).message });
        }
      }
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
  // to reach the panel (Tailscale IP, LAN IP, hostname — all work)
  app.get('/api/crafty/url', async (req) => {
    const host = String(req.headers.host ?? '').split(':')[0] || 'localhost';
    return { url: loadSettings().craftyUrl.replace('localhost', host) };
  });

  app.get('/api/runtime', async () => ({
    mode: loadSettings().runtime,
    supervisor: await supervisor('health').then(() => true, () => false),
    native: nativeRecords().map((s) => ({ id: s.server_id, name: s.server_name, autoStart: s.auto_start, blocked: s.blocked })),
  }));
  app.post<{ Body: { mode: 'crafty' | 'standalone' } }>('/api/runtime', async (req, reply) => {
    if (!['crafty', 'standalone'].includes(req.body?.mode)) return reply.code(400).send({ error: 'choose crafty or standalone' });
    if (req.body.mode === 'standalone') await supervisor('health');
    const settings = loadSettings();
    settings.runtime = req.body.mode;
    saveSettings(settings);
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>('/api/servers/:id/runtime', async (req) => {
    const owned = nativeRecord(req.params.id), plan = transferRecord(req.params.id);
    return { owner: owned ? 'standalone' : 'crafty', autoStart: owned?.auto_start, blocked: owned?.blocked,
      transfer: plan ? { phase: plan.phase, revision: plan.revision } : null };
  });
  app.put<{ Params: { id: string }; Body: { autoStart: boolean } }>('/api/servers/:id/runtime', async (req, reply) => {
    if (!nativeRecord(req.params.id) || typeof req.body?.autoStart !== 'boolean') return reply.code(400).send({ error: 'a native server and an explicit autostart choice are required' });
    await craftyApi.patchServer(req.params.id, { auto_start: req.body.autoStart });
    return { ok: true };
  });
  app.post<{ Params: { id: string }; Body: { action: 'prepare' | 'commit' | 'abort'; revision?: string; approve?: boolean; craftyStopped?: boolean } }>(
    '/api/servers/:id/runtime/import', async (req, reply) => {
      if (req.body?.approve !== true) return reply.code(409).send({ error: 'explicit ownership-transfer consent is required; worlds are never restored' });
      if (req.body.action === 'commit' && req.body.craftyStopped !== true) return reply.code(409).send({ error: 'confirm the entire Crafty service or container and its workers have exited; a closed API port alone is not proof' });
      try {
        const id = req.params.id;
        if (req.body.action === 'prepare') return { ok: true, revision: (await prepareCraftyImport(id)).revision };
        if (req.body.action === 'commit') await commitCraftyImport(id, req.body.revision ?? '');
        else if (req.body.action === 'abort') await abortCraftyImport(id);
        else return reply.code(400).send({ error: 'choose prepare, commit or abort' });
        return { ok: true };
      } catch (error) { return reply.code(409).send({ error: String(error) }); }
    });
}
