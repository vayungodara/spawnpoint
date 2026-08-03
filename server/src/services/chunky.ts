import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../config.js';
import { craftyApi } from '../clients/crafty.js';
import { rconCommand, rconBatch } from '../clients/rcon.js';
import { serverPhase } from './phase.js';
import { serverDir } from './servers.js';
import { detect } from './detect.js';
import { isUnderMaintenance } from './maintenance.js';

// CHUNKY CONTROL — drive the Chunky pre-generation mod natively from the panel.
// Any server that has the Chunky jar gets a full pregen console: start/pause/
// resume/cancel, radius + center + shape + which dimensions, live progress, an
// optional daily schedule, and an "auto-pause while players are online" guard
// so a pregen never competes with people actually playing.
//
// Everything is RCON. Two Chunky behaviours (confirmed by decompiling the
// installed jar, and the reason this file is careful):
//   1. `chunky cancel` and `chunky trim` are DESTRUCTIVE and gated — Chunky
//      stores a pending action and replies "type /chunky confirm". Sending the
//      bare command does NOTHING. Both must be followed by `chunky confirm` on
//      the SAME RCON connection (pending action is keyed by sender).
//   2. A PAUSED task is REMOVED from Chunky's in-memory map and saved to disk,
//      so `chunky progress` then reports "No tasks running." — a paused task is
//      indistinguishable from idle over RCON. The panel therefore tracks pause
//      state itself, PERSISTED, with a snapshot of the last progress, so the UI
//      can show a Resume button and the guard can auto-resume when empty.

const CONFIG_FILE = join(PATHS.data, 'chunky.json');
const POLL_MS = 20_000;

export const SHAPES = ['square', 'circle', 'diamond', 'triangle', 'pentagon', 'star'] as const;
export const DIMENSIONS = [
  { id: 'minecraft:overworld', label: 'Overworld' },
  { id: 'minecraft:the_nether', label: 'Nether' },
  { id: 'minecraft:the_end', label: 'The End' },
] as const;
const DIM_IDS = new Set(DIMENSIONS.map((d) => d.id));

export interface ChunkyServerConfig {
  radius: number;
  centerMode: 'spawn' | 'custom';
  centerX: number;
  centerZ: number;
  shape: string;
  dimensions: string[];
  pauseWhenPlayersOnline: boolean;
  schedule: { enabled: boolean; time: string };
  lastRun?: string;
}

const SERVER_DEFAULTS: ChunkyServerConfig = {
  radius: 2000,
  centerMode: 'spawn',
  centerX: 0,
  centerZ: 0,
  shape: 'square',
  dimensions: ['minecraft:overworld'],
  pauseWhenPlayersOnline: true,
  schedule: { enabled: false, time: '04:00' },
};

// what the panel remembers about a task it paused (Chunky can't tell us)
interface PauseState {
  by: 'user' | 'guard';
  at: string;
  snapshot: Omit<ChunkyProgress, 'running' | 'paused'> | null;
}

/** The completed-run summary the UI shows instead of silently snapping back
    to the start form (a finished pregen used to be indistinguishable from
    "never ran"). Written the first time a task we watched running is gone
    without being paused or cancelled. */
export interface DoneRecord {
  at: string; //        when we first saw it finished
  startedAt: string;
  chunks: number | null; // last processed count we saw (≈ total at completion)
  dimensions: string[];
  radius: number;
  shape: string;
}

interface ChunkyStore {
  servers: Record<string, ChunkyServerConfig>;
  pauseStates: Record<string, PauseState>;
  lastDone: Record<string, DoneRecord>;
}

function loadStore(): ChunkyStore {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, ''));
    return { servers: raw.servers ?? {}, pauseStates: raw.pauseStates ?? {}, lastDone: raw.lastDone ?? {} };
  } catch {
    return { servers: {}, pauseStates: {}, lastDone: {} };
  }
}

// tasks we have SEEN running this panel-process, so completion is detectable
// (in-memory: a panel restart mid-pregen just re-learns it on the next poll)
const liveSeen = new Map<string, { startedAt: string; chunks: number | null }>();

function saveStore(store: ChunkyStore): void {
  mkdirSync(PATHS.data, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(store, null, 2), 'utf8');
}

export function loadChunkyConfig(id: string): ChunkyServerConfig {
  const raw = loadStore().servers[id];
  return { ...SERVER_DEFAULTS, ...raw, schedule: { ...SERVER_DEFAULTS.schedule, ...raw?.schedule } };
}

/** Coerce a possibly-NaN incoming number to an integer, else keep the current. */
const intOr = (v: unknown, fallback: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : fallback;
};

const isHHMM = (s: unknown): s is string => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

export function saveChunkyConfig(id: string, patch: Partial<ChunkyServerConfig>): ChunkyServerConfig {
  const store = loadStore();
  const cur = { ...SERVER_DEFAULTS, ...store.servers[id], schedule: { ...SERVER_DEFAULTS.schedule, ...store.servers[id]?.schedule } };
  const next: ChunkyServerConfig = {
    radius: Math.min(50_000, Math.max(1, intOr(patch.radius, cur.radius))),
    centerMode: patch.centerMode === 'custom' || patch.centerMode === 'spawn' ? patch.centerMode : cur.centerMode,
    centerX: intOr(patch.centerX, cur.centerX),
    centerZ: intOr(patch.centerZ, cur.centerZ),
    shape: SHAPES.includes((patch.shape ?? '') as never) ? patch.shape! : cur.shape,
    dimensions:
      Array.isArray(patch.dimensions) && patch.dimensions.length
        ? [...new Set(patch.dimensions.filter((d) => DIM_IDS.has(d as never)))]
        : cur.dimensions,
    pauseWhenPlayersOnline:
      typeof patch.pauseWhenPlayersOnline === 'boolean' ? patch.pauseWhenPlayersOnline : cur.pauseWhenPlayersOnline,
    // schedule is validated field-by-field — never spread the raw body in
    schedule: {
      enabled: typeof patch.schedule?.enabled === 'boolean' ? patch.schedule.enabled : cur.schedule.enabled,
      time: isHHMM(patch.schedule?.time) ? patch.schedule!.time : cur.schedule.time,
    },
    lastRun: patch.lastRun ?? cur.lastRun,
  };
  // never persist an empty dimension list — it makes a start silently no-op
  if (!next.dimensions.length) next.dimensions = cur.dimensions.length ? cur.dimensions : ['minecraft:overworld'];
  store.servers[id] = next;
  saveStore(store);
  return next;
}

/** A replaced world (reset / slot switch / backup restore) invalidates every
    pregen artifact: the DONE record describes chunks that no longer exist and
    a paused task would resume into the wrong world. Callers do this alongside
    deleting the Bobby fallback zip (bobbyfallback.clearFallback). */
export function clearPregenHistory(id: string): void {
  liveSeen.delete(id);
  const store = loadStore();
  if (store.lastDone[id] || store.pauseStates[id]) {
    delete store.lastDone[id];
    delete store.pauseStates[id];
    saveStore(store);
  }
}

function loadPauseState(id: string): PauseState | null {
  return loadStore().pauseStates[id] ?? null;
}
function setPauseState(id: string, ps: PauseState): void {
  const store = loadStore();
  store.pauseStates[id] = ps;
  saveStore(store);
}
function clearPauseState(id: string): void {
  const store = loadStore();
  if (store.pauseStates[id]) {
    delete store.pauseStates[id];
    saveStore(store);
  }
}

/** Which jar dir this loader uses (mods vs plugins) — or null if the loader
    can't take Chunky at all (vanilla). */
function jarDirFor(id: string): string | null {
  const { loader } = detect(serverDir(id), id);
  if (loader === 'fabric' || loader === 'forge' || loader === 'neoforge') return 'mods';
  if (loader === 'paper' || loader === 'purpur') return 'plugins';
  return null;
}

export function chunkyInstalled(id: string): boolean {
  const sub = jarDirFor(id);
  if (!sub) return false;
  const dir = join(serverDir(id), sub);
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((f) => /chunky/i.test(f) && f.endsWith('.jar'));
  } catch {
    return false;
  }
}

const strip = (s: string) => s.replace(/§./g, '').trim();

// A jar in mods/ is NOT a loaded mod — a server started before the install
// answers every `chunky …` with the dispatcher's unknown-command error
// (vanilla/fabric/forge: "Unknown or incomplete command"; Bukkit-family:
// "Unknown command. Type \"/help\" for help."). Found live 2026-07-24: the
// panel reported "pre-generating" while all five commands bounced this way.
const UNKNOWN_CMD_RE = /unknown (?:or incomplete )?command/i;

/** Locale-aware number: Chunky may print "17.75" or (German locale) "17,75".
    Last separator is the decimal point; earlier separators are grouping. */
function num(raw: string | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim();
  const dec = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
  const v = dec < 0 ? Number(s) : Number(`${s.slice(0, dec).replace(/[.,\s]/g, '') || '0'}.${s.slice(dec + 1)}`);
  return Number.isFinite(v) ? v : null;
}

export interface ChunkyProgress {
  running: boolean;
  paused: boolean;
  dimension: string | null;
  chunks: number | null;
  percent: number | null;
  etaText: string | null;
  etaSeconds: number | null;
  rate: number | null;
  current: [number, number] | null;
  taskCount?: number; // how many worlds are generating concurrently
}

// `chunky progress` only ever lists RUNNING tasks (paused ones are removed from
// the map), one line each. Match every task line so a multi-dimension pregen
// isn't reported as just its first world.
const TASK_RE =
  /for\s+(minecraft:[a-z_]+|[a-z0-9_]+:[a-z0-9_/]+)\.?\s*Processed:\s*([\d.,]+)\s*chunks?\s*\(([\d.,]+)\s*%\)(?:[^]*?ETA:\s*([\d:]+))?(?:[^]*?Rate:\s*([\d.,]+)\s*cps)?(?:[^]*?Current:\s*(-?\d+),\s*(-?\d+))?/gi;

/** All running tasks in a `chunky progress` reply (empty when idle). */
export function parseAllProgress(raw: string): ChunkyProgress[] {
  const out = strip(raw);
  if (!out || /no task|not running|no.*generation|nothing.*running/i.test(out)) return [];
  const tasks: ChunkyProgress[] = [];
  for (const m of out.matchAll(TASK_RE)) {
    const etaText = m[4] ?? null;
    const etaSeconds = etaText ? etaText.split(':').map(Number).reduce((a, n) => a * 60 + n, 0) : null;
    tasks.push({
      running: true,
      paused: false,
      dimension: m[1],
      chunks: num(m[2]) !== null ? Math.round(num(m[2])!) : null,
      percent: num(m[3]),
      etaText,
      etaSeconds,
      rate: num(m[5]),
      current: m[6] !== undefined ? [Number(m[6]), Number(m[7])] : null,
    });
  }
  return tasks;
}

/** Primary task (first running) for the progress bar — back-compat single view. */
export function parseProgress(raw: string): ChunkyProgress {
  const all = parseAllProgress(raw);
  const idle: ChunkyProgress = {
    running: false, paused: false, dimension: null, chunks: null,
    percent: null, etaText: null, etaSeconds: null, rate: null, current: null,
  };
  if (!all.length) return idle;
  return { ...all[0], taskCount: all.length };
}

export interface ChunkyStatus {
  installed: boolean;
  running: boolean; // server process up + ready
  /** false = jar on disk but the RUNNING server doesn't answer chunky commands
      (installed after boot) — a restart is needed before anything can start */
  loaded: boolean;
  progress: ChunkyProgress | null;
  config: ChunkyServerConfig;
  lastDone: DoneRecord | null;
}

async function serverReady(id: string): Promise<boolean> {
  try {
    const stats = await craftyApi.getStats(id);
    if (!stats.running) return false;
    return (await serverPhase(id, true)) === 'ready';
  } catch {
    return false;
  }
}

/** Snapshot the live progress (primary task) into the plain shape we persist. */
function snapshotOf(p: ChunkyProgress | null): PauseState['snapshot'] {
  if (!p) return null;
  const { running: _r, paused: _p, ...rest } = p;
  return rest;
}

export async function chunkyStatus(id: string): Promise<ChunkyStatus> {
  const installed = chunkyInstalled(id);
  const config = loadChunkyConfig(id);
  const lastDone = (): DoneRecord | null => loadStore().lastDone[id] ?? null;
  if (!installed || !(await serverReady(id))) {
    return { installed, running: false, loaded: true, progress: null, config, lastDone: lastDone() };
  }
  let progress: ChunkyProgress | null = null;
  try {
    const raw = await rconCommand(id, 'chunky progress');
    if (UNKNOWN_CMD_RE.test(strip(raw))) {
      return { installed, running: true, loaded: false, progress: null, config, lastDone: lastDone() };
    }
    const tasks = parseAllProgress(raw);
    if (tasks.length) {
      // something is genuinely running — any stale pause record is void
      clearPauseState(id);
      progress = { ...tasks[0], taskCount: tasks.length };
      const prev = liveSeen.get(id);
      liveSeen.set(id, {
        startedAt: prev?.startedAt ?? config.lastRun ?? new Date().toISOString(),
        chunks: progress.chunks ?? prev?.chunks ?? null,
      });
    } else {
      // nothing running in Chunky's view; a task we paused is invisible here,
      // so fall back to our persisted pause record
      const ps = loadPauseState(id);
      // a task we watched running is gone WITHOUT a pause record = it finished
      const seen = liveSeen.get(id);
      if (!ps && seen) {
        liveSeen.delete(id);
        const store = loadStore();
        store.lastDone[id] = {
          at: new Date().toISOString(),
          startedAt: seen.startedAt,
          chunks: seen.chunks,
          dimensions: config.dimensions,
          radius: config.radius,
          shape: config.shape,
        };
        saveStore(store);
      }
      progress = ps
        ? { running: false, paused: true, dimension: null, chunks: null, percent: null, etaText: null, etaSeconds: null, rate: null, current: null, ...ps.snapshot }
        : parseProgress(''); // idle
    }
  } catch {
    // RCON blip: don't invent "idle". Report unknown-but-null; the UI keeps its
    // last state rather than snapping to the Start form mid-task.
    progress = null;
  }
  return { installed, running: true, loaded: true, progress, config, lastDone: lastDone() };
}

async function playersOnline(id: string): Promise<number> {
  try {
    const m = /There are (\d+)/i.exec(await rconCommand(id, 'list'));
    return m ? Number(m[1]) : 0;
  } catch {
    return -1; // unknown — treated as occupied everywhere below
  }
}

export async function startPregen(
  id: string,
  overrides?: Partial<Pick<ChunkyServerConfig, 'radius' | 'centerMode' | 'centerX' | 'centerZ' | 'shape' | 'dimensions'>>,
): Promise<{ ok: true; message: string } | { error: string }> {
  if (!chunkyInstalled(id)) return { error: 'Chunky is not installed on this server' };
  if (!(await serverReady(id))) return { error: 'the server must be running to pre-generate' };
  const cfg = overrides ? saveChunkyConfig(id, overrides) : loadChunkyConfig(id);

  // harden Chunky's own config so a server restart RESUMES the task instead
  // of silently killing it (live 2026-07-27: a panel restart at 2% orphaned
  // the run and the owner flew straight back into raw worldgen). Chunky reads
  // this file at boot, so writing it any time before the next restart works.
  try {
    const p = join(serverDir(id), 'config', 'chunky', 'config.json');
    if (existsSync(p)) {
      const c = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
      if (c.continueOnRestart !== true || c.silent !== true) {
        c.continueOnRestart = true; // restarts resume, never orphan
        c.silent = true;            // progress spam stays out of player chat
        writeFileSync(p, JSON.stringify(c, null, 2), 'utf8');
      }
    }
  } catch { /* never block a pregen start over config hardening */ }

  // refuse if a task is running OR paused (a paused task is invisible to
  // `chunky progress`, so also consult our persisted pause record — otherwise
  // `chunky start` hits Chunky's overwrite-confirm prompt and silently no-ops)
  let live: ChunkyProgress[] = [];
  try {
    const probe = await rconCommand(id, 'chunky progress');
    if (UNKNOWN_CMD_RE.test(strip(probe))) {
      return { error: 'Chunky is installed but the server booted before it was added — restart the server to load it, then generate' };
    }
    live = parseAllProgress(probe);
  } catch { /* proceed */ }
  if (live.length || loadPauseState(id)) {
    return { error: 'a pre-generation task is already active — cancel it first' };
  }

  const dims = cfg.dimensions.length ? cfg.dimensions : ['minecraft:overworld'];
  const replies: string[] = [];
  for (const dim of dims) {
    replies.push(...await rconBatch(id, [
      `chunky world ${dim}`,
      cfg.centerMode === 'spawn' ? 'chunky spawn' : `chunky center ${cfg.centerX} ${cfg.centerZ}`,
      `chunky radius ${cfg.radius}`,
      `chunky shape ${cfg.shape}`,
      'chunky start',
    ]));
  }
  // NEVER report a start the server didn't acknowledge (live 2026-07-24: all
  // five commands bounced off a not-yet-loaded Chunky and the panel still said
  // "pre-generating"). Truth = the commands were understood AND a task is now
  // visible; a tiny radius can finish between the two probes, so a "Task
  // started" reply also counts.
  if (replies.some((r) => UNKNOWN_CMD_RE.test(strip(r)))) {
    return { error: 'the server did not recognize the chunky command — restart the server so the Chunky jar loads, then generate' };
  }
  let confirmed = replies.some((r) => /task.{0,20}(started|running)|started.{0,20}task/i.test(strip(r)));
  if (!confirmed) {
    try {
      confirmed = parseAllProgress(await rconCommand(id, 'chunky progress')).length > 0;
    } catch { confirmed = true; /* RCON blip after clean sends — don't false-alarm */ }
  }
  if (!confirmed) {
    const tail = strip(replies[replies.length - 1] ?? '').slice(0, 140);
    return { error: `Chunky did not start a task${tail ? ` — it replied: "${tail}"` : ''}` };
  }
  saveChunkyConfig(id, { lastRun: new Date().toISOString() });
  const scope = dims.map((d) => d.replace('minecraft:', '')).join(', ');
  return { ok: true, message: `pre-generating a ${cfg.radius}-block ${cfg.shape} in ${scope}` };
}

export async function pausePregen(id: string): Promise<{ ok: true } | { error: string }> {
  if (!(await serverReady(id))) return { error: 'server not running' };
  // capture progress BEFORE pausing — once paused, Chunky hides the numbers
  let live: ChunkyProgress | null = null;
  try {
    live = parseProgress(await rconCommand(id, 'chunky progress'));
  } catch { /* snapshot is best-effort */ }
  const reply = await rconCommand(id, 'chunky pause');
  if (UNKNOWN_CMD_RE.test(strip(reply))) return { error: 'Chunky is not loaded — restart the server first' };
  // only record a paused task when one was actually running — pausing an idle
  // server must not leave a phantom PAUSED state with a dead Resume button
  if (live?.running) setPauseState(id, { by: 'user', at: new Date().toISOString(), snapshot: snapshotOf(live) });
  else clearPauseState(id);
  return { ok: true };
}

export async function resumePregen(id: string): Promise<{ ok: true } | { error: string }> {
  if (!(await serverReady(id))) return { error: 'server not running' };
  const reply = await rconCommand(id, 'chunky continue');
  if (UNKNOWN_CMD_RE.test(strip(reply))) return { error: 'Chunky is not loaded — restart the server first (your paused task is saved on disk)' };
  clearPauseState(id);
  return { ok: true };
}

export async function cancelPregen(id: string): Promise<{ ok: true } | { error: string }> {
  if (!(await serverReady(id))) return { error: 'server not running' };
  // `chunky cancel` is gated: it only ARMS the cancel and asks for confirmation.
  // The confirm MUST ride the same RCON connection (pending action keyed by
  // sender). rconBatch keeps them on one connection.
  const replies = await rconBatch(id, ['chunky cancel', 'chunky confirm']);
  if (replies.some((r) => UNKNOWN_CMD_RE.test(strip(r)))) return { error: 'Chunky is not loaded — restart the server first' };
  clearPauseState(id);
  liveSeen.delete(id); // a cancelled task must not be reported as completed
  return { ok: true };
}

export async function trimChunks(id: string): Promise<{ ok: true } | { error: string }> {
  if (!(await serverReady(id))) return { error: 'server not running' };
  const replies = await rconBatch(id, ['chunky trim', 'chunky confirm']); // same confirm gate as cancel
  if (replies.some((r) => UNKNOWN_CMD_RE.test(strip(r)))) return { error: 'Chunky is not loaded — restart the server first' };
  return { ok: true };
}

async function tick(log: (msg: string) => void): Promise<void> {
  let servers;
  try {
    servers = await craftyApi.listServers();
  } catch {
    return;
  }
  const store = loadStore();
  for (const srv of servers) {
    const id = srv.server_id;
    if (isUnderMaintenance(id)) continue;
    if (!chunkyInstalled(id)) continue;
    const cfg = store.servers[id] ? loadChunkyConfig(id) : null;
    const wantPlayerGuard = cfg?.pauseWhenPlayersOnline ?? SERVER_DEFAULTS.pauseWhenPlayersOnline;
    const wantSchedule = cfg?.schedule.enabled ?? false;
    const ps = store.pauseStates[id] ?? null;
    // nothing to automate unless a guard, a schedule, or a guard-paused task
    if (!wantPlayerGuard && !wantSchedule && !ps) continue;
    if (!(await serverReady(id))) continue;

    try {
      const tasks = parseAllProgress(await rconCommand(id, 'chunky progress'));
      const running = tasks.length > 0;
      const players = await playersOnline(id);

      // --- player-pause guard ---
      if (wantPlayerGuard) {
        // pause when occupied (players > 0) OR unknown (-1, treat as occupied)
        if (running && players !== 0) {
          const snap = snapshotOf({ ...tasks[0], taskCount: tasks.length });
          await rconCommand(id, 'chunky pause');
          setPauseState(id, { by: 'guard', at: new Date().toISOString(), snapshot: snap });
          log(`chunky: paused pregen on ${srv.server_name} — ${players < 0 ? 'players unknown' : players + ' online'}`);
          continue;
        }
        // resume only a task WE auto-paused, and only when provably empty
        if (!running && players === 0 && ps?.by === 'guard') {
          await rconCommand(id, 'chunky continue');
          clearPauseState(id);
          log(`chunky: resumed pregen on ${srv.server_name} — server empty again`);
          continue;
        }
      }

      // --- daily schedule (only when provably empty, and nothing active) ---
      if (wantSchedule && cfg && !running && !ps && players === 0 && scheduleDue(cfg, new Date())) {
        const res = await startPregen(id);
        // burn the daily slot ONLY on a real start — a failed start retries next tick
        if ('ok' in res) {
          saveChunkyConfig(id, { lastRun: new Date().toISOString() });
          log(`chunky: scheduled pregen on ${srv.server_name} — ${res.message}`);
        } else {
          log(`chunky: scheduled pregen on ${srv.server_name} skipped — ${res.error}`);
        }
      }
    } catch (e) {
      log(`chunky: tick failed for ${srv.server_name}: ${String(e).slice(0, 120)}`);
    }
  }
}

function scheduleDue(cfg: ChunkyServerConfig, now: Date): boolean {
  if (!cfg.schedule.enabled) return false;
  const [hh, mm] = String(cfg.schedule.time ?? '04:00').split(':').map(Number);
  const due = new Date(now);
  due.setHours(hh || 0, mm || 0, 0, 0);
  if (now < due) return false;
  const last = cfg.lastRun ? new Date(cfg.lastRun) : null;
  return !last || last < due;
}

export function startChunkyWatcher(log: (msg: string) => void): void {
  const timer = setInterval(() => {
    tick(log).catch((e) => log(`chunky: tick error: ${String(e)}`));
  }, POLL_MS);
  timer.unref();
}
