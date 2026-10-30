import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import AdmZip from 'adm-zip';
import { jdkFeatureFor, type JdkFeature } from './temurin.js';
import { FORGE_PROFILES, NEOFORGE_PROFILES } from './solver/forge.js';

// Server recipes for every loader, resolved from each project's own metadata.
// A recipe names the exact loader build and the upstream checksum of the one
// artifact Spawnpoint downloads itself; the official installers then verify
// their own downloads (Mojang jars, libraries) as they do upstream.

export const LOADERS = ['fabric', 'forge', 'neoforge', 'quilt', 'paper', 'purpur', 'vanilla'] as const;
export type RecipeLoader = typeof LOADERS[number];

/** Minecraft versions really created and booted by the standalone runtime
    (see docs/recipes.md). Every other listed version is offered as untested. */
export const BOOT_VERIFIED: Record<RecipeLoader, string[]> = {
  fabric: ['26.3', '1.21.11', '1.21.1', '1.20.1', '1.16.5'],
  forge: ['26.3', '1.21.1', '1.20.1', '1.18.2', '1.16.5', '1.12.2'],
  neoforge: ['26.3', '1.21.1', '1.20.4', '1.20.1'],
  quilt: ['26.3', '1.21.1', '1.20.1'],
  paper: ['26.3', '1.21.11', '1.20.1', '1.17.1', '1.16.5', '1.8.8'],
  purpur: ['26.3', '1.21.1', '1.20.1'],
  vanilla: ['26.3', '1.21.1', '1.20.1', '1.16.5', '1.12.2'],
};

export interface Checked { url: string; algo: 'sha512' | 'sha256' | 'sha1' | 'md5'; hash: string; size?: number }
export interface Recipe {
  loader: RecipeLoader;
  mc: string;
  /** Loader or build version installed for this Minecraft version. */
  build: string;
  java: JdkFeature;
  /** The artifact Spawnpoint downloads, saved under `file`. Fabric Meta's
      server launcher has no published hash, so Spawnpoint builds the same
      launcher from the checksummed installer instead of downloading it. */
  download: { file: string } & (Checked | { fabricInstaller: Checked });
  /** Fabric and Quilt fetch libraries and the Mojang jar without checking
      them. Every such file is verified before the server is sealed. */
  libraries?: { json: string; serverJar: string; mojang: Checked };
  /** What runs the server: a jar in the server root, the jar a legacy Forge
      installer produced, or the Forge/NeoForge argfile directory. */
  launch: { jar: string } | { forgeJar: true } | { argDir: string };
  notes: string[];
}

const UA = { 'user-agent': 'spawnpoint/1.0 (+https://github.com/vayungodara/spawnpoint)' };
async function get(url: string): Promise<Response> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status} for ${url}`);
  return res;
}
const json = async <T>(url: string): Promise<T> => (await (await get(url)).json()) as T;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60 * 60_000) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

/** newest first: 26.2 > 1.21.11 > 1.21.9 */
export function cmpMcDesc(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
const atLeast = (mc: string, floor: string): boolean => cmpMcDesc(mc, floor) <= 0;

interface Release { id: string; url: string; sha1: string }
const releases = (): Promise<Release[]> => cached('mojang', async () =>
  (await json<{ versions: (Release & { type: string })[] }>('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'))
    .versions.filter((v) => v.type === 'release'));

/** NeoForge's own numbering: 21.1.x is Minecraft 1.21.1, 21.0.x is 1.21;
    from Minecraft 26 on the first three parts are the game version and
    26.1.0.x is 26.1. Alpha builds target snapshots, never releases. */
export function neoforgeMc(version: string): string | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(-beta)?$/.exec(version);
  if (!m) return null;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (major >= 26) return m[4] === undefined ? null : `${major}.${minor}${patch ? `.${patch}` : ''}`;
  return m[4] === undefined ? `1.${major}${minor ? `.${minor}` : ''}` : null;
}
const NEO = 'https://maven.neoforged.net';
const neoVersions = (artifact: 'neoforge' | 'forge'): Promise<string[]> => cached(`neo-${artifact}`, async () =>
  (await json<{ versions: string[] }>(`${NEO}/api/maven/versions/releases/net/neoforged/${artifact}`)).versions);
const forgePromos = (): Promise<Record<string, string>> => cached('forge-promos', async () =>
  (await json<{ promos: Record<string, string> }>('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')).promos);
const paperVersions = (project: 'paper'): Promise<string[]> => cached(project, async () =>
  Object.values((await json<{ versions: Record<string, string[]> }>(`https://fill.papermc.io/v3/projects/${project}`)).versions).flat());

/** Every Minecraft release this loader officially builds, newest first. */
export function listVersions(loader: string): Promise<string[]> {
  return cached(`list-${loader}`, async () => {
    let supported: Iterable<string>;
    switch (loader) {
      case 'vanilla': // Mojang publishes no server jar before 1.2.5
        supported = (await releases()).map((r) => r.id).filter((id) => atLeast(id, '1.2.5'));
        break;
      case 'fabric':
      case 'quilt': {
        const base = loader === 'fabric' ? 'https://meta.fabricmc.net/v2' : 'https://meta.quiltmc.org/v3';
        supported = (await json<{ version: string; stable: boolean }[]>(`${base}/versions/game`)).filter((v) => v.stable).map((v) => v.version);
        break;
      }
      case 'forge': // Forge's Maven has server installers from 1.5.2 on
        supported = Object.keys(await forgePromos()).map((k) => k.replace(/-(latest|recommended)$/, '')).filter((mc) => atLeast(mc, '1.5.2'));
        break;
      case 'neoforge': {
        const mcs = (await neoVersions('neoforge')).map(neoforgeMc).filter((mc): mc is string => !!mc);
        // 1.20.1 is NeoForge's legacy line, published as net.neoforged:forge
        if ((await neoVersions('forge')).some((v) => v.startsWith('1.20.1-'))) mcs.push('1.20.1');
        supported = mcs;
        break;
      }
      case 'paper':
        supported = await paperVersions('paper');
        break;
      case 'purpur':
        supported = (await json<{ versions: string[] }>('https://api.purpurmc.org/v2/purpur')).versions;
        break;
      default:
        throw new Error(`unknown loader "${loader}"`);
    }
    // Releases only, in Mojang's order: snapshots, pre-releases and release
    // candidates never appear even when a loader publishes builds for them.
    const set = new Set(supported);
    return (await releases()).map((r) => r.id).filter((id) => set.has(id));
  });
}

/** Maven publishes checksum sidecars next to each artifact. Prefer the
    strongest one and refuse an artifact that has none. */
async function mavenChecked(url: string): Promise<Checked> {
  for (const algo of ['sha512', 'sha256', 'sha1'] as const) {
    const res = await fetch(`${url}.${algo}`, { headers: UA, signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (!res?.ok) continue;
    const hash = /^\s*([0-9a-f]+)/i.exec(await res.text())?.[1]?.toLowerCase();
    if (hash && hash.length === { sha512: 128, sha256: 64, sha1: 40 }[algo]) return { url, algo, hash };
  }
  throw new Error(`no upstream checksum is published for ${url}; refusing to install it`);
}

/** Download at most `limit` bytes. */
async function fetchBounded(url: string, limit = 128 * 1024 * 1024): Promise<Buffer> {
  const res = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} for ${url}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    if ((size += chunk.length) > limit) throw new Error(`${url} exceeds the ${limit / 1024 / 1024} MB limit`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Download bounded bytes and require the upstream checksum. */
export async function fetchChecked(item: Checked, limit?: number): Promise<Buffer> {
  const bytes = await fetchBounded(item.url, limit);
  if (item.size !== undefined && bytes.length !== item.size) throw new Error(`${item.url} is ${bytes.length} bytes; upstream publishes ${item.size}`);
  const actual = createHash(item.algo).update(bytes).digest('hex');
  if (actual !== item.hash) throw new Error(`${item.url} does not match its published ${item.algo} checksum`);
  return bytes;
}

/** Fabric Meta's server launcher is the installer with its signature
    removed, a manifest naming ServerLauncher and install.properties naming
    the game and loader. Build exactly that from the verified installer. */
export function fabricLauncher(installer: Buffer, mc: string, loader: string): Buffer {
  const zip = new AdmZip(installer);
  for (const name of zip.getEntries().map((e) => e.entryName)) {
    if (/^META-INF\/(MANIFEST\.MF|[^/]+\.(SF|RSA|DSA|EC))$/i.test(name) || name === 'install.properties') zip.deleteFile(name);
  }
  zip.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\r\nMain-Class: net.fabricmc.installer.ServerLauncher\r\nEnable-Native-Access: ALL-UNNAMED\r\n\r\n'));
  zip.addFile('install.properties', Buffer.from(`fabric-loader-version=${loader}\ngame-version=${mc}\n`));
  return zip.toBuffer();
}

/** The recipe's artifact, verified against its upstream checksum. */
export async function fetchRecipe(recipe: Recipe): Promise<Buffer> {
  const d = recipe.download;
  if ('fabricInstaller' in d) return fabricLauncher(await fetchChecked(d.fabricInstaller, 32 * 1024 * 1024), recipe.mc, recipe.build);
  return fetchChecked(d);
}

const digest = (algo: Checked['algo'], bytes: Buffer): string => createHash(algo).update(bytes).digest('hex');
const files = (dir: string): string[] => !existsSync(dir) ? [] : readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);

/** After the Fabric or Quilt installer ran, before anything is sealed:
    every library and version jar must match an upstream checksum. Loader
    libraries use Meta's hashes or the Maven sidecars; the Mojang jar uses
    Mojang's SHA-1; libraries the Mojang bundler unpacks use the SHA-256 in
    its own verified libraries.list. An unexpected or mismatched file fails. */
export async function verifyInstalled(dir: string, recipe: Recipe): Promise<void> {
  const lib = recipe.libraries;
  if (!lib) return;
  const mojang = readFileSync(join(dir, lib.serverJar));
  if (digest(lib.mojang.algo, mojang) !== lib.mojang.hash) throw new Error(`${lib.serverJar} does not match Mojang's published checksum`);
  const expected = new Map<string, { algo: Checked['algo']; hash: string }>();
  const listed = new AdmZip(mojang);
  for (const [list, root] of [['META-INF/libraries.list', 'libraries'], ['META-INF/versions.list', 'versions']]) {
    for (const line of (listed.getEntry(list) ? listed.readAsText(list) : '').split(/\r?\n/).filter(Boolean)) {
      const [hash, , path] = line.split('\t');
      expected.set(`${root}/${path}`, { algo: 'sha256', hash });
    }
  }
  const required: string[] = [];
  type Library = { name: string; url: string; sha512?: string; sha256?: string; sha1?: string };
  for (const l of (await json<{ libraries: Library[] }>(lib.json)).libraries) {
    const [group, artifact, version] = l.name.split(':');
    const path = `${group.replaceAll('.', '/')}/${artifact}/${version}/${artifact}-${version}.jar`;
    const algo = (['sha512', 'sha256', 'sha1'] as const).find((a) => l[a]);
    expected.set(`libraries/${path}`, algo ? { algo, hash: l[algo]! } : await mavenChecked(`${l.url.replace(/\/?$/, '/')}${path}`));
    required.push(`libraries/${path}`);
  }
  for (const path of required) if (!existsSync(join(dir, path))) throw new Error(`the installer did not fetch ${path}`);
  for (const file of [...files(join(dir, 'libraries')), ...files(join(dir, 'versions'))]) {
    const path = relative(dir, file).replaceAll('\\', '/');
    const want = expected.get(path);
    if (!want) throw new Error(`${path} has no upstream checksum; refusing the installation`);
    if (digest(want.algo, readFileSync(file)) !== want.hash) throw new Error(`${path} does not match its published ${want.algo} checksum`);
  }
}

const newest = (versions: string[]): string | undefined => [...versions].sort(cmpMcDesc)[0];
const stableFirst = (versions: string[]): { build: string; beta: boolean } | null => {
  const stable = newest(versions.filter((v) => !v.endsWith('-beta')));
  const any = stable ?? newest(versions);
  return any ? { build: any, beta: !stable } : null;
};

/** Resolve one exact, checksum-pinned recipe from upstream metadata. */
export async function resolveRecipe(loader: string, mc: string): Promise<Recipe> {
  if (!(LOADERS as readonly string[]).includes(loader)) throw new Error(`unknown loader "${loader}"`);
  if (!(await listVersions(loader)).includes(mc)) throw new Error(`${loader} publishes no release build for Minecraft ${mc}`);
  const l = loader as RecipeLoader;
  const java = jdkFeatureFor(mc, l);
  const release = (await releases()).find((r) => r.id === mc)!;
  // The version document is checked against the manifest's own sha1.
  const doc = JSON.parse((await fetchChecked({ url: release.url, algo: 'sha1', hash: release.sha1 }, 4 * 1024 * 1024)).toString('utf8')) as {
    javaVersion?: { majorVersion: number }; downloads?: { server?: { url: string; sha1: string; size: number } };
  };
  const declared = doc.javaVersion?.majorVersion ?? 8;
  if (declared > java) throw new Error(`Minecraft ${mc} declares Java ${declared}; Spawnpoint has no Java recipe for it yet`);
  const notes: string[] = [];
  const base = { loader: l, mc, java, notes };
  const mojangServer = (): Checked => {
    const server = doc.downloads?.server;
    if (!server) throw new Error(`Mojang publishes no server jar for ${mc}`);
    return { url: server.url, algo: 'sha1', hash: server.sha1, size: server.size };
  };
  switch (l) {
    case 'vanilla':
      return { ...base, build: mc, download: { ...mojangServer(), file: 'server.jar' }, launch: { jar: 'server.jar' } };
    case 'paper': {
      const info = await json<{ version: { java?: { version?: { minimum?: number } } } }>(`https://fill.papermc.io/v3/projects/paper/versions/${mc}`);
      const minimum = info.version.java?.version?.minimum ?? 8;
      if (minimum > java) throw new Error(`Paper ${mc} needs Java ${minimum}; Spawnpoint has no Java recipe for it yet`);
      const builds = await json<{ id: number; channel: string; downloads: Record<string, { url: string; size: number; checksums: { sha256?: string } }> }[]>(
        `https://fill.papermc.io/v3/projects/paper/versions/${mc}/builds`);
      const build = builds.find((b) => b.channel === 'STABLE') ?? builds[0];
      const file = build?.downloads['server:default'];
      if (!file?.checksums.sha256) throw new Error(`Paper publishes no checksummed server build for ${mc}`);
      if (build.channel !== 'STABLE') notes.push(`Paper ${mc} has no stable build; installed ${build.channel.toLowerCase()} build ${build.id}`);
      return { ...base, build: String(build.id), download: { url: file.url, algo: 'sha256', hash: file.checksums.sha256, size: file.size, file: 'paper.jar' }, launch: { jar: 'paper.jar' } };
    }
    case 'purpur': {
      const all = (await json<{ builds: { all: string[] } }>(`https://api.purpurmc.org/v2/purpur/${mc}`)).builds.all;
      for (const id of all.slice(-10).reverse()) {
        const b = await json<{ result: string; md5?: string }>(`https://api.purpurmc.org/v2/purpur/${mc}/${id}`);
        // Purpur publishes only an MD5. It still detects a corrupted or
        // substituted mirror response, but it is weaker than the others.
        if (b.result === 'SUCCESS' && b.md5) return { ...base, build: id, launch: { jar: 'purpur.jar' },
          download: { url: `https://api.purpurmc.org/v2/purpur/${mc}/${id}/download`, algo: 'md5', hash: b.md5.toLowerCase(), file: 'purpur.jar' } };
      }
      throw new Error(`Purpur publishes no successful checksummed build for ${mc}`);
    }
    case 'fabric': {
      const installer = (await json<{ url: string; version: string; stable: boolean }[]>('https://meta.fabricmc.net/v2/versions/installer')).find((i) => i.stable);
      const loaderBuild = (await json<{ loader: { version: string; stable: boolean } }[]>(`https://meta.fabricmc.net/v2/versions/loader/${mc}`)).find((v) => v.loader.stable)?.loader.version;
      if (!installer || !loaderBuild) throw new Error(`Fabric publishes no stable loader and installer for ${mc}`);
      return { ...base, build: loaderBuild, launch: { jar: 'fabric.jar' }, download: { file: 'fabric.jar', fabricInstaller: await mavenChecked(installer.url) },
        libraries: { json: `https://meta.fabricmc.net/v2/versions/loader/${mc}/${loaderBuild}/server/json`, serverJar: `.fabric/server/${mc}-server.jar`, mojang: mojangServer() } };
    }
    case 'quilt': {
      const installer = (await json<{ url: string }[]>('https://meta.quiltmc.org/v3/versions/installer'))[0];
      const loaderBuild = (await json<{ version: string }[]>('https://meta.quiltmc.org/v3/versions/loader')).map((v) => v.version).find((v) => !v.includes('-'));
      if (!installer || !loaderBuild) throw new Error('Quilt publishes no stable loader and installer');
      const meta = `https://meta.quiltmc.org/v3/versions/loader/${mc}/${loaderBuild}/server/json`;
      await get(meta);
      return { ...base, build: loaderBuild, download: { ...await mavenChecked(installer.url), file: 'quilt-installer.jar' }, launch: { jar: 'quilt-server-launch.jar' },
        libraries: { json: meta, serverJar: 'server.jar', mojang: mojangServer() } };
    }
    case 'forge': {
      const promos = await forgePromos();
      // A certified solver profile keeps new servers inside tested changes.
      const certified = Object.keys(FORGE_PROFILES).find((k) => k.startsWith(`${mc}-`))?.slice(mc.length + 1);
      const build = certified ?? promos[`${mc}-recommended`] ?? promos[`${mc}-latest`];
      const full = (await cached('forge-maven', () => json<Record<string, string[]>>('https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json')))[mc]
        ?.find((v) => v === `${mc}-${build}` || v.startsWith(`${mc}-${build}-`));
      if (!build || !full) throw new Error(`Forge publishes no installer for ${mc}`);
      if (!promos[`${mc}-recommended`] && !certified) notes.push(`Forge ${mc} has no recommended build; installed latest ${build}`);
      const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`;
      return { ...base, build, download: { ...await mavenChecked(url), file: 'installer.jar' },
        launch: atLeast(mc, '1.17') ? { argDir: `libraries/net/minecraftforge/forge/${mc}-${build}` } : { forgeJar: true } };
    }
    case 'neoforge': {
      const legacy = mc === '1.20.1';
      const certified = Object.keys(NEOFORGE_PROFILES).find((k) => k.startsWith(`${mc}-`))?.slice(mc.length + 1);
      const pick = certified ? { build: certified, beta: false }
        : stableFirst(legacy ? (await neoVersions('forge')).filter((v) => v.startsWith('1.20.1-')) : (await neoVersions('neoforge')).filter((v) => neoforgeMc(v) === mc));
      if (!pick) throw new Error(`NeoForge publishes no build for ${mc}`);
      if (pick.beta) notes.push(`NeoForge ${mc} has only beta builds; installed ${pick.build}`);
      const artifact = legacy ? 'forge' : 'neoforge';
      const url = `${NEO}/releases/net/neoforged/${artifact}/${pick.build}/${artifact}-${pick.build}-installer.jar`;
      return { ...base, build: pick.build, download: { ...await mavenChecked(url), file: 'installer.jar' }, launch: { argDir: `libraries/net/neoforged/${artifact}/${pick.build}` } };
    }
  }
}

/** Where the tested-change pipeline runs: every Fabric version, and only the
    Forge and NeoForge launch recipes revisions.ts certifies (their official
    argfile hashes). Other loaders never. */
export function testedChanges(loader: string): 'all' | string[] {
  return loader === 'fabric' ? 'all' : loader === 'forge' ? ['1.20.1'] : loader === 'neoforge' ? ['1.21.1'] : [];
}
