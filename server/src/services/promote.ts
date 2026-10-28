import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PATHS } from '../config.js';
import { craftyApi } from '../clients/crafty.js';
import { rconCommand } from '../clients/rcon.js';
import { serverDir } from './servers.js';
import { writeFileAtomic } from './platform.js';
import { beginMaintenance, busyReason, endMaintenance, isRunningSafe, maintenanceOf, stopAndWait, strandMaintenance, waitForReady } from './maintenance.js';
import { markRunning } from './bootrestore.js';
import { autoModpackActive } from './automodpack.js';
import { candidate, candidateSet, applyReady, undoLast, lastChange, changeState, liveBootFailed, noteLive, assertModsWritable, afterCommit } from './packtxn.js';
import { listPending } from './pendingmods.js';

// PROMOTION. A tested change to the server's own mods goes live only while
// the server is stopped: the running JVM keeps its old jars, and AutoModpack
// would hand friends files the server does not run. So the change waits here:
//   - server running, nobody online: restart now;
//   - players online: warn them in chat, and the owner picks "now" (30 s
//     countdown) or "when everyone has left";
//   - server stopped: the change goes in when it is next started from the
//     panel (Start, Restart, a scheduled start). Started any other way, it
//     runs the old mods and the change waits for the next restart.
// After the change goes in, this boot must prove it is up (RCON answers, or
// its own latest.log says Done); if not, the change is undone and the server
// starts on the previous mods. AutoModpack builds the friends' pack at that
// start; it must match the tested files byte for byte, or a tested change is
// undone the same way.
// One record per server on disk, with the stage it reached, so a panel
// restart part-way finishes the job. While a stage is set the promotion holds
// the server's maintenance fence: nothing else starts, stops or changes it.

export type Choice = 'now' | 'when-empty';

export interface Promotion {
  action: 'apply' | 'undo';
  txn: string;
  /** the owner's pick while players are online */
  choice?: Choice;
  /** players were told a restart is coming */
  warned?: boolean;
  /** absent: waiting for a moment to restart. countdown: players were told
      the restart is 30 s away. stopping: the panel stops the server and makes
      the change. applied: the change is in; the server is starting and its
      boot decides whether the change stays. rollback: it did not pass; it is
      being undone and the server started without it. */
  stage?: 'countdown' | 'stopping' | 'applied' | 'rollback';
  /** when the panel started the server with the change (ms) */
  startedAt?: number;
  /** rollback: why the change could not stay */
  reason?: string;
  since: string;
}

const POLL_MS = 15_000;
const READY_TIMEOUT_S = 600;
const OP = 'mod update';
const dir = join(PATHS.data, 'promotions');
const file = (id: string): string => join(dir, `${id}.json`);

export function promotion(id: string): Promotion | null {
  try { return JSON.parse(readFileSync(file(id), 'utf8')) as Promotion; } catch { return null; }
}
function save(id: string, p: Promotion): Promotion {
  writeFileAtomic(file(id), JSON.stringify(p, null, 1));
  return p;
}

/** what the last poll saw: players online, the server stopped, or nobody
    could say how many players are on (RCON does not answer) */
const seen = new Map<string, number | 'stopped' | 'unknown'>();
/** consecutive polls that found nobody online */
const emptyPolls = new Map<string, number>();
/** servers whose promotion is running a step right now (in this process) */
const busy = new Set<string>();
/** servers that asked for a step while one ran */
const rerun = new Set<string>();
let timer: NodeJS.Timeout | null = null;
let panelLog: (m: string) => void = () => {};

/** For the panel: players online, 'stopped', 'unknown', or undefined before the first poll. */
export function lastSeen(id: string): number | 'stopped' | 'unknown' | undefined {
  return seen.get(id);
}

/** True while the panel is stopping, changing or starting this server. */
export function restarting(id: string): boolean {
  return !!promotion(id)?.stage;
}

/** A change that needs a restart to go live: wait for the right moment. */
export function requestPromotion(id: string, action: Promotion['action'], txn: string, log: (m: string) => void): Promotion {
  const prev = promotion(id);
  const same = prev?.action === action && prev.txn === txn;
  const p = save(id, same ? prev : { action, txn, since: new Date().toISOString() });
  log(`promote: ${action} ${txn} on ${id} waits for a restart`);
  schedule(log);
  return p;
}

/** The owner's pick while players are online. */
export function choose(id: string, choice: Choice, log: (m: string) => void): Promotion {
  const p = promotion(id);
  if (!p) throw new Error('no mod change is waiting for a restart');
  if (restarting(id)) throw new Error('the server is already restarting for this change');
  const next = save(id, { ...p, choice, warned: choice === 'now' ? p.warned : false });
  schedule(log);
  return next;
}

/** Drop a waiting undo (a waiting apply is dropped by discarding its candidate). */
export function cancelUndo(id: string): void {
  const p = promotion(id);
  if (p?.action !== 'undo') return;
  if (restarting(id)) throw new Error('the server is already restarting for this undo');
  rmSync(file(id), { force: true });
}

/** Start the server from the panel. A waiting change goes in first and its
    boot is checked. Throws why when the server cannot be started now. */
export async function startServer(id: string, log: (m: string) => void): Promise<{ promoting: boolean }> {
  assertModsWritable(id); // never start on a half-applied change
  // a start on a running server is a no-op, not a restart for the change
  if (!(await isUp(id)) && claimWaiting(id, log)) return { promoting: true };
  const refused = busyReason(id);
  if (refused) throw new Error(refused);
  await craftyApi.action(id, 'start_server');
  return { promoting: false };
}

/** Restart the server from the panel (Restart button, scheduled restart,
    config restart). A waiting change goes in with it, without a countdown:
    this restart was already announced. Throws why when it cannot restart now. */
export async function restartServer(id: string, log: (m: string) => void): Promise<{ promoting: boolean }> {
  assertModsWritable(id);
  if (claimWaiting(id, log)) return { promoting: true };
  const refused = busyReason(id);
  if (refused) throw new Error(refused);
  await craftyApi.action(id, 'restart_server');
  return { promoting: false };
}

/** Crafty says the server runs or is starting; false when Crafty does not answer. */
const isUp = (id: string): Promise<boolean> => craftyApi.getStats(id).then((s) => !!(s.running || s.waiting_start), () => false);

/** If a change waits, take the server and run stop, change, start in the
    background. Changes queued while jars were locked (Windows) go first. */
function claimWaiting(id: string, log: (m: string) => void): boolean {
  const p = promotion(id);
  if (!p || !stillWaiting(id, p) || listPending(id).length) return false;
  const refused = beginMaintenance(id, OP);
  if (refused) throw new Error(refused);
  // claimed on disk before anything awaits: a poll step running now picks
  // the stage up as soon as it ends
  const claimed = save(id, { ...p, stage: 'stopping' });
  void own(id, () => goLive(id, claimed, log));
  return true;
}

/** Pick up records a panel restart left behind, and ready candidates whose
    record was never written (the panel stopped between the two writes). */
export function resumePromotions(log: (m: string) => void): void {
  panelLog = log;
  const cands = join(PATHS.data, 'candidates');
  for (const id of existsSync(cands) ? readdirSync(cands) : []) {
    const c = candidate(id);
    if (c?.status === 'ready' && !promotion(id)) requestPromotion(id, 'apply', c.txn, log);
  }
  for (const id of records()) {
    const p = promotion(id);
    if (!p) continue;
    // an activation the restart cut short was reversed by resumeCandidates;
    // it was tested, so it waits again instead of asking for approval
    const c = candidate(id);
    if (p.action === 'apply' && c?.txn === p.txn && c.status === 'needs-approval' && p.stage) {
      noteLive(id, p.txn, 'ready', 'tested; goes live when the server restarts');
    }
    // the fence this promotion held in the previous process is its own again
    const m = maintenanceOf(id);
    if (p.stage && m?.op === OP && m.interrupted && !m.note) {
      endMaintenance(id, OP);
      beginMaintenance(id, OP);
    }
  }
  schedule(log);
}

const records = (): string[] => (existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.json')).map((x) => x.slice(0, -5)) : []);

function schedule(log: (m: string) => void): void {
  panelLog = log;
  for (const id of records()) void own(id, () => step(id, panelLog));
  if (timer) return;
  timer = setInterval(() => {
    const ids = records();
    if (!ids.length && timer) { clearInterval(timer); timer = null; return; }
    for (const id of ids) void own(id, () => step(id, panelLog));
  }, POLL_MS);
  timer.unref();
}

/** Run `fn` as this server's only promotion step. While one runs, a poll
    is queued instead, so a stage claimed meanwhile is picked up right after. */
async function own(id: string, fn: () => Promise<void>): Promise<void> {
  if (busy.has(id)) { rerun.add(id); return; }
  busy.add(id);
  try {
    await fn();
  } catch (e) {
    panelLog(`promote: ${id}: ${String(e).slice(0, 200)}`);
  } finally {
    busy.delete(id);
    if (rerun.delete(id)) void own(id, () => step(id, panelLog));
  }
}

/** Is the change this record waits for still waiting? */
function stillWaiting(id: string, p: Promotion): boolean {
  if (p.action === 'apply') {
    const c = candidate(id);
    return c?.txn === p.txn && c.status === 'ready';
  }
  return lastChange(id)?.txn === p.txn;
}

async function step(id: string, log: (m: string) => void): Promise<void> {
  const p = promotion(id);
  if (!p) return;
  if (p.stage) {
    // resumed mid-way: finish what the previous process started, under its fence
    const m = maintenanceOf(id);
    if (m ? m.op !== OP || !!m.note : beginMaintenance(id, OP)) return;
  }
  if (p.stage === 'countdown') return release(id, p); // the stop never happened
  if (p.stage === 'stopping') return goLive(id, p, log);
  if (p.stage === 'applied') return bootAndVerify(id, p, log);
  if (p.stage === 'rollback') return rollBack(id, p, p.reason ?? 'the change did not pass after the restart', log);

  if (!stillWaiting(id, p)) return release(id, p); // discarded, retested or done
  if (maintenanceOf(id)) return; // another operation owns the server right now
  // changes queued while the jars were locked (Windows) go in on the owner's
  // restart first; the waiting change is retested against them
  if (listPending(id).length) return;
  if (!(await isRunningSafe(id))) {
    seen.set(id, 'stopped');
    emptyPolls.delete(id);
    return; // goes in on the next start from the panel
  }
  const online = await countPlayers(id);
  if (online === null) {
    // never restart a server that might have players on it
    seen.set(id, 'unknown');
    emptyPolls.delete(id);
    return;
  }
  seen.set(id, online);
  const empty = online === 0 ? (emptyPolls.get(id) ?? 0) + 1 : 0;
  emptyPolls.set(id, empty);
  // the owner may have chosen, cancelled or discarded while players were counted
  const now = current(id, p);
  if (!now) return;
  // two empty polls in a row: someone joining right now is not missed
  if (empty >= 2 || (now.choice === 'now' && online === 0)) return restart(id, now, log, false);
  if (online > 0 && now.choice === 'now') return restart(id, now, log, true);
  if (online > 0 && !now.warned) {
    await say(id, now.choice === 'when-empty'
      ? `The server restarts to load ${what(now)} once everyone has logged off.`
      : `${what(now, true)} is ready. The server will restart soon to load it.`);
    const after = current(id, now);
    if (after) save(id, { ...after, warned: true });
  }
}

/** The record on disk if it is still the same change, else null (cancelled,
    discarded or replaced while this step awaited). */
function current(id: string, p: Promotion): Promotion | null {
  const now = promotion(id);
  return now?.txn === p.txn && now.action === p.action ? now : null;
}

const what = (p: Promotion, start = false): string =>
  p.action === 'apply' ? `${start ? 'A' : 'a'} tested mod update` : `${start ? 'An' : 'an'} undo of the last mod change`;

/** Players online from RCON `list`. Without RCON, Crafty's count can only
    say someone is on (it lags about 30 s, so its 0 is not proof); null when
    nobody can say. */
async function countPlayers(id: string): Promise<number | null> {
  try {
    const m = /There are (\d+)/i.exec(await rconCommand(id, 'list', { timeout: 5000 }));
    if (m) return parseInt(m[1], 10);
  } catch { /* RCON off: ask Crafty */ }
  try {
    const n = (await craftyApi.getStats(id)).online;
    return typeof n === 'number' && n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function say(id: string, text: string): Promise<void> {
  await rconCommand(id, `tellraw @a [{"text":"[Spawnpoint] ","color":"aqua"},{"text":${JSON.stringify(text)},"color":"yellow"}]`).catch(() => {});
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function restart(id: string, p0: Promotion, log: (m: string) => void, countdown: boolean): Promise<void> {
  if (beginMaintenance(id, OP)) return; // another operation got there first: next poll
  // claimed in the same step as this re-check, so nothing can slip in between
  let p = current(id, p0);
  if (!p || !stillWaiting(id, p) || listPending(id).length) return release(id, p0);
  if (countdown) {
    // claimed before the first wait: discard, cancel and installs refuse from here
    p = save(id, { ...p, stage: 'countdown' });
    await say(id, `Restarting in 30 seconds to load ${what(p)}. You can rejoin right after.`);
    await pause(20_000);
    await say(id, 'Restarting in 10 seconds.');
    await pause(10_000);
  }
  await goLive(id, save(id, { ...p, stage: 'stopping' }), log);
}

/** Stop the server, make the change, start it and check the boot. */
async function goLive(id: string, p: Promotion, log: (m: string) => void): Promise<void> {
  log(`promote: restarting ${id} to ${p.action} ${p.txn}`);
  if ((await isRunningSafe(id)) && !(await stopAndWait(id))) {
    log(`promote: ${id} would not stop; trying again later`);
    return release(id, p);
  }
  const outcome = await execute(id, p, log);
  if (outcome === 'stuck') {
    return strand(id, `the ${p.action === 'apply' ? 'mod change' : 'undo'} moved only some files and could not put them back; restarting the panel finishes that`, log);
  }
  if (outcome === 'unchanged') {
    // dropped, not retried: retrying would restart the server every poll
    log(`promote: the ${p.action} on ${id} did not go in; starting the server as it was`);
    await craftyApi.action(id, 'start_server').catch(() => {});
    markRunning(id, true);
    if (current(id, p)) rmSync(file(id), { force: true });
    return release(id, p);
  }
  await bootAndVerify(id, save(id, { ...p, stage: 'applied' }), log);
}

/** Make the change while the server is stopped. The outcome is read from
    disk, not from whether a call threw. */
async function execute(id: string, p: Promotion, log: (m: string) => void): Promise<'done' | 'unchanged' | 'stuck'> {
  try {
    if (p.action === 'apply') await applyReady(id, p.txn, log);
    else await undoLast(id, log, p.txn);
  } catch (e) {
    log(`promote: ${p.action} on ${id} failed: ${String(e).slice(0, 200)}`);
  }
  if (p.action === 'apply') {
    const c = candidate(id);
    if (c?.txn !== p.txn) return 'unchanged';
    return c.status === 'applied' ? 'done' : c.status === 'activating' ? 'stuck' : 'unchanged';
  }
  const s = changeState(id, p.txn);
  return s === 'undone' ? 'done' : s === 'undoing' ? 'stuck' : 'unchanged';
}

/** The change is in: start the server (unless it already runs), and keep the
    change only if it boots. */
async function bootAndVerify(id: string, p: Promotion, log: (m: string) => void): Promise<void> {
  // repeated on purpose: a panel restart between the commit and its cleanup
  // (stage stopping or applied) must not boot on a stale friends' pack
  await afterCommit(id, log);
  if (!(await isUp(id))) {
    p = save(id, { ...p, startedAt: Date.now() });
    await craftyApi.action(id, 'start_server').catch(() => {});
  }
  markRunning(id, true);
  const since = p.startedAt ?? 0;
  if (!(await waitForReady(id, READY_TIMEOUT_S, since))) {
    if (p.action === 'undo') {
      log(`promote: ${id} did not come up after the undo; leaving it for the owner`);
      return release(id, p);
    }
    const why = await lastError(id);
    return rollBack(id, p, `the server did not start with this change (${why})`, log);
  }
  const c = candidate(id);
  const pack = await packCheck(id, since, p.action === 'apply' ? c?.pack : undefined);
  if (p.action === 'apply' && pack?.failed && !c?.approved) {
    // the join test proved this exact pack; anything else, or no proof, is untested for friends
    return rollBack(id, p, pack.note, log);
  }
  if (p.action === 'apply') noteLive(id, p.txn, 'applied', `tested and applied; the server restarted with it${pack ? `. ${pack.note}` : ''}`);
  if (pack) log(`promote: ${id}: ${pack.note}`);
  log(`promote: ${p.action} ${p.txn} is live on ${id}`);
  release(id, p);
}

/** The applied change must not stay: undo exactly it, start the server
    without it, and record why. Saved as a stage first, so a panel restart
    part-way finishes the rollback instead of re-judging the boot. */
async function rollBack(id: string, p: Promotion, why: string, log: (m: string) => void): Promise<void> {
  if (p.stage !== 'rollback') p = save(id, { ...p, stage: 'rollback', reason: why });
  log(`promote: undoing ${p.txn} on ${id}: ${why}`);
  if (changeState(id, p.txn) !== 'undone') {
    if ((await isRunningSafe(id)) && !(await stopAndWait(id))) {
      return strand(id, `${why}, and the server would not stop, so the change is still in`, log);
    }
    try {
      const r = await undoLast(id, log, p.txn);
      if (r.waiting || r.txn !== p.txn || !r.undone) throw new Error('the undo did not run');
    } catch (e) {
      return strand(id, `${why}, and undoing it failed: ${String(e).slice(0, 120)}`, log);
    }
  } else {
    // undone before a panel restart, maybe before the friends' pack was rebuilt
    await afterCommit(id, log);
  }
  liveBootFailed(id, p.txn, `${why}, so it was undone and the server started without it`);
  if (!(await isUp(id))) {
    const restartedAt = Date.now();
    await craftyApi.action(id, 'start_server').catch(() => {});
    await waitForReady(id, READY_TIMEOUT_S, restartedAt);
  }
  release(id, p);
}

async function lastError(id: string): Promise<string> {
  try {
    const lines = (await craftyApi.getLogs(id)).filter((l) => !/^\s*at /.test(l)); // no stack frames
    // the loader's own explanation first ("- Mod 'X' requires ..."), then the root cause
    const last = (re: RegExp): string | undefined => lines.filter((l) => re.test(l)).slice(-1)[0];
    const bad = last(/^\s*- Mod '/) ?? last(/Caused by:|ERROR\]/);
    return (bad ?? 'it did not finish starting').replace(/^\s*(\[[^\]]*\]\s*)*(- )?/, '').slice(0, 200);
  } catch {
    return 'it did not finish starting';
  }
}

/** null when the pack AutoModpack built at the start at `since` matches
    `tested` (pack path to SHA-1; default: the client files on disk). Else
    what differs, or why it could not be checked; both fail the check. */
export async function packCheck(id: string, since = 0, tested?: Record<string, string>): Promise<{ note: string; failed: true } | null> {
  if (!autoModpackActive(id)) return null;
  const manifest = join(serverDir(id), 'automodpack', 'host-modpack', 'automodpack-content.json');
  const fresh = (): boolean => existsSync(manifest) && statSync(manifest).mtimeMs >= since;
  // AutoModpack writes the manifest while the server starts; wait for this start's
  for (let i = 0; i < 12 && !fresh(); i++) await pause(5000);
  let served: Map<string, string>;
  try {
    if (!fresh()) throw new Error('stale');
    const content = JSON.parse(readFileSync(manifest, 'utf8')) as { list: { file: string; sha1: string }[] };
    served = new Map(content.list.map((e) => [e.file, e.sha1]));
  } catch {
    return { note: 'AutoModpack did not rebuild the friends\' pack when the server started (is generateModpackOnStart off?), so friends would not get exactly the tested files', failed: true };
  }
  const expected = new Map(Object.entries(tested ?? Object.fromEntries(candidateSet(id, { files: [] }).client
    // friends install AutoModpack itself from the starter pack; it never lists itself
    .filter((f) => !/^mods\/automodpack[^/]*\.jar$/i.test(f.rel))
    .map((f) => [`/${f.rel}`, createHash('sha1').update(readFileSync(f.src)).digest('hex')]))));
  const extra = [...served.keys()].filter((k) => !expected.has(k));
  const missing = [...expected.keys()].filter((k) => !served.has(k));
  const changed = [...expected.keys()].filter((k) => served.has(k) && served.get(k) !== expected.get(k));
  const parts = [
    extra.length && `serves untested files: ${extra.join(', ')}`,
    missing.length && `leaves out: ${missing.join(', ')}`,
    changed.length && `serves different bytes for: ${changed.join(', ')}`,
  ].filter(Boolean);
  return parts.length ? { note: `AutoModpack's pack differs from the tested set (${parts.join('; ')})`, failed: true } : null;
}

/** Done with this restart: hand the server back. A change that still waits
    (the stop failed, or it did not go in) waits for the next moment; a record
    cancelled or replaced meanwhile is left as it is. */
function release(id: string, p: Promotion): void {
  endMaintenance(id, OP);
  seen.delete(id);
  emptyPolls.delete(id);
  const now = current(id, p);
  if (!now) return;
  if (stillWaiting(id, now)) save(id, { action: now.action, txn: now.txn, choice: now.choice, since: now.since });
  else rmSync(file(id), { force: true });
}

/** The restart could not finish safely: the server stays fenced (and
    stopped) until the owner has looked. */
function strand(id: string, why: string, log: (m: string) => void): void {
  log(`promote: ${id}: ${why}`);
  strandMaintenance(id, OP, why);
  rmSync(file(id), { force: true });
  seen.delete(id);
  emptyPolls.delete(id);
}
