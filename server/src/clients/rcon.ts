import { Rcon } from 'rcon-client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serverDir } from '../services/servers.js';

/** Read rcon settings straight from a server's server.properties. */
function rconSettings(uuid: string): { enabled: boolean; port: number; password: string } {
  const props = readFileSync(join(serverDir(uuid), 'server.properties'), 'utf8');
  const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(props)?.[1]?.trim() ?? '';
  return {
    enabled: get('enable-rcon') === 'true',
    port: parseInt(get('rcon.port') || '25575', 10),
    password: get('rcon.password'),
  };
}

// rcon-client defaults to a 2000ms response timeout — far too low for a
// heavily-modded server. `/reload` alone runs ~1.5–2s+ (it straddles the 2s
// line, so it timed out *intermittently*: the schematic reload-before-place
// raced, the place ran mid-reload, and the build silently stamped nothing).
// A large fill/clone for an undo snapshot can take longer still. A timed-out
// command rejects mid-flight and desyncs the response queue. Default generously;
// callers pass a bigger budget for known-slow commands (reload).
const DEFAULT_TIMEOUT = 15_000;

/** Send one command over RCON (localhost only). Throws if RCON is disabled. */
export async function rconCommand(uuid: string, cmd: string, opts?: { timeout?: number }): Promise<string> {
  return (await rconBatch(uuid, [cmd], opts))[0];
}

/** Send many commands over ONE connection — vanilla logs two console lines
    per RCON connection, so batching keeps the server log readable. */
export async function rconBatch(uuid: string, cmds: string[], opts?: { timeout?: number }): Promise<string[]> {
  const s = rconSettings(uuid);
  if (!s.enabled || !s.password) {
    throw new Error('RCON is not enabled for this server');
  }
  const rcon = await Rcon.connect({
    host: '127.0.0.1',
    port: s.port,
    password: s.password,
    timeout: opts?.timeout ?? DEFAULT_TIMEOUT,
  });
  try {
    const out: string[] = [];
    for (const cmd of cmds) out.push(await rcon.send(cmd));
    return out;
  } finally {
    await rcon.end();
  }
}
