import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { PATHS } from '../config.js';
import { IS_WIN, unzipTo, chownToDirOwner } from './platform.js';

const run = promisify(execFile);

// AUTO-JAVA — javaFor() only ever SCANS Tools/ for jdk-* dirs; on a fresh box
// that scan finds nothing and server creation dies on the silent "no suitable
// JDK" landmine. This closes it: fetch the right Temurin from Adoptium the
// first time it's missing, exactly where the need fires. Adoptium's binary
// endpoint 307-redirects to the GitHub release asset; the archive root is the
// canonical `jdk-<ver>+<build>` name javaFor and gateJava both expect.

/** Which Temurin feature version a server needs — mirrors javaFor()'s rules. */
export function jdkFeatureFor(mc: string | null, loader?: string | null): 21 | 25 {
  const major = mc ? parseInt(mc.split('.')[0], 10) : NaN;
  if (!isNaN(major) && major >= 26) return 25;
  if (loader === 'forge' || loader === 'neoforge') return 21;
  const [, min = 0, pat = 0] = (mc ?? '').split('.').map((n) => parseInt(n, 10) || 0);
  return major === 1 && (min > 20 || (min === 20 && pat >= 5)) ? 25 : 21;
}

// one download at a time — two concurrent server creates must not both pull
// a 200MB archive into the same staging dir
let chain: Promise<boolean> = Promise.resolve(true);

/** Ensure a Temurin JDK of this feature version exists under Tools/.
    Returns true when one is present (already or after download). */
export function ensureJdk(feature: 21 | 25, log: (m: string) => void): Promise<boolean> {
  const next = chain.then(() => ensureJdkInner(feature, log), () => ensureJdkInner(feature, log));
  chain = next.catch(() => false);
  return next;
}

async function ensureJdkInner(feature: 21 | 25, log: (m: string) => void): Promise<boolean> {
  const tools = join(PATHS.root, 'Tools');
  mkdirSync(tools, { recursive: true });
  if (readdirSync(tools).some((d) => d.startsWith(`jdk-${feature}`))) return true;

  const os = IS_WIN ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const url = `https://api.adoptium.net/v3/binary/latest/${feature}/ga/${os}/${arch}/jdk/hotspot/normal/eclipse`;
  const staging = join(tools, '.jdk-staging');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const archive = join(staging, IS_WIN ? 'jdk.zip' : 'jdk.tar.gz');

  log(`java: no JDK ${feature} in Tools/ — downloading Temurin ${feature} (${os}/${arch}, ~200 MB)…`);
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) {
      log(`java: Adoptium answered ${res.status} for JDK ${feature} — install one into Tools/ manually`);
      return false;
    }
    // stream to disk — a 200MB arrayBuffer would sit in panel RAM
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(archive));
    if (IS_WIN) {
      await unzipTo(archive, staging);
    } else {
      await run('nice', ['-n', '10', 'tar', '-xzf', archive, '-C', staging]);
    }
    const rootDir = readdirSync(staging).find((d) => d.startsWith('jdk-'));
    if (!rootDir) {
      log('java: Temurin archive had no jdk-* root dir — aborting');
      return false;
    }
    // atomic move: javaFor prefix-matches any jdk-* the moment it appears,
    // so a half-extracted JDK must never be visible under Tools/ itself
    renameSync(join(staging, rootDir), join(tools, rootDir));
    await chownToDirOwner(join(tools, rootDir));
    log(`java: Temurin ${feature} installed at Tools/${rootDir}`);
    return true;
  } catch (e) {
    log(`java: JDK ${feature} download failed — ${String(e).slice(0, 140)}`);
    return false;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
