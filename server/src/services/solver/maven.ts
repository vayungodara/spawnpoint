/*
 * Maven comparison and range semantics adapted from Apache Maven Artifact
 * ComparableVersion and VersionRange (3.8.5 / 3.8.8), licensed under Apache-2.0.
 * https://github.com/apache/maven/tree/maven-3.8.8/maven-artifact
 * License: docs/licenses/maven-artifact.txt
 * Numbers use BigInt instead of separate Java int/long/BigInteger items.
 */

type Item = bigint | string | Item[];
export type MavenVersion = '3.8.5' | '3.8.8';
const QUALIFIERS = ['alpha', 'beta', 'milestone', 'rc', 'snapshot', '', 'sp'];
const ALIASES = new Map([['ga', ''], ['final', ''], ['release', ''], ['cr', 'rc']]);
const order = (a: string | bigint, b: string | bigint): number => a < b ? -1 : a > b ? 1 : 0;
const qualifier = (value: string): string => {
  const index = QUALIFIERS.indexOf(value);
  return index < 0 ? `7-${value}` : String(index);
};
const stringItem = (value: string, followedByDigit = false): string => {
  if (followedByDigit && value.length === 1) value = ({ a: 'alpha', b: 'beta', m: 'milestone' } as Record<string, string>)[value] ?? value;
  return ALIASES.get(value) ?? value;
};

function compare(a: Item | undefined, b: Item | undefined): number {
  if (a === undefined) return b === undefined ? 0 : -compare(b, undefined);
  if (typeof a === 'bigint') return b === undefined ? order(a, 0n) : typeof b === 'bigint' ? order(a, b) : 1;
  if (typeof a === 'string') {
    return b === undefined ? order(qualifier(a), '5') : typeof b === 'string' ? order(qualifier(a), qualifier(b)) : -1;
  }
  if (b !== undefined && !Array.isArray(b)) return typeof b === 'string' ? 1 : -1;
  for (let i = 0; i < Math.max(a.length, b?.length ?? 0); i++) {
    const result = compare(a[i], b?.[i]);
    if (result) return result;
  }
  return 0;
}

function parseVersion(raw: string, maven: MavenVersion): Item[] {
  if (raw.length > 512 || /[^\x20-\x7e]/.test(raw)) throw new Error('Unsupported Maven version');
  const version = raw.toLowerCase();
  const root: Item[] = [];
  let list = root, start = 0, digit = false;
  const stack = [list];
  const nest = (): void => { const child: Item[] = []; list.push(child); list = child; stack.push(child); };
  const item = (end: number): Item => {
    const token = version.slice(start, end);
    // Maven preserves the numeric type for all-zero long/BigInteger tokens,
    // so those spellings cannot safely collapse to our single BigInt type.
    if (digit && /^0{10,}$/.test(token)) throw new Error('Unsupported Maven all-zero numeric type');
    return digit ? BigInt(token) : stringItem(token);
  };
  for (let i = 0; i < version.length; i++) {
    const char = version[i];
    if (char === '.' || char === '-') {
      list.push(i === start ? 0n : item(i));
      start = i + 1;
      if (char === '-') nest();
    } else if (/\d/.test(char)) {
      if (!digit && i > start) {
        if (maven === '3.8.8' && list.length) nest();
        list.push(stringItem(version.slice(start, i), true));
        start = i;
        nest();
      }
      digit = true;
    } else {
      if (digit && i > start) { list.push(item(i)); start = i; nest(); }
      digit = false;
    }
  }
  if (start < version.length) {
    if (maven === '3.8.8' && !digit && list.length) nest();
    list.push(item(version.length));
  }
  for (const values of stack.reverse()) {
    for (let i = values.length - 1; i >= 0; i--) {
      const value = values[i];
      const zero = Array.isArray(value) ? value.length === 0 : typeof value === 'bigint' ? value === 0n : qualifier(value) === '5';
      if (zero) values.splice(i, 1);
      else if (!Array.isArray(value)) break;
    }
  }
  return root;
}

/** Maven ordering, including qualifier aliases, numeric transitions and lists. */
export function compareMavenVersions(a: string, b: string, maven: MavenVersion = '3.8.8'): number {
  return compare(parseVersion(a, maven), parseVersion(b, maven));
}

interface Restriction { lower?: string; upper?: string; lowerInclusive: boolean; upperInclusive: boolean }
export interface MavenRange { recommended?: string; restrictions: Restriction[] }

/** Maven's raw range grammar. A bare version is recommended, not an exact pin.
 * Loader-specific defaults for an absent range belong in the jar reader. */
export function parseMavenRange(spec: string, maven: MavenVersion = '3.8.8'): MavenRange {
  if (spec.length > 4096) throw new Error('Maven version range exceeds 4096 characters');
  const restrictions: Restriction[] = [];
  let rest = spec;
  while (rest.startsWith('[') || rest.startsWith('(')) {
    const close = rest.search(/[\])]/);
    if (close < 0) throw new Error(`Unbounded Maven range: ${spec}`);
    const range = rest.slice(0, close + 1);
    const lowerInclusive = range[0] === '[', upperInclusive = range.at(-1) === ']';
    const body = range.slice(1, -1).trim();
    const comma = body.indexOf(',');
    let lower: string | undefined, upper: string | undefined;
    if (comma < 0) {
      if (!lowerInclusive || !upperInclusive) throw new Error(`Single Maven version requires []: ${spec}`);
      lower = upper = body;
    } else {
      lower = body.slice(0, comma).trim(); upper = body.slice(comma + 1).trim();
      if (maven === '3.8.5' && lower === upper) throw new Error(`Identical Maven range bounds: ${spec}`);
      lower ||= undefined; upper ||= undefined;
      if (lower !== undefined && upper !== undefined) {
        const compared = compareMavenVersions(lower, upper, maven);
        if (compared > 0 || (maven === '3.8.8' && compared === 0 && (!lowerInclusive || !upperInclusive))) throw new Error(`Reversed Maven range: ${spec}`);
      }
    }
    if (lower !== undefined) parseVersion(lower, maven);
    if (upper !== undefined) parseVersion(upper, maven);
    const previous = restrictions.at(-1)?.upper;
    if (previous !== undefined && (lower === undefined || compareMavenVersions(lower, previous, maven) < 0)) throw new Error(`Overlapping Maven ranges: ${spec}`);
    restrictions.push({ lower, upper, lowerInclusive, upperInclusive });
    rest = rest.slice(close + 1).trim();
    if (rest.startsWith(',')) rest = rest.slice(1).trim();
  }
  if (rest) {
    if (restrictions.length) throw new Error(`Mixed Maven range and version: ${spec}`);
    parseVersion(rest, maven);
    return { recommended: rest, restrictions: [{ lowerInclusive: false, upperInclusive: false }] };
  }
  return { restrictions };
}

export function matchesMaven(version: string, spec: string, maven: MavenVersion = '3.8.8'): boolean {
  return containsMaven(version, parseMavenRange(spec, maven), maven);
}

export function containsMaven(version: string, range: MavenRange, maven: MavenVersion = '3.8.8'): boolean {
  const value = parseVersion(version, maven);
  return range.restrictions.some((range) => {
    const lower = range.lower === undefined ? undefined : compare(value, parseVersion(range.lower, maven));
    const upper = range.upper === undefined ? undefined : compare(value, parseVersion(range.upper, maven));
    return (lower === undefined || lower > 0 || (lower === 0 && range.lowerInclusive))
      && (upper === undefined || upper < 0 || (upper === 0 && range.upperInclusive));
  });
}

/** Intersection retains Maven's recommendation, including empty intersections.
 * JarJar rejects recommended aggregates even when membership would match. */
export function restrictMaven(a: MavenRange, b: MavenRange, maven: MavenVersion = '3.8.8'): MavenRange {
  const restrictions: Restriction[] = [];
  let i = 0, j = 0;
  // Native two-cursor traversal is significant even for accepted unsorted
  // unions; a mathematical Cartesian intersection gives different answers.
  while (i < a.restrictions.length && j < b.restrictions.length) {
    const left = a.restrictions[i], right = b.restrictions[j];
    if (left.lower !== undefined && right.upper !== undefined && compareMavenVersions(left.lower, right.upper, maven) > 0) { j++; continue; }
    if (left.upper !== undefined && right.lower !== undefined && compareMavenVersions(left.upper, right.lower, maven) < 0) { i++; continue; }
    const lowerOrder = left.lower === undefined ? -1 : right.lower === undefined ? 1 : compareMavenVersions(left.lower, right.lower, maven);
    const upperOrder = left.upper === undefined ? 1 : right.upper === undefined ? -1 : compareMavenVersions(left.upper, right.upper, maven);
    const lower = lowerOrder >= 0 ? left.lower : right.lower;
    const upper = upperOrder <= 0 ? left.upper : right.upper;
    const lowerInclusive = lowerOrder === 0 ? left.lowerInclusive && right.lowerInclusive : (lowerOrder > 0 ? left : right).lowerInclusive;
    const upperInclusive = upperOrder === 0 ? left.upperInclusive && right.upperInclusive : (upperOrder < 0 ? left : right).upperInclusive;
    const order = lower === undefined || upper === undefined ? -1 : compareMavenVersions(lower, upper, maven);
    if (order < 0 || (order === 0 && lowerInclusive && upperInclusive)) restrictions.push({ lower, upper, lowerInclusive, upperInclusive });
    if (left.upper === undefined || (right.upper !== undefined && upperOrder > 0) || left === right) j++;
    else i++;
  }
  const range: MavenRange = { restrictions };
  range.recommended = [a.recommended, b.recommended].find((version) => version !== undefined
    && (!restrictions.length || containsMaven(version, range, maven)));
  return range;
}

/** Java metadata equality compares ArtifactVersions, not their spellings. */
export function equalMavenRanges(a: MavenRange, b: MavenRange, maven: MavenVersion = '3.8.8'): boolean {
  const equal = (x?: string, y?: string): boolean => x === undefined || y === undefined ? x === y : compareMavenVersions(x, y, maven) === 0;
  return equal(a.recommended, b.recommended) && a.restrictions.length === b.restrictions.length
    && a.restrictions.every((left, i) => {
      const right = b.restrictions[i];
      return equal(left.lower, right.lower) && equal(left.upper, right.upper)
        && left.lowerInclusive === right.lowerInclusive && left.upperInclusive === right.upperInclusive;
    });
}
