import { readProperties, patchProperties } from './properties.js';
import { craftyApi, type CraftyServer } from '../clients/crafty.js';

// One source of truth for how ports are laid out across the fleet.
//
// The bug this module exists to kill: server creation only ever uniquified the
// GAME port (nextFreePort), never rcon.port. Crafty's template hands every new
// server the same rcon.port, so two servers would silently share it — and the
// genie's RCON client (clients/rcon.ts) connects to 127.0.0.1:<that server's
// own rcon.port>, so whichever server bound the shared port first would receive
// commands meant for the other. Deriving rcon.port from the game port makes a
// unique game port *guarantee* a unique rcon port.

export const PANEL_PORT = 25570; // the Spawnpoint panel — never hand this to a server
// rcon.port = server-port + 10000. The big offset keeps every rcon port in a
// separate 35xxx band from the 25xxx game ports, so a game port can never grow
// into a neighbour's rcon port. This is the start-time provisioner's convention
// (routes/servers.ts) — kept here as the single source of truth for both paths.
export const RCON_OFFSET = 10_000;
export const MIN_GAME_PORT = 25565;

/** rcon.port for a given game port (server-port + 10000). */
export const derivedRcon = (gamePort: number): number => gamePort + RCON_OFFSET;

export interface PortRow {
  id: string;
  name: string;
  gamePort: number;
  rconPort: number;
  queryPort: number | null;
}

export interface PortAudit {
  rows: PortRow[];
  gameCollisions: number[]; // game ports claimed by more than one server
  rconCollisions: number[]; // rcon ports claimed by more than one server
  panelConflicts: string[]; // server ids sitting on the panel's own port
  clean: boolean;
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/** The game/rcon/query ports a server is really configured with. server.properties
 *  is authoritative (it's what the JVM binds); Crafty's stored port is only a
 *  fallback for display when the file hasn't been written yet. */
export function portsOf(
  uuid: string,
  crafty?: CraftyServer,
): { gamePort: number; rconPort: number; queryPort: number | null } {
  const props = readProperties(uuid);
  const gamePort = num(props['server-port']) ?? crafty?.server_port ?? MIN_GAME_PORT;
  const rconPort = num(props['rcon.port']) ?? derivedRcon(gamePort);
  const queryPort = num(props['query.port']);
  return { gamePort, rconPort, queryPort };
}

/** Snapshot every server's ports and flag any collision. */
export async function portAudit(): Promise<PortAudit> {
  const servers = await craftyApi.listServers();
  const rows: PortRow[] = servers.map((s) => {
    const p = portsOf(s.server_id, s);
    return { id: s.server_id, name: s.server_name, ...p };
  });

  const collisions = (pick: (r: PortRow) => number | null): number[] => {
    const counts = new Map<number, number>();
    for (const r of rows) {
      const v = pick(r);
      if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts.entries()].filter(([, c]) => c > 1).map(([port]) => port).sort((a, b) => a - b);
  };

  const gameCollisions = collisions((r) => r.gamePort);
  const rconCollisions = collisions((r) => r.rconPort);
  const panelConflicts = rows.filter((r) => r.gamePort === PANEL_PORT).map((r) => r.id);

  return {
    rows,
    gameCollisions,
    rconCollisions,
    panelConflicts,
    clean: !gameCollisions.length && !rconCollisions.length && !panelConflicts.length,
  };
}

/** Lowest free game port, skipping the panel and every server's current game
 *  AND rcon port (a new game port must not collide with an existing rcon port
 *  either, or the derived rcon ports would clash). */
export async function suggestGamePort(exceptId?: string): Promise<number> {
  const audit = await portAudit();
  const taken = new Set<number>([PANEL_PORT]);
  for (const r of audit.rows) {
    if (r.id === exceptId) continue;
    taken.add(r.gamePort);
    taken.add(r.rconPort);
  }
  let p = MIN_GAME_PORT;
  while (taken.has(p) || taken.has(derivedRcon(p))) p++;
  return p;
}

export interface ReportResult {
  ok: boolean;
  error?: string;
  id: string;
  gamePort: number;
  rconPort: number;
  craftySynced: boolean;
}

/** Move a server to a new game port (rcon + query follow). Refuses to touch a
 *  running server — the JVM re-reads server.properties only on restart, so
 *  rewriting it live would leave the genie's RCON pointed at a port the server
 *  isn't listening on yet. patchProperties keeps a .bak automatically. */
export async function reportServer(
  id: string,
  gamePort: number,
  opts: { force?: boolean } = {},
): Promise<ReportResult> {
  const rconPort = derivedRcon(gamePort);
  const fail = (error: string): ReportResult => ({ ok: false, error, id, gamePort, rconPort, craftySynced: false });

  if (!Number.isInteger(gamePort) || gamePort < 1024 || gamePort > 65535) {
    return fail(`port ${gamePort} is out of the usable range (1024–65535)`);
  }
  if (gamePort === PANEL_PORT || rconPort === PANEL_PORT) {
    return fail(`port ${gamePort} collides with the Spawnpoint panel (${PANEL_PORT})`);
  }

  // no collision with any OTHER server's game or rcon port
  const audit = await portAudit();
  for (const r of audit.rows) {
    if (r.id === id) continue;
    if ([r.gamePort, r.rconPort].includes(gamePort) || [r.gamePort, r.rconPort].includes(rconPort)) {
      return fail(`port ${gamePort}/${rconPort} is already used by "${r.name}"`);
    }
  }

  // never re-port a running server
  if (!opts.force) {
    let running = false;
    try {
      running = (await craftyApi.getStats(id)).running;
    } catch {
      return fail('could not confirm the server is stopped (Crafty stats unavailable) — stop it and retry');
    }
    if (running) return fail('server is running — stop it before changing its port');
  }

  patchProperties(id, {
    'server-port': String(gamePort),
    'rcon.port': String(rconPort),
    'query.port': String(gamePort),
    'enable-rcon': 'true',
  });

  // keep Crafty's stored port in step so its status pings and the panel's
  // server list agree with the file (best-effort — the file is what binds).
  let craftySynced = false;
  try {
    await craftyApi.patchServer(id, { server_port: gamePort });
    craftySynced = true;
  } catch {
    craftySynced = false;
  }

  return { ok: true, id, gamePort, rconPort, craftySynced };
}
