// Public install contract against real files and loader metadata. Only the
// external catalog/CDN is simulated; the live Crafty proof is separate.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { stringify } from 'smol-toml';
import { tsImport } from 'tsx/esm/api';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';

const javaInfo = spawnSync('java', ['-XshowSettings:properties', '-version'], { encoding: 'utf8' });
const javaHome = /^\s*java.home = (.+)$/m.exec(javaInfo.stderr ?? '')?.[1].trim();
assert.ok(javaHome, 'an installed Java runtime is required');
const root = mkdtempSync(join(tmpdir(), 'spawnpoint-solver-'));
process.env.SPAWNPOINT_ROOT = root;
mkdirSync(join(root, 'Spawnpoint', 'data'), { recursive: true });
writeFileSync(join(root, 'Spawnpoint', 'data', 'settings.json'), JSON.stringify({ curseforgeApiKey: 'offline-fixture-only' }));
const { install, solveCandidate, deleteInstalled } = await tsImport('../server/src/services/installer.ts', import.meta.url);
const { candidate, candidateSet, discard, stage, stageConfig, stagingPath, approve, applyReady } = await tsImport('../server/src/services/packtxn.ts', import.meta.url);
const { updateLedger, ledgerEntries } = await tsImport('../server/src/services/ledger.ts', import.meta.url);
const { NetworkCatalog } = await tsImport('../server/src/services/solver/catalog.ts', import.meta.url);
const { repairCandidate, duplicateMods, keepNewest } = await tsImport('../server/src/services/repairs.ts', import.meta.url);
const { setOverride } = await tsImport('../server/src/services/detect.ts', import.meta.url);
const { revisionDir, setRevisionState, packPath: lockPath } = await tsImport('../server/src/services/revisions.ts', import.meta.url);
const { installMrpackFile, installCurseforgeZipFile } = await tsImport('../server/src/services/modpack.ts', import.meta.url);
const { ensureJdk } = await tsImport('../server/src/services/temurin.ts', import.meta.url);
const { javaFor, clientShelfDir } = await tsImport('../server/src/services/servers.ts', import.meta.url);
const { PATHS } = await tsImport('../server/src/config.ts', import.meta.url);
mkdirSync(join(root, 'Tools'), { recursive: true });
symlinkSync(javaHome, join(root, 'Tools', 'jdk-25-fixture'), process.platform === 'win32' ? 'junction' : 'dir');
symlinkSync(javaHome, join(root, 'Tools', 'jdk-21-fixture'), process.platform === 'win32' ? 'junction' : 'dir');
mkdirSync(PATHS.data, { recursive: true });

const versions = new Map(), projects = new Map(), artifacts = new Map();
const sha = (bytes, algorithm) => createHash(algorithm).update(bytes).digest('hex');
const record = (project, id, number, fields = {}, relations = [], loader = 'fabric') => {
  const zip = new AdmZip();
  if (loader === 'forge') zip.addFile('META-INF/mods.toml', Buffer.from(stringify({ modLoader: 'javafml', loaderVersion: '[47,)',
    mods: [{ modId: project, version: number }], ...fields })));
  else if (loader === 'neoforge') zip.addFile('META-INF/neoforge.mods.toml', Buffer.from(stringify({ modLoader: 'javafml', loaderVersion: '[4,5)', license: 'MIT',
    mods: [{ modId: project, version: number }], ...fields })));
  else zip.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ schemaVersion: 1, id: project, version: number, ...fields })));
  const bytes = zip.toBuffer();
  const file = { filename: `${id}.jar`, primary: true, size: bytes.length,
    url: `https://fixture.invalid/${id}.jar`, hashes: { sha1: sha(bytes, 'sha1'), sha512: sha(bytes, 'sha512') } };
  const version = { id, project_id: project, name: id, version_number: number, version_type: 'release',
    game_versions: [loader === 'forge' ? '1.20.1' : '1.21.1'], loaders: [loader], date_published: number.startsWith('2') ? '2026-01-02T00:00:00Z' : '2026-01-01T00:00:00Z',
    downloads: 0, files: [file], dependencies: relations };
  versions.set(id, version);
  projects.set(project, { id: project, title: project, categories: [], server_side: 'required', client_side: 'required' });
  artifacts.set(file.url, bytes);
  return version;
};
const originalFetch = globalThis.fetch;
const originalDispatcher = getGlobalDispatcher();
const cf = new MockAgent();
cf.disableNetConnect();
setGlobalDispatcher(cf);
let onDomain;
globalThis.fetch = async (url, options = {}) => {
  const request = new URL(url);
  if (artifacts.has(request.href)) return new Response(artifacts.get(request.href));
  const path = decodeURIComponent(request.pathname).split('/');
  if (path[2] === 'version_files') {
    const hashes = JSON.parse(options.body).hashes;
    return Response.json(Object.fromEntries([...versions.values()].flatMap((v) => v.files.filter((f) => hashes.includes(f.hashes.sha1)).map((f) => [f.hashes.sha1, v]))));
  }
  if (path[2] === 'project' && path[4] === 'version') {
    onDomain?.();
    return Response.json([...versions.values()].filter((v) => v.project_id === path[3]));
  }
  if (path[2] === 'project') return projects.has(path[3]) ? Response.json(projects.get(path[3])) : new Response('', { status: 404 });
  if (path[2] === 'version') return versions.has(path[3]) ? Response.json(versions.get(path[3])) : new Response('', { status: 404 });
  if (path[2] === 'search') return Response.json({ hits: [], total_hits: 0 });
  throw Error(`Unexpected network call: ${url}`);
};
const ids = [];
const fixture = (items, kind = 'fabric') => {
  const id = randomUUID(); ids.push(id);
  const dir = join(PATHS.craftyServers, id);
  mkdirSync(join(dir, 'mods'), { recursive: true });
  if (kind === 'forge') mkdirSync(join(dir, 'libraries/net/minecraftforge/forge/1.20.1-47.4.28'), { recursive: true });
  else if (kind === 'neoforge') {
    mkdirSync(join(dir, 'libraries/net/neoforged/neoforge/21.1.219'), { recursive: true });
    setOverride(id, { loader: 'neoforge', mc: '1.21.1' });
  }
  else {
    mkdirSync(join(dir, 'libraries/net/fabricmc/fabric-loader/0.20.1'), { recursive: true });
    const loader = new AdmZip(); loader.addFile('install.properties', Buffer.from('game-version=1.21.1'));
    writeFileSync(join(dir, 'fabric.jar'), loader.toBuffer());
  }
  const entries = items.map(([v, requested = true]) => {
    const file = v.files[0]; writeFileSync(join(dir, 'mods', file.filename), artifacts.get(file.url));
    return { file: file.filename, projectId: v.project_id, versionId: v.id, versionNumber: v.version_number,
      title: v.project_id, source: 'modrinth', sha1: file.hashes.sha1, installedAt: '2026-01-01T00:00:00Z', via: requested ? 'direct' : 'dependency' };
  });
  updateLedger(id, () => entries);
  return { id, dir, bytes: () => JSON.stringify(readdirSync(join(dir, 'mods')).sort().map((f) => [f, sha(readFileSync(join(dir, 'mods', f)), 'sha512')])),
    ledger: () => JSON.stringify(ledgerEntries(id)) };
};
let checks = 0;
const check = (name, condition) => { assert.ok(condition, name); console.log(`ok - ${name}`); checks++; };
try {
  const lib1 = record('testlib', 'testlib1', '1.0.0');
  const lib2 = record('testlib', 'testlib2', '2.0.0');
  const user = record('testuser', 'testuser1', '1.0.0', { depends: { testlib: '>=2' } },
    [{ project_id: 'testlib', version_id: null, dependency_type: 'required' }]);
  const f = fixture([[lib1, false]]);
  const before = { bytes: f.bytes(), ledger: f.ledger() };
  const result = await install(f.id, { projectId: 'testuser', versionId: user.id, type: 'mod' });
  check('whole-pack install changes only the required existing library', !result.error && result.solver.status === 'ok'
    && result.solver.changes.changed.length === 1 && result.solver.changes.changed[0].to.versionId === lib2.id
    && result.installed.length === 2);
  check('a solved plan is staged without changing live files or ledger', f.bytes() === before.bytes && f.ledger() === before.ledger
    && candidate(f.id).files.some((s) => s.file === lib2.files[0].filename && s.replaces === lib1.files[0].filename));
  check('requested and dependency roots survive staging distinctly', candidate(f.id).files.find((s) => s.entry.projectId === 'testuser').entry.via === 'direct'
    && candidate(f.id).files.find((s) => s.entry.projectId === 'testlib').entry.via === 'dependency');
  discard(f.id);

  const forgeOld = record('forgelib', 'forgelib1', '1.0.0', {}, [], 'forge');
  const forgeNew = record('forgelib', 'forgelib2', '2.0.0', {}, [], 'forge');
  const forgeUser = record('forgeuser', 'forgeuser1', '1.0.0', {
    dependencies: { forgeuser: [{ modId: 'forgelib', versionRange: '[2,3)', mandatory: true, side: 'BOTH' }] },
  }, [{ project_id: 'forgelib', version_id: null, dependency_type: 'required' }], 'forge');
  const forge = fixture([[forgeOld, false]], 'forge');
  const forgeBefore = { bytes: forge.bytes(), ledger: forge.ledger() };
  const forgeResult = await install(forge.id, { projectId: 'forgeuser', versionId: forgeUser.id, type: 'mod' });
  check('Forge native ranges resolve through public install and preserve root intent', !forgeResult.error
    && forgeResult.solver.status === 'ok' && forgeResult.solver.changes.changed[0].to.versionId === forgeNew.id
    && candidate(forge.id).files.find((s) => s.entry.projectId === 'forgeuser').entry.via === 'direct'
    && candidate(forge.id).files.find((s) => s.entry.projectId === 'forgelib').entry.via === 'dependency');
  check('Forge whole-pack planning does not write live files or ledger', forge.bytes() === forgeBefore.bytes && forge.ledger() === forgeBefore.ledger);
  discard(forge.id);

  const neoOld = record('neolib', 'neolib1', '1.0.0', {}, [], 'neoforge');
  const neoNew = record('neolib', 'neolib2', '2.0.0', {}, [], 'neoforge');
  const neoUser = record('neouser', 'neouser1', '1.0.0', {
    dependencies: { neouser: [{ modId: 'neolib', versionRange: '[2,3)' }] },
  }, [{ project_id: 'neolib', version_id: null, dependency_type: 'required' }], 'neoforge');
  const neo = fixture([[neoOld, false]], 'neoforge');
  const neoBefore = { bytes: neo.bytes(), ledger: neo.ledger() };
  const neoResult = await install(neo.id, { projectId: 'neouser', versionId: neoUser.id, type: 'mod' });
  check('NeoForge native dependency type defaults reach public install without the legacy repair path', !neoResult.error
    && neoResult.solver.status === 'ok' && neoResult.solver.changes.changed[0].to.versionId === neoNew.id
    && candidate(neo.id).files.find(s => s.entry.projectId === 'neouser').entry.via === 'direct'
    && candidate(neo.id).files.find(s => s.entry.projectId === 'neolib').entry.via === 'dependency');
  check('NeoForge planning preserves live bytes and ledger before consent', neo.bytes() === neoBefore.bytes && neo.ledger() === neoBefore.ledger);
  discard(neo.id);
  mkdirSync(join(neo.dir, 'config'));
  writeFileSync(join(neo.dir, 'config/fml.toml'), '[dependencyOverrides]\nneouser=["-neolib"]\n');
  const overridden = await install(neo.id, { projectId: 'neouser', versionId: neoUser.id, type: 'mod' });
  check('NeoForge dependency overrides cannot produce a silently weakened feasible pack', overridden.error?.includes('dependency overrides')
    && candidate(neo.id)?.status === 'rejected' && neo.bytes() === neoBefore.bytes && neo.ledger() === neoBefore.ledger);

  const moduleLibrary = record('module_library', 'upstream-library-1', '1.0.0', {}, [], 'forge');
  const libraryZip = new AdmZip();
  libraryZip.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\nFMLModType: GAMELIBRARY\n\n'));
  const libraryBytes = libraryZip.toBuffer(), libraryFile = moduleLibrary.files[0];
  artifacts.set(libraryFile.url, libraryBytes);
  libraryFile.hashes = { sha1: sha(libraryBytes, 'sha1'), sha512: sha(libraryBytes, 'sha512') };
  libraryFile.size = libraryBytes.length;
  const renamed = fixture([[moduleLibrary]], 'forge');
  renameSync(join(renamed.dir, 'mods', libraryFile.filename), join(renamed.dir, 'mods', 'sync.jar'));
  updateLedger(renamed.id, entries => entries.map(entry => ({ ...entry, file: 'sync.jar' })));
  const sameModule = record('sync', 'sync1', '1.0.0', {}, [], 'forge');
  const moduleBefore = { bytes: renamed.bytes(), ledger: renamed.ledger() };
  const moduleResult = await install(renamed.id, { projectId: 'sync', versionId: sameModule.id, type: 'mod' });
  check('catalog-identified local Forge jars use their installed filenames for discovery', moduleResult.error
    && moduleResult.solver.status === 'inconclusive' && !moduleResult.solver.tentative
    && !candidate(renamed.id) && renamed.bytes() === moduleBefore.bytes && renamed.ledger() === moduleBefore.ledger);

  const kept = fixture([[lib2, false]]);
  const promoted = await install(kept.id, { projectId: 'testlib', versionId: lib2.id, type: 'mod' });
  check('explicitly requesting an existing dependency promotes its root without a version swap', !promoted.error
    && promoted.candidate.files[0].entry.via === 'direct' && promoted.solver.changes.changed.length === 0);
  discard(kept.id);

  const removed = fixture([[lib1]]);
  stage(removed.id, [{ file: lib1.files[0].filename, to: 'mods', remove: true }], () => {});
  const refused = await install(removed.id, { projectId: 'testuser', versionId: user.id, type: 'mod' });
  check('an explicit removal cannot be silently reinstalled as a dependency', refused.error && refused.solver.status === 'conflict'
    && candidate(removed.id).files.length === 1 && candidate(removed.id).files[0].remove);
  discard(removed.id);

  const clash = record('clashroot', 'clashroot1', '1.0.0', { breaks: { testlib: '*' } });
  const requested = fixture([[lib1]]);
  const clashResult = await install(requested.id, { projectId: 'clashroot', versionId: clash.id, type: 'mod' });
  check('a conflicting requested mod is refused, never dropped to claim success', clashResult.error && clashResult.solver.status === 'conflict'
    && !candidate(requested.id));

  const raceUser = record('raceuser', 'raceuser1', '1.0.0');
  const raced = fixture([[lib1]]);
  onDomain = () => { onDomain = undefined; writeFileSync(join(raced.dir, 'mods', 'concurrent.jar'), artifacts.get(clash.files[0].url)); };
  const racedResult = await install(raced.id, { projectId: 'raceuser', versionId: raceUser.id, type: 'mod' });
  check('an inventory changed during planning refuses the stale write', racedResult.error?.includes('pack changed') && !candidate(raced.id));

  const tampered = record('badbytes', 'badbytes1', '1.0.0');
  artifacts.set(tampered.files[0].url, Buffer.from('wrong bytes'));
  const empty = fixture([]);
  const badResult = await install(empty.id, { projectId: 'badbytes', versionId: tampered.id, type: 'mod' });
  check('CDN bytes must match both hashes and size before staging', badResult.error?.includes('checksum') && !candidate(empty.id) && empty.bytes() === '[]');
  for (const field of ['sha512', 'size']) {
    const altered = record(`bad_${field}`, `bad_${field}1`, '1.0.0');
    if (field === 'sha512') altered.files[0].hashes.sha512 = '0'.repeat(128);
    else altered.files[0].size++;
    const refused = await install(empty.id, { projectId: altered.project_id, versionId: altered.id, type: 'mod' });
    check(`correct SHA-1 cannot bypass the declared ${field}`, refused.error?.includes('checksum') && !candidate(empty.id));
  }

  const bounded = new NetworkCatalog({ mc: '1.21.1', loader: 'fabric' }, new Map(), { downloads: 0, bytes: 1 });
  await assert.rejects(bounded.artifact(lib1), /download limit/);
  check('download exhaustion never yields a partial installed pack', !existsSync(join(PATHS.data, 'candidates', empty.id)));

  const unknown = fixture([[clash]]);
  updateLedger(unknown.id, () => []);
  const unknownResult = await solveCandidate(unknown.id);
  check('unidentified local jars remain immutable requested pins', !unknownResult.error
    && unknownResult.solver.plan.length === 1 && unknownResult.solver.plan[0].requested
    && unknownResult.solver.plan[0].projectId.startsWith('local:') && !candidate(unknown.id));

  const exactRoot = fixture([[lib1]]);
  assert.ok(!(await install(exactRoot.id, { projectId: 'testlib', versionId: lib2.id, type: 'mod' })).error);
  const downgrade = record('downgrader', 'downgrader1', '1.0.0', { depends: { testlib: '<2' } },
    [{ project_id: 'testlib', version_id: null, dependency_type: 'required' }]);
  const pinnedResult = await install(exactRoot.id, { projectId: 'downgrader', versionId: downgrade.id, type: 'mod' });
  check('later requests cannot discard an earlier exact owner version pin', pinnedResult.solver.status === 'conflict'
    && candidate(exactRoot.id).requests.some((r) => r.projectId === 'testlib' && r.versionId === lib2.id));
  discard(exactRoot.id);

  const oldAlias = record('renamelib', 'renamelib1', '1.0.0', { id: 'old_alias' });
  const newAlias = record('renamelib', 'renamelib2', '2.0.0', { provides: ['old_alias'] });
  const aliasUser = record('aliasuser', 'aliasuser1', '1.0.0', { depends: { renamelib: '*' } },
    [{ project_id: 'renamelib', version_id: null, dependency_type: 'required' }]);
  const aliasFixture = fixture([[oldAlias]]);
  const tentative = await install(aliasFixture.id, { projectId: 'aliasuser', versionId: aliasUser.id, type: 'mod' });
  check('a complete feasible plan with unknown optimality is staged with its warning', !tentative.error
    && tentative.solver.status === 'inconclusive' && tentative.solver.tentative.changes.changed.length === 1
    && tentative.solver.tentative.plan.some((p) => p.versionId === newAlias.id) && tentative.warnings.some((w) => w.includes('fewer replacements')));
  const revalidated = await solveCandidate(aliasFixture.id);
  check('revalidation uses the original live basis and retains inconclusive optimality', !revalidated.error && !revalidated.candidate
    && revalidated.solver.status === 'inconclusive' && revalidated.solver.tentative.changes.changed.length === 1
    && candidate(aliasFixture.id).requests.some((r) => r.versionId === aliasUser.id));
  discard(aliasFixture.id);

  const localRemoval = fixture([[lib2]]);
  updateLedger(localRemoval.id, () => []);
  stage(localRemoval.id, [{ file: lib2.files[0].filename, to: 'mods', remove: true }], () => {});
  const localRemoved = await install(localRemoval.id, { projectId: 'testuser', versionId: user.id, type: 'mod' });
  check('removing an unidentified jar cannot silently reinstall its mod from a catalog', localRemoved.error
    && candidate(localRemoval.id).files.length === 1 && candidate(localRemoval.id).files[0].remove);
  discard(localRemoval.id);

  const orphan = record('oldorphan', 'oldorphan1', '1.0.0');
  const breaker = record('breaker', 'breaker1', '1.0.0', { breaks: { oldorphan: '*' } });
  const compatible = record('breaker', 'breaker2', '2.0.0');
  const orphanFixture = fixture([[orphan, false]]);
  const drop = await install(orphanFixture.id, { projectId: 'breaker', versionId: breaker.id, type: 'mod' });
  check('a conflicting dependency-only artifact is proposed for consented removal', !drop.error
    && drop.candidate.files.some((f) => f.file === orphan.files[0].filename && f.remove && f.automatic));
  const sameDrop = await solveCandidate(orphanFixture.id);
  check('the same removal plan does not restage forever during preflight', !sameDrop.error && !sameDrop.candidate);
  const keep = await install(orphanFixture.id, { projectId: 'breaker', versionId: compatible.id, type: 'mod' });
  check('an automatic removal proposal does not become an owner exclusion', !keep.error
    && keep.candidate.files.some((f) => f.file === orphan.files[0].filename && !f.remove));
  discard(orphanFixture.id);

  const restored1 = record('restored_library', 'restored_library1', '1.0.0');
  const restored2 = record('restored_library', 'restored_library2', '2.0.0');
  restored2.files[0].filename = restored1.files[0].filename;
  const withoutLibrary = record('restore_root', 'restore_root1', '1.0.0', { breaks: { restored_library: '*' } });
  const withLibrary = record('restore_root', 'restore_root2', '2.0.0', { depends: { restored_library: '>=2' } },
    [{ project_id: restored1.project_id, version_id: null, dependency_type: 'required' }]);
  const restoration = fixture([[restored1, false]]);
  assert.ok(!(await install(restoration.id, { projectId: withoutLibrary.project_id, versionId: withoutLibrary.id, type: 'mod' })).error);
  const restored = await install(restoration.id, { projectId: withLibrary.project_id, versionId: withLibrary.id, type: 'mod' });
  check('restoring different bytes under the same filename retains replacement consent', !restored.error
    && restored.candidate.files.some((f) => f.file === restored1.files[0].filename && f.replaces === f.file && !f.remove));
  assert.ok(!(await solveCandidate(restoration.id)).error);
  check('a retest cannot erase same-filename replacement consent', candidate(restoration.id).files.some((f) => f.file === restored1.files[0].filename && f.replaces === f.file));
  discard(restoration.id);

  const shared1 = record('shared_name', 'shared_name1', '1.0.0');
  const shared2 = record('shared_name', 'shared_name2', '2.0.0');
  const shared3 = record('shared_name', 'shared_name3', '3.0.0');
  shared2.files[0].filename = shared3.files[0].filename = 'shared.jar';
  const sameName = fixture([[shared1]]);
  assert.ok(!(await install(sameName.id, { projectId: shared2.project_id, versionId: shared2.id, type: 'mod' })).error);
  const restaged = await install(sameName.id, { projectId: shared3.project_id, versionId: shared3.id, type: 'mod' });
  check('restaging a shared filename retains the original live predecessor and publishes the requested bytes', !restaged.error
    && candidate(sameName.id).files.length === 1 && candidate(sameName.id).files[0].replaces === shared1.files[0].filename
    && candidate(sameName.id).files[0].entry.versionId === shared3.id
    && readFileSync(stagingPath(sameName.id, 'shared.jar')).equals(artifacts.get(shared3.files[0].url)));
  discard(sameName.id);

  const uploaded = fixture([[lib1]]);
  writeFileSync(stagingPath(uploaded.id, lib1.files[0].filename), artifacts.get(lib2.files[0].url));
  stage(uploaded.id, [{ file: lib1.files[0].filename, replaces: lib1.files[0].filename, to: 'mods' }], () => {});
  const uploadedResult = await solveCandidate(uploaded.id);
  check('an explicit upload replacement retains its native mod as an immutable local root', !uploadedResult.error
    && uploadedResult.solver.plan.length === 1 && uploadedResult.solver.plan[0].projectId === 'local:testlib'
    && uploadedResult.solver.plan[0].sha1 === lib2.files[0].hashes.sha1 && uploadedResult.solver.plan[0].requested
    && !candidate(uploaded.id).files[0].entry && candidate(uploaded.id).files[0].replaces === lib1.files[0].filename);
  deleteInstalled(uploaded.id, lib1.files[0].filename);
  const deletedUpload = await solveCandidate(uploaded.id);
  check('deleting an uploaded replacement removes its stale local request', !deletedUpload.error
    && deletedUpload.solver.plan.length === 0 && candidateSet(uploaded.id, candidate(uploaded.id)).serverJars.length === 0
    && sha(readFileSync(join(uploaded.dir, 'mods', lib1.files[0].filename)), 'sha1') === lib1.files[0].hashes.sha1);
  writeFileSync(stagingPath(uploaded.id, lib1.files[0].filename), artifacts.get(clash.files[0].url));
  stage(uploaded.id, [{ file: lib1.files[0].filename, replaces: lib1.files[0].filename, to: 'mods' }], () => {});
  const wrongUpload = await solveCandidate(uploaded.id);
  check('an upload cannot silently replace a requested mod with a different native identity', wrongUpload.error?.includes('native mod identity')
    && sha(readFileSync(join(uploaded.dir, 'mods', lib1.files[0].filename)), 'sha1') === lib1.files[0].hashes.sha1);
  discard(uploaded.id);

  const renamedUpload = fixture([[lib1]]);
  updateLedger(renamedUpload.id, () => []);
  const renamedBefore = renamedUpload.bytes();
  writeFileSync(stagingPath(renamedUpload.id, lib2.files[0].filename), artifacts.get(lib2.files[0].url));
  stage(renamedUpload.id, [{ file: lib2.files[0].filename, to: 'mods' }], () => {});
  const renamedResult = await solveCandidate(renamedUpload.id);
  check('a renamed local update reconciles the old jar and requires replacement consent', !renamedResult.error
    && candidateSet(renamedUpload.id, candidate(renamedUpload.id)).serverJars.length === 1
    && candidate(renamedUpload.id).files.some((f) => f.file === lib2.files[0].filename && f.replaces === lib1.files[0].filename)
    && renamedUpload.bytes() === renamedBefore);
  deleteInstalled(renamedUpload.id, lib1.files[0].filename);
  const cancelledLocal = await solveCandidate(renamedUpload.id);
  check('removing a local root also cancels its renamed staged replacement', !cancelledLocal.error
    && cancelledLocal.solver.plan.length === 0 && candidateSet(renamedUpload.id, candidate(renamedUpload.id)).serverJars.length === 0
    && renamedUpload.bytes() === renamedBefore);
  discard(renamedUpload.id);

  const blocked = fixture([]);
  setRevisionState(blocked.id, { managedHosting: true });
  const locked = revisionDir(blocked.id, 'mismatch');
  mkdirSync(locked, { recursive: true });
  writeFileSync(join(locked, 'lock.json'), JSON.stringify({ schema: 1, id: 'mismatch', loader: 'fabric', files: [] }));
  writeFileSync(join(locked, 'report.json'), JSON.stringify({ tests: { solver: { result: 'failed', detail: 'inventory mismatch' } } }));
  const candidateFile = join(PATHS.data, 'candidates', blocked.id, 'candidate.json');
  mkdirSync(join(PATHS.data, 'candidates', blocked.id), { recursive: true });
  const mismatch = { txn: 'mismatch', revision: 'mismatch', baseline: 'baseline', files: [], detail: '', updatedAt: '' };
  writeFileSync(candidateFile, JSON.stringify({ ...mismatch, status: 'needs-approval' }));
  await assert.rejects(approve(blocked.id, () => {}, true, 'mismatch'), /solver inventory check must pass/);
  check('consent cannot override a failed exact-revision solver inventory check', candidate(blocked.id).status === 'needs-approval');
  writeFileSync(candidateFile, JSON.stringify({ ...mismatch, status: 'ready' }));
  await assert.rejects(applyReady(blocked.id, 'mismatch', () => {}), /solver inventory check must pass/);
  check('promotion rechecks the mandatory solver inventory gate', candidate(blocked.id).status === 'ready' && blocked.bytes() === '[]');

  const collision = record('collision', 'collision1', '1.0.0');
  const original = record('collide_original', 'collide_original1', '1.0.0');
  collision.files[0].filename = original.files[0].filename.slice(0, -4).toUpperCase() + '.jar';
  const collideFixture = fixture([[original]]);
  const collided = await install(collideFixture.id, { projectId: 'collision', versionId: collision.id, type: 'mod' });
  check('case-insensitive artifact collisions cannot overwrite a requested mod', collided.solver.status === 'conflict' && !candidate(collideFixture.id));

  const obsolete = record('staged_dependency', 'staged_dependency1', '1.0.0');
  const sequence1 = record('sequence', 'sequence1', '1.0.0', { depends: { staged_dependency: '*' } },
    [{ project_id: obsolete.project_id, version_id: null, dependency_type: 'required' }]);
  const sequence2 = record('sequence', 'sequence2', '2.0.0', { breaks: { staged_dependency: '*' } });
  const sequence = fixture([]);
  assert.ok(!(await install(sequence.id, { projectId: sequence1.project_id, versionId: sequence1.id, type: 'mod' })).error);
  stageConfig(sequence.id, 'config/retained.json', Buffer.from('{}'), () => {});
  const revised = await install(sequence.id, { projectId: sequence2.project_id, versionId: sequence2.id, type: 'mod' });
  check('later requests remove obsolete staged dependencies and preserve config proposals', !revised.error
    && candidateSet(sequence.id, candidate(sequence.id)).serverJars.length === 1
    && candidate(sequence.id).files.some((f) => f.path === 'config/retained.json')
    && !existsSync(join(PATHS.data, 'candidates', sequence.id, 'files', obsolete.files[0].filename)));
  const stableSequence = await solveCandidate(sequence.id);
  check('the reconciled inventory matches its witness and is stable on retest', !stableSequence.error && !stableSequence.candidate
    && stableSequence.solver.plan.length === 1 && sequence.bytes() === '[]');
  discard(sequence.id);

  const cancelled = fixture([[lib1]]);
  assert.ok(!(await install(cancelled.id, { projectId: lib2.project_id, versionId: lib2.id, type: 'mod' })).error);
  deleteInstalled(cancelled.id, lib1.files[0].filename);
  const afterRemoval = await solveCandidate(cancelled.id);
  check('an explicit removal cancels a staged replacement of that same live mod', !afterRemoval.error
    && afterRemoval.solver.plan.length === 0 && candidateSet(cancelled.id, candidate(cancelled.id)).serverJars.length === 0
    && candidate(cancelled.id).files.every((f) => f.remove) && readdirSync(join(cancelled.dir, 'mods')).length === 1);
  discard(cancelled.id);

  const cfLibrary = record('cflibrary', 'cflibrary1', '1.0.0');
  const cfFile = (id, modId = 812) => ({ id, modId, displayName: `file-${id}`, fileName: `${id}.jar`,
    downloadUrl: cfLibrary.files[0].url, fileDate: '2026-01-01T00:00:00Z', fileLength: cfLibrary.files[0].size,
    gameVersions: ['1.21.1', 'Fabric'], hashes: [{ algo: 1, value: cfLibrary.files[0].hashes.sha1 }], dependencies: [], releaseType: 1 });
  const pages = new Map();
  cf.get('https://api.curseforge.com').intercept({ path: /^\/v1\/mods\/812\/files\?/ }).reply(200, (opts) => {
    const offset = Number(new URL(opts.path, 'https://api.curseforge.com').searchParams.get('index'));
    return pages.get(offset);
  }).persist();
  pages.set(0, { data: Array.from({ length: 50 }, (_, i) => cfFile(i + 1)), pagination: { index: 0, totalCount: 51 } });
  pages.set(50, { data: [cfFile(51)], pagination: { index: 50, totalCount: 51 } });
  const cfCatalog = new NetworkCatalog({ mc: '1.21.1', loader: 'fabric' });
  const cfDomain = await cfCatalog.versions('cf:812');
  check('CurseForge domains include versions beyond the first page with exact source IDs', cfDomain.length === 51
    && cfDomain[50].id === 'cf:51' && cfDomain[50].project_id === 'cf:812');
  pages.set(50, { data: [], pagination: { index: 50, totalCount: 51 } });
  await assert.rejects(new NetworkCatalog({ mc: '1.21.1', loader: 'fabric' }).versions('cf:812'), /ended before/);
  check('an incomplete CurseForge page cannot masquerade as a complete domain', true);
  cf.get('https://api.curseforge.com').intercept({ path: '/v1/mods/files', method: 'POST', body: JSON.stringify({ fileIds: [99] }) })
    .reply(200, { data: [cfFile(98)] });
  await assert.rejects(cfCatalog.version('cf:99'), /exact file ID/);
  check('an exact CurseForge file request never substitutes a different ID', true);
  cf.get('https://api.curseforge.com').intercept({ path: '/v1/mods/files', method: 'POST', body: JSON.stringify({ fileIds: [100] }) })
    .reply(200, { data: [{ ...cfFile(100), downloadUrl: null }] });
  const manual = await cfCatalog.version('cf:100');
  await assert.rejects(cfCatalog.artifact(manual), /manual download/);
  check('author-disabled CurseForge downloads remain explicit manual work, never cross-source replacements', cfCatalog.manualDownloads.length === 1);

  for (const loader of ['fabric', 'forge', 'neoforge']) {
    const wrong = record(`repair_${loader}`, `wrong_${loader}`, '1.0.0', {}, [], loader === 'fabric' ? 'neoforge' : 'fabric');
    const right = record(`repair_${loader}`, `right_${loader}`, '1.0.0', {}, [], loader);
    const target = fixture([], loader);
    const live = target.bytes(), ledger = target.ledger();
    writeFileSync(stagingPath(target.id, wrong.files[0].filename), artifacts.get(wrong.files[0].url));
    stage(target.id, [{ file: wrong.files[0].filename, to: 'mods' }], () => {});
    const repaired = await repairCandidate(target.id, () => {});
    const result = await solveCandidate(target.id);
    check(`${loader} wrong-loader repair retains the source project and exact compatible build, without changing live bytes`, repaired && !result.error
      && result.solver.plan.some((p) => p.projectId === right.project_id && p.versionId === right.id && p.requested)
      && candidate(target.id).files.every((f) => f.file !== wrong.files[0].filename)
      && candidate(target.id).repairs[0].kind === 'wrong-loader' && target.bytes() === live && target.ledger() === ledger);
    discard(target.id);

    const pinned = fixture([], loader);
    writeFileSync(stagingPath(pinned.id, wrong.files[0].filename), artifacts.get(wrong.files[0].url));
    stage(pinned.id, [{ file: wrong.files[0].filename, to: 'mods' }], () => {}, { requests: [{ projectId: wrong.project_id, versionId: wrong.id }] });
    await assert.rejects(repairCandidate(pinned.id, () => {}), /exact owner pin/);
    check(`${loader} wrong-loader repair cannot replace an exact owner pin`, !candidate(pinned.id).repairs && candidate(pinned.id).files[0].file === wrong.files[0].filename);
    discard(pinned.id);
  }

  const compatibleRepair = fixture([[lib1]]);
  const foreign = record('testlib', 'testlib-foreign3', '3.0.0', {}, [], 'forge');
  writeFileSync(stagingPath(compatibleRepair.id, foreign.files[0].filename), artifacts.get(foreign.files[0].url));
  stage(compatibleRepair.id, [{ file: foreign.files[0].filename, to: 'mods' }], () => {});
  assert.equal(await repairCandidate(compatibleRepair.id, () => {}), true);
  const retained = await solveCandidate(compatibleRepair.id);
  check('wrong-loader repair reuses the installed compatible version instead of gratuitously upgrading it', !retained.error
    && retained.solver.plan.length === 1 && retained.solver.plan[0].versionId === lib1.id);
  discard(compatibleRepair.id);

  for (const alreadyStaged of [false, true]) {
    const chained = fixture([[lib1]]);
    if (alreadyStaged) {
      writeFileSync(stagingPath(chained.id, lib2.files[0].filename), artifacts.get(lib2.files[0].url));
      stage(chained.id, [{ file: lib2.files[0].filename, to: 'mods', replaces: lib1.files[0].filename,
        entry: { ...ledgerEntries(chained.id)[0], file: lib2.files[0].filename, versionId: lib2.id, sha1: lib2.files[0].hashes.sha1 } }], () => {});
    }
    writeFileSync(stagingPath(chained.id, foreign.files[0].filename), artifacts.get(foreign.files[0].url));
    stage(chained.id, [{ file: foreign.files[0].filename, to: 'mods', replaces: alreadyStaged ? undefined : lib1.files[0].filename }], () => {});
    assert.equal(await repairCandidate(chained.id, () => {}), true);
    const result = await solveCandidate(chained.id);
    check(`wrong-loader repair preserves the live replacement chain with compatible build ${alreadyStaged ? 'already staged' : 'not staged'}`, !result.error
      && candidate(chained.id).files.length === 1 && candidate(chained.id).files[0].replaces === lib1.files[0].filename
      && candidateSet(chained.id, candidate(chained.id)).serverJars.length === 1
      && result.solver.plan[0].versionId === lib2.id);
    discard(chained.id);
  }

  const aliasOnly = fixture([]);
  const aliasWrong = record('alias_repair', 'alias-wrong', '1.0.0', {}, [], 'forge');
  record('alias_repair', 'alias-right', '1.0.0', { id: 'different_primary', provides: ['alias_repair'] });
  writeFileSync(stagingPath(aliasOnly.id, aliasWrong.files[0].filename), artifacts.get(aliasWrong.files[0].url));
  stage(aliasOnly.id, [{ file: aliasWrong.files[0].filename, to: 'mods' }], () => {});
  await assert.rejects(repairCandidate(aliasOnly.id, () => {}), /no identity-preserving compatible build/);
  check('a same-project provides alias cannot replace the original native identity', !candidate(aliasOnly.id).repairs);
  discard(aliasOnly.id);

  const racedRepair = fixture([]);
  const racedWrong = record('raced_repair', 'raced-wrong', '1.0.0', {}, [], 'forge');
  record('raced_repair', 'raced-right', '1.0.0');
  writeFileSync(stagingPath(racedRepair.id, racedWrong.files[0].filename), artifacts.get(racedWrong.files[0].url));
  stage(racedRepair.id, [{ file: racedWrong.files[0].filename, to: 'mods' }], () => {});
  onDomain = () => { onDomain = undefined; writeFileSync(stagingPath(racedRepair.id, racedWrong.files[0].filename), artifacts.get(lib2.files[0].url)); };
  await assert.rejects(repairCandidate(racedRepair.id, () => {}), /candidate changed/);
  check('concurrent candidate byte changes invalidate a pending repair without consuming an attempt', !candidate(racedRepair.id).repairs);
  discard(racedRepair.id);

  const copies = fixture([[lib1]]);
  const copiesBefore = copies.bytes(), copiesLedger = copies.ledger();
  const uploadCopy = (name) => {
    writeFileSync(stagingPath(copies.id, name), artifacts.get(lib1.files[0].url));
    stage(copies.id, [{ file: name, to: 'mods' }], () => {});
  };
  uploadCopy('aaa-copy.jar');
  assert.equal(await repairCandidate(copies.id, () => {}), true);
  const deduped = await solveCandidate(copies.id);
  check('byte-identical deduplication retains the managed requested mod and its source pin', !deduped.error && deduped.solver.plan.length === 1
    && deduped.solver.plan[0].projectId === lib1.project_id && deduped.solver.plan[0].versionId === lib1.id
    && candidate(copies.id).files.find((f) => f.file === 'aaa-copy.jar').duplicateOf === lib1.files[0].filename
    && copies.bytes() === copiesBefore && copies.ledger() === copiesLedger);
  uploadCopy('aaa-copy.jar');
  await assert.rejects(repairCandidate(copies.id, () => {}), /repeated plan/);
  check('reintroducing an earlier inventory stops the automatic repair loop', candidate(copies.id).repairs.length === 1 && candidate(copies.id).files.some((f) => !f.remove && f.file === 'aaa-copy.jar'));
  discard(copies.id);

  const liveCopies = fixture([[lib1]]);
  writeFileSync(join(liveCopies.dir, 'mods', 'live-copy.jar'), artifacts.get(lib1.files[0].url));
  stage(liveCopies.id, [], () => {});
  assert.equal(await repairCandidate(liveCopies.id, () => {}), true);
  const liveDedup = await solveCandidate(liveCopies.id);
  check('a live duplicate proposal does not exclude the surviving native identity', !liveDedup.error && liveDedup.solver.plan.length === 1
    && liveDedup.solver.plan[0].projectId === lib1.project_id && readdirSync(join(liveCopies.dir, 'mods')).length === 2);
  discard(liveCopies.id);

  const scopes = fixture([[lib1]]);
  writeFileSync(stagingPath(scopes.id, 'shelf-copy.jar'), artifacts.get(lib1.files[0].url));
  stage(scopes.id, [{ file: 'shelf-copy.jar', to: 'shelf', entry: { ...ledgerEntries(scopes.id)[0], file: 'shelf-copy.jar', clientOnly: true } }], () => {});
  check('deduplication cannot replace server functionality with an identical client-shelf jar', !await repairCandidate(scopes.id, () => {})
    && !candidate(scopes.id).repairs && candidateSet(scopes.id, candidate(scopes.id)).serverJars.length === 1);
  discard(scopes.id);

  const repairBound = fixture([[lib1]]);
  for (let n = 0; n < 4; n++) {
    const file = `bounded-copy-${n}.jar`;
    writeFileSync(stagingPath(repairBound.id, file), artifacts.get(lib1.files[0].url));
    stage(repairBound.id, [{ file, to: 'mods' }], () => {});
  }
  for (let n = 0; n < 3; n++) assert.equal(await repairCandidate(repairBound.id, () => {}), true);
  await assert.rejects(repairCandidate(repairBound.id, () => {}), /three attempts/);
  check('three persisted repair attempts cannot become a fourth candidate mutation', candidate(repairBound.id).repairs.length === 3
    && candidateSet(repairBound.id, candidate(repairBound.id)).serverJars.length === 2);
  discard(repairBound.id);

  const distinct = fixture([[lib1]]);
  writeFileSync(stagingPath(distinct.id, lib2.files[0].filename), artifacts.get(lib2.files[0].url));
  stage(distinct.id, [{ file: lib2.files[0].filename, to: 'mods' }], () => {});
  check('different versions with the same mod ID are not silently deduplicated', !await repairCandidate(distinct.id, () => {}) && !candidate(distinct.id).repairs);
  discard(distinct.id);

  const nestedParents = fixture([]);
  for (const id of ['parent_one', 'parent_two']) {
    const parent = new AdmZip();
    parent.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ schemaVersion: 1, id, version: '1.0.0', jars: [{ file: 'nested.jar' }] })));
    parent.addFile('nested.jar', artifacts.get(lib1.files[0].url));
    writeFileSync(stagingPath(nestedParents.id, `${id}.jar`), parent.toBuffer());
    stage(nestedParents.id, [{ file: `${id}.jar`, to: 'mods' }], () => {});
  }
  check('distinct parent jars sharing an identical nested mod are not duplicate removals', !await repairCandidate(nestedParents.id, () => {})
    && !candidate(nestedParents.id).repairs && candidateSet(nestedParents.id, candidate(nestedParents.id)).serverJars.length === 2);
  discard(nestedParents.id);

  const runtime = fixture([]);
  const jar = new AdmZip();
  jar.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'runtime_repair', version: '1.0.0' })));
  jar.addFile('probe/Needs25.class', Buffer.from('cafebabe00000045', 'hex'));
  writeFileSync(stagingPath(runtime.id, 'runtime-repair.jar'), jar.toBuffer());
  stage(runtime.id, [{ file: 'runtime-repair.jar', to: 'mods' }], () => {}, { java: join(root, 'Tools', 'jdk-21-fixture', 'bin', process.platform === 'win32' ? 'java.exe' : 'java') });
  const diagnostic = 'java.lang.UnsupportedClassVersionError: probe/Needs25 has been compiled by a more recent version of the Java Runtime (class file version 69.0), this version of the Java Runtime only recognizes class file versions up to 65.0';
  await assert.rejects(repairCandidate(runtime.id, () => {}, diagnostic.replace('probe/Needs25', 'probe/NotInPack')), /one matching class/);
  await assert.rejects(repairCandidate(runtime.id, () => {}, diagnostic.replace('version 69.0', 'version 68.0')), /one matching class/);
  check('crash text alone or a mismatched class header cannot authorize a Java repair', !candidate(runtime.id).repairs);
  assert.equal(await repairCandidate(runtime.id, () => {}, diagnostic), true);
  check('class-file evidence proposes Java 25 only in the candidate, retaining every jar', candidate(runtime.id).java.includes('jdk-25-fixture')
    && candidate(runtime.id).repairs[0].kind === 'wrong-java' && candidateSet(runtime.id, candidate(runtime.id)).serverJars.length === 1
    && runtime.bytes() === '[]');
  discard(runtime.id);

  const pack = fixture([]), packPath = join(root, 'required.mrpack'), artifact = lib1.files[0];
  const packIndex = { formatVersion: 1, name: 'required files', dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.20.1' },
    files: [{ path: 'mods/required.jar', downloads: [artifact.url], fileSize: artifact.size, hashes: artifact.hashes }] };
  const writePack = () => { const zip = new AdmZip(); zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(packIndex))); zip.writeZip(packPath); };
  writePack();
  const validPack = await installMrpackFile(pack.id, packPath);
  check('new modpacks install exact requested artifacts and can resume from verified bytes', !validPack.error && validPack.installed === 1
    && !(await installMrpackFile(pack.id, packPath)).error && sha(readFileSync(join(pack.dir, 'mods/required.jar')), 'sha512') === artifact.hashes.sha512);
  writeFileSync(join(pack.dir, 'mods/required.jar'), 'stale');
  check('a same-named stale file cannot make an incomplete modpack ready', (await installMrpackFile(pack.id, packPath)).error?.includes('checksum or size mismatch'));
  rmSync(join(pack.dir, 'mods/required.jar'));
  packIndex.files[0].hashes = { ...artifact.hashes, sha512: '0'.repeat(128) }; writePack();
  check('corrupt modpack downloads are refused without exposing partial jars', (await installMrpackFile(pack.id, packPath)).error?.includes('checksum')
    && !existsSync(join(pack.dir, 'mods/required.jar')) && !existsSync(join(pack.dir, 'mods/required.jar.part')));
  packIndex.files[0].hashes = artifact.hashes; writePack();
  const conflictingOverrides = new AdmZip(packPath); conflictingOverrides.addFile('server-overrides/mods/required.jar', Buffer.from('conflicting override')); conflictingOverrides.writeZip(packPath);
  check('overrides cannot replace a hash-locked required mod unnoticed', (await installMrpackFile(pack.id, packPath)).error?.includes('checksum or size mismatch'));
  rmSync(join(pack.dir, 'mods/required.jar'));
  packIndex.files[0].hashes = artifact.hashes; packIndex.files[0].downloads = ['https://fixture.invalid/v2/version/missing']; writePack();
  check('HTTP download failures remain errors rather than partial success', (await installMrpackFile(pack.id, packPath)).error?.includes('404'));

  const cfPack = join(root, 'required.zip');
  for (const [required, meta] of [[true, null], [true, { id: 701, modId: 702, fileName: 'required.jar', downloadUrl: null }], [false, null],
    [true, { id: 701, modId: 702, fileName: 'cf-required.jar', downloadUrl: artifact.url, fileLength: artifact.size, hashes: [{ algo: 1, value: artifact.hashes.sha1 }] }]]) {
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify({ name: 'CF required files', minecraft: { version: '1.21.1', modLoaders: [{ id: 'fabric-0.20.1' }] },
      files: [{ projectID: 702, fileID: 701, required }] })));
    zip.writeZip(cfPack);
    cf.get('https://api.curseforge.com').intercept({ path: '/v1/mods/files', method: 'POST', body: JSON.stringify({ fileIds: [701] }) }).reply(200, { data: meta ? [meta] : [] });
    const result = await installCurseforgeZipFile(pack.id, cfPack);
    check(`CurseForge ${required ? 'required' : 'optional'} ${meta?.downloadUrl ? 'verified' : meta ? 'disabled' : 'missing'} download preserves the pack requirement`, meta?.downloadUrl
      ? !result.error && result.installed === 1 && sha(readFileSync(join(pack.dir, 'mods/cf-required.jar')), 'sha1') === artifact.hashes.sha1
      : required ? !!result.error : !result.error && result.installed === 0 && result.warnings.some(w => w.includes('701')));
  }

  // Crafty layouts seen on real servers: a root options.txt in AutoModpack's
  // extras, the same jar byte-identical in mods/ and on the client shelf, and
  // a same-name jar whose bytes differ. None may break the pack inventory.
  check('extras accept exact client root files and still refuse other root, control and traversal paths',
    lockPath('options.txt', 'extra') === 'options.txt'
    && ['server.properties', '.spawnpoint-revision.json', 'automodpack-content.json', 'mods/../options.txt', './options.txt', 'sub/options.txt'].every((p) => { try { lockPath(p, 'extra'); return false; } catch { return true; } })
    && [['options.txt', 'server'], ['options.txt', 'shelf']].every(([p, l]) => { try { lockPath(p, l); return false; } catch { return true; } }));
  const shared = record('sharedmod', 'sharedmod1', '1.0.0');
  const dupOld = record('dupmod', 'dupmod-old', '1.0.0');
  const dupNew = record('dupmod', 'dupmod-new', '2.0.0');
  const crafty = fixture([[shared], [dupOld]]);
  const shelf = clientShelfDir(crafty.id);
  mkdirSync(shelf, { recursive: true });
  const sharedName = shared.files[0].filename, dupName = dupOld.files[0].filename;
  writeFileSync(join(shelf, sharedName), artifacts.get(shared.files[0].url));
  writeFileSync(join(shelf, dupName), artifacts.get(dupNew.files[0].url)); // same file name, newer bytes
  const main = join(crafty.dir, 'automodpack', 'host-modpack', 'main');
  mkdirSync(join(main, 'mods'), { recursive: true });
  writeFileSync(join(main, 'options.txt'), 'enableVsync:false\nmaxFps:260\nentityDistanceScaling:0.75\n');
  const live = crafty.bytes();
  const set = candidateSet(crafty.id, { files: [] });
  const rels = set.client.map((f) => f.rel);
  check('a root options.txt in the extras ships to clients', rels.includes('options.txt'));
  check('a byte-identical jar in mods/ and on the shelf is one client file, served from mods/', rels.filter((r) => r === `mods/${sharedName}`).length === 1
    && set.client.find((f) => f.rel === `mods/${sharedName}`).src === join(crafty.dir, 'mods', sharedName) && set.shelfCopies.length === 1 && set.shelfCopies[0] === join(shelf, sharedName));
  check('a same-name jar with different bytes is one pair: the server runs its copy, friends get only the shelf bytes', JSON.stringify(set.pairs) === JSON.stringify([dupName])
    && set.serverJars.includes(join(crafty.dir, 'mods', dupName)) && set.client.filter((f) => f.rel === `mods/${dupName}`).length === 1
    && set.client.find((f) => f.rel === `mods/${dupName}`).src === join(shelf, dupName));
  const dupes = duplicateMods(crafty.id);
  check('duplicate detection reads the layout and offers only the differing pair', dupes.length === 1 && dupes[0].id === 'dupmod'
    && dupes[0].keep.to === 'shelf' && dupes[0].keep.version === '2.0.0' && dupes[0].drop.length === 1 && dupes[0].drop[0].to === 'mods');
  assert.equal(keepNewest(crafty.id, () => {}), 1);
  const cleaned = candidateSet(crafty.id, candidate(crafty.id));
  check('Keep newest drops only the older side of a same-name pair and keeps the shared jar once',
    !cleaned.serverJars.includes(join(crafty.dir, 'mods', dupName)) && cleaned.client.some((f) => f.src === join(shelf, dupName))
    && cleaned.client.filter((f) => f.rel === `mods/${dupName}`).length === 1 && cleaned.client.filter((f) => f.rel === `mods/${sharedName}`).length === 1);
  check('staging the cleanup changes no live file', crafty.bytes() === live && existsSync(join(shelf, dupName)) && existsSync(join(main, 'options.txt')));
  const solvedPair = await solveCandidate(crafty.id);
  const afterPair = candidateSet(crafty.id, candidate(crafty.id));
  check('the solver accepts the cleanup: the ledger record stays with its own bytes and the newer shelf copy is not excluded', !solvedPair.error
    && candidate(crafty.id).files.some((f) => f.file === dupName && f.to === 'mods' && f.remove)
    && !candidate(crafty.id).files.some((f) => f.file === dupName && f.to === 'shelf' && f.remove)
    && !afterPair.serverJars.includes(join(crafty.dir, 'mods', dupName)) && afterPair.client.find((f) => f.rel === `mods/${dupName}`)?.src === join(shelf, dupName));
  discard(crafty.id);
  stage(crafty.id, [{ file: dupName, to: 'shelf', remove: true, duplicateOf: dupName }], () => {});
  const solvedServer = await solveCandidate(crafty.id);
  const serverWins = candidateSet(crafty.id, candidate(crafty.id));
  const staged = JSON.stringify(candidate(crafty.id).files);
  const again = await solveCandidate(crafty.id);
  check('removing the shelf side instead keeps the server copy for server and friends, stably across solves', !solvedServer.error && !again.error
    && candidate(crafty.id).files.some((f) => f.file === dupName && f.to === 'shelf' && f.remove) && JSON.stringify(candidate(crafty.id).files) === staged
    && serverWins.serverJars.includes(join(crafty.dir, 'mods', dupName)) && serverWins.client.filter((f) => f.rel === `mods/${dupName}`).length === 1
    && serverWins.client.find((f) => f.rel === `mods/${dupName}`)?.src === join(crafty.dir, 'mods', dupName));
  const dupNext = record('dupmod', 'dupmod-next', '3.0.0');
  writeFileSync(stagingPath(crafty.id, dupNext.files[0].filename), artifacts.get(dupNext.files[0].url));
  stage(crafty.id, [{ file: dupNext.files[0].filename, to: 'mods', replaces: dupName }], () => {});
  const updated = candidateSet(crafty.id, candidate(crafty.id));
  check('updating the kept server copy keeps the shelf-side removal', candidate(crafty.id).files.some((f) => f.file === dupName && f.to === 'shelf' && f.remove)
    && !updated.client.some((f) => f.rel === `mods/${dupName}`) && updated.serverJars.some((p) => p.endsWith(dupNext.files[0].filename)));
  discard(crafty.id);
  const unshared = candidateSet(crafty.id, { files: [{ file: sharedName, to: 'mods', remove: true }] });
  check('removing a byte-identical shared jar removes it for the server and friends', !unshared.serverJars.some((p) => p.endsWith(sharedName))
    && !unshared.client.some((f) => f.rel === `mods/${sharedName}`) && !unshared.shelfCopies.length);
  writeFileSync(join(main, 'servers.dat'), 'not a pack file');
  check('an unrecognised extras root file is a readable error, not a guess', (() => { try { candidateSet(crafty.id, { files: [] }); return false; } catch (e) { return /not a pack-owned path: extra\/servers\.dat/.test(String(e)); } })());
  rmSync(join(main, 'servers.dat'));

  // Real extraction, controlled archives: normalize a macOS bundle and retain
  // the ordinary flat layout. No fake Java process is presented as a boot.
  for (const feature of [21, 25]) {
    rmSync(join(root, 'Tools', `jdk-${feature}-fixture`));
    const name = `jdk-${feature}-archive`, bundle = feature === 21 ? 'Contents/Home/' : '';
    const java = process.platform === 'win32' ? 'java.exe' : 'java';
    const zip = new AdmZip(); zip.addFile(`${name}/${bundle}bin/${java}`, Buffer.from('fixture executable bytes'));
    let bytes = zip.toBuffer();
    if (process.platform !== 'win32') {
      const staging = join(root, `archive-${feature}`); mkdirSync(staging);
      zip.extractAllTo(staging);
      const file = join(root, `jdk-${feature}.tar.gz`);
      assert.equal(spawnSync('tar', ['-czf', file, '-C', staging, name]).status, 0);
      bytes = readFileSync(file);
    }
    const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
    const link = `https://fixture.invalid/jdk-${feature}`;
    artifacts.set(`https://api.adoptium.net/v3/assets/latest/${feature}/hotspot?architecture=${process.arch === 'arm64' ? 'aarch64' : 'x64'}&image_type=jdk&os=${os}&vendor=eclipse`,
      JSON.stringify([{ binary: { package: { link, checksum: sha(bytes, 'sha256'), size: bytes.length } } }]));
    // Adoptium's published SHA-256 gates extraction: altered bytes never land in Tools/
    artifacts.set(link, Buffer.concat([bytes, Buffer.from('tampered')]));
    check(`JDK ${feature} archive that differs from Adoptium's SHA-256 is refused`, !await ensureJdk(feature, () => {}) && !existsSync(join(root, 'Tools', name)));
    artifacts.set(link, bytes);
    check(`JDK ${feature} ${bundle ? 'macOS bundle' : 'flat archive'} becomes the shared Tools Java recipe`, await ensureJdk(feature, () => {})
      && javaFor(feature === 21 ? '1.20.1' : '26.1', feature === 21 ? 'forge' : 'fabric') === join(root, 'Tools', name, 'bin', java));
  }
  console.log(`\n${checks}/${checks} installer checks passed`);
} finally {
  globalThis.fetch = originalFetch;
  setGlobalDispatcher(originalDispatcher);
  await cf.close();
  for (const id of ids) discard(id);
  rmSync(root, { recursive: true, force: true });
}
