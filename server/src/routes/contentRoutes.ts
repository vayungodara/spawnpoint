import type { FastifyInstance } from 'fastify';
import * as modrinth from '../clients/modrinth.js';
import type { ContentType } from '../clients/modrinth.js';
import { install, installCurseforge, listInstalled, toggleInstalled, deleteInstalled, checkUpdates, updateAll } from '../services/installer.js';
import * as curseforge from '../clients/curseforge.js';
import { loadSettings, PATHS } from '../config.js';
import {
  startCreateFromModpack,
  startCreateServer,
  listLoaders,
  listLoaderVersions,
  getJob,
} from '../services/servercreate.js';
import { detect } from '../services/detect.js';
import { serverDir } from '../services/servers.js';
import { publishPack, stageClientAsset, buildStarterPack, buildStarterPackCF } from '../services/automodpack.js';
import { candidate, approve, discard, retest, liveChanged, lastChange, undoLast, recentRejections, clearRejections, assertCanStage } from '../services/packtxn.js';
import { promotion, lastSeen, choose, cancelUndo } from '../services/promote.js';
import { craftyApi } from '../clients/crafty.js';
import { join } from 'node:path';

/** A change waiting for a restart, with the players it waits on. */
function promotionView(id: string) {
  const p = promotion(id);
  const seen = lastSeen(id);
  return p && {
    action: p.action, txn: p.txn, choice: p.choice ?? null, restarting: !!p.stage,
    stopped: seen === 'stopped', unknown: seen === 'unknown', players: typeof seen === 'number' ? seen : null,
  };
}

export default async function contentRoutes(app: FastifyInstance) {
  const log = (m: string): void => app.log.info(m);
  app.get<{
    Querystring: {
      q?: string; type?: ContentType; mc?: string; loader?: string;
      categories?: string; sort?: string; offset?: string; source?: string;
    };
  }>('/api/content/search', async (req) => {
    const { q, type = 'mod', mc, loader, categories, sort, offset, source } = req.query;
    if (source === 'curseforge') {
      return curseforge.search({
        query: q,
        type,
        mc,
        loader,
        sort: sort ?? 'downloads',
        offset: offset ? parseInt(offset, 10) : 0,
        limit: 20,
      });
    }
    return modrinth.search({
      query: q,
      type,
      mc,
      loader,
      categories: categories ? categories.split(',').filter(Boolean) : undefined,
      sort: (sort as never) ?? 'relevance',
      offset: offset ? parseInt(offset, 10) : 0,
      limit: 20,
    });
  });

  app.get<{ Params: { slug: string } }>('/api/content/project/:slug', async (req) => {
    return modrinth.getProject(req.params.slug);
  });

  app.get<{ Params: { slug: string }; Querystring: { mc?: string; loader?: string } }>(
    '/api/content/project/:slug/versions',
    async (req) => ({
      versions: (await modrinth.getVersions(req.params.slug, req.query)).slice(0, 30),
    }),
  );

  // source-agnostic project expansion for the Browse view: description +
  // pickable versions, one shape for both Modrinth and CurseForge
  app.get<{
    Querystring: { projectId: string; source?: string; mc?: string; loader?: string };
  }>('/api/content/expand', async (req) => {
    const { projectId, source, mc, loader } = req.query;
    if (source === 'curseforge') {
      const [mod, files, description] = await Promise.all([
        curseforge.getMod(projectId),
        curseforge.getFiles(projectId, { mc, loader }),
        curseforge.getDescription(projectId).catch(() => ''),
      ]);
      return {
        description: description.slice(0, 4000) || mod.summary,
        versions: files.slice(0, 25).map((f) => ({
          id: String(f.id),
          name: f.displayName,
          date: f.fileDate,
          mc: f.gameVersions.filter((v) => /^\d/.test(v)),
          downloadable: !!f.downloadUrl,
        })),
      };
    }
    const [proj, versions] = await Promise.all([
      modrinth.getProject(projectId),
      modrinth.getVersions(projectId, { mc, loader }),
    ]);
    // body is markdown — drop images/badges and raw html for plain-text display
    const plain = (proj.body || proj.description)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return {
      description: plain.slice(0, 4000),
      versions: versions.slice(0, 25).map((v) => ({
        id: v.id,
        name: `${v.version_number}${v.version_type !== 'release' ? ` (${v.version_type})` : ''}`,
        date: v.date_published,
        mc: v.game_versions,
        downloadable: true,
      })),
    };
  });

  app.post<{
    Params: { id: string };
    Body: { projectId: string; versionId?: string; type: ContentType; source?: string };
  }>('/api/servers/:id/install', async (req, reply) => {
    const id = req.params.id;
    const { projectId, versionId, type } = req.body;
    if (type === 'modpack') {
      return { error: 'a modpack becomes its own server: create a new server from it instead' };
    }
    // a refusal (a change is going in, an undo waits) is the owner's to read, not a crash
    try { assertCanStage(id); } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
    const r = req.body.source === 'curseforge'
      ? await installCurseforge(id, { modId: projectId, fileId: versionId, type }, log)
      : await install(id, { projectId, versionId, type }, log);
    // resource and shader packs belong in the synced pack on AutoModpack servers
    if (type === 'shader' || type === 'resourcepack') {
      for (const i of r.installed) void stageClientAsset(id, type, join(PATHS.downloads, i.file), log);
    }
    return r;
  });

  // the mod change waiting for (or done with) its boot test
  app.get<{ Params: { id: string } }>('/api/servers/:id/candidate', async (req) => ({ candidate: candidate(req.params.id), promotion: promotionView(req.params.id) }));
  app.post<{ Params: { id: string } }>('/api/servers/:id/candidate/apply', async (req) => ({ candidate: await approve(req.params.id, log) }));
  app.get<{ Params: { id: string } }>('/api/servers/:id/last-change', async (req) => ({ change: lastChange(req.params.id) }));
  app.post<{ Params: { id: string } }>('/api/servers/:id/last-change/undo', async (req, reply) => {
    try {
      const { waiting, ...change } = await undoLast(req.params.id, log);
      return { change, waiting: !!waiting, promotion: promotionView(req.params.id) };
    } catch (e) {
      return reply.code(409).send({ error: String((e as Error).message ?? e) });
    }
  });
  // a change waiting for the server to restart: the owner picks when
  app.post<{ Params: { id: string }; Body: { choice: 'now' | 'when-empty' } }>('/api/servers/:id/promotion', async (req, reply) => {
    if (req.body?.choice !== 'now' && req.body?.choice !== 'when-empty') return reply.code(400).send({ error: 'choice must be "now" or "when-empty"' });
    try {
      choose(req.params.id, req.body.choice, log);
      return { promotion: promotionView(req.params.id) };
    } catch (e) {
      return reply.code(409).send({ error: String((e as Error).message ?? e) });
    }
  });
  app.delete<{ Params: { id: string } }>('/api/servers/:id/promotion', async (req, reply) => {
    try {
      cancelUndo(req.params.id);
      return { promotion: promotionView(req.params.id) };
    } catch (e) {
      return reply.code(409).send({ error: String((e as Error).message ?? e) });
    }
  });
  app.post<{ Params: { id: string } }>('/api/servers/:id/candidate/retest', async (req) => {
    retest(req.params.id, log);
    return { candidate: candidate(req.params.id) };
  });
  app.delete<{ Params: { id: string } }>('/api/servers/:id/candidate', async (req, reply) => {
    try {
      discard(req.params.id);
    } catch (e) {
      return reply.code(409).send({ error: String((e as Error).message ?? e) });
    }
    return { candidate: candidate(req.params.id) };
  });

  // STARTER PACK: a tiny one-time bootstrap (loader + AutoModpack + the
  // server in the multiplayer list); everything else syncs on first join.
  // Friends join at the host this browser used to reach the panel.
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>('/api/servers/:id/starterpack', async (req, reply) => {
    try {
      const srv = (await craftyApi.listServers()).find((s) => s.server_id === req.params.id);
      if (!srv) return reply.code(404).send({ error: 'unknown server' });
      const address = srv.server_port === 25565 ? req.hostname : `${req.hostname}:${srv.server_port}`;
      const pack = req.query.format === 'curseforge'
        ? await buildStarterPackCF(req.params.id, srv.server_name, address)
        : await buildStarterPack(req.params.id, srv.server_name, address);
      reply
        .header('content-disposition', `attachment; filename="${pack.filename}"`)
        .type(req.query.format === 'curseforge' ? 'application/zip' : 'application/x-modrinth-modpack+zip');
      return reply.send(pack.buffer);
    } catch (e) {
      return reply.code(500).send({ error: String((e as Error).message ?? e) });
    }
  });

  // one-click new server from a modpack (background job; poll /api/create-jobs/:id)
  app.post<{
    Body: { name?: string; projectId: string; versionId?: string; source?: string; memGb?: number };
  }>('/api/servers/create-from-modpack', async (req) =>
    startCreateFromModpack({ ...req.body, source: req.body.source ?? 'modrinth' }),
  );

  // ---- create a plain server: any loader, any version, no Crafty visit ----
  app.get('/api/loaders', async () => ({ loaders: listLoaders() }));
  app.get<{ Querystring: { loader: string } }>('/api/loaders/versions', async (req, reply) => {
    try {
      return { versions: await listLoaderVersions(String(req.query.loader ?? '')) };
    } catch (e) {
      return reply.code(400).send({ error: String((e as Error).message ?? e) });
    }
  });
  app.post<{ Body: { name?: string; loader: string; mc: string; memGb?: number } }>(
    '/api/servers/create',
    async (req, reply) => {
      const loader = String(req.body.loader ?? '');
      const mc = String(req.body.mc ?? '');
      if (!loader || !mc) return reply.code(400).send({ error: 'loader and mc are required' });
      return startCreateServer({
        name: String(req.body.name ?? '').slice(0, 40),
        loader,
        mc,
        memGb: req.body.memGb,
      });
    },
  );

  app.get<{ Params: { id: string } }>('/api/create-jobs/:id', async (req, reply) => {
    const job = getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: 'unknown job' });
    return job;
  });

  // every creation this panel run knows about — the Servers page shows
  // in-progress ones no matter which page kicked them off
  app.get('/api/create-jobs', async () => {
    const { listJobs } = await import('../services/servercreate.js');
    return { jobs: listJobs() };
  });

  app.get('/api/content/sources', async () => ({
    modrinth: true,
    curseforge: !!loadSettings().curseforgeApiKey,
  }));

  app.get<{ Params: { id: string } }>('/api/servers/:id/installed', async (req) => ({
    items: await listInstalled(req.params.id),
    detection: detect(serverDir(req.params.id), req.params.id),
    rejections: recentRejections(req.params.id),
    candidate: candidate(req.params.id),
    promotion: promotionView(req.params.id),
  }));

  // the owner has read the rejection banner
  app.delete<{ Params: { id: string } }>('/api/servers/:id/rejections', async (req) => {
    clearRejections(req.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/servers/:id/installed/updates', async (req) => ({
    updates: await checkUpdates(req.params.id),
  }));

  app.post<{ Params: { id: string } }>('/api/servers/:id/installed/update-all', async (req) => updateAll(req.params.id, log));


  // A jar the running server holds open cannot be renamed or deleted on Windows.
  // That is an expected refusal, not a crash: answer 409 with the REASON, so the
  // UI can tell the player to stop the server instead of appearing to do nothing.
  app.post<{ Params: { id: string }; Body: { file: string } }>(
    '/api/servers/:id/installed/toggle',
    async (req, reply) => {
      try {
        const r = toggleInstalled(req.params.id, req.body.file);
        liveChanged(req.params.id, log);
        void publishPack(req.params.id, log);
        return r;
      } catch (e) {
        return reply.code(409).send({ error: String((e as Error).message ?? e) });
      }
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { file: string } }>(
    '/api/servers/:id/installed',
    async (req, reply) => {
      try {
        const r = { ok: true, ...deleteInstalled(req.params.id, req.query.file) };
        liveChanged(req.params.id, log);
        void publishPack(req.params.id, log);
        return r;
      } catch (e) {
        return reply.code(409).send({ error: String((e as Error).message ?? e) });
      }
    },
  );
}
