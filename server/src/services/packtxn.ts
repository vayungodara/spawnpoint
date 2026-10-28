import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { PATHS } from '../config.js';
import { serverDir, clientShelfDir } from './servers.js';
import { chownToDirOwner, moveFile, writeFileAtomic } from './platform.js';
import { ledgerEntries, updateLedger, type LedgerEntry } from './ledger.js';
import { dryBoot, type Verdict } from './preflight.js';
import { scanJars, isServerOnly } from './jardeps.js';
import { autoModpackActive, extrasDir, publishPack } from './automodpack.js';
import { clientGate, type ClientSet } from './launchgate.js';

// PACK TRANSACTIONS. A mod change never touches a live folder until it has
// passed its tests. Installs download into one candidate per server
// (data/candidates/<id>/). Twelve seconds after the last install, the whole
// candidate is boot-tested with the server's own loader and, on AutoModpack
// servers, with a real client. Only a candidate that passed moves into mods/
// and the client shelf; the files it replaces move to data/revisions/<id>/.
// A failed candidate is deleted, so every existing file stays as it was.

export interface StagedFile {
  file: string;
  to: 'mods' | 'shelf';
  /** a live file this one supersedes (an older version of the same mod) */
  replaces?: string;
  /** ledger record to write on apply; absent for hand-uploaded jars */
  entry?: LedgerEntry;
}

export type CandidateStatus = 'collecting' | 'testing' | 'needs-approval' | 'activating' | 'applied' | 'rejected';

export interface Candidate {
  txn: string;
  status: CandidateStatus;
  detail: string;
  files: StagedFile[];
  server?: Verdict;
  client?: Verdict;
  /** while activating: the journal that lets a crash or failure be undone */
  journal?: Journal;
  updatedAt: string;
}

/** Planned [from, to] moves, how many may have started, and the ledger
    before them. `started` is persisted before each move, so recovery reverses
    exactly the moves that can have happened and never touches the others. */
interface Journal {
  moves: [string, string][];
  started: number;
  ledgerBefore: LedgerEntry[];
}

const QUIET_MS = 12_000;
const KEEP_REVISIONS = 5;
const root = (id: string): string => join(PATHS.data, 'candidates', id);
const filesDir = (id: string): string => join(root(id), 'files');
const isOpen = (c: Candidate | null): c is Candidate =>
  !!c && (c.status === 'collecting' || c.status === 'testing' || c.status === 'needs-approval');
/** Delete this candidate's staged files (never the whole folder: an install may be mid-download into it). */
const dropFiles = (id: string, c: Candidate): void => {
  for (const f of c.files) rmSync(join(filesDir(id), f.file), { force: true });
};

export function candidate(id: string): Candidate | null {
  try { return JSON.parse(readFileSync(join(root(id), 'candidate.json'), 'utf8')) as Candidate; } catch { return null; }
}

function save(id: string, c: Candidate): Candidate {
  c.updatedAt = new Date().toISOString();
  writeFileAtomic(join(root(id), 'candidate.json'), JSON.stringify(c, null, 2));
  return c;
}

/** Where an install downloads a file that will join this server's candidate. */
export function stagingPath(id: string, file: string): string {
  mkdirSync(filesDir(id), { recursive: true });
  return join(filesDir(id), basename(file));
}

/** Files already staged for this server (planning treats them as installed). */
export function stagedFiles(id: string): StagedFile[] {
  const c = candidate(id);
  return isOpen(c) ? c.files : [];
}

const timers = new Map<string, NodeJS.Timeout>();
/** the panel log, for tests started by changes that come without one */
let panelLog: (m: string) => void = () => {};
const generation = new Map<string, number>();
const waiters = new Map<string, (() => void)[]>();
let running = 0;

/** True while any candidate is waiting or under test (the panel should not restart). */
export function txnBusy(): boolean {
  return running > 0 || timers.size > 0;
}

/** Add downloaded files to this server's candidate and (re)start its quiet timer. */
export function stage(id: string, files: StagedFile[], log: (m: string) => void): Candidate {
  assertNoRecovery(id);
  const prev = candidate(id);
  const c: Candidate = isOpen(prev) ? prev : { txn: new Date().toISOString().replace(/[:.]/g, '-'), status: 'collecting', detail: '', files: [], updatedAt: '' };
  for (const f of files) {
    for (const old of c.files.filter((x) => x.file === f.file || (f.entry && x.entry?.projectId === f.entry.projectId))) {
      if (old.file !== f.file) rmSync(join(filesDir(id), old.file), { force: true });
      // a staged update of a staged mod replaces what the first one replaced
      if (!f.replaces || f.replaces === old.file) f.replaces = old.replaces;
    }
    c.files = c.files.filter((x) => x.file !== f.file && !(f.entry && x.entry?.projectId === f.entry.projectId)).concat(f);
  }
  generation.set(id, (generation.get(id) ?? 0) + 1);
  if (c.status !== 'testing') {
    c.status = 'collecting';
    c.detail = 'waiting a few seconds for more changes, then boot-testing';
    arm(id, log);
  }
  return save(id, c);
}

function arm(id: string, log: (m: string) => void): void {
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => { timers.delete(id); void run(id, log); }, QUIET_MS));
}

/** Apply a candidate whose tests could not run, on the owner's say-so. */
export async function approve(id: string, log: (m: string) => void): Promise<Candidate | null> {
  const c = candidate(id);
  if (!c || c.status !== 'needs-approval') return c;
  return activate(id, c, log, true);
}

/** Test a candidate waiting for approval again, after the owner fixed what
    kept a test from running. */
export function retest(id: string, log: (m: string) => void): void {
  const c = candidate(id);
  if (c?.status !== 'needs-approval') return;
  save(id, { ...c, status: 'collecting', detail: 'testing again in a few seconds' });
  arm(id, log);
}

/** Refuse to write while an apply or undo is unfinished: its journal must
    roll back against the files it recorded. */
export function assertNoRecovery(id: string): void {
  const dir = revisionsDir(id);
  const undoing = existsSync(dir) && readdirSync(dir).some((txn) => readManifest(join(dir, txn))?.undoing);
  if (candidate(id)?.status === 'activating' || undoing) {
    throw new Error('the last mod change is still being applied or undone; try again in a moment, or restart the panel to finish it');
  }
}

/** Staged bytes are about to change: a running test must not pass on the old ones. */
export function invalidate(id: string): void {
  generation.set(id, (generation.get(id) ?? 0) + 1);
}

/** The live mods changed (a delete or toggle): any verdict on an open
    candidate is stale. A running test starts over; a waiting one is retested. */
export function liveChanged(id: string, log: (m: string) => void = panelLog): void {
  generation.set(id, (generation.get(id) ?? 0) + 1);
  retest(id, log);
}

/** Throw away an open candidate. Live files were never touched. */
export function discard(id: string): void {
  clearTimeout(timers.get(id));
  timers.delete(id);
  const c = candidate(id);
  if (!isOpen(c) || c.status === 'testing') return;
  dropFiles(id, c);
  save(id, { ...c, status: 'rejected', detail: 'discarded', files: c.files });
}

/** Resolves once this server's candidate is applied, rejected or waiting for approval. */
export function settled(id: string): Promise<Candidate | null> {
  const c = candidate(id);
  if (!c || (c.status !== 'collecting' && c.status !== 'testing')) return Promise.resolve(c);
  return new Promise((resolve) => waiters.set(id, [...(waiters.get(id) ?? []), () => resolve(candidate(id))]));
}

/** Pick up work a panel restart interrupted. An activation or undo cut short
    is reversed move by move and its ledger restored, so the live folders are
    as they were before it started. */
export function resumeCandidates(log: (m: string) => void): void {
  panelLog = log;
  const revs = join(PATHS.data, 'revisions');
  for (const id of existsSync(revs) ? readdirSync(revs) : []) {
    for (const txn of readdirSync(join(revs, id))) {
      const m = readManifest(join(revs, id, txn));
      if (!m?.undoing) continue;
      try {
        rollBackUndo(id, join(revs, id, txn));
        log(`packtxn: reversed an interrupted undo on ${id}`);
      } catch (e) {
        log(`packtxn: could not reverse the interrupted undo on ${id} (${String(e)}); retrying on the next start`);
      }
    }
  }
  const dir = join(PATHS.data, 'candidates');
  if (!existsSync(dir)) return;
  for (const id of readdirSync(dir)) {
    const c = candidate(id);
    if (c?.status === 'activating') {
      try {
        rollBackActivation(id, 'the panel stopped while applying this change, so it was undone; apply it again');
        log(`packtxn: undid an interrupted activation on ${id}`);
      } catch (e) {
        log(`packtxn: could not undo the interrupted activation on ${id} (${String(e)}); retrying on the next start`);
      }
    } else if (c?.status === 'collecting' || c?.status === 'testing') {
      save(id, { ...c, status: 'collecting' });
      arm(id, log);
    }
  }
}

/** The jars the server would run and the files a client would receive with this candidate applied. */
export function candidateSet(id: string, c: Pick<Candidate, 'files'>): { serverJars: string[]; client: ClientSet['files'] } {
  const modsDir = join(serverDir(id), 'mods');
  const shelfDir = clientShelfDir(id);
  const list = (dir: string): Map<string, string> =>
    new Map(existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jar')).map((f) => [f, join(dir, f)]) : []);
  const server = list(modsDir);
  const shelf = list(shelfDir);
  for (const f of c.files) {
    for (const gone of [f.replaces, f.file]) if (gone) { server.delete(gone); shelf.delete(gone); }
    (f.to === 'mods' ? server : shelf).set(f.file, join(filesDir(id), f.file));
  }
  const client: ClientSet['files'] = [];
  for (const [name, path] of [...server, ...shelf]) {
    if (server.has(name) && isServerOnly(path)) continue;
    client.push({ src: path, rel: `mods/${name}` });
  }
  // hand-placed extras (configs, resource packs) ship too; bridged shelf copies are replaced by the shelf above
  const extras = extrasDir(id);
  let bridged: string[] = [];
  try { bridged = JSON.parse(readFileSync(join(serverDir(id), 'automodpack', '.spawnpoint-bridged.json'), 'utf8')) as string[]; } catch { /* none */ }
  const walk = (dir: string, rel: string): void => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else if (!(rel === 'mods' && (bridged.includes(e.name) || shelf.has(e.name)))) client.push({ src: join(dir, e.name), rel: r });
    }
  };
  walk(extras, '');
  return { serverJars: [...server.values()], client };
}

async function run(id: string, log: (m: string) => void): Promise<void> {
  let c = candidate(id);
  if (!c || c.status !== 'collecting') return;
  running++;
  const healed = new Set<string>();
  const status = (detail: string): void => { c = save(id, { ...candidate(id)!, status: 'testing', detail }); };
  try {
    for (let round = 0; round < 6; round++) {
      const gen = generation.get(id) ?? 0;
      status('checking declared dependencies');
      let set = candidateSet(id, c);

      const missing = scanJars(set.serverJars).missing.filter((m) => !healed.has(m));
      if (missing.length && missing.length <= 6) {
        missing.forEach((m) => healed.add(m));
        status(`installing missing dependencies: ${missing.join(', ')}`);
        if ((await healMissing(id, missing)).length) continue;
      }

      status('boot-testing the server with this change');
      // every verdict below is only acted on if nothing changed meanwhile
      const stale = (): boolean => (generation.get(id) ?? 0) !== gen;
      const server = await dryBoot(id, set.serverJars);
      if (server.result === 'failed') {
        if (stale()) continue;
        // the loader names missing mod ids: install them and test again
        const named = missingFromExcerpt(server.excerpt ?? []).filter((m) => !healed.has(m));
        if (named.length && named.length <= 4) {
          named.forEach((m) => healed.add(m));
          status(`installing missing dependencies: ${named.join(', ')}`);
          if ((await healMissing(id, named)).length) continue;
        }
        // a client-only mod staged for mods/ crashes the server environment:
        // send it to the client shelf and test again
        if (rerouteClientOnly(id, server.excerpt ?? [])) continue;
        // blame the change only if the server boots without it, and the
        // failure repeats (some mods race at startup and fail at random)
        status('the server test failed; testing the current mods without this change');
        const before = await dryBoot(id, candidateSet(id, { files: [] }).serverJars);
        const again = before.result === 'passed' ? await dryBoot(id, set.serverJars) : before;
        if (stale()) continue;
        if (before.result === 'passed' && again.result === 'failed') return reject(id, server, undefined, log);
        const why = before.result !== 'passed'
          ? `the server does not boot without this change either: ${before.detail}`
          : 'the server boots unreliably with this change (it failed once, then passed)';
        return wait(id, { server: { ...(before.result === 'failed' ? before : server), detail: why } }, why, log);
      }

      // every change reaches the players' side of a join, so AutoModpack
      // servers test it with a real client
      let client: Verdict | undefined;
      if (autoModpackActive(id)) {
        set = candidateSet(id, candidate(id)!);
        const changed = candidate(id)!.files.map((f) => f.file);
        client = await clientGate(id, { files: set.client, serverJars: set.serverJars, label: 'candidate', changed }, status, log);
        if (client.result === 'failed') {
          if (stale()) continue;
          // blame the change only if the pack without it passes and the
          // failure repeats (mixin-heavy packs can crash at random)
          status('the client test failed; testing the current pack without this change');
          const live = candidateSet(id, { files: [] });
          const before = await clientGate(id, { files: live.client, serverJars: live.serverJars, label: 'live', changed: [] }, status, log);
          if (before.result === 'passed') status('the current pack passed; testing this change once more');
          const again = before.result === 'passed' ? await clientGate(id, { files: set.client, serverJars: set.serverJars, label: 'candidate', changed }, status, log) : before;
          if (stale()) continue;
          if (before.result === 'passed' && again.result === 'failed') return reject(id, server, again, log);
          // what the owner needs is what applying it would do: keep the candidate's own crash
          client = { ...client, result: 'unverified', detail: before.result !== 'passed'
            ? `the client fails without this change too (with it, ${client.detail})`
            : `the client test is unreliable with this change (it failed once, then passed: ${client.detail})` };
        }
      }
      if (stale()) continue; // more files arrived mid-test: test the new set

      if (server.result === 'unverified' || client?.result === 'unverified') {
        const why = [server, client].filter((v) => v?.result === 'unverified').map((v) => v!.detail).join('; ');
        return wait(id, { server, client }, why, log);
      }
      await activate(id, { ...candidate(id)!, server, client }, log);
      return;
    }
    wait(id, {}, 'the change kept growing while it was tested', log);
  } catch (e) {
    // an activation that could not roll itself back keeps its journal for the next start
    const now = candidate(id)?.status;
    if (now === 'testing' || now === 'collecting') wait(id, {}, `the test itself failed (${String(e).slice(0, 160)})`, log);
    else log(`packtxn: ${id}: ${String(e)}${now === 'activating' ? '; the change is rolled back on the next start' : ''}`);
  } finally {
    running--;
    for (const w of waiters.get(id) ?? []) w();
    waiters.delete(id);
  }
}

/** Park a candidate for the owner: apply anyway, test again or discard. */
function wait(id: string, verdicts: Pick<Candidate, 'server' | 'client'>, why: string, log: (m: string) => void): void {
  save(id, { ...candidate(id)!, ...verdicts, status: 'needs-approval', detail: `not tested: ${why}` });
  log(`packtxn: ${id} needs approval (${why})`);
}

function missingFromExcerpt(excerpt: string[]): string[] {
  return [...new Set(excerpt.flatMap((l) => [
    ...[...l.matchAll(/Mod ID: '([a-z0-9_.-]+)'/gi)].map((m) => m[1]), // forge / neoforge
    ...[...l.matchAll(/Install ([a-z0-9_.-]+),/gi)].map((m) => m[1]), // fabric: "Install x, any version"
  ]))].filter((m) => !/^(minecraft|forge|neoforge|fabricloader|java)$/.test(m));
}

/** Mod ids are usually Modrinth slugs, not always ('farmersdelight' vs
    'farmers-delight'): try the id, a dashed variant, then a search hit whose
    slug or title matches exactly once separators are stripped. */
async function healMissing(id: string, modIds: string[]): Promise<string[]> {
  const { install } = await import('./installer.js');
  const { search } = await import('../clients/modrinth.js');
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const healed: string[] = [];
  for (const modId of modIds) {
    const tries = modId === 'fabric' ? ['fabric-api'] : [...new Set([modId, modId.replace(/_/g, '-')])]; // "fabric" is Fabric API's legacy id
    const hit = (await search({ query: modId, type: 'mod', limit: 8 }).catch(() => ({ hits: [] }))).hits
      .find((h) => norm(h.slug) === norm(modId) || norm(h.title) === norm(modId));
    if (hit) tries.push(hit.project_id);
    for (const projectId of tries) {
      const r = await install(id, { projectId, type: 'mod' }).catch(() => null);
      if (r && 'installed' in r && r.installed.length) { healed.push(...r.installed.map((i) => i.file)); break; }
    }
  }
  return healed;
}

/** Fabric names the mod whose mixin fails "in environment type SERVER": if it
    is a staged mods/ file, it belongs on the client shelf. */
function rerouteClientOnly(id: string, excerpt: string[]): boolean {
  if (!excerpt.some((l) => /in environment type SERVER/i.test(l))) return false;
  const ids = new Set(excerpt.flatMap((l) => [...l.matchAll(/from mod ([a-z0-9_-]+)\]/gi)].map((m) => m[1].toLowerCase())));
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const c = candidate(id)!;
  let moved = false;
  for (const f of c.files) {
    if (f.to === 'mods' && [...ids].some((m) => norm(f.file).includes(norm(m)))) {
      f.to = 'shelf';
      if (f.entry) f.entry.clientOnly = true;
      moved = true;
    }
  }
  if (moved) save(id, c);
  return moved;
}

function reject(id: string, server: Verdict, client: Verdict | undefined, log: (m: string) => void): void {
  const c = candidate(id)!;
  const failed = client?.result === 'failed' ? client : server;
  dropFiles(id, c);
  save(id, { ...c, status: 'rejected', server, client, detail: `${client?.result === 'failed' ? 'client test' : 'server test'} failed: ${failed.detail}` });
  recordRejection(id, c.files.map((f) => f.file), failed.excerpt?.length ? failed.excerpt.slice(0, 5) : [failed.detail]);
  log(`packtxn: REJECTED ${c.files.map((f) => f.file).join(', ')} on ${id}: ${failed.detail}`);
}

/** Reverse the moves that may have started, newest first, persisting
    progress after each so a crash part-way resumes where it stopped. A
    cross-device move (copy, then delete) cut short leaves both copies; the
    source is then the complete one. */
function reverseMoves(j: Journal, persist: (j: Journal) => void): void {
  for (let i = j.started - 1; i >= 0; i--) {
    const [from, to] = j.moves[i];
    if (existsSync(to)) {
      if (existsSync(from)) rmSync(to, { force: true });
      else moveFile(to, from);
    }
    j = { ...j, started: i };
    persist(j);
  }
}

/** Run the planned moves, persisting `started` before each one. */
function runMoves(j: Journal, persist: (j: Journal) => void): void {
  for (let i = 0; i < j.moves.length; i++) {
    const [from, to] = j.moves[i];
    persist({ ...j, started: i + 1 });
    mkdirSync(dirname(to), { recursive: true });
    moveFile(from, to);
  }
}

/** Undo an activation from its persisted journal: files, ledger, manifest. */
function rollBackActivation(id: string, detail: string): void {
  const c = candidate(id)!;
  if (c.journal) {
    reverseMoves(c.journal, (journal) => save(id, { ...c, journal }));
    updateLedger(id, () => c.journal!.ledgerBefore);
  }
  rmSync(join(revisionsDir(id), c.txn, 'revision.json'), { force: true });
  save(id, { ...candidate(id)!, journal: undefined, status: 'needs-approval', detail });
}

/** Reverse an undo cut short, from the journal in its manifest. */
function rollBackUndo(id: string, dir: string): void {
  const m = readManifest(dir)!;
  reverseMoves(m.undoing!, (undoing) => writeManifest(dir, { ...m, undoing }));
  updateLedger(id, () => m.undoing!.ledgerBefore);
  writeManifest(dir, { ...m, undoing: undefined });
}

// One live-folder writer per server at a time: activations, undos and version switches.
const locks = new Map<string, Promise<unknown>>();
export function exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(id) ?? Promise.resolve()).then(fn, fn);
  locks.set(id, run.catch(() => {}));
  return run;
}

/** Move a tested candidate into the live folders. Every move is journaled
    in the candidate first, so a crash part-way is undone on the next start
    (resumeCandidates). Everything up to 'applied' is synchronous, so no
    install can join the candidate while it is being applied. */
function activate(id: string, c: Candidate, log: (m: string) => void, approved = false): Promise<Candidate> {
  const gen = generation.get(id) ?? 0;
  return exclusive(id, async () => {
    // a second approval queued behind the first finds it already applied
    const now = candidate(id);
    if (now?.txn !== c.txn || now.status !== c.status) return now!;
    // the candidate changed while this waited: test again
    if ((generation.get(id) ?? 0) !== gen) {
      arm(id, log);
      return save(id, { ...candidate(id)!, status: 'collecting', detail: 'the change grew while it waited; testing again' });
    }
    const modsDir = join(serverDir(id), 'mods');
    const shelfDir = clientShelfDir(id);
    const rev = join(PATHS.data, 'revisions', id, c.txn);
    const moves: [string, string][] = [];
    const replaced = new Set<string>();
    for (const f of c.files) {
      for (const victim of new Set([f.replaces, f.file])) {
        if (!victim) continue;
        for (const dir of [modsDir, shelfDir]) {
          if (existsSync(join(dir, victim))) { moves.push([join(dir, victim), join(rev, victim)]); replaced.add(victim); }
        }
      }
      moves.push([join(filesDir(id), f.file), join(f.to === 'mods' ? modsDir : shelfDir, f.file)]);
    }
    const journal: Journal = { moves, started: 0, ledgerBefore: ledgerEntries(id) };
    save(id, { ...c, status: 'activating', journal });
    try {
      runMoves(journal, (j) => save(id, { ...c, status: 'activating', journal: j }));
      const added = new Set(c.files.map((f) => f.file));
      // what undo needs: the files this change added and the ledger rows of what it replaced
      const manifest: RevisionManifest = {
        txn: c.txn, at: new Date().toISOString(),
        added: c.files.map((f) => ({ file: f.file, to: f.to })),
        replaced: moves.filter(([, to]) => to.startsWith(rev)).map(([from]) => ({ file: basename(from), to: from.startsWith(modsDir) ? 'mods' : 'shelf' })),
        ledger: ledgerEntries(id).filter((e) => replaced.has(e.file)),
      };
      writeManifest(rev, manifest);
      updateLedger(id, (entries) => entries
        .filter((e) => !replaced.has(e.file) && !added.has(e.file))
        .concat(c.files.flatMap((f) => (f.entry ? [{ ...f.entry, clientOnly: f.to === 'shelf' || undefined }] : []))));
    } catch (e) {
      // if the rollback itself fails, the journal stays and the next start finishes it
      rollBackActivation(id, `the files could not be moved (${String(e).slice(0, 100)}); stop the server and apply again`);
      return candidate(id)!;
    }
    const verdict = approved ? 'applied on your approval without a full test' : 'tested and applied';
    const applied = save(id, { ...c, journal: undefined, status: 'applied', detail: `${verdict}; restart the server to load ${c.files.length === 1 ? 'it' : 'them'}` });
    log(`packtxn: applied ${c.files.map((f) => f.file).join(', ')} on ${id}`);
    await afterCommit(id, log);
    return applied;
  });
}

interface RevisionManifest {
  txn: string;
  at: string;
  added: { file: string; to: 'mods' | 'shelf' }[];
  replaced: { file: string; to: 'mods' | 'shelf' }[];
  ledger: LedgerEntry[];
  undone?: string;
  /** while undoing: the journal that lets a crash or failure be reversed */
  undoing?: Journal;
}

const revisionsDir = (id: string): string => join(PATHS.data, 'revisions', id);
function readManifest(dir: string): RevisionManifest | null {
  try { return JSON.parse(readFileSync(join(dir, 'revision.json'), 'utf8')) as RevisionManifest; } catch { return null; }
}
function writeManifest(dir: string, m: RevisionManifest): void {
  writeFileAtomic(join(dir, 'revision.json'), JSON.stringify(m, null, 1));
}

/** The newest applied mod change that can still be undone. */
export function lastChange(id: string): RevisionManifest | null {
  const dir = revisionsDir(id);
  const newest = existsSync(dir) ? readdirSync(dir).sort().reverse() : [];
  for (const name of newest) {
    const m = readManifest(join(dir, name));
    if (!m) return null; // a modpack import came after it: undo that from Backups
    if (!m.undone) return m;
  }
  return null;
}

/** Undo the newest applied mod change: its files leave, the files it
    replaced come back. This restores the pack that was live before it, so
    it is not tested again. */
export function undoLast(id: string, log: (m: string) => void): Promise<RevisionManifest> {
  return exclusive(id, async () => {
    assertNoRecovery(id);
    if (stagedFiles(id).length) throw new Error('a mod change is waiting or being tested; finish or discard it first');
    const m = lastChange(id);
    if (!m) throw new Error('there is no mod change to undo');
    const dirOf = (to: 'mods' | 'shelf'): string => (to === 'mods' ? join(serverDir(id), 'mods') : clientShelfDir(id));
    const rev = join(revisionsDir(id), m.txn);
    const gone = m.added.filter((f) => !existsSync(join(dirOf(f.to), f.file)));
    if (gone.length) throw new Error(`${gone.map((f) => f.file).join(', ')} changed since; undo by hand from data/revisions/${id}/${m.txn}`);
    const moves: [string, string][] = [
      ...m.added.map((f): [string, string] => [join(dirOf(f.to), f.file), join(rev, 'undone', f.file)]),
      ...m.replaced.map((f): [string, string] => [join(rev, f.file), join(dirOf(f.to), f.file)]),
    ];
    // journaled like an activation: everything up to the final manifest
    // write is synchronous, and resumeCandidates reverses a crash part-way
    const journal: Journal = { moves, started: 0, ledgerBefore: ledgerEntries(id) };
    writeManifest(rev, { ...m, undoing: journal });
    const undone = { ...m, undone: new Date().toISOString() };
    try {
      runMoves(journal, (j) => writeManifest(rev, { ...m, undoing: j }));
      const added = new Set(m.added.map((f) => f.file));
      updateLedger(id, (entries) => entries.filter((e) => !added.has(e.file)).concat(m.ledger));
      writeManifest(rev, undone);
    } catch (e) {
      rollBackUndo(id, rev); // if this throws too, the next start finishes it
      throw new Error(`could not move the files back (${String(e).slice(0, 100)}); stop the server and try again`);
    }
    // the "applied" banner for this change would now be wrong
    const c = candidate(id);
    if (c?.txn === m.txn && c.status === 'applied') save(id, { ...c, status: 'rejected', detail: 'undone' });
    log(`packtxn: undid ${m.added.map((f) => f.file).join(', ')} on ${id}`);
    await afterCommit(id, log);
    return undone;
  });
}

/** Housekeeping once a change is final. Its failure is logged; it never
    reopens the change. */
async function afterCommit(id: string, log: (m: string) => void): Promise<void> {
  try {
    pruneRevisions(id);
    await chownToDirOwner(join(serverDir(id), 'mods'));
    await publishPack(id, log);
  } catch (e) {
    log(`packtxn: cleanup after a change on ${id} failed: ${String(e)}`);
  }
}

export function pruneRevisions(id: string): void {
  const dir = join(PATHS.data, 'revisions', id);
  if (!existsSync(dir)) return;
  for (const old of readdirSync(dir).sort().slice(0, -KEEP_REVISIONS)) rmSync(join(dir, old), { recursive: true, force: true });
}

// ---- Rejection history: shown on the Content page so a change that was
// turned away is visible, not silently gone. Last 10 per server, 48 hours.
interface Rejection { at: string; jars: string[]; reason: string[] }
const rejectionsFile = (id: string): string => join(PATHS.data, 'preflight-rejections', `${id}.json`);

function recordRejection(id: string, jars: string[], reason: string[]): void {
  mkdirSync(join(PATHS.data, 'preflight-rejections'), { recursive: true });
  let list: Rejection[] = [];
  try { list = JSON.parse(readFileSync(rejectionsFile(id), 'utf8')) as Rejection[]; } catch { /* first */ }
  list.push({ at: new Date().toISOString(), jars, reason });
  writeFileSync(rejectionsFile(id), JSON.stringify(list.slice(-10), null, 1), 'utf8');
}

export function clearRejections(id: string): void {
  rmSync(rejectionsFile(id), { force: true });
}

export function recentRejections(id: string): Rejection[] {
  try {
    const list = JSON.parse(readFileSync(rejectionsFile(id), 'utf8')) as Rejection[];
    return list.filter((x) => Date.now() - new Date(x.at).getTime() < 48 * 3600_000);
  } catch {
    return [];
  }
}
