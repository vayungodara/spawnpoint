// Public install contract against real files and loader metadata. Only the
// external catalog/CDN is simulated; the live Crafty proof is separate.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
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
const { revisionDir, setRevisionState } = await tsImport('../server/src/services/revisions.ts', import.meta.url);
const { PATHS } = await tsImport('../server/src/config.ts', import.meta.url);
mkdirSync(join(root, 'Tools'), { recursive: true });
symlinkSync(javaHome, join(root, 'Tools', 'jdk-25-fixture'), process.platform === 'win32' ? 'junction' : 'dir');
mkdirSync(PATHS.data, { recursive: true });

const versions = new Map(), projects = new Map(), artifacts = new Map();
const sha = (bytes, algorithm) => createHash(algorithm).update(bytes).digest('hex');
const record = (project, id, number, fields = {}, relations = []) => {
  const zip = new AdmZip();
  zip.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ schemaVersion: 1, id: project, version: number, ...fields })));
  const bytes = zip.toBuffer();
  const file = { filename: `${id}.jar`, primary: true, size: bytes.length,
    url: `https://fixture.invalid/${id}.jar`, hashes: { sha1: sha(bytes, 'sha1'), sha512: sha(bytes, 'sha512') } };
  const version = { id, project_id: project, name: id, version_number: number, version_type: 'release',
    game_versions: ['1.21.1'], loaders: ['fabric'], date_published: number.startsWith('2') ? '2026-01-02T00:00:00Z' : '2026-01-01T00:00:00Z',
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
globalThis.fetch = async (url) => {
  const request = new URL(url);
  if (artifacts.has(request.href)) return new Response(artifacts.get(request.href));
  const path = decodeURIComponent(request.pathname).split('/');
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
const fixture = (items) => {
  const id = randomUUID(); ids.push(id);
  const dir = join(PATHS.craftyServers, id);
  mkdirSync(join(dir, 'mods'), { recursive: true });
  mkdirSync(join(dir, 'libraries/net/fabricmc/fabric-loader/0.20.1'), { recursive: true });
  const loader = new AdmZip(); loader.addFile('install.properties', Buffer.from('game-version=1.21.1'));
  writeFileSync(join(dir, 'fabric.jar'), loader.toBuffer());
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
  console.log(`\n${checks}/${checks} installer checks passed`);
} finally {
  globalThis.fetch = originalFetch;
  setGlobalDispatcher(originalDispatcher);
  await cf.close();
  for (const id of ids) discard(id);
  rmSync(root, { recursive: true, force: true });
}
