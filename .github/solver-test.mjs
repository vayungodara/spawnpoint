// Offline solver contract tests. Real responses and jar metadata are unchanged
// in recorded.json. Explicit counterfactuals below exercise hard-to-find edges.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { stringify } from 'smol-toml';
import { tsImport } from 'tsx/esm/api';

const { solve } = await tsImport('../server/src/services/solver/index.ts', import.meta.url);
const { readFabricJar, matchesFabric, compareFabricVersions } = await tsImport('../server/src/services/solver/fabric.ts', import.meta.url);
const { compareMavenVersions, matchesMaven, parseMavenRange, restrictMaven, containsMaven } = await tsImport('../server/src/services/solver/maven.ts', import.meta.url);
const { readForgeJar, validateForge } = await tsImport('../server/src/services/solver/forge.ts', import.meta.url);
const recorded = JSON.parse(readFileSync(new URL('./fixtures/solver/recorded.json', import.meta.url), 'utf8'));
const fails = [];
let checks = 0;
const check = (name, ok) => {
  checks++;
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}`);
  if (!ok) fails.push(name);
};
const zipRecord = ({ fabric, nested }) => {
  const zip = new AdmZip();
  zip.addFile('fabric.mod.json', Buffer.from(JSON.stringify(fabric)));
  for (const [file, child] of Object.entries(nested)) zip.addFile(file, zipRecord(child));
  return zip.toBuffer();
};
const raw = new Map(Object.entries(recorded.jars));
const real = recorded.versions;
const version = (id) => real.find((v) => v.id === id);
const pin = (v, requested = false) => {
  const file = v.files.find((f) => f.primary) ?? v.files[0];
  return { projectId: v.project_id, versionId: v.id, file: file.filename, sha1: file.hashes.sha1, requested };
};
const input = (installed = [], add = [], remove = []) => ({
  mc: '1.21.1', loader: 'fabric', java: '21.0.4', loaderVersion: '0.18.0', installed,
  add: add.map((v) => typeof v === 'string' ? { projectId: v } : v), remove,
});
const exact = (v) => ({ projectId: v.project_id, versionId: v.id });
const pick = (result, project) => result.plan?.find((p) => p.projectId === project)?.versionId;
const relation = (project, type = 'required', id = null) => ({ project_id: project, version_id: id, dependency_type: type });

// Counterfactual records retain Modrinth's shape, but are NOT presented as
// author-published releases. Their versions, ranges and relations are test data.
const model = (project, id, number, fields = {}, dependencies = []) => {
  const v = structuredClone(version('sOzRw3CG'));
  Object.assign(v, { project_id: project, id, name: id, version_number: number, dependencies,
    date_published: `2024-09-${number.startsWith('2') ? '20' : '10'}T00:00:00Z` });
  v.files[0].filename = `${id}.jar`;
  v.files[0].hashes.sha1 = '0'.repeat(40);
  raw.set(id, { fabric: { schemaVersion: 1, id: project, name: id, version: number, ...fields }, nested: {} });
  return v;
};
const catalog = (versions = real) => {
  const metas = new Map(versions.map((v) => [v.id, readFabricJar(zipRecord(raw.get(v.id)))]));
  const hasId = (record, id) => record.fabric.id === id || record.fabric.provides?.includes(id)
    || Object.values(record.nested).some((child) => hasId(child, id));
  return {
    versions: async (id) => versions.filter((v) => v.project_id === id),
    jarMeta: async (v) => metas.get(v.id),
    providers: async (id) => [...new Set(versions.filter((v) => hasId(raw.get(v.id), id)).map((v) => v.project_id))],
    version: async (id) => versions.find((v) => v.id === id),
  };
};

const apiOld = version('bK6OgzFj');
const balmOld = version('Pz0YXByM'), balmNew = version('EghJxg4h');
const wayOld = version('pCpQ1Jxr'), wayNew = version('nSAwjAk4');
const ferrite = version('sOzRw3CG'), cloth = version('7jtvrmVP');

// Real 1.21.1 metadata, including the balm-fabric -> balm/provides transition.
let result = await solve(input([pin(apiOld), pin(balmNew)], [exact(wayOld)]), catalog());
check('1: adding Waystones keeps both compatible library pins', result.status === 'ok'
  && result.changes.changed.length === 0 && result.changes.added.length === 1
  && pick(result, apiOld.project_id) === apiOld.id && pick(result, balmNew.project_id) === balmNew.id);
result = await solve(input([pin(apiOld), pin(balmOld)], [exact(wayNew)]), catalog());
check('2: newer Waystones changes exactly Balm, preserving Fabric API', result.status === 'ok'
  && result.changes.changed.length === 1 && result.changes.changed[0].from.versionId === balmOld.id
  && result.changes.changed[0].to.versionId === balmNew.id && pick(result, apiOld.project_id) === apiOld.id);
result = await solve({ ...input([], [exact(wayNew)]), mc: '1.20.1' }, catalog());
check('4: no MC build is a readable conflict, even if catalog ignores the filter', result.status === 'conflict'
  && result.explanation.some((s) => s.includes('no build') && s.includes('1.20.1')));
const parsedApi = readFabricJar(zipRecord(raw.get(apiOld.id)));
check('reader retains real API aliases and all 48 nested metadata records', parsedApi.ids.includes('fabric')
  && parsedApi.nested.length === 48 && parsedApi.nested.some((m) => m.ids[0] === 'fabric-resource-loader-v0' && m.version === '1.3.0+565991296a'));
check('reader retains real breaks and OR predicates', readFabricJar(zipRecord(raw.get(ferrite.id))).breaks.hydrogen === '<=0.3'
  && Array.isArray(readFabricJar(zipRecord(raw.get('N08Z8wog'))).depends.minecraft));
const nonMod = new AdmZip(); nonMod.addFile('library.txt', Buffer.from('not a Fabric mod'));
const partial = new AdmZip();
partial.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'partial', version: '1',
  jars: [{ file: 'library.jar' }, { file: 'missing.jar' }] })));
partial.addFile('library.jar', nonMod.toBuffer());
check('reader ignores non-mod nested jars and missing declarations, like Fabric', readFabricJar(partial.toBuffer()).nested.length === 0);

const a1 = model('library', 'library-1', '1.0.0');
const a2 = model('library', 'library-2', '2.0.0');
const b1 = model('secondlib', 'secondlib-1', '1.0.0');
const b2 = model('secondlib', 'secondlib-2', '2.0.0');
const needsNew = model('consumer', 'consumer-1', '1.0.0', { depends: { library: '>=2 <3' } }, [relation('library')]);
result = await solve(input([pin(a1, true), pin(b1)], ['consumer']), catalog([a1, a2, b1, b2, needsNew]));
check('version range forces only the installed library upgrade (even if requested)', result.status === 'ok'
  && result.changes.changed.length === 1 && pick(result, 'library') === a2.id && pick(result, 'secondlib') === b1.id
  && result.plan.find((p) => p.projectId === 'library').requested);
const breaker = model('breaker', 'breaker-1', '1.0.0', { breaks: { library: '>=1 <2' } });
const hydrogen = model('hydrogen', 'hydrogen-fixture', '0.3');
result = await solve(input([pin(hydrogen, true)], [exact(ferrite)]), catalog([hydrogen, ferrite]));
check('3: breaks conflict names both mods and the offending range', result.status === 'conflict'
  && result.explanation.some((s) => s.includes('FerriteCore') && s.includes('hydrogen-fixture') && s.includes('<=0.3')));
result = await solve(input([pin(a1), pin(b1)], ['breaker']), catalog([a1, b1, breaker]));
check('dependency-only removal costs one change; unrelated orphan pins are kept', result.status === 'ok'
  && result.changes.removed.length === 1 && result.changes.removed[0].projectId === 'library'
  && pick(result, 'secondlib') === b1.id && result.changes.changed.length === 0);
result = await solve(input([pin(a1)], ['consumer']), catalog([a1, needsNew]));
check('an unsatisfied required dependency cannot be dropped to fake a valid plan', result.status === 'conflict');
const substitute = model('substitute', 'substitute-1', '1.0.0', { provides: ['library'] });
result = await solve(input([pin(a1, true)], ['breaker', 'substitute']), catalog([a1, breaker, substitute]));
check('5: requested project cannot be dropped or replaced by a provides alias', result.status === 'conflict');
result = await solve(input([pin(a1, true)], ['substitute'], ['library']), catalog([a1, substitute]));
check('explicit remove is the only way an installed requested project disappears', result.status === 'ok'
  && result.changes.removed.length === 1 && result.changes.removed[0].versionId === a1.id);
result = await solve(input([pin(a1)], ['consumer'], ['library']), catalog([a1, needsNew]));
check('required dependencies cannot silently reinstall an explicitly removed project', result.status === 'conflict');

for (const [name, limits] of [
  ['nodes', { maxNodes: 1 }], ['catalog calls', { maxCatalogCalls: 1 }], ['time', { maxMs: 0 }],
]) {
  result = await solve(input([], [exact(ferrite)]), catalog(), limits);
  check(`6: ${name} exhaustion is inconclusive, never conflict`, result.status === 'inconclusive');
}
result = await solve(input([], [exact(ferrite)]), { ...catalog(), versions: () => new Promise(() => {}) }, { maxMs: 15 });
check('elapsed limit also bounds a catalog promise that never settles', result.status === 'inconclusive' && /time/i.test(result.reason));

const aliasUser = model('aliasuser', 'aliasuser-1', '1.0.0', { depends: { 'cloth-config2': '>=15 <16' } });
result = await solve(input([pin(cloth)], ['aliasuser']), catalog([cloth, aliasUser]));
check('7a: real provides alias inherits jar version and adds no library', result.status === 'ok'
  && result.plan.length === 2 && result.changes.added.length === 1);
const nestedUser = model('nesteduser', 'nesteduser-1', '1.0.0', { depends: { 'fabric-resource-loader-v0': '>=1.3 <1.4' } });
result = await solve(input([pin(apiOld)], ['nesteduser']), catalog([apiOld, nestedUser]));
check('7b: real nested jar satisfies a versioned dependency without a separate install', result.status === 'ok'
  && result.plan.length === 2 && result.changes.added.length === 1);
const bundle = model('bundle', 'bundle-1', '1.0.0');
raw.get(bundle.id).fabric.jars = [{ file: 'nested.jar' }];
raw.get(bundle.id).nested['nested.jar'] = { fabric: {
  schemaVersion: 1, id: 'library', version: '1.0.0', depends: { absent: '>=1' },
}, nested: {} };
result = await solve(input([pin(a2)], ['bundle']), catalog([a2, bundle]));
check('nested copy is not an unconditional duplicate of a mandatory top-level mod', result.status === 'ok' && result.plan.length === 2);
const bundledUser = model('bundleduser', 'bundleduser-1', '1.0.0', { depends: { library: '>=1 <2' } });
result = await solve(input([], ['bundle', 'bundleduser']), catalog([bundle, bundledUser]));
check('a selected nested jar must satisfy its own transitive dependencies', result.status === 'conflict');
const transitive = model('absent', 'absent-1', '1.0.0');
result = await solve(input([], ['bundle', 'bundleduser']), catalog([bundle, bundledUser, transitive]));
check('Catalog.providers resolves and installs a nested jar transitive dependency', result.status === 'ok'
  && result.plan.length === 3 && pick(result, 'absent') === transitive.id);
result = await solve(input([pin(a2)], ['bundle', 'bundleduser']), catalog([bundle, a2, bundledUser]));
check('nested jar cannot shadow an incompatible mandatory top-level version', result.status === 'conflict');
const choices = model('nestedchoices', 'nestedchoices-1', '1.0.0');
const choiceUser = model('nestedchoiceuser', 'nestedchoiceuser-1', '1.0.0', { depends: { library: '*' } });
raw.get(choices.id).fabric.jars = [{ file: 'new.jar' }, { file: 'old.jar' }];
raw.get(choices.id).nested = {
  'new.jar': { fabric: { schemaVersion: 1, id: 'library', version: '2', breaks: { nestedchoiceuser: '*' } }, nested: {} },
  'old.jar': { fabric: { schemaVersion: 1, id: 'library', version: '1' }, nested: {} },
};
result = await solve(input([], ['nestedchoices', 'nestedchoiceuser']), catalog([choices, choiceUser]));
check('nested alternatives backtrack from a newer breaking copy to an older compatible copy', result.status === 'ok' && result.plan.length === 2);

const incompatible = model('negative', 'negative-1', '1.0.0', {}, [relation('library', 'incompatible')]);
result = await solve(input([pin(a1, true)], ['negative']), catalog([a1, incompatible]));
check('8: Modrinth project-wide incompatible relation is hard', result.status === 'conflict'
  && result.explanation.some((s) => s.includes('incompatible') && s.includes('library-1') && s.includes('negative-1')));
const specific = model('specific', 'specific-1', '1.0.0', {}, [relation('library', 'incompatible', a1.id)]);
result = await solve(input([pin(a1)], ['specific']), catalog([a1, a2, specific]));
check('version-specific incompatible blocks only that version, allowing one upgrade', result.status === 'ok'
  && pick(result, 'library') === a2.id && result.changes.changed.length === 1);
const versionOnly = model('versiononly', 'versiononly-1', '1.0.0', {}, [relation(null, 'incompatible', a1.id)]);
result = await solve(input([pin(a1, true)], ['versiononly']), catalog([a1, versionOnly]));
check('version-only incompatible relation is respected without a project id', result.status === 'conflict');

const rNew = model('choice', 'choice-2', '2.0.0', { depends: { library: '>=2', secondlib: '>=2' } }, [relation('library'), relation('secondlib')]);
const rOld = model('choice', 'choice-1', '1.0.0', { depends: { library: '>=2', secondlib: '>=1' } }, [relation('library'), relation('secondlib')]);
result = await solve(input([pin(a1), pin(b1)], ['choice']), catalog([a1, a2, b1, b2, rNew, rOld]));
check('9: minimum-change proof beats the newest-first DFS two-change hit', result.status === 'ok'
  && result.changes.changed.length === 1 && pick(result, 'choice') === rOld.id
  && pick(result, 'library') === a2.id && pick(result, 'secondlib') === b1.id);

const exactDep = model('exactdep', 'exactdep-1', '1.0.0', {}, [relation('library', 'required', a1.id)]);
result = await solve(input([], ['exactdep']), catalog([a1, a2, exactDep]));
check('Modrinth required version_id pins the exact version, not the newest', result.status === 'ok' && pick(result, 'library') === a1.id);
const bareDep = model('baredep', 'baredep-1', '1.0.0', {}, [relation(null, 'required', a1.id)]);
result = await solve(input([], ['baredep']), catalog([a1, a2, bareDep]));
check('version-only required dependency resolves its project through Catalog.version', result.status === 'ok' && pick(result, 'library') === a1.id);
const ignored = model('ignored', 'ignored-1', '1.0.0', {}, [relation('missing1', 'optional'), relation('missing2', 'embedded')]);
result = await solve(input([], ['ignored']), catalog([ignored]));
check('optional and embedded Modrinth relations never install separately', result.status === 'ok' && result.plan.length === 1);
const soft = model('soft', 'soft-1', '1.0.0', { conflicts: { library: '*' }, recommends: { missing: '>=1' } });
result = await solve(input([pin(a1)], ['soft']), catalog([a1, soft]));
check('Fabric conflicts and recommends are warnings only', result.status === 'ok' && result.warnings.length === 2);

const prerelease = structuredClone(a2);
prerelease.id = 'library-beta'; prerelease.version_type = 'beta'; prerelease.date_published = '2025-01-01T00:00:00Z';
raw.set(prerelease.id, structuredClone(raw.get(a2.id)));
result = await solve(input([], ['library']), catalog([prerelease, a2, a1]));
check('new selections prefer newest releases over newer prereleases', result.status === 'ok' && pick(result, 'library') === a2.id);
result = await solve(input([], ['library']), catalog([prerelease]));
check('compatible prerelease is used when no release fits', result.status === 'ok' && pick(result, 'library') === prerelease.id);
result = await solve({ ...input([], [exact(apiOld)]), java: '17' }, catalog([apiOld]));
check('built-in Java version is a hard constraint', result.status === 'conflict' && result.explanation.some((s) => s.includes('java >=21')));
result = await solve({ ...input([], [exact(apiOld)]), loaderVersion: '0.14.0' }, catalog([apiOld]));
check('built-in Fabric loader version is a hard constraint', result.status === 'conflict' && result.explanation.some((s) => s.includes('fabricloader >=0.15.11')));
result = await solve(input([], [exact(apiOld)]), { ...catalog([apiOld]), jarMeta: async () => { throw new Error('unreadable jar'); } });
check('catalog failures cannot be misreported as proven conflicts', result.status === 'inconclusive' && result.reason.includes('unreadable jar'));
const unknownUser = model('unknownuser', 'unknownuser-1', '1.0.0', { depends: { unknown: '*' } });
const noIndex = catalog([unknownUser]); delete noIndex.providers;
result = await solve(input([], ['unknownuser']), noIndex);
check('missing Fabric id lookup is inconclusive, not an invented project id or conflict', result.status === 'inconclusive' && result.reason.includes('Catalog.providers'));

const predicateCases = [
  ['opaque', '*', true], ['1.21.1', '>=1.21 <1.22', true], ['1.22', '>=1.21 <1.22', false],
  ['1.21.1', ['1.20', '1.21.1'], true], ['1.21.2', ['1.20', '1.21.1'], false],
  ['1.2.9', '~1.2.3', true], ['1.3.0-beta', '~1.2.3', false],
  ['0.9.0', '^0.2.3', true], ['1.0.0-', '^0.2.3', false],
  ['1.2.0-alpha', '1.2.x', true], ['1.3-', '1.2.x', false],
  ['1.9', '1.X.x', true], ['2-', '1.*', false],
  ['1.2.0-alpha.10', '>1.2.0-alpha.2', true], ['1.2', '>1.2-rc', true],
  ['1.2-', '<1.2-alpha', true], ['1.2-alpha', '<1.2-', false],
  ['1.2.0+build', '=1.2', true], ['1.2.0.1', '>1.2', true],
  ['01.02.00', '1.2', true], ['release-candidate', 'release-candidate', true],
  ['release-candidate', '>=release-candidate', true], ['different', '>=release-candidate', false],
  ['2147483648.x', '2147483648.x', true],
];
check('Fabric predicates: boundaries, OR/AND, wildcards, ^0.x, prereleases and opaque strings',
  predicateCases.every(([v, range, expected]) => matchesFabric(v, range) === expected));
let invalid = false;
try { matchesFabric('opaque', '>opaque'); } catch { invalid = true; }
check('exclusive opaque ranges are invalid; non-semver versions have no ordering', invalid
  && compareFabricVersions('opaque', 'different') === undefined && compareFabricVersions('1.0-alpha.2', '1.0-alpha.10') === -1);
check('operators without operands are invalid metadata, not string equality', ['=', '~', '^', '>='].every((range) => {
  try { matchesFabric('1', range); return false; } catch { return true; }
}));

const onlyClient = model('only_client', 'only_client-1', '1.0.0', { environment: 'client' });
result = await solve({ ...input([], [exact(onlyClient)]), side: 'both' }, catalog([onlyClient]));
check('friend packs keep requested client-only mods instead of dropping them', result.status === 'ok' && pick(result, onlyClient.project_id) === onlyClient.id);
const serverAlias = model('server_alias', 'server_alias-1', '1.0.0', { environment: 'server', provides: ['side_alias'] });
const clientAlias = model('client_alias', 'client_alias-2', '2.0.0', { environment: 'client', provides: ['side_alias'] });
result = await solve({ ...input([], [exact(serverAlias), exact(clientAlias)]), side: 'both' }, catalog([serverAlias, clientAlias]));
check('disjoint server/client aliases do not become false duplicates', result.status === 'ok' && result.plan.length === 2);
const sharedOld = model('shared', 'shared-1', '1.0.0');
const sharedNew = model('shared', 'shared-2', '2.0.0');
const clientNeedsNew = model('client_needs_new', 'client_needs_new-1', '1.0.0', { environment: 'client', depends: { shared: '>=2' } });
result = await solve({ ...input([pin(sharedOld, true)], [exact(clientNeedsNew)]), side: 'both' }, catalog([sharedOld, sharedNew, clientNeedsNew]));
check('one minimum-change solve honors client constraints on shared versions', result.status === 'ok' && result.changes.changed.length === 1 && pick(result, 'shared') === sharedNew.id);
const serverNeedsClientId = model('server_needs_client', 'server_needs_client-1', '1.0.0', { environment: 'server', depends: { only_client: '*' } });
result = await solve({ ...input([], [exact(serverNeedsClientId), exact(onlyClient)]), side: 'both' }, catalog([serverNeedsClientId, onlyClient]));
check('client-only providers cannot satisfy a server requirement', result.status === 'conflict');
const nestedServer = model('nested_server', 'nested_server-1', '1.0.0', { environment: 'server', depends: { library: '<2' } });
const nestedClient = model('nested_client', 'nested_client-1', '1.0.0', { environment: 'client', depends: { library: '>=2' } });
result = await solve({ ...input([], [exact(choices), exact(nestedServer), exact(nestedClient)]), side: 'both' }, catalog([choices, nestedServer, nestedClient]));
check('the server and client can activate different nested versions from the same artifact', result.status === 'ok'
  && result.plan.length === 3 && result.changes.added.length === 3);
const partialProviders = catalog([clientNeedsNew, sharedNew]);
partialProviders.providers = async () => ({ projects: [], complete: false });
result = await solve({ ...input([], [exact(clientNeedsNew)]), side: 'both' }, partialProviders);
check('an incomplete provider search is inconclusive, never a proved conflict', result.status === 'inconclusive' && /incomplete/.test(result.reason));
partialProviders.providers = async () => ({ projects: ['shared'], complete: false });
result = await solve({ ...input([], [exact(clientNeedsNew)]), side: 'both' }, partialProviders);
check('a discovered provider can prove a zero-change plan without claiming a complete index', result.status === 'ok' && result.changes.changed.length === 0 && pick(result, 'shared') === sharedNew.id);

const incompleteBalm = catalog();
incompleteBalm.providers = async (id) => ({ projects: await catalog().providers(id), complete: false });
const upgradeInput = input([pin(apiOld, true), pin(balmOld, true), pin(wayOld, true)], [exact(wayNew)]);
result = await solve(upgradeInput, incompleteBalm);
check('partial coverage returns a complete feasible Balm upgrade without claiming minimum changes', result.status === 'inconclusive'
  && result.tentative?.changes.changed.length === 2 && result.tentative.plan.some((p) => p.versionId === balmNew.id)
  && result.tentative.plan.every((p) => p.requested));
const unrelated = Array.from({ length: 40 }, (_, i) => model('unrelated', `unrelated-${i}`, `${i + 1}.0.0`));
const boundedUpgrade = catalog([...real, ...unrelated]);
boundedUpgrade.providers = incompleteBalm.providers;
result = await solve(input([...upgradeInput.installed, pin(unrelated[0], true)], [exact(wayNew)]), boundedUpgrade, { maxCatalogCalls: 24 });
check('a known missing provider is reconsidered before unrelated version histories exhaust the budget', result.status === 'inconclusive'
  && result.tentative?.changes.changed.length === 2 && result.tentative.plan.some((p) => p.versionId === balmNew.id)
  && result.tentative.plan.some((p) => p.versionId === unrelated[0].id));
const otherBalm = model('otherbalm', 'otherbalm-1', '1.0.0', { provides: ['balm'] });
const alternative = catalog([...real, otherBalm]);
alternative.providers = async (id) => ({ projects: await catalog([...real, otherBalm]).providers(id), complete: false });
result = await solve(upgradeInput, alternative);
check('another admitted provider can retain old Balm and prove the exact-request lower bound', result.status === 'ok'
  && result.changes.changed.length === 1 && pick(result, balmOld.project_id) === balmOld.id
  && pick(result, 'otherbalm') === otherBalm.id);
const uncertainProvider = model('uncertain_provider', 'uncertain_provider-1', '2.0.0', { provides: ['shared'], depends: { unknown: '*' } });
const validProvider = model('valid_provider', 'valid_provider-1', '2.0.0', { provides: ['shared'] });
const equalBudget = catalog([clientNeedsNew, uncertainProvider, validProvider]);
equalBudget.providers = async (id) => ({ projects: id === 'shared' ? ['uncertain_provider', 'valid_provider'] : [], complete: false });
result = await solve({ ...input([], [exact(clientNeedsNew)]), side: 'both' }, equalBudget);
check('uncertainty in another equal-cost branch cannot discredit a minimum-cost witness', result.status === 'ok'
  && pick(result, 'valid_provider') === validProvider.id);
result = await solve(upgradeInput, incompleteBalm, { maxNodes: 1 });
check('exhaustion before a complete witness has no tentative install plan', result.status === 'inconclusive' && !result.tentative);
result = await solve(input([], [{ ...exact(a1), requested: false }]), catalog([a1]));
check('a forced repair dependency does not become an owner-requested root', result.status === 'ok' && !result.plan[0].requested);
raw.get(serverAlias.id).fabric.conflicts = { side_alias: '>=2' };
result = await solve({ ...input([], [exact(serverAlias), exact(clientAlias)]), side: 'both' }, catalog([serverAlias, clientAlias]));
check('soft warnings use the relevant side rather than a disjoint alias version', result.status === 'ok' && result.warnings.length === 0);

// Cached 100-mod smoke check, not a real-pack performance benchmark. Every
// project is selected and every pin is verified, so fast failure is not success.
const pack = Array.from({ length: 100 }, (_, i) => model(`pack${i}`, `pack${i}-1`, '1.0.0', {
  depends: { minecraft: '>=1.21 <1.22', java: '>=21', fabricloader: '>=0.16', ...(i ? { [`pack${i - 1}`]: '^1.0' } : {}) },
}));
const cached = catalog(pack);
const start = performance.now();
result = await solve(input(pack.map((v) => pin(v))), cached, { maxMs: 1_000 });
check('cached 100-mod smoke solves under one second without changing a pin', result.status === 'ok'
  && result.plan.length === 100 && result.changes.changed.length === 0
  && pack.every((v) => pick(result, v.project_id) === v.id) && performance.now() - start < 1_000);

// Apache Maven Artifact 3.8.8 reference semantics, not npm/Fabric semver.
const qualifiers = ['1-alpha1', '1-beta1', '1-milestone1', '1-rc1', '1-SNAPSHOT', '1', '1-sp', '1-unknown'];
check('Maven qualifier ordering includes snapshots, service packs and unknown names', qualifiers.slice(1).every((v, i) => compareMavenVersions(qualifiers[i], v) < 0));
check('Maven release aliases and trailing numeric zeroes are equal', ['1.0.0', '1-0', '1-ga', '1-FINAL', '1-release'].every((v) => compareMavenVersions('1', v) === 0));
check('Maven numeric transitions and short qualifier aliases retain their semantics', compareMavenVersions('1-a2', '1-alpha2') === 0
  && compareMavenVersions('1.0.X1', '1.0-X2') < 0 && compareMavenVersions('1.0.1', '1.0-2') > 0);
check('Maven 3.8.5 retains the older dot-qualifier ordering used by Forge 47', compareMavenVersions('1.0.X1', '1.0-X2', '3.8.5') > 0
  && !matchesMaven('1.0.X1', '(,1.0-X2)', '3.8.5') && matchesMaven('1.0.X1', '(,1.0-X2)', '3.8.8'));
assert.throws(() => parseMavenRange('[1,1]', '3.8.5'));
assert.throws(() => parseMavenRange('(,)', '3.8.5'));
check('Maven 3.8.5 rejects identical raw boundaries but accepts equivalent open bounds', !matchesMaven('1', '(1.0,1]', '3.8.5')
  && matchesMaven('1', '[1.0,1]', '3.8.5'));
check('Maven numbers remain exact beyond JavaScript integer precision', compareMavenVersions('1.9007199254740993', '1.9007199254740992') > 0);
check('Maven metadata values cannot resolve JavaScript object prototype names as aliases', compareMavenVersions('constructor', 'beta') > 0
  && compareMavenVersions('__proto__', 'constructor') < 0 && compareMavenVersions('constructor1', 'constructor2') < 0);
check('Maven union ranges retain gaps and asymmetric inclusive boundaries', matchesMaven('0.9', '(,1],[1.2,2)')
  && matchesMaven('1', '(,1],[1.2,2)') && !matchesMaven('1.1', '(,1],[1.2,2)')
  && matchesMaven('1.2', '(,1],[1.2,2)') && !matchesMaven('2', '(,1],[1.2,2)'));
check('a bare Maven recommendation is not an exact constraint', matchesMaven('9', '1.2') && parseMavenRange('1.2').recommended === '1.2'
  && matchesMaven('1.2', '[1.2]') && !matchesMaven('1.3', '[1.2]'));
check('raw Maven empty ranges differ from loader-specific defaults', !matchesMaven('1', '') && parseMavenRange('').restrictions.length === 0);
check('Maven 3.8.8 accepts equal inclusive bounds and unbounded comma ranges', matchesMaven('1.0', '[1,1]')
  && !matchesMaven('1.1', '[1,1]') && matchesMaven('3', '(,)'));
const intersection = restrictMaven(parseMavenRange('(,1],[2,4)'), parseMavenRange('[1,3]'));
check('Maven restriction preserves isolated endpoints and union gaps', containsMaven('1', intersection)
  && !containsMaven('1.5', intersection) && containsMaven('2', intersection) && containsMaven('3', intersection) && !containsMaven('4', intersection));
check('Maven restriction retains recommendations, not just matching membership', restrictMaven(parseMavenRange('2'), parseMavenRange('[1,3)')).recommended === '2'
  && restrictMaven(parseMavenRange('4'), parseMavenRange('[1,3)')).recommended === undefined
  && restrictMaven(parseMavenRange('2'), parseMavenRange('')).recommended === '2');
const unsorted = restrictMaven(parseMavenRange('[2,),(,1]'), parseMavenRange('[0,3]'));
check('Maven restriction preserves the native traversal of accepted unsorted unbounded unions', !containsMaven('0', unsorted) && containsMaven('2', unsorted));
let repeated = parseMavenRange('[1],[1]');
for (let i = 0; i < 6; i++) repeated = restrictMaven(repeated, parseMavenRange('[1],[1]'));
check('repeated Maven restrictions do not multiply duplicate intervals exponentially', containsMaven('1', repeated) && repeated.restrictions.length <= 14);
for (const range of ['[2,1]', '(1)', '[1,1)', '(1.0,1]', '[1,3],[2,4]', '[1,2),2', '[1,2']) assert.throws(() => parseMavenRange(range));
check('malformed and overlapping Maven ranges are refused instead of widened', true);

// Metadata-only Forge jars, with actual TOML tables and JarJar zip trees.
const runtime = { mc: '1.21.1', forge: '52.1.20', java: '21.0.4', languages: { javafml: '52.1.20', lowcodefml: '52.1.20' } };
const fjar = (name, raw = {}, children = [], manifest = '') => {
  const zip = new AdmZip();
  zip.addFile('META-INF/MANIFEST.MF', Buffer.from(`Manifest-Version: 1.0\r\n${manifest}\r\n`));
  if (raw !== null) zip.addFile('META-INF/mods.toml', Buffer.from(stringify({ modLoader: 'javafml', loaderVersion: '[52,)', mods: [{ modId: name, version: '1' }], ...raw })));
  if (children.length) {
    zip.addFile('META-INF/jarjar/metadata.json', Buffer.from(JSON.stringify({ jars: children.map((child) => ({
      identifier: { group: child.group ?? 'example', artifact: child.artifact ?? child.name },
      version: { range: child.range ?? '[1,)', artifactVersion: child.version ?? '1' }, path: child.path ?? `${child.name}.jar`, isObfuscated: false,
    })) })));
    for (const child of children) zip.addFile(child.path ?? `${child.name}.jar`, child.bytes);
  }
  const bytes = zip.toBuffer();
  return { bytes, owner: name, meta: readForgeJar(bytes, `${name}.jar`, runtime) };
};
const dep = (modId, versionRange = '[1,)', extra = {}) => ({ modId, versionRange, mandatory: true, ...extra });
const fcheck = (files, side = 'server', ctx = runtime) => validateForge(files, side, ctx);
const legacyRuntime = { mc: '1.20.1', forge: '47.4.28', java: '21.0.4', languages: { javafml: '47', lowcodefml: '47' } };
const dotQualifier = fjar('dot_qualifier', { loaderVersion: '[47,)', mods: [{ modId: 'dot_qualifier', version: '1.0.X1' }] });
const needsQualifier = fjar('needs_qualifier', { loaderVersion: '[47,)', dependencies: { needs_qualifier: [dep('dot_qualifier', '(,1.0-X2)')] } });
check('Forge selects its installed Maven semantics for native dependency bounds', fcheck([dotQualifier, needsQualifier]).status === 'ok'
  && fcheck([dotQualifier, needsQualifier], 'server', legacyRuntime).status === 'conflict');
const multi = fjar('multi', { mods: [{ modId: 'multi', version: '1' }, { modId: 'secondary', version: '7.4' }] });
const needsSecondary = fjar('consumer', { dependencies: { consumer: [dep('secondary', '[7,8)')] } });
check('Forge secondary mods retain their own version instead of inheriting an alias version', fcheck([multi, needsSecondary]).status === 'ok'
  && fcheck([multi, needsSecondary]).missing.length === 0);
const sideNeeds = fjar('side_needs', { dependencies: { side_needs: [dep('secondary', '[7,8)', { side: 'SERVER' }), dep('secondary', '[8,9)', { side: 'CLIENT' })] } });
check('Forge repeated side-scoped requirements are not overwritten', fcheck([multi, sideNeeds]).status === 'ok' && fcheck([multi, sideNeeds], 'client').status === 'conflict');
const optional = fjar('optional', { dependencies: { optional: [dep('secondary', '[8,9)', { mandatory: false })] } });
check('Forge optional dependencies are absent-or-compatible, not ignored', fcheck([optional]).status === 'ok'
  && fcheck([optional]).missing.length === 0 && fcheck([optional, multi]).status === 'conflict');
const language = fjar('language', { loaderVersion: '[51,52)' });
check('Forge language requirements use the language provider version, not the Forge mod version', fcheck([language]).status === 'conflict'
  && fcheck([language], 'server', { ...runtime, languages: { javafml: '51.9' } }).status === 'ok');
const feature = fjar('feature', { features: { feature: { javaVersion: '[22,)' } } });
check('Forge declared Java feature bounds are enforced', fcheck([feature]).status === 'conflict'
  && fcheck([feature], 'server', { ...runtime, java: '22.0.1' }).status === 'ok');
const custom = fjar('custom', { modLoader: 'customfml' });
check('unmodeled Forge languages and features remain inconclusive', fcheck([custom]).status === 'inconclusive'
  && fcheck([fjar('feature', { features: { feature: { someFeature: '[1,)' } } })]).status === 'inconclusive');
const placeholder = fjar('placeholder', { mods: [{ modId: 'placeholder', version: '${file.jarVersion}' }, { modId: 'secondary', version: '${file.custom}' }], properties: { custom: '4.2' } }, [], 'Implementation-Version: 3.7.\r\n 2\r\n');
check('Forge manifest continuation and file substitutions are resolved before matching', placeholder.meta.mods[0].version === '3.7.2' && placeholder.meta.mods[1].version === '4.2');
const unknownVersion = fjar('unknown_version', { mods: [{ modId: 'unknown_version', version: '${file.jarVersion}' }] });
check('Forge 0.0NONE target version has its native wildcard behavior', fcheck([unknownVersion, fjar('consumer', { dependencies: { consumer: [dep('unknown_version', '[99,100)')] } })]).status === 'ok');
const cycleA = fjar('cycle_a', { dependencies: { cycle_a: [dep('cycle_b', '[1,)', { ordering: 'BEFORE', side: 'CLIENT' })] } });
const cycleB = fjar('cycle_b', { dependencies: { cycle_b: [dep('cycle_a', '[1,)', { ordering: 'BEFORE', side: 'CLIENT' })] } });
check('Forge file ordering edges are not side-filtered', fcheck([cycleA, cycleB], 'server').status === 'conflict');
const inFile = fjar('same_file', { mods: [{ modId: 'same_file' }, { modId: 'second' }], dependencies: { same_file: [dep('second', '[1,)', { ordering: 'BEFORE' })], second: [dep('same_file', '[1,)', { ordering: 'BEFORE' })] } });
check('Forge ignores ordering between independently versioned mods in the same file', fcheck([inFile]).status === 'ok');
const nested1 = fjar('nested_mod', { mods: [{ modId: 'nested_mod', version: '1' }] });
const nested2 = fjar('nested_mod', { mods: [{ modId: 'nested_mod', version: '2' }] });
const fbundle = (name, child, range = '[1,)', version = '1') => fjar(name, {}, [{ name: 'nested_mod', bytes: child.bytes, range, version }]);
check('Forge JarJar single distinct declaration short-circuits even an unsatisfied range', fcheck([fbundle('bundle_a', nested1, '[8,9)')]).status === 'ok');
const requiresNew = fjar('requires_new', { dependencies: { requires_new: [dep('nested_mod', '[2,3)')] } });
check('Forge JarJar negotiates globally before validating nested mod constraints', fcheck([fbundle('bundle_a', nested1, '[1,3)'), fbundle('bundle_b', nested2, '[2,3)', '2'), requiresNew]).status === 'ok');
check('Forge cannot choose a convenient nested version when runtime selection is ambiguous', fcheck([fbundle('bundle_a', nested1, '[1,3)'), fbundle('bundle_b', nested2, '[1,3)', '2'), requiresNew]).status === 'inconclusive');
check('identical JarJar declarations with different nested bytes remain inconclusive', fcheck([fbundle('bundle_a', nested1), fbundle('bundle_b', nested2)]).status === 'inconclusive');
const library = fjar('library', null, [], 'FMLModType: GAMELIBRARY\r\nAutomatic-Module-Name: example.library\r\n');
const libs = [fjar('libs_a', {}, [{ name: 'library', bytes: library.bytes, range: '[1,2)', version: '1' }]), fjar('libs_b', {}, [{ name: 'library', bytes: library.bytes, range: '[2,3)', version: '2' }])];
check('Forge JarJar negotiates non-mod libraries too', fcheck(libs).status === 'conflict');
const descendant = fjar('descendant', { dependencies: { descendant: [dep('missing_after_parent_dedup')] } });
const parent1 = fjar('parent', {}, [{ name: 'descendant', bytes: descendant.bytes }]);
const parent2 = fjar('parent', { mods: [{ modId: 'parent', version: '2' }] });
const root1 = fjar('root_one', {}, [{ name: 'parent', bytes: parent1.bytes, range: '[2,3)', version: '1' }]);
const root2 = fjar('root_two', {}, [{ name: 'parent', bytes: parent2.bytes, range: '[2,3)', version: '2' }]);
check('Forge discovers descendants before discarding a competing parent', fcheck([root1, root2]).status === 'ok'
  && fcheck([root1, root2]).missing.some((missing) => missing.id === 'missing_after_parent_dedup'));
const fversion = (file, version = '1') => ({ ...model(file.owner, `${file.owner}-${version}`, version), loaders: ['forge'] });
const fversions = [fversion(multi), fversion(needsSecondary), fversion(custom)];
const fmetas = new Map([[fversions[0].id, multi.meta], [fversions[1].id, needsSecondary.meta], [fversions[2].id, custom.meta]]);
const fcatalog = { versions: async (id) => fversions.filter((v) => v.project_id === id), jarMeta: async (v) => fmetas.get(v.id), providers: async (id) => id === 'secondary' ? [multi.owner] : [] };
const finput = { ...input([], [exact(fversions[1])]), loader: 'forge', loaderVersion: runtime.forge, languageVersions: runtime.languages, side: 'both' };
result = await solve(finput, fcatalog);
check('the shared solver discovers Forge native providers and preserves the requested root', result.status === 'ok'
  && result.plan.length === 2 && pick(result, multi.owner) === fversions[0].id && result.plan.find((p) => p.projectId === needsSecondary.owner).requested);
result = await solve({ ...finput, add: [exact(fversions[2])] }, fcatalog);
check('unknown Forge feasibility never carries a tentative install plan', result.status === 'inconclusive' && !result.tentative);
const coordinateMissing = fjar('coordinate_missing', { dependencies: { coordinate_missing: [dep('absent_coordinate_provider')] } });
const coordinateSafe = fjar('coordinate_safe');
const coordinateBundle = fjar('coordinate_bundle', {}, [
  { ...coordinateMissing, name: 'missing', group: 'a:b', artifact: 'c', version: '1', range: '[2,3)' },
  { ...coordinateSafe, name: 'safe', group: 'a', artifact: 'b:c', version: '2', range: '[2,3)' },
]);
const coordinateVersion = fversion(coordinateBundle);
result = await solve({ ...finput, add: [exact(coordinateVersion)] }, {
  versions: async () => [coordinateVersion], jarMeta: async () => coordinateBundle.meta, providers: async () => [],
});
check('distinct JarJar coordinate tuples cannot hide a selected nested dependency', result.status === 'inconclusive' && !result.tentative);
assert.throws(() => fjar('missing_mandatory', { loaderVersion: '[2,)', dependencies: { missing_mandatory: [{ modId: 'forge', versionRange: '[52,)' }] } }));
check('a Forge dependency clears the legacy mandatory fallback before its own validation', true);
assert.throws(() => fjar('recursive', { mods: [{ modId: 'recursive', version: '${file.recursive}' }], properties: { recursive: '${file.recursive}' } }));
check('recursive Forge substitutions are refused before expansion', true);
const equivalent = fcheck([fbundle('bundle_a', nested1, '[8,9)', '1'), fbundle('bundle_b', nested1, '[8.0,9.0)', '1.0')]);
check('native-equal JarJar declarations take the single-declaration shortcut', equivalent.status === 'ok');
const replacement = fversion(nested2, '2');
const withBundledOld = fbundle('bundle_a', nested1), bundledVersion = fversion(withBundledOld), requiresVersion = fversion(requiresNew);
const providerVersions = [bundledVersion, requiresVersion, replacement];
const providerMetas = new Map([[bundledVersion.id, withBundledOld.meta], [requiresVersion.id, requiresNew.meta], [replacement.id, nested2.meta]]);
result = await solve({ ...finput, add: [exact(bundledVersion), exact(requiresVersion)] }, {
  versions: async (id) => providerVersions.filter((v) => v.project_id === id), jarMeta: async (v) => providerMetas.get(v.id), providers: async (id) => id === 'nested_mod' ? [replacement.project_id] : [],
});
check('a top-level native provider can shadow an incompatible bundled Forge mod', result.status === 'ok' && pick(result, replacement.project_id) === replacement.id);

const badNested = fjar('nested_mod', { dependencies: { nested_mod: [dep('minecraft', '[1.20.1]')] } });
const badBundle = fbundle('bad_bundle', badNested), badBundleVersion = fversion(badBundle);
result = await solve({ ...finput, add: [exact(badBundleVersion)] }, {
  versions: async (id) => [badBundleVersion, replacement].filter((v) => v.project_id === id),
  jarMeta: async (v) => v.id === badBundleVersion.id ? badBundle.meta : nested2.meta,
  providers: async (id) => id === 'nested_mod' ? [replacement.project_id] : [],
});
check('a broken dependency declared by a nested mod is not false impossibility', result.status !== 'conflict');
const exponential = { p0: '' };
for (let i = 1; i <= 4; i++) exponential[`p${i}`] = `\${file.p${i - 1}}`.repeat(16);
for (const [name, version, properties] of [
  ['default-value syntax', '1.${file.v:-0}', { v: '2' }],
  ['escaped syntax inside a property', '${file.v}', { v: '1.$${global.mcVersion}' }],
  ['exponential empty expansion', '1${file.p4}', exponential],
]) {
  let refused = false;
  try { fjar('substitution', { mods: [{ modId: 'substitution', version }], properties }); } catch { refused = true; }
  check(`unsupported Forge ${name} is refused before certification`, refused);
}
let unsupportedNumeric = false;
try { matchesMaven('1.0000000000.1', '(,1.1.1)'); } catch { unsupportedNumeric = true; }
check('Maven all-zero LongItem spellings are not collapsed into ordinary zeroes', unsupportedNumeric);
const absentNested = fjar('nested_mod', { dependencies: { nested_mod: [dep('absent')] } });
const absentBundle = fbundle('absent_bundle', absentNested), absentVersion = fversion(absentBundle);
result = await solve({ ...finput, add: [exact(absentVersion)] }, {
  versions: async (id) => [absentVersion, replacement].filter((v) => v.project_id === id),
  jarMeta: async (v) => v.id === absentVersion.id ? absentBundle.meta : nested2.meta,
  providers: async (id) => id === 'nested_mod' ? [replacement.project_id] : [],
});
check('missing nested dependencies remain inconclusive when suppression was not searched', result.status === 'inconclusive' && !result.tentative);
const notBundled = fcheck([fbundle('bundle_a', nested1, '[2,3)', '1'), fbundle('bundle_b', nested2, '[2,3)', '3')]);
check('a missing JarJar candidate is not impossibility while another bundle could supply it', notBundled.status === 'inconclusive');

// Counterfactual service-only bootstrap: only its separately discovered child
// is an effective mod. Actual AutoModpack bytes are checked in the live proof.
const bootstrap = fjar('bootstrap');
bootstrap.meta.discovered = [nested2.meta];
check('a certified service bootstrap supplies its child, not its outer metadata id', fcheck([bootstrap, requiresNew]).missing.length === 0
  && fcheck([bootstrap, fjar('needs_bootstrap', { dependencies: { needs_bootstrap: [dep('bootstrap')] } })]).missing.some((m) => m.id === 'bootstrap'));
check('competing root or JarJar child identities stay unknown', fcheck([bootstrap, nested2]).status === 'inconclusive'
  && fcheck([bootstrap, fbundle('child_competition', nested2)]).status === 'inconclusive');
const transformer = new AdmZip(fjar('transformer').bytes);
transformer.addFile('META-INF/services/cpw.mods.modlauncher.api.ITransformationService', Buffer.from('example.Transformer'));
const transformationVersion = fversion({ owner: 'transformer' });
result = await solve({ ...finput, add: [exact(transformationVersion)] }, {
  versions: async () => [transformationVersion], jarMeta: async () => readForgeJar(transformer.toBuffer(), 'transformer.jar', runtime), providers: async () => [],
});
check('unmodeled transformation services cannot claim a feasible or tentative graph', result.status === 'inconclusive' && !result.tentative);

// javac --release 17: module example.versioned {}. Descriptor metadata only.
const versionedDescriptor = Buffer.from('yv66vgAAAD0ACgcAAgEAC21vZHVsZS1pbmZvAQAKU291cmNlRmlsZQEAEG1vZHVsZS1pbmZvLmphdmEBAAZNb2R1bGUTAAcBABFleGFtcGxlLnZlcnNpb25lZBMACQEACWphdmEuYmFzZYAAAAEAAAAAAAAAAAACAAMAAAACAAQABQAAABYABgAAAAAAAQAIgAAAAAAAAAAAAAAA', 'base64');
const multiRelease = new AdmZip(fjar('versioned_discovery').bytes);
multiRelease.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\r\nMulti-Release: true\r\n\r\n'));
multiRelease.addFile('META-INF/versions/17/module-info.class', versionedDescriptor);
const implicitOne = fjar('implicit_one', null, [], 'FMLModType: GAMELIBRARY\r\nImplementation-Version: 1\r\n');
const implicitTwo = fjar('implicit_two', null, [], 'FMLModType: GAMELIBRARY\r\nImplementation-Version: 2\r\n');
const moduleCollision = fjar('module_collision', {}, [
  { name: 'first_library', bytes: implicitOne.bytes, path: 'example-1.0-extra.jar' },
  { name: 'second_library', bytes: implicitTwo.bytes, path: 'example-extra.jar' },
]);
for (const [name, bytes] of [
  ['versioned module discovery', multiRelease.toBuffer()],
  ['implicit library module collision across distinct JarJar coordinates', moduleCollision.bytes],
]) {
  const version = fversion({ owner: 'discovery_boundary' });
  result = await solve({ ...finput, add: [exact(version)] }, {
    versions: async () => [version], jarMeta: async () => readForgeJar(bytes, 'discovery_boundary.jar', runtime), providers: async () => [],
  });
  check(`unmodeled ${name} has no feasible or tentative witness`, result.status === 'inconclusive' && !result.tentative);
}

const uncertainLibrary = new AdmZip(implicitOne.bytes);
uncertainLibrary.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\r\nFMLModType: GAMELIBRARY\r\nAutomatic-Module-Name: example\r\nMulti-Release: true\r\n\r\n'));
uncertainLibrary.addFile('META-INF/versions/17/module-info.class', versionedDescriptor);
for (const [name, filename, libraryBytes] of [
  ['versioned module', 'example.jar', uncertainLibrary.toBuffer()],
  ['implicit module', 'example-.1.jar', implicitOne.bytes],
  ...['true', 'false', 'null'].map((literal) => [`reserved literal ${literal}`, `example-${literal}.jar`, implicitOne.bytes]),
]) {
  const parent = new AdmZip(fjar('uncertain_parent').bytes);
  parent.addFile('META-INF/jarjar/metadata.json', Buffer.from(JSON.stringify({ jars: [{
    identifier: { group: 'example', artifact: 'uncertain_library' }, version: { range: '[1,)', artifactVersion: '1' }, path: filename,
  }] })));
  parent.addFile(filename, libraryBytes);
  const top = fjar('example'), roots = [fversion(top), fversion({ owner: 'uncertain_parent' })];
  result = await solve({ ...finput, add: roots.map(exact) }, {
    versions: async project => roots.filter(v => v.project_id === project),
    jarMeta: async version => readForgeJar(version.project_id === 'example' ? top.bytes : parent.toBuffer(), `${version.project_id}.jar`, runtime),
    providers: async () => [],
  });
  check(`a provisional nested ${name} identity cannot suppress its discovery uncertainty`, result.status === 'inconclusive' && !result.tentative);
}

console.log(`\n${checks - fails.length}/${checks} checks passed`);
if (fails.length) process.exit(1);
