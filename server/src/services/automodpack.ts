import { existsSync, readdirSync, copyFileSync, unlinkSync, mkdirSync, statSync, readFileSync, writeFileSync, chownSync } from 'node:fs';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { PATHS, loadSettings } from '../config.js';
import { serverDir } from './servers.js';
import { detect } from './detect.js';
import { clientShelfDir } from './installer.js';
import { rconCommand } from '../clients/rcon.js';

// AUTOMODPACK BRIDGE — servers running AutoModpack sync their mod set to
// clients on join, but the mod only sees two folders: the server's mods/ and
// automodpack/host-modpack/main/ (client-only extras). The panel's client-only
// detection shelves jars into data/clientmods/<id>/ (the old export pipeline's
// shelf) — invisible to AutoModpack. This bridge mirrors the shelf into the
// extras folder after every panel mod change and asks the mod to regenerate,
// so "install via panel → friend rejoins → mod is there" holds for BOTH lanes
// (found live 2026-07-20: Borderless Fullscreen installed fine, never synced).
//
// Only shelf jars the bridge itself copied are ever deleted from extras —
// hand-curated files (perf set, shaderpacks) are recorded nowhere and thus
// untouchable. The record lives next to the config, one file per server.

const BRIDGED_RECORD = '.spawnpoint-bridged.json';

function amDir(serverId: string): string {
  return join(serverDir(serverId), 'automodpack');
}

/** True when this server runs AutoModpack (config dir exists). */
export function autoModpackActive(serverId: string): boolean {
  return existsSync(amDir(serverId));
}

/** chown to the dir's owner so the crafty-run server can manage what the
    root-run panel wrote — same root-vs-crafty bug class as world resets. */
function chownToDirOwner(dir: string, path: string): void {
  try {
    const st = statSync(dir);
    chownSync(path, st.uid, st.gid);
  } catch { /* not fatal: jars only need to be readable */ }
}

/** Born-synced: every panel-created server gets AutoModpack + a ready config,
    so friends bootstrap once and never manage pack files (fleet decision
    2026-07-20). Failures are warnings on the create job, never a failed create. */
export async function provisionAutoModpack(serverId: string, loader: string, log?: (m: string) => void): Promise<string[]> {
  const warnings: string[] = [];
  try {
    const { install } = await import('./installer.js');
    const r = await install(serverId, { projectId: 'automodpack', type: 'mod', force: true });
    if (!('installed' in r) || !r.installed.length) {
      warnings.push('AutoModpack has no build for this MC/loader yet — clients need a manual pack for now');
    }
    const am = amDir(serverId);
    mkdirSync(join(am, 'host-modpack', 'main', 'mods'), { recursive: true });
    mkdirSync(join(am, 'host-modpack', 'main', 'shaderpacks'), { recursive: true });
    const cfgPath = join(am, 'automodpack-server.json');
    if (!existsSync(cfgPath)) {
      // partial config is fine: the mod fills every missing key with its
      // defaults on first boot. New servers have no legacy instances, so
      // clients are required to sync from day one.
      writeFileSync(cfgPath, JSON.stringify({
        DO_NOT_CHANGE_IT: 2,
        modpackName: '',
        modpackHost: true,
        generateModpackOnStart: true,
        requireAutoModpackOnClient: true,
        acceptedLoaders: [loader === 'quilt' ? 'fabric' : loader],
      }, null, 2), 'utf8');
    }
    // owner's defaults for every server: an FPS counter + ModMenu (fabric —
    // forge has a built-in Mods screen) in the pack, and first-install client
    // settings tuned for frames (editable — a friend's later changes stick,
    // this only seeds fresh installs)
    await install(serverId, { projectId: 'fpsdisplay', type: 'mod', force: true }).catch(() => {
      warnings.push('fpsdisplay has no build for this MC/loader — skipped');
    });
    if (loader !== 'forge' && loader !== 'neoforge') {
      await install(serverId, { projectId: 'modmenu', type: 'mod', force: true }).catch(() => {
        warnings.push('modmenu has no build for this MC/loader — skipped');
      });
    }
    // owner's rule (2026-07-21): every new server also ships the CLIENT
    // performance set — friends get Fabulously-Optimized-level frames with
    // zero setup (Colonies was born with an empty extras folder and the
    // owner expected otherwise). Per-loader lists because the ecosystems
    // split (sodium/iris vs embeddium/oculus); client-only mods route to the
    // shelf automatically and bridge into the pack. A slug with no build for
    // this MC/loader skips with a warning — expected off the beaten path.
    const CLIENT_PERF: Record<string, string[]> = {
      fabric: ['sodium', 'lithium', 'iris', 'sodium-extra', 'reeses-sodium-options', 'entityculling', 'immediatelyfast', 'dynamic-fps', 'ferrite-core', 'modernfix', 'moreculling', 'indium', 'badoptimizations'],
      quilt: ['sodium', 'lithium', 'iris', 'sodium-extra', 'reeses-sodium-options', 'entityculling', 'immediatelyfast', 'dynamic-fps', 'ferrite-core', 'modernfix', 'moreculling', 'indium', 'badoptimizations'],
      forge: ['embeddium', 'oculus', 'canary', 'rubidium-extra', 'fps-monitor', 'entityculling', 'immediatelyfast', 'dynamic-fps', 'ferrite-core', 'modernfix'],
      // modern neoforge has real sodium/iris ports; embeddium covers the older gap
      neoforge: ['sodium', 'iris', 'embeddium', 'sodium-extra', 'rubidium-extra', 'entityculling', 'immediatelyfast', 'dynamic-fps', 'ferrite-core', 'modernfix'],
    };
    // canary (forge lithium) rewrites the village-POI class that Valkyrien
    // Skies also hooks — VS's mixin then fails injection and the game dies in
    // the tick loop (gate-proven on FreshMC, 2026-08-02). Physics servers go
    // without canary; everything else keeps it.
    const modsNow = (() => {
      try { return readdirSync(join(serverDir(serverId), 'mods')).join(' ').toLowerCase(); } catch { return ''; }
    })();
    const hasVS = modsNow.includes('valkyrienskies');
    for (const slug of CLIENT_PERF[loader] ?? []) {
      if (slug === 'canary' && hasVS) {
        warnings.push('canary skipped — conflicts with Valkyrien Skies (POI mixin)');
        continue;
      }
      await install(serverId, { projectId: slug, type: 'mod', force: true }).catch(() => {
        warnings.push(`${slug} has no build for this MC/loader — skipped`);
      });
    }
    writeFileSync(join(am, 'host-modpack', 'main', 'options.txt'),
      'enableVsync:false\nmaxFps:260\nentityDistanceScaling:0.75\n', 'utf8');
    // synced resource/shader packs must land in the CLIENT'S real folders —
    // without forceCopy they stay inside automodpack's internal modpack dir,
    // invisible to the vanilla Resource Packs screen (live 2026-08-02: the
    // owner stared at Faithful in the wrong folder wondering why the menu
    // was empty)
    try {
      const cfgPath = join(am, 'automodpack-server.json');
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
      cfg.forceCopyFilesToStandardLocation = ['/resourcepacks/**', '/shaderpacks/**'];
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    } catch { /* config appears on first boot — the janitor's next pass or a re-provision covers it */ }
    // sodium-extra (fabric) and rubidium-extra (forge — same codebase, same
    // filename) both read sodium-extra-options.json. Seed the owner's tuned
    // defaults — reduce_resolution_on_mac ON etc. — so every fresh client
    // gets Retina-friendly frames without touching a menu. First-install
    // only: a friend's later changes live in their local file and stick.
    const seKey = join(PATHS.root, 'Shared', 'client-config-seeds', 'sodium-extra-options.json');
    if (existsSync(seKey)) {
      const cfgDir = join(am, 'host-modpack', 'main', 'config');
      mkdirSync(cfgDir, { recursive: true });
      copyFileSync(seKey, join(cfgDir, 'sodium-extra-options.json'));
    }
    await syncAutoModpack(serverId, log); // bridge the shelf (fpsdisplay is client-only)
    log?.(`automodpack: provisioned on new server ${serverId}`);
  } catch (e) {
    warnings.push(`AutoModpack setup skipped: ${String(e).slice(0, 100)}`);
  }
  return warnings;
}

/** Mirror the client shelf into host-modpack extras and regenerate. Fire-and-
    forget safe; never throws. Returns what changed for the caller's log. */
export async function syncAutoModpack(serverId: string, log?: (m: string) => void): Promise<{ active: boolean; copied: string[]; removed: string[] }> {
  const out: { active: boolean; copied: string[]; removed: string[] } = { active: false, copied: [], removed: [] };
  try {
    if (!autoModpackActive(serverId)) return out;
    out.active = true;
    const extras = join(amDir(serverId), 'host-modpack', 'main', 'mods');
    mkdirSync(extras, { recursive: true });

    const recordPath = join(amDir(serverId), BRIDGED_RECORD);
    let previous: string[] = [];
    try {
      previous = JSON.parse(readFileSync(recordPath, 'utf8'));
    } catch { /* first run */ }

    const shelf = clientShelfDir(serverId);
    const shelfJars = existsSync(shelf) ? readdirSync(shelf).filter((f) => f.endsWith('.jar')) : [];
    for (const jar of shelfJars) {
      const src = join(shelf, jar);
      const dst = join(extras, jar);
      if (!existsSync(dst) || statSync(dst).size !== statSync(src).size) {
        copyFileSync(src, dst);
        chownToDirOwner(amDir(serverId), dst);
        out.copied.push(jar);
      }
    }
    // a jar WE bridged that has left the shelf was uninstalled or replaced —
    // drop it from extras too (hand-placed files are not in the record)
    for (const jar of previous) {
      if (!shelfJars.includes(jar) && existsSync(join(extras, jar))) {
        unlinkSync(join(extras, jar));
        out.removed.push(jar);
      }
    }
    writeFileSync(recordPath, JSON.stringify(shelfJars, null, 2), 'utf8');

    // regenerate so the change ships on the NEXT join. Offline server is fine:
    // generateModpackOnStart covers it at the next boot.
    if (out.copied.length || out.removed.length) {
      await rconCommand(serverId, 'automodpack generate', { timeout: 15_000 }).catch(() => {
        log?.(`automodpack: ${serverId} offline — modpack regenerates on next boot`);
      });
      log?.(`automodpack: synced extras for ${serverId} (+${out.copied.length} −${out.removed.length}) and regenerated`);
    } else {
      // server-side mods/ changes need a regenerate too, even with no shelf delta
      await rconCommand(serverId, 'automodpack generate', { timeout: 15_000 }).catch(() => {});
    }
    // Tier-2: boot the regenerated client set headlessly so a client-side
    // conflict is caught here, never on a friend's screen
    if (log) {
      const { queueLaunchGate } = await import('./launchgate.js');
      queueLaunchGate(serverId, log);
    }
  } catch (e) {
    log?.(`automodpack: bridge failed for ${serverId}: ${String(e).slice(0, 120)}`);
  }
  return out;
}


/** Panel-installed shaders/resourcepacks go to the global downloads collection
    (pre-AutoModpack design) — mirror them into this server's synced extras so
    friends actually receive them. Additive only; regenerate ships it. */
export async function stageClientAsset(serverId: string, kind: 'shader' | 'resourcepack', file: string, log?: (m: string) => void): Promise<void> {
  try {
    if (!autoModpackActive(serverId)) return;
    const src = join(PATHS.downloads, file);
    if (!existsSync(src)) return;
    const folder = kind === 'shader' ? 'shaderpacks' : 'resourcepacks';
    const dstDir = join(amDir(serverId), 'host-modpack', 'main', folder);
    mkdirSync(dstDir, { recursive: true });
    copyFileSync(src, join(dstDir, file));
    chownToDirOwner(amDir(serverId), join(dstDir, file));
    await rconCommand(serverId, 'automodpack generate', { timeout: 15_000 }).catch(() => {});
    log?.(`automodpack: staged ${kind} ${file} into ${serverId}'s synced pack`);
  } catch (e) {
    log?.(`automodpack: staging ${file} failed: ${String(e).slice(0, 120)}`);
  }
}

// ---- STARTER PACK — the one-time bootstrap friends import: right MC+loader,
// the AutoModpack jar, and the server pre-registered in servers.dat. ~800
// bytes; everything else arrives via sync on first join. Friends can also
// skip this and drop the automodpack jar into a matching instance by hand —
// this is convenience, not a requirement.

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

export async function buildStarterPack(serverId: string, serverName: string): Promise<{ filename: string; buffer: Buffer }> {
  const dir = serverDir(serverId);
  const det = detect(dir, serverId);
  if (!det.mc || det.loader === 'unknown') throw new Error('cannot detect MC version/loader for this server');

  const deps: Record<string, string> = { minecraft: det.mc };
  if (det.loader === 'forge') {
    const fdir = join(dir, 'libraries', 'net', 'minecraftforge', 'forge');
    const v = existsSync(fdir) ? readdirSync(fdir)[0] : null;
    if (!v) throw new Error('forge version not found in libraries');
    deps.forge = v.replace(`${det.mc}-`, '');
  } else {
    const loaders = (await (await fetch('https://meta.fabricmc.net/v2/versions/loader')).json()) as { version: string; stable: boolean }[];
    deps['fabric-loader'] = loaders.find((l) => l.stable)?.version ?? loaders[0].version;
  }

  const q = `game_versions=${encodeURIComponent(JSON.stringify([det.mc]))}&loaders=${encodeURIComponent(JSON.stringify([det.loader]))}`;
  const vers = (await (await fetch(`https://api.modrinth.com/v2/project/automodpack/version?${q}`, {
    headers: { 'user-agent': 'spawnpoint/1.0' },
  })).json()) as { version_number: string; files: { primary: boolean; filename: string; url: string; size: number; hashes: { sha1: string; sha512: string } }[] }[];
  if (!Array.isArray(vers) || !vers.length) throw new Error(`AutoModpack has no build for ${det.mc} ${det.loader}`);
  const file = vers[0].files.find((f) => f.primary) ?? vers[0].files[0];

  const address = ((): string => {
    try {
      const cp = JSON.parse(readFileSync(join(PATHS.data, 'clientpack.json'), 'utf8')) as { addresses?: Record<string, string> };
      return cp.addresses?.[serverId] ?? loadSettings().laneSrvTarget ?? 'localhost';
    } catch { return loadSettings().laneSrvTarget ?? 'localhost'; }
  })();

  const index = {
    formatVersion: 1, game: 'minecraft', versionId: '1.0.0',
    name: `${serverName} — Starter`,
    summary: 'Join once; AutoModpack installs and updates everything else automatically.',
    files: [{
      path: `mods/${file.filename}`,
      hashes: { sha1: file.hashes.sha1, sha512: file.hashes.sha512 },
      env: { client: 'required', server: 'unsupported' },
      downloads: [file.url], fileSize: file.size,
    }],
    dependencies: deps,
  };
  const zip = new AdmZip();
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(index, null, 2)));
  zip.addFile('overrides/servers.dat', serversDat(serverName, address));
  const safe = serverName.replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '-') || serverId.slice(0, 8);
  return { filename: `${safe}-Starter.mrpack`, buffer: zip.toBuffer() };
}

/** Same starter in CurseForge's native zip format — the CF app cannot read
    .mrpack. One CF file reference (AutoModpack) + servers.dat override. */
export async function buildStarterPackCF(serverId: string, serverName: string): Promise<{ filename: string; buffer: Buffer }> {
  const dir = serverDir(serverId);
  const det = detect(dir, serverId);
  if (!det.mc || det.loader === 'unknown') throw new Error('cannot detect MC version/loader for this server');

  let loaderId: string;
  if (det.loader === 'forge') {
    const fdir = join(dir, 'libraries', 'net', 'minecraftforge', 'forge');
    const v = existsSync(fdir) ? readdirSync(fdir)[0] : null;
    if (!v) throw new Error('forge version not found in libraries');
    loaderId = `forge-${v.replace(`${det.mc}-`, '')}`;
  } else {
    const loaders = (await (await fetch('https://meta.fabricmc.net/v2/versions/loader')).json()) as { version: string; stable: boolean }[];
    loaderId = `fabric-${loaders.find((l) => l.stable)?.version ?? loaders[0].version}`;
  }

  // CurseForge's AutoModpack listing lags whole versions behind Modrinth
  // (26.2 missing entirely, checked live 2026-07-21) — so don't reference a CF
  // file at all: bundle the Modrinth jar in overrides/, which the CF app
  // copies into the profile verbatim. Works for every version and loader.
  const q = `game_versions=${encodeURIComponent(JSON.stringify([det.mc]))}&loaders=${encodeURIComponent(JSON.stringify([det.loader]))}`;
  const vers = (await (await fetch(`https://api.modrinth.com/v2/project/automodpack/version?${q}`, {
    headers: { 'user-agent': 'spawnpoint/1.0' },
  })).json()) as { files: { primary: boolean; filename: string; url: string }[] }[];
  if (!Array.isArray(vers) || !vers.length) throw new Error(`AutoModpack has no build for ${det.mc} ${det.loader}`);
  const file = vers[0].files.find((f) => f.primary) ?? vers[0].files[0];
  const jarBytes = Buffer.from(await (await fetch(file.url, { redirect: 'follow' })).arrayBuffer());

  const address = ((): string => {
    try {
      const cp = JSON.parse(readFileSync(join(PATHS.data, 'clientpack.json'), 'utf8')) as { addresses?: Record<string, string> };
      return cp.addresses?.[serverId] ?? loadSettings().laneSrvTarget ?? 'localhost';
    } catch { return loadSettings().laneSrvTarget ?? 'localhost'; }
  })();

  const manifest = {
    minecraft: { version: det.mc, modLoaders: [{ id: loaderId, primary: true }] },
    manifestType: 'minecraftModpack',
    manifestVersion: 1,
    name: `${serverName} — Starter`,
    version: '1.0.0',
    author: 'Spawnpoint',
    files: [],
    overrides: 'overrides',
  };
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  zip.addFile(`overrides/mods/${file.filename}`, jarBytes);
  zip.addFile('overrides/servers.dat', serversDat(serverName, address));
  const safe = serverName.replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '-') || serverId.slice(0, 8);
  return { filename: `${safe}-Starter-CurseForge.zip`, buffer: zip.toBuffer() };
}
