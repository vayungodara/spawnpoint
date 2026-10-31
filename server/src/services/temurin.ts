import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { PATHS } from '../config.js';
import { IS_WIN, unzipTo, chownToDirOwner } from './platform.js';

const run = promisify(execFile);

// Temurin JDKs are ~200 MB; anything wildly past that is not what we asked for
const MAX_ARCHIVE_BYTES = 600 * 1024 * 1024;

/** A directory only counts as a JDK when it actually contains a java binary. */
function usableJdk(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
    const java = join(dir, 'bin', IS_WIN ? 'java.exe' : 'java');
    return statSync(java).isFile();
  } catch {
    return false;
  }
}

// AUTO-JAVA — javaFor() only ever SCANS Tools/ for jdk-* dirs; on a fresh box
// that scan finds nothing and server creation dies on the silent "no suitable
// JDK" landmine. This closes it: fetch the right Temurin from Adoptium the
// first time it's missing, exactly where the need fires. Adoptium's assets
// API names the GitHub release asset and its SHA-256; the archive root is the
// canonical `jdk-<ver>+<build>` name javaFor and gateJava expect.

export type JdkFeature = 8 | 17 | 21 | 25;

/** Which Temurin feature version a server needs. Paper, Purpur and Vanilla
    take the major Mojang declares, as the next Temurin LTS: 8 before 1.17,
    17 until 1.20.5, 21 until 26 and 25 from 26. Paper 1.17 refuses anything
    newer than 17, and older plugin builds bundle native profilers that
    crash on Java 25. Forge and NeoForge keep 21 for all of 1.20, the
    certified recipe; their coremods break on newer JDKs. Fabric and Quilt
    run every version before 26 on 21: AutoModpack, Lithium and ModernFix
    for 1.21.1 fail to load on 25. A mod built for 25 gets a Java repair. */
export function jdkFeatureFor(mc: string | null, loader?: string | null): JdkFeature {
  const [major, minor = 0, patch = 0] = (mc ?? '').split('.').map((n) => parseInt(n, 10));
  if (major >= 26) return 25;
  if (major !== 1) return 21; // an unknown version keeps the long-standing default
  const modern = (minor > 20 || (minor === 20 && patch >= 5));
  if (loader === 'fabric' || loader === 'quilt') return 21;
  if (minor < 17) return 8;
  if (loader === 'forge' || loader === 'neoforge') return minor < 20 ? 17 : 21;
  return modern ? 21 : 17;
}

/** Every Tools JDK is named jdk-<feature>…: Temurin 8's jdk8u… archive root
    is installed as jdk-8u… so the owner and launch checks need one rule. */
export const jdkPrefix = (feature: JdkFeature): string => `jdk-${feature}`;

// one download at a time — two concurrent server creates must not both pull
// a 200MB archive into the same staging dir
let chain: Promise<boolean> = Promise.resolve(true);

/** Ensure a Temurin JDK of this feature version exists under Tools/.
    Returns true when one is present (already or after download). */
export function ensureJdk(feature: JdkFeature, log: (m: string) => void): Promise<boolean> {
  const next = chain.then(() => ensureJdkInner(feature, log), () => ensureJdkInner(feature, log));
  chain = next.catch(() => false);
  return next;
}

async function ensureJdkInner(feature: JdkFeature, log: (m: string) => void): Promise<boolean> {
  const tools = join(PATHS.root, 'Tools');
  mkdirSync(tools, { recursive: true });
  // a NAME is not a JDK: a leftover jdk-21-broken/ or a stray file would
  // otherwise suppress the download and leave server creation with no runtime
  if (readdirSync(tools).some((d) => d.startsWith(jdkPrefix(feature)) && usableJdk(join(tools, d)))) return true;

  const os = IS_WIN ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  const native = process.arch === 'arm64' ? 'aarch64' : 'x64';
  // per-process staging: two panels sharing a layout must not delete each
  // other's half-extracted archive
  const staging = join(tools, `.jdk-staging-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const archive = join(staging, IS_WIN ? 'jdk.zip' : 'jdk.tar.gz');

  try {
    // Adoptium publishes each archive's SHA-256 next to its link. Temurin 8
    // and 16 have no Apple silicon or Windows Arm build; those run the x64
    // build under Rosetta or Windows emulation.
    type Asset = { binary: { package: { link: string; checksum: string; size: number } } };
    const assets = async (arch: string) => {
      const res = await fetch(`https://api.adoptium.net/v3/assets/latest/${feature}/hotspot?architecture=${arch}&image_type=jdk&os=${os}&vendor=eclipse`,
        { signal: AbortSignal.timeout(60_000) });
      return res.ok ? ((await res.json()) as Asset[])[0]?.binary.package : undefined;
    };
    let arch = native;
    let pkg = await assets(arch);
    if (!pkg && arch === 'aarch64' && os !== 'linux') pkg = await assets(arch = 'x64');
    if (!pkg?.link || !/^[0-9a-f]{64}$/.test(pkg.checksum ?? '')) {
      log(`java: Adoptium publishes no checksummed JDK ${feature} for ${os}/${native} — install one into Tools/ manually`);
      return false;
    }
    log(`java: no JDK ${feature} in Tools/ — downloading Temurin ${feature} (${os}/${arch}, ~200 MB)…`);
    // bounded: a stalled mirror must not wedge the serialized chain forever,
    // and a runaway response must not fill the disk the worlds live on
    const res = await fetch(pkg.link, { redirect: 'follow', signal: AbortSignal.timeout(20 * 60_000) });
    if (!res.ok || !res.body) {
      log(`java: Adoptium answered ${res.status} for JDK ${feature} — install one into Tools/ manually`);
      return false;
    }
    const declared = parseInt(res.headers.get('content-length') ?? '0', 10);
    if (declared && declared > MAX_ARCHIVE_BYTES) {
      log(`java: refusing a ${Math.round(declared / 1e6)} MB JDK archive (limit ${MAX_ARCHIVE_BYTES / 1e6} MB)`);
      return false;
    }
    // stream to disk — a 200MB arrayBuffer would sit in panel RAM
    let seen = 0;
    const digest = createHash('sha256');
    const capped = new Transform({
      transform(chunk, _enc, cb) {
        seen += chunk.length;
        if (seen > MAX_ARCHIVE_BYTES) { cb(new Error('archive exceeded the size limit')); return; }
        digest.update(chunk);
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), capped, createWriteStream(archive));
    if (digest.digest('hex') !== pkg.checksum) {
      log(`java: the JDK ${feature} archive does not match Adoptium's published SHA-256 — refusing it`);
      return false;
    }
    if (IS_WIN) {
      await unzipTo(archive, staging);
    } else {
      await run('nice', ['-n', '10', 'tar', '-xzf', archive, '-C', staging]);
      // The owner service runs with UMask=0077. A JDK is not private: Crafty,
      // test and server accounts sharing Tools/ must be able to execute it.
      await run('chmod', ['-R', 'u+rwX,go+rX', staging]);
    }
    const rootDir = readdirSync(staging).find((d) => d.startsWith('jdk')
      && (usableJdk(join(staging, d)) || usableJdk(join(staging, d, 'Contents', 'Home'))));
    if (!rootDir) {
      log('java: the downloaded archive contained no usable JDK — aborting');
      return false;
    }
    const extracted = join(staging, rootDir);
    const home = usableJdk(extracted) ? extracted : join(extracted, 'Contents', 'Home');
    // atomic move: javaFor prefix-matches any jdk-* the moment it appears,
    // so a half-extracted JDK must never be visible under Tools/ itself.
    // macOS archives wrap the Java home in Contents/Home. Keep every caller
    // on the same Tools/jdk-*/bin/java recipe rather than special-casing it.
    const name = rootDir.replace(/^jdk8u/, 'jdk-8u');
    renameSync(home, join(tools, name));
    await chownToDirOwner(join(tools, name));
    log(`java: Temurin ${feature} installed at Tools/${name}`);
    return true;
  } catch (e) {
    log(`java: JDK ${feature} download failed — ${String(e).slice(0, 140)}`);
    return false;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
