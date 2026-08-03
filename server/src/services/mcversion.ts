// One place that knows how Minecraft versions compare. Anything that behaves
// differently across versions must ask HERE rather than hardcoding "the" syntax
// — the panel drives servers from 1.20.1 (Forge) to 26.2 (Fabric) at once, and
// every bug of the form "it works on my server but not that one" has started
// with a fact that was true in one era being stated as universal.

/** 1.20.5 is the great divide: Mojang replaced item NBT tags with item
 *  COMPONENTS. Before it, an enchanted pickaxe is
 *    diamond_pickaxe{Enchantments:[{id:"minecraft:efficiency",lvl:5}]}
 *  from it,
 *    diamond_pickaxe[enchantments={"minecraft:efficiency":5}]
 *  and each era REJECTS the other's syntax outright. Worn armour, mob equipment,
 *  attribute names and custom item names all moved around the same era too.
 *
 *  Version strings we must handle: "1.20.1", "1.21.11", "26.2" (Mojang dropped
 *  the leading 1. — so a bare major >= 20 that is not "1.x" is modern). */
export function isComponentEra(mc: string | null | undefined): boolean {
  if (!mc) return true; // unknown => assume modern (every new server we create is)
  const [maj, min = 0, pat = 0] = mc.split('.').map((n) => parseInt(n, 10) || 0);
  if (maj !== 1) return maj >= 20; // 21.x / 25.x / 26.x — the post-1.x numbering
  if (min !== 20) return min > 20; // 1.21+ modern, 1.19 and below legacy
  return pat >= 5; // 1.20.5 is the cutover
}

/** Coarse era label — used to tag remembered facts so a lesson learned on 26.2
 *  is never replayed to the genie as truth on a 1.20.1 server. */
export type Era = 'component' | 'nbt';
export const eraOf = (mc: string | null | undefined): Era => (isComponentEra(mc) ? 'component' : 'nbt');

/** Numeric compare so callers can ask real questions ("is this at least 1.20.3?")
 *  instead of string-matching. Returns <0, 0, >0 like a comparator.
 *  Treats the post-1.x scheme (25.x, 26.x) as newer than every 1.x release. */
export function compareMc(a: string, b: string): number {
  const parse = (v: string): number[] => {
    const p = v.split('.').map((n) => parseInt(n, 10) || 0);
    // 1.x sorts below the new scheme: give 1.x a leading 0 so 1.21 < 25.1
    return p[0] === 1 ? [0, ...p.slice(1)] : [p[0], ...p.slice(1)];
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Is `mc` at least `min`? (both in the 1.x or the new scheme) */
export const atLeast = (mc: string | null | undefined, min: string): boolean =>
  !mc ? true : compareMc(mc, min) >= 0;
