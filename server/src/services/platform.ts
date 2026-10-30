import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { renameSync, statSync, copyFileSync, constants, unlinkSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { freemem } from 'node:os';
import { cp, rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

const run = promisify(execFile);

// Every OS-specific call (PowerShell, robocopy, taskkill, .exe java paths on
// Windows; coreutils on Linux and macOS) lives behind a helper here, so the
// rest of the panel is platform-neutral.
export const IS_WIN = process.platform === 'win32';

/** Replace a file in one rename, so a crash leaves the old file or the new
    one, never half of one. Concurrent writers each get a private part file. */
export function writeFileAtomic(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const part = `${path}.${randomBytes(4).toString('hex')}.part`;
  writeFileSync(part, data);
  renameSync(part, path);
}

/** Bytes macOS can hand out without compressing or swapping anything, from
    vm_stat output: free pages plus file-backed cache, which includes
    read-ahead pages. Inactive pages are not counted: they include idle
    application memory, such as a live server's heap. os.freemem() counts
    free pages only, which macOS keeps low by caching, so a Mac with
    gigabytes of cache looked full. */
export function vmStatAvailableBytes(text: string): number | null {
  const page = /page size of (\d+) bytes/.exec(text)?.[1];
  const pages = ['Pages free', 'File-backed pages'].map((label) => new RegExp(`^${label}:\\s+(\\d+)\\.$`, 'm').exec(text)?.[1]);
  if (!page || pages.some((n) => n === undefined)) return null;
  return pages.reduce((sum, n) => sum + Number(n), 0) * Number(page);
}

/** Memory the OS can hand out now, counting reclaimable cache: Linux
    MemAvailable, macOS vm_stat, Windows available physical memory. */
async function availableGb(): Promise<number> {
  if (process.platform === 'linux') {
    try {
      const kb = /MemAvailable:\s+(\d+) kB/.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1];
      if (kb) return Number(kb) / 1024 / 1024;
    } catch { /* fall back */ }
  }
  if (process.platform === 'darwin') {
    try {
      const bytes = vmStatAvailableBytes((await run('/usr/bin/vm_stat', [], { timeout: 5_000 })).stdout);
      if (bytes !== null) return bytes / 1024 ** 3;
    } catch { /* fall back */ }
  }
  return freemem() / 1024 ** 3;
}

/** memory promised to test JVMs that are running (they may not have taken it yet) */
let reservedGb = 0;

/** Run a test JVM once the OS can spare `needGb` beyond what other running
    tests were promised, and keep it promised until `fn` settles: a test short
    of memory gets the live server or the panel OOM-killed (seen on a 4 GB
    box). After 10 minutes without room, returns why instead of running. */
export async function withMemory<T>(needGb: number, what: string, onStatus: (d: string) => void, fn: () => Promise<T>): Promise<T | string> {
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const free = await availableGb() - reservedGb;
    if (free >= needGb) break;
    const why = `${what} needs about ${needGb} GB of free memory and ${Math.max(0, free).toFixed(1)} GB is free`;
    if (Date.now() > deadline) return why;
    onStatus(`waiting for memory: ${why}`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
  reservedGb += needGb;
  try {
    return await fn();
  } finally {
    reservedGb -= needGb;
  }
}

/** True when something LISTENS on a local TCP port. */
export async function portListening(port: number): Promise<boolean> {
  if (IS_WIN) {
    const { stdout } = await run('powershell', [
      '-NoProfile', '-Command',
      `$ErrorActionPreference='Stop'; ([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object Port -eq ${port} | Measure-Object).Count`,
    ]);
    if (!/^\d+$/.test(stdout.trim())) throw new Error('could not inspect TCP listeners');
    return Number(stdout.trim()) > 0;
  }
  if (process.platform === 'darwin') {
    const { stdout } = await run('netstat', ['-an', '-p', 'tcp']);
    return stdout.split('\n').some((line) => /\sLISTEN\s*$/.test(line) && new RegExp(`^[^\\n]*\\s\\S+\\.${port}\\s`).test(line));
  }
  // iproute2 ships on every Ubuntu/Debian install; -H drops the header so
  // any output at all means a listener exists
  const { stdout } = await run('ss', ['-ltnH', `sport = :${port}`]);
  return stdout.trim().length > 0;
}

/** Move a directory (same volume — server dir shuffles only). */
export async function moveDir(src: string, dest: string): Promise<void> {
  if (IS_WIN) {
    await run('powershell', ['-NoProfile', '-Command', `Move-Item '${src}' '${dest}'`]);
    return;
  }
  renameSync(src, dest);
}

/** Mirror `world` into a staging dir (skipping session.lock, which the running
    server holds exclusively), zip the stage at low priority, remove the stage.
    The archive root is the world folder's own name. */
export async function stageAndZipWorld(world: string, stageWorld: string, destZip: string): Promise<void> {
  if (IS_WIN) {
    // Fastest compression: region files are already zlib-compressed internally,
    // Optimal only wastes CPU. BelowNormal priority keeps the game lag-free.
    const script = `
      $ErrorActionPreference = 'Stop'
      (Get-Process -Id $PID).PriorityClass = 'BelowNormal'
      robocopy '${world}' '${stageWorld}' /MIR /XF session.lock /R:1 /W:1 /NFL /NDL /NJH /NJS | Out-Null
      if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
      Compress-Archive -Path '${stageWorld}' -DestinationPath '${destZip}' -CompressionLevel Fastest
      Remove-Item '${dirname(stageWorld)}' -Recurse -Force
    `;
    await run('powershell', ['-NoProfile', '-Command', script], { maxBuffer: 10 * 1024 * 1024 });
    return;
  }
  await rm(stageWorld, { recursive: true, force: true });
  await cp(world, stageWorld, { recursive: true, filter: (src) => basename(src) !== 'session.lock' });
  try {
    await zipTool(() => run('nice', ['-n', '10', 'zip', '-r', '-1', '-q', destZip, basename(stageWorld)], {
      cwd: dirname(stageWorld),
      maxBuffer: 10 * 1024 * 1024,
    }));
  } finally {
    await rm(dirname(stageWorld), { recursive: true, force: true });
  }
}

/** Run a zip/unzip command, naming the missing package if it is not installed. */
async function zipTool<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { code?: unknown; stderr?: string };
    if (err.code === 'ENOENT' || err.code === 127 || /No such file or directory/.test(err.stderr ?? '')) {
      throw new Error('backups need the zip and unzip commands; install them (sudo apt install zip unzip) and try again');
    }
    throw e;
  }
}

/** Zip a directory in place; archive root = the directory's own name
    (matches Compress-Archive -Path semantics). */
export async function zipDir(dir: string, destZip: string): Promise<void> {
  if (IS_WIN) {
    await run('powershell', [
      '-NoProfile', '-Command',
      `Compress-Archive -Path '${dir}' -DestinationPath '${destZip}' -CompressionLevel Fastest`,
    ], { maxBuffer: 10 * 1024 * 1024 });
    return;
  }
  await zipTool(() => run('zip', ['-r', '-1', '-q', destZip, basename(dir)], { cwd: dirname(dir), maxBuffer: 10 * 1024 * 1024 }));
}

/** Extract a zip into destDir, overwriting (Expand-Archive -Force semantics). */
export async function unzipTo(zipPath: string, destDir: string): Promise<void> {
  if (IS_WIN) {
    await run('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ], { maxBuffer: 10 * 1024 * 1024 });
    return;
  }
  await zipTool(() => run('unzip', ['-o', '-q', zipPath, '-d', destDir], { maxBuffer: 10 * 1024 * 1024 }));
  await chownToDirOwner(destDir);
}

/** The panel runs as root but the Minecraft servers run as the crafty user.
    ANY file the panel writes into a server dir must take the dir's owner, or
    the server can't touch its own files. This has bitten twice for real: a
    root-owned 600 level.dat after a restore (server exited 0, silently), and
    root-owned config/ from a modpack install (FO's config mod crashed boot).
    Call this after every panel write into a server dir. No-op on Windows and
    when the panel already runs as the dir's owner. */
export async function chownToDirOwner(destDir: string): Promise<void> {
  if (IS_WIN) return;
  try {
    const me = typeof process.getuid === 'function' ? process.getuid() : null;
    if (me === null) return;
    let { uid, gid } = statSync(destDir);
    if (uid !== me) {
      // dir already belongs to someone else (the server user) — hand them
      // whatever the panel just wrote inside it
      await run('chown', ['-R', `${uid}:${gid}`, destDir]);
      return;
    }
    // the panel owns destDir — which means the panel probably just CREATED it
    // (mkdirSync recursive), and statting it learns nothing. The old code
    // stopped here as "already correct" and left root-owned dirs behind: a
    // fresh world/datapacks after a world reset kept world/ root-owned and
    // the crafty-run server died on session.lock AccessDenied. Walk UP to the first ancestor with a different owner —
    // the tree's real owner — and chown from the TOPMOST dir the panel owns,
    // so freshly-created intermediates (world/ itself) are fixed too.
    let top = destDir;
    let parent = dirname(top);
    while (parent !== top) {
      ({ uid, gid } = statSync(parent));
      if (uid !== me) {
        await run('chown', ['-R', `${uid}:${gid}`, top]);
        return;
      }
      top = parent;
      parent = dirname(top);
    }
    // reached filesystem root with everything panel-owned (dev machine) — fine
  } catch { /* never fail the caller over ownership */ }
}

/** A private copy, using a reflink where supported. Test JVMs and updaters
    must never be able to write through a hardlink into live or sealed inputs. */
export function linkOrCopy(src: string, dst: string): void {
  copyFileSync(src, dst, constants.COPYFILE_FICLONE);
}

/** rename(), falling back to copy-and-delete across filesystems. */
export function moveFile(src: string, dst: string): void {
  try {
    renameSync(src, dst);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    // across filesystems: never leave a half-copied file at dst
    copyFileSync(src, `${dst}.part`);
    renameSync(`${dst}.part`, dst);
    unlinkSync(src);
  }
}

/** Kill a spawned child AND its whole process tree. On Windows, spawn's own
    `timeout`/kill() only signals the cmd.exe wrapper and the real grandchild
    lives on — taskkill /T tears down the tree. On Linux the caller must have
    spawned with `detached: true` so the child owns a process group we can
    signal as a unit. */
export function killTree(pid: number): void {
  if (IS_WIN) {
    spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL'); // negative pid = the whole process group
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

/** Options for spawning a child whose tree killTree() can later reap. */
export const KILLABLE_SPAWN_OPTS = IS_WIN ? { windowsHide: true } : { detached: true };
