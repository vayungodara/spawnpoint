import { existsSync, readdirSync, copyFileSync, unlinkSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { serverDir, clientShelfDir } from './servers.js';
import { detect, loaderVersion } from './detect.js';
import { chownToDirOwner, writeFileAtomic } from './platform.js';
import { rconCommand, withRcon } from '../clients/rcon.js';
import { craftyApi } from '../clients/crafty.js';
import * as modrinth from '../clients/modrinth.js';
import { PATHS } from '../config.js';
import { assertUnsealed, revisionState, verifyActiveRevision, withStoppedRevision, writeLaunchGate } from './revisions.js';
import { stopAndWait } from './maintenance.js';

// AutoModpack syncs a server's mods to every client that joins. It reads two
// folders: the server's mods/ and automodpack/host-modpack/main/ (client-only
// extras). Client-only mods the panel installs live on the client shelf
// (data/clientmods/<id>/), so publishPack() mirrors the shelf into the extras
// folder and asks AutoModpack to regenerate. Only jars the bridge copied are
// ever removed from extras; hand-placed files are never recorded or touched.

const BRIDGED_RECORD = '.spawnpoint-bridged.json';
const holdFile = (id: string): string => join(PATHS.data, 'pack-hosting', `${id}.json`);

/** Persisted before turning hosting off. Promotion can recover a panel crash
    without exposing a revision whose live boot has not been verified. */
export function hostingHold(id: string): { original: string; paused: string } | null {
  return existsSync(holdFile(id)) ? JSON.parse(readFileSync(holdFile(id), 'utf8')) : null;
}
export function holdHosting(id: string): void {
  if (!autoModpackActive(id)) return;
  if (!revisionState(id).managedHosting) throw new Error('the owner must approve managed AutoModpack hosting before promotion');
  const path = join(amDir(id), 'automodpack-server.json');
  const prior = hostingHold(id);
  const original = prior?.original ?? readFileSync(path, 'utf8');
  const cfg = JSON.parse(original);
  if (cfg.modpackHost !== true || cfg.generateModpackOnStart !== true || cfg.selfUpdater !== false) throw new Error('managed publication requires modpackHost and generateModpackOnStart enabled, and selfUpdater disabled; review the AutoModpack settings first');
  const paused = prior?.paused ?? JSON.stringify({ ...JSON.parse(original), modpackHost: false }, null, 2);
  if (!prior) writeFileAtomic(holdFile(id), JSON.stringify({ original, paused }));
  writeFileAtomic(path, paused);
}
/** Make a verified pack visible. Keep hosting OFF in the startup config:
    even an external Crafty start cannot publish an unverified future boot.
    AutoModpack's async feedback must go to the console: RCON returns before
    completion and does not log feedback with broadcast-rcon-to-ops=false. */
export async function releaseHosting(id: string, verify: () => Promise<void>): Promise<void> {
  const hold = hostingHold(id);
  if (!hold) return;
  const path = join(amDir(id), 'automodpack-server.json');
  const logPath = join(serverDir(id), 'logs', 'latest.log');
  const mutex = join(serverDir(id), '.spawnpoint-publication');
  await withRcon(id, async (send) => {
    mkdirSync(mutex); // shared with the required pre-JVM launch guard
    writeFileAtomic(join(mutex, 'owner.json'), JSON.stringify({ pid: process.pid }));
    const command = async (cmd: string, success: RegExp): Promise<void> => {
      const offset = readFileSync(logPath, 'utf8').length;
      await craftyApi.sendStdin(id, cmd);
      for (let i = 0; ; i++) {
        const lines = readFileSync(logPath, 'utf8').slice(offset).split(/\r?\n/);
        // Exact console feedback only; chat and intermediate Netty host logs
        // cannot certify completion. Forge adds its logger name after INFO.
        const messages = lines.flatMap((line) => /^\[[^[\]\r\n]+\] \[[^[\]\r\n]+\/INFO\](?: \[[^[\]\r\n]*\])?: (.*)$/.exec(line)?.slice(1) ?? []);
        if (messages.some((message) => success.test(message))) return;
        if (messages.some((message) => /^(?:Error while reloading config file!|Couldn't start server!)$/.test(message))) throw new Error('AutoModpack refused the publication command');
        if (i >= 30) throw new Error('AutoModpack did not acknowledge the publication command');
        await new Promise((r) => setTimeout(r, 1000));
      }
    };
    try {
      await send('list'); // this connection cannot migrate to a later boot
      await verify();
      await send('list');
      writeFileAtomic(path, hold.original);
      await command('automodpack config reload', /^AutoModpack server config reloaded!$/);
      await send('list');
      writeFileAtomic(path, hold.paused);
      await command('automodpack host start', /^Modpack hosting (?:started!|is already running!)$/);
      await send('list');
      writeFileAtomic(path, hold.paused);
      rmSync(mutex, { recursive: true });
    } catch (error) {
      // A timed-out reload can still save enabled bytes or start hosting.
      // Do not retry in this JVM or release its fence until it is gone.
      await abortHosting(id);
      throw error;
    }
  });
}
async function abortHosting(id: string): Promise<void> {
  if (!await stopAndWait(id)) throw new Error('publication remains fenced: the previous JVM did not stop');
  await withStoppedRevision(id, async () => {
    holdHosting(id);
    rmSync(join(serverDir(id), '.spawnpoint-publication'), { recursive: true });
  });
}
/** Only a known-dead panel publisher's mutex can be reclaimed automatically.
    An unidentified guard stays fail-closed rather than racing a live launch. */
export async function recoverHosting(id: string): Promise<void> {
  const mutex = join(serverDir(id), '.spawnpoint-publication');
  if (!existsSync(join(mutex, 'owner.json'))) return;
  const { pid } = JSON.parse(readFileSync(join(mutex, 'owner.json'), 'utf8'));
  try { process.kill(pid, 0); return; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
  await abortHosting(id);
}

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
        selfUpdater: false,
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
    its tests. Locked packs fail closed on errors. */
export async function publishPack(serverId: string, log?: (m: string) => void): Promise<void> {
  try {
    if (!autoModpackActive(serverId)) return;
    await verifyActiveRevision(serverId);
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
    if (revisionState(serverId).active) {
      holdHosting(serverId);
      writeLaunchGate(serverId);
      return; // promotion regenerates while hosting is held
    }
    await rconCommand(serverId, 'automodpack generate', { timeout: 15_000 })
      .then(() => log?.(`automodpack: regenerated ${serverId}'s pack`))
      .catch(() => log?.(`automodpack: ${serverId} is offline, so its pack regenerates on next boot`));
  } catch (e) {
    log?.(`automodpack: publish failed for ${serverId}: ${String(e).slice(0, 120)}`);
    if (revisionState(serverId).active) throw e;
  }
}

/** Resource and shader packs install into the panel's downloads folder; on an
    AutoModpack server they also belong in the synced extras. */
export async function stageClientAsset(serverId: string, kind: 'shader' | 'resourcepack', src: string, log?: (m: string) => void): Promise<void> {
  try {
    if (!autoModpackActive(serverId) || !existsSync(src)) return;
    assertUnsealed(serverId);
    const dstDir = join(extrasDir(serverId), kind === 'shader' ? 'shaderpacks' : 'resourcepacks');
    mkdirSync(dstDir, { recursive: true });
    copyFileSync(src, join(dstDir, src.split(/[\\/]/).pop()!));
    await chownToDirOwner(dstDir);
    await publishPack(serverId, log);
  } catch (e) {
    log?.(`automodpack: staging ${src} failed: ${String(e).slice(0, 120)}`);
    if (revisionState(serverId).active) throw e;
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
