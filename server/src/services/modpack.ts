import AdmZip from 'adm-zip';
import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync, cpSync, statSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { serverDir } from './servers.js';

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
import { detect } from './detect.js';
import * as modrinth from '../clients/modrinth.js';
import * as curseforge from '../clients/curseforge.js';
import { chownToDirOwner } from './platform.js';

// Installs a Modrinth modpack (.mrpack) into an EXISTING server:
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
    version = all[0];
  }
  if (!version) {
    return { error: `No modpack version for ${det.mc}/${det.loader}. Try "all versions" and pick a version matching your server.` };
  }

  const file = version.files.find((f) => f.primary) ?? version.files[0];
  if (!file) return { error: 'pack version has no file' };

  // download the .mrpack
  const res = await fetch(file.url, { headers: { 'user-agent': 'spawnpoint/1.0' } });
  if (!res.ok) return { error: `download failed (${res.status})` };
  const tmp = join(tmpdir(), `spawnpoint-${Date.now()}.mrpack`);
  writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  try {
    return await installMrpackFile(serverUuid, tmp);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Install a LOCAL .mrpack (dropped into the panel, or just downloaded) into
    an existing server. All the safety of the search flow — loader mismatch
    rejected, Zip Slip screened, client-only files skipped. */
export async function installMrpackFile(
  serverUuid: string,
  packPath: string,
): Promise<ModpackResult | { error: string }> {
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
      if (!isInside(dir, dest)) {
        warnings.push(`skipped suspicious path: ${f.path}`);
        continue;
      }
      mkdirSync(dirname(dest), { recursive: true });
      if (existsSync(dest)) {
        installed++;
        continue;
      }
      const dl = await fetch(f.downloads[0], { headers: { 'user-agent': 'spawnpoint/1.0' } });
      if (!dl.ok) {
        warnings.push(`failed: ${f.path} (${dl.status})`);
        continue;
      }
      const part = `${dest}.part`;
      writeFileSync(part, Buffer.from(await dl.arrayBuffer()));
      renameSync(part, dest);
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

    await chownToDirOwner(dir); // panel is root, the server is not — see platform.ts
    return { name: index.name, installed, skippedClientOnly, overridesApplied, warnings };
  }
}

// CurseForge modpack (client zip: manifest.json + overrides/) into an
// EXISTING server. Same contract as the .mrpack flow. One CF limitation:
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
  const file = opts.fileId ? files.find((f) => String(f.id) === opts.fileId) : files[0];
  if (!file) {
    return { error: `No pack version for ${det.mc ?? '?'}/${det.loader}. Pick a version matching your server on CurseForge.` };
  }
  if (!file.downloadUrl) {
    return { error: 'The pack author disabled API downloads — download it from curseforge.com and install manually.' };
  }

  const res = await fetch(file.downloadUrl, { headers: { 'user-agent': 'spawnpoint/1.0' } });
  if (!res.ok) return { error: `download failed (${res.status})` };
  const tmp = join(tmpdir(), `spawnpoint-${Date.now()}.zip`);
  writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  try {
    return await installCurseforgeZipFile(serverUuid, tmp);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Install a LOCAL CurseForge client zip (manifest.json + overrides/) into an
    existing server. Mod downloads still come from the CF API — the zip only
    carries references, so packs whose authors disabled API downloads will
    surface per-file warnings just like the search flow. */
export async function installCurseforgeZipFile(
  serverUuid: string,
  zipPath: string,
): Promise<ModpackResult | { error: string }> {
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
      if (!meta) {
        warnings.push(`file ${ref.fileID} not found on CurseForge`);
        continue;
      }
      if (!meta.downloadUrl) {
        warnings.push(`${meta.fileName}: author disabled API downloads — install manually from curseforge.com`);
        continue;
      }
      const dest = resolve(modsDir, meta.fileName);
      if (!isInside(modsDir, dest)) {
        warnings.push(`skipped suspicious filename: ${meta.fileName}`);
        continue;
      }
      if (existsSync(dest)) {
        installed++;
        continue;
      }
      const dl = await fetch(meta.downloadUrl, { headers: { 'user-agent': 'spawnpoint/1.0' } });
      if (!dl.ok) {
        warnings.push(`failed: ${meta.fileName} (${dl.status})`);
        continue;
      }
      const part = `${dest}.part`;
      writeFileSync(part, Buffer.from(await dl.arrayBuffer()));
      renameSync(part, dest);
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

    warnings.push(
      "CF packs don't tag client-only mods — if the server crashes on boot, disable the client-only ones in Content → Installed",
    );
    await chownToDirOwner(dir); // panel is root, the server is not — see platform.ts
    return { name: manifest.name, installed, skippedClientOnly: 0, overridesApplied, warnings };
  }
}
