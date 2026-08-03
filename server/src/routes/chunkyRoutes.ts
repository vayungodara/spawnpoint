import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { bobbyStatus, buildFallback, zipPath } from '../services/bobbyfallback.js';
import {
  chunkyStatus,
  saveChunkyConfig,
  startPregen,
  pausePregen,
  resumePregen,
  cancelPregen,
  trimChunks,
  SHAPES,
  DIMENSIONS,
  type ChunkyServerConfig,
} from '../services/chunky.js';

// server ids are Crafty UUIDs; reject anything else so a crafted :id can't
// traverse out of the servers root via serverDir()'s path.join
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function chunkyRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    const id = (req.params as { id?: string })?.id;
    if (id !== undefined && !UUID.test(id)) return reply.code(400).send({ error: 'bad server id' });
  });

  // static option lists the UI renders dropdowns/checkboxes from
  app.get('/api/chunky/options', async () => ({ shapes: SHAPES, dimensions: DIMENSIONS }));

  // full status: installed? running? live progress + saved config
  app.get<{ Params: { id: string } }>('/api/servers/:id/chunky', async (req) => chunkyStatus(req.params.id));

  // save settings (radius/center/shape/dimensions/schedule/guard) without starting
  app.put<{ Params: { id: string }; Body: Partial<ChunkyServerConfig> }>(
    '/api/servers/:id/chunky/config',
    async (req) => ({ config: saveChunkyConfig(req.params.id, req.body) }),
  );

  // start with an optional inline override of the run parameters
  app.post<{
    Params: { id: string };
    Body: Partial<Pick<ChunkyServerConfig, 'radius' | 'centerMode' | 'centerX' | 'centerZ' | 'shape' | 'dimensions'>>;
  }>('/api/servers/:id/chunky/start', async (req, reply) => {
    const res = await startPregen(req.params.id, req.body ?? {});
    if ('error' in res) return reply.code(400).send(res);
    return res;
  });

  const control = (
    path: string,
    fn: (id: string) => Promise<{ ok: true } | { error: string }>,
  ) =>
    app.post<{ Params: { id: string } }>(`/api/servers/:id/chunky/${path}`, async (req, reply) => {
      const res = await fn(req.params.id);
      if ('error' in res) return reply.code(400).send(res);
      return res;
    });

  control('pause', pausePregen);
  control('continue', resumePregen);
  control('cancel', cancelPregen);
  control('trim', trimChunks);

  // ---- Bobby fallback-world export (pairs with a finished pregen) ----
  app.get<{ Params: { id: string } }>('/api/servers/:id/bobby', async (req) => bobbyStatus(req.params.id));

  app.post<{ Params: { id: string } }>('/api/servers/:id/bobby/build', async (req, reply) => {
    const res = await buildFallback(req.params.id, (m) => app.log.info(m));
    if ('error' in res) return reply.code(400).send(res);
    return res;
  });

  app.get<{ Params: { id: string } }>('/api/servers/:id/bobby/download', async (req, reply) => {
    const st = bobbyStatus(req.params.id);
    if (!st.ready) return reply.code(404).send({ error: 'no fallback world built yet' });
    reply.header('content-disposition', 'attachment; filename="bobby-fallback.zip"');
    reply.header('content-type', 'application/zip');
    return reply.send(createReadStream(zipPath(req.params.id)));
  });
}
