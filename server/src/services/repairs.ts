import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'smol-toml';
import { PATHS } from '../config.js';
import { identifyByHashes } from '../clients/modrinth.js';
import { candidate, candidateJava, candidateSet, checkRepair, stage, stagingPath, type StagedFile } from './packtxn.js';
import { detect, loaderVersion } from './detect.js';
import { serverDir } from './servers.js';
import { hashes } from './revisions.js';
import { ledgerEntries } from './ledger.js';
import { writeFileAtomic } from './platform.js';
import { ensureJdk } from './temurin.js';
import { NetworkCatalog } from './solver/catalog.js';
import { compareFabricVersions, readFabricJar } from './solver/fabric.js';
import { compareMavenVersions } from './solver/maven.js';
import { readForgeJar } from './solver/forge.js';
import { modIds } from './solver/index.js';

/** Loop identity only; source admission and locks independently use full hashes. */
export function repairKey(files: { file: string; sha1: string }[], java: string | null): string {
  return createHash('sha256').update(JSON.stringify({ java, files: files.map((f) => [f.file, f.sha1]).sort() })).digest('hex');
}

export async function repairInventory(id: string) {
  const c = candidate(id)!;
  const set = candidateSet(id, c);
  const paths = [...new Set([...set.serverJars, ...set.client.filter((f) => f.rel.startsWith('mods/') && f.rel.endsWith('.jar')).map((f) => f.src)])];
  const rows = [];
  for (const path of paths) rows.push({ path, file: basename(path), to: set.serverJars.includes(path) ? 'mods' as const : 'shelf' as const, ...await hashes(path) });
  return rows;
}

/** One evidence-backed change, never a loader/MC migration or a guessed slug.
    Applying the resulting candidate still requires exact-revision consent. */
export async function repairCandidate(id: string, log: (m: string) => void, failure?: string): Promise<boolean> {
  const c = candidate(id)!;
  const original = JSON.stringify(c);
  const det = detect(serverDir(id), id);
  const loader = loaderVersion(serverDir(id), det);
  if (!det.mc || !loader || !['fabric', 'forge', 'neoforge'].includes(det.loader)) return false;
  const native = (bytes: Buffer, file: string) => det.loader === 'fabric' ? readFabricJar(bytes)
    : readForgeJar(bytes, file, { mc: det.mc!, forge: loader, loader: det.loader as 'forge' | 'neoforge' });
  const rows = await repairInventory(id);
  const java = candidateJava(id);
  const before = repairKey(rows, java);
  const stable = async (): Promise<void> => {
    const current = await repairInventory(id);
    if (JSON.stringify(candidate(id)) !== original || repairKey(current, candidateJava(id)) !== before) throw new Error('the candidate changed during repair planning; test the new inventory');
  };
  const apply = async (kind: 'wrong-loader' | 'duplicate-mod', detail: string, files: StagedFile[], next: typeof rows, bytes?: Buffer): Promise<boolean> => {
    await stable();
    const repair = { kind, detail, before, after: repairKey(next, java) };
    checkRepair(id, repair);
    if (bytes) writeFileAtomic(stagingPath(id, files[0].file), bytes);
    const roots = files.flatMap((f) => f.entry ? [{ projectId: f.entry.projectId, versionId: f.entry.versionId, requested: true }] : []);
    stage(id, files, log, { repair, ...(kind === 'wrong-loader' ? { requests: [...c.requests?.filter((r) => !roots.some((root) => root.projectId === r.projectId)) ?? [], ...roots] } : {}) });
    log(`repair: ${kind}: ${detail}; retesting the complete candidate`);
    return true;
  };

  if (failure) {
    const error = /UnsupportedClassVersionError:\s*([\w/$]+(?:\.[\w$]+)*) has been compiled[^\r\n]*\(class file version (\d+)\.0\)[^\r\n]*up to (\d+)\.0/.exec(failure);
    if (!error) return false;
    const major = Number(error[2]);
    const required = major - 44;
    // Verify the named class bytes, including declared nested jars. Text alone
    // cannot authorize changing a runtime. Conflicting class providers stop.
    const classPath = `${error[1].replaceAll('.', '/')}.class`;
    const found: Buffer[] = [];
    let bytes = 0, entries = 0;
    const inspect = (buf: Buffer, depth: number): void => {
      if ((bytes += buf.length) > 64 * 1024 * 1024 || ++entries > 128 || depth > 8) throw new Error('wrong-java inspection reached its byte or nesting limit');
      const zip = new AdmZip(buf);
      const cls = zip.getEntry(classPath);
      if (cls) {
        if (cls.header.size > 4 * 1024 * 1024) throw new Error('the failing class exceeds the repair inspection limit');
        found.push(cls.getData());
      }
      const fabric = zip.getEntry('fabric.mod.json');
      const jarjar = zip.getEntry('META-INF/jarjar/metadata.json');
      const nested = fabric ? (JSON.parse(fabric.getData().toString()) as { jars?: { file: string }[] }).jars?.map((j) => j.file) ?? []
        : jarjar ? (JSON.parse(jarjar.getData().toString()) as { jars: { path: string }[] }).jars.map((j) => j.path) : [];
      for (const path of nested) {
        const entry = zip.getEntry(path);
        if (!entry || entry.header.size > 64 * 1024 * 1024 - bytes) throw new Error('a declared nested jar cannot be inspected within the repair limit');
        inspect(entry.getData(), depth + 1);
      }
    };
    for (const row of rows) {
      if (row.size > 64 * 1024 * 1024) throw new Error('wrong-java inspection reached its artifact size limit');
      inspect(readFileSync(row.path), 0);
    }
    if (found.length !== 1 || found[0].length < 8 || found[0].readUInt32BE(0) !== 0xcafebabe || found[0].readUInt16BE(6) !== major) throw new Error('wrong-java diagnostic did not identify one matching class in the candidate');
    if (found[0].readUInt16BE(4) === 65535 || required > 25 || (det.loader !== 'fabric' && required > 21)) throw new Error(`wrong-java: class version ${major} needs Java ${required}; no certified runtime repair is available without owner changes to the pack`);
    const feature = required <= 21 ? 21 : 25;
    if (!await ensureJdk(feature, log)) throw new Error(`wrong-java: could not obtain Java ${feature}`);
    const tools = join(PATHS.root, 'Tools');
    const name = readdirSync(tools).find((n) => n.startsWith(`jdk-${feature}`) && existsSync(join(tools, n, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')));
    if (!name) throw new Error('the required JDK is not available');
    const next = join(tools, name, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    await stable();
    const detail = `${classPath} has class-file version ${major} (Java ${required}); propose ${java} → ${next}, retaining Minecraft and loader versions`;
    stage(id, [], log, { java: next, repair: { kind: 'wrong-java', detail, before, after: repairKey(rows, next) } });
    return true;
  }

  // Only byte-identical top-level mods may be deduplicated automatically.
  // A shared nested ID or a provides alias is not evidence of a duplicate jar.
  const entries = [...c.files.flatMap((f) => f.entry ? [f.entry] : []), ...ledgerEntries(id)];
  rows.sort((a, b) => Number(entries.some((e) => e.file === b.file)) - Number(entries.some((e) => e.file === a.file)) || a.file.localeCompare(b.file));
  for (let i = 0; i < rows.length; i++) {
    const keep = rows[i];
    for (const drop of rows.slice(i + 1).filter((r) => r.to === keep.to && r.sha512 === keep.sha512 && r.size === keep.size)) {
      const a = entries.find((e) => e.file === keep.file), b = entries.find((e) => e.file === drop.file);
      if (a && b && (a.source !== b.source || a.projectId !== b.projectId)) continue;
      try {
        const ids = modIds(native(readFileSync(keep.path), keep.file));
        if (!ids.length || JSON.stringify(ids.sort()) !== JSON.stringify(modIds(native(readFileSync(drop.path), drop.file)).sort())) continue;
      }
      catch { continue; } // unknown discovery must remain inconclusive
      return apply('duplicate-mod', `Remove byte-identical ${drop.file}; retain ${keep.file} and its requested functionality`,
        [{ file: drop.file, to: drop.to, remove: true, duplicateOf: keep.file }], rows.filter((r) => r !== drop));
    }
  }

  for (const row of rows) {
    // Do not silently substitute an exact owner pin or rewrite a live jar.
    const uploaded = c.files.find((f) => !f.remove && !f.entry && stagingPath(id, f.file) === row.path);
    if (!uploaded) continue;
    const buf = readFileSync(row.path);
    const zip = new AdmZip(buf);
    const expected = det.loader === 'fabric' ? 'fabric.mod.json' : det.loader === 'forge' ? 'META-INF/mods.toml' : 'META-INF/neoforge.mods.toml';
    if (zip.getEntry(expected)) continue; // malformed/unknown metadata is not a wrong-loader diagnosis
    try { if (modIds(native(buf, row.file)).length) continue; } catch { /* inspect foreign top-level metadata */ }
    const foreign = ['fabric.mod.json', 'META-INF/mods.toml', 'META-INF/neoforge.mods.toml'].find((p) => zip.getEntry(p));
    if (!foreign) continue;
    const own = foreign === 'fabric.mod.json' ? [JSON.parse(zip.getEntry(foreign)!.getData().toString()).id as string]
      : ((parse(zip.getEntry(foreign)!.getData().toString()).mods ?? []) as { modId: string }[]).map((m) => m.modId);
    if (!own.length) continue;
    const source = (await identifyByHashes([row.sha1]))[row.sha1];
    if (!source || !source.files.some((f) => f.hashes.sha1.toLowerCase() === row.sha1 && f.hashes.sha512?.toLowerCase() === row.sha512 && f.size === row.size)) throw new Error(`wrong-loader: ${row.file} has no exact verified source; choose a compatible build explicitly`);
    if (c.requests?.some((r) => r.projectId === source.project_id && r.versionId)) throw new Error('wrong-loader: an exact owner pin cannot be substituted automatically; choose a compatible build');
    const catalog = new NetworkCatalog({ mc: det.mc, loader: det.loader as 'fabric' | 'forge' | 'neoforge', loaderVersion: loader }, undefined, { downloads: 8, bytes: 128 * 1024 * 1024 });
    const deadline = Date.now() + 60_000;
    const versions = (await catalog.versions(source.project_id)).filter((v) => v.project_id === source.project_id && v.game_versions.includes(det.mc!) && v.loaders.includes(det.loader));
    const current = entries.find((e) => e.source === 'modrinth' && e.projectId === source.project_id && rows.some((r) => r.file === e.file && r.sha1 === e.sha1));
    versions.sort((a, b) => Number(b.id === current?.versionId) - Number(a.id === current?.versionId)
      || Number(b.version_number === source.version_number) - Number(a.version_number === source.version_number)
      || Number(b.version_type === 'release') - Number(a.version_type === 'release') || Date.parse(b.date_published) - Date.parse(a.date_published));
    for (const version of versions.slice(0, 8)) {
      if (Date.now() >= deadline) throw new Error('wrong-loader repair reached its planning time limit');
      const file = version.files.find((f) => f.primary) ?? version.files[0];
      // Prepared bytes must not overwrite a manifest-referenced staged input.
      // A same-name substitution needs an explicit owner replacement instead.
      if (!file || file.filename.toLowerCase() === row.file.toLowerCase() || basename(file.filename) !== file.filename || !file.filename.endsWith('.jar') || rows.some((r) => r !== row && r.file.toLowerCase() === file.filename.toLowerCase()
        && (r.file !== file.filename || r.sha512 !== file.hashes.sha512?.toLowerCase() || r.size !== file.size))) continue;
      const path = await catalog.artifact(version);
      const meta = await catalog.jarMeta(version);
      const primary = 'loader' in meta ? modIds(meta) : meta.ids.slice(0, 1);
      if (!own.every((id) => primary.includes(id))) continue;
      const sum = await hashes(path);
      return apply('wrong-loader', `${row.file} (${source.project_id}/${source.id}) → ${file.filename} (${version.project_id}/${version.id}) for the existing ${det.loader} ${loader}, Minecraft ${det.mc}`,
        [{ file: file.filename, to: meta.environment === 'client' ? 'shelf' : row.to, replaces: row.file,
          entry: { file: file.filename, projectId: version.project_id, versionId: version.id, title: version.name, versionNumber: version.version_number,
            source: 'modrinth', sha1: sum.sha1, installedAt: new Date().toISOString(), via: 'direct' } }],
        rows.filter((r) => r !== row && r.file !== file.filename).concat({ ...row, ...sum, file: file.filename, path }), readFileSync(path));
    }
    throw new Error(`wrong-loader: no identity-preserving compatible build was verified within the repair limits for ${row.file}`);
  }
  return false;
}

export interface DuplicateMod {
  id: string;
  name: string;
  keep: { file: string; to: 'mods' | 'shelf'; version: string };
  drop: { file: string; to: 'mods' | 'shelf'; version: string }[];
}

/** Top-level jars in mods/ and on the client shelf that are versions of one
    native mod, newest first. Friends would receive both. Shared nested IDs
    and provides aliases are not duplicates; unreadable jars are skipped. */
export function duplicateMods(id: string): DuplicateMod[] {
  const det = detect(serverDir(id), id);
  const loader = loaderVersion(serverDir(id), det);
  if (!det.mc || !loader || !['fabric', 'forge', 'neoforge'].includes(det.loader)) return [];
  const set = candidateSet(id, { files: [] });
  const jars = [...set.serverJars.map((path) => ({ path, to: 'mods' as const })),
    ...set.client.filter((f) => f.rel.startsWith('mods/') && f.rel.endsWith('.jar') && !set.serverJars.includes(f.src)).map((f) => ({ path: f.src, to: 'shelf' as const }))];
  const groups = new Map<string, { file: string; to: 'mods' | 'shelf'; version: string; name: string }[]>();
  for (const jar of jars) {
    try {
      const meta = det.loader === 'fabric' ? readFabricJar(readFileSync(jar.path))
        : readForgeJar(readFileSync(jar.path), basename(jar.path), { mc: det.mc, forge: loader, loader: det.loader as 'forge' | 'neoforge' });
      const mod = modIds(meta)[0];
      if (!mod) continue;
      const version = 'loader' in meta ? meta.mods[0]?.version ?? meta.jarVersion : meta.version;
      const name = ('name' in meta && meta.name) || mod;
      groups.set(mod, [...groups.get(mod) ?? [], { file: basename(jar.path), to: jar.to, version, name }]);
    } catch { /* unreadable: never guess */ }
  }
  const newer = (a: string, b: string): number => (det.loader === 'fabric' ? compareFabricVersions(b, a) : compareMavenVersions(b, a))
    ?? b.localeCompare(a, undefined, { numeric: true });
  return [...groups].filter(([, list]) => list.length > 1).map(([mod, list]) => {
    const [keep, ...drop] = list.sort((a, b) => newer(a.version, b.version) || a.file.localeCompare(b.file));
    return { id: mod, name: keep.name, keep: { file: keep.file, to: keep.to, version: keep.version }, drop: drop.map(({ name: _, ...d }) => d) };
  });
}

/** Stage removal of every older duplicate; the normal tested flow and
    exact-revision consent apply before anything live changes. */
export function keepNewest(id: string, log: (m: string) => void): number {
  const drops = duplicateMods(id).flatMap((d) => d.drop.map((x): StagedFile => ({ file: x.file, to: x.to, remove: true, duplicateOf: d.keep.file })));
  if (drops.length) stage(id, drops, log);
  return drops.length;
}
