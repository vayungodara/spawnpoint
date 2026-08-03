import AdmZip from 'adm-zip';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../config.js';
import { serverDir } from './servers.js';

// STATIC DEP PREFLIGHT (2026-08-02, from the boot-test research): every mod
// jar DECLARES its mandatory dependencies (fabric.mod.json `depends`,
// mods.toml `[[dependencies]]`). Reading those takes <1s cached — versus a
// 10-60s dry-boot that fails, gets its error text parsed, heals, and boots
// AGAIN. This scan feeds the heal BEFORE the first boot. It NEVER rejects
// anything on its own: version ranges are deliberately ignored and unknowns
// resolve to "fine" — the dry-boot remains the only authority, this is just
// the fast path to a complete folder.

interface JarMeta {
  ids: string[];      // mod ids this jar satisfies (own id + provides + nested jar-in-jar ids)
  deps: string[];     // mandatory dep ids this jar demands
}

// ids the platform itself satisfies — never "missing"
const BUILTIN = new Set([
  'minecraft', 'java', 'forge', 'neoforge', 'fabricloader', 'fabric-loader',
  'fabric', 'fabric-api', 'quilt_loader', 'quilt_base', 'mixinextras', 'mods',
]);

function parseFabricJson(buf: Buffer): { ids: string[]; deps: string[]; nested: string[] } {
  const j = JSON.parse(buf.toString('utf8')) as {
    id?: string; provides?: string[]; depends?: Record<string, unknown>; jars?: { file: string }[];
  };
  return {
    ids: [j.id ?? '', ...(j.provides ?? [])].filter(Boolean),
    deps: Object.keys(j.depends ?? {}),
    nested: (j.jars ?? []).map((x) => x.file).filter(Boolean),
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
  /** mod ids claimed by more than one jar — a signal, not junk (the patched-
      architectury lesson): logged, never acted on */
  duplicates: string[];
  scanned: number;
}

export function scanMissingDeps(serverId: string): StaticScan {
  const modsDir = join(serverDir(serverId), 'mods');
  const out: StaticScan = { missing: [], requesters: {}, duplicates: [], scanned: 0 };
  if (!existsSync(modsDir)) return out;

  const c = loadCache();
  let dirty = false;
  const satisfied = new Set<string>(BUILTIN);
  const idOwners = new Map<string, string[]>();
  const wants = new Map<string, string[]>();

  for (const jar of readdirSync(modsDir).filter((f) => f.endsWith('.jar'))) {
    const p = join(modsDir, jar);
    let key: string;
    try { key = `${jar}:${statSync(p).size}`; } catch { continue; }
    let meta = c[key];
    if (!meta) {
      try { meta = scanJarBuffer(readFileSync(p), 0); } catch { meta = { ids: [], deps: [] }; }
      c[key] = meta;
      dirty = true;
    }
    out.scanned++;
    for (const id of meta.ids) {
      satisfied.add(id);
      idOwners.set(id, [...(idOwners.get(id) ?? []), jar]);
    }
    for (const d of meta.deps) wants.set(d, [...(wants.get(d) ?? []), jar]);
  }

  if (dirty) {
    try {
      mkdirSync(PATHS.data, { recursive: true });
      // drop cache entries for jars that no longer exist (bounded growth)
      const live = new Set(readdirSync(modsDir).filter((f) => f.endsWith('.jar')).map((f) => {
        try { return `${f}:${statSync(join(modsDir, f)).size}`; } catch { return ''; }
      }));
      // keep other servers' entries: only prune keys that LOOK like this dir's
      // stale versions (same name, different size) — cheap heuristic, the
      // cache is disposable anyway
      writeFileSync(CACHE_FILE, JSON.stringify(c), 'utf8');
      void live;
    } catch { /* cache is an optimization, never an error */ }
  }

  // fabric-api submodules ("fabric-resource-loader-v0") ship INSIDE the
  // fabric-api / Forgified-Fabric-API jar in ways nested scanning can miss —
  // proven false positive on FreshMC (forge + Connector). They are never a
  // real hole: healing them isn't possible (no such standalone projects) and
  // the dry-boot judges the truth anyway.
  const submodule = /^(fabric|quilt)(-[a-z0-9]+)+-v\d+$/;
  for (const [dep, requesters] of wants) {
    if (!satisfied.has(dep) && !submodule.test(dep)) {
      out.missing.push(dep);
      out.requesters[dep] = requesters.slice(0, 4);
    }
  }
  for (const [id, owners] of idOwners) {
    if (owners.length > 1) out.duplicates.push(`${id} (${owners.join(' + ')})`);
  }
  return out;
}
