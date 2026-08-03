import type { FastifyInstance } from 'fastify';
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join, resolve, sep, dirname, basename } from 'node:path';
import { chownSync, statSync as statS } from 'node:fs';
import { serverDir } from '../services/servers.js';

// WEB FILE MANAGER — browse/edit/upload/download any file under a server's
// directory from the panel. Every path is confined to the server dir (the one
// competitor feature Spawnpoint lacked; subsumes SFTP for daily use).

const SERVER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EDIT_MAX = 2 * 1024 * 1024; // editor refuses beyond 2MB — that's not a config file

/** Single-file version of platform.ts's chownToDirOwner: give the written
    file its parent dir's owner. -R on the parent would walk the whole world
    folder for a one-line config edit. Same never-fail contract. */
function chownFile(p: string): void {
  if (typeof process.getuid !== 'function') return;
  try {
    const { uid, gid } = statS(dirname(p));
    if (process.getuid() !== uid) chownSync(p, uid, gid);
  } catch { /* never fail the caller over ownership */ }
}

/** Resolve a user path INSIDE the server dir or throw. The resolve()+prefix
    check is the whole security story — every route funnels through here. */
function confine(id: string, rel: string): string {
  const root = resolve(serverDir(id));
  const p = resolve(join(root, rel));
  if (p !== root && !p.startsWith(root + sep)) throw new Error('path escapes server directory');
  return p;
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export default async function fileRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    const id = (req.params as { id?: string })?.id;
    if (id !== undefined && !SERVER_UUID.test(id)) return reply.code(400).send({ error: 'bad server id' });
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/servers/:id/files',
    async (req, reply) => {
      try {
        const dir = confine(req.params.id, req.query.path ?? '');
        if (!existsSync(dir)) return reply.code(404).send({ error: 'not found' });
        const entries = readdirSync(dir)
          .map((name) => {
            try {
              const st = statSync(join(dir, name));
              return { name, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs };
            } catch {
              return null; // vanished mid-listing / unreadable
            }
          })
          .filter((e): e is NonNullable<typeof e> => !!e)
          .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
        return { entries };
      } catch (e) {
        return reply.code(400).send({ error: String((e as Error).message ?? e).slice(0, 200) });
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { path: string } }>(
    '/api/servers/:id/files/content',
    async (req, reply) => {
      try {
        const p = confine(req.params.id, req.query.path);
        const st = statSync(p);
        if (st.isDirectory()) return reply.code(400).send({ error: 'is a directory' });
        if (st.size > EDIT_MAX) return { tooLarge: true, size: st.size };
        const buf = readFileSync(p);
        if (looksBinary(buf)) return { binary: true, size: st.size };
        return { content: buf.toString('utf8'), size: st.size };
      } catch (e) {
        return reply.code(400).send({ error: String((e as Error).message ?? e).slice(0, 200) });
      }
    },
  );

  app.put<{ Params: { id: string }; Body: { path: string; content: string } }>(
    '/api/servers/:id/files/content',
    { bodyLimit: 8 * 1024 * 1024 },
    async (req, reply) => {
      try {
        const p = confine(req.params.id, req.body.path);
        writeFileSync(p, req.body.content ?? '', 'utf8');
        chownFile(p); // root-vs-crafty ownership class — every panel write into server dirs
        return { ok: true };
      } catch (e) {
        return reply.code(400).send({ error: String((e as Error).message ?? e).slice(0, 200) });
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { path: string } }>(
    '/api/servers/:id/files/download',
    async (req, reply) => {
      try {
        const p = confine(req.params.id, req.query.path);
        const st = statSync(p);
        if (st.isDirectory()) return reply.code(400).send({ error: 'is a directory' });
        reply.header('content-disposition', `attachment; filename="${basename(p).replace(/"/g, '')}"`);
        reply.header('content-type', 'application/octet-stream');
        return reply.send(createReadStream(p));
      } catch (e) {
        return reply.code(400).send({ error: String((e as Error).message ?? e).slice(0, 200) });
      }
    },
  );

  // STREAMING UPLOAD — the old base64-in-JSON path made the BROWSER build a
  // ~1.3x copy of the file as one giant string (a 200MB Physics Mod jar froze
  // the tab, live 2026-07-21) and capped out at ~70MB server-side. This one
  // pipes bytes straight to disk. Uploads into mods/ also enter the normal
  // pipeline: dry-boot preflight + AutoModpack sync, and they appear in
  // Content → Installed like any panel install.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
  app.post<{ Params: { id: string }; Querystring: { path?: string; filename?: string } }>(
    '/api/servers/:id/files/upload-stream',
    { bodyLimit: 1024 * 1024 * 1024 },
    async (req, reply) => {
      try {
        const name = String(req.query.filename ?? 'file').replace(/[\\/]/g, '');
        const p = confine(req.params.id, join(req.query.path ?? '', name));
        mkdirSync(dirname(p), { recursive: true });
        await pipeline(req.body as NodeJS.ReadableStream, createWriteStream(p));
        chownFile(p);
        if (/(^|[\\/])mods$/.test(dirname(p)) && name.endsWith('.jar')) {
          // NO sync here — the preflight syncs after its verdict, so an
          // unproven jar can never reach friends through a live regenerate
          const { schedulePreflight } = await import('../services/preflight.js');
          schedulePreflight(req.params.id, [name], (m) => app.log.info(m));
        }
        // a dropped .mrpack / CF pack zip is an intent, not just a file — tell
        // the UI what it is so it can offer install / new-server right away
        if (/\.(mrpack|zip)$/i.test(name)) {
          const { inspectPackFile } = await import('../services/modpack.js');
          const pack = inspectPackFile(p);
          if (pack) return { ok: true, pack };
        }
        return { ok: true };
      } catch (e) {
        return reply.code(400).send({ error: String((e as Error).message ?? e).slice(0, 200) });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { path: string; filename: string; dataBase64: string } }>(
    '/api/servers/:id/files/upload',
    { bodyLimit: 96 * 1024 * 1024 }, // legacy small-file path (base64 inflates 4/3)
    async (req, reply) => {
      try {
        const name = String(req.body.filename ?? 'file').replace(/[\\/]/g, '');
        const p = confine(req.params.id, join(req.body.path ?? '', name));
        const data = Buffer.from(String(req.body.dataBase64 ?? ''), 'base64');
        if (data.length === 0) return reply.code(400).send({ error: 'empty upload' });
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, data);
        chownFile(p);
        return { ok: true };
      } catch (e) {
        return reply.code(400).send({ error: String((e as Error).message ?? e).slice(0, 200) });
      }
    },
  );

  // ---- DROPPED PACK FILE ACTIONS — a recognized .mrpack / CF pack zip in a
  // server dir can be poured into THAT server or become a brand-new server.
  // Both consume the carrier file on success (its content lives on).

  app.post<{ Params: { id: string }; Body: { path: string } }>(
    '/api/servers/:id/packfile/install',
    async (req, reply) => {
      try {
        const p = confine(req.params.id, req.body.path);
        const { inspectPackFile, installMrpackFile, installCurseforgeZipFile } = await import('../services/modpack.js');
        const info = inspectPackFile(p);
        if (!info) return reply.code(400).send({ error: 'not a Modrinth .mrpack or CurseForge pack zip' });
        const res = info.kind === 'curseforge'
          ? await installCurseforgeZipFile(req.params.id, p)
          : await installMrpackFile(req.params.id, p);
        if ('error' in res) return reply.code(400).send(res);
        rmSync(p, { force: true });
        // no sync here: the preflight gates the whole new set and syncs
        // after its verdict — unproven pack content never reaches friends
        const { schedulePreflight } = await import('../services/preflight.js');
        schedulePreflight(req.params.id, [], (m) => app.log.info(m));
        return res;
      } catch (e) {
        return reply.code(400).send({ error: String((e as Error).message ?? e).slice(0, 200) });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { path: string; name?: string; memGb?: number } }>(
    '/api/servers/:id/packfile/create-server',
    async (req, reply) => {
      try {
        const p = confine(req.params.id, req.body.path);
        const { startCreateFromPackFile } = await import('../services/servercreate.js');
        const r = startCreateFromPackFile({ path: p, name: req.body.name, memGb: req.body.memGb });
        if ('error' in r) return reply.code(400).send(r);
        return r;
      } catch (e) {
        return reply.code(400).send({ error: String((e as Error).message ?? e).slice(0, 200) });
      }
    },
  );

  // FILE SEARCH — filename substring match across the whole server dir.
  // Noise dirs skipped (libraries alone is thousands of entries); results
  // capped and the walk bounded so a pathological tree can't hang the panel.
  app.get<{ Params: { id: string }; Querystring: { q: string } }>(
    '/api/servers/:id/files/search',
    async (req, reply) => {
      try {
        const q = String(req.query.q ?? '').toLowerCase().trim();
        if (q.length < 2) return { results: [] };
        const root = confine(req.params.id, '');
        const SKIP = new Set(['libraries', '.fabric', 'versions', 'debug', 'crash-reports', '.git', 'node_modules']);
        const results: { path: string; dir: boolean; size: number }[] = [];
        let visited = 0;
        const walk = (dir: string, rel: string, depth: number): void => {
          if (depth > 8 || results.length >= 100 || visited > 30_000) return;
          let entries: string[] = [];
          try { entries = readdirSync(dir); } catch { return; }
          for (const name of entries) {
            if (results.length >= 100 || ++visited > 30_000) return;
            const full = join(dir, name);
            const r = rel ? `${rel}/${name}` : name;
            let st;
            try { st = statSync(full); } catch { continue; }
            if (st.isDirectory()) {
              if (name.toLowerCase().includes(q)) results.push({ path: r, dir: true, size: 0 });
              if (!SKIP.has(name)) walk(full, r, depth + 1);
            } else if (name.toLowerCase().includes(q)) {
              results.push({ path: r, dir: false, size: st.size });
            }
          }
        };
        walk(root, '', 0);
        return { results };
      } catch (e) {
        return reply.code(400).send({ error: String((e as Error).message ?? e).slice(0, 200) });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { path: string } }>(
    '/api/servers/:id/files/mkdir',
    async (req, reply) => {
      try {
        const p = confine(req.params.id, req.body.path);
        mkdirSync(p, { recursive: true });
        chownFile(p);
        return { ok: true };
      } catch (e) {
        return reply.code(400).send({ error: String((e as Error).message ?? e).slice(0, 200) });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { from: string; to: string } }>(
    '/api/servers/:id/files/rename',
    async (req, reply) => {
      try {
        const from = confine(req.params.id, req.body.from);
        const to = confine(req.params.id, req.body.to);
        renameSync(from, to);
        return { ok: true };
      } catch (e) {
        return reply.code(400).send({ error: String((e as Error).message ?? e).slice(0, 200) });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { path: string } }>(
    '/api/servers/:id/files/delete',
    async (req, reply) => {
      try {
        const rel = (req.body.path ?? '').replace(/^[/\\]+|[/\\]+$/g, '');
        if (rel === '') return reply.code(400).send({ error: 'refusing to delete the server root' });
        // the world lives under the Worlds card's journaled machinery — a raw
        // rm here would bypass backups, slot metadata, and crash recovery
        if (rel === 'world' || rel === 'worlds') {
          return reply.code(400).send({ error: 'use the Worlds card to manage worlds — it backs up first' });
        }
        const p = confine(req.params.id, rel);
        rmSync(p, { recursive: true, force: true });
        return { ok: true };
      } catch (e) {
        return reply.code(400).send({ error: String((e as Error).message ?? e).slice(0, 200) });
      }
    },
  );
}
