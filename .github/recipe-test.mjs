// Standalone server recipes against controlled upstream metadata: version
// lists, exact builds, Java majors and checksum refusal. No real downloads;
// the real create-and-boot proof is listed in docs/recipes.md.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import AdmZip from 'adm-zip';
import { tsImport } from 'tsx/esm/api';

const root = mkdtempSync(join(tmpdir(), 'spawnpoint-recipes-'));
process.env.SPAWNPOINT_ROOT = root;
const recipes = await tsImport('../server/src/services/recipes.ts', import.meta.url);
const { jdkFeatureFor } = await tsImport('../server/src/services/temurin.ts', import.meta.url);
const { rewriteJava } = await tsImport('../server/src/services/servers.ts', import.meta.url);
let checks = 0;
const check = (name, ok) => { assert.ok(ok, name); checks++; console.log(`ok ${name}`); };
const sha = (algo, bytes) => createHash(algo).update(bytes).digest('hex');

const routes = new Map();
const route = (url, body) => routes.set(url, typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const body = routes.get(String(url));
  return body === undefined ? new Response('missing', { status: 404 }) : new Response(body);
};

const releaseIds = ['26.3', '26.2', '1.21.11', '1.21.1', '1.20.1', '1.16.5', '1.12.2', '1.2.5', '1.0'];
const manifest = { versions: [{ id: '26.4-snapshot-6', type: 'snapshot', url: 'https://mojang.invalid/snap.json', sha1: 'x' }] };
for (const id of releaseIds) {
  const major = id.startsWith('26') ? 25 : ['1.21.11', '1.21.1'].includes(id) ? 21 : id === '1.20.1' ? 17 : 8;
  const doc = JSON.stringify({ javaVersion: { majorVersion: major }, downloads: id === '1.0' ? {} : { server: { url: `https://mojang.invalid/${id}/server.jar`, sha1: sha('sha1', Buffer.from(`server ${id}`)), size: `server ${id}`.length } } });
  route(`https://mojang.invalid/${id}.json`, doc);
  manifest.versions.push({ id, type: 'release', url: `https://mojang.invalid/${id}.json`, sha1: sha('sha1', Buffer.from(doc)) });
}
route('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', manifest);
route('https://mojang.invalid/26.3/server.jar', 'server 26.3');
route('https://mojang.invalid/1.21.1/server.jar', 'tampered');

// Versions: every release the loader builds, in Mojang order, never snapshots
route('https://meta.fabricmc.net/v2/versions/game', [{ version: '26.4-snapshot-6', stable: false }, ...['26.3', '1.21.1', '1.20.1', '1.16.5'].map((version) => ({ version, stable: true }))]);
check('Fabric lists only its stable releases, newest first', JSON.stringify(await recipes.listVersions('fabric')) === '["26.3","1.21.1","1.20.1","1.16.5"]');
route('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge', { versions: ['21.1.219', '21.1.300-beta', '26.3.0.0-alpha.1+snapshot-1', '26.3.0.99', '26.2.0.5-beta', '20.2.86'] });
route('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/forge', { versions: ['1.20.1-47.1.106', '47.1.82'] });
check('NeoForge maps its own numbering, including 26.x and legacy 1.20.1', JSON.stringify(await recipes.listVersions('neoforge')) === '["26.3","26.2","1.21.1","1.20.1"]');
check('NeoForge alpha snapshot builds and 1.x four-part numbers map to no release', recipes.neoforgeMc('26.3.0.0-alpha.1+snapshot-1') === null && recipes.neoforgeMc('21.1.219.1') === null && recipes.neoforgeMc('26.1.0.13-beta') === '26.1');
route('https://meta.fabricmc.net/v2/versions/game', []);

// Vanilla: Mojang's own sha1 and size; a version without a server jar refuses
const vanilla = await recipes.resolveRecipe('vanilla', '26.3');
check('Vanilla 26.3 uses Mojang\'s sha1 and Java 25', vanilla.download.algo === 'sha1' && vanilla.java === 25 && (await recipes.fetchRecipe(vanilla)).toString() === 'server 26.3');
await assert.rejects(recipes.fetchRecipe(await recipes.resolveRecipe('vanilla', '1.21.1')), /size|checksum|bytes/); checks++;
console.log('ok altered upstream bytes are refused');
await assert.rejects(recipes.resolveRecipe('vanilla', '1.0'), /no release build|no server jar/); checks++;
console.log('ok Minecraft before 1.2.5 is not offered: Mojang publishes no server jar');
await assert.rejects(recipes.resolveRecipe('vanilla', '26.4-snapshot-6'), /no release build/); checks++;
console.log('ok snapshots are refused even when named directly');

// Forge: certified solver profile first, then recommended, else latest with a note
route('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json', { promos: { '1.20.1-latest': '47.4.30', '1.20.1-recommended': '47.4.29', '1.12.2-latest': '14.23.5.2864', '1.12.2-recommended': '14.23.5.2859', '26.3-latest': '66.1.2' } });
route('https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json', { '1.20.1': ['1.20.1-47.4.28', '1.20.1-47.4.29'], '1.12.2': ['1.12.2-14.23.5.2859'], '26.3': ['26.3-66.1.2'] });
const installer = Buffer.from('forge installer');
for (const full of ['1.20.1-47.4.28', '1.12.2-14.23.5.2859', '26.3-66.1.2']) route(`https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar.sha1`, `${sha('sha1', installer)}  forge-${full}-installer.jar\n`);
route('https://maven.minecraftforge.net/net/minecraftforge/forge/26.3-66.1.2/forge-26.3-66.1.2-installer.jar.sha512', sha('sha512', installer));
const forge1201 = await recipes.resolveRecipe('forge', '1.20.1');
check('Forge 1.20.1 keeps the certified 47.4.28 profile over newer promotions', forge1201.build === '47.4.28' && forge1201.java === 21 && 'argDir' in forge1201.launch);
const forge1122 = await recipes.resolveRecipe('forge', '1.12.2');
check('Forge 1.12.2 takes the recommended build, Java 8 and the legacy jar launch', forge1122.build === '14.23.5.2859' && forge1122.java === 8 && 'forgeJar' in forge1122.launch);
const forge263 = await recipes.resolveRecipe('forge', '26.3');
check('Forge 26.3 without a recommended build takes latest, says so, and prefers sha512', forge263.build === '66.1.2' && forge263.notes.length === 1 && forge263.download.algo === 'sha512' && forge263.java === 25);
routes.delete('https://maven.minecraftforge.net/net/minecraftforge/forge/1.12.2-14.23.5.2859/forge-1.12.2-14.23.5.2859-installer.jar.sha1');
await assert.rejects(recipes.resolveRecipe('forge', '1.12.2'), /no upstream checksum/); checks++;
console.log('ok an installer without a published checksum fails loudly');

// Fabric: Meta's launcher has no hash, so Spawnpoint builds it from the verified installer
const installerZip = new AdmZip();
installerZip.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\r\nMain-Class: net.fabricmc.installer.Main\r\nClass-Path: evil.jar\r\n'));
installerZip.addFile('META-INF/FABRIC1.SF', Buffer.from('signature'));
installerZip.addFile('net/fabricmc/installer/ServerLauncher.class', Buffer.from('launcher class'));
const built = new AdmZip(recipes.fabricLauncher(installerZip.toBuffer(), '26.3', '0.20.1'));
check('the Fabric launcher is the verified installer with a canonical manifest and properties',
  built.readAsText('META-INF/MANIFEST.MF') === 'Manifest-Version: 1.0\r\nMain-Class: net.fabricmc.installer.ServerLauncher\r\nEnable-Native-Access: ALL-UNNAMED\r\n\r\n'
  && built.readAsText('install.properties') === 'fabric-loader-version=0.20.1\ngame-version=26.3\n'
  && built.readFile('net/fabricmc/installer/ServerLauncher.class').toString() === 'launcher class' && !built.getEntry('META-INF/FABRIC1.SF'));

// Libraries the Fabric and Quilt installers fetch must all match upstream checksums
const bundled = Buffer.from('bundled library'), versionJar = Buffer.from('unbundled server'), loaderJar = Buffer.from('loader'), mixin = Buffer.from('mixin');
const mojangZip = new AdmZip();
mojangZip.addFile('META-INF/libraries.list', Buffer.from(`${sha('sha256', bundled)}\tcom.example:lib:1\tcom/example/lib/1/lib-1.jar\n`));
mojangZip.addFile('META-INF/versions.list', Buffer.from(`${sha('sha256', versionJar)}\t26.3\t26.3/server-26.3.jar\n`));
const mojangJar = mojangZip.toBuffer();
route('https://meta.invalid/server.json', { libraries: [{ name: 'net.fabricmc:sponge-mixin:0.17', url: 'https://maven.invalid', sha512: sha('sha512', mixin) }, { name: 'net.fabricmc:fabric-loader:0.20.1', url: 'https://maven.invalid/' }] });
route('https://maven.invalid/net/fabricmc/fabric-loader/0.20.1/fabric-loader-0.20.1.jar.sha1', sha('sha1', loaderJar));
const installed = { ...vanilla, loader: 'fabric', libraries: { json: 'https://meta.invalid/server.json', serverJar: '.fabric/server/26.3-server.jar', mojang: { url: 'x', algo: 'sha1', hash: sha('sha1', mojangJar) } } };
const tree = (extra = {}) => {
  const dir = mkdtempSync(join(root, 'installed-'));
  const put = (path, bytes) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), bytes); };
  put('.fabric/server/26.3-server.jar', mojangJar);
  put('libraries/com/example/lib/1/lib-1.jar', bundled);
  put('versions/26.3/server-26.3.jar', versionJar);
  put('libraries/net/fabricmc/sponge-mixin/0.17/sponge-mixin-0.17.jar', mixin);
  put('libraries/net/fabricmc/fabric-loader/0.20.1/fabric-loader-0.20.1.jar', loaderJar);
  for (const [path, bytes] of Object.entries(extra)) bytes === null ? rmSync(join(dir, path)) : put(path, bytes);
  return dir;
};
check('installed libraries matching Meta, Maven sidecars and the Mojang bundler pass', await recipes.verifyInstalled(tree(), installed).then(() => true));
for (const [name, extra, why] of [['an unlisted library', { 'libraries/evil/evil.jar': 'x' }, /no upstream checksum/],
  ['an altered loader jar', { 'libraries/net/fabricmc/fabric-loader/0.20.1/fabric-loader-0.20.1.jar': 'altered' }, /does not match/],
  ['an altered bundled library', { 'libraries/com/example/lib/1/lib-1.jar': 'altered' }, /does not match/],
  ['a missing Meta library', { 'libraries/net/fabricmc/sponge-mixin/0.17/sponge-mixin-0.17.jar': null }, /did not fetch/],
  ['an altered Mojang jar', { '.fabric/server/26.3-server.jar': 'altered' }, /Mojang/]]) {
  await assert.rejects(recipes.verifyInstalled(tree(extra), installed), why); checks++;
  console.log(`ok ${name} fails the installation`);
}

// Tested changes are claimed only where locked revisions certify the launch recipe
check('tested changes: all Fabric, Forge 1.20.1 and NeoForge 1.21.1 only, never plugins',
  recipes.testedChanges('fabric') === 'all' && JSON.stringify(recipes.testedChanges('forge')) === '["1.20.1"]'
  && JSON.stringify(recipes.testedChanges('neoforge')) === '["1.21.1"]' && recipes.testedChanges('paper').length === 0);

// Java majors follow each loader's real limits
const table = [['26.3', 'forge', 25], ['1.21.1', 'neoforge', 21], ['1.20.1', 'forge', 21], ['1.18.2', 'forge', 17], ['1.16.5', 'forge', 8], ['1.12.2', 'vanilla', 8],
  ['1.16.5', 'fabric', 21], ['1.16.5', 'quilt', 21], ['1.20.4', 'paper', 17], ['1.17.1', 'vanilla', 17], ['1.20.6', 'paper', 21], ['1.21.11', 'purpur', 21], ['1.21.11', 'fabric', 21], ['1.21.1', 'quilt', 21], ['1.17.1', 'purpur', 17], ['26.3', 'vanilla', 25], [null, 'paper', 21], [null, 'forge', 21]];
check('Java majors match every loader and era', table.every(([mc, loader, want]) => jdkFeatureFor(mc, loader) === want));

// Existing servers keep a working Java pin; only a pin that cannot run is replaced
const pin = (major) => `"/srv/Tools/jdk-${major}.0.1/bin/java" -Xmx2G -jar server.jar nogui`;
check('a working Java 25 pin on Paper 1.21.1 survives the newer Java 21 default', rewriteJava(pin(25), '/srv/Tools/jdk-21.0.1/bin/java', '1.21.1', 'paper') === null);
check('a Java 21 pin that cannot run Fabric 26.3 is upgraded', rewriteJava(pin(21), '/srv/Tools/jdk-25.0.1/bin/java', '26.3', 'fabric')?.startsWith('"/srv/Tools/jdk-25.0.1/bin/java"'));
check('a Java 25 pin on Forge 1.20.1 returns to 21', rewriteJava(pin(25), '/srv/Tools/jdk-21.0.1/bin/java', '1.20.1', 'forge')?.startsWith('"/srv/Tools/jdk-21.0.1/bin/java"'));

globalThis.fetch = originalFetch;
rmSync(root, { recursive: true, force: true });
console.log(`\n${checks}/${checks} recipe checks passed`);
