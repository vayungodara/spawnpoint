import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nativeRoot, nativeRecord, nativeServers, supervisor } from './native.js';
import { writeFileAtomic } from './platform.js';
import { javaFor } from './servers.js';
import { ensureJdk } from './temurin.js';
import { suggestGamePort, derivedRcon, portAudit, PANEL_PORT } from './ports.js';
import { packFiles, hashes } from './revisions.js';
import { setOverride } from './detect.js';
import type { CreateJob } from './servercreate.js';

// This MVP declares its supported recipes rather than silently taking latest.
export const NATIVE_RECIPES = {
  fabric: { mc: '1.21.1', loader: '0.20.1', url: 'https://meta.fabricmc.net/v2/versions/loader/1.21.1/0.20.1/1.1.1/server/jar',
    sha512: 'd0056f4ce05f4911f5bfd1a94248a9dbcf7147a3e697bc156195824ffe02bb27c1abb3bef42e079d68ff9efde388ad4186def37e03aba01a87b764717e164dee' },
  forge: { mc: '1.20.1', loader: '47.4.28', url: 'https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.4.28/forge-1.20.1-47.4.28-installer.jar',
    sha512: '8fd435b269ea75a97340127ab9f745410595ce70e52c39fe1aa70ad00419ae8c4580049d6538c3a24adf9bfc6bc2b42026f2a4cca33015f9f3c5bb8152c1fd35' },
  neoforge: { mc: '1.21.1', loader: '21.1.219', url: 'https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.219/neoforge-21.1.219-installer.jar',
    sha512: '62b047d95ced148e6b1df0dbb21d16803d1c87090ac4f7e8c8f2be3f46a1b9f74a71db6b1e519aa0c7a0991bb97d5a1f3a8f2df81c06505808b00c7b12bbccc3' },
} as const;
export type NativePack = { source: 'file'; path: string; sha512: string; kind: 'mrpack' | 'curseforge' }
  | { source: 'modrinth' | 'curseforge'; projectId: string; versionId: string };
interface Install extends CreateJob {
  loader: keyof typeof NATIVE_RECIPES;
  mc: string;
  memGb: number;
  port?: number;
  attempts: number;
  configureAttempts?: number;
  pack?: NativePack;
  phase: 'queued' | 'installing' | 'installed' | 'configuring' | 'done' | 'failed';
}
const jobDir = join(nativeRoot, 'installs');
const file = (id: string): string => {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('invalid install id');
  return join(jobDir, `${id}.json`);
};
function save(job: Install): void { writeFileAtomic(file(job.id), JSON.stringify(job)); }
export function nativeInstallJob(id: string): Install | undefined {
  if (!/^[0-9a-f-]{36}$/.test(id) || !existsSync(file(id))) return undefined;
  return JSON.parse(readFileSync(file(id), 'utf8')) as Install;
}
export function nativeInstallJobs(): Install[] {
  return existsSync(jobDir) ? readdirSync(jobDir).filter((f) => /^[0-9a-f-]{36}\.json$/.test(f)).map((f) => nativeInstallJob(f.slice(0, -5))!) : [];
}
export function queueNativeInstall(opts: { id?: string; name: string; loader: string; mc: string; memGb?: number; port?: number; pack?: NativePack }): { jobId: string } {
  const recipe = NATIVE_RECIPES[opts.loader as keyof typeof NATIVE_RECIPES];
  if (!recipe || opts.mc !== recipe.mc) throw new Error('Standalone supports Fabric 1.21.1 / 0.20.1, Forge 1.20.1 / 47.4.28, and NeoForge 1.21.1 / 21.1.219');
  const id = opts.id ?? randomUUID();
  if (nativeInstallJob(id)) throw new Error('installation is already queued');
  let pack = opts.pack;
  if (pack?.source === 'file') {
    mkdirSync(jobDir, { recursive: true });
    const path = join(jobDir, `${id}.pack`);
    copyFileSync(pack.path, path);
    pack = { ...pack, path };
  }
  save({ id, serverId: id, status: 'queued for the independent installer', done: false, error: null,
    packName: opts.name.trim().slice(0, 40) || `${opts.loader} ${opts.mc}`, warnings: [], loader: opts.loader as Install['loader'], mc: opts.mc,
    memGb: Math.max(2, Math.min(12, Math.round(opts.memGb ?? 2))), port: opts.port, attempts: 0, phase: 'queued', pack });
  return { jobId: id };
}

let configuring = false;
/** Only the panel writes shared install/detection metadata. Independent
    workers install opaque loaders; the durable job fences starts until the
    panel has poured the whole modpack and finished auto-sync provisioning. */
export async function finishNativeInstalls(log: (message: string) => void): Promise<void> {
  if (configuring) return;
  configuring = true;
  try {
    const job = nativeInstallJobs().find((j) => j.phase === 'installed' || j.phase === 'configuring');
    if (!job) return;
    try {
      if ((job.configureAttempts = (job.configureAttempts ?? 0) + 1) > 3) throw new Error('three configuration attempts exhausted; inspect this stopped installation');
      job.phase = 'configuring'; job.status = 'configuring the complete pack and client sync'; save(job);
      setOverride(job.id, { loader: job.loader, mc: job.mc });
      if (job.pack) {
        const pack = job.pack;
        const { installModpack, installCurseforgeModpack, installMrpackFile, installCurseforgeZipFile } = await import('./modpack.js');
        if (pack.source === 'file' && (await hashes(pack.path)).sha512 !== pack.sha512) throw new Error('queued modpack bytes changed');
        const result = pack.source === 'file'
          ? await (pack.kind === 'mrpack' ? installMrpackFile(job.id, pack.path) : installCurseforgeZipFile(job.id, pack.path))
          : pack.source === 'modrinth' ? await installModpack(job.id, { projectId: pack.projectId, versionId: pack.versionId })
            : await installCurseforgeModpack(job.id, { modId: pack.projectId, fileId: pack.versionId });
        if ('error' in result) throw new Error(result.error);
        job.warnings = result.warnings;
      }
      const { finalizeServer } = await import('./servercreate.js');
      job.warnings.push(...await finalizeServer(job.id, { mc: job.mc, loader: job.loader, memGb: job.memGb, gamePort: job.port }));
      const { provisionAutoModpack } = await import('./automodpack.js');
      job.warnings.push(...await provisionAutoModpack(job.id, job.loader));
      job.phase = 'done'; job.status = `done — ${job.packName} is ready on port ${job.port}. Press Start.`; job.done = true; save(job);
    } catch (error) {
      job.phase = 'failed'; job.status = 'failed'; job.error = String(error); job.done = true; save(job);
      log(`native installation ${job.id}: ${job.error}`);
    }
  } catch (error) { log(`native installation recovery: ${String(error)}`); }
  finally { configuring = false; }
}

async function install(id: string): Promise<void> {
  const job = nativeInstallJob(id)!;
  if (!job || job.done) return;
  const dest = join(nativeServers, id), staging = join(nativeRoot, 'installing', id);
  const prepared = join(jobDir, `${id}.prepared.json`);
  const inventory = async (dir: string) => {
    const rows = [];
    for (const path of packFiles(dir)) rows.push({ path: relative(dir, path).replaceAll('\\', '/'), ...await hashes(path) });
    return rows;
  };
  try {
    if (!nativeRecord(id) && existsSync(dest)) {
      const sealed = JSON.parse(readFileSync(prepared, 'utf8')) as { server: unknown; files: Awaited<ReturnType<typeof inventory>> };
      if (JSON.stringify(await inventory(dest)) !== JSON.stringify(sealed.files)) throw new Error('interrupted installation bytes changed; inspect the unregistered directory');
      await supervisor('register', { server: sealed.server });
    }
    if (!nativeRecord(id)) {
      if (++job.attempts > 3) throw new Error('three installer attempts exhausted; inspect the installer log');
      // Only the owner service calls this after its previous installer tree
      // has exited. A retry never overlays a registered directory or world.
      job.phase = 'installing';
      job.status = 'installing the pinned loader in disposable staging';
      job.port ??= await suggestGamePort();
      if (!Number.isInteger(job.port) || job.port < 1024 || derivedRcon(job.port) > 65535) throw new Error('invalid game/RCON port pair');
      const audit = await portAudit();
      if (job.port === PANEL_PORT || audit.rows.some((r) => [r.gamePort, r.rconPort].some((p) => p === job.port || p === derivedRcon(job.port!)))) throw new Error('requested game/RCON port pair is already reserved');
      save(job);
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      if (!await ensureJdk(job.loader === 'fabric' ? 25 : 21, () => {})) throw new Error('could not install the pinned Java major');
      const java = javaFor(job.mc, job.loader);
      if (!java) throw new Error('Tools Java is unavailable');
      const recipe = NATIVE_RECIPES[job.loader];
      const response = await fetch(recipe.url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`installer download failed: ${response.status}`);
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body!) {
        if ((size += chunk.length) > 32 * 1024 * 1024) throw new Error('installer exceeds 32 MB limit');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (createHash('sha512').update(bytes).digest('hex') !== recipe.sha512) throw new Error('pinned installer hash mismatch');
      const jar = job.loader === 'fabric' ? 'fabric.jar' : 'installer.jar';
      writeFileSync(join(staging, jar), bytes);
      writeFileSync(join(staging, 'eula.txt'), 'eula=false');
      const args = job.loader === 'fabric' ? ['-Xmx768M', '-jar', jar, 'nogui'] : ['-Xmx1G', '-jar', jar, '--installServer'];
      const log = join(jobDir, `${id}.log`);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(java, args, { cwd: staging, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        const data = (b: Buffer): void => { output = (output + b.toString()).slice(-2 * 1024 * 1024); };
        child.stdout.on('data', data); child.stderr.on('data', data);
        child.once('error', reject);
        child.once('close', (code) => {
          writeFileAtomic(log, output);
          const completed = job.loader === 'fabric' ? /You need to agree to the EULA/.test(output) : code === 0;
          if (completed) resolve();
          else reject(new Error(`loader install failed with exit ${code}; inspect ${log}`));
        });
      });
      const argfile = job.loader === 'forge' ? `libraries/net/minecraftforge/forge/${job.mc}-${recipe.loader}/${process.platform === 'win32' ? 'win' : 'unix'}_args.txt`
        : `libraries/net/neoforged/neoforge/${recipe.loader}/${process.platform === 'win32' ? 'win' : 'unix'}_args.txt`;
      if (!existsSync(join(staging, job.loader === 'fabric' ? 'fabric.jar' : argfile))) throw new Error('installer did not produce the pinned recipe');
      const quotedJava = JSON.stringify(java.replaceAll('\\', '/'));
      let command: string;
      if (job.loader === 'fabric') command = `${quotedJava} -Xms1G -Xmx${job.memGb}G -jar fabric.jar nogui`;
      else {
        writeFileSync(join(staging, 'user_jvm_args.txt'), `-Xms1G\n-Xmx${job.memGb}G\n`);
        command = `${quotedJava} @user_jvm_args.txt @${argfile} nogui`;
        rmSync(join(staging, jar));
      }
      writeFileSync(join(staging, 'eula.txt'), 'eula=true');
      writeFileSync(join(staging, 'server.properties'), `server-port=${job.port}\nenable-rcon=true\nrcon.port=${derivedRcon(job.port!)}\nrcon.password=${randomBytes(24).toString('hex')}\nbroadcast-rcon-to-ops=false\n`);
      // Persist the recipe before its visibility commit. If rename succeeded
      // before owner death, recover only this exact unregistered UUID directory.
      const server = { server_id: id, server_name: job.packName, type: 'minecraft_java', server_ip: '127.0.0.1',
        server_port: job.port, path: dest, executable: job.loader === 'fabric' ? 'fabric.jar' : argfile, execution_command: command, auto_start: false };
      writeFileAtomic(prepared, JSON.stringify({ server, files: await inventory(staging) }));
      if (existsSync(dest)) throw new Error('unregistered destination exists; inspect it before retrying installation');
      mkdirSync(nativeServers, { recursive: true });
      renameSync(staging, dest);
      await supervisor('register', { server });
    }
    job.phase = 'installed'; job.status = 'loader installed; waiting for panel configuration'; save(job);
  } catch (error) {
    job.phase = 'failed'; job.status = 'failed'; job.error = String(error); job.done = true; save(job);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await install(process.argv[2]);
