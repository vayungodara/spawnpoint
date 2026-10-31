import AdmZip from 'adm-zip';
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PATHS } from '../config.js';

// Static dependency scan. Every mod jar declares its mandatory dependencies
// (fabric.mod.json `depends`, mods.toml `[[dependencies]]`). Reading them
// takes under a second, so missing ones are installed before the first boot
// test instead of after a failed one. The scan never rejects anything: version
// ranges are ignored and unknowns count as fine. The boot test decides.

interface JarMeta {
  ids: string[];      // mod ids this jar satisfies (own id + provides + nested jar-in-jar ids)
  deps: string[];     // mandatory dep ids this jar demands
  serverOnly?: boolean; // fabric.mod.json "environment": "server" (never sent to clients)
}

// ids the loader itself satisfies — never "missing". Fabric API is a mod
// (its jar provides "fabric" and "fabric-api"), so it is not on this list.
const BUILTIN = new Set([
  'minecraft', 'java', 'forge', 'neoforge', 'fabricloader', 'fabric-loader',
  'quilt_loader', 'quilt_base', 'mixinextras', 'mods',
]);

function parseFabricJson(buf: Buffer): { ids: string[]; deps: string[]; nested: string[]; serverOnly: boolean } {
  const j = JSON.parse(buf.toString('utf8')) as {
    id?: string; provides?: string[]; depends?: Record<string, unknown>; jars?: { file: string }[]; environment?: string;
  };
  return {
    ids: [j.id ?? '', ...(j.provides ?? [])].filter(Boolean),
    deps: Object.keys(j.depends ?? {}),
    nested: (j.jars ?? []).map((x) => x.file).filter(Boolean),
    serverOnly: j.environment === 'server',
  };
}

/** mods.toml / neoforge.mods.toml — regex-level TOML: good enough for the
    modId/mandatory fields, and a misparse only costs us the fast path. */
function parseModsToml(text: string): { ids: string[]; deps: string[] } {
  const ids = [...text.matchAll(/^\s*modId\s*=\s*"([^"]+)"/gm)].map((m) => m[1]);
  const deps: string[] = [];
  // dependency blocks: [[dependencies.<owner>]] ... modId="x" ... mandatory=true | type="required"
  const blocks = text.split(/\[\[dependencies[^\]]*\]\]/).slice(1);
  for (const b of blocks) {
    const scope = b.split('[[')[0]; // don't read past the next table
    const modId = /modId\s*=\s*"([^"]+)"/.exec(scope)?.[1];
    if (!modId) continue;
    const mandatory = /mandatory\s*=\s*true/.test(scope) || /type\s*=\s*"required"/i.test(scope);
    const clientOnly = /side\s*=\s*"CLIENT"/i.test(scope);
    if (mandatory && !clientOnly) deps.push(modId);
  }
  // the first modId lines are the jar's OWN mods — they also appear inside
  // dependency blocks, so subtract those from ids
  const depSet = new Set(deps);
  return { ids: ids.filter((i) => !depSet.has(i) || ids.indexOf(i) === 0), deps };
}

function scanJarBuffer(buf: Buffer, depth: number): JarMeta {
  const meta: JarMeta = { ids: [], deps: [] };
  let zip: AdmZip;
  try { zip = new AdmZip(buf); } catch { return meta; }

  const fab = zip.getEntry('fabric.mod.json');
  if (fab) {
    try {
      const f = parseFabricJson(fab.getData());
      meta.ids.push(...f.ids);
      meta.deps.push(...f.deps);
      if (f.serverOnly && depth === 0) meta.serverOnly = true;
      if (depth < 2) {
        for (const rel of f.nested) {
          const e = zip.getEntry(rel);
          if (!e) continue;
          const n = scanJarBuffer(e.getData(), depth + 1);
          meta.ids.push(...n.ids); // a bundled lib SATISFIES its id
          // nested deps are the bundler's problem, not the folder's — skip
        }
      }
    } catch { /* malformed json — dry-boot will judge it */ }
  }

  for (const name of ['META-INF/mods.toml', 'META-INF/neoforge.mods.toml']) {
    const toml = zip.getEntry(name);
    if (!toml) continue;
    try {
      const t = parseModsToml(toml.getData().toString('utf8'));
      meta.ids.push(...t.ids);
      meta.deps.push(...t.deps);
    } catch { /* same contract */ }
    // forge jar-in-jar
    if (depth < 2) {
      const jj = zip.getEntry('META-INF/jarjar/metadata.json');
      if (jj) {
        try {
          const m = JSON.parse(jj.getData().toString('utf8')) as { jars?: { path?: string }[] };
          for (const rel of (m.jars ?? []).map((x) => x.path).filter((p): p is string => !!p)) {
            const e = zip.getEntry(rel);
            if (!e) continue;
            meta.ids.push(...scanJarBuffer(e.getData(), depth + 1).ids);
          }
        } catch { /* ignore */ }
      }
    }
    break;
  }
  return meta;
}

// cache keyed by name:size — a jar's declared deps never change in place
const CACHE_FILE = join(PATHS.data, 'jardeps.json');
let cache: Record<string, JarMeta> | null = null;
function loadCache(): Record<string, JarMeta> {
  if (cache) return cache;
  try { cache = JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Record<string, JarMeta>; }
  catch { cache = {}; }
  return cache;
}

export interface StaticScan {
  /** mandatory dep ids nothing in the folder (or platform) satisfies */
  missing: string[];
  /** which jars demanded each missing id — for honest log lines */
  requesters: Record<string, string[]>;
  /** mod ids claimed by more than one jar: logged, never acted on */
  duplicates: string[];
  scanned: number;
}

/** Declared metadata for one jar, cached by name and size. */
function metaOf(path: string): JarMeta {
  const c = loadCache();
  let key: string;
  try { key = `${basename(path)}:${statSync(path).size}`; } catch { return { ids: [], deps: [] }; }
  if (!c[key]) {
    try { c[key] = scanJarBuffer(readFileSync(path), 0); } catch { c[key] = { ids: [], deps: [] }; }
    cacheDirty = true;
  }
  return c[key];
}
let cacheDirty = false;
function flushCache(): void {
  if (!cacheDirty) return;
  try {
    mkdirSync(PATHS.data, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8');
    cacheDirty = false;
  } catch { /* the cache is an optimization, never an error */ }
}

const idsSeen = new Map<string, string[] | null>();
/** Mod ids a jar declares, nested jars included; null when it cannot be read.
    Keyed by this exact file, not the shared name-and-size cache. */
export function jarModIds(path: string): string[] | null {
  let key: string;
  try { const s = statSync(path); key = `${path}:${s.size}:${s.mtimeMs}:${s.ino}`; } catch { return null; }
  if (!idsSeen.has(key)) {
    try { idsSeen.set(key, scanJarBuffer(readFileSync(path), 0).ids); } catch { idsSeen.set(key, null); }
  }
  return idsSeen.get(key)!;
}

/** True for jars that declare themselves server-only (AutoModpack never ships those). */
export function isServerOnly(path: string): boolean {
  const m = metaOf(path).serverOnly === true;
  flushCache();
  return m;
}

/** Missing and duplicate mod ids across an explicit set of jars. */
/** `strict` keeps fabric/quilt submodule ids: a removal must not orphan them. */
export function scanJars(paths: string[], strict = false): StaticScan {
  const out: StaticScan = { missing: [], requesters: {}, duplicates: [], scanned: 0 };
  const satisfied = new Set<string>(BUILTIN);
  const idOwners = new Map<string, string[]>();
  const wants = new Map<string, string[]>();
  for (const p of paths) {
    const meta = metaOf(p);
    const jar = basename(p);
    out.scanned++;
    for (const id of meta.ids) {
      satisfied.add(id);
      idOwners.set(id, [...(idOwners.get(id) ?? []), jar]);
    }
    for (const d of meta.deps) wants.set(d, [...(wants.get(d) ?? []), jar]);
  }
  flushCache();

  // fabric-api submodules ("fabric-resource-loader-v0") ship inside the
  // fabric-api jar in ways nested scanning can miss. They have no standalone
  // projects to install, and the boot test judges them anyway.
  const submodule = /^(fabric|quilt)(-[a-z0-9]+)+-v\d+$/;
  for (const [dep, requesters] of wants) {
    if (!satisfied.has(dep) && (strict || !submodule.test(dep))) {
      out.missing.push(dep);
      out.requesters[dep] = requesters.slice(0, 4);
    }
  }
  for (const [id, owners] of idOwners) {
    if (owners.length > 1) out.duplicates.push(`${id} (${owners.join(' + ')})`);
  }
  return out;
}
