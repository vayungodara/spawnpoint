import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, basename, dirname } from 'node:path';
import { PATHS } from '../config.js';
import { serverDir, clientShelfDir } from './servers.js';
import { chownToDirOwner, moveFile, writeFileAtomic } from './platform.js';
import { ledgerEntries, updateLedger, type LedgerEntry } from './ledger.js';
import { dryBoot, type Verdict } from './preflight.js';
import { scanJars, isServerOnly } from './jardeps.js';
import { autoModpackActive, extrasDir, publishPack } from './automodpack.js';
import { clientGate, type ClientSet } from './launchgate.js';
import { isRunningSafe, busyReason } from './maintenance.js';
import { promotion, requestPromotion, restarting } from './promote.js';
import { detect } from './detect.js';
import { sealRevision, verifyRevision, revisionInputs, revisionMoves, withStoppedRevision, lockedPath, revisionDir, reportRevision, revisionReport, revisionState, setRevisionState, installLaunchGuard, writeLaunchGate, packPath, hashes, readLock, type RevisionInput } from './revisions.js';
import type { SolveInput, SolveResult } from './solver/index.js';

// PACK TRANSACTIONS. A mod change never touches a live folder until it has
// passed its tests. Installs download into one candidate per server
// (data/candidates/<id>/). Twelve seconds after the last install, the whole
// candidate is boot-tested with the server's own loader and, on AutoModpack
// servers, with a real client. Only a candidate that passed moves into mods/
// and the client shelf; the files it replaces move to data/revisions/<id>/.
// A failed candidate is deleted, so every existing file stays as it was.
// mods/ only changes while the server is stopped: a passed candidate for a
// running server becomes 'ready' and promote.ts restarts it in.

export interface StagedFile {
  file: string;
  to: 'mods' | 'shelf';
  /** A pack config edit, staged and tested rather than written live. */
  path?: string;
  /** Proposed removal; always needs owner consent before promotion. */
  remove?: boolean;
  /** Dependency-only removal proposed by the solver, not an owner exclusion. */
  automatic?: boolean;
  /** a live file this one supersedes (an older version of the same mod) */
  replaces?: string;
  /** ledger record to write on apply; absent for hand-uploaded jars */
  entry?: LedgerEntry;
}

export type CandidateStatus = 'collecting' | 'testing' | 'needs-approval' | 'ready' | 'activating' | 'applied' | 'rejected';

export interface Candidate {
  txn: string;
  status: CandidateStatus;
  detail: string;
  files: StagedFile[];
  server?: Verdict;
  client?: Verdict;
  /** while activating: the journal that lets a crash or failure be undone */
  journal?: Journal;
  /** applied on the owner's say-so without a full test */
  approved?: boolean;
  /** while 'ready' on an AutoModpack server: SHA-1 of every tested client
      file by pack path, to check the pack friends get after the restart */
  pack?: Record<string, string>;
  /** Exact immutable inputs used by this test attempt and its rollback. */
  revision?: string;
  baseline?: string;
  consent?: string[];
  solver?: SolveResult;
  /** Owner intent survives retests; staged dependency choices are not pins. */
  requests?: SolveInput['add'];
  updatedAt: string;
}

/** Planned [from, to] moves, how many may have started, and the ledger
    before them. `started` is persisted before each move, so recovery reverses
    exactly the moves that can have happened and never touches the others. */
interface Journal {
  moves: [string, string][];
  started: number;
  ledgerBefore: LedgerEntry[];
  activeBefore?: string;
}

const QUIET_MS = 12_000;
const KEEP_REVISIONS = 5;
const root = (id: string): string => join(PATHS.data, 'candidates', id);
const filesDir = (id: string): string => join(root(id), 'files');
/** Open candidates take more files; a 'ready' one is tested again with them. */
const isOpen = (c: Candidate | null): c is Candidate =>
  !!c && (c.status === 'collecting' || c.status === 'testing' || c.status === 'needs-approval' || c.status === 'ready');
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
export function stage(id: string, files: StagedFile[], log: (m: string) => void, planning?: Pick<Candidate, 'solver' | 'requests'> & { keep?: string[] }): Candidate {
  assertCanStage(id);
  const prev = candidate(id);
  const c: Candidate = isOpen(prev) ? prev : { txn: new Date().toISOString().replace(/[:.]/g, '-'), status: 'collecting', detail: '', files: [], updatedAt: '' };
  for (const f of files) {
    for (const old of c.files.filter((x) => x.file === f.file || (f.entry && x.entry?.projectId === f.entry.projectId))) {
      if (old.file !== f.file) rmSync(join(filesDir(id), old.file), { force: true });
      // a staged update of a staged mod replaces what the first one replaced
      if (!old.remove && (!f.replaces || f.replaces === old.file)) f.replaces = old.replaces;
    }
    c.files = c.files.filter((x) => x.file !== f.file && !(f.entry && x.entry?.projectId === f.entry.projectId)).concat(f);
  }
  if (planning?.keep) {
    for (const f of c.files) if (!planning.keep.includes(f.file)) rmSync(join(filesDir(id), f.file), { force: true });
    c.files = c.files.filter((f) => planning.keep!.includes(f.file));
  }
  generation.set(id, (generation.get(id) ?? 0) + 1);
  // an approval or a tested pack was for the files before this batch
  c.approved = undefined;
  c.pack = undefined;
  c.revision = undefined;
  c.consent = undefined;
  c.solver = planning?.solver ?? (files.some((f) => f.file.endsWith('.jar') || f.remove || f.replaces) ? undefined : c.solver);
  c.requests = planning?.requests ?? c.requests;
  if (c.status !== 'testing') {
    c.status = 'collecting';
    c.detail = 'waiting a few seconds for more changes, then boot-testing';
    arm(id, log);
  }
  return save(id, c);
}

/** Generated configs are only proposals: the final inventory is retested,
    and promotion requires separate explicit consent for every config edit. */
export function stageConfig(id: string, path: string, bytes: Buffer | null, log: (m: string) => void): Candidate {
  assertCanStage(id);
  packPath(path, 'server');
  if (!path.startsWith('config/')) throw new Error('only pack config/ edits can be staged; world config edits require a separate world operation');
  const file = `config-${createHash('sha256').update(path).digest('hex')}`;
  if (bytes) writeFileSync(stagingPath(id, file), bytes);
  return stage(id, [{ file, path, to: 'mods', remove: bytes === null }], log);
}

function arm(id: string, log: (m: string) => void): void {
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => { timers.delete(id); void run(id, log); }, QUIET_MS));
}

/** Apply a candidate whose tests could not run, on the owner's say-so. */
export async function approve(id: string, log: (m: string) => void, consent = false, expectedRevision?: string): Promise<Candidate | null> {
  const c = candidate(id);
  if (!c || c.status !== 'needs-approval') return c;
  if (!consent) throw new Error('explicit owner consent is required; review the test results and requested changes');
  if (!revisionState(id).managedHosting) {
    await installLaunchGuard(id);
    retest(id, log);
    return candidate(id);
  }
  if (!c.revision) throw new Error('no locked test attempt exists; test this change again');
  if (expectedRevision !== c.revision) throw new Error('the candidate changed since you reviewed it; reload and review the new revision');
  reportRevision(id, c.revision, { approved: { at: new Date().toISOString(), reasons: [...c.consent ?? [], c.detail] } });
  return activate(id, c, log, true);
}

/** Test a waiting candidate again: the owner fixed what kept a test from
    running, or the live mods it was tested against changed. A 'ready' one
    loses its place in the restart queue until it passes again. */
export function retest(id: string, log: (m: string) => void): void {
  const c = candidate(id);
  if (c?.status !== 'needs-approval' && c?.status !== 'ready') return;
  if (restarting(id)) return; // it is going in right now; mods are locked until then
  save(id, { ...c, status: 'collecting', detail: 'testing again in a few seconds', pack: undefined, approved: undefined, revision: undefined, consent: undefined });
  arm(id, log);
}

/** An apply or undo stopped part-way: its journal must roll back against
    the files it recorded before anything else writes. */
function recoveryPending(id: string): boolean {
  const dir = revisionsDir(id);
  return candidate(id)?.status === 'activating' || (existsSync(dir) && readdirSync(dir).some((txn) => readManifest(join(dir, txn))?.undoing));
}

/** Refuse to touch this server's mods while a change is half-applied or the
    panel is restarting the server to load one. */
export function assertModsWritable(id: string): void {
  if (recoveryPending(id)) throw new Error('the last mod change is still being applied or undone; try again in a moment, or restart the panel to finish it');
  if (restarting(id)) throw new Error('the server is restarting to load a mod change; try again in a minute');
}

/** Refuse a new install before its first byte is written: a refused batch
    must not replace bytes a waiting change was tested with. */
export function assertCanStage(id: string): void {
  assertModsWritable(id);
  if (promotion(id)?.action === 'undo') throw new Error('an undo is waiting for the server to restart; restart it or cancel the undo first');
}

/** Staged bytes are about to change: a running test must not pass on the old ones. */
export function invalidate(id: string): void {
  generation.set(id, (generation.get(id) ?? 0) + 1);
}

/** The live mods changed (a delete or toggle): any verdict on an open
    candidate is stale. A running test starts over; a waiting or ready one is
    retested. */
export function liveChanged(id: string, log: (m: string) => void = panelLog): void {
  generation.set(id, (generation.get(id) ?? 0) + 1);
  retest(id, log);
}

/** Throw away an open candidate. Live files were never touched. */
export function discard(id: string): void {
  if (restarting(id)) throw new Error('the server is restarting to load this change; it can be undone once it is up');
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
export async function resumeCandidates(log: (m: string) => void): Promise<void> {
  panelLog = log;
  const revs = join(PATHS.data, 'revisions');
  for (const id of existsSync(revs) ? readdirSync(revs) : []) {
    for (const txn of readdirSync(join(revs, id))) {
      const m = readManifest(join(revs, id, txn));
      if (!m?.undoing) continue;
      try {
        await withStoppedRevision(id, async () => {
          rollBackUndo(id, join(revs, id, txn));
          await afterCommit(id, log);
        });
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
        await withStoppedRevision(id, async () => {
          rollBackActivation(id, 'the panel stopped while applying this change, so it was undone; apply it again');
          await afterCommit(id, log);
        });
        log(`packtxn: undid an interrupted activation on ${id}`);
      } catch (e) {
        log(`packtxn: could not undo the interrupted activation on ${id} (${String(e)}); retrying on the next start`);
      }
    } else if (c?.status === 'collecting' || c?.status === 'testing') {
      save(id, { ...c, status: 'collecting' });
      arm(id, log);
    }
    // A crash after the journal committed but before releasing its OS fence
    // leaves only the start-blocking marker. Reverify before clearing it.
    if (existsSync(join(serverDir(id), '.spawnpoint-mutation')) && !recoveryPending(id)) {
      try { await withStoppedRevision(id, () => afterCommit(id, log)); }
      catch (e) { log(`packtxn: retained the interrupted start fence on ${id}: ${String(e)}`); }
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
  for (const name of shelf.keys()) if (server.has(name)) throw new Error(`ambiguous pack: ${name} exists in both server mods and the client shelf`);
  for (const f of c.files) {
    if (f.path) continue;
    for (const gone of [f.replaces, f.file]) if (gone) { server.delete(gone); shelf.delete(gone); }
    if (!f.remove && f.file.endsWith('.jar')) (f.to === 'mods' ? server : shelf).set(f.file, join(filesDir(id), f.file));
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
      else if (!(rel === 'mods' && (bridged.includes(e.name) || shelf.has(e.name)))) client.push({ src: join(dir, e.name), rel: packPath(r, 'extra') });
    }
  };
  walk(extras, '');
  const manifest = join(serverDir(id), 'automodpack', 'host-modpack', 'automodpack-content.json');
  if (existsSync(manifest)) {
    const { list } = JSON.parse(readFileSync(manifest, 'utf8')) as { list: { file: string }[] };
    for (const f of list) {
      const rel = packPath(f.file.replace(/^\//, ''), 'extra');
      if (rel.startsWith('mods/') || client.some((c) => c.rel === rel)) continue;
      const extra = join(extras, rel);
      client.push({ src: existsSync(extra) ? extra : join(serverDir(id), rel), rel });
    }
  }
  for (const f of c.files.filter((f) => f.path)) {
    const index = client.findIndex((item) => item.rel === f.path);
    if (index >= 0) {
      if (f.remove) client.splice(index, 1);
      else client[index] = { rel: f.path!, src: join(filesDir(id), f.file) };
    }
  }
  return { serverJars: [...server.values()], client };
}

/** Full inventories, not overlays which would silently reread mutable inputs
    during a test. Keep client-only files physically outside server/mods. */
function inputsFor(id: string, c: Pick<Candidate, 'files'>): RevisionInput[] {
  const set = candidateSet(id, c);
  const ledger = ledgerEntries(id);
  const entry = (src: string): LedgerEntry | undefined => {
    const staged = c.files.find((f) => f.file === basename(src));
    return staged ? staged.entry : ledger.find((e) => e.file === basename(src));
  };
  const inputs = revisionInputs(id).filter((f) => !c.files.some((s) => s.path === f.path) && (!f.path.startsWith('mods/') || (!f.path.endsWith('.jar') && !c.files.some((s) => [s.file, s.replaces].includes(basename(f.path))))));
  for (const f of c.files.filter((f) => !f.remove && !f.file.endsWith('.jar'))) inputs.push({ src: join(filesDir(id), f.file), path: f.path ?? `mods/${f.file}`, side: 'server', location: f.to === 'mods' ? 'server' : 'shelf', entry: f.entry });
  for (const src of set.serverJars) inputs.push({ src, path: `mods/${basename(src)}`, side: isServerOnly(src) ? 'server' : 'both', location: 'server', entry: entry(src) });
  for (const f of set.client) {
    if (set.serverJars.includes(f.src)) continue;
    const serverInput = inputs.find((input) => input.location === 'server' && input.src === f.src);
    if (serverInput) { serverInput.side = 'both'; continue; }
    if (f.src.startsWith(`${serverDir(id)}/`) && !f.src.startsWith(`${extrasDir(id)}/`)) {
      inputs.push({ src: f.src, path: f.rel, side: 'both', location: 'server' });
      continue;
    }
    const shelf = f.rel.startsWith('mods/') && (f.src.startsWith(clientShelfDir(id)) || c.files.some((s) => s.to === 'shelf' && s.file === basename(f.src)));
    inputs.push({ src: f.src, path: f.rel, side: 'client', location: shelf ? 'shelf' : 'extra', entry: entry(f.src) });
  }
  return inputs;
}

function sealedSet(id: string, revision: string) {
  const dir = revisionDir(id, revision);
  const serverJars: string[] = [];
  const client: ClientSet['files'] = [];
  // readLock is synchronous; verifyRevision is separately awaited at each boundary.
  const lock = readLock(id, revision);
  for (const f of lock.files) {
    const src = lockedPath(id, revision, f);
    if (f.location === 'server' && f.path.startsWith('mods/') && f.path.endsWith('.jar')) serverJars.push(src);
    if (f.side !== 'server') client.push({ src, rel: f.path });
  }
  return { serverJars, client, sourceDir: join(dir, 'files', 'server'), lock };
}

async function run(id: string, log: (m: string) => void): Promise<void> {
  let c = candidate(id);
  if (!c || c.status !== 'collecting') return;
  running++;
  const healed = new Set<string>();
  let configAttempts = 0;
  const status = (detail: string): void => { c = save(id, { ...candidate(id)!, status: 'testing', detail }); };
  try {
    if (!revisionState(id).managedHosting) {
      c = save(id, { ...c, consent: ['Install the required Crafty launch guard and hold AutoModpack hosting off until each boot and exact pack are verified. Permit pack rollback to restore locked configs and pack inputs, retaining altered copies for inspection. This changes the launch command and hosting flag, never Minecraft, the loader, or the world.'] });
      return wait(id, {}, 'owner consent is required to manage revision-checked starts and publication', log);
    }
    for (let round = 0; round < 6; round++) {
      const gen = generation.get(id) ?? 0;
      status('checking declared dependencies');
      let set = candidateSet(id, c);
      const solvedLoader = ['fabric', 'forge'].includes(detect(serverDir(id), id).loader);
      if (solvedLoader) {
        status('solving the complete server and friend pack');
        const { solveCandidate } = await import('./installer.js');
        const solved = await solveCandidate(id, [], log);
        c = save(id, { ...candidate(id)!, solver: solved.solver });
        if (solved.error) return wait(id, {}, solved.error, log);
        if (solved.candidate) continue;
      } else {
        const missing = scanJars(set.serverJars).missing.filter((m) => !healed.has(m));
        if (missing.length && missing.length <= 6) {
          missing.forEach((m) => healed.add(m));
          status(`installing missing dependencies: ${missing.join(', ')}`);
          if ((await healMissing(id, missing)).length) continue;
        }
      }

      const baseline = revisionState(id).active ?? `${c.txn}-baseline`;
      if (!existsSync(join(revisionDir(id, baseline), 'lock.json'))) {
        await sealRevision(id, baseline, inputsFor(id, { files: [] }));
        reportRevision(id, baseline, { tests: { server: { result: 'inconclusive', detail: 'Observed pre-change pack; not certified by this test' }, client: { result: 'inconclusive', detail: 'Observed pre-change pack; not certified by this test' } } });
      } else await verifyRevision(id, baseline, true);
      if (!revisionState(id).active) {
        setRevisionState(id, { active: baseline });
        await afterCommit(id, log);
      }
      const revision = `${c.txn}-${Date.now()}`;
      await sealRevision(id, revision, inputsFor(id, c));
      c = save(id, { ...candidate(id)!, revision, baseline });
      const sealed = sealedSet(id, revision);
      set = sealed;
      const witness = c.solver?.status === 'ok' ? c.solver : c.solver?.status === 'inconclusive' ? c.solver.tentative : undefined;
      if (solvedLoader) {
        const paths = [...new Set([...set.serverJars, ...set.client.filter((f) => f.rel.startsWith('mods/') && f.rel.endsWith('.jar')).map((f) => f.src)])];
        let matches = !!witness && paths.length === witness.plan.length;
        for (const path of paths) {
          const actual = await hashes(path);
          if (!witness?.plan.some((p) => p.file === basename(path) && p.sha1 === actual.sha1)) matches = false;
        }
        if (!matches) {
          const why = 'The sealed mod inventory differs from the complete solver plan; test the new inventory again';
          reportRevision(id, revision, { tests: { solver: { result: 'failed', detail: why, renderer: 'none' } } });
          return wait(id, {}, why, log);
        }
      }
      reportRevision(id, revision, { tests: {
        solver: witness ? { result: 'passed', detail: 'Loader metadata, exact source relations and both client/server constraints satisfied', renderer: 'none' }
          : { result: 'inconclusive', detail: 'This loader has not been solved', renderer: 'none' },
        optimality: c.solver?.status === 'ok' ? { result: 'passed', detail: 'Minimum existing-version changes proved against the original live inventory', renderer: 'none' }
          : { result: 'inconclusive', detail: c.solver?.status === 'inconclusive' ? `${c.solver.reason} Fewer replacements may be possible.` : 'Minimum changes not checked', renderer: 'none' },
      } });
      status('boot-testing the server with this change');
      // every verdict below is only acted on if nothing changed meanwhile
      const stale = (): boolean => (generation.get(id) ?? 0) !== gen;
      const server = await dryBoot(id, set.serverJars, status, sealed.sourceDir, sealed.lock);
      reportRevision(id, revision, { tests: { server: { ...server, result: server.result === 'unverified' ? 'inconclusive' : server.result, renderer: 'none' }, ...server.checks } });
      if (server.configs?.length) {
        if (stale()) continue;
        if (++configAttempts > 3) return wait(id, { server: { result: 'unverified', detail: 'the server rewrites its configs on every boot; no stable revision was verified' } }, 'generated configs did not stabilize after three attempts', log);
        for (const config of server.configs) c = stageConfig(id, config.path, config.remove ? null : readFileSync(config.src!), log);
        continue; // certify the proposed output bytes, not the old inputs
      }
      if (server.result === 'failed') {
        if (stale()) continue;
        // the loader names missing mod ids: install them and test again
        const named = missingFromExcerpt(server.excerpt ?? []).filter((m) => !healed.has(m));
        if (!solvedLoader && named.length && named.length <= 4) {
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
        const previous = sealedSet(id, baseline);
        const before = await dryBoot(id, previous.serverJars, status, previous.sourceDir, previous.lock);
        const again = before.result === 'passed' ? await dryBoot(id, set.serverJars, status, sealed.sourceDir, sealed.lock) : before;
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
        const changed = candidate(id)!.files.map((f) => f.file);
        client = await clientGate(id, { files: set.client, serverJars: set.serverJars, label: 'candidate', changed, sourceDir: sealed.sourceDir, lock: sealed.lock }, status, log);
        reportRevision(id, revision, { tests: { client: { ...client, result: client.result === 'unverified' ? 'inconclusive' : client.result }, ...client.checks } });
        if (client.result === 'failed') {
          if (stale()) continue;
          // blame the change only if the pack without it passes and the
          // failure repeats (mixin-heavy packs can crash at random)
          status('the client test failed; testing the current pack without this change');
          const live = sealedSet(id, baseline);
          const before = await clientGate(id, { files: live.client, serverJars: live.serverJars, sourceDir: live.sourceDir, lock: live.lock, label: 'live', changed: [] }, status, log);
          if (before.result === 'passed') status('the current pack passed; testing this change once more');
          const again = before.result === 'passed' ? await clientGate(id, { files: set.client, serverJars: set.serverJars, sourceDir: sealed.sourceDir, lock: sealed.lock, label: 'candidate', changed }, status, log) : before;
          if (stale()) continue;
          if (before.result === 'passed' && again.result === 'failed') return reject(id, server, again, log);
          // what the owner needs is what applying it would do: keep the candidate's own crash
          client = { ...client, result: 'unverified', detail: before.result !== 'passed'
            ? `the client fails without this change too (with it, ${client.detail})`
            : `the client test is unreliable with this change (it failed once, then passed: ${client.detail})` };
        }
      }
      if (stale()) continue; // more files arrived mid-test: test the new set
      await verifyRevision(id, revision);
      if (!autoModpackActive(id)) reportRevision(id, revision, { tests: { client: { result: 'skipped', detail: 'AutoModpack is not configured; friend synchronization was not tested', renderer: 'none' } } });

      if (server.result === 'unverified' || client?.result === 'unverified') {
        const why = [server, client].filter((v) => v?.result === 'unverified').map((v) => v!.detail).join('; ');
        return wait(id, { server, client }, why, log);
      }
      if (candidate(id)!.files.some((f) => f.path || f.replaces || f.remove)) {
        return wait(id, { server, client }, 'approve the listed replacements, removals and config edits before promotion', log);
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
  const c = candidate(id)!;
  const consent = revisionState(id).managedHosting ? c.files.filter((f) => f.path || f.replaces || f.remove).map((f) => f.path ? `${f.remove ? 'Remove config' : 'Write config'} ${f.path}` : f.remove ? `Remove ${f.file}` : `${f.replaces} → ${f.file}`) : c.consent;
  save(id, { ...c, ...verdicts, consent, status: 'needs-approval', detail: why });
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
      const r = await install(id, { projectId, type: 'mod', dependency: true }).catch(() => null);
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
    setRevisionState(id, { active: c.journal.activeBefore });
  }
  rmSync(join(revisionsDir(id), c.txn, 'revision.json'), { force: true });
  save(id, { ...candidate(id)!, journal: undefined, status: 'needs-approval', detail });
}

/** Reverse an undo cut short, from the journal in its manifest. */
function rollBackUndo(id: string, dir: string): void {
  const m = readManifest(dir)!;
  reverseMoves(m.undoing!, (undoing) => writeManifest(dir, { ...m, undoing }));
  updateLedger(id, () => m.undoing!.ledgerBefore);
  setRevisionState(id, { active: m.undoing!.activeBefore });
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
function activate(id: string, c: Candidate, log: (m: string) => void, approved = false, applying = false): Promise<Candidate> {
  const gen = generation.get(id) ?? 0;
  return exclusive(id, async () => {
    // the running server keeps its old jars, and AutoModpack would serve
    // friends files it does not run: a change to mods/ waits for a restart
    const touches = touchesServer(id, c);
    const wait = !applying || await isRunningSafe(id);
    if (!c.revision || !c.baseline) throw new Error('this change has no revision lock; test it again');
    if (['fabric', 'forge'].includes(readLock(id, c.revision).loader) && revisionReport(id, c.revision).tests.solver?.result !== 'passed') {
      throw new Error('the exact revision solver inventory check must pass before approval or promotion; test this change again');
    }
    await verifyRevision(id, c.revision);
    const pack = autoModpackActive(id) ? await packHashes(sealedSet(id, c.revision).client) : undefined;
    // a second approval queued behind the first finds it already applied
    const now = candidate(id);
    if (now?.txn !== c.txn || now.status !== c.status) return now!;
    // the candidate changed while this waited: test again
    if ((generation.get(id) ?? 0) !== gen) {
      arm(id, log);
      return save(id, { ...candidate(id)!, status: 'collecting', detail: 'the change grew while it waited; testing again' });
    }
    approved ||= !!c.approved;
    if (wait) {
      const ready = save(id, { ...c, approved, pack, status: 'ready', detail: `${approved ? 'approved' : 'tested'}; goes live when the server restarts` });
      requestPromotion(id, 'apply', c.txn, log);
      return ready;
    }
    await verifyRevision(id, c.baseline, true);
    const lock = readLock(id, c.revision);
    for (const f of c.files) {
      if (f.remove) continue;
      const sealed = lock.files.find((file) => file.location === (f.to === 'mods' ? 'server' : 'shelf') && file.path === (f.path ?? `mods/${f.file}`));
      if (!sealed || (await hashes(join(filesDir(id), f.file))).sha512 !== sealed.sha512) throw new Error(`staged bytes changed after testing: ${f.file}`);
    }
    const modsDir = join(serverDir(id), 'mods');
    const shelfDir = clientShelfDir(id);
    const rev = join(PATHS.data, 'revisions', id, c.txn);
    const moves = await revisionMoves(id, c.revision, rev);
    const removed = c.files.flatMap((f) => [f.replaces, f.file]).filter((f): f is string => !!f);
    const replaced = new Set(removed.filter((name) => existsSync(join(modsDir, name)) || existsSync(join(shelfDir, name))));
    const journal: Journal = { moves, started: 0, ledgerBefore: ledgerEntries(id), activeBefore: revisionState(id).active };
    save(id, { ...c, status: 'activating', journal });
    try {
      runMoves(journal, (j) => save(id, { ...c, status: 'activating', journal: j }));
      const added = new Set(c.files.map((f) => f.file));
      // what undo needs: the files this change added and the ledger rows of what it replaced
      const manifest: RevisionManifest = {
        txn: c.txn, at: new Date().toISOString(),
        added: c.files.filter((f) => !f.path && !f.remove).map((f) => ({ file: f.file, to: f.to })),
        replaced: [...replaced].map((file) => ({ file, to: existsSync(join(rev, 'before', 'server', 'mods', file)) ? 'mods' : 'shelf' })),
        ledger: ledgerEntries(id).filter((e) => replaced.has(e.file)),
        revision: c.revision, baseline: c.baseline,
      };
      writeManifest(rev, manifest);
      updateLedger(id, (entries) => entries
        .filter((e) => !replaced.has(e.file) && !added.has(e.file))
        .concat(c.files.flatMap((f) => (!f.remove && f.entry ? [{ ...f.entry, clientOnly: f.to === 'shelf' || undefined }] : []))));
      await verifyRevision(id, c.revision, true);
      setRevisionState(id, { active: c.revision });
    } catch (e) {
      // if the rollback itself fails, the journal stays and the next start finishes it
      rollBackActivation(id, `the files could not be moved (${String(e).slice(0, 100)}); stop the server and apply again`);
      return candidate(id)!;
    }
    const verdict = approved ? 'applied with owner consent' : 'tested and applied';
    const when = touches ? `${c.files.length === 1 ? 'it loads' : 'they load'} when the server starts` : 'friends get it on their next join';
    const applied = save(id, { ...c, approved, journal: undefined, status: 'applied', detail: `${verdict}; ${when}` });
    log(`packtxn: applied ${c.files.map((f) => f.file).join(', ')} on ${id}`);
    await afterCommit(id, log);
    return applied;
  });
}

/** Does this change move anything into or out of the server's own mods/? */
function touchesServer(id: string, c: Pick<Candidate, 'files'>): boolean {
  const mods = join(serverDir(id), 'mods');
  return c.files.some((f) => f.to === 'mods' || [f.replaces, f.file].some((x) => x && existsSync(join(mods, x))));
}

/** SHA-1 of each client file by its path in AutoModpack's pack. AutoModpack
    never lists its own jar: friends get it from the starter pack. */
async function packHashes(files: ClientSet['files']): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of files) {
    if (/^mods\/automodpack[^/]*\.jar$/i.test(f.rel)) continue;
    out[`/${f.rel}`] = createHash('sha1').update(await readFile(f.src)).digest('hex');
  }
  return out;
}

/** Apply ready candidate `txn` now (the promotion stopped the server for it).
    Anything else (already applied, retested, discarded) is left as it is. */
export function applyReady(id: string, txn: string, log: (m: string) => void): Promise<Candidate | null> {
  const c = candidate(id);
  return c?.status === 'ready' && c.txn === txn ? activate(id, c, log, false, true) : Promise.resolve(c);
}

/** How far change `txn` got: live, mid-undo, or undone (null: no such change). */
export function changeState(id: string, txn: string): 'live' | 'undoing' | 'undone' | null {
  const m = readManifest(join(revisionsDir(id), txn));
  return !m ? null : m.undoing ? 'undoing' : m.undone ? 'undone' : 'live';
}

/** The promotion reports how the restart went. */
export function noteLive(id: string, txn: string, status: 'ready' | 'applied', detail: string): void {
  const c = candidate(id);
  if (c?.txn === txn) save(id, { ...c, status, detail });
}

/** The live server would not start with an applied change, so it was undone. */
export function liveBootFailed(id: string, txn: string, detail: string): void {
  const c = candidate(id);
  if (c?.txn !== txn || (c.status === 'rejected' && c.detail === detail)) return; // already recorded
  save(id, { ...c, status: 'rejected', detail });
  recordRejection(id, c.files.map((f) => f.file), [detail]);
}

interface RevisionManifest {
  txn: string;
  at: string;
  revision?: string;
  baseline?: string;
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
    it is not tested again. With `txn`, only that change is undone (a replay
    of a finished undo returns it unchanged). */
export function undoLast(id: string, log: (m: string) => void, txn?: string): Promise<RevisionManifest & { waiting?: boolean }> {
  return exclusive(id, async () => {
    const running = await isRunningSafe(id);
    if (recoveryPending(id)) throw new Error('the last mod change is still being applied or undone; try again in a moment, or restart the panel to finish it');
    // the owner's undo waits its turn; a promotion's own rollback names its txn
    const busy = !txn && (restarting(id) ? 'the server is restarting to load a mod change; try again in a minute' : busyReason(id));
    if (busy) throw new Error(busy);
    if (isOpen(candidate(id))) throw new Error('a mod change is waiting or being tested; finish or discard it first');
    const m = lastChange(id);
    if (txn && m?.txn !== txn) {
      const done = readManifest(join(revisionsDir(id), txn));
      if (done?.undone) return done;
      throw new Error('that mod change is no longer the last one, so it was not undone');
    }
    if (!m) throw new Error('there is no mod change to undo');
    const dirOf = (to: 'mods' | 'shelf'): string => (to === 'mods' ? join(serverDir(id), 'mods') : clientShelfDir(id));
    const rev = join(revisionsDir(id), m.txn);
    const gone = m.added.filter((f) => !existsSync(join(dirOf(f.to), f.file)));
    if (!m.baseline && gone.length) throw new Error(`${gone.map((f) => f.file).join(', ')} changed since; undo by hand from data/revisions/${id}/${m.txn}`);
    // like an apply, an undo that touches mods/ waits for a restart
    if ((!txn && m.baseline) || (running && [...m.added, ...m.replaced].some((f) => f.to === 'mods'))) {
      requestPromotion(id, 'undo', m.txn, log);
      return { ...m, waiting: true };
    }
    const moves: [string, string][] = m.baseline ? await revisionMoves(id, m.baseline, join(rev, 'undo')) : [
      ...m.added.map((f): [string, string] => [join(dirOf(f.to), f.file), join(rev, 'undone', f.file)]),
      ...m.replaced.map((f): [string, string] => [join(rev, f.file), join(dirOf(f.to), f.file)]),
    ];
    // journaled like an activation: everything up to the final manifest
    // write is synchronous, and resumeCandidates reverses a crash part-way
    const journal: Journal = { moves, started: 0, ledgerBefore: ledgerEntries(id), activeBefore: revisionState(id).active };
    writeManifest(rev, { ...m, undoing: journal });
    const undone = { ...m, undone: new Date().toISOString() };
    try {
      runMoves(journal, (j) => writeManifest(rev, { ...m, undoing: j }));
      const added = new Set(m.added.map((f) => f.file));
      updateLedger(id, (entries) => entries.filter((e) => !added.has(e.file)).concat(m.ledger));
      if (m.baseline) {
        await verifyRevision(id, m.baseline, true);
        setRevisionState(id, { active: m.baseline });
      }
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

/** Housekeeping once a change is final (safe to repeat). Its failure is
    logged; it never reopens the change. */
export async function afterCommit(id: string, log: (m: string) => void): Promise<void> {
  try {
    pruneRevisions(id);
    // Restored configs must be writable by Crafty's server user too.
    for (const name of ['mods', 'config', 'kubejs', 'emotes', 'automodpack']) if (existsSync(join(serverDir(id), name))) await chownToDirOwner(join(serverDir(id), name));
  } catch (e) {
    log(`packtxn: cleanup after a change on ${id} failed: ${String(e)}`);
  }
  await publishPack(id, log);
  writeLaunchGate(id);
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
