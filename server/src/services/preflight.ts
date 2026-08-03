import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, basename } from 'node:path';
import { PATHS } from '../config.js';
import { serverDir, javaFor } from './servers.js';
import { detect } from './detect.js';
import { IS_WIN } from './platform.js';

// cross-platform launch: `nice` is a Linux nicety, not a requirement; Forge
// ships win_args.txt beside unix_args.txt
const gentle = (cmd: string, args: string[]): [string, string[]] =>
  IS_WIN ? [cmd, args] : ['nice', ['-n', '19', cmd, ...args]];
export const FORGE_ARGFILE = IS_WIN ? 'win_args.txt' : 'unix_args.txt';

// INSTALL-TIME PREFLIGHT — the loader itself is the only honest judge of
// whether a mods folder boots (2026-07-20 audit: every shipped conflict was
// the panel's hand-rolled model diverging from the loader's). So don't model:
// DRY-BOOT the real thing. A sandbox gets symlinks to the server's jar,
// libraries and candidate mods, an eula=false file, and is launched for real.
// The loader resolves dependencies, applies mixins and runs every mod's init
// — then the vanilla EULA gate stops it before ports, worlds or any writes
// that matter. "You need to agree to the EULA" in the log = the exact bytes
// of this mod set boot on this server. Anything else = they don't.
//
// Proven live: main's 40-mod set reaches the EULA line in ~18s; the JVM
// lingers on non-daemon threads afterwards, so the verdict comes from log
// polling and the process is killed, not awaited.

const PASS_RE = /You need to agree to the EULA/i;
const FAIL_RE = /Incompatible mods found|Mod resolution failed|Missing or unsupported mandatory dependencies|Error during pre-launch|Failed to start the minecraft server|Exception in thread "main"/i;
const TIMEOUT_MS = 150_000;

export interface PreflightResult {
  ok: boolean;
  skipped?: string; // loader we can't dry-boot yet — NOT a pass, a non-verdict
  reason?: string;
  excerpt?: string[];
  seconds?: number;
}

// dry-boots share a per-server sandbox and cost ~2GB each — NEVER run two at
// once: a second run's sandbox wipe mid-first-run dangled the symlinks and
// convicted an innocent jar (live 2026-07-21, physics-mod-pro upload x2)
let preflightChain: Promise<unknown> = Promise.resolve();

/** Dry-boot the server's mod set, optionally with extra candidate jars added
    and/or current jars removed — the exact post-install state, judged by the
    exact loader, BEFORE the change is committed. Serialized globally. */
export function runPreflight(
  serverId: string,
  opts: { extraJars?: string[]; withoutJars?: string[] } = {},
): Promise<PreflightResult> {
  const run = preflightChain.then(() => runPreflightInner(serverId, opts), () => runPreflightInner(serverId, opts));
  preflightChain = run.catch(() => {});
  return run;
}

async function runPreflightInner(
  serverId: string,
  opts: { extraJars?: string[]; withoutJars?: string[] } = {},
): Promise<PreflightResult> {
  const dir = serverDir(serverId);
  const det = detect(dir, serverId);
  // short-lived-JVM flags (researched 2026-08-02): C1-only JIT skips C2
  // compile work a killed-at-EULA process never amortizes (the AWS-Lambda/
  // JRuby cold-start standard, 10-25% off), ParallelGC beats G1 for pure
  // boot churn, UsePerfData off skips the hsperfdata mmap. NONE of these
  // change what loads or how it fails — verdict fidelity is untouched.
  // Rejected as unsafe: -Xverify:none (masks VerifyError = false PASS),
  // sandbox-only speedup mods like ModernFix (mixin env diverges from prod).
  const FAST_BOOT = ['-XX:TieredStopAtLevel=1', '-XX:+UseParallelGC', '-XX:-UsePerfData'];
  // launch command per loader. Forge: run the SAME @argfile its real boot
  // uses (proven live 2026-07-21: Horror reaches the EULA gate in 10s with
  // FML discovery + dependency resolution completed — the exact layer that
  // throws "Missing or unsupported mandatory dependencies").
  let launchArgs: string[] | null = null;
  if (det.loader === 'fabric') {
    launchArgs = ['-Xmx2G', ...FAST_BOOT, '-jar', 'fabric.jar', 'nogui'];
  } else if (det.loader === 'forge' || det.loader === 'neoforge') {
    const ns = det.loader === 'forge' ? 'minecraftforge' : 'neoforge';
    const fdir = join(dir, 'libraries', 'net', ns, det.loader === 'forge' ? 'forge' : 'neoforge');
    const ver = existsSync(fdir) ? readdirSync(fdir)[0] : null;
    const argRel = ver ? `libraries/net/${ns}/${det.loader === 'forge' ? 'forge' : 'neoforge'}/${ver}/${FORGE_ARGFILE}` : null;
    if (argRel && existsSync(join(dir, argRel))) launchArgs = ['-Xmx2G', ...FAST_BOOT, `@${argRel}`, 'nogui'];
  }
  if (!launchArgs) {
    return { ok: true, skipped: `${det.loader} dry-boot not supported — depdoctor remains the net` };
  }
  const java = javaFor(det.mc, det.loader);
  if (!java) return { ok: true, skipped: 'no JDK found for this MC version' };

  const sandbox = join(PATHS.data, 'preflight', serverId);
  rmSync(sandbox, { recursive: true, force: true });
  mkdirSync(join(sandbox, 'mods'), { recursive: true });

  // the loader's world, borrowed read-only; config deliberately NOT linked so
  // mods regenerate defaults in the sandbox instead of writing to the real one
  for (const item of ['fabric.jar', 'libraries', 'versions', '.fabric', 'server.properties']) {
    const src = join(dir, item);
    if (existsSync(src)) symlinkSync(src, join(sandbox, item));
  }
  const skip = new Set((opts.withoutJars ?? []).map((f) => basename(f)));
  for (const jar of readdirSync(join(dir, 'mods')).filter((f) => f.endsWith('.jar'))) {
    if (!skip.has(jar)) symlinkSync(join(dir, 'mods', jar), join(sandbox, 'mods', jar));
  }
  for (const extra of opts.extraJars ?? []) {
    if (existsSync(extra)) symlinkSync(extra, join(sandbox, 'mods', basename(extra)));
  }
  writeFileSync(join(sandbox, 'eula.txt'), 'eula=false\n', 'utf8');

  const logPath = join(sandbox, 'preflight.log');
  const started = Date.now();
  return await new Promise<PreflightResult>((resolve) => {
    const [cmd, args] = gentle(java, launchArgs);
    const child = spawn(cmd, args, {
      cwd: sandbox,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let settled = false;
    const finish = (r: PreflightResult): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(killer);
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      try { writeFileSync(logPath, out, 'utf8'); } catch { /* diagnostics only */ }
      resolve({ ...r, seconds: Math.round((Date.now() - started) / 1000) });
    };
    const excerpt = (): string[] => {
      const lines = out.split('\n');
      // the CAUSE first, stack noise never: "Caused by"/loader verdict lines
      // beat generic error frames, which beat raw tail
      // "Mod ID:" is FML's detail line under "Missing or unsupported mandatory
      // dependencies:" — it NAMES the missing mod (live 2026-07-21: tectonic
      // needed lithostitched, the banner showed only the useless header)
      const cause = lines.filter((l) => /Caused by|Incompatible mods found|Missing or unsupported|requires .* of|Replace mod|which is missing!|Mod ID: /i.test(l) && !/recommends/i.test(l));
      if (cause.length) return cause.slice(0, 8).map((l) => l.trim().slice(0, 220));
      const bad = lines.filter((l) => /incompatible|error|exception|missing|install /i.test(l) && !/\tat |recommends/i.test(l));
      return (bad.length ? bad : lines).slice(-8).map((l) => l.trim().slice(0, 220));
    };
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    const poll = setInterval(() => {
      if (PASS_RE.test(out)) finish({ ok: true });
      else if (FAIL_RE.test(out)) finish({ ok: false, reason: 'the loader rejected this mod set', excerpt: excerpt() });
    }, 1500);
    child.on('exit', (code) => {
      // exited before the EULA line: resolution/init crash even if no known
      // marker matched — fail closed with whatever it said
      setTimeout(() => {
        if (PASS_RE.test(out)) finish({ ok: true });
        else finish({ ok: false, reason: `dry-boot exited (code ${code}) before reaching the EULA gate`, excerpt: excerpt() });
      }, 300);
    });
    const killer = setTimeout(() => {
      finish({ ok: false, reason: `dry-boot produced no verdict within ${TIMEOUT_MS / 1000}s`, excerpt: excerpt() });
    }, TIMEOUT_MS);
  });
}


// ---- CULPRIT RESOLUTION — the dry-boot judges the WHOLE mods dir, so a
// pre-existing broken mod convicts whatever was added last (live 2026-07-27:
// a modpack's client-only Mobility crashed the boot and the gate kept
// removing AutoModpack — the one jar that was fine). Fabric NAMES the real
// offender ("Mixin [… from mod <id>]" + "in environment type SERVER");
// believe it: move THAT jar to the client shelf — AutoModpack still ships it
// to friends' clients, the server never loads it — and judge again.

async function modIdOf(jarPath: string): Promise<string | null> {
  try {
    const { default: AdmZip } = await import('adm-zip');
    const zip = new AdmZip(jarPath);
    const fab = zip.getEntry('fabric.mod.json');
    if (fab) return (JSON.parse(zip.readAsText(fab)) as { id?: string }).id ?? null;
    for (const name of ['META-INF/mods.toml', 'META-INF/neoforge.mods.toml']) {
      const toml = zip.getEntry(name);
      if (toml) return /modId\s*=\s*"([^"]+)"/.exec(zip.readAsText(toml))?.[1] ?? null;
    }
  } catch { /* unreadable jar — filename fallback below */ }
  return null;
}

function culpritIds(excerpt: string[]): string[] {
  const ids = new Set<string>();
  for (const l of excerpt) {
    for (const m of l.matchAll(/from mod ([a-z0-9_-]+)\]/gi)) ids.add(m[1].toLowerCase());
  }
  return [...ids].filter((id) => !/^(minecraft|forge|neoforge|fabric|fabricloader|fabric-api|java|mixinextras)$/.test(id));
}

async function findModJar(serverId: string, modId: string): Promise<string | null> {
  const modsDir = join(serverDir(serverId), 'mods');
  if (!existsSync(modsDir)) return null;
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const jars = readdirSync(modsDir).filter((f) => f.endsWith('.jar'));
  // filename candidates first — cracking open all 350 jars of a big pack for
  // one lookup is real IO on this disk
  const byName = jars.filter((f) => norm(f).includes(norm(modId)));
  for (const jar of byName) {
    if ((await modIdOf(join(modsDir, jar)))?.toLowerCase() === modId.toLowerCase()) return jar;
  }
  if (byName.length === 1) return byName[0]; // metadata unreadable, name unambiguous
  if (byName.length === 0 && jars.length <= 120) {
    for (const jar of jars) {
      if ((await modIdOf(join(modsDir, jar)))?.toLowerCase() === modId.toLowerCase()) return jar;
    }
  }
  return null;
}

async function shelfToClientPack(serverId: string, jar: string, log: (m: string) => void): Promise<boolean> {
  const src = join(serverDir(serverId), 'mods', jar);
  if (!existsSync(src)) return false;
  const { clientShelfDir, markClientOnly } = await import('./installer.js');
  const shelf = clientShelfDir(serverId);
  mkdirSync(shelf, { recursive: true });
  renameSync(src, join(shelf, jar));
  markClientOnly(serverId, jar);
  const { syncAutoModpack } = await import('./automodpack.js');
  await syncAutoModpack(serverId, log).catch(() => {});
  return true;
}

/** Resolve a list of MOD IDS to installed jars. A mod id is USUALLY its
    Modrinth slug, but not always ('farmersdelight' vs 'farmers-delight' —
    live 2026-08-02, a 404'd heal killed a whole batch over a dep that
    exists). Candidates: the id, an underscore-to-dash variant, then a
    Modrinth search demanding an EXACT separator-stripped match — never a
    fuzzy top hit. Returns the installed files. */
async function healMissingIds(serverId: string, ids: string[]): Promise<string[]> {
  const { install } = await import('./installer.js');
  const healed: string[] = [];
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const id of ids) {
    const candidates = [...new Set([id, id.replace(/_/g, '-')])];
    try {
      const { search } = await import('../clients/modrinth.js');
      const found = await search({ query: id, type: 'mod', limit: 8 });
      for (const hit of found.hits) {
        if (norm(hit.slug) === norm(id) || norm(hit.title) === norm(id)) {
          candidates.push(hit.project_id);
          break;
        }
      }
    } catch { /* search down — direct candidates still get their shot */ }
    for (const cand of candidates) {
      try {
        const res = await install(serverId, { projectId: cand, type: 'mod', force: true });
        if ('installed' in res && res.installed.length) {
          healed.push(...res.installed.map((i) => i.file));
          break;
        }
      } catch { /* next candidate */ }
    }
  }
  return healed;
}

// ---- ASYNC BATCHED GATE — installs must feel instant (a 30s synchronous
// dry-boot per mod made the UI sit on "Placing…", live 2026-07-21). New jars
// are collected per server; 12s after the LAST install a single dry-boot
// verifies the whole batch. FAIL → the batch is rolled back and the reason
// logged — self-healing, never a blocked click. The 12s window also means
// "add 10 mods" costs ONE boot, not ten.
const pendingBatch = new Map<string, { jars: Set<string>; timer: ReturnType<typeof setTimeout> }>();
let batchesRunning = 0;
/** pending/running batches die with the panel process — admin/exit asks
    (Better Caves shipped ungated through exactly that hole, 2026-08-02) */
export function preflightBusy(): boolean { return pendingBatch.size > 0 || batchesRunning > 0; }

export function schedulePreflight(serverId: string, newJars: string[], log: (m: string) => void): void {
  const entry = pendingBatch.get(serverId) ?? { jars: new Set<string>(), timer: setTimeout(() => {}, 0) };
  clearTimeout(entry.timer);
  for (const j of newJars) entry.jars.add(basename(j));
  entry.timer = setTimeout(() => {
    const jars = [...entry.jars];
    pendingBatch.delete(serverId);
    void (async () => {
      // never judge a HALF-INSTALLED folder: a mod spree keeps downloading
      // past any single install's completion, and a dry-boot fired into that
      // window sees a dependency as "[MISSING]" and convicts the whole batch
      // (live 2026-08-02). Re-arm and try again in 12s.
      const inst = await import('./installer.js');
      if (inst.installerBusy()) {
        schedulePreflight(serverId, jars, log);
        return;
      }
      // THE SYNC IS THE VERDICT'S TO GIVE. AutoModpack must regenerate after
      // every outcome (PASS ships the jars, rollback ships their removal) and
      // NEVER before one: an install-time sync pushed krypton to a friend's
      // client through the running server's pack regenerate, and the gate's
      // rejection 4 minutes later couldn't un-crash that client boot
      // (live 2026-07-27).
      batchesRunning++;
      try {
        await runBatch();
      } finally {
        batchesRunning--;
        const { syncAutoModpack } = await import('./automodpack.js');
        await syncAutoModpack(serverId, log).catch(() => {});
      }
    })();

    async function runBatch(): Promise<void> {
      // STATIC FAST PATH — read every jar's DECLARED mandatory deps (<1s,
      // cached) and heal what's missing BEFORE paying for a dry-boot. This
      // never rejects anything (no version matching, unknowns pass) — the
      // dry-boot below stays the only authority. A yungsapi- or
      // farmersdelight-shaped hole now costs one boot instead of
      // fail → parse → heal → boot again (live 2026-08-02, twice).
      try {
        const { scanMissingDeps } = await import('./jardeps.js');
        const scan = scanMissingDeps(serverId);
        if (scan.duplicates.length) {
          log(`preflight: DUPLICATE mod ids on ${serverId} (a signal, not junk — see the patched-architectury lesson): ${scan.duplicates.slice(0, 3).join('; ')}`);
        }
        if (scan.missing.length > 0 && scan.missing.length <= 6) {
          log(`preflight: static scan (${scan.scanned} jars) found undeclared holes on ${serverId}: ${scan.missing.map((m) => `${m} (wanted by ${scan.requesters[m]?.[0] ?? '?'})`).join(', ')} — healing before the dry-boot`);
          const healed = await healMissingIds(serverId, scan.missing);
          for (const f of healed) jars.push(basename(f)); // a later rollback must take these too
          if (healed.length) log(`preflight: statically healed ${healed.join(', ')}`);
        }
      } catch (e) {
        log(`preflight: static scan skipped (${String(e).slice(0, 80)}) — dry-boot judges as always`);
      }

      let r = await runPreflight(serverId);
      if (r.ok || r.skipped) {
        if (!r.skipped) log(`preflight: PASS ${serverId} after installing ${jars.join(', ')} (${r.seconds}s)`);
        return;
      }
      // SELF-HEAL missing dependencies before rejecting. The install-time
      // resolver can only follow deps the author DECLARED on the platform —
      // tectonic 3.0.17 declares none yet its jar demands lithostitched
      // (live 2026-07-21). The loader's own error names the missing mod id,
      // and mod ids are usually the platform slug: install what it names,
      // dry-boot again, and only reject if that still fails.
      const missing = [...new Set((r.excerpt ?? []).flatMap((l) => [
        ...[...l.matchAll(/Mod ID: '([a-z0-9_.-]+)'/gi)].map((m) => m[1]), // forge/neoforge
        ...[...l.matchAll(/Install ([a-z0-9_.-]+),/gi)].map((m) => m[1]),  // fabric's "Install x, any version"
      ]))].filter((id) => !/^(minecraft|forge|neoforge|fabric|fabricloader|java)$/.test(id));
      if (missing.length > 0 && missing.length <= 4) {
        const healed = await healMissingIds(serverId, missing);
        if (healed.length) {
          const r2 = await runPreflight(serverId);
          if (r2.ok) {
            log(`preflight: PASS ${serverId} after SELF-HEALING missing dependencies (installed ${healed.join(', ')}) for ${jars.join(', ')}`);
            return;
          }
          r = r2; // still broken — reject the batch plus what we added for it
          for (const f of healed) jars.push(basename(f));
        }
      }
      // BLAME CHECK before rollback: when the failure is a client-only mod
      // crashing the SERVER environment and the loader names a mod that is
      // NOT in the batch just installed, the batch is the messenger, not the
      // culprit. Shelf the named jar(s) to the client pack and retest — up to
      // a few rounds, because the loader stops at the FIRST broken mixin and
      // a modpack can stack several behind each other.
      const shelved: string[] = [];
      for (let round = 0; round < 4 && !r.ok; round++) {
        if (!(r.excerpt ?? []).some((l) => /in environment type SERVER/i.test(l))) break;
        let moved = false;
        for (const cid of culpritIds(r.excerpt ?? [])) {
          const jar = await findModJar(serverId, cid);
          if (jar && !jars.includes(jar) && (await shelfToClientPack(serverId, jar, log))) {
            shelved.push(jar);
            moved = true;
          }
        }
        if (!moved) break;
        r = await runPreflight(serverId);
      }
      if (shelved.length) {
        recordRejection(serverId, shelved, [
          'client-only mod — it crashes the SERVER boot, so it was moved to the synced client pack: friends still get it, the server never loads it',
        ]);
        if (r.ok) {
          log(`preflight: PASS ${serverId} after shelving client-only ${shelved.join(', ')} — batch ${jars.join(', ')} kept`);
          return;
        }
      }
      // roll back through deleteInstalled, not a bare rm: it also purges the
      // install-ledger entry — a jar deleted with its ledger record left
      // behind blocks every reinstall as a phantom "duplicate" (live
      // 2026-07-21: terralith/tectonic uninstallable after their rollback)
      const { deleteInstalled } = await import('./installer.js');
      for (const f of jars) {
        try { deleteInstalled(serverId, f); } catch { /* best effort */ }
      }
      recordRejection(serverId, jars, (r.excerpt ?? []).slice(0, 5));
      log(`preflight: REJECTED ${jars.join(', ')} on ${serverId} — rolled back. Loader said: ${(r.excerpt ?? []).slice(0, 3).join(' | ')}`);
    }
  }, 12_000);
  pendingBatch.set(serverId, entry);
}

/** Post-install gate with rollback: given the just-installed server-side jars,
    dry-boot the CURRENT mods dir; on failure delete those jars and report.
    (The jars are already committed by install() — this converts "boots at 3am
    crash" into "install rejected with the loader's own words".) */
export async function gateInstalledJars(
  serverId: string,
  installedFiles: string[],
  log?: (m: string) => void,
): Promise<PreflightResult> {
  const r = await runPreflight(serverId);
  if (r.ok || r.skipped) return r;
  const { deleteInstalled } = await import('./installer.js');
  for (const f of installedFiles) {
    try { deleteInstalled(serverId, basename(f)); } catch { /* best effort */ }
  }
  log?.(`preflight: REJECTED install on ${serverId} (${installedFiles.join(', ')}) — rolled back: ${r.reason}`);
  return r;
}

/** Read back the last dry-boot log for a server (support/debugging). */
export function lastPreflightLog(serverId: string): string | null {
  const p = join(PATHS.data, 'preflight', serverId, 'preflight.log');
  try { return readFileSync(p, 'utf8').slice(-20_000); } catch { return null; }
}

// ---- REJECTION LEDGER — the owner must SEE what the gate removed (a mod
// silently vanishing reads as a panel bug, not a save). Shown on the Content
// page; last 10 kept per server.
interface Rejection { at: string; jars: string[]; reason: string[] }

// the ledger must NOT live inside data/preflight/<id>/ — that's the dry-boot
// sandbox and every run rmSync's it, so the very next preflight erased the
// history the Content banner was about to show (live 2026-07-21)
function rejectionsFile(serverId: string): string {
  return join(PATHS.data, 'preflight-rejections', `${serverId}.json`);
}

function recordRejection(serverId: string, jars: string[], reason: string[]): void {
  mkdirSync(join(PATHS.data, 'preflight-rejections'), { recursive: true });
  let list: Rejection[] = [];
  try { list = JSON.parse(readFileSync(rejectionsFile(serverId), 'utf8')); } catch { /* first */ }
  list.push({ at: new Date().toISOString(), jars, reason });
  writeFileSync(rejectionsFile(serverId), JSON.stringify(list.slice(-10), null, 1), 'utf8');
}

/** The launch gate's join-kick self-heal writes into the SAME ledger the
    Content banner reads — a quarantined mod must be as visible as a
    preflight rejection (zero-noise: self-heal + tell the owner). */
export function recordGateHeal(serverId: string, jar: string, reason: string): void {
  recordRejection(serverId, [jar], [reason]);
}

/** The owner has read the banner and moved on — clear the ledger so an
    already-handled incident stops haunting the Content page for 48h. */
export function clearRejections(serverId: string): void {
  try { rmSync(rejectionsFile(serverId), { force: true }); } catch { /* already gone */ }
}

/** Rejections from the last 48h — surfaced in the Content page's installed view. */
export function recentRejections(serverId: string): Rejection[] {
  try {
    const list = JSON.parse(readFileSync(rejectionsFile(serverId), 'utf8')) as Rejection[];
    return list.filter((x) => Date.now() - new Date(x.at).getTime() < 48 * 3600_000);
  } catch {
    return [];
  }
}
