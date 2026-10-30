import { randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nativeRoot, nativeRecord, nativeServers, supervisor } from './native.js';
import { writeFileAtomic } from './platform.js';
import { toolsJava } from './servers.js';
import { ensureJdk } from './temurin.js';
import { fetchRecipe, resolveRecipe, verifyInstalled, type Recipe, type RecipeLoader } from './recipes.js';
import { suggestGamePort, derivedRcon, portAudit, PANEL_PORT } from './ports.js';
import { packFiles, hashes } from './revisions.js';
import { setOverride } from './detect.js';
import type { CreateJob } from './servercreate.js';

export type NativePack = { source: 'file'; path: string; sha512: string; kind: 'mrpack' | 'curseforge' }
  | { source: 'modrinth' | 'curseforge'; projectId: string; versionId: string };
interface Install extends CreateJob {
  loader: RecipeLoader;
  mc: string;
  /** Resolved once at queue time, so every retry installs the same bytes. */
  recipe?: Recipe;
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
export async function queueNativeInstall(opts: { id?: string; name: string; loader: string; mc: string; memGb?: number; port?: number; pack?: NativePack }): Promise<{ jobId: string }> {
  const recipe = await resolveRecipe(opts.loader, opts.mc);
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
    packName: opts.name.trim().slice(0, 40) || `${opts.loader} ${opts.mc}`, warnings: [...recipe.notes], loader: recipe.loader, mc: opts.mc, recipe,
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
      job.phase = 'done'; job.status = `${job.packName} is ready on port ${job.port}.`; job.done = true; save(job);
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
      // Jobs queued before per-version recipes named no exact bytes; today's
      // upstream build would be a different install, so they must be requeued.
      const recipe = job.recipe;
      if (!recipe) throw new Error('this installation was queued before exact recipes; delete it and create the server again');
      job.status = `installing ${job.loader} ${recipe.build} for Minecraft ${job.mc} in disposable staging`;
      job.port ??= await suggestGamePort();
      if (!Number.isInteger(job.port) || job.port < 1024 || derivedRcon(job.port) > 65535) throw new Error('invalid game/RCON port pair');
      const audit = await portAudit();
      if (job.port === PANEL_PORT || audit.rows.some((r) => [r.gamePort, r.rconPort].some((p) => p === job.port || p === derivedRcon(job.port!)))) throw new Error('requested game/RCON port pair is already reserved');
      save(job);
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      if (!await ensureJdk(recipe.java, () => {})) throw new Error(`could not install Java ${recipe.java}`);
      const java = toolsJava(recipe.java);
      if (!java) throw new Error(`Tools Java ${recipe.java} is unavailable`);
      const file = recipe.download.file;
      writeFileSync(join(staging, file), await fetchRecipe(recipe));
      writeFileSync(join(staging, 'eula.txt'), 'eula=false');
      const log = join(jobDir, `${id}.log`);
      const run = (args: string[], completed: (output: string, code: number | null) => boolean) => new Promise<void>((resolve, reject) => {
        const child = spawn(java, args, { cwd: staging, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        const data = (b: Buffer): void => { output = (output + b.toString()).slice(-2 * 1024 * 1024); };
        child.stdout.on('data', data); child.stderr.on('data', data);
        child.once('error', reject);
        child.once('close', (code) => {
          writeFileAtomic(log, output);
          if (completed(output, code)) resolve();
          else reject(new Error(`loader install failed with exit ${code}; inspect ${log}`));
        });
      });
      // Fabric's launcher fetches its libraries and the Mojang jar before the
      // EULA check. Paper, Purpur and Vanilla jars are the server already.
      if (job.loader === 'fabric') await run(['-Xmx768M', '-jar', file, 'nogui'], (output) => /You need to agree to the EULA/.test(output));
      else if (job.loader === 'quilt') await run(['-Xmx768M', '-jar', file, 'install', 'server', job.mc, recipe.build, '--download-server', `--install-dir=${staging}`], (_, code) => code === 0);
      else if (job.loader === 'forge' || job.loader === 'neoforge') await run(['-Xmx1G', '-jar', file, '--installServer'], (_, code) => code === 0);
      await verifyInstalled(staging, recipe);
      const quotedJava = JSON.stringify(java.replaceAll('\\', '/'));
      let executable: string, command: string;
      if ('argDir' in recipe.launch) {
        executable = `${recipe.launch.argDir}/${process.platform === 'win32' ? 'win' : 'unix'}_args.txt`;
        if (!existsSync(join(staging, executable))) throw new Error(`installer did not produce ${executable}`);
        writeFileSync(join(staging, 'user_jvm_args.txt'), `-Xms1G\n-Xmx${job.memGb}G\n`);
        command = `${quotedJava} @user_jvm_args.txt @${executable} nogui`;
      } else {
        // Legacy Forge installers name their launch jar after the build.
        const produced = 'forgeJar' in recipe.launch ? readdirSync(staging).filter((f) => /forge.*\.jar$/i.test(f) && f !== file) : [recipe.launch.jar];
        if (produced.length !== 1 || !existsSync(join(staging, produced[0]))) throw new Error('installer did not produce exactly one launch jar');
        executable = produced[0];
        command = `${quotedJava} -Xms1G -Xmx${job.memGb}G -jar ${executable} nogui`;
      }
      if (file !== executable) rmSync(join(staging, file));
      writeFileSync(join(staging, 'eula.txt'), 'eula=true');
      writeFileSync(join(staging, 'server.properties'), `server-port=${job.port}\nenable-rcon=true\nrcon.port=${derivedRcon(job.port!)}\nrcon.password=${randomBytes(24).toString('hex')}\nbroadcast-rcon-to-ops=false\n`);
      // Persist the recipe before its visibility commit. If rename succeeded
      // before owner death, recover only this exact unregistered UUID directory.
      const server = { server_id: id, server_name: job.packName, type: 'minecraft_java', server_ip: '127.0.0.1',
        server_port: job.port, path: dest, executable, execution_command: command, auto_start: false };
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
