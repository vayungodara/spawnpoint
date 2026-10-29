import AdmZip from 'adm-zip';

export type Predicate = string | string[];
export interface JarMeta {
  /** Primary id first, followed by provides aliases. Aliases inherit this version. */
  ids: string[];
  version: string;
  name?: string;
  environment?: '*' | 'server' | 'client';
  depends: Record<string, Predicate>;
  breaks: Record<string, Predicate>;
  conflicts?: Record<string, Predicate>;
  recommends?: Record<string, Predicate>;
  nested: JarMeta[];
}

interface SemanticVersion { components: number[]; prerelease: string | null }

// Fabric's extended semver, not npm semver: any component count, leading
// zeroes, empty prerelease, arbitrary build key, and no special case for ^0.x.
function semantic(raw: string): SemanticVersion | undefined {
  const core = raw.split('+', 1)[0];
  const dash = core.indexOf('-');
  const numbers = dash < 0 ? core : core.slice(0, dash);
  const prerelease = dash < 0 ? null : core.slice(dash + 1);
  if (!/^\+?\d+(\.\+?\d+)*$/.test(numbers)) return undefined;
  if (prerelease !== null && !/^(?:[-0-9A-Za-z]+(?:\.[-0-9A-Za-z]+)*)?$/.test(prerelease)) return undefined;
  const components = numbers.split('.').map(Number);
  if (components.some((n) => n > 2147483647)) return undefined;
  return { components, prerelease };
}

function compare(a: SemanticVersion, b: SemanticVersion): number {
  for (let i = 0; i < Math.max(a.components.length, b.components.length); i++) {
    const delta = (a.components[i] ?? 0) - (b.components[i] ?? 0);
    if (delta) return Math.sign(delta);
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  const left = a.prerelease ? a.prerelease.split('.') : [];
  const right = b.prerelease ? b.prerelease.split('.') : [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === undefined) return -1;
    if (right[i] === undefined) return 1;
    const x = left[i], y = right[i];
    const nx = /^(0|[1-9]\d*)$/.test(x), ny = /^(0|[1-9]\d*)$/.test(y);
    if (nx !== ny) return nx ? -1 : 1;
    if (nx && x.length !== y.length) return Math.sign(x.length - y.length);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Undefined means the versions are not semantically orderable. */
export function compareFabricVersions(a: string, b: string): number | undefined {
  const left = semantic(a), right = semantic(b);
  return left && right ? compare(left, right) : undefined;
}

function term(raw: string): (version: string) => boolean {
  if (!raw || raw === '*') return () => true;
  const match = /^(>=|<=|>|<|=|~|\^)?(.*)$/.exec(raw);
  if (!match?.[2]) throw new Error(`Invalid Fabric predicate: ${raw}`);
  let op = match[1] ?? '=';
  let operand = match[2];
  const wildcard = /^(\d+(?:\.\d+)*)\.([xX*])(?:\.[xX*])*(?:\+.*)?$/.exec(operand);
  if (wildcard && semantic(wildcard[1])) {
    if (op !== '=') throw new Error(`Invalid Fabric wildcard: ${raw}`);
    op = wildcard[1].includes('.') ? '~' : '^';
    operand = `${wildcard[1]}-`;
  }
  const ref = semantic(operand);
  if (!ref && (op === '<' || op === '>')) throw new Error(`Invalid Fabric range: ${raw}`);
  return (version) => {
    const actual = semantic(version);
    // Inclusive operators on a non-semantic version reduce to string equality.
    if (!actual || !ref) return op !== '<' && op !== '>' && version === operand;
    const order = compare(actual, ref);
    switch (op) {
      case '=': return order === 0;
      case '>': return order > 0;
      case '>=': return order >= 0;
      case '<': return order < 0;
      case '<=': return order <= 0;
      case '^': return order >= 0 && actual.components[0] === ref.components[0];
      case '~': return order >= 0 && actual.components[0] === ref.components[0]
        && (actual.components[1] ?? 0) === (ref.components[1] ?? 0);
      default: throw new Error(`Invalid Fabric operator: ${op}`);
    }
  };
}

/** Space-separated AND; an array is OR. Invalid exclusive string ranges throw. */
export function matchesFabric(version: string, predicate: Predicate): boolean {
  // Compile every term, even after a match, like Fabric's metadata parser.
  const alternatives = (Array.isArray(predicate) ? predicate : [predicate])
    .map((p) => p.split(' ').map((s) => term(s.trim())));
  return alternatives.some((terms) => terms.every((test) => test(version)));
}

/** Loader-specific boundary. Reads only metadata; never runs code from a jar. */
export function readFabricJar(buffer: Buffer, maxDepth = 32): JarMeta {
  let expanded = 0;
  const read = (data: Buffer, depth: number): JarMeta | undefined => {
    if (depth > maxDepth) throw new Error('Fabric nested jar depth exceeded');
    const zip = new AdmZip(data);
    const json = zip.getEntry('fabric.mod.json');
    if (!json) {
      if (depth > 0) return undefined; // Loader ignores bundled non-mod libraries.
      throw new Error('Jar has no fabric.mod.json');
    }
    if (json.header.size > 1024 * 1024) throw new Error('Fabric metadata exceeds one MiB');
    const raw = JSON.parse(json.getData().toString('utf8')) as Record<string, unknown>;
    if (raw.schemaVersion !== 1) throw new Error('Only Fabric metadata schema 1 is supported');
    if (typeof raw.id !== 'string' || typeof raw.version !== 'string') throw new Error('Fabric metadata needs id and version');
    if (raw.provides !== undefined && (!Array.isArray(raw.provides) || !raw.provides.every((id) => typeof id === 'string'))) {
      throw new Error('Invalid Fabric provides');
    }
    const ranges = (key: string): Record<string, Predicate> => {
      const value = raw[key] ?? {};
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid Fabric ${key}`);
      for (const predicate of Object.values(value)) {
        if (typeof predicate !== 'string' && !(Array.isArray(predicate) && predicate.every((p) => typeof p === 'string'))) {
          throw new Error(`Invalid Fabric ${key} predicate`);
        }
        matchesFabric('0', predicate as Predicate);
      }
      return value as Record<string, Predicate>;
    };
    const nested: JarMeta[] = [];
    if (raw.jars !== undefined) {
      if (!Array.isArray(raw.jars)) throw new Error('Invalid Fabric jars');
      for (const jar of raw.jars as { file: string }[]) {
        if (typeof jar?.file !== 'string') throw new Error('Invalid Fabric nested jar path');
        const entry = zip.getEntry(jar.file);
        if (!entry) continue; // Missing declarations are ignored by Loader too.
        expanded += entry.header.size;
        if (expanded > 64 * 1024 * 1024) throw new Error('Fabric nested jar expansion exceeds 64 MiB');
        const child = read(entry.getData(), depth + 1);
        if (child) nested.push(child);
      }
    }
    if (raw.environment !== undefined && !['*', 'client', 'server'].includes(raw.environment as string)) {
      throw new Error('Invalid Fabric environment');
    }
    return {
      ids: [raw.id, ...((raw.provides ?? []) as string[])], version: raw.version,
      name: typeof raw.name === 'string' ? raw.name : raw.id,
      environment: (raw.environment ?? '*') as JarMeta['environment'],
      depends: ranges('depends'), breaks: ranges('breaks'),
      conflicts: ranges('conflicts'), recommends: ranges('recommends'), nested,
    };
  };
  return read(buffer, 0)!;
}
