import type { FastifyInstance } from 'fastify';
import { resetPlayers, listBackups, createBackup, restoreBackup, deleteBackup } from '../services/maintenance.js';
import { autostopStatus, saveAutostop, type AutostopConfig } from '../services/autostop.js';
import { listConfigs, readConfig, writeConfig } from '../services/modconfigs.js';
import { loadHud, saveHud, type HudConfig } from '../services/ingamehud.js';
import { sweepCrashedClientMods } from '../services/clientsweep.js';
import { getPerfMode, setPerfMode } from '../services/perfmode.js';
import { loadGenie, saveGenie, genieBusy, injectWish, type GenieConfig } from '../services/chatgenie.js';
import { scanAll, clean } from '../services/cleaner.js';
import { listSlots, renameSlot, switchSlot, resetSlot, worldOpProgress } from '../services/worldslots.js';
import { loadTasks, upsertTask, deleteTask, type SchedTask } from '../services/scheduler.js';
import { tpsHistory, tpsSource } from '../services/tpsmonitor.js';
import { listSchematics, importSchematic, deleteSchematic } from '../services/schematics.js';
import {
  listTargets,
  plan as planVersion,
  apply as applyVersion,
  rollback as rollbackVersion,
  snapshotInfo,
} from '../services/versionswitch.js';
import { rconCommand } from '../clients/rcon.js';

export default async function maintenanceRoutes(app: FastifyInstance) {
  app.get('/api/autostop', async () => autostopStatus());

  app.get<{ Params: { id: string } }>('/api/servers/:id/worlds', async (req) => listSlots(req.params.id));
  // live progress of a running reset/switch (null when idle) — feeds the
  // Worlds card's progress bar; the record self-clears ~12s after finishing
  app.get<{ Params: { id: string } }>('/api/servers/:id/worlds/progress', async (req) => ({
    progress: worldOpProgress(req.params.id),
  }));
  app.put<{ Params: { id: string }; Body: { n: number; name: string } }>(
    '/api/servers/:id/worlds/name',
    async (req) => {
      renameSlot(req.params.id, Number(req.body.n), String(req.body.name ?? ''));
      return listSlots(req.params.id);
    },
  );
  app.post<{ Params: { id: string }; Body: { n: number; start?: boolean; seed?: string } }>(
    '/api/servers/:id/worlds/switch',
    async (req) => switchSlot(req.params.id, Number(req.body.n), { start: !!req.body.start, seed: req.body.seed ? String(req.body.seed) : undefined }),
  );
  app.post<{ Params: { id: string }; Body: { n: number; seed?: string } }>(
    '/api/servers/:id/worlds/reset',
    async (req) => resetSlot(req.params.id, Number(req.body.n), req.body.seed ? String(req.body.seed) : undefined),
  );

  // ---- task scheduler ----
  app.get('/api/scheduler', async () => ({ tasks: loadTasks() }));
  app.post<{ Body: Partial<SchedTask> }>('/api/scheduler', async (req) => ({ tasks: upsertTask(req.body ?? {}) }));
  app.delete<{ Querystring: { id: string } }>('/api/scheduler', async (req) => ({ tasks: deleteTask(req.query.id) }));

  // ---- live players (RCON-truth, not Crafty's stale count) ----
  app.get<{ Params: { id: string } }>('/api/servers/:id/players/live', async (req) => {
    try {
      // Forge 1.20.1 RCON replies carry a trailing \n; `$` won't match past it
      // and `.` can't cross it, so the un-trimmed reply parsed as 0/0 — the
      // dashboard said "no players online" while the owner stood in the world.
      const out = (await rconCommand(req.params.id, 'list')).trim();
      const m = /There are (\d+) of a max of (\d+) players online:?\s*(.*)$/i.exec(out);
      const names = (m?.[3] ?? '').split(/,\s*/).map((s) => s.trim()).filter(Boolean);
      return { online: Number(m?.[1] ?? 0), max: Number(m?.[2] ?? 0), players: names };
    } catch {
      return { online: 0, max: 0, players: [], offline: true };
    }
  });
  app.post<{ Params: { id: string }; Body: { name: string; action: string; arg?: string } }>(
    '/api/servers/:id/players/act',
    async (req, reply) => {
      const name = String(req.body.name ?? '');
      if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) return reply.code(400).send({ error: 'bad player name' });
      const arg = String(req.body.arg ?? '').replace(/[\r\n]/g, ' ').slice(0, 120);
      const cmds: Record<string, string> = {
        kick: `kick ${name}${arg ? ` ${arg}` : ''}`,
        ban: `ban ${name}${arg ? ` ${arg}` : ''}`,
        op: `op ${name}`,
        deop: `deop ${name}`,
        msg: `tellraw ${name} [{"text":"[panel] ","color":"aqua"},{"text":${JSON.stringify(arg)},"color":"white"}]`,
        kill: `kill ${name}`,
        heal: `effect give ${name} minecraft:instant_health 1 10 true`,
      };
      const cmd = cmds[String(req.body.action)];
      if (!cmd) return reply.code(400).send({ error: 'unknown action' });
      const out = await rconCommand(req.params.id, cmd);
      return { ok: true, out: out.slice(0, 200) };
    },
  );

  // ---- TPS history ----
  // `source` tells the UI WHY a chart is empty: 1.20.1 has no `tick query`, so on
  // a Fabric server that old there is genuinely nothing to read without Spark.
  // An unexplained blank box reads as "the panel is broken".
  app.get<{ Params: { id: string } }>('/api/servers/:id/tps', async (req) => ({
    samples: tpsHistory(req.params.id),
    ...tpsSource(req.params.id),
  }));

  app.get('/api/cleaner/scan', async () => scanAll());
  app.post<{ Body: { serverId: string; keys: string[] } }>('/api/cleaner/clean', async (req) =>
    clean(req.body.serverId, Array.isArray(req.body.keys) ? req.body.keys.map(String) : []),
  );

  // ---- version switcher ----
  app.get('/api/versions/targets', async () => listTargets());
  app.get<{ Params: { id: string }; Querystring: { mc: string } }>(
    '/api/servers/:id/version/plan',
    async (req, reply) => {
      const mc = String(req.query.mc ?? '').trim();
      if (!/^[\w.\-+]{1,24}$/.test(mc)) return reply.code(400).send({ error: 'bad target version' });
      return planVersion(req.params.id, mc);
    },
  );
  app.post<{ Params: { id: string }; Body: { mc: string; acceptDowngrade?: boolean; disableIncompatible?: boolean } }>(
    '/api/servers/:id/version/apply',
    async (req, reply) => {
      const mc = String(req.body.mc ?? '').trim();
      if (!/^[\w.\-+]{1,24}$/.test(mc)) return reply.code(400).send({ error: 'bad target version' });
      const res = await applyVersion(req.params.id, mc, {
        acceptDowngrade: !!req.body.acceptDowngrade,
        disableIncompatible: !!req.body.disableIncompatible,
      });
      if (!res.ok) return reply.code(409).send(res);
      return res;
    },
  );
  app.post<{ Params: { id: string } }>('/api/servers/:id/version/rollback', async (req) => ({
    ok: await rollbackVersion(req.params.id),
  }));
  app.get<{ Params: { id: string } }>('/api/servers/:id/version/snapshot', async (req) => ({
    snapshot: snapshotInfo(req.params.id),
  }));

  // ---- schematic library (genie build templates) ----
  app.get('/api/schematics', async () => ({ schematics: listSchematics() }));
  app.post<{ Body: { filename: string; dataBase64: string } }>(
    '/api/schematics',
    { bodyLimit: 96 * 1024 * 1024 }, // base64 inflates 4/3; allows ~70MB files
    async (req, reply) => {
      try {
        const filename = String(req.body.filename ?? 'schematic.schem').replace(/[\\/]/g, '');
        const data = Buffer.from(String(req.body.dataBase64 ?? ''), 'base64');
        if (data.length === 0) return reply.code(400).send({ error: 'empty upload' });
        return importSchematic(filename, data);
      } catch (e) {
        return reply.code(400).send({ error: String((e as Error).message ?? e).slice(0, 300) });
      }
    },
  );
  app.delete<{ Querystring: { name: string } }>('/api/schematics', async (req) => {
    deleteSchematic(String(req.query.name ?? ''));
    return { schematics: listSchematics() };
  });

  app.get('/api/chatgenie', async () => loadGenie());
  app.get('/api/chatgenie/busy', async () => genieBusy());

  // localhost-only wish injection: the ONLY way to E2E-verify the genie without
  // a player in-game (RCON say never reaches latest.log on either era —
  // verified live, so the chat carrier physically cannot be driven remotely)
  app.post<{ Body: { serverId: string; player?: string; wish: string; secret?: boolean } }>(
    '/api/chatgenie/testwish',
    async (req, reply) => {
      if (req.ip !== '127.0.0.1' && req.ip !== '::1') return reply.code(403).send({ error: 'localhost only' });
      if (!req.body?.serverId || !req.body?.wish) return reply.code(400).send({ error: 'serverId and wish required' });
      injectWish(req.body.serverId, req.body.player ?? loadGenie().players[0] ?? 'Player', String(req.body.wish).slice(0, 300), !!req.body.secret, (m) => app.log.info(m));
      return { ok: true };
    },
  );
  app.put<{ Body: Partial<GenieConfig> }>('/api/chatgenie', async (req) => saveGenie(req.body ?? {}));

  app.get('/api/perfmode', async () => getPerfMode());
  app.put<{ Body: { loud: boolean } }>('/api/perfmode', async (req, reply) => {
    try {
      return await setPerfMode(!!req.body.loud);
    } catch {
      return reply.code(500).send({
        error: 'powercfg was denied — the panel is not elevated right now. Use the "Loud Mode"/"Quiet Mode" bat on the PC, or reboot (the boot task relaunches the panel elevated).',
      });
    }
  });

  app.post<{ Params: { id: string } }>('/api/servers/:id/sweep-crash', async (req) =>
    sweepCrashedClientMods(req.params.id),
  );

  app.get('/api/ingamehud', async () => loadHud());
  // Partial: the dashboard lever sends {enabled} alone; saveHud merges the rest
  app.put<{ Body: Partial<HudConfig> }>('/api/ingamehud', async (req) => saveHud(req.body ?? {}));

  app.put<{ Body: AutostopConfig }>('/api/autostop', async (req) => {
    return saveAutostop(req.body);
  });

  app.post<{ Params: { id: string } }>('/api/servers/:id/reset-players', async (req) => {
    return resetPlayers(req.params.id);
  });

  app.get<{ Params: { id: string } }>('/api/servers/:id/configs', async (req) => ({
    files: listConfigs(req.params.id),
  }));

  app.get<{ Params: { id: string }; Querystring: { path: string } }>(
    '/api/servers/:id/configs/file',
    async (req) => readConfig(req.params.id, req.query.path),
  );

  app.put<{ Params: { id: string }; Body: { path: string; content: string } }>(
    '/api/servers/:id/configs/file',
    async (req) => writeConfig(req.params.id, req.body.path, req.body.content),
  );

  app.get<{ Params: { id: string } }>('/api/servers/:id/backups', async (req) => ({
    backups: listBackups(req.params.id),
  }));

  app.post<{ Params: { id: string } }>('/api/servers/:id/backups', async (req) => {
    return createBackup(req.params.id);
  });

  app.post<{ Params: { id: string }; Body: { file: string } }>(
    '/api/servers/:id/backups/restore',
    async (req) => restoreBackup(req.params.id, req.body.file),
  );

  app.delete<{ Params: { id: string }; Querystring: { file: string } }>(
    '/api/servers/:id/backups',
    async (req) => {
      deleteBackup(req.params.id, req.query.file);
      return { ok: true };
    },
  );
}
