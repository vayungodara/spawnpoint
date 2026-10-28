import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../config.js';
import { craftyApi, type CraftyServer } from '../clients/crafty.js';
import { detect, type Detection } from './detect.js';

export interface ServerInfo {
  id: string;
  name: string;
  port: number;
  path: string;
  active: boolean;
  detection: Detection;
}

export function getActiveUuid(): string | null {
  if (!existsSync(PATHS.activeServerFile)) return null;
  const v = readFileSync(PATHS.activeServerFile, 'utf8').trim();
  return v.length > 0 ? v : null;
}

export function setActiveUuid(uuid: string): void {
  writeFileSync(PATHS.activeServerFile, uuid, 'ascii');
}

const SERVER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isServerId = (id: string): boolean => SERVER_ID.test(id);

/** A server's folder on this machine: the path Crafty reports when it exists
    here (a native Crafty install), otherwise <layout>/Crafty/servers/<uuid>
    (Crafty in Docker with that folder mounted). Throws on anything that is
    not a server id, so no caller can build a path from untrusted input. */
export function serverDir(uuid: string): string {
  if (!SERVER_ID.test(uuid)) throw new Error('not a server id');
  const reported = craftyApi.reportedPath(uuid);
  return reported && existsSync(reported) ? reported : join(PATHS.craftyServers, uuid);
}

/** Client-only mods live outside the server folder, so the server can never load them. */
export function clientShelfDir(uuid: string): string {
  if (!SERVER_ID.test(uuid)) throw new Error('not a server id');
  return join(PATHS.data, 'clientmods', uuid);
}

/** The JDK a server should launch with, or null if none is installed.
    The MC version sets the minimum Java and the loader the maximum: Forge
    and NeoForge stay on 21 (their coremods break on newer JDKs), while
    everything else takes the newest JDK, because modern plugins often
    require Java 25. JDKs live under Tools/ in space-free paths: Crafty does
    not quote the launch command, so a space splits the java path. */
export function javaFor(mc: string | null, loader?: string | null): string | null {
  const major = mc ? parseInt(mc.split('.')[0], 10) : NaN;
  const toolsDir = join(PATHS.root, 'Tools');
  if (!existsSync(toolsDir)) return null;
  const jdks = readdirSync(toolsDir).filter((d) => d.startsWith('jdk-'));
  const pick = (prefix: string) => {
    const d = jdks.find((x) => x.startsWith(prefix));
    const p = d ? join(toolsDir, d, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : null;
    return p && existsSync(p) ? p : null;
  };
  const java25 = pick('jdk-25');
  const java21 = pick('jdk-21');

  // MC 26+ needs Java 25 regardless of loader
  if (!isNaN(major) && major >= 26) return java25 ?? java21;

  // 1.x: Forge/NeoForge must stay on 21; everything else takes the newest.
  const fragile = loader === 'forge' || loader === 'neoforge';
  if (fragile) return java21 ?? java25;

  // 1.20.4 and older predate Java 21 support in some loaders — keep those on 21
  // too; 1.20.5+ and 1.21+ are happy on 25 and their plugins often demand it.
  const [, min = 0, pat = 0] = (mc ?? '').split('.').map((n) => parseInt(n, 10) || 0);
  const modernEnough = major === 1 && (min > 20 || (min === 20 && pat >= 5));
  return modernEnough ? java25 ?? java21 : java21 ?? java25;
}

/** Rewrite a launch command's java to `exe`. Handles a bare `java` and a
    previously-written absolute jdk path that is now the wrong major. Returns
    null when the command already runs the right java (no change needed). */
function rewriteJava(cur: string, exe: string): string | null {
  // a bare `java` may not resolve under Crafty's service account
  const bare = /^"?java(\.exe)?"?\s/.test(cur);
  // a Tools/ JDK the panel wrote earlier that is now the wrong major
  const currentPath = /^"([^"]*[\\/]bin[\\/]java(?:\.exe)?)"/.exec(cur)?.[1];
  const wrongMajor = !!currentPath && currentPath.toLowerCase() !== exe.toLowerCase() && /[\\/]Tools[\\/]jdk-/i.test(currentPath);
  if (!bare && !wrongMajor) return null;
  return bare
    ? cur.replace(/^"?java(\.exe)?"?/, `"${exe}"`)
    : cur.replace(/^"[^"]*[\\/]bin[\\/]java(?:\.exe)?"/, `"${exe}"`);
}

/** Point the server's launch command at the right JDK for its MC version and
    loader. Only when Crafty sees the same paths as the panel (a native
    install): a Crafty container cannot run a JDK path from the host. Returns
    true when the command changed. */
export async function pinJavaFor(id: string, mc: string | null, loader?: string | null): Promise<boolean> {
  const exe = javaFor(mc, loader);
  if (!exe || craftyApi.reportedPath(id) !== serverDir(id)) return false;
  const s = await craftyApi.getServer(id).catch(() => null);
  const cmd = s && rewriteJava(s.execution_command, exe);
  if (!cmd) return false;
  await craftyApi.patchServer(id, { execution_command: cmd });
  return true;
}

export async function listServers(): Promise<ServerInfo[]> {
  const servers = await craftyApi.listServers();
  const active = getActiveUuid();
  return servers.map((s: CraftyServer) => {
    const dir = serverDir(s.server_id);
    return {
      id: s.server_id,
      name: s.server_name,
      port: s.server_port,
      path: dir,
      active: s.server_id === active,
      detection: existsSync(dir) ? detect(dir, s.server_id) : { loader: 'unknown' as const, mc: null },
    };
  });
}

export async function resolveByName(name: string): Promise<string | null> {
  const servers = await craftyApi.listServers();
  const hit = servers.find((s) => s.server_name.toLowerCase() === name.toLowerCase());
  return hit?.server_id ?? null;
}
