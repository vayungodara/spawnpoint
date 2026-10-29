# Fabric solver contract

`solve(input, catalog, limits?)` returns a `Promise<SolveResult>`. It plans only.
It does not import installer configuration, download files, change the ledger,
or write to disk. The installer consumes a complete `plan`, never a partial
selection. Boot and friend-sync tests remain separate from metadata planning.

## Inputs and results

`SolveInput` contains `mc`, `loader: 'fabric'`, `java`, `loaderVersion`,
`installed: Pin[]`, `add: { projectId, versionId? }[]`, and `remove: string[]`.
Use canonical Modrinth project ids, `cf:<id>` for CurseForge projects and files,
or immutable `local:` pins for unidentified jars. Java is a version such as
`21.0.4`, not the output of `java -version`. `side: 'both'` checks the shared
artifact plan against separate server and client environments. `exclude`
retains explicitly removed top-level mod identities without source records.

`Pin` is `{ projectId, versionId, file, sha1, requested }`. A requested project
must remain unless explicitly removed. Its version may change when constraints
require it. An `add.versionId` pins an exact version. Adding and removing the
same project is a conflict.

Results are:

- `ok`: `{ plan: Pin[], changes: { added: Pin[], removed: Pin[], changed: { from: Pin, to: Pin }[] }, warnings: string[] }`.
  The plan is feasible and has the minimum number of existing-project changes.
- `conflict`: `{ explanation: string[] }`. Each line names a failed constraint.
  These lines are evidence from failed branches, not a minimal unsatisfiable core.
- `inconclusive`: `{ reason: string, tentative?: SolvedPlan }`. A tentative
  plan is a complete feasible selection whose minimum-change status is not
  proved. The installer can stage it with its warning and consent requirements.
  Without a complete witness, limits or missing information return no plan.

## Catalog boundary

`Catalog.versions(projectId, { mc, loader })` returns a complete compatible
domain of Modrinth `Version` objects. The solver checks MC and loader again.
Do not silently truncate pages or substitute a newest-only list. When an
installed version is missing from a nonempty domain, the result is inconclusive.

`Catalog.jarMeta(version)` returns `JarMeta`, with `ids` (primary id first,
then provides aliases), the jar's own `version`, `depends`, `breaks`, and
`nested: JarMeta[]`. `conflicts`, `recommends`, `name`, and `environment` are
optional. `readFabricJar(buffer)` reads this tree from real schema-1 jars.
It uses the existing `adm-zip` dependency and executes no jar code.

Two optional lookups fill gaps in the suggested interface:

- `providers(modId, { mc, loader })` returns every possible provider project
  as `string[]`, or `{ projects: string[], complete: boolean }` for partial
  coverage. Fabric mod ids are not Modrinth project ids. Only a complete
  empty index proves that no provider exists.
- `version(versionId): Promise<Version>` identifies the project for a required
  Modrinth dependency that specifies only a version id.

An unavailable lookup returns inconclusive when needed. A catalog error or
unreadable metadata also returns inconclusive, not conflict. Network adapters,
provider indexing, checksum verification of downloads, and shared caching are
the caller's responsibility. Per-solve domain and metadata reads are memoized.

## Selection rules

The search tries change budgets of zero, one, and so on. A changed installed
version or an omitted dependency-only project costs one. Explicit removals are
fixed, so they do not affect the optimization. A solution is returned only after
all smaller budgets have failed conclusively. Uncertainty at a smaller budget
permits only an inconclusive tentative plan. Requested projects and required dependencies
cannot be omitted. Unneeded dependencies stay when keeping them works.

Within a budget, installed pins come first. New choices prefer releases, newest
publication date first, followed by beta and alpha builds in publication order.
Input request order breaks ties between new projects. After a missing native
ID, known provider projects move deeper in later search trees so their version
alternatives are tried before unrelated version histories. This changes no
domain or budget. There is no objective to minimize downloads or prune orphans.

Fabric predicate behavior follows the specification and Fabric Loader 0.16.10:
arbitrary numeric component counts, ignored build metadata, prerelease ordering,
AND strings, OR arrays, equality-only opaque versions, wildcards, and `^0.x`
without npm's special case. Version matching and jar reading live in `fabric.ts`
so a second loader can replace those functions.

Nested jars follow Loader's `IF_POSSIBLE` rule. They are candidates enabled by
selected parents, not unconditional duplicate installations. The solver selects
a satisfiable mandatory closure, including each selected nested jar's own
dependencies and breaks. A mandatory top-level id cannot be shadowed by a
nested copy. Only one loaded candidate may claim a primary or provided id.
Aliases inherit the declaring jar's version. Nested activation is independent
on the server and client, which can choose different bundled versions from
the same top-level artifact. Loader can add other compatible
nested candidates greedily. Warnings describe the selected mandatory closure,
not every optional nested candidate Loader might add. Client-only nested trees,
non-mod nested jars, and missing nested declarations do not supply server ids.

Modrinth required relations demand the project and honor exact version pins.
Incompatible relations exclude the project pair, or only the named version.
Embedded and optional relations add nothing. Fabric id dependencies can be
satisfied by provides or nested jars without adding a separate project.

## Bounds and coverage

Defaults are `maxNodes: 100000`, `maxCatalogCalls: 2000`, and `maxMs: 5000`.
Counters cover all change budgets, provider expansion, and nested selection.
Catalog waits share the same elapsed deadline. A timeout stops waiting, but
cannot cancel an in-flight catalog request with this interface. Every exhausted
bound returns inconclusive, including one reached while proving optimality.

The installer uses a 60-second search deadline. `NetworkCatalog` separately
bounds downloads to 64 artifacts, 256 MiB total and 64 MiB per artifact, with
15-second HTTP timeouts. Its content-addressed cache is hash-checked on reuse.
Modrinth domains are complete lists. CurseForge domains paginate or fail, and
exact file lookups never substitute IDs. Author-disabled downloads require
manual work. The provider index combines observed metadata, slug lookups and
search, and always reports partial coverage.

The jar reader supports Fabric metadata schema 1, with a nesting depth limit of
32. Schema 0 and malformed metadata are inconclusive through `solve`. Forge,
NeoForge, dependency overrides, runtime mixin compatibility, and boot testing
are outside this module.

`node .github/solver-test.mjs` runs offline through the existing `tsx` dependency.
`node .github/solver-install.mjs` checks the public installer with real files,
Java and controlled external catalog/CDN responses in a temporary layout.
The corpus in `.github/fixtures/solver/recorded.json` contains nine unmodified
Modrinth version responses and recursive metadata extracted from SHA-1-verified
Fabric 1.21.1 jars. `record.mjs` beside it refreshes that corpus manually.
Tests reconstruct metadata-only zip trees; they do not redistribute jar code.
Counterfactual ranges and relations are explicitly labeled in the test script.
The 100-mod cached smoke check verifies completed work under one second, but is
not a benchmark of a real mod pack or a cold network catalog.

References: [fabric.mod.json specification](https://wiki.fabricmc.net/documentation:fabric_mod_json_spec),
[version predicates](https://github.com/FabricMC/fabric-loader/blob/0.16.10/src/main/java/net/fabricmc/loader/impl/util/version/VersionPredicateParser.java),
[version comparisons](https://github.com/FabricMC/fabric-loader/blob/0.16.10/src/main/java/net/fabricmc/loader/api/metadata/version/VersionComparisonOperator.java),
and [nested load conditions](https://github.com/FabricMC/fabric-loader/blob/0.16.10/src/main/java/net/fabricmc/loader/impl/discovery/ModCandidateImpl.java).
