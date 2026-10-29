// Offline solver contract tests. Real responses and jar metadata are unchanged
// in recorded.json. Explicit counterfactuals below exercise hard-to-find edges.
import { readFileSync } from 'node:fs';
import AdmZip from 'adm-zip';
import { tsImport } from 'tsx/esm/api';

const { solve } = await tsImport('../server/src/services/solver/index.ts', import.meta.url);
const { readFabricJar, matchesFabric, compareFabricVersions } = await tsImport('../server/src/services/solver/fabric.ts', import.meta.url);
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

console.log(`\n${checks - fails.length}/${checks} checks passed`);
if (fails.length) process.exit(1);
