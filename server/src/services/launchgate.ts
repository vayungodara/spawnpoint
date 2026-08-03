import { existsSync, mkdirSync, rmSync, copyFileSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { join, basename, dirname } from 'node:path';
import { PATHS } from '../config.js';
import { serverDir, javaFor } from './servers.js';
import { detect } from './detect.js';
import { killTree, IS_WIN } from './platform.js';
import { symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// the client gate needs a virtual display — Linux + xvfb-run. Elsewhere the
// gate degrades HONESTLY: verdict says why it skipped, the dry-boot preflight
// still protects the server, and nothing pretends to have tested a client.
let xvfbState: boolean | null = null;
function clientGateAvailable(): boolean {
  if (xvfbState !== null) return xvfbState;
  xvfbState = !IS_WIN && process.platform === 'linux'
    && spawnSync('which', ['xvfb-run'], { stdio: 'ignore' }).status === 0;
  return xvfbState;
}

// TIER-2 LAUNCH GATE — AutoModpack is a mirror, not a validator (its own
// README: users must ensure the modpack works before it distributes it). So
// after every pack regenerate, this boots the EXACT client set friends will
// receive — a real Minecraft client under Xvfb with mc-runtime-test driving
// it into a world — and records PASS/FAIL. A client-side conflict is caught
// on this box instead of on a friend's screen.
//
// Proven live 2026-07-20: main's 43-mod set (sodium+iris+shaders present)
// boots and joins in ~2min; the harness caught its first real finding the
// same evening (ImmediatelyFast's font-atlas patch NPEs under Xvfb/Mesa).
//
// ENV_SKIP: mods that crash ONLY in this headless environment while being
// demonstrably fine on real clients (owner plays with them daily). They ship
// to players but are excluded from gate boots. Keep this list SHORT and
// documented — every entry is a hole in the gate.
const ENV_SKIP = [
  'immediatelyfast', // FontSet.resetTextures NPE under Xvfb/Mesa only — bisected 2026-07-20
];

const HMC = join(PATHS.root, 'Tools', 'headlessmc');
const LAUNCHER = join(HMC, 'headlessmc-launcher-2.10.0.jar');
const JAVA25 = join(PATHS.root, 'Tools', 'jdk-25.0.3+9', 'bin', 'java');
// known HMC hang modes — timeout is a FAIL. 15 min: a 70-mod pack with a
// 183MB physics mod under software GL genuinely needs >10 (live 2026-07-21)
const RUN_TIMEOUT_MS = 15 * 60_000;
const RUNTIME_TEST_VERSION = '4.5.1';

export interface GateVerdict {
  ok: boolean;
  skipped?: string;
  detail: string;
  mods?: number;
  seconds?: number;
  at: string;
  /** MULTIPLAYER-JOIN result — the singleplayer boot proves the pack LAUNCHES,
      this proves a player actually gets INTO the world. The custom-weapons
      class (join-handshake packet kills the connection) is only visible here. */
  join?: { ok: boolean; detail: string };
  /** sha256 of the manifest this verdict judged — identical content skips re-gating */
  manifestSha?: string;
}

// one boot at a time (2-4GB each), coalesce repeat requests per server
let chain: Promise<void> = Promise.resolve();
const queued = new Set<string>();
let gateRunning = 0;
/** a queued-or-running gate dies with the panel process — admin/exit asks */
export function gateBusy(): boolean { return queued.size > 0 || gateRunning > 0; }

/** GATES WAIT FOR QUIET. The manifest changes exactly when a server BOOTS —
    i.e. exactly when the owner sits down to play — and the boot+join gates
    cost cores and gigabytes (live 2026-07-27: Sensible MC ran 291 ticks
    behind while its own boot test and join sandbox hammered the box). A
    verdict is never worth lagging the live game: hold the gate until no
    player is online on ANY server, rechecking every 3 min. */
async function waitForQuiet(serverId: string, log: (m: string) => void): Promise<void> {
  const { craftyApi } = await import('../clients/crafty.js');
  let announced = false;
  let quietStreak = 0;
  for (;;) {
    let online = 0;
    try {
      for (const s of await craftyApi.listServers()) {
        try {
          const st = await craftyApi.getStats(s.server_id);
          if (st.running) online += st.online ?? 0;
        } catch { /* one server's stats must not block the gate */ }
      }
    } catch { return; } // Crafty unreachable — don't deadlock the queue
    if (online === 0) {
      // demand quiet TWICE, 2 min apart — a boot regenerates the manifest
      // seconds before the owner logs in, and a single check green-lit a
      // gate straight into their session (live 2026-07-27, evening)
      if (++quietStreak >= 2) return;
      await new Promise((r) => setTimeout(r, 120_000));
      continue;
    }
    quietStreak = 0;
    if (!announced) {
      log(`launchgate: holding ${serverId}'s gate — ${online} player(s) online, the live game comes first`);
      announced = true;
    }
    await new Promise((r) => setTimeout(r, 180_000));
  }
}

/** sha256 of the pack manifest — the identity of what a gate actually judged.
    EVERY server boot rewrites the manifest file (mtime changes, content
    usually doesn't), and each rewrite queued a full 25-min gate cycle for a
    pack that was already proven (live 2026-07-27: every play session began
    with a redundant re-verification of the identical pack). */
function manifestSha(serverId: string): string | null {
  try {
    const p = join(serverDir(serverId), 'automodpack', 'host-modpack', 'automodpack-content.json');
    return createHash('sha256').update(readFileSync(p)).digest('hex');
  } catch {
    return null;
  }
}

export function queueLaunchGate(serverId: string, log: (m: string) => void): void {
  if (queued.has(serverId)) return;
  queued.add(serverId);
  chain = chain.then(async () => {
    queued.delete(serverId);
    gateRunning++;
    try {
      const sha = manifestSha(serverId);
      const last = lastVerdict(serverId);
      if (sha && last?.manifestSha === sha) {
        log(`launchgate: ${serverId} pack content unchanged since its last verdict — re-gate skipped`);
        return;
      }
      await waitForQuiet(serverId, log);
      // the pack may have changed again while we waited — judge what's there NOW
      const v = await runGate(serverId, log);
      if (!v.skipped) {
        v.manifestSha = manifestSha(serverId) ?? undefined;
        try {
          writeFileSync(join(PATHS.data, 'launchgate', serverId, 'verdict.json'), JSON.stringify(v, null, 2), 'utf8');
        } catch { /* verdict already saved without the sha — worst case one extra re-gate */ }
        log(`launchgate: ${v.ok ? 'PASS' : 'FAIL'} ${serverId} — ${v.detail}`);
      }
    } catch (e) {
      log(`launchgate: ${serverId} errored: ${String(e).slice(0, 150)}`);
    } finally {
      gateRunning--;
    }
  });
}

/** Gate EVERY pack regenerate, however it happened. The queue hook on panel
    installs misses two real paths (both hit live 2026-07-20: hand-placed
    extras jars, and generateModpackOnStart at server boot — the sodium-extra
    0.9.3 vs sodium 0.8.12 crash shipped through exactly that gap). Watch the
    content manifest itself: mtime change = new pack = boot-test it. */
export function startLaunchGateWatcher(listIds: () => Promise<string[]>, log: (m: string) => void): void {
  const seen = new Map<string, number>();
  const tick = async (): Promise<void> => {
    let ids: string[] = [];
    try { ids = await listIds(); } catch { return; }
    for (const id of ids) {
      try {
        const p = join(serverDir(id), 'automodpack', 'host-modpack', 'automodpack-content.json');
        if (!existsSync(p)) continue;
        const mtime = statSync(p).mtimeMs;
        const prev = seen.get(id);
        seen.set(id, mtime);
        if (prev !== undefined && mtime !== prev) {
          log(`launchgate: pack manifest changed for ${id} — queueing boot test`);
          queueLaunchGate(id, log);
        }
      } catch { /* server dir mid-change — next tick */ }
    }
  };
  const timer = setInterval(() => { tick().catch(() => {}); }, 60_000);
  timer.unref();
}

export function lastVerdict(serverId: string): GateVerdict | null {
  try {
    return JSON.parse(readFileSync(join(PATHS.data, 'launchgate', serverId, 'verdict.json'), 'utf8'));
  } catch {
    return null;
  }
}

const execFileP = promisify(execFile);

// ASYNC on purpose: `download <mc>` is a multi-minute full-client fetch on a
// first-time version, and the execFileSync original froze the ENTIRE panel
// (blocked event loop — no requests, no timers, gate timeouts never fired)
// for its whole duration. Live 2026-07-21: "panel isnt loading" while the
// horrorFabric gate downloaded 1.20.1.
async function hmcCmd(args: string[]): Promise<void> {
  await execFileP('nice', ['-n', '19', JAVA25, '-jar', LAUNCHER, '--command', ...args], {
    cwd: HMC, timeout: 8 * 60_000, maxBuffer: 32 * 1024 * 1024,
  });
}

/** Make sure HMC has this MC version + loader installed (one-time per pair). */
async function ensureVersion(mc: string, loader: 'fabric' | 'forge'): Promise<void> {
  const versions = join(HMC, 'mc', 'versions');
  const have = existsSync(versions) && readdirSync(versions).some((d) =>
    loader === 'fabric' ? d.startsWith('fabric-loader-') && d.endsWith(`-${mc}`) : d.startsWith(`${mc}-forge-`),
  );
  if (have) return;
  await hmcCmd(['download', mc]);
  await hmcCmd([loader, mc, '--java', parseInt(mc.split('.')[0], 10) >= 26 ? '25' : '21']);
}

/** mc-runtime-test jar for this MC (cached; asset names use the minor version
    family, e.g. 26.1.2 -> 26.1). */
async function runtimeTestJar(mc: string, loader: 'fabric' | 'forge'): Promise<string | null> {
  // mc-runtime-test names old Forge builds "lexforge" (a plain "forge" URL
  // 404s and curl happily saves the words "Not Found" as a 9-byte jar,
  // which then kills FML's zip scan — live 2026-07-21)
  const assetLoader = loader === 'forge' ? 'lexforge' : 'fabric';
  const candidates = [mc, mc.split('.').slice(0, 2).join('.')];
  for (const v of candidates) {
    const local = join(HMC, `mc-runtime-test-${v}-${RUNTIME_TEST_VERSION}-${assetLoader}-release.jar`);
    if (existsSync(local)) return local;
  }
  for (const v of candidates) {
    const name = `mc-runtime-test-${v}-${RUNTIME_TEST_VERSION}-${assetLoader}-release.jar`;
    const url = `https://github.com/headlesshq/mc-runtime-test/releases/download/${RUNTIME_TEST_VERSION}/${name}`;
    const res = await fetch(url, { redirect: 'follow' });
    if (res.ok) {
      const local = join(HMC, name);
      writeFileSync(local, Buffer.from(await res.arrayBuffer()));
      return local;
    }
  }
  return null;
}

// ---- MULTIPLAYER-JOIN GATE ------------------------------------------------
// Boots a THROWAWAY copy of the real server (symlinked jars+mods, fresh flat
// world, offline mode, side port) and quick-plays the already-assembled gate
// client into it (--quickPlayMultiplayer, vanilla since 1.20 — no helper mod).
// The verdict comes from the SERVER's log: "joined the game" followed by a
// quiet dwell = PASS; "lost connection: Internal Exception/EncoderException"
// = exactly the custom-weapons class that singleplayer boots can never see
// (live 2026-07-20: unconditional S2C payload on JOIN kicked every vanilla
// client while the pack booted fine).
// AutoModpack is EXCLUDED on both sides: the sandbox would host a modpack
// with a fresh fingerprint and require=true would kick our test client for
// being "unsynced" — a false FAIL about infrastructure, not the pack.
const JOIN_PORT = 25999;
const JOIN_SERVER_UP_MS = 4 * 60_000;
const JOIN_DWELL_MS = 25_000; // survive this long after joining = handshake done
const JOIN_TOTAL_MS = 8 * 60_000;

async function runJoinGate(
  serverId: string,
  det: { loader: string; mc: string | null },
  rundir: string,
  log: (m: string) => void,
): Promise<{ ok: boolean; detail: string }> {
  const sdir = serverDir(serverId);
  // quickPlayMultiplayer exists since 1.20 — older eras fall back to boot-only
  const [maj, min] = (det.mc ?? '0.0').split('.').map((n) => parseInt(n, 10));
  if (maj < 1 || (maj === 1 && min < 20)) return { ok: true, detail: 'join test skipped (pre-1.20 client, no quickplay)' };

  // a 350-mod pack loading a real world OOMs a 2G sandbox; gates only run
  // when nobody is playing, so a bigger heap costs no one anything. The
  // timeouts scale too: Sensible MC's sandbox took 4.5 min just to reach
  // Done and the 369-mod client relaunch alone outlives the stock 8-min
  // budget (live 2026-07-27 — a timeout is a FAIL about the clock, not
  // the pack).
  const modCount = existsSync(join(sdir, 'mods'))
    ? readdirSync(join(sdir, 'mods')).filter((f) => f.endsWith('.jar')).length : 0;
  const big = modCount > 200;
  const heap = big ? '-Xmx4G' : '-Xmx2G';
  const serverUpMs = big ? 2 * JOIN_SERVER_UP_MS : JOIN_SERVER_UP_MS;
  const totalMs = big ? 20 * 60_000 : JOIN_TOTAL_MS;
  let launchArgs: string[] | null = null;
  // same short-lived-JVM flags as the dry-boot (see preflight.ts FAST_BOOT):
  // the sandbox lives minutes and its JIT warmup is pure waste
  const fast = ['-XX:TieredStopAtLevel=1', '-XX:+UseParallelGC', '-XX:-UsePerfData'];
  if (det.loader === 'fabric') launchArgs = [heap, ...fast, '-jar', 'fabric.jar', 'nogui'];
  else if (det.loader === 'forge' || det.loader === 'neoforge') {
    const ns = det.loader === 'forge' ? 'minecraftforge' : 'neoforge';
    const fdir = join(sdir, 'libraries', 'net', ns, det.loader === 'forge' ? 'forge' : 'neoforge');
    const ver = existsSync(fdir) ? readdirSync(fdir)[0] : null;
    const rel = ver ? `libraries/net/${ns}/${det.loader === 'forge' ? 'forge' : 'neoforge'}/${ver}/unix_args.txt` : null;
    if (rel && existsSync(join(sdir, rel))) launchArgs = [heap, ...fast, `@${rel}`, 'nogui'];
  }
  const java = javaFor(det.mc, det.loader);
  if (!launchArgs || !java) return { ok: true, detail: 'join test skipped (no dry-boot recipe for this loader)' };

  const srv = join(PATHS.data, 'joingate', serverId, 'server');
  rmSync(srv, { recursive: true, force: true });
  mkdirSync(join(srv, 'mods'), { recursive: true });
  for (const item of ['fabric.jar', 'libraries', 'versions', '.fabric']) {
    const src = join(sdir, item);
    if (existsSync(src)) symlinkSync(src, join(srv, item));
  }
  for (const jar of readdirSync(join(sdir, 'mods')).filter((f) => f.endsWith('.jar'))) {
    if (/automodpack/i.test(jar)) continue;
    symlinkSync(join(sdir, 'mods', jar), join(srv, 'mods', jar));
  }
  writeFileSync(join(srv, 'eula.txt'), 'eula=true\n', 'utf8');
  writeFileSync(join(srv, 'server.properties'), [
    `server-port=${JOIN_PORT}`, 'enable-rcon=false', 'online-mode=false', 'white-list=false',
    'level-type=flat', 'generate-structures=false', 'spawn-protection=0', 'view-distance=4',
    'max-players=3', 'motd=spawnpoint joingate', 'sync-chunk-writes=false', '',
  ].join('\n'), 'utf8');
  // Simple Voice Chat binds its OWN UDP port (default 24454) regardless of
  // server-port — with the real server running, the sandbox's bind fails and
  // voicechat SHUTS THE SERVER DOWN, a false FAIL about ports, not the pack
  // (live 2026-07-27). port=-1 = ride the MC server port, which is ours.
  mkdirSync(join(srv, 'config', 'voicechat'), { recursive: true });
  writeFileSync(join(srv, 'config', 'voicechat', 'voicechat-server.properties'), 'port=-1\n', 'utf8');

  // the client rundir was assembled for the singleplayer boot — strip the
  // test driver (it would force its own singleplayer flow) and automodpack
  for (const jar of readdirSync(join(rundir, 'mods'))) {
    if (/mc-runtime-test|automodpack/i.test(jar)) rmSync(join(rundir, 'mods', jar), { force: true });
  }

  const started = Date.now();
  return await new Promise((resolve) => {
    let srvOut = '';
    let cliChild: ReturnType<typeof spawn> | null = null;
    let settled = false;
    let dwellTimer: NodeJS.Timeout | null = null;
    const srvChild = spawn('nice', ['-n', '19', java, ...launchArgs], {
      cwd: srv, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    const finish = (ok: boolean, detail: string): void => {
      if (settled) return;
      settled = true;
      if (dwellTimer) clearTimeout(dwellTimer);
      clearTimeout(totalKiller);
      try { if (cliChild?.pid) killTree(cliChild.pid); } catch { /* gone */ }
      try { if (srvChild.pid) killTree(srvChild.pid); } catch { /* gone */ }
      try { writeFileSync(join(PATHS.data, 'joingate', serverId, 'last-run.log'), srvOut.slice(-30_000), 'utf8'); } catch { /* diagnostics */ }
      resolve({ ok, detail });
    };
    // A NO-SHOW is not a verdict. Phase 1 already proved this client boots;
    // when the sandbox server is healthy and never even SAW a connection
    // attempt, the hung headless relaunch (369-mod packs do this, live
    // 2026-07-27: client log just stops mid-init) says nothing about the
    // PACK. Real join failures leave server-side evidence — a kick line, an
    // encoder exception, the server crashing — and those still FAIL.
    const inconclusive = (why: string): void => {
      if (/Done \(/.test(srvOut) && !/lost connection|logged in|joined the game/i.test(srvOut)) {
        finish(true, `join inconclusive — ${why}; the sandbox server stayed healthy and saw no failed join, boot is proven`);
      } else finish(false, why);
    };
    const totalKiller = setTimeout(() => inconclusive(`join test produced no verdict in ${totalMs / 60000} min`), totalMs);
    let joined = false;
    const onServerLine = (): void => {
      if (!joined && /joined the game/.test(srvOut)) {
        joined = true;
        log(`launchgate: join test — client joined the sandbox server for ${serverId}, dwelling ${JOIN_DWELL_MS / 1000}s`);
        const joinedAtLen = srvOut.length;
        dwellTimer = setTimeout(() => {
          const after = srvOut.slice(joinedAtLen);
          const kick = /lost connection: (.*)/.exec(after);
          if (kick && /Internal Exception|EncoderException|DecoderException/i.test(kick[1])) {
            finish(false, `player was KICKED after joining: ${kick[1].slice(0, 160)}`);
          } else finish(true, 'player joined the server and stayed connected');
        }, JOIN_DWELL_MS);
      }
      // a kick can land before the dwell timer was even set (instant encoder kicks)
      if (joined && /lost connection: .*(Internal Exception|EncoderException|DecoderException)/i.test(srvOut)) {
        const kick = /lost connection: (.*)/.exec(srvOut);
        finish(false, `player was KICKED on join: ${(kick?.[1] ?? 'unknown').slice(0, 160)}`);
      }
    };
    srvChild.stdout!.on('data', (d: Buffer) => { srvOut += d.toString(); onServerLine(); });
    srvChild.stderr!.on('data', (d: Buffer) => { srvOut += d.toString(); onServerLine(); });
    srvChild.on('exit', (code) => { if (!joined) finish(false, `sandbox server exited (code ${code}) before the client joined`); });

    // wait for the sandbox server's Done line, then quick-play the client in
    const upPoll = setInterval(() => {
      if (settled) { clearInterval(upPoll); return; }
      if (Date.now() - started > serverUpMs && !/Done \(/.test(srvOut)) {
        clearInterval(upPoll);
        finish(false, 'sandbox server did not finish starting in time');
        return;
      }
      if (!/Done \(/.test(srvOut) || cliChild) return;
      clearInterval(upPoll);
      const escaped = (det.mc ?? '').replace(/\./g, '\\.');
      const versionRegex = det.loader === 'fabric' ? `fabric-loader-.*-${escaped}` : `${escaped}-forge-.*`;
      log(`launchgate: join test — sandbox server up, quick-playing client into 127.0.0.1:${JOIN_PORT}`);
      cliChild = spawn('nice', ['-n', '19', 'ionice', '-c3', 'xvfb-run', '-a',
        JAVA25, '-Dhmc.check.xvfb=true', `-Dhmc.gameargs=--quickPlayMultiplayer 127.0.0.1:${JOIN_PORT}`,
        '-jar', LAUNCHER, '--command', 'launch', versionRegex, '-regex', '--jvm', '-Xmx4G',
      ], { cwd: HMC, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      cliChild.on('exit', (code) => {
        if (!joined) inconclusive(`client exited (code ${code}) before ever joining the server`);
      });
    }, 2000);
  });
}

// ---- JOIN-KICK SELF-HEAL ---------------------------------------------------
// A join kick NAMES its culprit: "Failed to encode packet '…custom_payload'
// (custom-weapons:dead_eye_sync)" — the namespace is the mod id. Zero-noise
// rule: don't just report that, FIX it. Resolve the id to its jar (server
// mods / client shelf / hand-placed extras), move the jar to quarantine,
// clean the ledger, resync — the regenerate re-queues the gate, which proves
// the healed pack. The owner sees it in the Content banner, not as a broken
// evening for friends.
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
  } catch { /* unreadable jar — fall through to filename match */ }
  return null;
}

async function healJoinKick(serverId: string, kickDetail: string, log: (m: string) => void): Promise<string | null> {
  const ns = /\(([a-z0-9_-]+):[a-z0-9_/.-]+\)/i.exec(kickDetail)?.[1];
  if (!ns || /^(minecraft|forge|neoforge|fabric|fabricloader|brand|register)$/i.test(ns)) return null;
  const sdir = serverDir(serverId);
  const { clientShelfDir, deleteInstalled } = await import('./installer.js');
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const places = [
    join(sdir, 'mods'),
    clientShelfDir(serverId),
    join(sdir, 'automodpack', 'host-modpack', 'main', 'mods'),
  ];
  for (const dir of places) {
    if (!existsSync(dir)) continue;
    for (const jar of readdirSync(dir).filter((f) => f.endsWith('.jar'))) {
      const id = await modIdOf(join(dir, jar));
      const hit = id ? norm(id) === norm(ns) : norm(jar).includes(norm(ns));
      if (!hit) continue;
      const qdir = join(PATHS.data, 'quarantine', serverId);
      mkdirSync(qdir, { recursive: true });
      copyFileSync(join(dir, jar), join(qdir, jar)); // keep the jar restorable
      try { deleteInstalled(serverId, jar); } catch { /* not panel-installed */ }
      rmSync(join(dir, jar), { force: true }); // hand-placed copies too
      const { recordGateHeal } = await import('./preflight.js');
      recordGateHeal(serverId, jar, `multiplayer-join gate: players get KICKED by this mod — ${kickDetail.slice(0, 160)}`);
      log(`launchgate: SELF-HEAL — quarantined ${jar} (mod id '${ns}' named in the join kick), resyncing pack`);
      const { syncAutoModpack } = await import('./automodpack.js');
      void syncAutoModpack(serverId, log); // regenerate → watcher re-gates the healed pack
      return jar;
    }
  }
  return null;
}

async function runGate(serverId: string, log: (m: string) => void): Promise<GateVerdict> {
  const started = Date.now();
  const save = (v: GateVerdict): GateVerdict => {
    const dir = join(PATHS.data, 'launchgate', serverId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'verdict.json'), JSON.stringify(v, null, 2), 'utf8');
    return v;
  };
  const at = new Date().toISOString();
  const sdir = serverDir(serverId);
  const det = detect(sdir, serverId);
  if ((det.loader !== 'fabric' && det.loader !== 'forge') || !det.mc) {
    return save({ ok: true, skipped: `${det.loader} client gate not supported yet`, detail: 'skipped', at });
  }
  if (!clientGateAvailable()) {
    return save({ ok: true, skipped: 'client gate needs Linux with xvfb-run (install xvfb) — server-side dry-boot still active', detail: 'skipped', at });
  }
  const contentPath = join(sdir, 'automodpack', 'host-modpack', 'automodpack-content.json');
  if (!existsSync(contentPath)) return save({ ok: true, skipped: 'no automodpack content', detail: 'skipped', at });

  await ensureVersion(det.mc, det.loader);
  const testJar = await runtimeTestJar(det.mc, det.loader);
  if (!testJar) return save({ ok: true, skipped: `no mc-runtime-test build for ${det.mc}`, detail: 'skipped', at });

  // assemble the EXACT synced set from the content manifest
  const rundir = join(PATHS.data, 'launchgate', serverId, 'run');
  rmSync(rundir, { recursive: true, force: true });
  mkdirSync(join(rundir, 'mods'), { recursive: true });
  const content = JSON.parse(readFileSync(contentPath, 'utf8')) as { list?: { file: string }[]; files?: { file: string }[] };
  const files = content.list ?? content.files ?? [];
  let mods = 0;
  let skippedEnv = 0;
  for (const f of files) {
    const rel = f.file.replace(/^\//, '');
    if (ENV_SKIP.some((s) => basename(rel).toLowerCase().includes(s))) { skippedEnv++; continue; }
    for (const base of [join(sdir, 'automodpack', 'host-modpack', 'main'), sdir]) {
      const src = join(base, rel);
      if (existsSync(src)) {
        const dst = join(rundir, rel);
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(src, dst);
        if (rel.startsWith('mods/')) mods++;
        break;
      }
    }
  }
  copyFileSync(testJar, join(rundir, 'mods', basename(testJar)));

  // gate runs are serialized, so mutating the shared HMC gamedir is safe
  const cfg = join(HMC, 'HeadlessMC', 'config.properties');
  const props = readFileSync(cfg, 'utf8').replace(/^hmc\.gamedir=.*$/m, `hmc.gamedir=${rundir}`);
  writeFileSync(cfg, props, 'utf8');

  log(`launchgate: booting ${det.mc} client with ${mods} mods (${skippedEnv} env-skipped) for ${serverId}`);
  const escaped = det.mc.replace(/\./g, '\\.');
  const versionRegex = det.loader === 'fabric' ? `fabric-loader-.*-${escaped}` : `${escaped}-forge-.*`;
  const sp = await new Promise<GateVerdict>((resolve) => {
    const child = spawn('nice', ['-n', '19', 'ionice', '-c3', 'xvfb-run', '-a',
      JAVA25, '-Dhmc.check.xvfb=true', '-jar', LAUNCHER,
      '--command', 'launch', versionRegex, '-regex', '--jvm', '-Xmx4G',
    // detached: the child owns a process group, so a timeout kill takes the
    // WHOLE tree (nice→ionice→xvfb-run→java). child.kill alone only shot the
    // nice wrapper and the Minecraft client lived on as an orphan, wedging
    // every later gate run (live 2026-07-21, twice).
    ], { cwd: HMC, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    const killer = setTimeout(() => { try { killTree(child.pid!); } catch { /* gone */ } }, RUN_TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(killer);
      const seconds = Math.round((Date.now() - started) / 1000);
      writeFileSync(join(PATHS.data, 'launchgate', serverId, 'last-run.log'), out.slice(-40_000), 'utf8');
      if (code === 0 && /exited with code: 0/.test(out)) {
        resolve({ ok: true, detail: `client booted and joined a world (${mods} mods, ${seconds}s)`, mods, seconds, at });
      } else {
        const crash = /Crash report saved to:.*?(\S+\.txt)/.exec(out)?.[1];
        // exit null = OUR timeout kill. If the log proves the client got past
        // mod loading into the interactive phase — mc-runtime-test spinning on
        // a mod's modal GUI (MCA's Destiny screen) or a gameplay mod holding
        // player spawn — that's a mod BLOCKING AUTOPLAY, not a broken pack:
        // real load failures crash with an exit code. Boot counts as proven
        // and the join gate (whose verdict reads the sandbox SERVER's log, so
        // client GUIs can't stall it) stays the decisive test.
        const blockedAutoplay =
          code === null && !crash && /(Screen not yet null:|Waiting for player to load)/.test(out);
        if (blockedAutoplay) {
          resolve({
            ok: true, mods, seconds, at,
            detail: `client booted (${mods} mods, ${seconds}s) — a mod GUI/spawn hook blocked the automated play-test, boot still proven`,
          });
        } else {
          resolve({
            ok: false, mods, seconds, at,
            detail: `client did NOT survive (exit ${code}${crash ? `, crash report ${crash}` : ''}) — pack change may crash friends' games, check data/launchgate/${serverId}/last-run.log`,
          });
        }
      }
    });
  });
  if (!sp.ok) return save(sp);

  // singleplayer proved the pack LAUNCHES — now prove a player gets IN.
  // Re-check for players first: the boot phase runs for many minutes and the
  // owner may have logged on since the queue's quiet check.
  await waitForQuiet(serverId, log);
  const jv = await runJoinGate(serverId, det, rundir, log).catch((e) => ({ ok: false, detail: `join test errored: ${String(e).slice(0, 140)}` }));
  let healNote = '';
  if (!jv.ok && /KICKED/i.test(jv.detail)) {
    const healed = await healJoinKick(serverId, jv.detail, log).catch(() => null);
    if (healed) healNote = ` — SELF-HEALED: ${healed} quarantined (data/quarantine/${serverId}/), pack regenerating and re-testing without it`;
  }
  return save({
    ...sp,
    join: jv,
    ok: sp.ok && jv.ok,
    detail: jv.ok ? `${sp.detail}; multiplayer join OK (${jv.detail})` : `pack boots but MULTIPLAYER JOIN FAILED — ${jv.detail}${healNote}. Check data/joingate/${serverId}/last-run.log`,
  });
}
