import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { chownToDirOwner, writeFileAtomic } from './platform.js';
import { PATHS } from '../config.js';
import { serverDir, clientShelfDir } from './servers.js';
import { detect, type Detection } from './detect.js';
import * as modrinth from '../clients/modrinth.js';
import * as curseforge from '../clients/curseforge.js';
import type { ContentType, Version } from '../clients/modrinth.js';
import { queueChange, listPending, applyPending, type PendingAction } from './pendingmods.js';
import { ledgerEntries, updateLedger, type LedgerEntry } from './ledger.js';
import { stage, stagedFiles, stagingPath, invalidate, assertNoRecovery, type Candidate, type StagedFile } from './packtxn.js';
import { scanJars } from './jardeps.js';

// The install engine: picks the right build for the server's MC version and
// loader (releases first), resolves required dependencies (keeping any copy
// that is already installed), refuses builds their authors mark incompatible
// with something installed, and downloads with a checksum. Mods for modded
// servers go into the server's candidate (packtxn.ts) and reach the live
// folders only after a boot test. Plugins and datapacks install directly.

export interface InstallResult {
  installed: { file: string; title: string; version: string; clientOnly?: boolean }[];
  skipped: { projectId: string; reason: string }[];
  warnings: string[];
  restartRequired: boolean;
  /** a refusal the player must act on (incompatible or duplicate mod) */
  error?: string;
  /** CurseForge authors can forbid API downloads; these need a manual download */
  manualDownloads?: { title: string; url: string }[];
  /** the mod change these files joined; they go live only after it passes */
  candidate?: Candidate;
  /** why this install went live without a boot test */
  untested?: string;
}

export interface InstallOpts {
  projectId: string;
  versionId?: string;
  type: ContentType;
  /** accepted for older clients; installs no longer ask for confirmation */
  force?: boolean;
  /** write straight into the live folders: only for a server being created */
  direct?: boolean;
}

/** One file the plan wants installed. */
interface Planned {
  url: string;
  size?: number;
  sha1?: string;
  entry: LedgerEntry;
  replaces?: string;
}

const MOD_LOADERS = new Set(['fabric', 'forge', 'neoforge']);

function targetDir(uuid: string, type: ContentType): string {
  const dir = serverDir(uuid);
  if (type === 'mod') return join(dir, 'mods');
  if (type === 'plugin') return join(dir, 'plugins'); // Bukkit-family jars load from plugins/
  if (type === 'datapack') return join(dir, 'world', 'datapacks');
  return PATHS.downloads; // resource and shader packs are client-side
}

/** Where this server's jars live: plugins/ on Bukkit-family servers, mods/ otherwise. */
function jarDir(uuid: string): string {
  const dir = serverDir(uuid);
  return modrinth.isPluginLoader(detect(dir, uuid).loader) ? join(dir, 'plugins') : join(dir, 'mods');
}

async function isRunning(uuid: string): Promise<boolean> {
  const { craftyApi } = await import('../clients/crafty.js');
  return craftyApi.getStats(uuid).then((s) => s.running, () => false);
}

/** What is installed or already staged, by project id. A ledger entry whose
    file is gone does not count. */
function knownProjects(serverUuid: string): Map<string, LedgerEntry> {
  const dirs = [jarDir(serverUuid), clientShelfDir(serverUuid), join(serverDir(serverUuid), 'world', 'datapacks')];
  const known = new Map<string, LedgerEntry>();
  for (const e of ledgerEntries(serverUuid)) {
    if (dirs.some((d) => existsSync(join(d, e.file)))) known.set(e.projectId, e);
  }
  for (const f of stagedFiles(serverUuid)) if (f.entry) known.set(f.entry.projectId, f.entry);
  return known;
}

/** Modrinth and CurseForge ids never match, so the same mod from the other
    source shows up only by title. Two copies of one mod stop a server booting. */
const titleKey = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]/g, '');

class Refusal extends Error {}

async function fetchFile(url: string, sha1?: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { 'user-agent': 'spawnpoint/1.0' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha1 && createHash('sha1').update(buf).digest('hex') !== sha1) throw new Error('download failed its checksum');
  return buf;
}



/** Download a plan and either stage it (mods on modded servers) or write it
    straight into the live folders. */
async function commit(serverUuid: string, det: Detection, type: ContentType, plan: Planned[], direct: boolean, result: InstallResult, log: (m: string) => void): Promise<InstallResult> {
  const viaCandidate = type === 'mod' && MOD_LOADERS.has(det.loader) && !direct;
  const staged: { file: StagedFile; buf: Buffer }[] = [];
  const written: LedgerEntry[] = [];
  for (const p of plan) {
    const clientOnly = !!p.entry.clientOnly;
    let buf: Buffer;
    try {
      buf = await fetchFile(p.url, p.sha1);
    } catch (e) {
      result.skipped.push({ projectId: p.entry.title, reason: String((e as Error).message ?? e) });
      continue;
    }
    result.installed.push({ file: p.entry.file, title: p.entry.title, version: p.entry.versionNumber, ...(clientOnly ? { clientOnly: true } : {}) });
    if (viaCandidate) {
      staged.push({ file: { file: p.entry.file, to: clientOnly ? 'shelf' : 'mods', replaces: p.replaces, entry: p.entry }, buf });
    } else {
      writeFileAtomic(join(clientOnly ? clientShelfDir(serverUuid) : targetDir(serverUuid, type), p.entry.file), buf);
      if (p.replaces && p.replaces !== p.entry.file) {
        for (const d of [targetDir(serverUuid, type), clientShelfDir(serverUuid)]) {
          try { unlinkSync(join(d, p.replaces)); } catch { /* not there */ }
        }
      }
      written.push(p.entry);
    }
  }
  // one synchronous step from the first staged byte to stage(): a running
  // test sees the generation change before any file under it is replaced
  if (staged.length) {
    // a running test must not pass on bytes about to be replaced, even if a
    // write below fails before stage() registers the batch
    assertNoRecovery(serverUuid);
    invalidate(serverUuid);
    const known = new Set(stagedFiles(serverUuid).map((f) => f.file));
    const written: string[] = [];
    try {
      for (const s of staged) {
        writeFileAtomic(stagingPath(serverUuid, s.file.file), s.buf);
        written.push(s.file.file);
      }
    } catch (e) {
      // files this batch added, not ones it replaced, are orphans: remove them
      for (const f of written) if (!known.has(f)) rmSync(stagingPath(serverUuid, f), { force: true });
      throw e;
    }
    result.candidate = stage(serverUuid, staged.map((s) => s.file), log);
  }
  if (written.length) {
    const names = new Set(written.map((e) => e.file));
    const replaced = new Set(plan.map((p) => p.replaces).filter(Boolean));
    updateLedger(serverUuid, (entries) => entries.filter((e) => !names.has(e.file) && !replaced.has(e.file)).concat(written));
    if (type === 'mod' || type === 'plugin' || type === 'datapack') {
      await chownToDirOwner(targetDir(serverUuid, type));
      if (!direct) result.untested = type === 'mod' ? `Spawnpoint cannot boot-test ${det.loader} servers yet` : `${type}s are not boot-tested`;
    }
  }
  return result;
}

const noLog = (): void => {};

export async function install(serverUuid: string, opts: InstallOpts, log: (m: string) => void = noLog): Promise<InstallResult> {
  const { type } = opts;
  const det = detect(serverDir(serverUuid), serverUuid);
  const isServerContent = type === 'mod' || type === 'plugin' || type === 'datapack';
  const result: InstallResult = { installed: [], skipped: [], warnings: [], restartRequired: isServerContent };
  const known = knownProjects(serverUuid);
  const filter =
    type === 'mod' || type === 'plugin'
      ? { mc: det.mc ?? undefined, loader: det.loader === 'unknown' ? undefined : det.loader }
      : type === 'datapack' ? { mc: det.mc ?? undefined, loader: 'datapack' } : {};
  const fits = (v: Version): boolean => (!filter.mc || v.game_versions.includes(filter.mc)) && (!filter.loader || v.loaders.includes(filter.loader));
  const plan: Planned[] = [];
  const seen = new Set<string>();

  const visit = async (projectId: string, pinned: string | null | undefined, isDep: boolean): Promise<void> => {
    if (seen.has(projectId) || (isDep && known.has(projectId))) return;
    seen.add(projectId);
    let version = pinned ? await modrinth.getVersion(pinned).catch(() => undefined) : undefined;
    // a dependency pinned to a build for another MC version or loader is replaced by the best fitting one
    if (version && isDep && !fits(version)) version = undefined;
    version ??= modrinth.bestVersion(await modrinth.getVersions(projectId, filter).catch(() => []));
    if (!version) {
      result.skipped.push({ projectId, reason: `no build for ${det.mc ?? '?'}/${det.loader}` });
      return;
    }
    seen.add(version.project_id);
    if (isDep && known.has(version.project_id)) return; // keep the copy already installed
    const existing = known.get(version.project_id);
    if (existing?.versionId === version.id) {
      result.skipped.push({ projectId, reason: 'already installed' });
      return;
    }
    const file = version.files.find((f) => f.primary) ?? version.files[0];
    if (!file) {
      result.skipped.push({ projectId, reason: 'version has no files' });
      return;
    }
    const proj = await modrinth.getProject(version.project_id).catch(() => null);
    const title = proj?.title ?? version.name;
    if (isServerContent && !existing) {
      const dup = [...known.values()].find((e) => e.source === 'curseforge' && titleKey(e.title) === titleKey(title));
      if (dup) throw new Refusal(`"${title}" is already installed from CurseForge as ${dup.file}. Two copies of one mod stop the server booting; delete that one first.`);
    }
    for (const dep of version.dependencies) {
      const other = dep.dependency_type === 'incompatible' && dep.project_id ? known.get(dep.project_id) : undefined;
      if (other) throw new Refusal(`${title} is marked incompatible with ${other.title} by its author.`);
    }
    // a mod Modrinth says the server cannot run goes to the client shelf
    const clientOnly = type === 'mod' && !!proj && proj.server_side === 'unsupported' && proj.client_side !== 'unsupported';
    plan.push({
      url: file.url, size: file.size, sha1: file.hashes.sha1, replaces: existing?.file,
      entry: {
        file: file.filename, projectId: version.project_id, versionId: version.id, versionNumber: version.version_number,
        title, source: 'modrinth', sha1: file.hashes.sha1, installedAt: new Date().toISOString(),
        via: isDep ? 'dependency' : 'direct', categories: proj?.categories, ...(clientOnly ? { clientOnly: true } : {}),
      },
    });
    if (type === 'mod' || type === 'plugin') {
      for (const dep of version.dependencies.filter((d) => d.dependency_type === 'required' && d.project_id)) {
        await visit(dep.project_id!, dep.version_id, true);
      }
    }
  };

  try {
    await visit(opts.projectId, opts.versionId, false);
    await refuseReverseIncompatible(serverUuid, plan);
  } catch (e) {
    if (e instanceof Refusal) return { ...result, error: e.message };
    throw e;
  }
  return commit(serverUuid, det, type, plan, !!opts.direct, result, log);
}

/** An installed mod whose author marks a planned one incompatible blocks the plan too. */
async function refuseReverseIncompatible(serverUuid: string, plan: Planned[]): Promise<void> {
  const planned = new Set(plan.map((p) => p.entry.projectId));
  const replacing = new Set(plan.map((p) => p.replaces).filter(Boolean));
  const installed = [...knownProjects(serverUuid).values()].filter((e) => e.source === 'modrinth' && !replacing.has(e.file) && !planned.has(e.projectId));
  if (!installed.length || !planned.size) return;
  const versions = await modrinth.getVersionsBulk(installed.map((e) => e.versionId)).catch(() => []);
  for (const v of versions) {
    const clash = v.dependencies.find((d) => d.dependency_type === 'incompatible' && d.project_id && planned.has(d.project_id));
    if (clash) {
      const mine = installed.find((e) => e.versionId === v.id)?.title ?? v.name;
      const theirs = plan.find((p) => p.entry.projectId === clash.project_id)?.entry.title ?? 'this mod';
      throw new Refusal(`${mine} (installed) is marked incompatible with ${theirs} by its author.`);
    }
  }
}

export type ModGroup = 'performance' | 'support' | 'gameplay';

/** CurseForge install: same contract as install(). CurseForge has no client/
    server flag, so sides are borrowed from the Modrinth listing with the same slug. */
export async function installCurseforge(
  serverUuid: string,
  opts: { modId: string; fileId?: string; type?: ContentType; force?: boolean; direct?: boolean },
  log: (m: string) => void = noLog,
): Promise<InstallResult> {
  const type: ContentType = opts.type ?? 'mod';
  const det = detect(serverDir(serverUuid), serverUuid);
  const isServerContent = type === 'mod' || type === 'plugin' || type === 'datapack';
  const result: InstallResult = { installed: [], skipped: [], warnings: [], restartRequired: isServerContent };
  const known = knownProjects(serverUuid);
  const plan: Planned[] = [];
  const seen = new Set<string>();

  const visit = async (modId: string, pinnedFileId: string | undefined, isDep: boolean): Promise<void> => {
    if (seen.has(modId) || (isDep && known.has(modId))) return;
    seen.add(modId);
    const mod = await curseforge.getMod(modId).catch(() => null);
    if (!mod) {
      result.skipped.push({ projectId: modId, reason: 'project not found on CurseForge' });
      return;
    }
    const files = await curseforge.getFiles(modId, {
      mc: det.mc ?? undefined,
      // only mods are loader-specific
      loader: type === 'mod' && det.loader !== 'unknown' ? det.loader : undefined,
    });
    const file = (pinnedFileId && files.find((f) => String(f.id) === pinnedFileId)) || curseforge.bestFile(files);
    if (!file) {
      result.skipped.push({ projectId: mod.name, reason: `no build for ${det.mc ?? '?'}/${det.loader}` });
      return;
    }
    const existing = known.get(String(mod.id));
    if (existing?.versionId === String(file.id)) {
      result.skipped.push({ projectId: mod.name, reason: 'already installed' });
      return;
    }
    if (isServerContent && !existing) {
      const dup = [...known.values()].find((e) => e.source === 'modrinth' && titleKey(e.title) === titleKey(mod.name));
      if (dup) throw new Refusal(`"${mod.name}" is already installed from Modrinth as ${dup.file}. Two copies of one mod stop the server booting; delete that one first.`);
    }
    for (const dep of file.dependencies) {
      const other = dep.relationType === curseforge.RELATION.incompatible ? known.get(String(dep.modId)) : undefined;
      if (other) throw new Refusal(`${mod.name} is marked incompatible with ${other.title} by its author.`);
    }
    if (!file.downloadUrl) {
      // the author ticked "no third-party downloads"; no retry will help
      (result.manualDownloads ??= []).push({ title: mod.name, url: mod.links?.websiteUrl ?? `https://www.curseforge.com/minecraft/mc-mods/${modId}` });
      result.warnings.push(`${mod.name}: the author blocked API downloads, so download the jar yourself`);
      return;
    }
    let clientOnly = false;
    if (type === 'mod' && mod.slug) {
      const [cross] = await modrinth.getProjects([mod.slug]).catch(() => []);
      clientOnly = !!cross && cross.server_side === 'unsupported' && cross.client_side !== 'unsupported';
    }
    const sha1 = file.hashes.find((h) => h.algo === 1)?.value;
    plan.push({
      url: file.downloadUrl, sha1, replaces: existing?.file,
      entry: {
        file: file.fileName, projectId: String(mod.id), versionId: String(file.id), versionNumber: file.displayName,
        title: mod.name, source: 'curseforge', sha1: sha1 ?? '', installedAt: new Date().toISOString(),
        via: isDep ? 'dependency' : 'direct', categories: curseforge.mapCategories(mod.categories), ...(clientOnly ? { clientOnly: true } : {}),
      },
    });
    if (type === 'mod') {
      for (const dep of file.dependencies.filter((d) => d.relationType === curseforge.RELATION.required)) {
        await visit(String(dep.modId), undefined, true);
      }
    }
  };

  try {
    await visit(opts.modId, opts.fileId, false);
  } catch (e) {
    if (e instanceof Refusal) return { ...result, error: e.message };
    throw e;
  }
  return commit(serverUuid, det, type, plan, !!opts.direct, result, log);
}

export interface InstalledItem {
  file: string;
  enabled: boolean;
  title: string | null;
  versionNumber: string | null;
  projectId: string | null;
  sizeMb: number;
  group: ModGroup;
  via: 'direct' | 'dependency' | 'unknown';
  source: 'modrinth' | 'curseforge' | null;
  /** queued while the running server held the jar open — applies on next stop */
  pending?: PendingAction;
  clientOnly?: boolean;
  /** non-jar client assets living in the synced pack (resourcepacks/shaders) */
  kind?: 'resourcepack' | 'shader';
}

// CurseForge file fingerprint: MurmurHash2 (seed 1) over the file bytes with
// whitespace (\t \n \r space) removed — that's CF's exact algorithm.
function cfFingerprint(buf: Buffer): number {
  const data: number[] = [];
  for (const b of buf) {
    if (b !== 9 && b !== 10 && b !== 13 && b !== 32) data.push(b);
  }
  const m = 0x5bd1e995;
  let len = data.length;
  let h = (1 ^ len) >>> 0;
  let i = 0;
  while (len >= 4) {
    let k = data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24);
    k = Math.imul(k, m);
    k ^= k >>> 24;
    k = Math.imul(k, m);
    h = (Math.imul(h, m) ^ k) >>> 0;
    i += 4;
    len -= 4;
  }
  if (len === 3) h ^= data[i + 2] << 16;
  if (len >= 2) h ^= data[i + 1] << 8;
  if (len >= 1) {
    h ^= data[i];
    h = Math.imul(h, m) >>> 0;
  }
  h ^= h >>> 13;
  h = Math.imul(h, m) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

// well-known library/support mods that predate `via` tracking
const KNOWN_SUPPORT = ['fabric-api', 'collective', 'almanac', 'placebo', 'balm', 'shogi', 'cloth-config', 'architectury', 'bluemap'];

function classify(
  file: string,
  via: 'direct' | 'dependency' | 'unknown',
  categories?: string[],
): ModGroup {
  const f = file.toLowerCase();
  // Modrinth's own taxonomy decides for anything new
  if (categories?.includes('optimization')) return 'performance';
  if (categories?.includes('library')) return 'support';
  if (via === 'dependency') return 'support';
  if (KNOWN_SUPPORT.some((k) => f.includes(k.replace(/-/g, '')) || f.includes(k))) return 'support';
  return 'gameplay';
}

export async function listInstalled(serverUuid: string): Promise<InstalledItem[]> {
  // Opportunistic flush: if the server has since stopped, the jars are free and
  // anything the player queued while it was running lands NOW — so simply
  // stopping the server and reopening this page does what they asked.
  if (!(await isRunning(serverUuid))) applyPending(serverUuid);
  const pendingByFile = new Map(listPending(serverUuid).map((c) => [c.file, c.action]));

  const dir = jarDir(serverUuid);
  if (!existsSync(dir)) return [];
  const ledger = ledgerEntries(serverUuid);
  const byFile = new Map(ledger.map((e) => [e.file, e]));

  const files = readdirSync(dir).filter((f) => f.endsWith('.jar') || f.endsWith('.jar.disabled'));
  const unknown = files.filter((f) => !byFile.has(f.replace(/\.disabled$/, '')));

  // identify unledgered jars by hash (user-added files, e.g. via Crafty)
  if (unknown.length > 0 && unknown.length <= 30) {
    const hashes = new Map<string, string>();
    for (const f of unknown) {
      const sha1 = createHash('sha1').update(readFileSync(join(dir, f))).digest('hex');
      hashes.set(sha1, f.replace(/\.disabled$/, ''));
    }
    const found = await modrinth.identifyByHashes([...hashes.keys()]).catch(() => ({}) as never);
    // one bulk call for real titles + categories (version.name is often junk)
    const projIds = [...new Set(Object.values(found).map((v) => v.project_id))];
    const projects = await modrinth.getProjects(projIds).catch(() => []);
    const projById = new Map(projects.map((p) => [p.id, p]));
    for (const [sha1, version] of Object.entries(found)) {
      const file = hashes.get(sha1);
      if (!file) continue;
      const proj = projById.get(version.project_id);
      byFile.set(file, {
        file,
        projectId: version.project_id,
        versionId: version.id,
        versionNumber: version.version_number,
        title: proj?.title ?? version.name,
        source: 'modrinth',
        sha1,
        installedAt: '',
        categories: proj?.categories,
      });
    }
    // second pass: whatever Modrinth didn't know, try CF fingerprints
    // (CF-exclusive mods added by hand or via a CF modpack)
    const stillUnknown = unknown.map((f) => f.replace(/\.disabled$/, '')).filter((f) => !byFile.has(f));
    if (stillUnknown.length > 0) {
      try {
        const prints = new Map<number, string>();
        for (const f of stillUnknown) {
          const raw = readFileSync(join(dir, existsSync(join(dir, f)) ? f : `${f}.disabled`));
          prints.set(cfFingerprint(raw), f);
        }
        const matches = await curseforge.fingerprintMatch([...prints.keys()]);
        const mods = await curseforge.getModsBulk([...new Set(matches.map((m) => m.file.modId))]);
        const modById = new Map(mods.map((m) => [m.id, m]));
        for (const match of matches) {
          const target = prints.get(match.file.fileFingerprint);
          if (!target) continue;
          const mod = modById.get(match.file.modId);
          byFile.set(target, {
            file: target,
            projectId: String(match.file.modId),
            versionId: String(match.file.id),
            versionNumber: match.file.displayName,
            title: mod?.name ?? match.file.displayName,
            source: 'curseforge',
            sha1: match.file.hashes.find((h) => h.algo === 1)?.value ?? '',
            installedAt: '',
            categories: mod ? curseforge.mapCategories(mod.categories) : undefined,
          });
        }
      } catch {
        /* no CF key configured or API down — they just stay unlabeled */
      }
    }

    // persist identifications so we never re-hash these files
    const fresh = [...byFile.values()].filter((e) => e.installedAt === '');
    if (fresh.length > 0) {
      updateLedger(serverUuid, (entries) => {
        const have = new Set(entries.map((e) => e.file));
        return entries.concat(fresh.filter((e) => !have.has(e.file)));
      });
    }
  }

  // client-shelf items ride along: never in mods/, always in the export
  const shelf = clientShelfDir(serverUuid);
  const shelfItems: InstalledItem[] = existsSync(shelf)
    ? readdirSync(shelf)
        .filter((f) => f.endsWith('.jar'))
        .map((f) => {
          const entry = byFile.get(f) ?? ledger.find((e) => e.file === f);
          return {
            file: f,
            enabled: true,
            title: entry?.title ?? null,
            versionNumber: entry?.versionNumber ?? null,
            projectId: entry?.projectId ?? null,
            sizeMb: Math.round((statSync(join(shelf, f)).size / 1e6) * 10) / 10,
            group: 'gameplay' as ModGroup,
            via: entry?.via ?? 'unknown',
            source: entry?.source ?? null,
            clientOnly: true,
          };
        })
    : [];
  // client ASSETS (resourcepacks/shaders) live in the synced pack, not in
  // mods/, so list them here too or installs look like no-ops.
  // deleteInstalled knows their paths.
  const assetItems: InstalledItem[] = [];
  const amMain = join(serverDir(serverUuid), 'automodpack', 'host-modpack', 'main');
  for (const [folder, kind] of [['resourcepacks', 'resourcepack'], ['shaderpacks', 'shader']] as const) {
    const d = join(amMain, folder);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((x) => /\.zip$/i.test(x))) {
      const entry = ledger.find((e) => e.file === f);
      assetItems.push({
        file: f,
        enabled: true,
        title: entry?.title ?? f.replace(/\.zip$/i, ''),
        versionNumber: entry?.versionNumber ?? null,
        projectId: entry?.projectId ?? null,
        sizeMb: Math.round((statSync(join(d, f)).size / 1e6) * 10) / 10,
        group: 'gameplay' as ModGroup,
        via: entry?.via ?? 'direct',
        source: entry?.source ?? null,
        clientOnly: true,
        kind,
      });
    }
  }
  return shelfItems.concat(assetItems, files.map((f) => {
    const clean = f.replace(/\.disabled$/, '');
    const entry = byFile.get(clean);
    const via = entry?.via ?? 'unknown';
    return {
      file: clean,
      enabled: !f.endsWith('.disabled'),
      title: entry?.title ?? null,
      versionNumber: entry?.versionNumber ?? null,
      projectId: entry?.projectId ?? null,
      sizeMb: Math.round((statSync(join(dir, f)).size / 1e6) * 10) / 10,
      group: classify(clean, via, entry?.categories),
      via,
      source: entry?.source ?? null,
      pending: pendingByFile.get(clean),
    };
  }));
}

export interface UpdateInfo {
  file: string;
  title: string;
  from: string;
  to: string;
  projectId: string;
  versionId: string;
  source: 'modrinth' | 'curseforge';
  changelog?: string;
}

/** Compare every ledgered jar against the newest matching Modrinth build. */
export async function checkUpdates(serverUuid: string): Promise<UpdateInfo[]> {
  const det = detect(serverDir(serverUuid), serverUuid);
  const filter = { mc: det.mc ?? undefined, loader: det.loader === 'unknown' ? undefined : det.loader };
  // an "update" is only ever newer than what is installed: a release
  // preference or a pinned line must not offer a downgrade
  const check = async (e: LedgerEntry): Promise<UpdateInfo | null> => {
    if (e.source === 'curseforge') {
      const files = await curseforge.getFiles(e.projectId, filter);
      const latest = curseforge.bestFile(files);
      const current = files.find((f) => String(f.id) === e.versionId);
      if (!latest || String(latest.id) === e.versionId || (current && latest.fileDate <= current.fileDate)) return null;
      const changelog = await curseforge.getChangelog(e.projectId, latest.id).then((c) => c.slice(0, 1500)).catch(() => undefined);
      return { file: e.file, title: e.title, from: e.versionNumber, to: latest.displayName, projectId: e.projectId, versionId: String(latest.id), source: 'curseforge', changelog };
    }
    const versions = await modrinth.getVersions(e.projectId, filter);
    const latest = modrinth.bestVersion(versions);
    const current = versions.find((v) => v.id === e.versionId);
    if (!latest || latest.id === e.versionId || (current && latest.date_published <= current.date_published)) return null;
    return { file: e.file, title: e.title, from: e.versionNumber, to: latest.version_number, projectId: e.projectId, versionId: latest.id, source: 'modrinth', changelog: latest.changelog?.slice(0, 1500) ?? undefined };
  };
  const entries = ledgerEntries(serverUuid);
  const updates: UpdateInfo[] = [];
  for (let i = 0; i < entries.length; i += 8) {
    const batch = await Promise.all(entries.slice(i, i + 8).map((e) => check(e).catch(() => null)));
    updates.push(...batch.filter((u): u is UpdateInfo => !!u));
  }
  return updates;
}

/** A plugin update must land in plugins/, not mods/. */
function contentTypeOf(serverUuid: string, file: string): ContentType {
  return existsSync(join(serverDir(serverUuid), 'plugins', file)) ? 'plugin' : 'mod';
}

/** Install every available update; mods join the server's candidate. */
export async function updateAll(serverUuid: string, log: (m: string) => void = noLog): Promise<{ updated: string[]; warnings: string[]; candidate?: Candidate }> {
  const updated: string[] = [];
  const warnings: string[] = [];
  let candidate: Candidate | undefined;
  for (const u of await checkUpdates(serverUuid)) {
    const res = u.source === 'curseforge'
      ? await installCurseforge(serverUuid, { modId: u.projectId, fileId: u.versionId, type: contentTypeOf(serverUuid, u.file) }, log)
      : await install(serverUuid, { projectId: u.projectId, versionId: u.versionId, type: contentTypeOf(serverUuid, u.file) }, log);
    if (res.installed.length) updated.push(`${u.title} ${u.from} -> ${u.to}`);
    if (res.error) warnings.push(res.error);
    warnings.push(...res.warnings);
    candidate = res.candidate ?? candidate;
  }
  return { updated, warnings, candidate };
}

export function toggleInstalled(
  serverUuid: string,
  file: string,
): { enabled: boolean; pending?: PendingAction } {
  assertNoRecovery(serverUuid);
  const dir = jarDir(serverUuid);
  const clean = basename(file); // no path traversal
  if (existsSync(join(clientShelfDir(serverUuid), clean))) {
    throw new Error(`${clean} is a client-only mod — it is never loaded by the server, so there is nothing to toggle. Delete it to drop it from the pack.`);
  }
  const jar = join(dir, clean);
  const disabled = `${jar}.disabled`;
  const isOn = existsSync(jar);
  if (!isOn && !existsSync(disabled)) throw new Error(`${clean} not found`);

  if (isOn) assertNotRequired(serverUuid, clean);
  try {
    if (isOn) {
      renameSync(jar, disabled);
      return { enabled: false };
    }
    // re-ENABLING is usually safe: a .disabled file is not loaded, so nothing
    // holds it open. Only the disable direction normally hits the lock.
    renameSync(disabled, jar);
    return { enabled: true };
  } catch (e) {
    if (!/EBUSY|EPERM|EACCES/i.test(String((e as NodeJS.ErrnoException).code ?? e))) throw e;
    // The running server has the jar open and Windows will not budge. Don't just
    // refuse — QUEUE it and apply the moment the server is down, so the click
    // actually does what the player asked, just not this instant.
    queueChange(serverUuid, clean, isOn ? 'disable' : 'enable');
    return { enabled: isOn, pending: isOn ? 'disable' : 'enable' };
  }
}

/** Refuse to take out a jar that other installed mods require: nothing
    boot-tests a removal, so this is the check that keeps it safe. */
export function assertNotRequired(serverUuid: string, file: string): void {
  const jars = [jarDir(serverUuid), clientShelfDir(serverUuid)].flatMap((d) =>
    existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.jar')).map((f) => join(d, f)) : []);
  if (!jars.some((p) => basename(p) === file)) return;
  const before = new Set(scanJars(jars, true).missing);
  const after = scanJars(jars.filter((p) => basename(p) !== file), true);
  const needers = [...new Set(after.missing.filter((m) => !before.has(m)).flatMap((m) => after.requesters[m] ?? []))];
  if (needers.length) throw new Error(`${file} is required by ${needers.join(', ')}; remove ${needers.length === 1 ? 'that' : 'those'} first`);
}

export function deleteInstalled(serverUuid: string, file: string): { pending?: PendingAction } {
  assertNoRecovery(serverUuid);
  const dir = jarDir(serverUuid);
  const clean = basename(file);
  assertNotRequired(serverUuid, clean);
  const amMain = join(serverDir(serverUuid), 'automodpack', 'host-modpack', 'main');
  for (const p of [
    join(dir, clean), join(dir, `${clean}.disabled`), join(clientShelfDir(serverUuid), clean),
    // client assets live in the synced pack, never in mods/
    join(amMain, 'resourcepacks', clean), join(amMain, 'shaderpacks', clean),
  ]) {
    if (existsSync(p)) {
      try {
        unlinkSync(p);
      } catch (e) {
        if (!/EBUSY|EPERM|EACCES/i.test(String((e as NodeJS.ErrnoException).code ?? e))) throw e;
        // locked by the running server — queue it instead of refusing (see pendingmods.ts)
        queueChange(serverUuid, clean, 'delete');
        return { pending: 'delete' };
      }
    }
  }
  updateLedger(serverUuid, (entries) => entries.filter((e) => e.file !== clean));
  return {};
}
