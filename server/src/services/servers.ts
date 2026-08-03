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
  /** public join address (relay lane) — what friends type; null = no lane */
  address: string | null;
}

export function getActiveUuid(): string | null {
  if (!existsSync(PATHS.activeServerFile)) return null;
  const v = readFileSync(PATHS.activeServerFile, 'utf8').trim();
  return v.length > 0 ? v : null;
}

export function setActiveUuid(uuid: string): void {
  writeFileSync(PATHS.activeServerFile, uuid, 'ascii');
}

export function serverDir(uuid: string): string {
  return join(PATHS.craftyServers, uuid);
}

// Every server must launch via an ABSOLUTE java path, and the java has to
// match the MC version:
//   - MC 26.x needs Java 25 (Tools\jdk-25*); older Java = UnsupportedClassVersionError
//   - MC 1.17–1.21.x runs on Java 21 (the system Adoptium JDK)
// Crafty writes a bare `java` into the launch command. That FAILS SILENTLY
// under Crafty: it runs as the craftysvc service, whose environment was
// captured before the JDK was installed, so `java` doesn't resolve — the
// process dies with no console output and no log file, and the panel just
// sits on "starting". (Diagnosed live on a Forge 1.20.1 server; the same
// command ran fine by hand because an interactive shell HAS java on PATH.)
const javaFixed = new Set<string>();

/** Absolute path to the best JRE for this MC version, or null if none found.
    ONLY space-free paths are usable: Crafty joins the launch command for the
    shell WITHOUT quoting, so `C:\Program Files\...\java.exe` is torn at the
    space, `C:\Program` is executed, and the server dies instantly with no
    process, no console output and no log — the panel just says "starting"
    forever. (Diagnosed on the Forge 1.20.1 server; that is why every JDK the
    panel points at lives under C:\MinecraftServers\Tools.) */
/** Which JDK to launch a server with.
 *
 *  The MC version sets the MINIMUM Java; the LOADER sets the maximum — and that
 *  second half was missing, which is why Paper plugins silently refused to load.
 *
 *  - Forge / NeoForge are the fragile ones: Forge 1.20.x genuinely BREAKS on a
 *    newer JDK (its coremods reflect into JVM internals), so those stay pinned
 *    to 21 no matter what.
 *  - Paper / Purpur / Spigot / Fabric / Quilt / Vanilla run happily on a newer
 *    JDK than their minimum, and modern PLUGINS increasingly REQUIRE one:
 *    Chunky-Bukkit 1.5.3 is compiled to class-file 69 (Java 25), so on Java 21
 *    Paper booted fine and then rejected the plugin with
 *    "UnsupportedClassVersionError … compiled by a more recent version".
 *    Nothing in the panel surfaced that — the server looked healthy.
 *    So: give them the NEWEST JDK we have. */
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
  // (a) a bare `java` never resolves under the craftysvc service account
  const bare = /^"?java(\.exe)?"?\s/.test(cur);
  // (b) an ABSOLUTE path we previously wrote that is now the WRONG major. This
  //     used to be skipped ("already a full path"), which is how a Paper server
  //     stayed pinned to Java 21 and silently refused every Java-25 plugin.
  //     Separator/extension-agnostic so the same logic works on the Linux box
  //     (…/Tools/jdk-25/bin/java) and Windows (…\Tools\jdk-25\bin\java.exe).
  const currentPath = /^"([^"]*[\\/]bin[\\/]java(?:\.exe)?)"/.exec(cur)?.[1];
  const wrongMajor = !!currentPath && currentPath.toLowerCase() !== exe.toLowerCase() && /[\\/]Tools[\\/]jdk-/i.test(currentPath);
  if (!bare && !wrongMajor) return null;
  return bare
    ? cur.replace(/^"?java(\.exe)?"?/, `"${exe}"`)
    : cur.replace(/^"[^"]*[\\/]bin[\\/]java(?:\.exe)?"/, `"${exe}"`);
}

async function autoFixJava(s: CraftyServer, mc: string | null, loader?: string | null): Promise<void> {
  if (javaFixed.has(s.server_id)) return;
  const exe = javaFor(mc, loader);
  if (!exe) return;
  const cmd = rewriteJava(s.execution_command, exe);
  if (!cmd) return;
  await craftyApi.patchServer(s.server_id, { execution_command: cmd });
  javaFixed.add(s.server_id);
}

/** Force the launch command's java to match `mc` NOW, for a specific server.
    The version switcher needs this: changing the MC version can change the Java
    MAJOR (1.20→21, 26→25), it starts the server itself (bypassing the start
    route's java-fix), and autoFixJava is memoised — so without an explicit
    re-pin the boot-verify dies on UnsupportedClassVersionError and rolls back a
    switch that was actually fine. Returns true if the command was changed. */
export async function pinJavaFor(id: string, mc: string | null, loader?: string | null): Promise<boolean> {
  const exe = javaFor(mc, loader);
  if (!exe) return false;
  const s = await craftyApi.getServer(id).catch(() => null);
  if (!s) return false;
  const cmd = rewriteJava(s.execution_command, exe);
  javaFixed.add(id); // reflect the pinned state so autoFixJava won't second-guess it
  if (!cmd) return false;
  await craftyApi.patchServer(id, { execution_command: cmd });
  return true;
}

export async function listServers(): Promise<ServerInfo[]> {
  const servers = await craftyApi.listServers();
  const active = getActiveUuid();
  let addresses: Record<string, string> = {};
  try {
    addresses = (JSON.parse(readFileSync(join(PATHS.data, 'clientpack.json'), 'utf8')) as { addresses?: Record<string, string> }).addresses ?? {};
  } catch { /* no lanes yet */ }
  return Promise.all(
    servers.map(async (s: CraftyServer) => {
      const dir = serverDir(s.server_id);
      const detection = existsSync(dir) ? detect(dir, s.server_id) : { loader: 'unknown' as const, mc: null };
      await autoFixJava(s, detection.mc, detection.loader).catch(() => {});
      return {
        id: s.server_id,
        name: s.server_name,
        port: s.server_port,
        path: dir,
        active: s.server_id === active,
        detection,
        address: addresses[s.server_id] ?? null,
      };
    }),
  );
}

export async function resolveByName(name: string): Promise<string | null> {
  const servers = await craftyApi.listServers();
  const hit = servers.find((s) => s.server_name.toLowerCase() === name.toLowerCase());
  return hit?.server_id ?? null;
}
