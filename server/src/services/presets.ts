import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { patchProperties } from './properties.js';
import { deopAll } from './players.js';
import { serverDir } from './servers.js';
import { parseNbt, writeNbt, nByte, nString } from './nbt.js';
import { craftyApi } from '../clients/crafty.js';
import { applyMemory } from './servercreate.js';

// Ports of Set-Mode.ps1 / Set-OnlineMode.ps1 / Set-Ram.ps1.

/** server.properties only sets hardcore/difficulty at WORLD CREATION — an
    existing world carries its own copy in level.dat (26.2 nests it under
    Data.difficulty_settings) and that copy wins. Patch it too, or a preset
    switch silently does nothing to the world the player is standing in.
    Only possible while the server is stopped; the caller already requires a
    restart to apply presets, so the timing works out. */
function patchLevelDat(uuid: string, hardcore: boolean, difficulty: string): void {
  const p = join(serverDir(uuid), 'world', 'level.dat');
  if (!existsSync(p)) return; // no world yet: creation will honor server.properties
  const { name, root } = parseNbt(readFileSync(p));
  const data = (root.v as Record<string, { v: unknown }>)['Data']?.v as Record<string, { t: number; v: unknown }> | undefined;
  if (!data) return;
  copyFileSync(p, `${p}.bak`);
  const ds = data['difficulty_settings']?.v as Record<string, { t: number; v: unknown }> | undefined;
  if (ds) {
    // MC 26.x layout
    if (ds['hardcore']) ds['hardcore'].v = hardcore ? 1 : 0; else ds['hardcore'] = nByte(hardcore ? 1 : 0);
    if (ds['difficulty']) ds['difficulty'].v = difficulty; else ds['difficulty'] = nString(difficulty);
  } else if (data['hardcore']) {
    // pre-26 layout
    data['hardcore'].v = hardcore ? 1 : 0;
  } else {
    return; // unknown layout: leave the world file alone rather than guess
  }
  writeFileSync(p, writeNbt(root, name));
}

export async function applyModePreset(
  uuid: string,
  mode: 'hardcore' | 'survival',
  keepOps: boolean,
): Promise<{ restarted: boolean; error?: string }> {
  const hardcore = mode === 'hardcore';
  const difficulty = hardcore ? 'hard' : 'normal';
  // a RUNNING server rewrites level.dat from memory at shutdown, which would
  // silently revert the world-file patch — so the whole preset applies across
  // a stop, and we restart for the player afterwards
  const { craftyApi } = await import('../clients/crafty.js');
  const { stopAndWait, isRunningSafe, beginMaintenance, endMaintenance } = await import('./maintenance.js');
  // hold the maintenance lock: a scheduled/auto start booting the server
  // mid-patch would rewrite level.dat from memory and silently revert it
  beginMaintenance(uuid);
  try {
    const wasRunning = await isRunningSafe(uuid);
    if (wasRunning) {
      const stopped = await stopAndWait(uuid);
      if (!stopped) return { restarted: false, error: 'server would not stop — try again' };
    }
    patchProperties(uuid, {
      gamemode: 'survival',
      'force-gamemode': 'true',
      'enable-command-block': 'false',
      pvp: 'true',
      hardcore: String(hardcore),
      difficulty,
    });
    patchLevelDat(uuid, hardcore, difficulty);
    if (!keepOps) deopAll(uuid);
    if (wasRunning) {
      try {
        await craftyApi.action(uuid, 'start_server');
      } catch {
        return { restarted: false, error: 'preset applied, but the server did not restart — start it from the dashboard' };
      }
    }
    return { restarted: wasRunning };
  } finally {
    endMaintenance(uuid);
  }
}

export function setOnlineMode(uuid: string, online: boolean): void {
  const patch: Record<string, string> = {
    'online-mode': String(online),
    'enforce-secure-profile': String(online),
  };
  if (!online) {
    // cracked mode: force the whitelist so the server is never wide open
    patch['white-list'] = 'true';
    patch['enforce-whitelist'] = 'true';
  }
  patchProperties(uuid, patch);
}

const toGb = (m: RegExpExecArray | null): number | null =>
  m ? (m[2].toLowerCase() === 'g' ? parseInt(m[1], 10) : Math.round(parseInt(m[1], 10) / 1024)) : null;

/** Where does this server's heap ACTUALLY come from?
    Forge/NeoForge read user_jvm_args.txt and IGNORE the -Xmx in the launch
    command — so RAM set in Crafty silently did nothing and a "8GB" server ran
    on the JVM's ~1/4-of-RAM default. Everything else reads the command. Report
    the value that the JVM will really get, and say which file it lives in. */
export async function getJvmHeap(
  uuid: string,
): Promise<{ minGb: number | null; maxGb: number | null; source: 'args-file' | 'command' | 'default' }> {
  const file = join(serverDir(uuid), 'user_jvm_args.txt');
  if (existsSync(file)) {
    // comments do NOT count — "# -Xmx4G" is documentation, not a setting
    const live = readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    const xmx = /-Xmx(\d+)([GgMm])/.exec(live);
    if (xmx) {
      return { minGb: toGb(/-Xms(\d+)([GgMm])/.exec(live)), maxGb: toGb(xmx), source: 'args-file' };
    }
    // the args file exists (so it is what the JVM reads) but sets no heap
    return { minGb: null, maxGb: null, source: 'default' };
  }
  const cmd = await craftyApi.getServer(uuid).then((s) => s.execution_command).catch(() => '');
  const xmx = /-Xmx(\d+)([GgMm])/.exec(cmd);
  if (xmx) return { minGb: toGb(/-Xms(\d+)([GgMm])/.exec(cmd)), maxGb: toGb(xmx), source: 'command' };
  return { minGb: null, maxGb: null, source: 'default' };
}

/** Set the heap wherever THIS server actually reads it from. */
export async function setJvmHeap(uuid: string, gb: number): Promise<{ ok: true; source: string }> {
  const dir = serverDir(uuid);
  const cmd = await craftyApi.getServer(uuid).then((s) => s.execution_command).catch(() => '');
  const next = applyMemory(uuid, dir, cmd, gb);
  if (next !== cmd) await craftyApi.patchServer(uuid, { execution_command: next });
  const usesArgsFile = existsSync(join(dir, 'user_jvm_args.txt'));
  return { ok: true, source: usesArgsFile ? 'user_jvm_args.txt' : 'launch command' };
}
