import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { parse } from 'smol-toml';
import { compareMavenVersions, containsMaven, equalMavenRanges, matchesMaven, parseMavenRange, restrictMaven, type MavenVersion } from './maven.js';

interface Dependency {
  id: string;
  range: string;
  mandatory: boolean;
  type?: 'REQUIRED' | 'OPTIONAL' | 'INCOMPATIBLE' | 'DISCOURAGED';
  side: 'BOTH' | 'CLIENT' | 'SERVER';
  ordering: 'NONE' | 'BEFORE' | 'AFTER';
}
interface Mod { id: string; version: string; dependencies: Dependency[]; features: Record<string, string> }
interface Contained {
  group: string;
  artifact: string;
  range: string;
  version: string;
  path: string;
  obfuscated: boolean;
  jar: ForgeJar;
}
export interface ForgeJar {
  loader: 'forge' | 'neoforge';
  file: string;
  sha512: string;
  type: 'MOD' | 'LIBRARY' | 'GAMELIBRARY' | 'LANGPROVIDER';
  module: string;
  jarVersion: string;
  mods: Mod[];
  language?: { id: string; range: string };
  environment?: 'client';
  /** A certified service-only bootstrap discovers these instead of itself. */
  discovered?: ForgeJar[];
  nested: Contained[];
  unknown: string[];
}
export interface ForgeRuntime {
  mc: string;
  /** Shared FML model; omitted loader retains the Forge API. */
  loader?: 'forge' | 'neoforge';
  forge: string;
  java: string;
  /** Implementation versions of the installed language providers, not Forge. */
  languages: Record<string, string>;
  features?: Record<string, string>;
}
// Checked against the published loader sources and installed language loaders.
export const FORGE_PROFILES: Record<string, { maven: MavenVersion; languages: Record<string, string>; compatible: Record<string, string[]>;
  bundles?: { group: string; artifact: string; module: string }[] }> = {
  '1.20.1-47.4.28': { maven: '3.8.5', languages: { javafml: '47', lowcodefml: '47' }, compatible: { forge: ['47.1.79'] } },
  '1.21.1-52.1.20': { maven: '3.8.8', languages: { javafml: '52', lowcodefml: '52' }, compatible: { minecraft: ['1.21'], forge: ['51.0.33'] } },
};
export const NEOFORGE_PROFILES: typeof FORGE_PROFILES = {
  '1.21.1-21.1.219': { maven: '3.8.5', languages: { javafml: '4.0.42', lowcodefml: '4.0.42' }, compatible: { minecraft: ['1.21'], neoforge: ['21.0.166'] },
    // The universal jar participates in JarJar too. Until negotiated with
    // these pinned bundles, competing coordinates or identities are unknown.
    bundles: [{ group: 'io.github.llamalad7', artifact: 'mixinextras-neoforge', module: 'mixinextras.neoforge' },
      { group: 'net.neoforged', artifact: 'neoforge-coremods', module: 'neoforge.coremods' }] },
};
interface Artifact { owner: string; meta: ForgeJar }
export type ForgeResult =
  | { status: 'ok'; missing: { id: string; range: string; owner: string }[]; suppressible: boolean; warnings: string[] }
  | { status: 'conflict'; reason: string }
  | { status: 'inconclusive'; reason: string };

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected Forge metadata table');
  return value as Record<string, unknown>;
};
const string = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('Expected Forge metadata string');
  return value;
};
const bool = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw new Error('Expected Forge metadata boolean');
  return value;
};
const list = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error('Expected Forge metadata list');
  return value;
};
const id = (value: unknown): string => {
  const result = string(value);
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(result)) throw new Error(`Invalid Forge mod id ${result}`);
  return result;
};
// A library's explicit Java module descriptor wins over its filename/manifest.
// Read its Module attribute without loading any classes or executing jar code.
function moduleName(data: Buffer): string {
  if (data.readUInt32BE() !== 0xcafebabe) throw new Error('Invalid module-info.class');
  const pool: (string | number | undefined)[] = [];
  let offset = 10;
  for (let i = 1; i < data.readUInt16BE(8); i++) {
    const tag = data[offset++];
    if (tag === 1) { const size = data.readUInt16BE(offset); offset += 2; pool[i] = data.subarray(offset, offset + size).toString('utf8'); offset += size; }
    else if ([7, 8, 16, 19, 20].includes(tag)) { pool[i] = data.readUInt16BE(offset); offset += 2; }
    else if ([3, 4, 9, 10, 11, 12, 17, 18].includes(tag)) offset += 4;
    else if (tag === 5 || tag === 6) { offset += 8; i++; }
    else if (tag === 15) offset += 3;
    else throw new Error('Unsupported module-info constant');
  }
  offset += 6;
  offset += 2 + 2 * data.readUInt16BE(offset); // interfaces
  for (let part = 0; part < 2; part++) {
    const count = data.readUInt16BE(offset); offset += 2;
    for (let i = 0; i < count; i++) {
      offset += 6;
      const attributes = data.readUInt16BE(offset); offset += 2;
      for (let j = 0; j < attributes; j++) offset += 6 + data.readUInt32BE(offset + 2);
    }
  }
  const attributes = data.readUInt16BE(offset); offset += 2;
  for (let i = 0; i < attributes; i++) {
    const name = pool[data.readUInt16BE(offset)], size = data.readUInt32BE(offset + 2); offset += 6;
    if (name === 'Module') return string(pool[Number(pool[data.readUInt16BE(offset)])]);
    offset += size;
  }
  throw new Error('module-info has no Module attribute');
}

/** Certified FML metadata profiles. Bounded, with no executed jar code. */
export function readForgeJar(bytes: Buffer, file: string, context: Pick<ForgeRuntime, 'mc' | 'forge' | 'loader'>): ForgeJar {
  const neo = context.loader === 'neoforge';
  const metadataPath = neo ? 'META-INF/neoforge.mods.toml' : 'META-INF/mods.toml';
  const profile = (neo ? NEOFORGE_PROFILES : FORGE_PROFILES)[`${context.mc}-${context.forge}`];
  if (!profile) throw new Error('This Forge runtime metadata profile is not certified');
  const maven = profile.maven;
  const range = (value: unknown): string => { const text = string(value); parseMavenRange(text, maven); return text; };
  const services = [...(neo ? ['net.neoforged.neoforgespi.locating.IModFileCandidateLocator', 'net.neoforged.neoforgespi.locating.IDependencyLocator',
    'net.neoforged.neoforgespi.locating.IModFileReader', 'net.neoforged.neoforgespi.language.IModLanguageLoader',
    'net.neoforged.neoforgespi.earlywindow.ImmediateWindowProvider', 'net.neoforged.neoforgespi.earlywindow.GraphicsBootstrapper',
    'cpw.mods.modlauncher.serviceapi.ITransformerDiscoveryService'] :
    ['net.minecraftforge.forgespi.locating.IModLocator', 'net.minecraftforge.forgespi.locating.IDependencyLocator',
    'net.minecraftforge.forgespi.language.IModLanguageProvider', 'net.minecraftforge.fml.loading.ImmediateWindowProvider']),
    'cpw.mods.modlauncher.api.ITransformationService'];
  let expanded = 0, artifacts = 0;
  const read = (data: Buffer, name: string, depth: number, defaultType: ForgeJar['type']): ForgeJar => {
    if (depth > 32 || ++artifacts > 4096) throw new Error('Forge nested jar limit exceeded');
    const zip = new AdmZip(data);
    const text = (path: string): string | undefined => {
      const entry = zip.getEntry(path);
      if (!entry) return undefined;
      if (entry.header.size > 1024 * 1024) throw new Error(`Forge metadata exceeds one MiB: ${path}`);
      return entry.getData().toString('utf8');
    };
    const manifest = new Map<string, string>();
    for (const line of (text('META-INF/MANIFEST.MF') ?? '').replace(/\r?\n /g, '').split(/\r?\n/)) {
      if (!line) break; // main attributes only
      const colon = line.indexOf(': ');
      if (colon > 0) manifest.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 2));
    }
    const type = manifest.get('fmlmodtype') ?? (zip.getEntry(metadataPath) ? 'MOD' : defaultType);
    if (!(neo ? ['MOD', 'LIBRARY', 'GAMELIBRARY'] : ['MOD', 'LIBRARY', 'GAMELIBRARY', 'LANGPROVIDER']).includes(type)) throw new Error(`Unknown Forge file type ${type}`);
    const jar: ForgeJar = {
      loader: neo ? 'neoforge' : 'forge', file: name, type: type as ForgeJar['type'], jarVersion: manifest.get('implementation-version') ?? '0.0NONE',
      sha512: createHash('sha512').update(data).digest('hex'), module: '', mods: [], nested: [], unknown: [],
    };
    // AutoModpack 4.0.7 / Forge 1.20.1 (Modrinth KcBYU5P0): its dependency
    // locator always adds a separate main mod. The early locator adds only
    // the controlled client pack; server admission disables self-updating.
    const autoModpack = depth === 0 && /^automodpack.*\.jar$/i.test(basename(name)) && (neo
      ? context.mc === '1.21.1' && context.forge === '21.1.219' && jar.sha512 === '30a37438215c7cbee43f5761fc53d92f07a2a19094800df612647d77257850de65d7d66f19205e13ece7c85f41719bed2714d67504c2da6e5d483abfbf0361fd'
      : context.mc === '1.20.1' && context.forge === '47.4.28' && jar.sha512 === '3118fb1e4f3d36aa4c6f50fa1dca8b34747b43ae751817f73efefd37c5c1c50e9672bfafaa3591eaa34c68acf82a5ee46113d42d95913ff7cb6529644a4c4753');
    if (manifest.get('multi-release')?.toLowerCase() === 'true'
      && zip.getEntries().some((entry) => /^META-INF\/versions\/\d+\/module-info\.class$/.test(entry.entryName))) throw new Error('Versioned Forge module discovery is not certified');
    const descriptor = zip.getEntry('module-info.class');
    if (descriptor) {
      if (descriptor.header.size > 1024 * 1024) throw new Error('Forge module descriptor exceeds one MiB');
      if (!(neo && zip.getEntry(metadataPath))) jar.module = moduleName(descriptor.getData());
      // Custom module-provided discovery/language services can alter the graph.
      const raw = descriptor.getData().toString('latin1');
      if (services.some((service) => raw.includes(service) || raw.includes(service.replaceAll('.', '/')))) jar.unknown.push('Custom Forge module service');
    }
    for (const service of services) {
      if (text(`META-INF/services/${service}`)?.trim() && !autoModpack) jar.unknown.push(`Custom Forge service ${service}`);
    }
    const toml = text(metadataPath);
    if (toml !== undefined) {
      const raw = object(parse(toml));
      if (neo && (raw.license === undefined || !string(raw.license).trim())) throw new Error('NeoForge mod metadata requires a nonblank license');
      const properties = raw.properties === undefined ? {} : object(raw.properties);
      if (Object.hasOwn(properties, 'jarVersion') || Object.hasOwn(properties, '__FORGE__not_a_forge_mod')) throw new Error('Forge property uses a reserved loader key');
      let substitutions = 0;
      const substitute = (value: string, ancestors = new Set<string>()): string => {
        if (++substitutions > 4096 || value.length > 512 || ancestors.size > 16) throw new Error('Forge version substitution exceeds limits');
        if (value.includes('$${') || value.includes(':-')) throw new Error('Unsupported Forge substitution syntax');
        let result = '', offset = 0;
        for (const match of value.matchAll(/\$\{([^{}]+)\}/g)) {
          const key = match[1], [prefix, name] = key.split('.');
          if (ancestors.has(key)) throw new Error('Cyclic Forge substitution');
          const replacement = prefix === 'file' ? name === 'jarVersion' ? jar.jarVersion : Object.hasOwn(properties, name) ? properties[name] : 'null'
            : key === 'global.mcVersion' ? context.mc : key === (neo ? 'global.neoForgeVersion' : 'global.forgeVersion') ? context.forge : undefined;
          if (replacement === undefined || (typeof replacement === 'object' && replacement !== null)) throw new Error(`Unmodeled Forge substitution ${key}`);
          const expanded = substitute(String(replacement), new Set([...ancestors, key]));
          const prefixText = value.slice(offset, match.index);
          if (result.length + prefixText.length + expanded.length > 512) throw new Error('Forge version substitution exceeds limits');
          result += prefixText + expanded;
          offset = match.index + match[0].length;
        }
        if (result.length + value.length - offset > 512) throw new Error('Forge version substitution exceeds limits');
        result += value.slice(offset);
        if (result.includes('${')) throw new Error('Unresolved Forge substitution');
        return result;
      };
      jar.language = { id: string(raw.modLoader), range: range(raw.loaderVersion) };
      jar.environment = !neo && ((raw.clientSideOnly !== undefined && bool(raw.clientSideOnly)) || (context.mc === '1.20.1' && properties.__FORGE_clientSideOnly === true)) ? 'client' : undefined;
      let maybeNotForge = !neo && context.mc === '1.21.1' && jar.language.id === 'javafml' && jar.language.range === '[2,)' && !jar.environment;
      const dependencies = raw.dependencies === undefined ? {} : object(raw.dependencies);
      const features = raw.features === undefined ? {} : object(raw.features);
      jar.mods = list(raw.mods).map((value) => {
        const mod = object(value), modId = id(mod.modId);
        if (mod.namespace !== undefined && !/^[a-z][a-z0-9_.-]{1,63}$/.test(string(mod.namespace))) throw new Error('Invalid Forge namespace');
        const version = substitute(mod.version === undefined ? '1' : string(mod.version));
        if (!/^\d+/.test(version)) throw new Error(`Invalid Forge mod version ${version}`);
        compareMavenVersions(version, version, maven);
        const deps = Object.hasOwn(dependencies, modId) ? list(dependencies[modId]) : [];
        const bounds = Object.hasOwn(features, modId) ? object(features[modId]) : {};
        return { id: modId, version, features: Object.fromEntries(Object.entries(bounds).map(([k, v]) => [k, string(v)])), dependencies: deps.map((value) => {
          const dep = object(value), side = dep.side ?? 'BOTH', ordering = dep.ordering ?? 'NONE';
          if (!['BOTH', 'CLIENT', 'SERVER'].includes(string(side)) || !['NONE', 'BEFORE', 'AFTER'].includes(string(ordering))) throw new Error('Invalid Forge dependency side or ordering');
          const modId = id(dep.modId);
          if (modId === 'forge') maybeNotForge = false;
          if (neo) {
            const type = dep.type === undefined ? 'REQUIRED' : string(dep.type).toUpperCase();
            if (!['REQUIRED', 'OPTIONAL', 'INCOMPATIBLE', 'DISCOURAGED'].includes(type)) throw new Error(`Invalid NeoForge dependency type ${type}`);
            return { id: modId, range: dep.versionRange === undefined ? ' ' : range(dep.versionRange), mandatory: type === 'REQUIRED',
              type: type as Dependency['type'], side: side as Dependency['side'], ordering: ordering as Dependency['ordering'] };
          }
          return { id: modId, range: dep.versionRange === undefined ? '' : range(dep.versionRange), mandatory: dep.mandatory === undefined && maybeNotForge
            ? true : bool(dep.mandatory), side: side as Dependency['side'], ordering: ordering as Dependency['ordering'] };
        }) };
      });
      if (!jar.mods.length) throw new Error('Forge mods.toml has no mods');
      if (maybeNotForge) throw new Error('This javafml [2,) artifact is not a Forge mod');
    } else if (depth === 0 && type === 'MOD' && !manifest.has('fmlmodtype')) throw new Error('Jar has no Forge metadata');
    jar.module ||= jar.mods[0]?.id ?? manifest.get('automatic-module-name')
      // SecureJarHandler removes every dash-numeric segment, not the suffix.
      // Uncertified identities must fail before nested suppression can use them.
      ?? basename(name).replace(/\.[^.]*$/, '').replace(/-[.\d]+/g, '').replace(/[^A-Za-z0-9]/g, '.').replace(/\.+/g, '.').replace(/^\.|\.$/g, '');
    // SecureJarHandler 3 additionally prefixes numeric/keyword components.
    if (neo && !descriptor && !jar.mods.length && !manifest.has('automatic-module-name')) jar.module = jar.module.split('.').map((part) =>
      /^\d/.test(part) || /^(?:abstract|continue|for|new|switch|assert|default|goto|package|synchronized|boolean|do|if|private|this|break|double|implements|protected|throw|byte|else|import|public|throws|case|enum|instanceof|return|transient|catch|extends|int|short|try|char|final|interface|static|void|class|finally|long|strictfp|volatile|const|float|native|super|while)$/.test(part) ? `_${part}` : part).join('.');
    if (!descriptor && !jar.mods.length && !manifest.has('automatic-module-name')
      && (!jar.module || jar.module.split('.').some((part) => /^\d/.test(part)
        || /^(?:abstract|continue|for|new|switch|assert|default|goto|package|synchronized|boolean|do|if|private|this|break|double|implements|protected|throw|byte|else|import|public|throws|case|enum|instanceof|return|transient|catch|extends|int|short|try|char|final|interface|static|void|class|finally|long|strictfp|volatile|const|float|native|super|while|true|false|null)$/.test(part))
        || /-\./.test(basename(name)))) throw new Error('Implicit Forge module identifier is not certified');
    if (profile.bundles?.some((bundle) => bundle.module === jar.module)) throw new Error('Jar identity competes with a certified NeoForge runtime bundle');
    const metadata = text('META-INF/jarjar/metadata.json');
    if (metadata !== undefined && !(neo && autoModpack)) jar.nested = list(object(JSON.parse(metadata)).jars).map((value) => {
      const item = object(value), identifier = object(item.identifier), version = object(item.version);
      if (profile.bundles?.some((bundle) => bundle.group === identifier.group && bundle.artifact === identifier.artifact)) throw new Error('JarJar coordinate competes with a certified NeoForge runtime bundle');
      const path = string(item.path);
      if (path.startsWith('/') || path.includes('\\') || path.split('/').some((p) => !p || p === '.' || p === '..')) throw new Error('Unsafe Forge nested jar path');
      const entry = zip.getEntry(path);
      if (!entry) throw new Error(`Missing Forge nested jar ${path}`);
      expanded += entry.header.size;
      if (expanded > 64 * 1024 * 1024) throw new Error('Forge nested jar expansion exceeds 64 MiB');
      const artifactVersion = string(version.artifactVersion);
      compareMavenVersions(artifactVersion, artifactVersion, maven);
      return { group: string(identifier.group), artifact: string(identifier.artifact), range: range(version.range), version: artifactVersion,
        path, obfuscated: item.isObfuscated === undefined ? false : bool(item.isObfuscated),
        jar: read(entry.getData(), basename(path), depth + 1, neo || type === 'LIBRARY' || type === 'LANGPROVIDER' ? 'LIBRARY' : 'GAMELIBRARY') };
    });
    if (autoModpack) {
      const main = zip.getEntry('META-INF/jarjar/automodpack-mod.jar');
      if (!main || main.header.size > 64 * 1024 * 1024) throw new Error('Invalid certified AutoModpack main jar');
      jar.discovered = [read(main.getData(), 'automodpack-mod.jar', depth + 1, 'MOD')];
    }
    return jar;
  };
  return read(bytes, file, 0, 'MOD');
}

/** Recompute discovery/JarJar for the whole proposed inventory on each side.
 * Ambiguous runtime choices are unknown feasibility, never a tentative plan. */
export function validateForge(artifacts: Artifact[], side: 'server' | 'client', runtime: ForgeRuntime, tick = (): void => {}): ForgeResult {
  const neo = runtime.loader === 'neoforge';
  let suppressible = false;
  // A future top-level provider can suppress a discovered nested file, even
  // when that file (rather than its dependency target) declares the failure.
  // Until that alternative is searched, rejection is not impossibility.
  const conflict = (reason: string): ForgeResult => ({ status: suppressible ? 'inconclusive' : 'conflict',
    reason: suppressible ? `${reason}; a top-level artifact could suppress an effective nested file` : reason });
  const unknown = (reason: string): ForgeResult => ({ status: 'inconclusive', reason });
  const identity = (jar: ForgeJar): string => jar.mods.map((mod) => mod.id).join('') || (neo ? `library:${jar.module}` : jar.module || jar.file);
  const unique = (input: Artifact[]): Artifact[] => {
    const files = new Map<string, Artifact>();
    for (const file of input) {
      tick();
      const key = file.meta.mods[0]?.id ?? file.meta.module;
      const prior = files.get(key);
      if (prior && prior.meta.sha512 !== file.meta.sha512) throw new Error(`Multiple Forge artifacts share first identity ${key}; discovery deduplication is not certified`);
      files.set(key, file);
    }
    return [...files.values()];
  };
  try {
    const profile = (neo ? NEOFORGE_PROFILES : FORGE_PROFILES)[`${runtime.mc}-${runtime.forge}`];
    if (!profile) return unknown('This Forge runtime metadata profile is not certified');
    if (artifacts.some((file) => file.meta.loader !== (neo ? 'neoforge' : 'forge'))) return unknown('Native metadata does not match the installed FML loader');
    const maven = profile.maven;
    const top = artifacts.filter((file) => side === 'client' || file.meta.environment !== 'client');
    const injected = top.flatMap((file) => (file.meta.discovered ?? []).map((meta) => ({ owner: file.owner, meta })));
    if (injected.length) {
      if (side === 'client' && top.some((file) => !file.meta.mods.length)) return unknown('AutoModpack client discovery of non-mod Forge libraries is not certified');
      const ids = new Set(injected.map((file) => identity(file.meta)));
      const collision = (jar: ForgeJar): boolean => ids.has(identity(jar)) || jar.nested.some((entry) => collision(entry.jar));
      if (top.some((file) => collision(file.meta)) || new Set(injected.map((file) => identity(file.meta))).size !== injected.length) return unknown('AutoModpack dependency-locator identity competes with another root or JarJar file');
    }
    // Forge excludes transformation-service jars from ordinary mod discovery.
    // AutoModpack's outer mods.toml is not an effective mod on either side.
    const roots = unique([...top.filter((file) => !file.meta.discovered), ...injected]);
    const groups = new Map<string, { entry: Contained; owner: string }[]>();
    const discover = (file: Artifact): void => {
      for (const entry of file.meta.nested) {
        tick();
        const key = JSON.stringify([entry.group, entry.artifact]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push({ entry, owner: file.owner });
        discover({ meta: entry.jar, owner: file.owner }); // before selection, including discarded parents
      }
    };
    roots.forEach(discover);
    const loaded = [...roots];
    const rootIds = new Set(roots.map((file) => identity(file.meta)));
    const nestedIds = new Map<string, ForgeJar>();
    for (const [key, entries] of groups) {
      tick();
      const distinct: Contained[] = [];
      // ponytail: bounded quadratic equality within one GAV group; hash keys
      // would have to duplicate Maven's canonicalization and equality rules.
      for (const { entry } of entries) if (!distinct.some((prior) => {
        tick();
        return prior.path === entry.path && prior.obfuscated === entry.obfuscated
          && compareMavenVersions(prior.version, entry.version, maven) === 0
          && equalMavenRanges(parseMavenRange(prior.range, maven), parseMavenRange(entry.range, maven), maven);
      })) distinct.push(entry);
      let candidates = entries;
      if (distinct.length > 1) {
        const ranges = distinct.map((entry) => { tick(); return parseMavenRange(entry.range, maven); });
        if (ranges.some((range) => range.recommended !== undefined || range.restrictions.slice(0, -1).some((r) => r.upper === undefined))) {
          return unknown(`JarJar ${key} has order-sensitive recommended or unsorted ranges; runtime aggregation is not certified`);
        }
        const combined = ranges.reduce((a, b) => { tick(); return restrictMaven(a, b, maven); });
        if (combined.recommended !== undefined || !combined.restrictions.length) return conflict(`JarJar ${key} has incompatible or recommended aggregate ranges`);
        candidates = entries.filter(({ entry }) => containsMaven(entry.version, combined, maven));
        if (!candidates.length) return unknown(`JarJar ${key} has no matching bundled version; an unsearched bundle could supply it`);
      }
      // JarJar 0.3 and 0.4.1 choose hash-collection order, not the highest version.
      const bytes = new Set(candidates.map(({ entry }) => `${identity(entry.jar)}:${entry.jar.sha512}`));
      if (bytes.size > 1) return unknown(`JarJar ${key} can select different effective bytes; runtime selection is not certified`);
      const chosen = candidates[0], jar = chosen.entry.jar, ident = identity(jar);
      if (rootIds.has(ident)) continue; // suppression happens after range negotiation
      const prior = nestedIds.get(ident);
      if (prior && prior.sha512 !== jar.sha512) return unknown(`JarJar selections collide at runtime identity ${ident}`);
      if (!prior) loaded.push({ owner: chosen.owner, meta: jar });
      nestedIds.set(ident, jar);
    }
    suppressible = loaded.length > roots.length;
    const files = unique(loaded), mods = new Map<string, { file: Artifact; mod: Mod }>();
    const firstIds = new Map<string, Artifact>();
    const missing: { id: string; range: string; owner: string }[] = [];
    const warnings: string[] = [];
    for (const file of files) {
      tick();
      const jar = file.meta;
      if (jar.unknown.length) return unknown(`${jar.file}: ${jar.unknown.join('; ')}`);
      if (jar.type === 'LANGPROVIDER') return unknown(`Custom Forge language provider ${jar.file}`);
      if (jar.type === 'LIBRARY' && jar.mods.length) return unknown(`Forge plugin-layer mod metadata in ${jar.file} is not certified`);
      if (jar.language) {
        const version = Object.hasOwn(runtime.languages, jar.language.id) ? runtime.languages[jar.language.id] : undefined;
        if (!['javafml', 'lowcodefml'].includes(jar.language.id) || !version) return unknown(`Forge language provider ${jar.language.id} version is not certified`);
        if (!matchesMaven(version, jar.language.range, maven)) return conflict(`${jar.file} requires language ${jar.language.id} ${jar.language.range}, installed ${version}`);
      }
      if (jar.mods[0]) firstIds.set(jar.mods[0].id, file);
      for (const mod of jar.mods) {
        if (mods.has(mod.id) || ['minecraft', neo ? 'neoforge' : 'forge'].includes(mod.id)) return conflict(`Duplicate Forge mod id ${mod.id}`);
        mods.set(mod.id, { file, mod });
      }
    }
    // FML 4 sorts individual mod IDs, including secondary IDs in one jar.
    const vertices: (Artifact | Mod)[] = neo ? [...mods.values()].map(({ mod }) => mod) : files;
    const edges = new Map(vertices.map((vertex) => [vertex, new Set<Artifact | Mod>()]));
    const builtins = new Map([['minecraft', runtime.mc], [neo ? 'neoforge' : 'forge', runtime.forge]]);
    const compatible = (id: string, version: string, range: string): boolean => matchesMaven(version, range, maven) || version === '0.0NONE'
      || (profile.compatible[id] ?? []).some((version) => matchesMaven(version, range, maven));
    for (const { file, mod } of mods.values()) {
      tick();
      for (const [feature, bound] of Object.entries(mod.features)) {
        if (feature === 'openGLVersion' && side === 'server') continue;
        const value = feature === 'javaVersion' ? runtime.java : runtime.features?.[feature];
        if (!value) return unknown(`${mod.id} declares unverified Forge feature ${feature} ${bound}`);
        if (!matchesMaven(value, bound, maven)) return conflict(`${mod.id} requires Forge feature ${feature} ${bound}, installed ${value}`);
      }
      for (const dep of mod.dependencies) {
        tick();
        if (dep.side === 'BOTH' || dep.side.toLowerCase() === side) {
          const version = builtins.get(dep.id) ?? mods.get(dep.id)?.mod.version;
          if (dep.type === 'INCOMPATIBLE' || dep.type === 'DISCOURAGED') {
            if (version !== undefined && compatible(dep.id, version, dep.range)) {
              const reason = `${mod.id} ${dep.type === 'INCOMPATIBLE' ? 'is incompatible with' : 'discourages'} ${dep.id} ${dep.range}, installed ${version}`;
              if (dep.type === 'INCOMPATIBLE') return conflict(reason);
              warnings.push(reason);
            }
          } else if (version === undefined && dep.mandatory) missing.push({ id: dep.id, range: dep.range, owner: mod.id });
          else if (version !== undefined && !compatible(dep.id, version, dep.range)) {
            const target = mods.get(dep.id);
            if (target && !roots.includes(target.file)) missing.push({ id: dep.id, range: dep.range, owner: mod.id });
            else return conflict(`${mod.id} requires ${dep.mandatory ? '' : 'optional '} ${dep.id} ${dep.range}, installed ${version}`);
          }
        }
        // Neither loader filters ordering by dependency side.
        const self = neo ? mod : file;
        const target = neo ? mods.get(dep.id)?.mod : firstIds.get(dep.id);
        if (target && target !== self && dep.ordering !== 'NONE') {
          edges.get(dep.ordering === 'BEFORE' ? self : target)!.add(dep.ordering === 'BEFORE' ? target : self);
        }
      }
    }
    const visiting = new Set<Artifact | Mod>(), done = new Set<Artifact | Mod>();
    const acyclic = (file: Artifact | Mod): boolean => {
      tick();
      if (visiting.has(file)) return false;
      if (done.has(file)) return true;
      visiting.add(file);
      for (const target of edges.get(file)!) if (!acyclic(target)) return false;
      visiting.delete(file); done.add(file); return true;
    };
    if (!vertices.every(acyclic)) return conflict('FML dependency ordering has a cycle');
    return { status: 'ok', missing, suppressible, warnings };
  } catch (error) { return unknown(error instanceof Error ? error.message : String(error)); }
}
