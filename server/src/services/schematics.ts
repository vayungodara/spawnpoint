import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, copyFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../config.js';
import { serverDir } from './servers.js';
import { parseNbt, writeNbt, TAG, comp, num, str, list, nInt, nString, nList, nCompound, type Tag, type Compound } from './nbt.js';

// Schematic library: .schem (Sponge) / .litematic (Litematica) files are
// converted ONCE at upload into vanilla structure-template NBT, tiled at 48³
// (the safe template size), and stored under data/schematics/<name>/. Placing
// copies the tiles into the world's generated/spawnpoint/structures/ folder
// and runs one `place template spawnpoint:<tile>` per tile — pure vanilla, no
// mods needed on the server.

const LIB_DIR = join(PATHS.data, 'schematics');
const TILE = 48;
const DATA_VERSION = 4903; // MC 26.2 world_version (versions/26.2/server-26.2.jar version.json)
const MAX_BLOCKS = 4_000_000; // refuse absurd imports before they eat the heap

interface PaletteEntry { name: string; props?: Record<string, string> }
interface Grid {
  w: number; h: number; l: number;
  palette: PaletteEntry[];
  /** palette index per cell, (y*l + z)*w + x; ABSENT = cell not covered (place nothing) */
  cells: Uint32Array;
  /** cell index → block-entity data to embed (chest contents etc.) */
  blockEntities: Map<number, Compound>;
  /** The MC DataVersion the SOURCE FILE was saved with (Sponge `DataVersion`,
   *  Litematica `MinecraftDataVersion`, structure `DataVersion`). We used to
   *  throw this away and stamp every template with 26.2's 4903, which defeats
   *  the server's DataFixer in BOTH directions:
   *    - a 26.2 build placed on 1.20.1: blocks that do not exist there
   *      (pale_oak_stairs, bush, short_grass) are read as AIR, SILENTLY — the
   *      house stamps with no stairs, no signs, no plants, and no error;
   *    - a 1.20.1 build placed on 26.2: the fixer sees 4903 >= 4903, runs
   *      nothing, and never renames `grass` -> `short_grass`, so every one of
   *      those blocks becomes air.
   *  0 = unknown (the file did not say). */
  dataVersion: number;
}
const ABSENT = 0xffffffff;

export interface TileInfo { file: string; offset: [number, number, number]; size: [number, number, number]; blocks: number }
/** A few known solid cells, used to VERIFY a placement landed (schematic
    corners are often air, so probing corners proves nothing). */
export interface SampleBlock { pos: [number, number, number]; block: string }
export interface SchematicMeta {
  name: string;
  source: string;
  format: 'schem' | 'litematic' | 'nbt';
  size: [number, number, number];
  blocks: number;
  tiles: TileInfo[];
  samples?: SampleBlock[];
  /** MC DataVersion of the SOURCE build (0 = the file didn't say). Compared
   *  against the target world's own DataVersion before placing: Minecraft's
   *  DataFixer can only migrate data FORWARD, so a build from a newer version
   *  cannot be placed on an older server — its unknown blocks become air. */
  dataVersion?: number;
  createdAt: string;
}

/** The DataVersion actually stamped into a stored tile — the fallback for
 *  library entries imported before we recorded the source version (their
 *  original .schem/.litematic is not kept, so the tile is all we have). */
function tileDataVersion(meta: SchematicMeta): number {
  try {
    const first = meta.tiles[0];
    if (!first) return 0;
    const { root } = parseNbt(readFileSync(join(LIB_DIR, meta.name, first.file)));
    const c = comp(root);
    return c['DataVersion'] ? num(c['DataVersion']) : 0;
  } catch {
    return 0;
  }
}

/** The DataVersion of a server's actual world, read from its level.dat. This is
 *  authoritative and needs no version table: the world itself records exactly
 *  which MC data format it is on. Returns 0 if it cannot be read. */
export function worldDataVersion(serverId: string): number {
  try {
    const p = join(serverDir(serverId), 'world', 'level.dat');
    if (!existsSync(p)) return 0;
    const { root } = parseNbt(readFileSync(p));
    const data = comp(comp(root)['Data']);
    return data['DataVersion'] ? num(data['DataVersion']) : 0;
  } catch {
    return 0;
  }
}

const cellIdx = (g: { w: number; l: number }, x: number, y: number, z: number) => (y * g.l + z) * g.w + x;

// ---------- .schem (Sponge v2 / v3) ----------

function readVarintArray(buf: Buffer, count: number): Uint32Array {
  const out = new Uint32Array(count);
  let pos = 0;
  for (let i = 0; i < count; i++) {
    let value = 0, shift = 0;
    for (;;) {
      const b = buf[pos++];
      if (b === undefined) throw new Error('schem: BlockData truncated');
      value |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 28) throw new Error('schem: varint too long');
    }
    out[i] = value >>> 0;
  }
  return out;
}

/** "minecraft:oak_stairs[facing=east,half=top]" → PaletteEntry */
function parseBlockStateString(s: string): PaletteEntry {
  const m = /^([^[]+)(?:\[(.*)\])?$/.exec(s.trim());
  if (!m) return { name: s };
  const entry: PaletteEntry = { name: m[1].includes(':') ? m[1] : `minecraft:${m[1]}` };
  if (m[2]) {
    entry.props = {};
    for (const kv of m[2].split(',')) {
      const [k, v] = kv.split('=');
      if (k && v !== undefined) entry.props[k.trim()] = v.trim();
    }
  }
  return entry;
}

function decodeSchem(root: Tag): Grid {
  let c = comp(root);
  // legacy MCEdit .schematic (pre-1.13): numeric block ids in Blocks/Data byte
  // arrays, no Palette. It used to die deep in the parser with a cryptic
  // "NBT: expected compound" — name the real problem and the way out instead.
  if (c['Blocks'] && c['Data'] && !c['Palette'] && !c['Schematic']) {
    throw new Error(
      'this is a legacy MCEdit .schematic (pre-1.13 numeric block ids) — open it in Amulet or WorldEdit and re-export as a modern .schem, then upload that',
    );
  }
  // v3 wraps everything in a "Schematic" child compound
  if (c['Schematic']) c = comp(c['Schematic']);
  const w = num(c['Width']), h = num(c['Height']), l = num(c['Length']);
  if (w * h * l > MAX_BLOCKS) throw new Error(`schematic is ${w}×${h}×${l} = ${w * h * l} blocks — too big (max ${MAX_BLOCKS})`);

  // v2 keeps Palette/BlockData at top level; v3 nests them under Blocks
  const blocksC = c['Blocks'] ? comp(c['Blocks']) : c;
  const paletteTag = blocksC['Palette'] ?? c['Palette'];
  if (!paletteTag) throw new Error('schem: no Palette — is this a pre-2019 v1 file? Re-export it as Sponge v2/v3');
  const paletteMap = comp(paletteTag);
  const dataTag = blocksC['Data'] ?? blocksC['BlockData'] ?? c['BlockData'];
  if (!dataTag) throw new Error('schem: no BlockData/Data');

  // Palette is state-string → index; invert it
  let maxIdx = 0;
  for (const t of Object.values(paletteMap)) maxIdx = Math.max(maxIdx, num(t));
  const palette: PaletteEntry[] = new Array(maxIdx + 1).fill(null).map(() => ({ name: 'minecraft:air' }));
  for (const [state, idxTag] of Object.entries(paletteMap)) palette[num(idxTag)] = parseBlockStateString(state);

  const raw = readVarintArray(dataTag.v as Buffer, w * h * l);
  // Sponge order is YZX: idx = (y*Length + z)*Width + x — same as our layout
  const cells = raw;

  const grid: Grid = { w, h, l, palette, cells, blockEntities: new Map(), dataVersion: c['DataVersion'] ? num(c['DataVersion']) : 0 };
  for (const beTag of list(blocksC['BlockEntities'] ?? c['BlockEntities'])) {
    const be = comp(beTag);
    const pos = be['Pos']?.v as Int32Array | undefined;
    if (!pos || pos.length !== 3) continue;
    const data: Compound = {};
    if (be['Data']) Object.assign(data, comp(be['Data'])); // v3
    for (const [k, v] of Object.entries(be)) if (!['Pos', 'Data'].includes(k)) data[k] = v; // v2 inline
    if (be['Id']) data['id'] = be['Id'];
    grid.blockEntities.set(cellIdx(grid, pos[0], pos[1], pos[2]), data);
  }
  return grid;
}

// ---------- .litematic ----------

function litematicBits(paletteLen: number): number {
  return Math.max(2, 32 - Math.clz32(Math.max(1, paletteLen - 1)));
}

/** Litematica packs entries continuously across 64-bit words (unlike modern chunks). */
function unpackBitArray(words: BigInt64Array, bits: number, count: number): Uint32Array {
  const out = new Uint32Array(count);
  const mask = (1n << BigInt(bits)) - 1n;
  for (let i = 0; i < count; i++) {
    const start = i * bits;
    const wordIdx = start >> 6;
    const offset = BigInt(start & 63);
    let value = (BigInt.asUintN(64, words[wordIdx]) >> offset) & mask;
    const spill = (start & 63) + bits - 64;
    if (spill > 0) {
      const low = BigInt.asUintN(64, words[wordIdx + 1]) & ((1n << BigInt(spill)) - 1n);
      value |= low << BigInt(bits - spill);
    }
    out[i] = Number(value & mask);
  }
  return out;
}

function decodeLitematic(root: Tag): Grid {
  const c = comp(root);
  const regions = c['Regions'] ? comp(c['Regions']) : null;
  if (!regions || Object.keys(regions).length === 0) throw new Error('litematic: no Regions');

  // overall box = union of regions (a region's Size may be negative: it grows
  // backwards from Position — normalize to origin+abs-size)
  interface R { origin: [number, number, number]; dims: [number, number, number]; region: Compound }
  const rs: R[] = [];
  for (const rTag of Object.values(regions)) {
    const region = comp(rTag);
    const p = comp(region['Position']), s = comp(region['Size']);
    const px = num(p['x']), py = num(p['y']), pz = num(p['z']);
    const sx = num(s['x']), sy = num(s['y']), sz = num(s['z']);
    rs.push({
      origin: [px + Math.min(sx + 1, 0), py + Math.min(sy + 1, 0), pz + Math.min(sz + 1, 0)],
      dims: [Math.abs(sx), Math.abs(sy), Math.abs(sz)],
      region,
    });
  }
  const min = [0, 1, 2].map((a) => Math.min(...rs.map((r) => r.origin[a]))) as [number, number, number];
  const max = [0, 1, 2].map((a) => Math.max(...rs.map((r) => r.origin[a] + r.dims[a]))) as [number, number, number];
  const w = max[0] - min[0], h = max[1] - min[1], l = max[2] - min[2];
  if (w * h * l > MAX_BLOCKS) throw new Error(`schematic is ${w}×${h}×${l} = ${w * h * l} blocks — too big (max ${MAX_BLOCKS})`);

  const palette: PaletteEntry[] = [{ name: 'minecraft:air' }];
  const paletteKey = new Map<string, number>([['minecraft:air|', 0]]);
  const cells = new Uint32Array(w * h * l).fill(ABSENT);
  const grid: Grid = {
    w, h, l, palette, cells, blockEntities: new Map(),
    dataVersion: c['MinecraftDataVersion'] ? num(c['MinecraftDataVersion']) : 0,
  };

  for (const { origin, dims, region } of rs) {
    const [rw, rh, rl] = dims;
    const localPalette: number[] = [];
    for (const pTag of list(region['BlockStatePalette'])) {
      const pc = comp(pTag);
      const name = str(pc['Name']);
      const props: Record<string, string> = {};
      if (pc['Properties']) for (const [k, v] of Object.entries(comp(pc['Properties']))) props[k] = String(v.v);
      const key = `${name}|${Object.entries(props).sort().map(([k, v]) => `${k}=${v}`).join(',')}`;
      let idx = paletteKey.get(key);
      if (idx === undefined) {
        idx = palette.length;
        palette.push(Object.keys(props).length ? { name, props } : { name });
        paletteKey.set(key, idx);
      }
      localPalette.push(idx);
    }
    const states = region['BlockStates'];
    if (!states || states.t !== TAG.LongArray) throw new Error('litematic: region has no BlockStates');
    const bits = litematicBits(Math.max(localPalette.length, 2));
    const raw = unpackBitArray(states.v as BigInt64Array, bits, rw * rh * rl);
    for (let y = 0; y < rh; y++) for (let z = 0; z < rl; z++) for (let x = 0; x < rw; x++) {
      const local = raw[(y * rl + z) * rw + x];
      const global = localPalette[local];
      if (global === undefined) continue;
      cells[cellIdx(grid, origin[0] - min[0] + x, origin[1] - min[1] + y, origin[2] - min[2] + z)] = global;
    }
    for (const beTag of list(region['TileEntities'])) {
      const be = comp(beTag);
      const bx = num(be['x'], -1), by = num(be['y'], -1), bz = num(be['z'], -1);
      if (bx < 0 || by < 0 || bz < 0) continue;
      const data: Compound = {};
      for (const [k, v] of Object.entries(be)) if (!['x', 'y', 'z'].includes(k)) data[k] = v;
      grid.blockEntities.set(cellIdx(grid, origin[0] - min[0] + bx, origin[1] - min[1] + by, origin[2] - min[2] + bz), data);
    }
  }
  return grid;
}

// ---------- vanilla structure .nbt (already a template — just re-tile) ----------

function decodeStructureNbt(root: Tag): Grid {
  const c = comp(root);
  const size = list(c['size']).map((t) => num(t));
  if (size.length !== 3) throw new Error('structure nbt: missing size');
  const [w, h, l] = size as [number, number, number];
  if (w * h * l > MAX_BLOCKS) throw new Error('structure too big');
  const palette: PaletteEntry[] = list(c['palette']).map((pTag) => {
    const pc = comp(pTag);
    const entry: PaletteEntry = { name: str(pc['Name']) };
    if (pc['Properties']) {
      entry.props = {};
      for (const [k, v] of Object.entries(comp(pc['Properties']))) entry.props[k] = String(v.v);
    }
    return entry;
  });
  const grid: Grid = {
    w, h, l, palette,
    cells: new Uint32Array(w * h * l).fill(ABSENT),
    blockEntities: new Map(),
    dataVersion: c['DataVersion'] ? num(c['DataVersion']) : 0,
  };
  for (const bTag of list(c['blocks'])) {
    const bc = comp(bTag);
    const pos = list(bc['pos']).map((t) => num(t));
    const i = cellIdx(grid, pos[0], pos[1], pos[2]);
    grid.cells[i] = num(bc['state']);
    if (bc['nbt']) grid.blockEntities.set(i, comp(bc['nbt']));
  }
  return grid;
}

// ---------- grid → tiled structure templates ----------

function tileToStructure(g: Grid, ox: number, oy: number, oz: number, tw: number, th: number, tl: number): { nbt: Buffer; blocks: number } {
  const paletteTags = g.palette.map((p) => {
    const entry: Compound = { Name: nString(p.name) };
    if (p.props && Object.keys(p.props).length) {
      const props: Compound = {};
      for (const [k, v] of Object.entries(p.props)) props[k] = nString(v);
      entry['Properties'] = nCompound(props);
    }
    return nCompound(entry);
  });
  const blocks: Tag[] = [];
  for (let y = 0; y < th; y++) for (let z = 0; z < tl; z++) for (let x = 0; x < tw; x++) {
    const i = cellIdx(g, ox + x, oy + y, oz + z);
    const state = g.cells[i];
    if (state === ABSENT) continue;
    const entry: Compound = {
      pos: nList(TAG.Int, [nInt(x), nInt(y), nInt(z)]),
      state: nInt(state),
    };
    const be = g.blockEntities.get(i);
    if (be) entry['nbt'] = nCompound(be);
    blocks.push(nCompound(entry));
  }
  const root = nCompound({
    size: nList(TAG.Int, [nInt(tw), nInt(th), nInt(tl)]),
    entities: nList(TAG.Compound, []),
    blocks: nList(TAG.Compound, blocks),
    palette: nList(TAG.Compound, paletteTags),
    // Stamp the version the BUILD WAS MADE IN, not ours. This is the whole point
    // of DataVersion: it tells the target server's DataFixer how far forward to
    // migrate the blocks. Lying about it (we used to hardcode 26.2's 4903) tells
    // the fixer "already current" and it does nothing — so a 1.20.1 build's
    // `grass` never becomes `short_grass` and lands as AIR instead.
    DataVersion: nInt(g.dataVersion || DATA_VERSION),
  });
  return { nbt: writeNbt(root), blocks: blocks.length };
}

// ---------- library management ----------

function sanitizeName(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '');
  // slice BEFORE trimming underscores: trimming first once left a stored name
  // ending in "_" (the slice re-exposed one), which this same function then
  // stripped at lookup time — the library couldn't find its own entry
  const clean = base.toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 40).replace(/^_+|_+$/g, '');
  return clean || 'schematic';
}

const metaFile = (name: string) => join(LIB_DIR, name, 'meta.json');

export function listSchematics(): SchematicMeta[] {
  if (!existsSync(LIB_DIR)) return [];
  const out: SchematicMeta[] = [];
  for (const dir of readdirSync(LIB_DIR)) {
    try {
      out.push(JSON.parse(readFileSync(metaFile(dir), 'utf8')) as SchematicMeta);
    } catch { /* half-imported or foreign dir */ }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getSchematic(name: string): SchematicMeta | null {
  if (!/^[a-z0-9_]{1,40}$/.test(name)) return null; // also blocks path tricks
  try {
    return JSON.parse(readFileSync(metaFile(name), 'utf8')) as SchematicMeta;
  } catch {
    return null;
  }
}

export function deleteSchematic(name: string): void {
  const clean = sanitizeName(name);
  if (!clean) return;
  rmSync(join(LIB_DIR, clean), { recursive: true, force: true });
}

/** Convert an uploaded schematic and store it in the library. */
export function importSchematic(filename: string, data: Buffer): SchematicMeta {
  const ext = (filename.split('.').pop() ?? '').toLowerCase();
  const { root } = parseNbt(data);

  let grid: Grid;
  let format: SchematicMeta['format'];
  if (ext === 'litematic') { grid = decodeLitematic(root); format = 'litematic'; }
  else if (ext === 'schem' || ext === 'schematic') { grid = decodeSchem(root); format = 'schem'; }
  else if (ext === 'nbt') { grid = decodeStructureNbt(root); format = 'nbt'; }
  else throw new Error(`unsupported extension .${ext} — upload .schem, .litematic or .nbt`);

  const name = sanitizeName(filename);
  const dir = join(LIB_DIR, name);
  rmSync(dir, { recursive: true, force: true }); // re-upload replaces
  mkdirSync(dir, { recursive: true });

  const tiles: TileInfo[] = [];
  let totalBlocks = 0;
  for (let oy = 0; oy < grid.h; oy += TILE) for (let oz = 0; oz < grid.l; oz += TILE) for (let ox = 0; ox < grid.w; ox += TILE) {
    const tw = Math.min(TILE, grid.w - ox), th = Math.min(TILE, grid.h - oy), tl = Math.min(TILE, grid.l - oz);
    const { nbt, blocks } = tileToStructure(grid, ox, oy, oz, tw, th, tl);
    if (blocks === 0) continue; // fully-absent tile: nothing to place
    const single = grid.w <= TILE && grid.h <= TILE && grid.l <= TILE;
    const file = single ? `${name}.nbt` : `${name}_${ox}_${oy}_${oz}.nbt`;
    writeFileSync(join(dir, file), nbt);
    tiles.push({ file, offset: [ox, oy, oz], size: [tw, th, tl], blocks });
    totalBlocks += blocks;
  }
  if (tiles.length === 0) throw new Error('schematic decoded to zero blocks — file may be empty or corrupt');

  // pick ~6 spread-out solid cells as placement-verification probes
  const samples: SampleBlock[] = [];
  const solid: number[] = [];
  for (let i = 0; i < grid.cells.length; i++) {
    const s = grid.cells[i];
    if (s !== ABSENT && grid.palette[s] && grid.palette[s].name !== 'minecraft:air') solid.push(i);
  }
  const step = Math.max(1, Math.floor(solid.length / 6));
  for (let k = 0; k < solid.length && samples.length < 6; k += step) {
    const i = solid[k];
    const y = Math.floor(i / (grid.l * grid.w));
    const z = Math.floor((i - y * grid.l * grid.w) / grid.w);
    const x = i - (y * grid.l + z) * grid.w;
    samples.push({ pos: [x, y, z], block: grid.palette[grid.cells[i]].name });
  }

  const meta: SchematicMeta = {
    name,
    source: filename,
    format,
    size: [grid.w, grid.h, grid.l],
    blocks: totalBlocks,
    tiles,
    samples,
    dataVersion: grid.dataVersion,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(metaFile(name), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

/** Stage a schematic's tiles into the server's world and return the place commands.
    Anchor (x,y,z) is the min corner of the whole build. */
/** newer-block -> older-equivalent map for downgrading. Exact ids first, then
    pattern rules. Unmapped unknown blocks stay as-is and become air on the
    target — the sample verification reports that instead of hiding it. */
const DOWNGRADE_RENAMES: Record<string, string> = {
  'minecraft:short_grass': 'minecraft:grass', // renamed in 1.20.3
  'minecraft:resin_block': 'minecraft:red_terracotta',
  'minecraft:resin_bricks': 'minecraft:red_nether_bricks',
};
function downgradeBlockId(id: string, targetDv: number): string {
  if (DOWNGRADE_RENAMES[id] && !(id === 'minecraft:short_grass' && targetDv >= 3698)) return DOWNGRADE_RENAMES[id];
  if (/^minecraft:[a-z_]*_shelf$/.test(id)) return 'minecraft:bookshelf'; // shelves are 26.x
  if (id.startsWith('minecraft:pale_oak_')) return id.replace('pale_oak_', 'oak_'); // pale oak is 1.21.4+
  return id;
}

/** Convert a too-new schematic's tiles for an older server: re-stamp the
    DataVersion, map renamed blocks, write `<tile>_dg<dv>.nbt` siblings, and
    return a meta clone pointing at them (samples mapped too, so the panel's
    post-place verification checks the CONVERTED blocks). Deterministic output,
    so the staging content-compare works unchanged. */
/** Recursively convert modern item stacks ({id, count:int, components}) to the
    legacy pre-1.20.5 shape ({id, Count:byte, tag-less}) anywhere in a tile's
    NBT — container Items lists, jukebox RecordItem, lectern Book, etc. */
function downgradeItemStacks(tag: Tag): void {
  if (tag.t === TAG.Compound) {
    const v = tag.v as Record<string, Tag>;
    const id = v.id;
    const count = v.count;
    // an item stack = compound with a string id and a numeric count
    if (id && id.t === TAG.String && count && (count.t === TAG.Int || count.t === TAG.Byte) && !v.Count) {
      v.Count = { t: TAG.Byte, v: Math.max(1, Math.min(127, Number(count.v))) } as Tag;
      delete v.count;
      if (v.components) delete v.components; // no pre-1.20.5 equivalent — item survives bare
    }
    for (const child of Object.values(v)) downgradeItemStacks(child);
  } else if (tag.t === TAG.List) {
    for (const child of (tag as { v: Tag[] }).v) downgradeItemStacks(child);
  }
}

function downgradeSchematic(meta: SchematicMeta, targetDv: number): SchematicMeta {
  const tiles = meta.tiles.map((tile) => {
    const srcPath = join(LIB_DIR, meta.name, tile.file);
    const outFile = tile.file.replace(/\.nbt$/, `_dg${targetDv}.nbt`);
    const outPath = join(LIB_DIR, meta.name, outFile);
    const fresh = existsSync(outPath) && statSync(outPath).mtimeMs >= statSync(srcPath).mtimeMs;
    if (!fresh) {
      const { root } = parseNbt(readFileSync(srcPath));
      const rv = root.v as Record<string, { t: number; v: unknown }>;
      if (rv.DataVersion) rv.DataVersion.v = targetDv;
      const mapPalette = (pal: { v: { v: Record<string, { v: unknown }> }[] }): void => {
        for (const entry of pal.v) {
          const nameTag = entry.v.Name as { v: string } | undefined;
          if (nameTag) nameTag.v = downgradeBlockId(nameTag.v, targetDv);
        }
      };
      if (rv.palette) mapPalette(rv.palette as never);
      if (rv.palettes) for (const pal of (rv.palettes as { v: never[] }).v) mapPalette(pal);
      // BLOCK-ENTITY ITEMS use the modern stack shape from 1.20.5 on
      // ({id, count:int, components}) — a pre-1.20.5 server reading that
      // silently drops the item, so every downgraded dispenser/chest arrived
      // EMPTY (live 2026-07-20: the mega farm's 352 water dispensers). Convert
      // to the legacy shape: count(int)→Count(byte), components dropped
      // (enchants on container loot are lost; the item itself survives).
      if (targetDv < 3837) downgradeItemStacks(root);
      writeFileSync(outPath, writeNbt(root));
    }
    return { ...tile, file: outFile };
  });
  const samples = (meta.samples ?? []).map((sm) => ({
    ...sm,
    block: sm.block.replace(/^[a-z_:]+/, (id) => downgradeBlockId(id, targetDv)),
  }));
  return { ...meta, tiles, samples, dataVersion: targetDv };
}


// ---- redstone auto-update pass ----
// `place template` writes blocks without update propagation, so circuits can
// arrive frozen (owner report 2026-07-19: farm redstone dead on arrival) and
// wires crossing TILE SEAMS never learn about the neighboring tile at all.
// The cure is to re-fire updates over every component: clone-in-place with
// `force` re-places each block "as if by setblock", which re-evaluates state.
// Verified live 2026-07-20 on 1.20.1: harmless on a healthy circuit (torch/
// wire/lamp states unchanged, block entities preserved), and any component
// that needed an update gets one. Only redstone-BEARING volumes are cloned —
// a decorative build adds zero commands.
const REDSTONE_COMPONENT =
  /redstone|repeater|comparator|observer|piston|dispenser|dropper|note_block|lever|_button|pressure_plate|tripwire|powered_rail|activator_rail|detector_rail|daylight_detector|target|sculk_sensor|hopper|sticky/;
const CLONE_LIMIT = 32_768; // vanilla clone block cap

const rsBoundsCache = new Map<string, { box: number[] | null }>(); // tile path|mtime -> bounds
function redstoneBoundsOfTile(dir: string, file: string): number[] | null {
  const p = join(dir, file);
  let st;
  try {
    st = statSync(p);
  } catch {
    return null;
  }
  const key = `${p}|${st.mtimeMs}`;
  const hit = rsBoundsCache.get(key);
  if (hit) return hit.box;
  let box: number[] | null = null;
  try {
    const { root } = parseNbt(readFileSync(p));
    const v = root.v as Record<string, Tag>;
    const palette = (v.palette as { v: Tag[] }).v.map((e) => String(((e.v as Record<string, Tag>).Name as Tag).v));
    const rs = new Set(palette.map((n, i) => (REDSTONE_COMPONENT.test(n) ? i : -1)).filter((i) => i >= 0));
    if (rs.size) {
      let [x1, y1, z1, x2, y2, z2] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (const b of (v.blocks as { v: Tag[] }).v) {
        const bv = b.v as Record<string, Tag>;
        if (!rs.has(Number((bv.state as Tag).v))) continue;
        const [px, py, pz] = (bv.pos as { v: Tag[] }).v.map((t) => Number(t.v));
        x1 = Math.min(x1, px); y1 = Math.min(y1, py); z1 = Math.min(z1, pz);
        x2 = Math.max(x2, px); y2 = Math.max(y2, py); z2 = Math.max(z2, pz);
      }
      // pad by 1 (clamped to the tile) so seam-adjacent neighbors re-evaluate too
      if (x1 !== Infinity) box = [Math.max(0, x1 - 1), Math.max(0, y1 - 1), Math.max(0, z1 - 1), x2 + 1, y2 + 1, z2 + 1];
    }
  } catch { /* unreadable tile — no pass for it */ }
  rsBoundsCache.set(key, { box });
  return box;
}

/** Split a box into clone-sized chunks and emit clone-in-place commands. */
function cloneInPlace(out: string[], x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): void {
  const vol = (x2 - x1 + 1) * (y2 - y1 + 1) * (z2 - z1 + 1);
  if (vol <= CLONE_LIMIT) {
    out.push(`clone ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${x1} ${y1} ${z1} replace force`);
    return;
  }
  // split along the longest axis
  const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
  if (dx >= dy && dx >= dz) {
    const mid = x1 + Math.floor(dx / 2);
    cloneInPlace(out, x1, y1, z1, mid, y2, z2);
    cloneInPlace(out, mid + 1, y1, z1, x2, y2, z2);
  } else if (dy >= dz) {
    const mid = y1 + Math.floor(dy / 2);
    cloneInPlace(out, x1, y1, z1, x2, mid, z2);
    cloneInPlace(out, x1, mid + 1, z1, x2, y2, z2);
  } else {
    const mid = z1 + Math.floor(dz / 2);
    cloneInPlace(out, x1, y1, z1, x2, y2, mid);
    cloneInPlace(out, x1, y1, mid + 1, x2, y2, z2);
  }
}

export function stagePlacement(serverId: string, name: string, x: number, y: number, z: number): { commands: string[]; meta: SchematicMeta; needsReload: boolean } {
  // resolve forgivingly: exact, sanitized, then unique prefix/substring match —
  // the model copies names from the library list, so near-misses must not fail
  let meta =
    getSchematic(name) ??
    getSchematic(sanitizeName(name)) ??
    (() => {
      const want = sanitizeName(name);
      const hits = listSchematics().filter((s) => s.name.includes(want) || want.includes(s.name));
      return hits.length === 1 ? hits[0] : null;
    })();
  if (!meta) throw new Error(`no schematic named "${name}" in the library`);
  const world = join(serverDir(serverId), 'world');
  if (!existsSync(world)) throw new Error('the world does not exist yet — start the server once first');

  // A build from a NEWER Minecraft than this server cannot be placed. The
  // DataFixer only migrates data forward — it has no downgrade path — so every
  // block that does not exist on this server is read as AIR, silently, with no
  // error at all. The 26.2 mansion on the 1.20.1 server would stamp with no
  // stairs, no trapdoors, no signs and no plants, and the genie would report
  // success. Refuse loudly instead of shipping a hollow house.
  const worldDv = worldDataVersion(serverId);
  // Entries imported BEFORE we recorded the source version have no meta.dataVersion.
  // Their tiles carry our old hardcoded 4903 stamp, which is what the server will
  // actually read — so use that. It is an upper bound, and it still correctly
  // refuses a 26.2 build on the 1.20.1 server.
  const schemDv = meta.dataVersion || tileDataVersion(meta);
  if (schemDv && worldDv && schemDv > worldDv) {
    // AUTO-DOWNGRADE (2026-07-19): instead of refusing, convert — re-stamp the
    // DataVersion and map renamed/new block ids to this era's equivalents.
    // Safety comes from the machinery that already exists: the post-place
    // sample probes catch a hollow result honestly, and the undo snapshot
    // restores the terrain. Proven by hand first on the abfielder starter
    // house (26.x -> 1.20.1, oak_shelf -> bookshelf): placed perfectly.
    meta = downgradeSchematic(meta, worldDv);
  }


  // The datapack folder was RENAMED from plural to singular in MC 1.21:
  //   <= 1.20.6 : generated/<ns>/structures/   (plural)
  //   >= 1.21   : generated/<ns>/structure/    (singular)
  // We only wrote the singular one, so on the Forge 1.20.1 server EVERY place
  // template failed with "There is no template with ID" — the schematic library
  // was 100% dead there and no amount of `reload` could help.
  // Writing BOTH is the honest fix: the folder the server does not use is inert,
  // costs a few hundred KB, and means we never have to be right about the
  // boundary for a version that does not exist yet.
  const destDirs = [
    join(world, 'generated', 'spawnpoint', 'structure'),
    join(world, 'generated', 'spawnpoint', 'structures'),
  ];
  for (const d of destDirs) mkdirSync(d, { recursive: true });

  const commands: string[] = [];
  let staged = false;
  for (const tile of meta.tiles) {
    const src = join(LIB_DIR, meta.name, tile.file);
    for (const destDir of destDirs) {
      const dest = join(destDir, tile.file);
      // same SIZE is not the same FILE — a re-uploaded build can compress to an
      // identical length and would have left the old template staged. Compare
      // content: these are ≤ a few hundred KB, the read is free next to `place`.
      const same = existsSync(dest) && readFileSync(dest).equals(readFileSync(src));
      if (!same) {
        copyFileSync(src, dest);
        staged = true;
      }
    }
    const id = `spawnpoint:${tile.file.replace(/\.nbt$/, '')}`;
    commands.push(`place template ${id} ${x + tile.offset[0]} ${y + tile.offset[1]} ${z + tile.offset[2]}`);
  }
  // redstone auto-update pass — appended to the SAME command batch so the
  // clones run right after the last tile lands (seam wires need both sides
  // present before re-evaluating)
  for (const tile of meta.tiles) {
    const box = redstoneBoundsOfTile(join(LIB_DIR, meta.name), tile.file);
    if (!box) continue;
    const cl = (yv: number) => Math.max(-64, Math.min(319, yv));
    cloneInPlace(
      commands,
      x + tile.offset[0] + box[0], cl(y + tile.offset[1] + box[1]), z + tile.offset[2] + box[2],
      x + tile.offset[0] + box[3], cl(y + tile.offset[1] + box[4]), z + tile.offset[2] + box[5],
    );
  }

  // the server CACHES template lookups — including misses. Any newly staged
  // file (first placement of this build, or a re-upload) needs one `reload`
  // or the very first `place template` says "no template with ID" (verified
  // live: place failed → reload → same command loaded the template fine)
  return { commands, meta, needsReload: staged };
}
