import { Agent, request } from 'undici';
import { loadSettings, craftyToken } from '../config.js';

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

export const craftyApi = {
  listServers: () => crafty<CraftyServer[]>('GET', '/api/v2/servers'),
  // create via Crafty's wizard API; it downloads the jar / runs the loader
  // installer itself. Returns the new server's uuid (key name varies by build).
  createServer: (payload: unknown) =>
    crafty<{ new_server_id?: string; new_server_uuid?: string }>('POST', '/api/v2/servers/', payload),
  getServer: (id: string) => crafty<CraftyServer>('GET', `/api/v2/servers/${id}`),
  getStats: (id: string) => crafty<CraftyStats>('GET', `/api/v2/servers/${id}/stats`),
  getLogs: (id: string) => crafty<string[]>('GET', `/api/v2/servers/${id}/logs`),
  action: (
    id: string,
    action: 'start_server' | 'stop_server' | 'restart_server' | 'kill_server' | 'accept_eula',
  ) => crafty('POST', `/api/v2/servers/${id}/action/${action}`),
  // Crafty's own catalogue of installable server jars: { <category>: { <type>: [versions] } }.
  // The create wizard only accepts a type/version pair that appears here.
  jarCatalog: () => crafty<Record<string, Record<string, string[]>>>('GET', '/api/v2/jars'),
  patchServer: (id: string, fields: Record<string, unknown>) =>
    crafty('PATCH', `/api/v2/servers/${id}`, fields),
  // Crafty 4.x exposes stdin as an action-style endpoint on some builds; the
  // route layer falls back to RCON when this 404s.
  sendStdin: (id: string, cmd: string) =>
    crafty('POST', `/api/v2/servers/${id}/stdin`, undefined, cmd),
  // unregisters the server from Crafty. File removal is OUR job afterwards —
  // Crafty builds differ on whether DELETE touches the dir, so the panel never
  // relies on it.
  deleteServer: (id: string) => crafty('DELETE', `/api/v2/servers/${id}`),
};
