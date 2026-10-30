import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../config.js';
import { craftyApi, type CraftyServer } from '../clients/crafty.js';
import { detect, type Detection } from './detect.js';
import { nativeRecord, transferRecord } from './native.js';
import { jdkFeatureFor, jdkPrefix, type JdkFeature } from './temurin.js';

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
  mkdirSync(PATHS.shared, { recursive: true });
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
  const owned = nativeRecord(uuid);
  if (owned) {
    if (!existsSync(owned.path)) throw new Error('the native server directory is missing; recovery required');
    return owned.path;
  }
  const transfer = transferRecord(uuid);
  if (transfer) {
    const path = transfer.phase === 'committing' && existsSync(transfer.destination) ? transfer.destination : transfer.path;
    if (!existsSync(path)) throw new Error('the transferring server directory is missing; recovery required');
    return path;
  }
  const reported = craftyApi.reportedPath(uuid);
  return reported && existsSync(reported) ? reported : join(PATHS.craftyServers, uuid);
}

/** Client-only mods live outside the server folder, so the server can never load them. */
export function clientShelfDir(uuid: string): string {
  if (!SERVER_ID.test(uuid)) throw new Error('not a server id');
  return join(PATHS.data, 'clientmods', uuid);
}

/** The JDK a server should launch with, or null if none is installed.
    jdkFeatureFor() owns the major. Java 21 and 25 stand in for each other
    as before; a Java 8 or 17 recipe has no safe substitute. JDKs live under
    Tools/ in space-free paths: Crafty does not quote the launch command, so
    a space splits the java path. */
export function javaFor(mc: string | null, loader?: string | null): string | null {
  const feature = jdkFeatureFor(mc, loader);
  return toolsJava(feature) ?? (feature === 25 ? toolsJava(21) : feature === 21 ? toolsJava(25) : null);
}

/** The Tools JDK of exactly this feature version, or null. */
export function toolsJava(feature: JdkFeature): string | null {
  const toolsDir = join(PATHS.root, 'Tools');
  const d = existsSync(toolsDir) ? readdirSync(toolsDir).find((x) => x.startsWith(jdkPrefix(feature))) : undefined;
  const p = d ? join(toolsDir, d, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : null;
  return p && existsSync(p) ? p : null;
}

/** Whether a Java major can run this server at all: at least the major
    Mojang declares, and FML coremods break past 21 before Minecraft 26. */
function javaRuns(java: number, mc: string | null, loader?: string | null): boolean {
  const [major, minor = 0, patch = 0] = (mc ?? '').split('.').map((n) => parseInt(n, 10));
  const modern = major >= 26;
  const minimum = modern ? 25 : major !== 1 ? 8 : minor < 17 ? 8 : minor < 18 ? 16 : minor < 20 || (minor === 20 && patch < 5) ? 17 : 21;
  return java >= minimum && !((loader === 'forge' || loader === 'neoforge') && java > (modern ? 25 : 21));
}

/** Rewrite a launch command's java to `exe`. Handles a bare `java` and a
    Tools JDK that cannot run this version. A working pin is left alone even
    when a new server would default to another major. Returns null when no
    change is needed. */
export function rewriteJava(cur: string, exe: string, mc: string | null, loader?: string | null): string | null {
  // a bare `java` may not resolve under Crafty's service account
  const bare = /^"?java(\.exe)?"?\s/.test(cur);
  // a Tools/ JDK the panel wrote earlier that is now the wrong major
  const currentPath = /^"([^"]*[\\/]bin[\\/]java(?:\.exe)?)"/.exec(cur)?.[1];
  const pinned = Number(/[\\/]Tools[\\/]jdk-(\d+)/i.exec(currentPath ?? '')?.[1]);
  const wrongMajor = !!currentPath && currentPath.toLowerCase() !== exe.toLowerCase() && pinned > 0 && !javaRuns(pinned, mc, loader);
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
  const cmd = s && rewriteJava(s.execution_command, exe, mc, loader);
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
