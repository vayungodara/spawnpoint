import { Agent, request } from 'undici';
import { loadSettings, craftyToken } from '../config.js';

// Legacy backend. clients/crafty.ts owns routing and revision-aware starts.
// Crafty runs on localhost with a self-signed cert. TLS verification is
// disabled ONLY for this dispatcher — never globally.
const insecureLocalAgent = new Agent({ connect: { rejectUnauthorized: false } });

export class CraftyError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

async function crafty<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  rawBody?: string,
): Promise<T> {
  const token = craftyToken();
  if (!token) throw new CraftyError('No Crafty API token (Shared\\crafty-token.txt)');
  const base = loadSettings().craftyUrl;
  const res = await request(`${base}${path}`, {
    method,
    dispatcher: insecureLocalAgent,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(rawBody !== undefined ? { 'content-type': 'text/plain' } : {}),
    },
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.body.text();
  if (res.statusCode >= 400) {
    throw new CraftyError(`Crafty ${method} ${path} -> ${res.statusCode}: ${text.slice(0, 300)}`, res.statusCode);
  }
  const json = JSON.parse(text) as { status: string; data: T };
  if (json.status && json.status !== 'ok') {
    throw new CraftyError(`Crafty ${method} ${path} -> status=${json.status}`);
  }
  return json.data;
}

export interface CraftyServer {
  server_id: string;
  server_name: string;
  type: string;
  server_ip: string;
  server_port: number;
  path: string;
  executable: string;
  execution_command: string;
  auto_start: boolean;
}

export interface CraftyStats {
  running: boolean;
  crashed: boolean;
  waiting_start: boolean;
  started: string;
  cpu: number;
  mem: number | string;
  mem_percent: number;
  online: number;
  max: number;
  players: string;
  version: string;
  desc: string;
  world_size: string;
}

// Every page and background job asks Crafty the same two questions (which
// servers exist, how is each one doing). Answers are shared for a few seconds
// and concurrent callers ride one request; anything that changes a server
// drops the cache.
const LIST_TTL = 10_000;
const STATS_TTL = 2_000;
let listCache: { at: number; p: Promise<CraftyServer[]> } | null = null;
const statsCache = new Map<string, { at: number; p: Promise<CraftyStats> }>();
const reportedPaths = new Map<string, string>();

function invalidate(id?: string): void {
  listCache = null;
  if (id) statsCache.delete(id);
  else statsCache.clear();
}

async function mutate<T>(id: string | undefined, p: Promise<T>): Promise<T> {
  try { return await p; } finally { invalidate(id); }
}

export const craftyApi = {
  listServers(): Promise<CraftyServer[]> {
    if (listCache && Date.now() - listCache.at < LIST_TTL) return listCache.p;
    const entry = {
      at: Date.now(),
      p: crafty<CraftyServer[]>('GET', '/api/v2/servers').then((list) => {
        for (const s of list) reportedPaths.set(s.server_id, s.path);
        return list;
      }),
    };
    listCache = entry;
    entry.p.catch(() => { if (listCache === entry) listCache = null; });
    return entry.p;
  },
  /** The folder Crafty reports for a server (inside its container when Crafty runs in Docker). */
  reportedPath: (id: string): string | undefined => reportedPaths.get(id),
  // create via Crafty's wizard API; it downloads the jar / runs the loader
  // installer itself. Returns the new server's uuid (key name varies by build).
  createServer: (payload: unknown) =>
    mutate(undefined, crafty<{ new_server_id?: string; new_server_uuid?: string }>('POST', '/api/v2/servers/', payload)),
  getServer: (id: string) => crafty<CraftyServer>('GET', `/api/v2/servers/${id}`),
  getStats(id: string): Promise<CraftyStats> {
    const hit = statsCache.get(id);
    if (hit && Date.now() - hit.at < STATS_TTL) return hit.p;
    const entry = { at: Date.now(), p: crafty<CraftyStats>('GET', `/api/v2/servers/${id}/stats`) };
    statsCache.set(id, entry);
    entry.p.catch(() => { if (statsCache.get(id) === entry) statsCache.delete(id); });
    return entry.p;
  },
  /** Console lines as plain text (Crafty HTML-escapes them for its own web console). */
  getLogs: async (id: string) => (await crafty<string[]>('GET', `/api/v2/servers/${id}/logs`)).map((l) => l
    .replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')),
  action: async (
    id: string,
    action: 'start_server' | 'stop_server' | 'restart_server' | 'kill_server' | 'accept_eula',
  ) => {
    if (action === 'start_server' || action === 'restart_server') {
      const { verifyActiveRevision, revisionState } = await import('../services/revisions.js');
      await verifyActiveRevision(id);
      if (revisionState(id).active) {
        const { holdHosting } = await import('../services/automodpack.js');
        holdHosting(id);
      }
    }
    const result = await mutate(id, crafty('POST', `/api/v2/servers/${id}/action/${action}`));
    if (action === 'start_server' || action === 'restart_server') {
      const { watchStart } = await import('../services/promote.js');
      watchStart(id);
    }
    return result;
  },
  // Crafty's own catalogue of installable server jars: { <category>: { <type>: [versions] } }.
  // The create wizard only accepts a type/version pair that appears here.
  jarCatalog: () => crafty<Record<string, Record<string, string[]>>>('GET', '/api/v2/jars'),
  patchServer: async (id: string, fields: Record<string, unknown>) => {
    if ('execution_command' in fields || 'executable' in fields || 'path' in fields) {
      const { assertUnsealed } = await import('../services/revisions.js');
      assertUnsealed(id);
    }
    return mutate(id, crafty('PATCH', `/api/v2/servers/${id}`, fields));
  },
  /** Transaction-only: the journal and OS fence outlive this async write.
      No arbitrary command or HTTP runtime-edit bypass is accepted here. */
  useRevisionCommand: async (id: string, revision: string) => {
    const { assertRevisionMutation, verifyRevision } = await import('../services/revisions.js');
    assertRevisionMutation(id);
    const lock = await verifyRevision(id, revision);
    if ((await craftyApi.getServer(id)).execution_command !== lock.command) {
      await mutate(id, crafty('PATCH', `/api/v2/servers/${id}`, { execution_command: lock.command }));
    }
  },
  /** Import-only source freeze/abort, never exposed as a generic HTTP patch. */
  setTransferSource: async (id: string, fields: Record<string, unknown>) => {
    const { assertRevisionMutation } = await import('../services/revisions.js');
    assertRevisionMutation(id);
    return mutate(id, crafty('PATCH', `/api/v2/servers/${id}`, fields));
  },
  // Crafty 4.x exposes stdin as an action-style endpoint on some builds; the
  // route layer falls back to RCON when this 404s.
  sendStdin: (id: string, cmd: string) =>
    crafty('POST', `/api/v2/servers/${id}/stdin`, undefined, cmd),
  // unregisters the server from Crafty. File removal is the panel's job:
  // Crafty builds differ on whether DELETE touches the folder.
  deleteServer: (id: string) => mutate(id, crafty('DELETE', `/api/v2/servers/${id}`)),
};
