import type { FastifyInstance } from 'fastify';
import * as modrinth from '../clients/modrinth.js';
import type { ContentType } from '../clients/modrinth.js';
import { install, installCurseforge, installPerfPack, listInstalled, toggleInstalled, deleteInstalled, checkUpdates, updateAll } from '../services/installer.js';
import * as curseforge from '../clients/curseforge.js';
import { loadSettings } from '../config.js';
import { installModpack, installCurseforgeModpack } from '../services/modpack.js';
import {
  startCreateFromModpack,
  startCreateServer,
  listLoaders,
  listLoaderVersions,
  getJob,
} from '../services/servercreate.js';
import { detect } from '../services/detect.js';
import { serverDir } from '../services/servers.js';
import { syncAutoModpack } from '../services/automodpack.js';
import { craftyApi } from '../clients/crafty.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// server ids are Crafty UUIDs — same traversal guard as chunkyRoutes: a
// percent-encoded `..%2F` in :id would otherwise walk serverDir() out of the
// servers root (clientpack would happily zip up whatever it landed on)
const SERVER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function contentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    // create-job ids are 8-char tokens, NOT server UUIDs — this guard 400'd
    // every job-status poll, so creation progress never rendered and every
    // create click flashed "bad server id" (live 2026-08-02; the "server
    // just appears out of nowhere" report was this same bug from the start)
    if (req.routeOptions.url?.startsWith('/api/create-jobs/')) return;
    const id = (req.params as { id?: string })?.id;
    if (id !== undefined && !SERVER_UUID.test(id)) return reply.code(400).send({ error: 'bad server id' });
  });
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
    Body: { projectId: string; versionId?: string; type: ContentType; force?: boolean; source?: string };
  }>('/api/servers/:id/install', async (req, reply) => {
    // any mod change on an AutoModpack server must land in the synced modpack —
    // shelf jars bridge to host-modpack extras and the mod regenerates
    const resync = () => void syncAutoModpack(req.params.id, (m) => app.log.info(m));
    // install-time gate, BATCHED + ASYNC: installs return instantly; 12s
    // after the last one, a single dry-boot verifies the whole batch with the
    // real loader and auto-rolls-back rejects (reason in the panel log).
    // Returns true when a preflight was scheduled — in that case the SYNC IS
    // THE PREFLIGHT'S JOB, after the verdict. Syncing at install time pushed
    // an unproven jar into friends' clients through the live server's pack
    // regenerate: krypton was rejected by the gate 4 minutes after AutoModpack
    // had already delivered it to a client, which then crashed at boot
    // (live 2026-07-27, the exact hole the four gates exist to close).
    const gate = async (r: { installed: { file: string; title: string; clientOnly?: boolean }[] }) => {
      if (req.body.type !== 'mod') return false;
      const serverJars = (r.installed ?? []).filter((i) => !i.clientOnly).map((i) => i.file);
      if (!serverJars.length) return false;
      const { schedulePreflight } = await import('../services/preflight.js');
      schedulePreflight(req.params.id, serverJars, (m) => app.log.info(m));
      return true;
    };
    if (req.body.source === 'curseforge') {
      if (req.body.type === 'modpack') {
        return installCurseforgeModpack(req.params.id, {
          modId: req.body.projectId,
          fileId: req.body.versionId,
        });
      }
      const r = await installCurseforge(req.params.id, {
        modId: req.body.projectId,
        fileId: req.body.versionId,
        type: req.body.type,
        force: req.body.force,
      });
      if (!('installed' in r) || !(await gate(r))) resync();
      return r;
    }
    if (req.body.type === 'modpack') {
      return installModpack(req.params.id, req.body);
    }
    const r = await install(req.params.id, req.body);
    let gated = false;
    if ('installed' in r) {
      gated = await gate(r);
      // shaders/resourcepacks land in the global downloads collection — on an
      // AutoModpack server they belong in the synced pack's extras instead
      if (req.body.type === 'shader' || req.body.type === 'resourcepack') {
        const { stageClientAsset } = await import('../services/automodpack.js');
        for (const i of r.installed) void stageClientAsset(req.params.id, req.body.type, i.file, (m) => app.log.info(m));
      }
    }
    if (!gated) resync();
    return r;
  });

  // (the old CLIENT PACK EXPORT routes lived here — retired 2026-07-20 in favor
  // of AutoModpack sync + the starter pack below. The solver survives untouched
  // in services/clientpack.ts as a cold archive; re-import exportClientPack and
  // re-add GET /api/servers/:id/clientpack to resurrect it.)

  // STARTER PACK — tiny one-time bootstrap (loader + AutoModpack + server
  // pre-registered); everything else syncs on first join. The heavy clientpack
  // export below is DEPRECATED and stays only as fallback if AutoModpack fails.
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>('/api/servers/:id/starterpack', async (req, reply) => {
    try {
      const name = (await craftyApi.listServers().catch(() => []))
        .find((s) => s.server_id === req.params.id)?.server_name ?? 'Server';
      const { buildStarterPack, buildStarterPackCF } = await import('../services/automodpack.js');
      const pack = req.query.format === 'curseforge'
        ? await buildStarterPackCF(req.params.id, name)
        : await buildStarterPack(req.params.id, name);
      reply
        .header('content-disposition', `attachment; filename="${pack.filename}"`)
        .header('content-length', String(pack.buffer.length))
        .type('application/x-modrinth-modpack+zip');
      return reply.send(pack.buffer);
    } catch (e) {
      return reply.code(500).send({ error: String((e as Error).message ?? e) });
    }
  });

  // tear down lanes whose server no longer exists in Crafty (relay unit +
  // firewall + SRV record + pack address). Idempotent; runs daily anyway.
  app.post('/api/lanes/cleanup', async () => {
    const { cleanupOrphanLanes } = await import('../services/lanes.js');
    const ids = new Set((await craftyApi.listServers()).map((s) => s.server_id));
    return cleanupOrphanLanes(ids, (m) => app.log.info(m));
  });

  // (re)provision a public lane for an EXISTING server: relay unit + SRV
  // record + pack-address entry. Idempotent — safe to press twice.
  app.post<{ Params: { id: string } }>('/api/servers/:id/lane', async (req, reply) => {
    const srv = (await craftyApi.listServers().catch(() => []))
      .find((s) => s.server_id === req.params.id);
    if (!srv) return reply.code(404).send({ error: 'unknown server' });
    let port = 25565;
    try {
      const m = /^server-port=(\d+)/m.exec(
        readFileSync(join(serverDir(req.params.id), 'server.properties'), 'utf8'),
      );
      if (m) port = +m[1];
    } catch { /* default */ }
    const { ensureLane } = await import('../services/lanes.js');
    return ensureLane(req.params.id, srv.server_name, port);
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

  app.get<{ Params: { id: string } }>('/api/servers/:id/installed', async (req) => {
    const { recentRejections } = await import('../services/preflight.js');
    return {
      items: await listInstalled(req.params.id),
      detection: detect(serverDir(req.params.id), req.params.id),
      rejections: recentRejections(req.params.id),
    };
  });

  // the owner read the safety banner and moved on — stop showing it for 48h
  app.delete<{ Params: { id: string } }>('/api/servers/:id/rejections', async (req) => {
    const { clearRejections } = await import('../services/preflight.js');
    clearRejections(req.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/servers/:id/installed/updates', async (req) => ({
    updates: await checkUpdates(req.params.id),
  }));

  app.post<{ Params: { id: string } }>('/api/servers/:id/installed/update-all', async (req) => {
    const r = await updateAll(req.params.id);
    // same krypton rule as /install: updated server jars are unproven until the
    // dry-boot verdict, so the preflight owns the sync when any were installed
    if (r.serverJars.length) {
      const { schedulePreflight } = await import('../services/preflight.js');
      schedulePreflight(req.params.id, r.serverJars, (m) => app.log.info(m));
    } else {
      void syncAutoModpack(req.params.id, (m) => app.log.info(m));
    }
    return r;
  });

  app.post<{ Params: { id: string }; Body: { includeOptional?: boolean; force?: boolean } }>(
    '/api/servers/:id/perf-pack',
    async (req) => {
      const r = await installPerfPack(req.params.id, req.body ?? {});
      const serverJars =
        'installed' in r ? r.installed.filter((x) => !x.clientOnly).map((x) => x.file) : [];
      if (serverJars.length) {
        const { schedulePreflight } = await import('../services/preflight.js');
        schedulePreflight(req.params.id, serverJars, (m) => app.log.info(m));
      } else {
        void syncAutoModpack(req.params.id, (m) => app.log.info(m));
      }
      return r;
    },
  );

  // A jar the running server holds open cannot be renamed or deleted on Windows.
  // That is an expected refusal, not a crash: answer 409 with the REASON, so the
  // UI can tell the player to stop the server instead of appearing to do nothing.
  app.post<{ Params: { id: string }; Body: { file: string } }>(
    '/api/servers/:id/installed/toggle',
    async (req, reply) => {
      try {
        const r = toggleInstalled(req.params.id, req.body.file);
        void syncAutoModpack(req.params.id, (m) => app.log.info(m));
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
        void syncAutoModpack(req.params.id, (m) => app.log.info(m));
        return r;
      } catch (e) {
        return reply.code(409).send({ error: String((e as Error).message ?? e) });
      }
    },
  );
}
