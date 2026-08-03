import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { renameSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

const run = promisify(execFile);

// One switch for the whole codebase. The panel historically ran only on
// Windows (PowerShell, robocopy, taskkill, .exe java paths); every one of
// those calls now lives behind a helper here so the same build runs on the
// Linux box after the migration. The Windows branches are byte-identical to
// the pre-port code — nothing changes until the OS does.
export const IS_WIN = process.platform === 'win32';

/** True when something LISTENS on a local TCP port. */
export async function portListening(port: number): Promise<boolean> {
  if (IS_WIN) {
    const { stdout } = await run('powershell', [
      '-NoProfile', '-Command',
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count`,
    ]);
    return stdout.trim() !== '0';
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
  // rsync + zip come from the migration bootstrap (apt install rsync zip unzip)
  // rsync does not create the destination's parent dirs (robocopy does)
  await mkdir(stageWorld, { recursive: true });
  await run('nice', ['-n', '10', 'rsync', '-a', '--delete', '--exclude', 'session.lock', `${world}/`, `${stageWorld}/`]);
  await run('nice', ['-n', '10', 'zip', '-r', '-1', '-q', destZip, basename(stageWorld)], {
    cwd: dirname(stageWorld),
    maxBuffer: 10 * 1024 * 1024,
  });
  await run('rm', ['-rf', dirname(stageWorld)]);
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
  await run('zip', ['-r', '-1', '-q', destZip, basename(dir)], { cwd: dirname(dir), maxBuffer: 10 * 1024 * 1024 });
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
  await run('unzip', ['-o', '-q', zipPath, '-d', destDir], { maxBuffer: 10 * 1024 * 1024 });
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
    // the crafty-run server died on session.lock AccessDenied (live
    // 2026-07-21). Walk UP to the first ancestor with a different owner —
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
