import { existsSync, readdirSync, copyFileSync, unlinkSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { serverDir, clientShelfDir } from './servers.js';
import { detect, loaderVersion } from './detect.js';
import { chownToDirOwner, writeFileAtomic } from './platform.js';
import { rconCommand } from '../clients/rcon.js';
import * as modrinth from '../clients/modrinth.js';

// AutoModpack syncs a server's mods to every client that joins. It reads two
// folders: the server's mods/ and automodpack/host-modpack/main/ (client-only
// extras). Client-only mods the panel installs live on the client shelf
// (data/clientmods/<id>/), so publishPack() mirrors the shelf into the extras
// folder and asks AutoModpack to regenerate. Only jars the bridge copied are
// ever removed from extras; hand-placed files are never recorded or touched.

const BRIDGED_RECORD = '.spawnpoint-bridged.json';

function amDir(serverId: string): string {
  return join(serverDir(serverId), 'automodpack');
}

/** The extras folder AutoModpack ships to clients next to the server's mods. */
export function extrasDir(serverId: string): string {
  return join(amDir(serverId), 'host-modpack', 'main');
}

/** True when this server runs AutoModpack (its config dir exists). */
export function autoModpackActive(serverId: string): boolean {
  return existsSync(amDir(serverId));
}

/** New servers get AutoModpack and a ready config, so friends install one
    jar once and never manage pack files. Failures become warnings on the
    create job; they never fail the create. */
export async function provisionAutoModpack(serverId: string, loader: string): Promise<string[]> {
  const warnings: string[] = [];
  try {
    const { install } = await import('./installer.js');
    const r = await install(serverId, { projectId: 'automodpack', type: 'mod', direct: true });
    if (!('installed' in r) || !r.installed.length) {
      warnings.push('AutoModpack has no build for this MC/loader yet, so clients need a manual pack for now');
    }
    mkdirSync(join(extrasDir(serverId), 'mods'), { recursive: true });
    const cfgPath = join(amDir(serverId), 'automodpack-server.json');
    if (!existsSync(cfgPath)) {
      // AutoModpack fills every missing key with its defaults on first boot.
      // New servers have no legacy clients, so clients must sync from day one.
      writeFileSync(cfgPath, JSON.stringify({
        DO_NOT_CHANGE_IT: 2,
        modpackName: '',
        modpackHost: true,
        generateModpackOnStart: true,
        requireAutoModpackOnClient: true,
        acceptedLoaders: [loader === 'quilt' ? 'fabric' : loader],
        // synced resource and shader packs must land in the client's real
        // folders, or the vanilla Resource Packs screen never lists them
        forceCopyFilesToStandardLocation: ['/resourcepacks/**', '/shaderpacks/**'],
      }, null, 2), 'utf8');
    }
    await chownToDirOwner(amDir(serverId));
  } catch (e) {
    warnings.push(`AutoModpack setup skipped: ${String(e).slice(0, 100)}`);
  }
  return warnings;
}

/** Mirror the client shelf into the extras folder and regenerate the pack,
    so the next join ships the current set. Call only after a change passed
    its tests. Never throws. */
export async function publishPack(serverId: string, log?: (m: string) => void): Promise<void> {
  try {
    if (!autoModpackActive(serverId)) return;
    const extras = join(extrasDir(serverId), 'mods');
    mkdirSync(extras, { recursive: true });
    const recordPath = join(amDir(serverId), BRIDGED_RECORD);
    let previous: string[] = [];
    try { previous = JSON.parse(readFileSync(recordPath, 'utf8')) as string[]; } catch { /* first run */ }

    const shelf = clientShelfDir(serverId);
    const shelfJars = existsSync(shelf) ? readdirSync(shelf).filter((f) => f.endsWith('.jar')) : [];
    let changed = 0;
    for (const jar of shelfJars) {
      const src = join(shelf, jar);
      const dst = join(extras, jar);
      // compare bytes, not sizes: an undo can bring back a same-size jar
      const bytes = readFileSync(src);
      if (!existsSync(dst) || !readFileSync(dst).equals(bytes)) {
        writeFileAtomic(dst, bytes);
        changed++;
      }
    }
    for (const jar of previous) {
      if (!shelfJars.includes(jar) && existsSync(join(extras, jar))) {
        unlinkSync(join(extras, jar));
        changed++;
      }
    }
    writeFileSync(recordPath, JSON.stringify(shelfJars, null, 2), 'utf8');
    if (changed) await chownToDirOwner(extras);
    // an offline server regenerates at its next boot (generateModpackOnStart)
    await rconCommand(serverId, 'automodpack generate', { timeout: 15_000 })
      .then(() => log?.(`automodpack: regenerated ${serverId}'s pack`))
      .catch(() => log?.(`automodpack: ${serverId} is offline, so its pack regenerates on next boot`));
  } catch (e) {
    log?.(`automodpack: publish failed for ${serverId}: ${String(e).slice(0, 120)}`);
  }
}

/** Resource and shader packs install into the panel's downloads folder; on an
    AutoModpack server they also belong in the synced extras. */
export async function stageClientAsset(serverId: string, kind: 'shader' | 'resourcepack', src: string, log?: (m: string) => void): Promise<void> {
  try {
    if (!autoModpackActive(serverId) || !existsSync(src)) return;
    const dstDir = join(extrasDir(serverId), kind === 'shader' ? 'shaderpacks' : 'resourcepacks');
    mkdirSync(dstDir, { recursive: true });
    copyFileSync(src, join(dstDir, src.split(/[\\/]/).pop()!));
    await chownToDirOwner(dstDir);
    await publishPack(serverId, log);
  } catch (e) {
    log?.(`automodpack: staging ${src} failed: ${String(e).slice(0, 120)}`);
  }
}

// ---- Starter packs: the one-time bootstrap friends import. Right MC and
// loader, the AutoModpack jar, and the server pre-registered in servers.dat.
// Everything else arrives through AutoModpack on first join.

function nbtStr(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}

function serversDat(name: string, ip: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x0a]), nbtStr(''),
    Buffer.from([0x09]), nbtStr('servers'), Buffer.from([0x0a, 0, 0, 0, 1]),
    Buffer.from([0x08]), nbtStr('ip'), nbtStr(ip),
    Buffer.from([0x08]), nbtStr('name'), nbtStr(name),
    Buffer.from([0x00]),
    Buffer.from([0x00]),
  ]);
}

interface StarterBase {
  mc: string;
  loader: 'fabric' | 'forge' | 'neoforge';
  loaderVersion: string;
  jar: modrinth.VersionFile;
}

async function starterBase(serverId: string): Promise<StarterBase> {
  const dir = serverDir(serverId);
  const det = detect(dir, serverId);
  if (!det.mc || (det.loader !== 'fabric' && det.loader !== 'forge' && det.loader !== 'neoforge')) {
    throw new Error('starter packs need a Fabric, Forge or NeoForge server with a detectable MC version');
  }
  // the client runs the server's own loader version (mods may need a minimum one)
  const loader = loaderVersion(dir, det);
  if (!loader) throw new Error(`${det.loader} version not found in libraries/`);
  // client and server must run the same AutoModpack build: ship the server's own when Modrinth knows it
  const modsDir = join(dir, 'mods');
  const own = existsSync(modsDir) ? readdirSync(modsDir).find((f) => /^automodpack.*\.jar$/i.test(f)) : undefined;
  const sha1 = own && createHash('sha1').update(readFileSync(join(modsDir, own))).digest('hex');
  const version = (sha1 && (await modrinth.identifyByHashes([sha1]))[sha1])
    || modrinth.bestVersion(await modrinth.getVersions('automodpack', { mc: det.mc, loader: det.loader }));
  const jar = version && (version.files.find((f) => f.primary) ?? version.files[0]);
  if (!jar) throw new Error(`AutoModpack has no build for ${det.mc} ${det.loader}`);
  return { mc: det.mc, loader: det.loader, loaderVersion: loader, jar };
}

const safeName = (name: string, serverId: string): string =>
  name.replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '-') || serverId.slice(0, 8);

/** Modrinth .mrpack starter. `address` is what friends type to join. */
export async function buildStarterPack(serverId: string, serverName: string, address: string): Promise<{ filename: string; buffer: Buffer }> {
  const b = await starterBase(serverId);
  const loaderKey = b.loader === 'fabric' ? 'fabric-loader' : b.loader;
  const index = {
    formatVersion: 1, game: 'minecraft', versionId: '1.0.0',
    name: `${serverName} Starter`,
    summary: 'Join once; AutoModpack installs and updates everything else.',
    files: [{
      path: `mods/${b.jar.filename}`,
      hashes: b.jar.hashes,
      env: { client: 'required', server: 'unsupported' },
      downloads: [b.jar.url], fileSize: b.jar.size,
    }],
    dependencies: { minecraft: b.mc, [loaderKey]: b.loaderVersion },
  };
  const zip = new AdmZip();
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(index, null, 2)));
  zip.addFile('overrides/servers.dat', serversDat(serverName, address));
  return { filename: `${safeName(serverName, serverId)}-Starter.mrpack`, buffer: zip.toBuffer() };
}

/** The same starter in CurseForge's zip format (the CurseForge app cannot
    read .mrpack). The AutoModpack jar ships in overrides/ because its
    CurseForge listing lags the Modrinth one. */
export async function buildStarterPackCF(serverId: string, serverName: string, address: string): Promise<{ filename: string; buffer: Buffer }> {
  const b = await starterBase(serverId);
  const jarBytes = Buffer.from(await (await fetch(b.jar.url, { redirect: 'follow' })).arrayBuffer());
  const manifest = {
    minecraft: { version: b.mc, modLoaders: [{ id: `${b.loader}-${b.loaderVersion}`, primary: true }] },
    manifestType: 'minecraftModpack',
    manifestVersion: 1,
    name: `${serverName} Starter`,
    version: '1.0.0',
    author: 'Spawnpoint',
    files: [],
    overrides: 'overrides',
  };
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  zip.addFile(`overrides/mods/${b.jar.filename}`, jarBytes);
  zip.addFile('overrides/servers.dat', serversDat(serverName, address));
  return { filename: `${safeName(serverName, serverId)}-Starter-CurseForge.zip`, buffer: zip.toBuffer() };
}
