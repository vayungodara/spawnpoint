import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
  renameSync, unlinkSync, statSync,
} from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { chownToDirOwner } from './platform.js';
import { PATHS } from '../config.js';
import { serverDir } from './servers.js';
import { detect } from './detect.js';
import { craftyApi } from '../clients/crafty.js';
import * as modrinth from '../clients/modrinth.js';
import * as curseforge from '../clients/curseforge.js';
import type { ContentType, Version } from '../clients/modrinth.js';
import { queueChange, listPending, applyPending, type PendingAction } from './pendingmods.js';

// The install engine: version-matched downloads, recursive REQUIRED-dependency
// resolution, old-version dedup, and a ledger so installed jars stay
// identifiable. Direct port of Add-PerfMods.ps1's Fetch with extra safety.

interface LedgerEntry {
  file: string;
  projectId: string;
  versionId: string;
  versionNumber: string;
  title: string;
  source: 'modrinth' | 'curseforge';
  sha1: string;
  installedAt: string;
  via?: 'direct' | 'dependency'; // dependency = auto-installed support mod
  categories?: string[]; // Modrinth categories - drives auto-grouping
  /** lives on the CLIENT SHELF (data/clientmods/<id>/), never in the server's
      mods/ — in the exported pack, invisible to the server, zero boot risk */
  clientOnly?: boolean;
}
type Ledger = Record<string, LedgerEntry[]>; // serverUuid -> entries

function loadLedger(): Ledger {
  try {
    return JSON.parse(readFileSync(PATHS.ledgerFile, 'utf8'));
  } catch {
    return {};
  }
}
function saveLedger(l: Ledger): void {
  mkdirSync(PATHS.data, { recursive: true });
  writeFileSync(PATHS.ledgerFile, JSON.stringify(l, null, 2), 'utf8');
}

/** Flip a ledger entry to client-only after its jar was MOVED to the shelf
    (preflight's client-crash self-heal) — uninstall and dedup resolve the
    jar's directory through this flag, so a stale false would point them at a
    mods/ path that no longer exists. No entry = hand-placed jar, nothing to fix. */
export function markClientOnly(serverUuid: string, file: string): void {
  const ledger = loadLedger();
  const e = (ledger[serverUuid] ?? []).find((x) => x.file === file);
  if (!e || e.clientOnly) return;
  e.clientOnly = true;
  saveLedger(ledger);
}

function targetDir(uuid: string, type: ContentType): string {
  const dir = serverDir(uuid);
  if (type === 'mod') return join(dir, 'mods');
  if (type === 'plugin') return join(dir, 'plugins'); // Bukkit-family jars load from here, NOT mods/
  if (type === 'datapack') return join(dir, 'world', 'datapacks');
  return PATHS.downloads; // resourcepacks/shaders are client-side -> collection
}

/** Content that lands in the server folder (vs. the client downloads collection). */
const SERVER_SIDE_TYPES: ContentType[] = ['mod', 'plugin', 'datapack'];
const isServerType = (t: ContentType): boolean => SERVER_SIDE_TYPES.includes(t);

/** Where THIS server's jars live. Bukkit-family servers have no mods/ folder at
 *  all — their jars load from plugins/ — so the installed list, toggle and
 *  delete all have to follow the loader instead of assuming mods/. */
/** Client-only mods live OUTSIDE the server dir: the server can't load what
    it can't see, so a client-only mod can never crash a boot. The pack export
    reads them from here. */
export function clientShelfDir(uuid: string): string {
  return join(PATHS.data, 'clientmods', uuid);
}

function jarDir(uuid: string): string {
  const dir = serverDir(uuid);
  return modrinth.isPluginLoader(detect(dir, uuid).loader) ? join(dir, 'plugins') : join(dir, 'mods');
}

async function isRunning(uuid: string): Promise<boolean> {
  try {
    return (await craftyApi.getStats(uuid)).running;
  } catch {
    return false;
  }
}

export interface InstallResult {
  installed: { file: string; title: string; version: string; clientOnly?: boolean }[];
  skipped: { projectId: string; reason: string }[];
  warnings: string[];
  restartRequired: boolean;
  /** a refusal the player must act on (e.g. the same mod is already installed
      from the other source, and two copies would stop the server booting) */
  error?: string;
  /** CurseForge authors can forbid API downloads (downloadUrl: null). That is
      a hard wall — no panel can fetch the file. Surfaced as STRUCTURED data so
      the UI can show a real "download it yourself" prompt with a link, instead
      of burying it in a warning string the player scrolls past. */
  manualDownloads?: { title: string; url: string }[];
}

/** Modrinth and CurseForge use DIFFERENT id spaces for the same mod (CF is
 *  numeric, Modrinth is base62), so a mod installed from one source is invisible
 *  to the other: it shows an "Install" button again, the dedup (which matches on
 *  project id) does not fire, and you end up with TWO jars of the same mod in
 *  mods/ — which Fabric and Forge both refuse to boot with ("duplicate mod").
 *  Titles are the only identity the two sources share, so normalise and compare. */
const titleKey = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]/g, '');

function crossSourceDuplicate(serverUuid: string, title: string, projectId: string): LedgerEntry | null {
  const key = titleKey(title);
  return (
    (loadLedger()[serverUuid] ?? []).find((e) => e.projectId !== projectId && titleKey(e.title) === key) ?? null
  );
}

// installs actively downloading — the batched preflight consults this so it
// never dry-boots a HALF-INSTALLED folder (live 2026-08-02: a 17-mod spree
// was judged while YungsApi was still in flight, FML saw it "[MISSING]" and
// the gate convicted all 19 jars of a race condition)
let installsInFlight = 0;
let lastInstallDone = 0;
/** busy = an install is downloading OR one finished moments ago — a user
    mid-spree clicks installs seconds apart, and a dry-boot fired into one of
    those gaps judges a folder that is still growing */
export function installerBusy(): boolean {
  return installsInFlight > 0 || Date.now() - lastInstallDone < 15_000;
}

export async function install(
  serverUuid: string,
  opts: { projectId: string; versionId?: string; type: ContentType; force?: boolean },
): Promise<InstallResult | { needsConfirm: true; reason: string }> {
  installsInFlight++;
  try {
    return await installInner(serverUuid, opts);
  } finally {
    installsInFlight--;
    lastInstallDone = Date.now();
  }
}

async function installInner(
  serverUuid: string,
  opts: { projectId: string; versionId?: string; type: ContentType; force?: boolean },
): Promise<InstallResult | { needsConfirm: true; reason: string }> {
  const { type } = opts;
  const det = detect(serverDir(serverUuid), serverUuid);
  const isServerContent = isServerType(type);

  // The SAME mod from the OTHER source is a hard stop, not a warning: Modrinth and
  // CurseForge ids never match, so the dedup (which keys on project id) would not
  // fire and mods/ would end up holding two jars of one mod — which Fabric and
  // Forge both refuse to boot with ("duplicate mod").
  if (isServerContent) {
    const proj = await modrinth.getProject(opts.projectId).catch(() => null);
    const dup = proj ? crossSourceDuplicate(serverUuid, proj.title, opts.projectId) : null;
    if (dup) {
      return {
        installed: [], skipped: [], warnings: [], restartRequired: false,
        error: `"${proj!.title}" is already installed from ${dup.source === 'curseforge' ? 'CurseForge' : 'Modrinth'} as ${dup.file}. Installing it again from the other source would put TWO copies of the same mod in the folder and the server would refuse to start ("duplicate mod"). Delete the existing one in the Installed tab first.`,
      };
    }
  }

  if (isServerContent && !opts.force && (await isRunning(serverUuid))) {
    return {
      needsConfirm: true,
      reason: 'Server is running. New files load on next restart; replacing a loaded mod may fail (file locked).',
    };
  }

  const dir = targetDir(serverUuid, type);
  mkdirSync(dir, { recursive: true });

  const result: InstallResult = { installed: [], skipped: [], warnings: [], restartRequired: isServerContent };
  const ledger = loadLedger();
  const entries = (ledger[serverUuid] ??= []);
  const visited = new Set<string>();

  const fetchOne = async (projectId: string, pinnedVersionId?: string | null, isDep = false): Promise<void> => {
    if (visited.has(projectId)) return;
    visited.add(projectId);

    let version: Version | undefined;
    if (pinnedVersionId) {
      try {
        version = await modrinth.getVersion(pinnedVersionId);
      } catch {
        /* fall through to version search */
      }
    }
    if (!version) {
      const filter =
        type === 'mod' || type === 'plugin'
          ? { mc: det.mc ?? undefined, loader: det.loader === 'unknown' ? undefined : det.loader }
          : type === 'datapack'
            ? { mc: det.mc ?? undefined, loader: 'datapack' }
            : {};
      const versions = await modrinth.getVersions(projectId, filter);
      version = versions[0];
    }
    if (!version) {
      result.skipped.push({
        projectId,
        reason: `no build for ${det.mc ?? '?'}/${det.loader}`,
      });
      return;
    }
    visited.add(version.project_id);

    const file = version.files.find((f) => f.primary) ?? version.files[0];
    if (!file) {
      result.skipped.push({ projectId, reason: 'version has no files' });
      return;
    }

    const proj = await modrinth.getProject(version.project_id).catch(() => null);
    // CLIENT-ONLY DETECTION: Modrinth says the server can't use it → it goes to
    // the client shelf, not mods/. Still listed, still exported, never loaded.
    const clientOnly = type === 'mod' && !!proj && proj.server_side === 'unsupported' && proj.client_side !== 'unsupported';
    const destDir = clientOnly ? clientShelfDir(serverUuid) : dir;
    mkdirSync(destDir, { recursive: true });

    // dedup: remove older files of the SAME project (identified via ledger — no
    // fuzzy name matching, so lithium never deletes fabric-api etc.)
    // READ FROM ledger[serverUuid], NOT the captured `entries`: each fetchOne
    // REPLACES ledger[serverUuid] with a filtered copy, so the captured array
    // goes stale after the first mod — rebuilding from it silently DROPPED the
    // parent mod's ledger entry whenever a dependency install followed it
    // (found 2026-07-19: Oculus lost its entry when Embeddium came after).
    for (const old of (ledger[serverUuid] ?? []).filter((e) => e.projectId === version!.project_id && e.file !== file.filename)) {
      const oldPath = join(old.clientOnly ? clientShelfDir(serverUuid) : dir, old.file);
      if (existsSync(oldPath)) {
        try {
          unlinkSync(oldPath);
        } catch {
          result.warnings.push(`old version locked, kept: ${old.file} (delete after restart)`);
        }
      }
    }
    // drop older files of the same project AND any prior entry for this exact
    // file — reinstalling appended forever (13 Faithful rows, live 2026-08-02:
    // the owner kept clicking because the UI showed nothing)
    ledger[serverUuid] = (ledger[serverUuid] ?? []).filter((e) => e.projectId !== version!.project_id && e.file !== file.filename);

    const dest = join(destDir, file.filename);
    if (!existsSync(dest) || statSync(dest).size !== file.size) {
      const res = await fetch(file.url, { headers: { 'user-agent': 'spawnpoint/1.0' } });
      if (!res.ok) {
        result.skipped.push({ projectId, reason: `download failed (${res.status})` });
        return;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const tmp = `${dest}.part`;
      writeFileSync(tmp, buf);
      try {
        renameSync(tmp, dest);
      } catch {
        unlinkSync(tmp);
        result.warnings.push(`${file.filename} is locked by the running server — stop it and retry`);
        return;
      }
      await chownToDirOwner(dirname(dest)); // panel is root, the server is not — see platform.ts
    }

    ledger[serverUuid].push({
      file: file.filename,
      projectId: version.project_id,
      versionId: version.id,
      versionNumber: version.version_number,
      title: proj?.title ?? version.name,
      source: 'modrinth',
      sha1: file.hashes.sha1,
      installedAt: new Date().toISOString(),
      via: isDep ? 'dependency' : 'direct',
      categories: proj?.categories,
      ...(clientOnly ? { clientOnly: true } : {}),
    });
    result.installed.push({
      file: file.filename,
      title: proj?.title ?? version.name,
      version: version.version_number,
      ...(clientOnly ? { clientOnly: true } : {}),
    });

    // recurse into REQUIRED dependencies (mods/plugins — packs have none)
    if (type === 'mod' || type === 'plugin') {
      for (const dep of version.dependencies.filter((d) => d.dependency_type === 'required' && d.project_id)) {
        await fetchOne(dep.project_id!, dep.version_id, true);
      }
    }
  };

  await fetchOne(opts.projectId, opts.versionId);
  saveLedger(ledger);
  return result;
}

export type ModGroup = 'performance' | 'support' | 'gameplay';

/** CurseForge install: same ledger/dedup/dep-recursion contract as install().
    Handles mods, datapacks, and client-side packs/shaders (-> downloads
    collection). Modpacks go through installCurseforgeModpack instead. */
export async function installCurseforge(
  serverUuid: string,
  opts: { modId: string; fileId?: string; type?: ContentType; force?: boolean },
): Promise<InstallResult | { needsConfirm: true; reason: string }> {
  installsInFlight++;
  try {
    return await installCurseforgeInner(serverUuid, opts);
  } finally {
    installsInFlight--;
    lastInstallDone = Date.now();
  }
}

async function installCurseforgeInner(
  serverUuid: string,
  opts: { modId: string; fileId?: string; type?: ContentType; force?: boolean },
): Promise<InstallResult | { needsConfirm: true; reason: string }> {
  const type: ContentType = opts.type ?? 'mod';
  const det = detect(serverDir(serverUuid), serverUuid);
  const isServerContent = isServerType(type);
  if (isServerContent && !opts.force && (await isRunning(serverUuid))) {
    return {
      needsConfirm: true,
      reason: 'Server is running. New files load on next restart; replacing a loaded mod may fail (file locked).',
    };
  }
  const dir = targetDir(serverUuid, type);
  mkdirSync(dir, { recursive: true });

  const result: InstallResult = { installed: [], skipped: [], warnings: [], restartRequired: isServerContent };
  const ledger = loadLedger();
  const entries = (ledger[serverUuid] ??= []);
  const visited = new Set<string>();

  const fetchOne = async (modId: string, pinnedFileId?: string, isDep = false): Promise<void> => {
    if (visited.has(modId)) return;
    visited.add(modId);

    const mod = await curseforge.getMod(modId).catch(() => null);
    if (!mod) {
      result.skipped.push({ projectId: modId, reason: 'project not found on CurseForge' });
      return;
    }
    const files = await curseforge.getFiles(modId, {
      mc: det.mc ?? undefined,
      // loader only constrains mods — packs/shaders/datapacks are loader-free
      loader: type === 'mod' && det.loader !== 'unknown' ? det.loader : undefined,
    });
    const file = pinnedFileId ? files.find((f) => String(f.id) === pinnedFileId) ?? files[0] : files[0];
    if (!file) {
      result.skipped.push({ projectId: mod.name, reason: `no build for ${det.mc ?? '?'}/${det.loader}` });
      return;
    }
    // CurseForge's API has no usable client/server-side flag, so a CF install
    // of a CLIENT-ONLY mod (EMF/ETF, live 2026-07-21) used to land in the
    // server's mods/ and die in the dry-boot ("invalid dist DEDICATED_SERVER")
    // — while the Modrinth path shelved the same mod correctly. Borrow the
    // sides from Modrinth by slug, exactly like the CF search already does.
    let clientOnly = false;
    if (type === 'mod' && mod.slug) {
      try {
        const { getProjects } = await import('../clients/modrinth.js');
        const [cross] = await getProjects([mod.slug]);
        clientOnly = !!cross && cross.server_side === 'unsupported' && cross.client_side !== 'unsupported';
      } catch { /* CF-exclusive mod — no cross-listing, treat as server-side */ }
    }
    const destDir = clientOnly ? clientShelfDir(serverUuid) : dir;
    if (clientOnly) mkdirSync(destDir, { recursive: true });
    if (!file.downloadUrl) {
      // CONFIRMED opt-out: CurseForge itself returns a null downloadUrl, which
      // only happens when the author ticked "no third-party downloads". It is
      // not a transient failure and no retry will help.
      (result.manualDownloads ??= []).push({
        title: mod.name,
        url: mod.links?.websiteUrl ?? `https://www.curseforge.com/minecraft/mc-mods/${modId}`,
      });
      result.warnings.push(`${mod.name}: the author blocked API downloads — download the jar yourself`);
      return;
    }

    // dedup older files of the same CF project via ledger identity
    for (const old of entries.filter(
      (e) => e.source === 'curseforge' && e.projectId === String(mod.id) && e.file !== file.fileName,
    )) {
      const oldPath = join(old.clientOnly ? clientShelfDir(serverUuid) : dir, old.file);
      if (existsSync(oldPath)) {
        try {
          unlinkSync(oldPath);
        } catch {
          result.warnings.push(`old version locked, kept: ${old.file} (delete after restart)`);
        }
      }
    }
    ledger[serverUuid] = ledger[serverUuid].filter(
      (e) => e.source !== 'curseforge' || e.projectId !== String(mod.id) || e.file === file.fileName,
    );

    const dest = join(destDir, file.fileName);
    if (!existsSync(dest)) {
      const res = await fetch(file.downloadUrl, { headers: { 'user-agent': 'spawnpoint/1.0' } });
      if (!res.ok) {
        result.skipped.push({ projectId: mod.name, reason: `download failed (${res.status})` });
        return;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const tmp = `${dest}.part`;
      writeFileSync(tmp, buf);
      try {
        renameSync(tmp, dest);
      } catch {
        unlinkSync(tmp);
        result.warnings.push(`${file.fileName} is locked by the running server — stop it and retry`);
        return;
      }
      await chownToDirOwner(dirname(dest)); // panel is root, the server is not — see platform.ts
    }

    if (!ledger[serverUuid].some((e) => e.file === file.fileName)) {
      ledger[serverUuid].push({
        file: file.fileName,
        projectId: String(mod.id),
        versionId: String(file.id),
        versionNumber: file.displayName,
        title: mod.name,
        source: 'curseforge',
        sha1: file.hashes.find((h) => h.algo === 1)?.value ?? '',
        installedAt: new Date().toISOString(),
        via: isDep ? 'dependency' : 'direct',
        categories: curseforge.mapCategories(mod.categories),
        ...(clientOnly ? { clientOnly: true } : {}),
      });
      result.installed.push({ file: file.fileName, title: mod.name, version: file.displayName, ...(clientOnly ? { clientOnly: true } : {}) });
    }

    if (type === 'mod') {
      for (const dep of file.dependencies.filter((d) => d.relationType === 3)) {
        await fetchOne(String(dep.modId), undefined, true);
      }
    }
  };

  await fetchOne(opts.modId, opts.fileId);
  saveLedger(ledger);
  return result;
}

interface PerfManifest {
  mods: { slug: string; match: string; optional?: boolean; note?: string }[];
}

/** Install the curated performance pack (Shared\perf-mods.json).
    Mods with no build for this server's version/loader are skipped with a
    warning — that's expected, not an error. */
export async function installPerfPack(
  serverUuid: string,
  opts: { includeOptional?: boolean; force?: boolean } = {},
): Promise<InstallResult | { needsConfirm: true; reason: string }> {
  if (!opts.force && (await isRunning(serverUuid))) {
    return {
      needsConfirm: true,
      reason: 'Server is running. The pack installs fine but loads on next restart; replacing a loaded mod may fail.',
    };
  }
  const manifest = JSON.parse(
    readFileSync(PATHS.perfManifest, 'utf8').replace(/^﻿/, ''),
  ) as PerfManifest;

  const combined: InstallResult = { installed: [], skipped: [], warnings: [], restartRequired: true };
  for (const m of manifest.mods) {
    if (m.optional && !opts.includeOptional) continue;
    try {
      const r = await install(serverUuid, { projectId: m.slug, type: 'mod', force: true });
      if ('needsConfirm' in r) continue; // force:true makes this unreachable
      combined.installed.push(...r.installed);
      combined.skipped.push(...r.skipped);
      combined.warnings.push(...r.warnings);
    } catch (e) {
      combined.warnings.push(`${m.slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return combined;
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

// perf-pack membership by filename pattern (from Shared\perf-mods.json)
function perfPatterns(): string[] {
  try {
    const m = JSON.parse(readFileSync(PATHS.perfManifest, 'utf8')) as { mods: { match: string }[] };
    return m.mods.map((x) => x.match.toLowerCase());
  } catch {
    return [];
  }
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
  perf: string[],
  categories?: string[],
): ModGroup {
  const f = file.toLowerCase();
  if (perf.some((p) => f.includes(p))) return 'performance';
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
  const ledger = loadLedger()[serverUuid] ?? [];
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
    const l = loadLedger();
    const existing = new Set((l[serverUuid] ?? []).map((e) => e.file));
    const fresh = [...byFile.values()].filter((e) => e.installedAt === '' && !existing.has(e.file));
    if (fresh.length > 0) {
      l[serverUuid] = [...(l[serverUuid] ?? []), ...fresh];
      saveLedger(l);
    }
  }

  const perf = perfPatterns();
  // client-shelf items ride along: never in mods/, always in the export
  const shelf = clientShelfDir(serverUuid);
  const shelfItems: InstalledItem[] = existsSync(shelf)
    ? readdirSync(shelf)
        .filter((f) => f.endsWith('.jar'))
        .map((f) => {
          const entry = byFile.get(f) ?? (loadLedger()[serverUuid] ?? []).find((e) => e.file === f);
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
  // mods/ — they were invisible to this inventory, so installs looked like
  // no-ops and the owner reinstalled Faithful 64x thirteen times looking for
  // proof (live 2026-08-02). Surface them; deleteInstalled knows their paths.
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
      group: classify(clean, via, perf, entry?.categories),
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
  const entries = loadLedger()[serverUuid] ?? [];
  const updates: UpdateInfo[] = [];
  for (const e of entries) {
    try {
      if (e.source === 'curseforge') {
        const files = await curseforge.getFiles(e.projectId, {
          mc: det.mc ?? undefined,
          loader: det.loader === 'unknown' ? undefined : det.loader,
        });
        const latest = files[0];
        if (latest && String(latest.id) !== e.versionId) {
          const changelog = await curseforge
            .getChangelog(e.projectId, latest.id)
            .then((c) => c.slice(0, 1500))
            .catch(() => undefined);
          updates.push({
            file: e.file,
            title: e.title,
            from: e.versionNumber,
            to: latest.displayName,
            projectId: e.projectId,
            versionId: String(latest.id),
            source: 'curseforge',
            changelog,
          });
        }
        continue;
      }
      const versions = await modrinth.getVersions(e.projectId, {
        mc: det.mc ?? undefined,
        loader: det.loader === 'unknown' ? undefined : det.loader,
      });
      const latest = versions[0];
      if (latest && latest.id !== e.versionId) {
        updates.push({
          file: e.file,
          title: e.title,
          from: e.versionNumber,
          to: latest.version_number,
          projectId: e.projectId,
          versionId: latest.id,
          source: 'modrinth',
          changelog: latest.changelog?.slice(0, 1500) ?? undefined,
        });
      }
    } catch {
      /* project gone or offline — skip */
    }
  }
  return updates;
}

/** Install every available update (reuses the dedup/ledger logic). */
export async function updateAll(
  serverUuid: string,
): Promise<{ updated: string[]; warnings: string[]; serverJars: string[] }> {
  const updates = await checkUpdates(serverUuid);
  const updated: string[] = [];
  const warnings: string[] = [];
  const serverJars: string[] = [];
  for (const u of updates) {
    const res =
      u.source === 'curseforge'
        ? await installCurseforge(serverUuid, { modId: u.projectId, fileId: u.versionId, force: true })
        : await install(serverUuid, { projectId: u.projectId, versionId: u.versionId, type: 'mod', force: true });
    if ('installed' in res && res.installed.length) {
      updated.push(`${u.title} ${u.from} -> ${u.to}`);
      warnings.push(...res.warnings);
      serverJars.push(...res.installed.filter((x) => !x.clientOnly).map((x) => x.file));
    }
  }
  return { updated, warnings, serverJars };
}

/** Windows will not let you rename or delete a file the running JVM has open, so
 *  every enable/disable/delete fails with EBUSY while the server is up. The raw
 *  error escaped as a 500 and the UI (whose toggle had no error handler) just
 *  did nothing at all — the click looked broken. Say what actually happened. */
const LOCKED = (clean: string) =>
  new Error(
    `"${clean}" is open by the running server — Windows will not let it be renamed or deleted while the server is up. Stop the server, then try again.`,
  );

export function toggleInstalled(
  serverUuid: string,
  file: string,
): { enabled: boolean; pending?: PendingAction } {
  const dir = jarDir(serverUuid);
  const clean = basename(file); // no path traversal
  if (existsSync(join(clientShelfDir(serverUuid), clean))) {
    throw new Error(`${clean} is a client-only mod — it is never loaded by the server, so there is nothing to toggle. Delete it to drop it from the pack.`);
  }
  const jar = join(dir, clean);
  const disabled = `${jar}.disabled`;
  const isOn = existsSync(jar);
  if (!isOn && !existsSync(disabled)) throw new Error(`${clean} not found`);

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

export function deleteInstalled(serverUuid: string, file: string): { pending?: PendingAction } {
  const dir = jarDir(serverUuid);
  const clean = basename(file);
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
        if (!/EBUSY|EPERM|EACCES/i.test(String((e as NodeJS.ErrnoException).code ?? e))) throw LOCKED(clean);
        // locked by the running server — queue it instead of refusing (see pendingmods.ts)
        queueChange(serverUuid, clean, 'delete');
        return { pending: 'delete' };
      }
    }
  }
  const ledger = loadLedger();
  if (ledger[serverUuid]) {
    ledger[serverUuid] = ledger[serverUuid].filter((e) => e.file !== clean);
    saveLedger(ledger);
  }
  return {};
}
