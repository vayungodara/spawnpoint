import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../config.js';
import { craftyApi } from '../clients/crafty.js';
import * as modrinth from '../clients/modrinth.js';
import { serverDir } from './servers.js';
import { install } from './installer.js';
import { clientShelfDir } from './servers.js';
import { updateLedger } from './ledger.js';
import { settled, assertModsWritable } from './packtxn.js';
import { isUnderMaintenance } from './maintenance.js';
import { assertUnsealed } from './revisions.js';

// DEPENDENCY DOCTOR — a failed boot from missing mod dependencies should be
// fixed in the background, not shown to the owner (his words: "fixed
// automatically before I get any file, so I don't see the noise").
//
// Fabric prints exactly what it wants:
//   "Install glitchcore, version 26.1.2.0.0 or later." / "Install lithostitched, any version."
// and names version conflicts:
//   "Mod 'Voxy' (voxy) ... requires ... of mod 'Sodium' ... but only the wrong version is present"
// Forge's equivalent: "Missing or unsupported mandatory dependencies: ... Mod ID: 'x'".
//
// The doctor watches for a server that is DOWN with a fresh resolution failure
// in its log, installs the missing ids from Modrinth (mod ids are Modrinth
// slugs in practice), shelves client-only offenders, and restarts the server.
// Strictly bounded: one log signature is treated ONCE, and at most 2 fix
// attempts per server per hour — a dep that Modrinth cannot supply must not
// become a restart loop.

const STATE_FILE = join(PATHS.data, 'depdoctor.json');
const POLL_MS = 20_000;
const MAX_ATTEMPTS_PER_HOUR = 2;

interface DoctorState {
  [serverId: string]: { lastSig: string; attempts: { at: number }[] };
}

function loadState(): DoctorState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveState(s: DoctorState): void {
  mkdirSync(PATHS.data, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
}

/** Missing hard deps, from the loader's own fix advice. */
function parseMissing(log: string): { id: string; anyVersion: boolean }[] {
  const out = new Map<string, boolean>();
  // Fabric: "Install glitchcore, version 26.1.2.0.0 or later." | "Install lithostitched, any version."
  for (const m of log.matchAll(/Install ([a-z0-9_-]{2,}), (?:version [\w.+-]+ or later|any version)/gi)) {
    out.set(m[1].toLowerCase(), /any version/i.test(m[0]));
  }
  // Forge: "Mod ID: 'terrablender', Requested by: 'biomesoplenty'"
  for (const m of log.matchAll(/Mod ID: '([a-z0-9_-]{2,})', Requested by:/gi)) {
    out.set(m[1].toLowerCase(), true);
  }
  return [...out.entries()].map(([id, anyVersion]) => ({ id, anyVersion }));
}

/** Mods whose version demands can't be met because they are CLIENT mods that
    should never have been server-side (the Voxy case): "Replace mod 'Voxy'
    (voxy) …". Only shelved when Modrinth confirms server-unsupported. */
function parseConflictMods(log: string): string[] {
  const ids = new Set<string>();
  for (const m of log.matchAll(/Replace mod '[^']+' \(([a-z0-9_-]{2,})\)/gi)) ids.add(m[1].toLowerCase());
  for (const m of log.matchAll(/Mod '[^']+' \(([a-z0-9_-]{2,})\) [^\n]*requires [^\n]*wrong version is present/gi)) {
    ids.add(m[1].toLowerCase());
  }
  return [...ids];
}

async function treat(id: string, log: (m: string) => void): Promise<boolean> {
  // an unfinished apply or undo is reversed on the next start; leave mods/ alone until then
  try { assertModsWritable(id); assertUnsealed(id); } catch { return false; }
  const dir = serverDir(id);
  const logFile = join(dir, 'logs', 'latest.log');
  if (!existsSync(logFile)) return false;
  const text = readFileSync(logFile, 'utf8').slice(-40_000);
  if (!/Incompatible mods found|Mod resolution failed|Missing or unsupported mandatory dependencies/i.test(text)) {
    return false;
  }

  const missing = parseMissing(text);
  const conflicts = parseConflictMods(text);
  if (!missing.length && !conflicts.length) return false;

  // one signature = one treatment; a re-crash after our fix produces a NEW
  // signature (different missing set) and gets one more look
  const sig = `${statSync(logFile).mtimeMs}|${missing.map((m) => m.id).join(',')}|${conflicts.join(',')}`;
  const state = loadState();
  const st = (state[id] ??= { lastSig: '', attempts: [] });
  st.attempts = st.attempts.filter((a) => Date.now() - a.at < 3600_000);
  if (st.lastSig === sig || st.attempts.length >= MAX_ATTEMPTS_PER_HOUR) return false;
  st.lastSig = sig;
  st.attempts.push({ at: Date.now() });
  saveState(state);

  const fixed: string[] = [];

  /** move a jar to the client shelf (AutoModpack still ships it to clients) */
  const shelfJar = (jar: string): void => {
    assertModsWritable(id); // re-checked here: the lookups before this awaited
    assertUnsealed(id);
    mkdirSync(clientShelfDir(id), { recursive: true });
    renameSync(join(dir, 'mods', jar), join(clientShelfDir(id), jar));
    updateLedger(id, (entries) => entries.map((e) => (e.file === jar ? { ...e, clientOnly: true } : e)));
  };

  // 0) a mod whose MISSING hard deps are client-only libraries is itself a
  //    CLIENT mod sitting on a server — installing the deps can never help
  //    (they shelve themselves as client-only and the requirer keeps failing
  //    in a loop). Shelf the
  //    REQUIRER: the pack still ships it, the server stops loading it.
  const requirers = new Map<string, string[]>(); // requirer modid -> missing dep ids
  for (const m of text.matchAll(/Mod '[^']+' \(([a-z0-9_-]{2,})\)[^\n]*?of (?:mod '[^']+' \()?([a-z0-9_.-]{2,})\)?,? which is missing/gi)) {
    const list = requirers.get(m[1].toLowerCase()) ?? [];
    list.push(m[2].toLowerCase());
    requirers.set(m[1].toLowerCase(), list);
  }
  for (const [reqId, deps] of requirers) {
    let allClientOnly = deps.length > 0;
    for (const depId of deps) {
      try {
        const proj = await modrinth.getProject(depId).catch(() => modrinth.getProject(depId.replace(/_/g, '-')));
        if (proj.server_side !== 'unsupported') { allClientOnly = false; break; }
      } catch { allClientOnly = false; break; }
    }
    if (!allClientOnly) continue;
    const modsDir = join(dir, 'mods');
    const jar = existsSync(modsDir)
      ? readdirSync(modsDir).find((f) => f.toLowerCase().includes(reqId.replace(/[_.]/g, '')) || f.toLowerCase().includes(reqId))
      : undefined;
    if (jar) {
      shelfJar(jar);
      fixed.push(`${reqId} → client shelf (its missing deps are all client-only)`);
      // its deps need no server install — drop them from the missing list
      for (const depId of deps) {
        const i = missing.findIndex((x) => x.id === depId);
        if (i >= 0) missing.splice(i, 1);
      }
    }
  }

  // 1) shelf client-only conflict mods (Modrinth-verified — never guess)
  for (const slug of conflicts) {
    try {
      const proj = await modrinth.getProject(slug);
      if (proj.server_side !== 'unsupported') continue;
      const modsDir = join(dir, 'mods');
      const jar = existsSync(modsDir)
        ? readdirSync(modsDir).find(
            (f) => f.toLowerCase().includes(slug.replace(/_/g, '')) || f.toLowerCase().includes(slug),
          )
        : undefined;
      if (jar) {
        shelfJar(jar);
        fixed.push(`${slug} → client shelf`);
      }
    } catch { /* unknown on modrinth — leave it alone */ }
  }

  // 2) install missing hard deps (a mod id is usually its Modrinth slug, or
  //    the slug with dashes). They go through a boot-tested candidate.
  let staged = false;
  for (const dep of missing) {
    try {
      const proj = await modrinth.getProject(dep.id).catch(() => modrinth.getProject(dep.id.replace(/_/g, '-')));
      const r = await install(id, { projectId: proj.id, type: 'mod' }, log);
      if (r.candidate) staged = true;
      else if (r.installed.length) fixed.push(...r.installed.map((i) => i.title));
    } catch {
      log(`depdoctor: ${dep.id} not found on Modrinth, so it cannot be fixed automatically`);
    }
  }
  if (staged) {
    const c = await settled(id);
    if (c?.status === 'applied') fixed.push(...c.files.map((f) => f.entry?.title ?? f.file));
    else log(`depdoctor: the fix for ${id} was not applied (${c?.detail ?? 'unknown'})`);
  }

  if (!fixed.length) return false;
  log(`depdoctor: fixed the boot of server ${id} (${fixed.join(', ')}), restarting`);
  const { publishPack } = await import('./automodpack.js');
  await publishPack(id, log);
  // through the panel's start: refused if a mod change took the server meanwhile
  const { startServer } = await import('./promote.js');
  await startServer(id, log).catch((e) => log(`depdoctor: not starting ${id}: ${String((e as Error).message ?? e)}`));
  return true;
}

export function startDepDoctor(log: (msg: string) => void): void {
  const tick = async (): Promise<void> => {
    const servers = await craftyApi.listServers().catch(() => []);
    for (const srv of servers) {
      const id = srv.server_id;
      let stats;
      try {
        stats = await craftyApi.getStats(id);
      } catch {
        continue;
      }
      if (stats.running) continue; // doctor only examines servers that DIED
      if (isUnderMaintenance(id)) continue; // a restart or operation in progress handles its own failures
      const logFile = join(serverDir(id), 'logs', 'latest.log');
      // only fresh corpses: a crash log older than 10 min is history, not a patient
      if (!existsSync(logFile) || Date.now() - statSync(logFile).mtimeMs > 10 * 60_000) continue;
      await treat(id, log).catch((e) => log(`depdoctor: ${srv.server_name}: ${String(e).slice(0, 120)}`));
    }
  };
  const timer = setInterval(() => {
    tick().catch(() => {});
  }, POLL_MS);
  timer.unref();
}
