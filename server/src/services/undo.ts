import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../config.js';
import { rconBatch } from '../clients/rcon.js';

// Undo for genie builds. Before a wish modifies blocks, the affected region is
// cloned into a "shadow buffer" — a strip of forever-unused chunks a million
// blocks out. "server undo" clones it back. Pure vanilla commands, no mods:
// the world itself is the backup medium.
//
// Scope (v1, deliberately): plain absolute-coordinate fill/setblock/clone and
// blueprint replays, overworld only. Commands wrapped in "execute in <dim>"
// are not snapshotted — cross-dimension clone is impossible in vanilla.

const UNDO_DIR = join(PATHS.data, 'undo');
const SLOTS = 8; // how many snapshots we keep per server, rotating
const BUF_X = 1_000_000; // shadow buffer origin — nobody will ever walk here
const BUF_Z = 1_000_000;
const SLOT_PITCH = 512; // one slot every 512 blocks along X
const MAX_VOLUME = 200_000; // bigger changes than this are not snapshotted
const MAX_FOOTPRINT = 32_768; // clone's per-command ceiling (dx*dz of one slab)
const WORLD_MIN_Y = -64;
const WORLD_MAX_Y = 319;

export interface Box { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number }
interface Snapshot { slot: number; box: Box; label: string; at: string }

const metaFile = (id: string) => join(UNDO_DIR, `${id}.json`);

function loadMeta(id: string): { counter: number; snaps: Snapshot[] } {
  try {
    return JSON.parse(readFileSync(metaFile(id), 'utf8'));
  } catch {
    return { counter: 0, snaps: [] };
  }
}

function saveMeta(id: string, meta: { counter: number; snaps: Snapshot[] }): void {
  mkdirSync(UNDO_DIR, { recursive: true });
  writeFileSync(metaFile(id), JSON.stringify(meta, null, 2), 'utf8');
}

const norm = (b: Box): Box => ({
  x1: Math.min(b.x1, b.x2),
  y1: Math.max(WORLD_MIN_Y, Math.min(b.y1, b.y2)),
  z1: Math.min(b.z1, b.z2),
  x2: Math.max(b.x1, b.x2),
  y2: Math.min(WORLD_MAX_Y, Math.max(b.y1, b.y2)),
  z2: Math.max(b.z1, b.z2),
});

const volume = (b: Box) => (b.x2 - b.x1 + 1) * (b.y2 - b.y1 + 1) * (b.z2 - b.z1 + 1);

/** Pull the union bounding box of every block-changing command in the batch.
    Only plain absolute coordinates count — that is what the genie is told to
    use, and what blueprints render to via execute positioned. */
export function boxFromCommands(cmds: string[]): Box | null {
  let box: Box | null = null;
  const grow = (x1: number, y1: number, z1: number, x2 = x1, y2 = y1, z2 = z1) => {
    const b = norm({ x1, y1, z1, x2, y2, z2 });
    box = box
      ? norm({
          x1: Math.min(box.x1, b.x1),
          y1: Math.min(box.y1, b.y1),
          z1: Math.min(box.z1, b.z1),
          x2: Math.max(box.x2, b.x2),
          y2: Math.max(box.y2, b.y2),
          z2: Math.max(box.z2, b.z2),
        })
      : b;
  };
  const I = '(-?\\d+)';
  for (const c of cmds) {
    let m = new RegExp(`^\\s*fill\\s+${I}\\s+${I}\\s+${I}\\s+${I}\\s+${I}\\s+${I}\\b`).exec(c);
    if (m) { grow(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]); continue; }
    m = new RegExp(`^\\s*setblock\\s+${I}\\s+${I}\\s+${I}\\b`).exec(c);
    if (m) { grow(+m[1], +m[2], +m[3]); continue; }
    m = new RegExp(`^\\s*clone\\s+${I}\\s+${I}\\s+${I}\\s+${I}\\s+${I}\\s+${I}\\s+${I}\\s+${I}\\s+${I}\\b`).exec(c);
    if (m) {
      const dx = Math.abs(+m[4] - +m[1]);
      const dy = Math.abs(+m[5] - +m[2]);
      const dz = Math.abs(+m[6] - +m[3]);
      grow(+m[7], +m[8], +m[9], +m[7] + dx, +m[8] + dy, +m[9] + dz);
    }
  }
  return box;
}

/** The box a rendered blueprint will occupy at a base point. */
export function boxFromBlueprint(commands: string[], bx: number, by: number, bz: number): Box | null {
  const rel = boxFromCommands(
    commands.map((c) => c.replace(/~(-?\d+)?/g, (_, n) => String(n ? +n : 0))),
  );
  if (!rel) return null;
  return norm({ x1: bx + rel.x1, y1: by + rel.y1, z1: bz + rel.z1, x2: bx + rel.x2, y2: by + rel.y2, z2: bz + rel.z2 });
}

/** Split a region into Y slabs small enough for clone's 32768-block limit. */
function slabs(box: Box): Box[] {
  const dx = box.x2 - box.x1 + 1;
  const dz = box.z2 - box.z1 + 1;
  if (dx * dz > MAX_FOOTPRINT) return []; // footprint alone too big — caller skips
  const rows = Math.max(1, Math.floor(MAX_FOOTPRINT / (dx * dz)));
  const out: Box[] = [];
  for (let y = box.y1; y <= box.y2; y += rows) {
    out.push({ ...box, y1: y, y2: Math.min(box.y2, y + rows - 1) });
  }
  return out;
}

const bufOrigin = (slot: number) => ({ x: BUF_X + slot * SLOT_PITCH, z: BUF_Z });

/** Snapshot a region before the genie touches it. Returns a human line for
    the trail, or null when the region was not snapshottable. */
export async function takeSnapshot(id: string, rawBox: Box, label: string): Promise<string | null> {
  // SERIALIZED per server: wishes run 3-parallel, and two concurrent snapshots
  // used to pick the SAME slot (both read counter=0), clone over each other in
  // the shadow buffer, and then race to save meta — one wish's undo record
  // vanished and the other's restored the wrong blocks.
  const prev = snapQueue.get(id) ?? Promise.resolve();
  const mine = prev.catch(() => {}).then(() => doSnapshot(id, rawBox, label));
  snapQueue.set(id, mine.then(() => {}, () => {}));
  return mine;
}
const snapQueue = new Map<string, Promise<void>>();

async function doSnapshot(id: string, rawBox: Box, label: string): Promise<string | null> {
  const box = norm(rawBox);
  if (volume(box) > MAX_VOLUME) return null;
  // the buffer gives each slot SLOT_PITCH blocks along X and Z; a wider box
  // would spill into the NEXT slot and corrupt an older snapshot
  if (box.x2 - box.x1 + 1 > SLOT_PITCH || box.z2 - box.z1 + 1 > SLOT_PITCH) return null;
  const parts = slabs(box);
  if (parts.length === 0) return null;

  const meta = loadMeta(id);
  const slot = meta.counter % SLOTS;
  const o = bufOrigin(slot);

  const cmds: string[] = [
    `forceload add ${o.x} ${BUF_Z} ${o.x + (box.x2 - box.x1)} ${BUF_Z + (box.z2 - box.z1)}`,
  ];
  for (const s of parts) {
    const by = s.y1; // buffer keeps the same Y layering
    cmds.push(
      `clone ${s.x1} ${s.y1} ${s.z1} ${s.x2} ${s.y2} ${s.z2} ${o.x} ${by} ${o.z}`,
    );
  }
  cmds.push(`forceload remove ${o.x} ${BUF_Z} ${o.x + (box.x2 - box.x1)} ${BUF_Z + (box.z2 - box.z1)}`);

  const res = await rconBatch(id, cmds);
  const failed = res.filter((r) => /Expected|Unknown|too big|not loaded/i.test(r)).length;
  if (failed > 0) return null;

  meta.snaps = meta.snaps.filter((s) => s.slot !== slot); // this slot is being overwritten
  meta.snaps.push({ slot, box, label: label.slice(0, 80), at: new Date().toISOString() });
  meta.counter += 1;
  saveMeta(id, meta);
  return `snapshot saved (${volume(box)} blocks) — "server undo" restores it`;
}

/** Restore the most recent snapshot. Each call walks one step further back.
    With `match` words, restores the NEWEST snapshot whose wish-label contains
    them instead — "server undo whitehouse" undoes the white house even when a
    medieval town was built after it (blind pop once undid the wrong build,
    2026-07-19). */
export async function undoLast(id: string, match?: string): Promise<string> {
  const meta = loadMeta(id);
  let snap: (typeof meta.snaps)[number] | undefined;
  if (match?.trim()) {
    const words = match.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    for (let i = meta.snaps.length - 1; i >= 0; i--) {
      const label = meta.snaps[i].label.toLowerCase();
      const squished = label.replace(/\s+/g, ''); // "whitehouse" must match "white house"
      if (words.some((w) => label.includes(w) || squished.includes(w))) {
        snap = meta.snaps.splice(i, 1)[0];
        break;
      }
    }
    if (!snap) {
      const have = meta.snaps.map((sn) => `"${sn.label.slice(0, 40)}"`).join(', ');
      return `no snapshot matches "${match}" — I have: ${have || 'none'}. Say "server undo" for the most recent.`;
    }
  } else {
    snap = meta.snaps.pop();
  }
  if (!snap) return 'nothing to undo — no snapshots saved';
  const o = bufOrigin(snap.slot);
  const box = snap.box;

  const cmds: string[] = [
    `forceload add ${o.x} ${BUF_Z} ${o.x + (box.x2 - box.x1)} ${BUF_Z + (box.z2 - box.z1)}`,
  ];
  for (const s of slabs(box)) {
    cmds.push(
      `clone ${o.x} ${s.y1} ${o.z} ${o.x + (box.x2 - box.x1)} ${s.y2} ${o.z + (box.z2 - box.z1)} ${s.x1} ${s.y1} ${s.z1}`,
    );
  }
  cmds.push(`forceload remove ${o.x} ${BUF_Z} ${o.x + (box.x2 - box.x1)} ${BUF_Z + (box.z2 - box.z1)}`);

  const res = await rconBatch(id, cmds);
  const failed = res.filter((r) => /Expected|Unknown|too big|not loaded/i.test(r)).length;
  // only CONSUME the snapshot when the restore actually worked. The old code
  // saved the popped meta either way, so a failed undo threw the snapshot away
  // and a second "server undo" silently restored an UNRELATED older region.
  if (failed === 0) {
    saveMeta(id, meta);
    return `undone: "${snap.label}" — region restored (${volume(box)} blocks)`;
  }
  return `undo of "${snap.label}" partially failed (${failed} clone errors) — kept the snapshot, say "server undo" again to retry`;
}

export function undoCount(id: string): number {
  return loadMeta(id).snaps.length;
}
