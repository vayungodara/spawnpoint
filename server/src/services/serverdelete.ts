import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../config.js';
import { craftyApi } from '../clients/crafty.js';
import { serverDir } from './servers.js';
import { isRunningSafe, createBackup, beginMaintenance, endMaintenance } from './maintenance.js';
import { cleanupOrphanLanes } from './lanes.js';

// SERVER DELETION — the last operation that still required opening Crafty.
// Order matters: world backup FIRST (a deleted server must stay recoverable,
// same contract as reset/switch), then Crafty unregister, then the directory,
// then every panel-side record. Nothing here runs while the server is up.

/** Panel-side state files that reference a server by id. Left behind they are
    harmless clutter, but clutter accretes — clean them with the server. */
function cleanPanelState(id: string, problems: string[]): void {
  for (const f of [
    join(PATHS.data, 'worldslots', `${id}.json`),
    join(PATHS.data, 'deathsnaps', `${id}.json`),
    join(PATHS.data, 'undo', `${id}.json`),
  ]) {
    try {
      rmSync(f, { force: true });
    } catch (e) {
      problems.push(`could not remove ${f}: ${String(e).slice(0, 80)}`);
    }
  }
}

export async function deleteServer(
  id: string,
  confirmName: string,
  skipBackup = false,
): Promise<{ ok: boolean; error?: string; backedUp?: boolean; problems?: string[] }> {
  let srv;
  try {
    srv = await craftyApi.getServer(id);
  } catch {
    return { ok: false, error: 'server not found in Crafty' };
  }
  // the route already UUID-checks :id; the typed name match is the human
  // confirmation — a fat-fingered click cannot delete a server
  if ((srv.server_name ?? '').trim() !== confirmName.trim()) {
    return { ok: false, error: `name mismatch — type the server's exact name ("${srv.server_name}") to confirm` };
  }
  if (await isRunningSafe(id)) {
    return { ok: false, error: 'server is running (or unverifiable) — stop it first' };
  }

  beginMaintenance(id);
  const problems: string[] = [];
  try {
    // final safety copy of the live world (dormant slots live inside the server
    // dir and go with it — the backups folder is OUTSIDE the server dir and
    // survives). No world = nothing to back up, deletion proceeds.
    // skipBackup is the owner's explicit choice in the delete dialog — a
    // pregenerated world zips for MINUTES at idle io priority, and a
    // throwaway server's world isn't worth the wait. Default is always ON.
    let backedUp = false;
    if (!skipBackup && existsSync(join(serverDir(id), 'world'))) {
      const b = await createBackup(id).catch((e) => ({ error: String(e).slice(0, 140) }));
      if ('error' in b) return { ok: false, error: `final world backup failed — NOT deleting: ${b.error}` };
      backedUp = true;
    }

    const dir = serverDir(id);
    try {
      await craftyApi.deleteServer(id);
    } catch (e) {
      return { ok: false, error: `Crafty refused the delete: ${String(e).slice(0, 140)}` };
    }
    // the dir path was captured BEFORE the Crafty record disappeared
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      problems.push(`server dir not fully removed: ${String(e).slice(0, 100)}`);
    }

    cleanPanelState(id, problems);
    // lane/SRV/firewall teardown rides the existing janitor logic against the
    // fresh server list — same path the daily cleanup uses
    try {
      const live = new Set((await craftyApi.listServers()).map((s) => s.server_id));
      const r = await cleanupOrphanLanes(live, () => {});
      problems.push(...r.problems);
    } catch (e) {
      problems.push(`lane cleanup failed (the daily janitor will retry): ${String(e).slice(0, 100)}`);
    }

    return { ok: true, backedUp, problems: problems.length ? problems : undefined };
  } finally {
    endMaintenance(id);
  }
}
