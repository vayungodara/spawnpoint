import AdmZip from 'adm-zip';
import { createWriteStream, existsSync, mkdirSync, writeFileSync, renameSync, rmSync, cpSync, statSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { serverDir } from './servers.js';
import { detect } from './detect.js';
import * as modrinth from '../clients/modrinth.js';
import * as curseforge from '../clients/curseforge.js';
import { chownToDirOwner } from './platform.js';
import { assertUnsealed, hashes } from './revisions.js';

/** Is `target` really inside `root`? A bare startsWith() accepts a SIBLING
    directory that merely shares the prefix (…/<uuid> vs …/<uuid>-evil) —
    require a path-separator boundary. */
function isInside(root: string, target: string): boolean {
  const r = resolve(root);
  const t = resolve(target);
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** Extract only the entries under `folder`, each one path-checked. AdmZip's
    extractAllTo() writes EVERY entry first — a crafted pack with `../` names
    (Zip Slip) could drop files outside the extract root. */
function extractSubtree(zip: AdmZip, folder: string, extractRoot: string): boolean {
  let any = false;
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const name = e.entryName.replace(/\\/g, '/');
    if (!name.startsWith(`${folder}/`)) continue;
    const dest = resolve(extractRoot, name);
    if (!isInside(extractRoot, dest)) continue; // Zip Slip attempt — drop it
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, e.getData());
    any = true;
  }
  return any;
}

/** A retry may reuse exact bytes, never a same-named partial or stale file. */
async function installPackFile(dest: string, url: string, size: number, expected: { sha1?: string; sha512?: string }): Promise<void> {
  if ((!expected?.sha1 && !expected?.sha512) || !Number.isSafeInteger(size) || size < 0) throw new Error(`missing checksum or size for ${dest}`);
  const part = `${dest}.part`;
  let path = dest;
  try {
    if (!existsSync(dest)) {
      const dl = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { 'user-agent': 'spawnpoint/1.0' } });
      if (!dl.ok || !dl.body) throw new Error(`download failed: ${dest} (${dl.status})`);
      mkdirSync(dirname(dest), { recursive: true });
      let seen = 0;
      const capped = new Transform({ transform(chunk, _encoding, callback) {
        seen += chunk.length;
        callback(seen > size ? new Error(`download exceeds declared size: ${dest}`) : null, chunk);
      } });
      await pipeline(Readable.fromWeb(dl.body as import('node:stream/web').ReadableStream), capped, createWriteStream(part));
      path = part;
    }
    const actual = await hashes(path);
    if (actual.size !== size || (expected.sha1 && actual.sha1 !== expected.sha1.toLowerCase())
      || (expected.sha512 && actual.sha512 !== expected.sha512.toLowerCase())) throw new Error(`checksum or size mismatch: ${dest}`);
    if (path === part) renameSync(part, dest);
  } finally { rmSync(part, { force: true }); }
}

// Installs a Modrinth modpack (.mrpack) into a newly created server (servercreate.ts):
//  - downloads every server-side file from the pack index into the server dir
//  - applies overrides/ and server-overrides/ (configs, datapacks, etc.)
// It does NOT change the server's loader — mismatches are rejected up front.

interface MrpackIndex {
  formatVersion: number;
  name: string;
  dependencies: Record<string, string>; // minecraft, fabric-loader, forge, neoforge...
  files: {
    path: string;
    downloads: string[];
    fileSize: number;
    hashes: { sha1?: string; sha512?: string };
    env?: { client: string; server: string };
  }[];
}

export interface ModpackResult {
  name: string;
  installed: number;
  skippedClientOnly: number;
  overridesApplied: boolean;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Local pack files. A dropped .mrpack / CurseForge client zip is a first-class
// install source: same installers as the search flow, minus the download step.
// ---------------------------------------------------------------------------

const LOADER_MAP: Record<string, string> = { 'fabric-loader': 'fabric', forge: 'forge', neoforge: 'neoforge', 'quilt-loader': 'quilt' };

export interface PackFileInfo {
  kind: 'mrpack' | 'curseforge';
  name: string;
  mc: string | null;
  loader: string | null;
  fileCount: number;
}

/** What is this zip? Cheap peek at the two index formats; null = not a pack.
    AdmZip buffers the whole file, so refuse anything implausibly large (a
    world backup zip is not a modpack, and this box's RAM belongs to the MC
    servers). */
export function inspectPackFile(path: string): PackFileInfo | null {
  try {
    if (statSync(path).size > 512 * 1024 * 1024) return null;
    const zip = new AdmZip(path);
    const mi = zip.getEntry('modrinth.index.json');
    if (mi) {
      const index = JSON.parse(mi.getData().toString('utf8')) as MrpackIndex;
      const packLoaders = Object.keys(index.dependencies ?? {}).filter((k) => k !== 'minecraft');
      return {
        kind: 'mrpack',
        name: index.name || 'modpack',
        mc: index.dependencies?.minecraft ?? null,
        loader: LOADER_MAP[packLoaders[0]] ?? packLoaders[0] ?? null,
        fileCount: index.files?.length ?? 0,
      };
    }
    const mf = zip.getEntry('manifest.json');
    if (mf) {
      const manifest = JSON.parse(mf.getData().toString('utf8')) as CfManifest;
      if (!manifest.minecraft?.modLoaders) return null; // some other manifest.json
      return {
        kind: 'curseforge',
        name: manifest.name || 'modpack',
        mc: manifest.minecraft.version ?? null,
        loader: manifest.minecraft.modLoaders[0]?.id.split('-')[0] ?? null,
        fileCount: manifest.files?.length ?? 0,
      };
    }
  } catch { /* unreadable / not a zip */ }
  return null;
}

export async function installModpack(
  serverUuid: string,
  opts: { projectId: string; versionId?: string },
): Promise<ModpackResult | { error: string }> {
  const dir = serverDir(serverUuid);
  const det = detect(dir, serverUuid);

  // resolve the pack version (match server loader+mc when possible)
  let version;
  if (opts.versionId) {
    version = await modrinth.getVersion(opts.versionId);
  } else {
    const all = await modrinth.getVersions(opts.projectId, {
      mc: det.mc ?? undefined,
      loader: det.loader === 'unknown' ? undefined : det.loader,
    });
    version = modrinth.bestVersion(all);
  }
  if (!version) {
    return { error: `No modpack version for ${det.mc}/${det.loader}. Try "all versions" and pick a version matching your server.` };
  }

  const file = version.files.find((f) => f.primary) ?? version.files[0];
  if (!file) return { error: 'pack version has no file' };

  // Verify the exact carrier too: its overrides are part of the chosen pack.
  const tmp = join(tmpdir(), `spawnpoint-${Date.now()}.mrpack`);
  try {
    await installPackFile(tmp, file.url, file.size, file.hashes);
    return await installMrpackFile(serverUuid, tmp);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Install a LOCAL .mrpack (dropped into the panel, or just downloaded) into
    a newly created server. All the safety of the search flow — loader mismatch
    rejected, Zip Slip screened, client-only files skipped. */
export async function installMrpackFile(
  serverUuid: string,
  packPath: string,
): Promise<ModpackResult | { error: string }> {
  assertUnsealed(serverUuid);
  const dir = serverDir(serverUuid);
  const det = detect(dir, serverUuid);

  const warnings: string[] = [];
  {
    const zip = new AdmZip(packPath);
    const indexEntry = zip.getEntry('modrinth.index.json');
    if (!indexEntry) return { error: 'invalid modpack (no modrinth.index.json)' };
    const index = JSON.parse(indexEntry.getData().toString('utf8')) as MrpackIndex;

    // loader sanity check
    const packLoaders = Object.keys(index.dependencies).filter((k) => k !== 'minecraft');
    const loaderMap: Record<string, string> = { 'fabric-loader': 'fabric', forge: 'forge', neoforge: 'neoforge', 'quilt-loader': 'quilt' };
    const packLoader = loaderMap[packLoaders[0]] ?? packLoaders[0];
    if (det.loader !== 'unknown' && packLoader && packLoader !== det.loader) {
      return { error: `This pack is for ${packLoader} ${index.dependencies.minecraft}, but the server is ${det.loader} ${det.mc}. Create a ${packLoader} server first.` };
    }
    if (det.mc && index.dependencies.minecraft && det.mc !== index.dependencies.minecraft) {
      warnings.push(`pack targets MC ${index.dependencies.minecraft}, server is ${det.mc} — mods may not load`);
    }

    // download server-side files
    let installed = 0;
    let skippedClientOnly = 0;
    for (const f of index.files) {
      if (f.env?.server === 'unsupported') {
        skippedClientOnly++;
        continue;
      }
      // path confinement: no absolute paths or ..
      const dest = resolve(dir, f.path);
      if (!isInside(dir, dest)) return { error: `suspicious required path: ${f.path}` };
      try { await installPackFile(dest, f.downloads[0], f.fileSize, f.hashes); }
      catch (error) { return { error: String(error) }; }
      installed++;
    }

    // apply overrides then server-overrides (server wins)
    let overridesApplied = false;
    for (const folder of ['overrides', 'server-overrides']) {
      const extractRoot = join(tmpdir(), `spawnpoint-ovr-${Date.now()}`);
      if (!extractSubtree(zip, folder, extractRoot)) continue;
      cpSync(join(extractRoot, folder), dir, { recursive: true, force: true });
      rmSync(extractRoot, { recursive: true, force: true });
      overridesApplied = true;
    }

    if (overridesApplied) {
      try {
        for (const f of index.files.filter((f) => f.env?.server !== 'unsupported')) await installPackFile(resolve(dir, f.path), f.downloads[0], f.fileSize, f.hashes);
      } catch (error) { return { error: String(error) }; }
    }
    await chownToDirOwner(dir); // panel is root, the server is not — see platform.ts
    return { name: index.name, installed, skippedClientOnly, overridesApplied, warnings };
  }
}

// CurseForge modpack (client zip: manifest.json + overrides/) into a
// newly created server. Same contract as the .mrpack flow. One CF limitation:
// manifests don't tag client-only mods, so everything installs and the user
// may need to disable a client-only mod if the server crashes on boot.
interface CfManifest {
  minecraft: { version: string; modLoaders: { id: string; primary?: boolean }[] };
  name: string;
  files: { projectID: number; fileID: number; required: boolean }[];
  overrides?: string;
}

export async function installCurseforgeModpack(
  serverUuid: string,
  opts: { modId: string; fileId?: string },
): Promise<ModpackResult | { error: string }> {
  const dir = serverDir(serverUuid);
  const det = detect(dir, serverUuid);

  let files = await curseforge.getFiles(opts.modId, {
    mc: det.mc ?? undefined,
    loader: det.loader === 'unknown' ? undefined : det.loader,
  });
  if (opts.fileId && !files.some((f) => String(f.id) === opts.fileId)) {
    files = await curseforge.getFiles(opts.modId); // pinned file outside the filter
  }
  const file = opts.fileId ? files.find((f) => String(f.id) === opts.fileId) : curseforge.bestFile(files);
  if (!file) {
    return { error: `No pack version for ${det.mc ?? '?'}/${det.loader}. Pick a version matching your server on CurseForge.` };
  }
  if (!file.downloadUrl) {
    return { error: 'The pack author disabled API downloads — download it from curseforge.com and install manually.' };
  }

  const tmp = join(tmpdir(), `spawnpoint-${Date.now()}.zip`);
  try {
    await installPackFile(tmp, file.downloadUrl, file.fileLength, { sha1: file.hashes.find((h) => h.algo === 1)?.value });
    return await installCurseforgeZipFile(serverUuid, tmp);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Install a LOCAL CurseForge client zip (manifest.json + overrides/) into an
    existing server. Mod downloads still come from the CF API — the zip only
    carries references. Missing required files keep creation fenced, including
    files whose authors disabled API downloads. */
export async function installCurseforgeZipFile(
  serverUuid: string,
  zipPath: string,
): Promise<ModpackResult | { error: string }> {
  assertUnsealed(serverUuid);
  const dir = serverDir(serverUuid);
  const det = detect(dir, serverUuid);

  const warnings: string[] = [];
  {
    const zip = new AdmZip(zipPath);
    const manifestEntry = zip.getEntry('manifest.json');
    if (!manifestEntry) return { error: 'invalid CurseForge pack (no manifest.json)' };
    const manifest = JSON.parse(manifestEntry.getData().toString('utf8')) as CfManifest;

    // loader sanity check ("fabric-0.16.9" / "forge-47.2.0" / "neoforge-…")
    const packLoader = manifest.minecraft.modLoaders[0]?.id.split('-')[0] ?? '';
    if (det.loader !== 'unknown' && packLoader && packLoader !== det.loader) {
      return { error: `This pack is for ${packLoader} ${manifest.minecraft.version}, but the server is ${det.loader} ${det.mc}. Create a ${packLoader} server first.` };
    }
    if (det.mc && manifest.minecraft.version && det.mc !== manifest.minecraft.version) {
      warnings.push(`pack targets MC ${manifest.minecraft.version}, server is ${det.mc} — mods may not load`);
    }

    // resolve every referenced file in bulk, then download into mods/
    const metas = await curseforge.getFilesBulk(manifest.files.map((f) => f.fileID));
    const byId = new Map(metas.map((m) => [m.id, m]));
    const modsDir = join(dir, 'mods');
    mkdirSync(modsDir, { recursive: true });
    let installed = 0;
    for (const ref of manifest.files) {
      const meta = byId.get(ref.fileID);
      if (!meta || !meta.downloadUrl) {
        const error = !meta ? `file ${ref.fileID} not found on CurseForge`
          : `${meta.fileName}: author disabled API downloads — install manually from curseforge.com`;
        if (ref.required !== false) return { error };
        warnings.push(error);
        continue;
      }
      if (meta.modId !== ref.projectID) return { error: `CurseForge file ${ref.fileID} belongs to another project` };
      const dest = resolve(modsDir, meta.fileName);
      if (!isInside(modsDir, dest)) return { error: `suspicious filename: ${meta.fileName}` };
      try { await installPackFile(dest, meta.downloadUrl, meta.fileLength, { sha1: meta.hashes.find((h) => h.algo === 1)?.value }); }
      catch (error) {
        if (ref.required !== false) return { error: String(error) };
        warnings.push(String(error));
        continue;
      }
      installed++;
    }

    // apply the overrides folder (configs, datapacks, kubejs scripts, …)
    let overridesApplied = false;
    const folder = manifest.overrides ?? 'overrides';
    {
      const extractRoot = join(tmpdir(), `spawnpoint-ovr-${Date.now()}`);
      if (extractSubtree(zip, folder, extractRoot)) {
        cpSync(join(extractRoot, folder), dir, { recursive: true, force: true });
        rmSync(extractRoot, { recursive: true, force: true });
        overridesApplied = true;
      }
    }

    if (overridesApplied) {
      try {
        for (const ref of manifest.files.filter((f) => f.required !== false)) {
          const meta = byId.get(ref.fileID)!;
          await installPackFile(resolve(modsDir, meta.fileName), meta.downloadUrl!, meta.fileLength, { sha1: meta.hashes.find((h) => h.algo === 1)?.value });
        }
      } catch (error) { return { error: String(error) }; }
    }
    warnings.push(
      "CF packs don't tag client-only mods — if the server crashes on boot, disable the client-only ones in Content → Installed",
    );
    await chownToDirOwner(dir); // panel is root, the server is not — see platform.ts
    return { name: manifest.name, installed, skippedClientOnly: 0, overridesApplied, warnings };
  }
}
