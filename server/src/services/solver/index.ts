import type { Version } from '../../clients/modrinth.js';
import { compareFabricVersions, matchesFabric, type JarMeta, type Predicate } from './fabric.js';
import { validateForge, type ForgeJar } from './forge.js';

export type { JarMeta, Predicate } from './fabric.js';
export type NativeMeta = JarMeta | ForgeJar;
export const modIds = (meta: NativeMeta): string[] => 'loader' in meta ? meta.discovered?.flatMap(modIds) ?? meta.mods.map((mod) => mod.id) : meta.ids;
export interface Pin {
  projectId: string;
  versionId: string;
  file: string;
  sha1: string;
  requested: boolean;
}
export interface SolveInput {
  mc: string;
  loader: 'fabric' | 'forge';
  java: string;
  loaderVersion: string;
  languageVersions?: Record<string, string>;
  features?: Record<string, string>;
  installed: Pin[];
  add: { projectId: string; versionId?: string; requested?: boolean }[];
  remove: string[];
  /** Explicitly removed top-level mod identities, even without a source ledger. */
  exclude?: string[];
  /** Friend packs must satisfy server and client constraints together. */
  side?: 'server' | 'both';
}
export interface Catalog {
  /** Complete compatible domain, including installed and explicitly pinned versions. */
  versions(projectId: string, filter: { mc: string; loader: 'fabric' | 'forge' }): Promise<Version[]>;
  jarMeta(version: Version): Promise<NativeMeta>;
  /** Complete provider index for a native id (including nested ids).
   * Missing capability is unknown, not evidence that no provider exists. */
  providers?(modId: string, filter: { mc: string; loader: 'fabric' | 'forge' }): Promise<string[] | { projects: string[]; complete: boolean }>;
  /** Needed only for required Modrinth dependencies with a version id but no project id. */
  version?(versionId: string): Promise<Version>;
}
export interface Limits { maxNodes?: number; maxCatalogCalls?: number; maxMs?: number }
export interface Changes { added: Pin[]; removed: Pin[]; changed: { from: Pin; to: Pin }[] }
export interface SolvedPlan { plan: Pin[]; changes: Changes; warnings: string[] }
export type SolveResult =
  | ({ status: 'ok' } & SolvedPlan)
  | { status: 'conflict'; explanation: string[] }
  | { status: 'inconclusive'; reason: string; tentative?: SolvedPlan };

interface Pick { version: Version; meta: NativeMeta }
interface Unit { meta: JarMeta; owner: string; side: number }
interface Solution { selected: Map<string, Pick>; active: Unit[]; warnings?: string[] }
class Exhausted extends Error {}

const describe = (unit: Unit): string => `${unit.meta.name ?? unit.meta.ids[0]} ${unit.meta.version} (${unit.owner})`;
const rangeText = (range: Predicate): string => Array.isArray(range) ? range.join(' OR ') : range;

/** Pure planning: no downloads, filesystem writes, installer state, or global cache. */
export async function solve(input: SolveInput, catalog: Catalog, limits: Limits = {}): Promise<SolveResult> {
  const maxNodes = limits.maxNodes ?? 100_000;
  const maxCalls = limits.maxCatalogCalls ?? 2_000;
  const deadline = performance.now() + (limits.maxMs ?? 5_000);
  let nodes = 0, calls = 0;
  const tick = (node = false): void => {
    if (performance.now() >= deadline) throw new Exhausted('Elapsed time limit reached');
    if (node && ++nodes > maxNodes) throw new Exhausted('Search node limit reached');
  };
  const call = async <T>(action: () => Promise<T>): Promise<T> => {
    tick();
    if (++calls > maxCalls) throw new Exhausted('Catalog call limit reached');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        action(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Exhausted('Elapsed time limit reached during catalog read')), Math.max(0, deadline - performance.now()));
        }),
      ]);
      tick();
      return result;
    } finally { clearTimeout(timer); }
  };
  const removed = new Set(input.remove);
  const installed = new Map(input.installed.map((pin) => [pin.projectId, pin]));
  const retained = [...installed.keys()].filter((id) => !removed.has(id));
  const wanted = new Map<string, string | undefined>();
  const reasons = new Set<string>();
  const reject = (reason: string): null => { if (reasons.size < 16) reasons.add(reason); return null; };
  let unknown: string | undefined;
  const uncertain = (reason: string): null => { unknown ??= reason; return null; };
  const domains = new Map<string, Version[]>();
  const metadata = new Map<string, NativeMeta>();
  const providers = new Map<string, { projects: string[]; complete: boolean }>();
  const missingProviders = new Set<string>();
  const versionProjects = new Map<string, string>();
  const filter = { mc: input.mc, loader: input.loader };
  const builtins = new Map([
    ['minecraft', input.mc], ['java', input.java], ['fabricloader', input.loaderVersion],
  ]);
  const environments = input.side === 'both' ? [1, 2] : [1];
  const side = (meta: JarMeta): number => meta.environment === 'client' ? 2 : meta.environment === 'server' ? 1 : 3;

  const domain = async (id: string): Promise<Version[]> => {
    if (!domains.has(id)) {
      const versions = await call(() => catalog.versions(id, filter));
      for (const version of versions) versionProjects.set(version.id, version.project_id);
      domains.set(id, versions.filter((v) => v.project_id === id && v.game_versions.includes(input.mc)
        && v.loaders.includes(input.loader)).sort((a, b) => {
        const pin = installed.get(id)?.versionId;
        if ((a.id === pin) !== (b.id === pin)) return a.id === pin ? -1 : 1;
        if ((a.version_type === 'release') !== (b.version_type === 'release')) return a.version_type === 'release' ? -1 : 1;
        return Date.parse(b.date_published) - Date.parse(a.date_published) || a.id.localeCompare(b.id);
      }));
    }
    return domains.get(id)!;
  };
  const meta = async (version: Version): Promise<NativeMeta> => {
    if (!metadata.has(version.id)) metadata.set(version.id, await call(() => catalog.jarMeta(version)));
    const result = metadata.get(version.id)!;
    if (('loader' in result) !== (input.loader === 'forge')) throw new Error(`Wrong native metadata for ${input.loader}`);
    return result;
  };

  // Check hard constraints on loaded units. An absent mod id can still be
  // supplied later; a present but unsuitable id cannot be shadowed by a nested jar.
  const validate = (active: Unit[], environment: number): Map<string, Unit> | null => {
    active = active.filter((unit) => unit.side & environment);
    const ids = new Map<string, Unit>();
    for (const unit of active) {
      if (!unit.meta.ids.length || !unit.meta.version) throw new Error(`Incomplete jar metadata for ${unit.owner}`);
      for (const id of new Set(unit.meta.ids)) {
        const prior = ids.get(id);
        if (builtins.has(id)) return reject(`${describe(unit)} duplicates built-in id ${id}.`);
        if (prior && prior !== unit) return reject(`${describe(prior)} and ${describe(unit)} both provide ${id}.`);
        ids.set(id, unit);
      }
    }
    for (const unit of active) {
      for (const [id, range] of Object.entries(unit.meta.depends)) {
        const target = ids.get(id);
        const version = builtins.get(id) ?? target?.meta.version;
        if (version !== undefined && !matchesFabric(version, range)) {
          return reject(`${describe(unit)} requires ${id} ${rangeText(range)}, but ${target ? describe(target) : `${id} ${version}`} is selected.`);
        }
      }
      for (const [id, range] of Object.entries(unit.meta.breaks)) {
        const target = ids.get(id);
        const version = builtins.get(id) ?? target?.meta.version;
        if (version !== undefined && matchesFabric(version, range)) {
          return reject(`${describe(unit)} breaks ${id} ${rangeText(range)}; ${target ? describe(target) : `${id} ${version}`} matches that range.`);
        }
      }
    }
    return ids;
  };

  const search = async (selected: Map<string, Pick>, required: Map<string, string | undefined>, budget: number, omitted = new Set<string>()): Promise<Solution | null> => {
    tick(true);
    let cost = omitted.size;
    for (const [id, pick] of selected) if (installed.has(id) && installed.get(id)!.versionId !== pick.version.id) cost++;
    if (cost > budget) return null;
    const filenames = new Set<string>();
    for (const [id, pick] of selected) {
      const old = installed.get(id);
      const file = old?.versionId === pick.version.id ? old.file
        : (pick.version.files.find((f) => f.primary) ?? pick.version.files[0])?.filename;
      if (!file || filenames.has(file.toLowerCase())) return reject(`Selected artifacts collide at filename ${file ?? '(missing)'}.`);
      filenames.add(file.toLowerCase());
    }
    const active = input.loader === 'fabric' ? [...selected].map(([owner, pick]) => {
      const jar = pick.meta as JarMeta;
      return { owner, meta: jar, side: side(jar) };
    }) : [];
    if (environments.some((environment) => !validate(active, environment))) return null;
    const needs = new Map(required);
    for (const [id, pick] of selected) {
      for (const dependency of pick.version.dependencies) {
        if (dependency.dependency_type === 'incompatible') {
          const other = [...selected.values()].find((p) => dependency.version_id
            ? p.version.id === dependency.version_id
            : p.version.project_id === dependency.project_id);
          if (other) return reject(`${pick.version.name} (${id}, ${pick.version.id}) is marked incompatible with ${other.version.name} (${other.version.project_id}, ${other.version.id}) on Modrinth.`);
        }
        if (dependency.dependency_type !== 'required') continue; // optional and embedded never add projects
        let project = dependency.project_id;
        if (!project && dependency.version_id) {
          project = versionProjects.get(dependency.version_id) ?? null;
          if (!project) {
            if (!catalog.version) return uncertain(`Catalog.version is needed to resolve required version ${dependency.version_id} from ${pick.version.name}.`);
            const version = await call(() => catalog.version!(dependency.version_id!));
            if (version.id !== dependency.version_id) throw new Error('Catalog returned a different version id');
            project = version.project_id;
            versionProjects.set(version.id, project);
          }
        }
        if (!project) return uncertain(`Required dependency of ${pick.version.name} has neither project id nor version id.`);
        if (removed.has(project)) return reject(`${pick.version.name} requires project ${project}, which is explicitly removed.`);
        const pin = dependency.version_id ?? undefined;
        const previous = needs.get(project);
        if (previous && pin && previous !== pin) return reject(`${pick.version.name} requires ${project} version ${pin}, but version ${previous} is also required.`);
        needs.set(project, pin ?? previous);
      }
    }
    for (const [id, pin] of needs) {
      if (omitted.has(id)) return reject(`Project ${id} is required and cannot be dropped.`);
      if (pin && selected.has(id) && selected.get(id)!.version.id !== pin) {
        return reject(`Project ${id} must use version ${pin}, not ${selected.get(id)!.version.id}.`);
      }
    }
    const remaining = [...needs.keys(), ...retained].filter((id) => !selected.has(id) && !omitted.has(id));
    // Put providers of previously missing IDs deepest in the next search tree:
    // their alternative versions are then tried before unrelated histories.
    // This changes traversal only, never domains, budgets or completeness.
    const next = remaining.find((id) => !missingProviders.has(id)) ?? remaining[0];
    if (next) {
      const versions = await domain(next);
      const exact = needs.get(next);
      const candidates = versions.filter((v) => !exact || v.id === exact);
      if (!candidates.length) reject(`Project ${next} has no build${exact ? ` for exact version ${exact}` : ''} for Minecraft ${input.mc} / ${input.loader}.`);
      const old = installed.get(next);
      if (old && versions.length && !versions.some((v) => v.id === old.versionId)) {
        return uncertain(`Catalog is missing installed version ${old.versionId} of ${next}; its constraints cannot be checked.`);
      }
      for (const version of candidates) {
        tick(true);
        if (cost + (old && old.versionId !== version.id ? 1 : 0) > budget) continue;
        if (!version.files.length) { reject(`${version.name} (${version.id}) has no downloadable file.`); continue; }
        const jar = await meta(version);
        const excluded = modIds(jar).find((id) => input.exclude?.includes(id));
        if (excluded) { reject(`Mod ${excluded} was explicitly removed and cannot be reinstalled.`); continue; }
        if (jar.environment === 'client' && input.side !== 'both') { reject(`${version.name} (${version.id}) is client-only, not a server build.`); continue; }
        const branch = new Map(selected);
        branch.set(next, { version, meta: jar });
        const result = await search(branch, needs, budget, omitted);
        if (result) return result;
      }
      // No orphan cleanup: omission costs one change, so it is tried only when
      // keeping every pin cannot fit. Requested and required projects are roots.
      if (old && !needs.has(next) && cost < budget) {
        return search(selected, needs, budget, new Set([...omitted, next]));
      }
      return null;
    }

    const provide = async (id: string, range: string, owner: string, suppressible = false): Promise<Solution | null> => {
      if (!providers.has(id)) {
        if (!catalog.providers) return uncertain(`No selected jar supplies ${id} ${range} required by ${owner}. Catalog.providers is needed to discover other projects.`);
        const found = await call(() => catalog.providers!(id, filter));
        providers.set(id, Array.isArray(found) ? { projects: found, complete: true } : found);
      }
      for (const project of new Set(providers.get(id)!.projects)) {
        missingProviders.add(project);
        if (selected.has(project) || removed.has(project)) continue;
        const extra = new Map(needs);
        extra.set(project, undefined);
        const result = await search(selected, extra, budget, omitted);
        if (result) return result;
      }
      if (suppressible) return uncertain(`No indexed provider satisfied ${id} ${range}; suppression of effective nested files has not been exhaustively searched.`);
      if (!providers.get(id)!.complete) return uncertain(`The provider index for ${id} is incomplete; no allowed indexed provider satisfied ${range}.`);
      return reject(`${owner} requires ${id} ${range}, but no allowed provider can satisfy it for Minecraft ${input.mc} / ${input.loader}.`);
    };
    if (input.loader === 'forge') {
      const warnings = new Set<string>();
      for (const environment of environments) {
        const result = validateForge([...selected].map(([owner, pick]) => ({ owner, meta: pick.meta as ForgeJar })), environment === 1 ? 'server' : 'client', {
          mc: input.mc, forge: input.loaderVersion, java: input.java, languages: input.languageVersions ?? {}, features: input.features,
        }, () => tick(true));
        if (result.status === 'conflict') return reject(result.reason);
        if (result.status === 'inconclusive') return uncertain(result.reason);
        if (result.missing.length) {
          const missing = result.missing[0];
          return provide(missing.id, missing.range, missing.owner, result.suppressible);
        }
        result.warnings.forEach((warning) => warnings.add(warning));
      }
      return { selected, active: [], warnings: [...warnings] };
    }

    // Nested jars have Fabric's IF_POSSIBLE load condition: optional candidates,
    // tied to their parents, with at most one primary/provided id loaded. Select
    // the mandatory closure only; Loader may greedily add other compatible jars.
    const nested: { unit: Unit; path: Unit[] }[] = [];
    const collect = (parent: Unit, path: Unit[]): void => {
      for (const child of parent.meta.nested) {
        tick(true);
        const scope = parent.side & side(child);
        if (!environments.some((environment) => scope & environment)) continue;
        const unit = { meta: child, owner: parent.owner, side: scope };
        const chain = [...path, unit];
        nested.push({ unit, path: chain });
        collect(unit, chain);
      }
    };
    for (const root of active) collect(root, []);
    nested.sort((a, b) => compareFabricVersions(b.unit.meta.version, a.unit.meta.version) ?? 0);

    const complete = async (loaded: Unit[]): Promise<Solution | null> => {
      tick(true);
      for (const environment of environments) {
        const ids = validate(loaded, environment);
        if (!ids) return null;
        for (const unit of loaded.filter((unit) => unit.side & environment)) {
          for (const [id, range] of Object.entries(unit.meta.depends)) {
            if (ids.has(id) || builtins.has(id)) continue;
            for (const candidate of nested) {
              if (!(candidate.unit.side & environment) || !candidate.unit.meta.ids.includes(id) || !matchesFabric(candidate.unit.meta.version, range)) continue;
              // Server and client are separate Loader processes. Activating a
              // bundled version on one side does not select it on the other.
              const extra = candidate.path.filter((u) => !loaded.some((l) => l.meta === u.meta && l.owner === u.owner && (l.side & environment)))
                .map((u) => ({ ...u, side: environment }));
              const result = await complete([...loaded, ...extra]);
              if (result) return result;
            }
            return provide(id, rangeText(range), describe(unit));
          }
        }
      }
      return { selected, active: loaded };
    };
    return complete(active);
  };

  try {
    tick();
    if (!input.mc || !input.java || !input.loaderVersion || !['fabric', 'forge'].includes(input.loader)) {
      return { status: 'inconclusive', reason: 'Minecraft, Java and a supported loader version are required.' };
    }
    if (installed.size !== input.installed.length) return { status: 'inconclusive', reason: 'Installed pins contain duplicate project ids.' };
    for (const add of input.add) {
      if (removed.has(add.projectId)) return { status: 'conflict', explanation: [`Project ${add.projectId} is both requested and explicitly removed.`] };
      if (wanted.get(add.projectId) && add.versionId && wanted.get(add.projectId) !== add.versionId) {
        return { status: 'conflict', explanation: [`Two different exact versions of project ${add.projectId} were requested.`] };
      }
      wanted.set(add.projectId, add.versionId ?? wanted.get(add.projectId));
    }
    // Requested project identity is mandatory; its version may change if needed.
    // Dependency-only projects are kept preferentially, but may be dropped for
    // one change when no selected mod still requires them.
    for (const pin of input.installed) if (pin.requested && !removed.has(pin.projectId) && !wanted.has(pin.projectId)) wanted.set(pin.projectId, undefined);
    let lowerBound = retained.filter((id) => wanted.get(id) && wanted.get(id) !== installed.get(id)!.versionId).length;
    let incomplete: string | undefined;
    for (let budget = lowerBound; budget <= retained.length; budget++) {
      unknown = undefined;
      const solution = await search(new Map(), wanted, budget);
      if (!solution) {
        if (unknown) incomplete ??= unknown;
        else if (budget === lowerBound) lowerBound++;
        continue;
      }
      tick();
      const plan: Pin[] = [...solution.selected].map(([projectId, pick]) => {
        const old = installed.get(projectId);
        const requested = input.add.some((a) => a.projectId === projectId && a.requested !== false) || old?.requested === true;
        if (old?.versionId === pick.version.id) return { ...old, requested };
        const file = pick.version.files.find((f) => f.primary) ?? pick.version.files[0];
        return { projectId, versionId: pick.version.id, file: file.filename, sha1: file.hashes.sha1, requested };
      });
      const byProject = new Map(plan.map((pin) => [pin.projectId, pin]));
      const changes: Changes = {
        added: plan.filter((pin) => !installed.has(pin.projectId)),
        removed: input.installed.filter((pin) => !byProject.has(pin.projectId)),
        changed: plan.filter((pin) => installed.has(pin.projectId) && installed.get(pin.projectId)!.versionId !== pin.versionId)
          .map((pin) => ({ from: installed.get(pin.projectId)!, to: pin })),
      };
      const warnings = new Set<string>(solution.warnings);
      for (const environment of environments) {
        const active = solution.active.filter((u) => u.side & environment);
        const supplied = new Map(active.flatMap((u) => u.meta.ids.map((id) => [id, u.meta.version] as const)));
        for (const [id, version] of builtins) supplied.set(id, version);
        for (const unit of active) {
          for (const [id, range] of Object.entries(unit.meta.conflicts ?? {})) {
            if (supplied.has(id) && matchesFabric(supplied.get(id)!, range)) warnings.add(`${describe(unit)} conflicts with ${id} ${rangeText(range)} (warning only).`);
          }
          for (const [id, range] of Object.entries(unit.meta.recommends ?? {})) {
            if (!supplied.has(id) || !matchesFabric(supplied.get(id)!, range)) warnings.add(`${describe(unit)} recommends ${id} ${rangeText(range)} (warning only).`);
          }
        }
      }
      tick();
      const cost = changes.changed.length + changes.removed.filter((pin) => !removed.has(pin.projectId)).length;
      if (cost > lowerBound) return { status: 'inconclusive', reason: incomplete ?? 'Fewer existing-version changes could not be ruled out',
        tentative: { plan, changes, warnings: [...warnings, 'This complete plan satisfies the modeled constraints, but fewer replacements may be possible.'] } };
      return { status: 'ok', plan, changes, warnings: [...warnings] };
    }
    tick();
    if (incomplete) return { status: 'inconclusive', reason: incomplete };
    return { status: 'conflict', explanation: reasons.size ? [...reasons] : ['No selection satisfies all hard constraints.'] };
  } catch (error) {
    return { status: 'inconclusive', reason: error instanceof Error ? error.message : String(error) };
  }
}
