import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../config.js';
import { serverDir } from './servers.js';
import { craftyApi } from '../clients/crafty.js';
import { stopAndWait, createBackup, isRunningSafe, beginMaintenance, endMaintenance } from './maintenance.js';
import { chownToDirOwner } from './platform.js';

/** Reset and switch replace world/ — the Chunky DONE record and the Bobby
    fallback zip describe the OLD world's chunks and must not survive it.
    Dynamic imports: chunky.ts pulls in maintenance.ts, keep the graph flat. */
async function clearPregenArtifacts(id: string): Promise<void> {
  try {
    const [{ clearPregenHistory }, { clearFallback }] = await Promise.all([
      import('./chunky.js'), import('./bobbyfallback.js'),
    ]);
    clearPregenHistory(id);
    clearFallback(id);
  } catch { /* never fail a good world op over bookkeeping */ }
}

// Realms-style world slots. The LIVE world always sits at world/ so every mod
// behaves exactly as normal; dormant worlds are plain directories parked at
// worlds/slot-<n>/. A switch is two renames — instant regardless of world
// size, and fully reversible by hand (nothing is converted or rewritten).

export const SLOT_COUNT = 3;
const META_DIR = join(PATHS.data, 'worldslots');

interface SlotMeta { name: string; createdAt: string; lastPlayed?: string; pendingSeed?: string }
/** A switch is two renames. A crash between them used to leave meta pointing
    at a slot whose directory held the ONLY copy of the live world — and the
    next switch's "stale copy" rmSync would delete it. The journal records the
    switch before it starts so `recover()` can finish or unwind it. */
interface Pending { from: number; to: number; stage: 'parking' | 'waking' }
interface Meta { active: number; slots: Record<string, SlotMeta>; pending?: Pending }

const metaFile = (id: string) => join(META_DIR, `${id}.json`);

// one world operation at a time per server: a stuck-looking UI once let a
// second reset start while the first was mid-backup — two full zips ran in
// parallel. The lock lives server-side so page refreshes can't defeat it.
const inFlight = new Set<string>();

/** Live progress of the current (or just-finished) world op, for the panel's
    progress bar. Self-clears ~12s after finishing so the UI's "resetting"
    state reliably goes away even if a client missed the completion. */
export interface WorldOpProgress {
  op: 'reset' | 'switch';
  phase: string;
  pct: number;
  startedAt: number;
  done: boolean;
  error?: string;
}
const opProgress = new Map<string, WorldOpProgress>();
export function worldOpProgress(id: string): WorldOpProgress | null {
  return opProgress.get(id) ?? null;
}
function setPhase(id: string, op: 'reset' | 'switch', phase: string, pct: number): void {
  const prev = opProgress.get(id);
  opProgress.set(id, { op, phase, pct, startedAt: prev?.startedAt ?? Date.now(), done: false });
}
function finishOp(id: string, error?: string): void {
  const prev = opProgress.get(id);
  if (!prev) return;
  opProgress.set(id, { ...prev, phase: error ? `failed: ${error}` : 'done', pct: 100, done: true, error });
  const t = setTimeout(() => {
    // only clear if no NEW op started since we finished
    if (opProgress.get(id)?.done) opProgress.delete(id);
  }, 12_000);
  t.unref?.();
}
const slotDir = (id: string, n: number) => join(serverDir(id), 'worlds', `slot-${n}`);
const worldDir = (id: string) => join(serverDir(id), 'world');

/** Finish (or unwind) a switch that was interrupted by a crash/kill. Renames
    are atomic per directory, so each stage has exactly two possible states and
    we can always tell which one we are in. Runs on every read — a recovered
    switch is invisible to the caller. */
function recover(id: string, meta: Meta): Meta {
  const p = meta.pending;
  if (!p) return meta;
  const liveExists = existsSync(worldDir(id));
  const fromExists = existsSync(slotDir(id, p.from));
  const toExists = existsSync(slotDir(id, p.to));

  if (p.stage === 'parking') {
    if (liveExists && !fromExists) {
      // nothing moved yet — abandon the switch, the old world is still live
      delete meta.pending;
      saveMeta(id, meta);
      return meta;
    }
    // the park rename landed; fall through and finish the wake stage
    p.stage = 'waking';
  }

  if (p.stage === 'waking') {
    if (!liveExists && toExists) renameSync(slotDir(id, p.to), worldDir(id)); // redo the wake
    // if the target slot never existed, the world is meant to regenerate fresh
    meta.active = p.to;
    delete meta.pending;
    saveMeta(id, meta);
  }
  return meta;
}

function loadMeta(id: string): Meta {
  // ONLY a genuinely-missing file may fall back to defaults. A transient read
  // failure (antivirus briefly locking a just-written file) once returned the
  // default meta and silently flipped the active slot — retry, then throw.
  for (let attempt = 0; ; attempt++) {
    try {
      return recover(id, JSON.parse(readFileSync(metaFile(id), 'utf8')) as Meta);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') break;
      if (attempt >= 2) throw e;
      const until = Date.now() + 60;
      while (Date.now() < until) { /* brief blocking wait — callers are sync */ }
    }
  }
  // first sight of this server: whatever world exists today is slot 1
  return { active: 1, slots: { 1: { name: 'World 1', createdAt: new Date().toISOString() } } };
}

function saveMeta(id: string, meta: Meta): void {
  mkdirSync(META_DIR, { recursive: true });
  // atomic: a reader can never see a half-written file
  const tmp = `${metaFile(id)}.tmp`;
  writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8');
  renameSync(tmp, metaFile(id));
}

function dirSize(p: string): number {
  let total = 0;
  try {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const f = join(p, e.name);
      try {
        total += e.isDirectory() ? dirSize(f) : statSync(f).size;
      } catch { /* transient */ }
    }
  } catch { /* missing */ }
  return total;
}

export interface SlotView {
  n: number;
  name: string;
  active: boolean;
  exists: boolean;
  sizeMb: number;
  createdAt?: string;
  lastPlayed?: string;
}

export function listSlots(id: string): { active: number; slots: SlotView[] } {
  const meta = loadMeta(id);
  const slots: SlotView[] = [];
  for (let n = 1; n <= SLOT_COUNT; n++) {
    const active = n === meta.active;
    const dir = active ? worldDir(id) : slotDir(id, n);
    const exists = existsSync(dir);
    const info = meta.slots[n];
    slots.push({
      n,
      name: info?.name ?? `World ${n}`,
      active,
      exists,
      sizeMb: exists ? Math.round(dirSize(dir) / 1e5) / 10 : 0,
      createdAt: info?.createdAt,
      lastPlayed: active ? undefined : info?.lastPlayed,
    });
  }
  return { active: meta.active, slots };
}

export function renameSlot(id: string, n: number, name: string): void {
  const meta = loadMeta(id);
  const clean = name.trim().slice(0, 32) || `World ${n}`;
  const prev = meta.slots[n];
  meta.slots[n] = { createdAt: prev?.createdAt ?? new Date().toISOString(), lastPlayed: prev?.lastPlayed, name: clean };
  saveMeta(id, meta);
}

/** Write (or clear) level-seed in server.properties — only matters when the
    switched-to slot has no world yet, i.e. the server will generate one. */
function setSeed(id: string, seed: string | undefined): void {
  const file = join(serverDir(id), 'server.properties');
  if (!existsSync(file)) return;
  const props = readFileSync(file, 'utf8');
  const line = `level-seed=${(seed ?? '').trim()}`;
  const next = /^level-seed=.*$/m.test(props)
    ? props.replace(/^level-seed=.*$/m, line)
    : `${props.trimEnd()}\n${line}\n`;
  writeFileSync(file, next, 'utf8');
}

export interface SwitchResult { ok: boolean; error?: string; fresh?: boolean; restarted?: boolean }

/** Switch the live world to slot n. Stops the server if needed, backs up the
    outgoing world, swaps directories, optionally starts again. */
export async function switchSlot(id: string, n: number, opts: { start?: boolean; seed?: string } = {}): Promise<SwitchResult> {
  if (n < 1 || n > SLOT_COUNT) return { ok: false, error: 'bad slot number' };
  if (inFlight.has(id)) return { ok: false, error: 'a world operation is already running — give it a few minutes' };
  inFlight.add(id);
  beginMaintenance(id); // scheduler/autostop must not touch the server mid-switch
  setPhase(id, 'switch', 'starting…', 5);
  try {
    const r = await doSwitch(id, n, opts);
    // panel runs as root; anything a world op touched must return to the
    // crafty user or the server can't boot (live 2026-07-19: a reset left
    // world/ + server.properties root-owned and Horror crashed on start
    // with "Failed to store properties" until a manual chown)
    await chownToDirOwner(serverDir(id)).catch(() => {});
    if (r.ok) await clearPregenArtifacts(id);
    finishOp(id, r.ok ? undefined : r.error);
    return r;
  } catch (e) {
    finishOp(id, String(e).slice(0, 120));
    throw e;
  } finally {
    inFlight.delete(id);
    endMaintenance(id);
  }
}

async function doSwitch(id: string, n: number, opts: { start?: boolean; seed?: string }): Promise<SwitchResult> {
  const meta = loadMeta(id);
  if (n === meta.active) return { ok: false, error: 'that world is already active' };

  const wasRunning = await isRunningSafe(id);
  if (wasRunning) {
    setPhase(id, 'switch', 'stopping the server…', 12);
    const stopped = await stopAndWait(id);
    if (!stopped) return { ok: false, error: 'server would not stop — try again' };
  }

  // safety: the outgoing world gets a backup before anything moves. A thrown
  // backup (robocopy/zip failure) must surface as a clean refusal, not a 500.
  if (existsSync(worldDir(id))) {
    setPhase(id, 'switch', 'backing up the outgoing world…', 30);
    try {
      const b = await createBackup(id);
      if ('error' in b) return { ok: false, error: `pre-switch backup failed: ${b.error}` };
    } catch (e) {
      return { ok: false, error: `pre-switch backup failed: ${String(e).slice(0, 140)}` };
    }
  }

  setPhase(id, 'switch', 'swapping worlds…', 80);
  mkdirSync(join(serverDir(id), 'worlds'), { recursive: true });

  // journal the switch BEFORE touching anything: a crash between the two
  // renames is now recoverable instead of silently fatal
  meta.pending = { from: meta.active, to: n, stage: 'parking' };
  saveMeta(id, meta);

  // park the active world in its slot
  if (existsSync(worldDir(id))) {
    // a leftover directory in our own slot can only be junk from an aborted
    // run — but never delete it while a pending switch could still need it
    rmSync(slotDir(id, meta.active), { recursive: true, force: true });
    renameSync(worldDir(id), slotDir(id, meta.active));
  }
  meta.slots[meta.active] = {
    name: meta.slots[meta.active]?.name ?? `World ${meta.active}`,
    createdAt: meta.slots[meta.active]?.createdAt ?? new Date().toISOString(),
    lastPlayed: new Date().toISOString(),
  };
  meta.pending = { from: meta.active, to: n, stage: 'waking' };
  saveMeta(id, meta);

  // wake the target slot — or let the server generate a fresh world
  let fresh = false;
  if (existsSync(slotDir(id, n))) {
    renameSync(slotDir(id, n), worldDir(id));
    setSeed(id, undefined); // never let a stale seed leak into future worlds
  } else {
    fresh = true;
    // explicit seed wins; otherwise a seed remembered from a reset; blank = random
    setSeed(id, opts.seed ?? meta.slots[n]?.pendingSeed);
    meta.slots[n] = { name: meta.slots[n]?.name ?? `World ${n}`, createdAt: new Date().toISOString() };
  }

  meta.active = n;
  delete meta.pending;
  saveMeta(id, meta);

  let restarted = false;
  if (opts.start || wasRunning) {
    await craftyApi.action(id, 'start_server').catch(() => {});
    restarted = true;
  }
  return { ok: true, fresh, restarted };
}

/** Reset a slot to "never generated". The world is zipped into the normal
    backups folder FIRST — even a reset is recoverable. */
export async function resetSlot(id: string, n: number, seed?: string): Promise<{ ok: boolean; error?: string }> {
  if (n < 1 || n > SLOT_COUNT) return { ok: false, error: 'bad slot number' };
  if (inFlight.has(id)) return { ok: false, error: 'a world operation is already running — give it a few minutes' };
  inFlight.add(id);
  beginMaintenance(id);
  setPhase(id, 'reset', 'starting…', 5);
  try {
    const r = await doReset(id, n, seed);
    await chownToDirOwner(serverDir(id)).catch(() => {}); // same root-vs-crafty class as switch
    if (r.ok) await clearPregenArtifacts(id);
    finishOp(id, r.ok ? undefined : r.error);
    return r;
  } catch (e) {
    finishOp(id, String(e).slice(0, 120));
    throw e;
  } finally {
    inFlight.delete(id);
    endMaintenance(id);
  }
}

async function doReset(id: string, n: number, seed?: string): Promise<{ ok: boolean; error?: string }> {
  const meta = loadMeta(id);

  if (n === meta.active) {
    const wasRunning = await isRunningSafe(id);
    if (wasRunning) {
      setPhase(id, 'reset', 'stopping the server…', 12);
      const stopped = await stopAndWait(id);
      if (!stopped) return { ok: false, error: 'server would not stop — try again' };
    }
    if (existsSync(worldDir(id))) {
      setPhase(id, 'reset', 'backing up the world (the slow part on big worlds)…', 30);
      try {
        const b = await createBackup(id);
        if ('error' in b) return { ok: false, error: `pre-reset backup failed: ${b.error}` };
      } catch (e) {
        return { ok: false, error: `pre-reset backup failed: ${String(e).slice(0, 140)}` };
      }
      setPhase(id, 'reset', 'deleting the old world…', 78);
      rmSync(worldDir(id), { recursive: true, force: true });
    }
    setPhase(id, 'reset', 'finalizing…', 92);
    setSeed(id, seed); // blank/undefined = random seed = brand-new spawn
    meta.slots[n] = { name: meta.slots[n]?.name ?? `World ${n}`, createdAt: new Date().toISOString() };
    saveMeta(id, meta);
    return { ok: true }; // next Start generates a fresh world
  }

  // dormant slot: move it to world/ position is not needed — zip it in place
  const dir = slotDir(id, n);
  setPhase(id, 'reset', 'backing up the dormant slot…', 35);
  if (existsSync(dir)) {
    // reuse the backup pipeline by temporarily renaming through world/? No —
    // the live world may exist. Zip the slot directly in place.
    const { zipDir } = await import('./platform.js');
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const dest = join(PATHS.root, 'Backups', 'panel', id, `world-slot${n}-${stamp}.zip`);
    mkdirSync(join(PATHS.root, 'Backups', 'panel', id), { recursive: true });
    try {
      await zipDir(dir, dest);
    } catch (e) {
      return { ok: false, error: `pre-reset zip failed: ${String(e).slice(0, 120)}` };
    }
    rmSync(dir, { recursive: true, force: true });
  }
  // a dormant slot can't take the seed yet — remember it for the switch that
  // eventually generates this world
  meta.slots[n] = { name: meta.slots[n]?.name ?? `World ${n}`, createdAt: new Date().toISOString(), pendingSeed: seed };
  saveMeta(id, meta);
  return { ok: true };
}
