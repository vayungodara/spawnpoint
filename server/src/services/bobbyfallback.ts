import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../config.js';
import { serverDir } from './servers.js';
import { clientShelfDir } from './installer.js';
import { rconCommand } from '../clients/rcon.js';

// BOBBY FALLBACK EXPORT — Bobby (client mod) renders chunks beyond the
// server's view-distance from a local cache, and reads a singleplayer world
// named `bobby-fallback` in saves/ for terrain the server has never sent.
// Paired with Chunky that means: pre-generate once server-side, hand every
// player a world copy, and the whole map is visible from their first login.
//
// The export zips world/ (minus session.lock and players/ — no reason to
// ship anyone's inventory or position) into
// data/bobbyfallback/<id>/bobby-fallback.zip as a BACKGROUND child at
// nice/ionice-idle priority: a normal-priority copy of a live world once put
// the server 93 ticks behind. The zip's top-level folder is already named
// bobby-fallback, so the player unzips straight into saves/ and is done.

const IS_WIN = process.platform === 'win32';

function outDir(id: string): string {
  return join(PATHS.data, 'bobbyfallback', id);
}
export function zipPath(id: string): string {
  return join(outDir(id), 'bobby-fallback.zip');
}

const building = new Map<string, { startedAt: string }>();
const lastError = new Map<string, string>();

/** Bobby anywhere in the pack: server mods (it runs both sides), the
    client-only shelf, or the AutoModpack extras dir. */
export function bobbyInstalled(id: string): boolean {
  const dirs = [
    join(serverDir(id), 'mods'),
    join(serverDir(id), 'automodpack', 'host-modpack', 'main', 'mods'),
    clientShelfDir(id),
  ];
  for (const d of dirs) {
    try {
      if (readdirSync(d).some((f) => /^bobby[-.\d]/i.test(f) && f.endsWith('.jar'))) return true;
    } catch { /* dir absent — keep looking */ }
  }
  return false;
}

export interface BobbyStatus {
  bobbyInstalled: boolean;
  building: boolean;
  ready: boolean;
  sizeBytes: number | null;
  builtAt: string | null;
  error: string | null;
}

export function bobbyStatus(id: string): BobbyStatus {
  const zp = zipPath(id);
  let sizeBytes: number | null = null;
  let builtAt: string | null = null;
  try {
    const st = statSync(zp);
    sizeBytes = st.size;
    builtAt = st.mtime.toISOString();
  } catch { /* not built yet */ }
  return {
    bobbyInstalled: bobbyInstalled(id),
    building: building.has(id),
    ready: sizeBytes !== null,
    sizeBytes,
    builtAt,
    error: lastError.get(id) ?? null,
  };
}

/** The zip is derived data of ONE specific world — after a reset/switch/
    restore it would hand friends phantom terrain from a world that no longer
    exists. World-replacing operations delete it outright. */
export function clearFallback(id: string): void {
  rmSync(outDir(id), { recursive: true, force: true });
}

export async function buildFallback(id: string, log: (m: string) => void): Promise<{ ok: true } | { error: string }> {
  if (IS_WIN) return { error: 'the fallback export needs a Linux host (zip/nice)' };
  if (building.has(id)) return { error: 'a fallback build is already running' };
  const world = join(serverDir(id), 'world');
  if (!existsSync(join(world, 'level.dat'))) return { error: 'no world yet — start the server once first' };

  // flush pending chunk writes so the copy carries the freshest terrain;
  // a stopped server (RCON down) simply has nothing buffered — proceed
  try { await rconCommand(id, 'save-all flush', { timeout: 30_000 }); } catch { /* server off */ }

  mkdirSync(outDir(id), { recursive: true });
  const staging = join(outDir(id), 'staging');
  const script = [
    `set -e`,
    `rm -rf ${JSON.stringify(staging)}`,
    `mkdir -p ${JSON.stringify(staging)}`,
    `nice -n 19 ionice -c3 cp -a ${JSON.stringify(world)} ${JSON.stringify(join(staging, 'bobby-fallback'))}`,
    `rm -f ${JSON.stringify(join(staging, 'bobby-fallback', 'session.lock'))}`,
    `rm -rf ${JSON.stringify(join(staging, 'bobby-fallback', 'players'))}`,
    `cd ${JSON.stringify(staging)}`,
    `nice -n 19 ionice -c3 zip -qr ../bobby-fallback.zip.tmp bobby-fallback`,
    `mv ../bobby-fallback.zip.tmp ${JSON.stringify(zipPath(id))}`,
    `rm -rf ${JSON.stringify(staging)}`,
  ].join('\n');

  building.set(id, { startedAt: new Date().toISOString() });
  lastError.delete(id);
  const child = spawn('sh', ['-c', script], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
  child.on('close', (code) => {
    building.delete(id);
    if (code === 0) {
      log(`bobby: fallback world built for ${id} (${Math.round(statSync(zipPath(id)).size / 1e6)}MB)`);
    } else {
      lastError.set(id, `build failed (exit ${code}): ${err.slice(0, 160)}`);
      log(`bobby: fallback build FAILED for ${id}: ${err.slice(0, 160)}`);
    }
  });
  child.on('error', (e) => {
    building.delete(id);
    lastError.set(id, String(e).slice(0, 160));
  });
  return { ok: true };
}
