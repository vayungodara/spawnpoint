import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, cpSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { PATHS } from '../config.js';
import { serverDir, pinJavaFor } from './servers.js';
import { craftyApi } from '../clients/crafty.js';
import { detect } from './detect.js';
import { serverPhase } from './phase.js';
import { stopAndWait, isRunningSafe, createBackup, beginMaintenance, endMaintenance } from './maintenance.js';
import * as modrinth from '../clients/modrinth.js';

// Change a server's Minecraft version in place — the thing you would otherwise
// do by building a whole new server. Three phases, and the middle one is the
// only destructive part:
//
//   plan()   — read-only: what every installed mod would do on the target
//   apply()  — backup → swap loader jar → update/disable mods → boot-verify
//              → ROLLBACK the whole mods dir + jar if the server won't come up
//   rollback() — manual escape hatch afterwards (the snapshot is kept)
//
// The WORLD is the one thing that cannot be rolled back by us: Minecraft
// upgrades a world's chunks on first load and never downgrades them. So a
// world backup is taken first and a downgrade is refused unless the caller
// explicitly acknowledges it.

const FABRIC_META = 'https://meta.fabricmc.net/v2';

export interface ModPlan {
  file: string;
  title: string;
  projectId?: string;
  status: 'ok' | 'update' | 'incompatible' | 'unknown';
  /** the version we would install on the target */
  targetVersionId?: string;
  targetVersionNumber?: string;
  targetFile?: string;
  targetUrl?: string;
  note?: string;
}

export interface SwitchPlan {
  serverId: string;
  from: { mc: string; loader: string };
  to: { mc: string; loader: string; loaderVersion?: string };
  downgrade: boolean;
  worldWarning?: string;
  mods: ModPlan[];
  counts: { ok: number; update: number; incompatible: number; unknown: number };
}

const sha1 = (buf: Buffer) => createHash('sha1').update(buf).digest('hex');
const modsDir = (id: string) => join(serverDir(id), 'mods');
const snapDir = (id: string) => join(PATHS.data, 'versionswitch', id);

/** Stable Minecraft versions Fabric can run, newest first. */
export async function listTargets(): Promise<{ versions: string[]; loader: string | null }> {
  const games = (await (await fetch(`${FABRIC_META}/versions/game`)).json()) as { version: string; stable: boolean }[];
  const loaders = (await (await fetch(`${FABRIC_META}/versions/loader`)).json()) as { version: string; stable: boolean }[];
  return {
    versions: games.filter((g) => g.stable).map((g) => g.version),
    loader: loaders.find((l) => l.stable)?.version ?? null,
  };
}

/** Compare two MC versions numerically (1.21.4 < 1.21.10 < 26.2). */
function cmpVersion(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => Number(n) || 0);
  const pb = b.split(/[.-]/).map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function jarFiles(id: string): string[] {
  const dir = modsDir(id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.jar')); // .disabled jars stay disabled
}

/** READ-ONLY. What happens to every installed mod if we move to targetMc? */
export async function plan(id: string, targetMc: string): Promise<SwitchPlan> {
  const det = detect(serverDir(id), id); // takes the PATH, not the uuid
  const loader = det.loader && det.loader !== 'unknown' ? det.loader : 'fabric';
  const currentMc = det.mc ?? '(unknown)';

  const files = jarFiles(id);
  // identify EVERY jar by hash — the install ledger only knows the ones the
  // panel installed; a modpack's jars would otherwise be invisible
  const hashes = new Map<string, string>(); // sha1 -> filename
  for (const f of files) {
    try {
      hashes.set(sha1(readFileSync(join(modsDir(id), f))), f);
    } catch { /* unreadable jar: reported as unknown below */ }
  }
  const known: Record<string, modrinth.Version> = await modrinth
    .identifyByHashes([...hashes.keys()])
    .catch(() => ({} as Record<string, modrinth.Version>));

  const mods: ModPlan[] = [];
  const projects = new Map<string, string>(); // projectId -> file
  for (const [hash, file] of hashes) {
    const v = known[hash];
    if (!v) {
      mods.push({ file, title: file, status: 'unknown', note: 'not on Modrinth (CurseForge or hand-placed) — check it yourself' });
      continue;
    }
    projects.set(v.project_id, file);
    mods.push({ file, title: file, projectId: v.project_id, status: 'incompatible' }); // provisional
  }

  // one lookup per project on the TARGET version
  const titles = await modrinth
    .getProjects([...projects.keys()])
    .then((ps) => new Map(ps.map((p) => [p.id, p.title])))
    .catch(() => new Map<string, string>());

  await Promise.all(
    [...projects.entries()].map(async ([projectId, file]) => {
      const row = mods.find((m) => m.file === file)!;
      row.title = titles.get(projectId) ?? file;
      try {
        const versions = await modrinth.getVersions(projectId, { mc: targetMc, loader });
        const best = versions.find((v) => v.version_type === 'release') ?? versions[0];
        if (!best) {
          row.status = 'incompatible';
          row.note = `no ${loader} build for ${targetMc} yet`;
          return;
        }
        const f = best.files.find((x) => x.primary) ?? best.files[0];
        if (!f) {
          row.status = 'incompatible';
          row.note = 'target version has no downloadable file';
          return;
        }
        row.targetVersionId = best.id;
        row.targetVersionNumber = best.version_number;
        row.targetFile = f.filename;
        row.targetUrl = f.url;
        row.status = f.filename === file ? 'ok' : 'update';
      } catch (e) {
        row.status = 'unknown';
        row.note = `lookup failed: ${String(e).slice(0, 80)}`;
      }
    }),
  );

  mods.sort((a, b) => a.title.localeCompare(b.title));
  const counts = {
    ok: mods.filter((m) => m.status === 'ok').length,
    update: mods.filter((m) => m.status === 'update').length,
    incompatible: mods.filter((m) => m.status === 'incompatible').length,
    unknown: mods.filter((m) => m.status === 'unknown').length,
  };
  const downgrade = currentMc !== '(unknown)' && cmpVersion(targetMc, currentMc) < 0;
  return {
    serverId: id,
    from: { mc: currentMc, loader },
    to: { mc: targetMc, loader },
    downgrade,
    worldWarning: downgrade
      ? `DOWNGRADE: your world was last opened on ${currentMc}. Minecraft upgrades chunks on load and cannot undo it — an older version may refuse to open this world or corrupt it. The world is backed up first, but the only safe downgrade is restoring that backup.`
      : undefined,
    mods,
    counts,
  };
}

export interface SwitchResult {
  ok: boolean;
  error?: string;
  updated?: string[];
  disabled?: string[];
  rolledBack?: boolean;
  backup?: string;
}

/** Download the Fabric server launcher for a specific game+loader version. */
async function fabricLauncher(mc: string, loaderVersion: string): Promise<Buffer> {
  // /v2/versions/loader/<game>/<loader>/<installer>/server/jar
  const installers = (await (await fetch(`${FABRIC_META}/versions/installer`)).json()) as { version: string; stable: boolean }[];
  const installer = installers.find((i) => i.stable)?.version ?? installers[0]?.version;
  if (!installer) throw new Error('no Fabric installer version available');
  const url = `${FABRIC_META}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loaderVersion)}/${encodeURIComponent(installer)}/server/jar`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fabric launcher download failed (${res.status}) for MC ${mc}`);
  return Buffer.from(await res.arrayBuffer());
}

/** DESTRUCTIVE. Swap the loader jar, update every mod, disable what has no
    build, then PROVE the server still boots — rolling everything back if not. */
export async function apply(
  id: string,
  targetMc: string,
  opts: { acceptDowngrade?: boolean; disableIncompatible?: boolean } = {},
): Promise<SwitchResult> {
  if (inFlight.has(id)) return { ok: false, error: 'a version switch is already running' };
  inFlight.add(id);
  beginMaintenance(id);
  try {
    return await doApply(id, targetMc, opts);
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e).slice(0, 300) };
  } finally {
    inFlight.delete(id);
    endMaintenance(id);
  }
}
const inFlight = new Set<string>();

async function doApply(id: string, targetMc: string, opts: { acceptDowngrade?: boolean; disableIncompatible?: boolean }): Promise<SwitchResult> {
  const p = await plan(id, targetMc);

  // EVERYTHING below this line assumes Fabric: it downloads a Fabric loader,
  // writes fabric.jar, and rewrites the launch command to run it. Nothing used
  // to check the loader, and the route accepts any server id — so pointing this
  // at the Forge 1.20.1 server would stop it, back up its world, then install a
  // FABRIC launcher over a Forge install and disable its mods. Refuse loudly.
  if (p.from.loader !== 'fabric') {
    return {
      ok: false,
      error: `Version switching is only implemented for Fabric. This server is ${p.from.loader} — switching it would install a Fabric launcher over ${p.from.loader} and break it. Create a new ${p.from.loader} server on the target version instead.`,
    };
  }

  if (p.downgrade && !opts.acceptDowngrade) {
    return { ok: false, error: p.worldWarning ?? 'downgrade not acknowledged' };
  }
  if (p.counts.incompatible > 0 && !opts.disableIncompatible) {
    return {
      ok: false,
      error: `${p.counts.incompatible} mod(s) have no ${p.to.loader} build for ${targetMc}. Re-run with "disable incompatible mods" to continue without them.`,
    };
  }

  const loaders = (await (await fetch(`${FABRIC_META}/versions/loader`)).json()) as { version: string; stable: boolean }[];
  const loaderVersion = loaders.find((l) => l.stable)?.version;
  if (!loaderVersion) return { ok: false, error: 'could not read Fabric loader versions' };

  // the world is the one thing we cannot roll back — back it up FIRST
  const dir = serverDir(id);
  const wasRunning = await isRunningSafe(id);
  if (wasRunning) {
    const stopped = await stopAndWait(id);
    if (!stopped) return { ok: false, error: 'server would not stop — try again' };
  }
  let backupFile: string | undefined;
  if (existsSync(join(dir, 'world'))) {
    const b = await createBackup(id).catch((e) => ({ error: String(e) }));
    if ('error' in b) return { ok: false, error: `world backup failed, refusing to switch: ${b.error}` };
    backupFile = b.file;
  }

  // snapshot mods/ + the loader jar so a failed boot is fully reversible
  const snap = snapDir(id);
  rmSync(snap, { recursive: true, force: true });
  mkdirSync(snap, { recursive: true });
  cpSync(modsDir(id), join(snap, 'mods'), { recursive: true });
  const jarPath = join(dir, 'fabric.jar');
  if (existsSync(jarPath)) cpSync(jarPath, join(snap, 'fabric.jar'));
  writeFileSync(join(snap, 'meta.json'), JSON.stringify({ from: p.from, to: p.to, at: new Date().toISOString(), backupFile }, null, 2));

  const updated: string[] = [];
  const disabled: string[] = [];
  try {
    // 1. new loader jar for the target MC
    writeFileSync(jarPath, await fabricLauncher(targetMc, loaderVersion));

    // 2. mods: download the target build, then remove the old jar
    for (const m of p.mods) {
      if (m.status === 'update' && m.targetUrl && m.targetFile) {
        const res = await fetch(m.targetUrl, { headers: { 'user-agent': 'spawnpoint/1.0' } });
        if (!res.ok) throw new Error(`download failed for ${m.title} (${res.status})`);
        const buf = Buffer.from(await res.arrayBuffer());
        const dest = join(modsDir(id), m.targetFile);
        const part = `${dest}.part`;
        writeFileSync(part, buf);
        renameSync(part, dest);
        if (m.targetFile !== m.file) rmSync(join(modsDir(id), m.file), { force: true });
        updated.push(`${m.title} → ${m.targetVersionNumber}`);
      } else if (m.status === 'incompatible' || m.status === 'unknown') {
        // unknown jars are disabled too: an un-updatable mod for the OLD
        // version is the single most likely thing to kill the boot
        const from = join(modsDir(id), m.file);
        if (existsSync(from)) renameSync(from, `${from}.disabled`);
        disabled.push(m.title);
      }
    }

    // 3. tell Crafty where the next launcher update comes from
    await craftyApi
      .patchServer(id, { executable_update_url: `https://meta.fabricmc.net/v2/versions/loader/${targetMc}/${loaderVersion}/stable/server/jar` })
      .catch(() => {});

    // 3b. re-pin Java for the TARGET version. A 1.21→26 upgrade needs Java 25,
    //     not the 21 this server launched on; without this the boot-verify below
    //     dies silently (UnsupportedClassVersionError under craftysvc) and rolls
    //     back a perfectly valid switch.
    await pinJavaFor(id, targetMc, p.to.loader).catch(() => {});

    // 4. BOOT-VERIFY: it only counts if the server actually comes up
    await craftyApi.action(id, 'start_server');
    const ready = await waitForReady(id, 240);
    if (!ready) throw new Error('the server did not come up on the new version within 4 minutes');

    return { ok: true, updated, disabled, backup: backupFile };
  } catch (e) {
    const err = String((e as Error).message ?? e).slice(0, 220);
    const rolled = await rollback(id).catch(() => false);
    return {
      ok: false,
      error: `${err} — ${rolled ? 'rolled back to the previous version' : 'ROLLBACK FAILED, restore from the snapshot in data/versionswitch'}`,
      rolledBack: rolled,
      backup: backupFile,
    };
  }
}

async function waitForReady(id: string, timeoutSec: number): Promise<boolean> {
  const until = Date.now() + timeoutSec * 1000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const stats = await craftyApi.getStats(id);
      if (!stats.running && !stats.waiting_start && Date.now() > until - timeoutSec * 1000 + 30_000) return false; // died
      if ((await serverPhase(id, true)) === 'ready') return true;
    } catch { /* keep waiting */ }
  }
  return false;
}

/** Put mods/ and the loader jar back the way they were before the switch. */
export async function rollback(id: string): Promise<boolean> {
  const snap = snapDir(id);
  if (!existsSync(join(snap, 'mods'))) return false;
  if (await isRunningSafe(id)) await stopAndWait(id);
  const dir = serverDir(id);
  rmSync(modsDir(id), { recursive: true, force: true });
  cpSync(join(snap, 'mods'), modsDir(id), { recursive: true });
  if (existsSync(join(snap, 'fabric.jar'))) cpSync(join(snap, 'fabric.jar'), join(dir, 'fabric.jar'));
  // restore the Java pin too — apply() may have moved it to the target's major,
  // which would be wrong for the version we're rolling back to.
  const from = snapshotInfo(id)?.from as { mc?: string; loader?: string } | undefined;
  await pinJavaFor(id, from?.mc ?? null, from?.loader ?? 'fabric').catch(() => {});
  return true;
}

export function snapshotInfo(id: string): { at: string; from: unknown; to: unknown; backupFile?: string } | null {
  try {
    return JSON.parse(readFileSync(join(snapDir(id), 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}
