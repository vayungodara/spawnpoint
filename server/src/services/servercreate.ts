import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS, loadSettings } from '../config.js';
import { craftyApi } from '../clients/crafty.js';
import { nativeInstallJob, nativeInstallJobs, queueNativeInstall } from './nativeinstall.js';
import { listVersions } from './recipes.js';
import * as modrinth from '../clients/modrinth.js';
import * as curseforge from '../clients/curseforge.js';
import {
  installModpack, installCurseforgeModpack,
  installMrpackFile, installCurseforgeZipFile, inspectPackFile,
  type ModpackResult,
} from './modpack.js';
import { javaFor, serverDir } from './servers.js';
import { patchProperties } from './properties.js';
import { derivedRcon, suggestGamePort } from './ports.js';
import { chownToDirOwner } from './platform.js';
import { hashes } from './revisions.js';

// One-click "create a server FROM a modpack": Crafty's wizard API builds the
// base server (it downloads Fabric / runs the Forge installer itself), then
// the existing modpack installers pour the pack in. Long-running, so it runs
// as a background job the UI polls.

export interface CreateJob {
  id: string;
  status: string; // human-readable current step
  done: boolean;
  error: string | null;
  serverId: string | null;
  packName: string | null;
  warnings: string[];
}

const jobs = new Map<string, CreateJob>();

export function getJob(id: string): CreateJob | undefined {
  return nativeInstallJob(id) ?? jobs.get(id);
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CRAFTY_TYPE: Record<string, string> = {
  fabric: 'fabric',
  forge: 'forge-installer',
  neoforge: 'neoforge-installer',
  quilt: 'quilt',
  paper: 'paper',
  purpur: 'purpur',
  vanilla: 'vanilla',
};

// Version catalogues come straight from each project's own API (recipes.ts).
// Crafty has no public jars endpoint on this build — GET /api/v2/jars is 404 —
// so neither runtime depends on its internal cache.

export async function listLoaderVersions(loader: string): Promise<string[]> {
  if (!CRAFTY_TYPE[loader]) throw new Error(`unknown loader "${loader}"`);
  return listVersions(loader);
}

export function listLoaders(): string[] {
  return Object.keys(CRAFTY_TYPE);
}

// ---------------------------------------------------------------------------
// Every trap a freshly-created server falls into, closed in one place.
// ---------------------------------------------------------------------------

/** Modded loaders read their heap from user_jvm_args.txt, NOT from the
    -Xmx in Crafty's launch command — so RAM chosen in Crafty silently did
    nothing and the server ran on the JVM default. Vanilla/Fabric/Paper take
    it on the command line. Handle both, always. */
export function applyMemory(dir: string, execCommand: string, memGb: number): string {
  const min = Math.max(1, Math.min(memGb, Math.round(memGb / 2) || 1));
  const argsFile = join(dir, 'user_jvm_args.txt');
  if (existsSync(argsFile)) {
    // forge / neoforge
    const lines = readFileSync(argsFile, 'utf8')
      .split(/\r?\n/)
      .filter((l) => !/^\s*-Xm[sx]/i.test(l));
    lines.push(`-Xms${min}G`, `-Xmx${memGb}G`, '');
    writeFileSync(argsFile, lines.join('\n'), 'utf8');
    // the command must NOT also carry -Xmx (it would fight the args file)
    return execCommand.replace(/\s-Xm[sx]\S+/gi, '');
  }
  // fabric / vanilla / paper: heap lives in the launch command
  const stripped = execCommand.replace(/\s-Xm[sx]\S+/gi, '');
  return stripped.replace(/^("[^"]+"|\S+)/, `$1 -Xms${min}G -Xmx${memGb}G`);
}

/** Make a Crafty-created server actually bootable. */
export async function finalizeServer(
  serverId: string,
  opts: { mc: string | null; memGb?: number; loader?: string | null; gamePort?: number },
): Promise<string[]> {
  const notes: string[] = [];
  const dir = serverDir(serverId);

  // 0. Uniquify rcon.port. Crafty hands every new server the same rcon.port from
  //    its template, so two servers would silently share it and the genie's RCON
  //    could hit the wrong world (clients/rcon.ts connects by rcon.port). Derive
  //    it from the game port so a unique game port guarantees a unique rcon port.
  if (opts.gamePort) {
    try {
      patchProperties(serverId, {
        'enable-rcon': 'true',
        'rcon.port': String(derivedRcon(opts.gamePort)),
      });
    } catch { notes.push('could not set a unique rcon.port'); }
  }

  // 1. EULA — the silent killer. Crafty compares eula.txt's contents LITERALLY
  //    against "eula=true": a comment line above it, or even a trailing
  //    newline, makes it decide the EULA is not accepted. It then aborts the
  //    launch with no process, no error and no console output — the panel just
  //    says "starting" forever. Write exactly 9 bytes. (`accept_eula` is NOT
  //    an API action: Crafty routes it to the server console and it fails with
  //    "server not running".)
  try {
    writeFileSync(join(dir, 'eula.txt'), 'eula=true', 'utf8');
  } catch { notes.push('could not write eula.txt'); }

  // 2. Java: absolute path (Crafty's service account has no java on PATH) and
  //    the RIGHT major (26.x needs 25; Forge 1.20.x breaks on anything newer
  //    than 21). Paths must be space-free — Crafty tears the command at spaces.
  const server = await craftyApi.getServer(serverId).catch(() => null);
  let cmd = server?.execution_command ?? '';
  let java = javaFor(opts.mc, opts.loader);
  if (!java) {
    // fresh box, empty Tools/: fetch the right Temurin instead of shipping
    // a server that silently never starts
    const { ensureJdk, jdkFeatureFor } = await import('./temurin.js');
    if (await ensureJdk(jdkFeatureFor(opts.mc, opts.loader), (m) => notes.push(m))) {
      java = javaFor(opts.mc, opts.loader);
    }
  }
  if (cmd && java) {
    cmd = /^"?java(\.exe)?"?\s/.test(cmd) ? cmd.replace(/^"?java(\.exe)?"?/, `"${java}"`) : cmd;
  } else if (!java) {
    notes.push(`no suitable JDK found under ${join(PATHS.root, 'Tools')}`);
  }

  // 3. RAM, into whichever file this loader actually reads
  if (cmd && opts.memGb) cmd = applyMemory(dir, cmd, opts.memGb);

  if (cmd && cmd !== server?.execution_command) {
    await craftyApi.patchServer(serverId, { execution_command: cmd }).catch(() => {
      notes.push('could not update the launch command in Crafty');
    });
  }
  return notes;
}

interface PackMeta {
  loader: string;
  mc: string;
  fileId: string; // versionId (modrinth) / fileId (curseforge)
  title: string;
}

async function resolvePack(source: string, projectId: string, versionId?: string): Promise<PackMeta> {
  if (source === 'curseforge') {
    const [mod, files] = await Promise.all([
      curseforge.getMod(projectId),
      curseforge.getFiles(projectId),
    ]);
    const file = versionId ? files.find((f) => String(f.id) === versionId) : files[0];
    if (!file) throw new Error('no downloadable pack file found');
    const gv = file.gameVersions.map((v) => v.toLowerCase());
    const loader = ['forge', 'fabric', 'neoforge', 'quilt'].find((l) => gv.includes(l)) ?? 'forge';
    const mc = file.gameVersions.find((v) => /^\d+\.\d+(\.\d+)?$/.test(v));
    if (!mc) throw new Error('pack file does not state its Minecraft version');
    return { loader, mc, fileId: String(file.id), title: mod.name };
  }
  const versions = await modrinth.getVersions(projectId, {});
  const version = versionId ? versions.find((v) => v.id === versionId) : versions[0];
  if (!version) throw new Error('no pack version found');
  const loader = version.loaders[0] ?? 'fabric';
  const mc = version.game_versions[0];
  if (!mc) throw new Error('pack version does not state its Minecraft version');
  const proj = await modrinth.getProject(projectId).catch(() => null);
  return { loader, mc, fileId: version.id, title: proj?.title ?? version.name };
}

// Delegates to the ports service so a new game port avoids every existing
// server's game AND rcon port (and the panel), keeping derived rcon ports clash-free.
const nextFreePort = (): Promise<number> => suggestGamePort();

/** The loader is installed once a launchable server file exists. */
function loaderReady(dir: string, loader: string): boolean {
  if (!existsSync(dir)) return false;
  const files = readdirSync(dir);
  if (loader === 'forge' || loader === 'neoforge') {
    return files.includes('run.bat') && files.includes('libraries');
  }
  return files.some((f) => f.endsWith('.jar') && !f.includes('installer'));
}

/** Create a plain server of any loader/version — no Crafty visit required. */
export async function startCreateServer(opts: {
  name: string;
  loader: string;
  mc: string;
  memGb?: number;
}): Promise<{ jobId: string }> {
  if (loadSettings().runtime === 'standalone') return queueNativeInstall(opts);
  const id = randomUUID().slice(0, 8);
  const job: CreateJob = {
    id, status: 'starting…', done: false, error: null,
    serverId: null, packName: null, warnings: [],
  };
  jobs.set(id, job);

  (async () => {
    const craftyType = CRAFTY_TYPE[opts.loader];
    if (!craftyType) throw new Error(`unsupported loader "${opts.loader}"`);
    const versions = await listLoaderVersions(opts.loader).catch(() => [] as string[]);
    if (versions.length && !versions.includes(opts.mc)) {
      throw new Error(`${opts.loader} has no build for Minecraft ${opts.mc}`);
    }
    const mem = Math.min(12, Math.max(2, Math.round(opts.memGb ?? 6)));
    const port = await nextFreePort(); // never collide with an existing server
    const name = opts.name.trim().slice(0, 40) || `${opts.loader} ${opts.mc}`;

    job.status = `creating ${opts.loader} ${opts.mc} on port ${port}…`;
    const res = await craftyApi.createServer({
      name,
      roles: [],
      monitoring_type: 'minecraft_java',
      minecraft_java_monitoring_data: { host: '127.0.0.1', port },
      create_type: 'minecraft_java',
      minecraft_java_create_data: {
        create_type: 'download_jar',
        download_jar_create_data: {
          category: 'mc_java_servers',
          type: craftyType,
          version: opts.mc,
          mem_min: Math.max(1, Math.round(mem / 2)),
          mem_max: mem,
          server_properties_port: port,
        },
      },
    });
    const serverId = res.new_server_id ?? res.new_server_uuid;
    if (!serverId) throw new Error('Crafty did not return the new server id');
    job.serverId = serverId;

    // loader install (the Forge/NeoForge installers take a few minutes)
    job.status = `installing ${opts.loader} ${opts.mc}…`;
    const dir = join(PATHS.craftyServers, serverId);
    const deadline = Date.now() + 10 * 60_000;
    while (!loaderReady(dir, opts.loader)) {
      if (Date.now() > deadline) throw new Error(`${opts.loader} install did not finish within 10 min`);
      await pause(5000);
    }
    await pause(3000);

    job.status = 'applying EULA, Java and memory…';
    job.warnings = await finalizeServer(serverId, { mc: opts.mc, memGb: mem, loader: opts.loader, gamePort: port });

    job.status = 'setting up client auto-sync (AutoModpack)…';
    const { provisionAutoModpack } = await import('./automodpack.js');
    job.warnings.push(...(await provisionAutoModpack(serverId, opts.loader)));
    await chownToDirOwner(dir); // panel is root, the server is not — see platform.ts

    job.status = `"${name}" is ready, with ${mem} GB on port ${port}.`;
    job.done = true;
  })().catch((e) => {
    job.error = e instanceof Error ? e.message : String(e);
    job.done = true;
    job.status = 'failed';
  });

  return { jobId: id };
}

/** The shared build pipeline behind every "server from a pack" flow: Crafty
    builds the base server, `pour` installs the pack content, then the usual
    trap-closing (EULA/Java/heap) and AutoModpack. */
async function buildPackServer(
  job: CreateJob,
  meta: { loader: string; mc: string; title: string },
  opts: { name?: string; memGb?: number },
  pour: (serverId: string) => Promise<ModpackResult | { error: string }>,
): Promise<void> {
  const craftyType = CRAFTY_TYPE[meta.loader];
  if (!craftyType) throw new Error(`loader "${meta.loader}" is not supported by Crafty's installer`);
  const mem = Math.min(10, Math.max(2, Math.round(opts.memGb ?? 6)));
  const port = await nextFreePort();
  const name = (opts.name?.trim() || meta.title).slice(0, 40);

  // Crafty builds the base server (downloads jar / runs loader installer)
  job.status = `creating ${meta.loader} ${meta.mc} server "${name}" (port ${port})…`;
  const res = await craftyApi.createServer({
    name,
    roles: [],
    monitoring_type: 'minecraft_java',
    minecraft_java_monitoring_data: { host: '127.0.0.1', port },
    create_type: 'minecraft_java',
    minecraft_java_create_data: {
      create_type: 'download_jar',
      download_jar_create_data: {
        category: 'mc_java_servers',
        type: craftyType,
        version: meta.mc,
        mem_min: Math.max(1, mem - 2),
        mem_max: mem,
        server_properties_port: port,
      },
    },
  });
  const serverId = res.new_server_id ?? res.new_server_uuid;
  if (!serverId) throw new Error('Crafty did not return the new server id');
  job.serverId = serverId;

  // wait for the loader install (Forge installer can take a few minutes)
  job.status = `installing ${meta.loader} ${meta.mc} (Crafty is working)…`;
  const dir = serverDir(serverId);
  const deadline = Date.now() + 8 * 60_000;
  while (!loaderReady(dir, meta.loader)) {
    if (Date.now() > deadline) throw new Error(`${meta.loader} install did not finish within 8 min — check Crafty`);
    await pause(5000);
  }
  await pause(3000); // let file handles settle

  // pour the modpack in
  job.status = `installing modpack "${meta.title}" (downloads every mod — takes minutes)…`;
  const packRes = await pour(serverId);
  if ('error' in packRes) throw new Error(packRes.error);
  job.warnings = packRes.warnings;

  // same traps apply to a modpack server: EULA, java path/major, real heap
  job.status = 'applying EULA, Java and memory…';
  job.warnings.push(...(await finalizeServer(serverId, { mc: meta.mc, memGb: mem, loader: meta.loader, gamePort: port })));

  job.status = 'setting up client auto-sync (AutoModpack)…';
  const { provisionAutoModpack } = await import('./automodpack.js');
  job.warnings.push(...(await provisionAutoModpack(serverId, meta.loader)));
  await chownToDirOwner(dir); // panel is root, the server is not — see platform.ts

  job.status = `"${name}" is ready, with ${mem} GB on port ${port}. Its first boot takes a few minutes.`;
  job.done = true;
}

export function startCreateFromModpack(opts: {
  name?: string;
  projectId: string;
  versionId?: string;
  source: string;
  memGb?: number;
}): { jobId: string } {
  const native = loadSettings().runtime === 'standalone';
  const id = native ? randomUUID() : randomUUID().slice(0, 8);
  const job: CreateJob = {
    id, status: 'resolving pack…', done: false, error: null,
    serverId: null, packName: null, warnings: [],
  };
  jobs.set(id, job);

  (async () => {
    const meta = await resolvePack(opts.source, opts.projectId, opts.versionId);
    job.packName = meta.title;
    if (native) {
      await queueNativeInstall({ id, name: opts.name ?? meta.title, loader: meta.loader, mc: meta.mc, memGb: opts.memGb,
        pack: { source: opts.source === 'curseforge' ? 'curseforge' : 'modrinth', projectId: opts.projectId, versionId: meta.fileId } });
      return;
    }
    await buildPackServer(job, meta, opts, (serverId) =>
      opts.source === 'curseforge'
        ? installCurseforgeModpack(serverId, { modId: opts.projectId, fileId: meta.fileId })
        : installModpack(serverId, { projectId: opts.projectId, versionId: meta.fileId }),
    );
  })().catch((e) => {
    job.error = e instanceof Error ? e.message : String(e);
    job.done = true;
    job.status = 'failed';
  });

  return { jobId: id };
}

/** New server from a LOCAL pack file (a dropped .mrpack / CurseForge client
    zip). The pack's own index supplies loader+mc; the carrier file is removed
    on success. Inspection is synchronous so a non-pack file fails the click,
    not the background job. */
export function startCreateFromPackFile(opts: {
  path: string; // absolute, already confined to a server dir by the route
  name?: string;
  memGb?: number;
}): { jobId: string } | { error: string } {
  const info = inspectPackFile(opts.path);
  if (!info) return { error: 'that file is not a Modrinth .mrpack or CurseForge pack zip' };
  if (!info.loader || !CRAFTY_TYPE[info.loader]) {
    return { error: `pack loader "${info.loader ?? 'unknown'}" is not supported by the server installer` };
  }
  if (!info.mc) return { error: 'the pack does not state its Minecraft version' };

  const native = loadSettings().runtime === 'standalone';
  const id = native ? randomUUID() : randomUUID().slice(0, 8);
  const job: CreateJob = {
    id, status: 'reading the uploaded pack…', done: false, error: null,
    serverId: null, packName: info.name, warnings: [],
  };
  jobs.set(id, job);

  (async () => {
    if (native) {
      await queueNativeInstall({ id, name: opts.name ?? info.name, loader: info.loader!, mc: info.mc!, memGb: opts.memGb,
        pack: { source: 'file', kind: info.kind, path: opts.path, sha512: (await hashes(opts.path)).sha512 } });
      return;
    }
    await buildPackServer(job, { loader: info.loader!, mc: info.mc!, title: info.name }, opts, (serverId) =>
      info.kind === 'curseforge'
        ? installCurseforgeZipFile(serverId, opts.path)
        : installMrpackFile(serverId, opts.path),
    );
    // the dropped file was a carrier, its content now lives in the server
    try { rmSync(opts.path, { force: true }); } catch { /* leave it */ }
  })().catch((e) => {
    job.error = e instanceof Error ? e.message : String(e);
    job.done = true;
    job.status = 'failed';
  });

  return { jobId: id };
}

/** All jobs this panel run knows about, newest first — the Servers page shows
    in-progress creations globally, so a server never "just appears". */
export function listJobs(): CreateJob[] {
  const native = nativeInstallJobs();
  return [...[...jobs.values()].filter((j) => !native.some((n) => n.id === j.id)), ...native].reverse();
}
