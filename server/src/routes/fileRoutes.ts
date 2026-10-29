import type { FastifyInstance } from 'fastify';
import { existsSync, readdirSync, statSync, lstatSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, createReadStream, createWriteStream, realpathSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join, resolve, sep, dirname, basename, relative } from 'node:path';
import { chownSync, statSync as statS } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { serverDir } from '../services/servers.js';
import { liveChanged, assertModsWritable, assertCanStage, stage, stagingPath } from '../services/packtxn.js';
import { assertNotRequired } from '../services/installer.js';
import { assertPackPathWritable } from '../services/revisions.js';

// WEB FILE MANAGER — browse/edit/upload/download any file under a server's
// directory from the panel. Every path is confined to the server dir (the one
// competitor feature Spawnpoint lacked; subsumes SFTP for daily use).

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

/** Resolve a user path inside the server dir or throw. Symlinks in the
    parent path are followed, so a link cannot lead out. A final symlink is
    returned as itself (delete and rename act on the link, not its target),
    but it must point inside too, since reads and writes go through it; a
    dangling one is refused instead of being written through. */
function confine(id: string, rel: string): string {
  const root = realpathSync(serverDir(id));
  const inside = (x: string): boolean => x === root || x.startsWith(root + sep);
  const escapes = (): Error => new Error('path escapes server directory');
  const p = resolve(join(root, rel));
  if (p === root) return root;
  const stat = (x: string) => { try { return lstatSync(x); } catch { return null; } };
  let existing = dirname(p);
  while (!stat(existing)) existing = dirname(existing);
  let real: string;
  try { real = join(realpathSync(existing), relative(existing, p)); } catch { throw escapes(); }
  if (!inside(real)) throw escapes();
  if (stat(real)?.isSymbolicLink()) {
    let target: string;
    try { target = realpathSync(real); } catch { throw escapes(); }
    if (!inside(target)) throw escapes();
  }
  return real;
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export default async function fileRoutes(app: FastifyInstance) {
  // an unfinished apply or undo must roll back against the files it recorded
  app.addHook('preHandler', async (req, reply) => {
    const id = (req.params as { id?: string }).id;
    if (!id || req.method === 'GET') return;
    try { assertModsWritable(id); } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });
  /** Any write through the file manager changes what a mod test saw. The
      check, the write and the invalidation run in one synchronous step, so a
      restart for a mod change cannot claim a verdict on the old files between. */
  const mutate = <T>(id: string, write: () => T, ...paths: string[]): T => {
    assertModsWritable(id);
    for (const path of paths) assertPackPathWritable(id, path);
    const r = write();
    liveChanged(id);
    return r;
  };
  /** removing or renaming a jar in mods/ must not orphan a mod that needs it */
  const guardJar = (id: string, path: string): void => {
    if (dirname(path) === join(realpathSync(serverDir(id)), 'mods') && path.endsWith('.jar')) assertNotRequired(id, basename(path));
  };
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
        mutate(req.params.id, () => writeFileSync(p, req.body.content ?? '', 'utf8'), p);
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

  // Uploads stream straight to disk (no base64 copy in the browser).
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
  app.post<{ Params: { id: string }; Querystring: { path?: string; filename?: string } }>(
    '/api/servers/:id/files/upload-stream',
    { bodyLimit: 1024 * 1024 * 1024 },
    async (req, reply) => {
      try {
        const name = String(req.query.filename ?? 'file').replace(/[\\/]/g, '');
        const p = confine(req.params.id, join(req.query.path ?? '', name));
        // a jar dropped into mods/ is a mod install: it joins the server's
        // candidate and goes live only after the boot test
        if (dirname(p) === join(realpathSync(serverDir(req.params.id)), 'mods') && name.endsWith('.jar')) {
          // a private part file, renamed into place: a test reading the old bytes keeps them
          const dest = stagingPath(req.params.id, name);
          const part = `${dest}.${randomBytes(4).toString('hex')}.part`;
          await pipeline(req.body as NodeJS.ReadableStream, createWriteStream(part));
          // from here to stage() is synchronous, so nothing can slip in between
          try { assertCanStage(req.params.id); } catch (e) { rmSync(part, { force: true }); throw e; }
          renameSync(part, dest);
          const replaces = existsSync(p) ? name : undefined;
          return { ok: true, candidate: stage(req.params.id, [{ file: name, to: 'mods', replaces }], (m) => app.log.info(m)) };
        }
        assertPackPathWritable(req.params.id, p);
        mkdirSync(dirname(p), { recursive: true });
        // streamed to a private part file; a mod change may have started going
        // live meanwhile, so check again, then land it and invalidate in one step
        const part = `${p}.${randomBytes(4).toString('hex')}.part`;
        await pipeline(req.body as NodeJS.ReadableStream, createWriteStream(part));
        try { mutate(req.params.id, () => renameSync(part, p), p); } catch (e) { rmSync(part, { force: true }); throw e; }
        chownFile(p);
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


  // ---- DROPPED PACK FILE — a recognized .mrpack / CF pack zip in a server
  // dir can become a brand-new server; that consumes the carrier file.

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
        mutate(req.params.id, () => mkdirSync(p, { recursive: true }), p);
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
        if (from !== to) guardJar(req.params.id, from);
        mutate(req.params.id, () => renameSync(from, to), from, to);
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
        const p = confine(req.params.id, req.body.path ?? '');
        const root = realpathSync(serverDir(req.params.id));
        if (p === root) return reply.code(400).send({ error: 'refusing to delete the server root' });
        // the world lives under the Worlds card's journaled machinery — a raw
        // rm here would bypass backups, slot metadata, and crash recovery.
        // Compared by file identity, so "WORLD" on a case-insensitive disk is
        // caught too; a symlink is deleted as itself, never as the world.
        const fileId = (x: string): string | null => {
          try { const s = statSync(x, { bigint: true }); return `${s.dev}:${s.ino}`; } catch { return null; }
        };
        const target = lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() ? null : fileId(p);
        if (target && [join(root, 'world'), join(root, 'worlds')].some((d) => fileId(d) === target)) {
          return reply.code(400).send({ error: 'use the Worlds card to manage worlds — it backs up first' });
        }
        guardJar(req.params.id, p);
        mutate(req.params.id, () => rmSync(p, { recursive: true, force: true }), p);
        return { ok: true };
      } catch (e) {
        return reply.code(400).send({ error: String((e as Error).message ?? e).slice(0, 200) });
      }
    },
  );
}
