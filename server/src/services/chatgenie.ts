import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import AdmZip from 'adm-zip';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, renameSync, openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS, loadSettings } from '../config.js';
import { craftyApi } from '../clients/crafty.js';
import { rconBatch, rconCommand } from '../clients/rcon.js';
import { serverPhase } from './phase.js';
import { detect } from './detect.js';
import { serverDir } from './servers.js';
import { isComponentEra, atLeast } from './mcversion.js';
import { listInstalled } from './installer.js';
import { listConfigs, readConfig, writeConfig } from './modconfigs.js';
import { youtubeResearch } from './youtube.js';
import { wikiLookup } from './wiki.js';
import { loadNotes, addNote, listBlueprints, getBlueprint, saveBlueprint, renderBlueprint, addEpisode, similarEpisodes, addRemedy, loadRemedies } from './geniememory.js';
import { listSchematics, stagePlacement } from './schematics.js';
import { takeSnapshot, boxFromCommands, boxFromBlueprint, undoLast } from './undo.js';
import type { Box } from './undo.js';
import { ledgerMark, ledgerAudit, unionBox } from './ledgerverify.js';
import { KILLABLE_SPAWN_OPTS, killTree } from './platform.js';

// The chat genie: an allowlisted player types `server <anything>` in game
// chat, the panel asks Claude (headless `claude -p`) to translate the wish
// into console commands, and runs them over RCON seconds later.
// Explicitly authorized by the owner. Guardrails: allowlisted requesters
// only, admin commands blocked, bounded command count, one wish at a time.

const CONFIG_FILE = join(PATHS.data, 'chatgenie.json');
const POLL_MS = 800; // chat is a local file tail — cheap to watch closely
// a redstone build is hundreds of setblocks, so the ceiling is high; simple
// wishes still cost one round of two commands
const MAX_CMDS = 120;
// Owner granted full in-game authority, admin commands included (kick, op,
// whitelist, ban). Only `stop` stays blocked: it would kill the server the
// genie lives in, and no in-game wish is served by that — use the panel.
// Start-anchoring this was a hole: the prompt PUSHES the model to wrap commands
// ("NEVER use ~ ~ ~ at top level — wrap it: execute at <name> run <cmd>"), and
// `execute at Steve run stop` is not start-anchored, so it sailed through
// and would have shut down the very server the genie is talking from. Match the
// bare command AND anything behind a `run`.
const BLOCKED = /(^|\brun\s+)\/?\s*(stop|save-off)\b/i;
// publish-readiness knob (2026-07-22): commandPolicy 'no-admin' additionally
// blocks permission-granting/moderation commands so allowlisted players can't
// op themselves. DEFAULT IS 'full' — the owner's own genie keeps its complete
// power; only a public deployment that opts in gets the tighter tier.
const ADMIN_BLOCKED = /(^|\brun\s+)\/?\s*(stop|save-off|op|deop|whitelist|ban|ban-ip|pardon|pardon-ip|kick)\b/i;
export function isBlockedCmd(line: string): boolean {
  const policy = loadGenie().commandPolicy ?? 'full';
  return (policy === 'no-admin' ? ADMIN_BLOCKED : BLOCKED).test(line);
}

export interface GenieConfig {
  enabled: boolean; // master switch
  players: string[]; // who may command the genie
  servers: Record<string, boolean>; // per-server opt-in (missing = off)
  /** 'full' (default) = everything but stop/save-off; 'no-admin' also blocks
      op/ban/whitelist/kick — for deployments where genie players aren't the
      owner's own trusted friends. */
  commandPolicy?: 'full' | 'no-admin';
}

const DEFAULTS: GenieConfig = { enabled: true, players: [], servers: {} };

export function loadGenie(): GenieConfig {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, ''));
    return { ...DEFAULTS, ...raw, servers: raw.servers ?? {} };
  } catch {
    return { ...DEFAULTS, servers: {} };
  }
}

export function saveGenie(cfg: Partial<GenieConfig>): GenieConfig {
  const cur = loadGenie();
  const clean: GenieConfig = {
    enabled: !!(cfg.enabled ?? cur.enabled),
    players: Array.isArray(cfg.players) ? cfg.players.map(String).slice(0, 10) : cur.players,
    servers: { ...cur.servers, ...(cfg.servers ?? {}) },
    commandPolicy: cfg.commandPolicy === 'no-admin' || cfg.commandPolicy === 'full' ? cfg.commandPolicy : cur.commandPolicy,
  };
  mkdirSync(PATHS.data, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}

// conversation memory: the last dozen exchanges per server, injected into
// every prompt so "fix the farm you just built" needs no re-explaining
const HISTORY_FILE = join(PATHS.data, 'genie-history.json');
interface HistEntry { player: string; wish: string; verdict: string; at: string }

function loadHistory(): Record<string, HistEntry[]> {
  try {
    return JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function pushHistory(id: string, entry: HistEntry): void {
  const all = loadHistory();
  all[id] = [...(all[id] ?? []), entry].slice(-12);
  mkdirSync(PATHS.data, { recursive: true });
  writeFileSync(HISTORY_FILE, JSON.stringify(all, null, 2), 'utf8');
}

// tail state per server: byte offset into logs/latest.log
const offsets = new Map<string, number>();
// one wish runs at a time per server (parallel wishes would fight over the
// same player's inventory/position); extras wait their turn in this queue
interface Job { player: string; wish: string; secret: boolean }
// Wishes run CONCURRENTLY — each is its own `claude -p`, and a slow build no
// longer blocks a quick "give me a stick" behind it. Beyond MAX_PARALLEL they
// wait in a short queue. They are not serialized because in practice wishes
// touch different things; the model is told to work in absolute coordinates,
// so two overlapping wishes don't fight over "~ ~ ~".
const MAX_PARALLEL = 3;
const running = new Map<string, number>();
// per-server wish activity windows — the Ledger audit can only attribute block
// changes to THIS wish when no other wish overlapped [mark, audit]; Ledger's
// source column says 'command', not which wish. Finished windows are retained
// briefly so a quick wish that started AND finished inside a slow wish's
// window still disqualifies the audit.
const wishWindows = new Map<string, { t0: number; t1: number | null }[]>();
const queues = new Map<string, Job[]>();
const MAX_QUEUE = 5;

/** The server's MC version, memoised — genieLine runs on every chat line and
 *  must not stat the disk each time. 60s is short enough that a version switch
 *  settles on its own. */
const MC_CACHE = new Map<string, { mc: string | null; at: number }>();
function mcOf(id: string): string | null {
  const hit = MC_CACHE.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.mc;
  const mc = detect(serverDir(id), id).mc;
  MC_CACHE.set(id, { mc, at: Date.now() });
  return mc;
}

/** Text components were renamed in 1.21.5: `hoverEvent`/`contents` became
 *  `hover_event`/`value`. The trap is that an OLD server does NOT reject the new
 *  key — its component parser ignores unknown fields silently. Verified live on
 *  1.20.1: malformed JSON is rejected ("Invalid chat component: End of input"),
 *  but `hover_event` parses fine and the tooltip simply never renders. So this
 *  bug is invisible from the server side: the genie looks like it works, and
 *  every hover on the 1.20.1 server was quietly dead. Branch on the version. */
function hoverOf(mc: string | null, text: string): Record<string, unknown> {
  return atLeast(mc, '1.21.5')
    ? { hover_event: { action: 'show_text', value: text } }
    : { hoverEvent: { action: 'show_text', contents: text } };
}

/** Chat output: one consistent, colored line per wish, tagged with a snippet
    of the wish so parallel genies never blur together. Hovering the line
    shows the full wish. Chat is for RESULTS only — progress goes to the
    action bar, the way big servers keep their chat clean. */
function genieLine(id: string, player: string, secret: boolean, wish: string, text: string, color: string): string {
  const tag = wish.length > 22 ? `${wish.slice(0, 22).trim()}…` : wish;
  const hover = hoverOf(mcOf(id), `wish: ${wish}`);
  const parts = [
    { text: secret ? '🤫 ' : '✦ ', color: secret ? 'light_purple' : 'aqua' },
    { text: 'genie', color: secret ? 'light_purple' : 'aqua', bold: true, ...hover },
    { text: ' · ', color: 'dark_gray' },
    { text: tag, color: 'gray', italic: true, ...hover },
    { text: ' — ', color: 'dark_gray' },
    { text, color },
  ];
  return `tellraw ${player} ${JSON.stringify(parts)}`;
}

/** A bullet under a genie answer: indented, one point per line. Rundown
    points are usually "Topic: description" — the topic gets the bright color
    so the list scans like a table instead of a uniform gray wall. */
function genieBullet(player: string, text: string): string {
  const kv = /^([^:]{2,40}):\s+(\S.*)$/.exec(text);
  const parts: Record<string, unknown>[] = [{ text: '   ▪ ', color: 'dark_aqua' }];
  if (kv) {
    parts.push({ text: kv[1], color: 'aqua' }, { text: ' — ', color: 'dark_gray' }, { text: kv[2], color: 'gray' });
  } else {
    parts.push({ text, color: 'gray' });
  }
  return `tellraw ${player} ${JSON.stringify(parts)}`;
}

/** Working-state updates live on the ACTION BAR (the line above the hotbar):
    it updates in place and fades by itself, so "on it… / checking the wiki…"
    never clutters chat. */
function genieBar(player: string, secret: boolean, wish: string, text: string): string {
  const tag = wish.length > 18 ? `${wish.slice(0, 18).trim()}…` : wish;
  const parts = [
    { text: secret ? '🤫 ' : '✦ ', color: secret ? 'light_purple' : 'aqua' },
    { text: `${tag} `, color: 'gray', italic: true },
    { text, color: 'white' },
  ];
  return `title ${player} actionbar ${JSON.stringify(parts)}`;
}

/** Event sounds, Hypixel-style: a ding you can feel without reading chat. */
const SOUND = {
  done: 'minecraft:entity.player.levelup',
  say: 'minecraft:entity.experience_orb.pickup',
  fail: 'minecraft:entity.villager.no',
  tick: 'minecraft:ui.button.click',
} as const;
function genieSound(player: string, s: keyof typeof SOUND): string {
  return `execute at ${player} run playsound ${SOUND[s]} master ${player} ~ ~ ~ 0.8 1`;
}

function readNewLines(id: string): string[] {
  const file = join(PATHS.craftyServers, id, 'logs', 'latest.log');
  if (!existsSync(file)) return [];
  const size = statSync(file).size;
  let off = offsets.get(id);
  if (off === undefined || off > size) {
    // first sight or log rotated — start from the end, only future chat counts
    offsets.set(id, size);
    return [];
  }
  if (size === off) return [];
  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(size - off);
  readSync(fd, buf, 0, buf.length, off);
  closeSync(fd);
  offsets.set(id, size);
  return buf.toString('utf8').split(/\r?\n/).filter(Boolean);
}

/** A web lookup costs ~1-3 minutes of the player's time, so it is only worth
    it for wishes whose ANSWER is a design or a version-specific mechanic
    ("build me an iron farm"). "give me 64 apples" needs no research and must
    stay a seconds-long round-trip, so those spawn with no tools at all. */
function needsWeb(wish: string): boolean {
  // Over-routing has NO recovery path (a 'make time day' on the deep tier just
  // burns 30s+), while under-routing self-heals via ESCALATE — so this list is
  // deliberately tight. Bare 'make'/'craft'/'recipe'/'redstone' routed trivial
  // gives to Opus (live log: 'make time day', 'give us stone and redstone
  // dust'); 'make' now only counts with a build-noun object.
  return (
    // 'orchestrat|jumpscare' added 2026-07-18 from real wish history — multi-mob
    // orchestration needs the deep tier's planning; single spawns stay fast
    /\b(build|construct|farm|generator|contraption|machine|design|automat|circuit|orchestrat|jumpscare|how (do|does|to)|best way|tips?|strategy)\b/i.test(wish) ||
    /\bmake\s+(me\s+|us\s+)?(a|an)\s+(\w+\s+)?(house|base|castle|tower|bridge|wall|maze|arena|trap|farm|structure)\b/i.test(wish)
  );
}

/** A bare directory for the genie subprocess to run in — no CLAUDE.md, no
    project skills, nothing to inject. */
let genieCwdPath: string | null = null;
function genieCwd(): string {
  if (!genieCwdPath) {
    genieCwdPath = join(PATHS.data, 'genie-cwd');
    mkdirSync(genieCwdPath, { recursive: true });
  }
  return genieCwdPath;
}

// ---- WARM GENIE ----
// A `claude -p` invoked with no prompt sits reading stdin — which means the
// expensive part of a wish (node boot, CLI init, auth) can be PRE-PAID before
// the wish exists. One fast-tier process is kept warm at all times: a wish
// takes it, writes its prompt, and a replacement starts warming immediately.
// This is the difference between the genie and the concierge: the concierge
// is always awake. Now the genie is too. Deep-tier (opus) runs are rare and
// long anyway — they spawn cold. Warm children are recycled after 10 minutes
// (staleness) and killed on panel exit (they're detached; without the exit
// hook a deploy would orphan one).
function claudeArgs(web: boolean): string[] {
  // NO TOOLS AT ALL — deliberately. When the model had WebSearch/WebFetch it
  // spent whole 5-minute budgets inside its own browse loop and emitted zero
  // commands. Research happens OUT OF BAND via WIKI/YOUTUBE lines. Deny EVERY
  // tool: live test 2026-07-18 showed the model fumbling leftover tools and
  // the owner's Claude-Code skills. Text lines only.
  // --safe-mode skips the OWNER's hooks/plugins/skills (superpowers, Vercel
  // greeters …) which leaked into every wish as system-reminders the model had
  // to spend rounds explicitly ignoring — visible all over the 2026-07-18
  // trails. NOT --bare: bare also skips OAuth and the genie can't log in.
  // deep tier pins claude-opus-5 EXPLICITLY (verified live 2026-07-26 with the
  // genie's own token) — the bare 'opus' alias resolves to whatever the
  // installed CLI maps it to, which lags model launches
  return ['-p', '--safe-mode', '--model', web ? 'claude-opus-5' : 'sonnet', '--disallowedTools',
    'Bash,Write,Edit,NotebookEdit,Task,WebSearch,WebFetch,Read,Glob,Grep,LS,Skill,TodoWrite,BashOutput,KillShell,NotebookRead,TaskCreate,TaskUpdate,TaskList,TaskGet,TaskStop,EnterPlanMode,ExitPlanMode,AskUserQuestion,Agent,SendMessage,Monitor,Workflow,ToolSearch'];
}

function spawnClaude(web: boolean): ChildProcessWithoutNullStreams {
  const child = spawn('claude', claudeArgs(web).join(' ') === '' ? [] : claudeArgs(web), {
    shell: true,
    // an EMPTY cwd: spawning in the panel's own directory injected the
    // Spawnpoint CLAUDE.md (and project skills) into every wish
    cwd: genieCwd(),
    ...KILLABLE_SPAWN_OPTS,
    // build tier thinks deeply; everyday wishes skip thinking entirely.
    // Installs without a system-wide Claude login can put an API key in the
    // panel settings (wizard step 3); it only ever travels via spawn env.
    env: {
      ...process.env,
      MAX_THINKING_TOKENS: web ? '6000' : '0',
      ...(loadSettings().anthropicApiKey ? { ANTHROPIC_API_KEY: loadSettings().anthropicApiKey! } : {}),
    },
  });
  // a claude that dies before draining stdin emits EPIPE on this stream;
  // without a listener that's an uncaughtException that kills the PANEL
  child.stdin?.on('error', () => {});
  return child;
}

let warmChild: ChildProcessWithoutNullStreams | null = null;
let warmSince = 0;
function heatOne(): void {
  if (warmChild) return;
  try {
    const c = spawnClaude(false);
    warmChild = c;
    warmSince = Date.now();
    c.on('error', () => { if (warmChild === c) warmChild = null; });
    // forget a dead child so ensureWarm's next beat replaces it — but never
    // respawn from here: a crash-looping claude would fork-bomb. The
    // heartbeat caps spawns at 1/min.
    c.on('close', () => { if (warmChild === c) warmChild = null; });
    // CLI ≥2.1.214 aborts -p mode after 3 SECONDS of silent stdin ("no stdin
    // data received in 3s") — a byte sent immediately makes it wait for EOF
    // instead (verified: 20s gap, correct answer). Without this the warm
    // child died 3s after every heat and warm mode silently never ran.
    c.stdin.write('\n');
  } catch { warmChild = null; }
}
/** Heartbeat: keep exactly one live, fresh warm child at all times. Recycles
    stale (>10 min) or dead children and re-heats after natural deaths — the
    original design only re-heated on take, so one quiet death left the genie
    permanently cold until the next wish. Each beat also drips a newline into
    the live child's stdin so no idle-stream timeout can hit between beats
    (leading blank lines are harmless prompt whitespace). */
function ensureWarm(): void {
  if (warmChild && (warmChild.exitCode !== null || Date.now() - warmSince >= 10 * 60_000)) {
    if (warmChild.pid) { try { killTree(warmChild.pid); } catch { /* already gone */ } }
    warmChild = null;
  }
  if (warmChild) { try { warmChild.stdin.write('\n'); } catch { /* close handler cleans up */ } }
  heatOne();
}
function takeClaude(web: boolean): ChildProcessWithoutNullStreams {
  if (!web && warmChild && warmChild.exitCode === null && Date.now() - warmSince < 10 * 60_000) {
    const c = warmChild;
    warmChild = null;
    setTimeout(heatOne, 50).unref?.(); // start warming the next one immediately
    return c;
  }
  // stale/absent warm child: recycle it and go cold this once
  if (warmChild && (warmChild.exitCode !== null || Date.now() - warmSince >= 10 * 60_000)) {
    if (warmChild.pid) killTree(warmChild.pid);
    warmChild = null;
    setTimeout(heatOne, 50).unref?.();
  }
  return spawnClaude(web);
}
// never orphan a detached warm child across a deploy
process.on('exit', () => { if (warmChild?.pid) try { killTree(warmChild.pid); } catch { /* dying anyway */ } });

function askClaude(prompt: string, web: boolean, onLine?: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    // prompt goes via STDIN — passing it as an argv through the Windows
    // shell mangles quotes/newlines (the model once received just "You")
    const child = takeClaude(web);
    // a claude that dies before draining stdin emits EPIPE on this stream;
    // without a listener that's an uncaughtException that kills the PANEL
    child.stdin.on('error', () => {});
    child.stdin.write(prompt);
    child.stdin.end();
    let out = '';
    let err = '';
    let buf = '';
    let timedOut = false;
    child.stdout.on('data', (d) => {
      // first output cancels the dead-air kill — a slow-but-streaming run lives
      if (inactivity) { clearTimeout(inactivity); inactivity = null; }
      out += d;
      if (!onLine) return;
      // STREAMING: hand each completed line to the caller the moment it
      // exists — commands execute while the model is still writing the rest
      buf += d;
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl < 0) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try { onLine(line); } catch { /* consumer errors must not kill the stream */ }
      }
    });
    child.stderr.on('data', (d) => (err += d));

    // spawn's own `timeout` is useless here: it signals the cmd.exe wrapper,
    // and the real `claude` grandchild lives on — a wish once hung for 8+
    // minutes with the promise never settling, silently holding a slot.
    // taskkill /T tears down the whole tree.
    // a real build takes the model ~3 minutes to write out; give it room. Even
    // an "easy" wish gets 3 minutes, because 90s killed wishes that were merely
    // looking something up ("mega TNT" died mid-lookup with nothing to show).
    const budget = web ? 480_000 : 180_000;
    const watchdog = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, budget);
    // DEAD-AIR KILL, fast tier only: thinking is off there, healthy replies
    // start streaming in single-digit seconds — 60s of total silence is a hung
    // run, and sitting out the full 180s budget with zero output is exactly the
    // "remove the mansion" failure (FAILED after 180s, nothing ran). The deep
    // tier is exempt: 6000 thinking tokens can legitimately precede all stdout.
    let noOutput = false;
    let inactivity: NodeJS.Timeout | null = null;
    if (!web) {
      inactivity = setTimeout(() => {
        noOutput = true;
        if (child.pid) killTree(child.pid);
      }, 60_000);
      inactivity.unref?.();
    }

    child.on('close', (code) => {
      clearTimeout(watchdog);
      if (inactivity) clearTimeout(inactivity);
      if (noOutput) return reject(new Error('NO_OUTPUT: no reply started within 60s'));
      if (timedOut) return reject(new Error(`thinking took longer than ${budget / 1000}s`));
      // last line often has no trailing newline — deliver it before finishing
      if (onLine && buf.trim()) { try { onLine(buf); } catch { /* ignore */ } }
      // a killed-mid-thought run can still have produced usable output
      if (code === 0 || out.trim()) return resolve(out);
      reject(new Error(err.slice(0, 200) || `claude exited ${code}`));
    });
    child.on('error', (e) => {
      clearTimeout(watchdog);
      reject(e);
    });
  });
}

// A wish can arrive on the quiet channel: a whisper (/msg, /tell, /w — ONLY on
// servers with WhisperMod; no server on this fleet logs whispers natively, so
// everywhere else whispers silently vanish and the panel hints "shh" instead)
// or a "shh …" chat line. Nobody else sees a whisper, and nobody on this
// server is op — so console command feedback is broadcast to no one. The
// genie's own replies already go out as tellraw to the requester alone. In
// secret mode we additionally forbid the model from making any public noise.
// Note: on a no-WhisperMod server even "shh" leaks the WISH TEXT to public
// chat — true secrecy there needs a server-side logging mod or panel input.
const SECRET_RULES = [
  ``,
  `SECRET MODE — this wish arrived on the quiet channel. The other players must NOT learn the genie did anything:`,
  `- NEVER use say, "tellraw @a", "title @a", bossbar, or any command that writes to other players' chat or screen.`,
  `- Address ONLY the requester (tellraw <name> …) and only if you need to; I already report the outcome to them privately.`,
  `- Prefer invisible mechanics: always pass the final "true" to "effect give" so particles are hidden; use "give"/"item replace" rather than dropping items in the world where others can see them.`,
  `- If the wish is inherently visible in the world (lightning, a summoned mob, a built structure), just do it — but do not announce it.`,
].join('\n');


/** The syntax facts that CHANGE with the version. Everything the genie is told
    about items has to come from here, never from a hardcoded example. */
const ITEM_SYNTAX = (mc: string | null | undefined): string[] =>
  isComponentEra(mc)
    ? [
        `- ITEMS USE COMPONENTS in this version (${mc ?? 'modern'}), and the enchantment map is FLAT: give <player> minecraft:diamond_pickaxe[enchantments={"minecraft:efficiency":5,"minecraft:unbreaking":3,"minecraft:mending":1}] 1`,
        `  There is NO "levels" wrapper: [enchantments={levels:{...}}] is the OLD pre-1.20.5 shape and this server REJECTS it with "Malformed 'minecraft:enchantments' component" — the player gets NOTHING. Old {Enchantments:[{id:...,lvl:...}]} NBT is also dead here.`,
        `- ARMOURING A SUMMONED MOB uses the equipment compound: summon minecraft:zombie ~ ~ ~ {equipment:{head:{id:"minecraft:leather_helmet",count:1}},PersistenceRequired:1b}. The old ArmorItems:[...] list is DEAD here — and this is a SILENT trap: summon ACCEPTS unknown NBT keys without any error, so a wrong-era tag produces no failure message at all. The mob simply spawns naked and burns at dawn. Nothing will warn you: check the mob after summoning it.`,
        `- ATTRIBUTES have no "generic." prefix here: attribute <player> minecraft:max_health base set 40 (NOT minecraft:generic.max_health — that is rejected with "Can't find element").`,
      ]
    : [
        `- ITEMS USE NBT TAGS in this version (${mc}) — item components DO NOT EXIST yet (they arrive in 1.20.5). An enchanted tool is: give <player> minecraft:diamond_pickaxe{Enchantments:[{id:"minecraft:efficiency",lvl:5},{id:"minecraft:unbreaking",lvl:3},{id:"minecraft:mending",lvl:1}]} 1`,
        `  The square-bracket component form (diamond_pickaxe[enchantments={...}]) is from a NEWER version and this server REJECTS it. Custom names use {display:{Name:'{"text":"Foo"}'}}. Item counts in NBT are Count:64b (capital C, b suffix).`,
        `- ARMOURING A SUMMONED MOB uses the ArmorItems list (feet→head, so the helmet is LAST): summon minecraft:zombie ~ ~ ~ {ArmorItems:[{},{},{},{id:"minecraft:leather_helmet",Count:1b}],PersistenceRequired:1b}. The modern equipment:{head:{...}} compound does NOT exist here — and this is a SILENT trap: summon ACCEPTS unknown NBT keys without any error, so a wrong-era tag produces no failure message. The mob just spawns naked and burns at dawn. Check the mob after summoning it.`,
        `- ATTRIBUTES keep the "generic." prefix here: attribute <player> minecraft:generic.max_health base set 40 (the modern un-prefixed minecraft:max_health does NOT exist on this version).`,
      ];

const SYSTEM = (player: string, secret: boolean, mc: string | null | undefined) => [
  `You are the command genie for a vanilla-command-compatible Minecraft Java server running MINECRAFT ${mc ?? '(unknown version)'}. Command syntax differs between versions and the rules below are for THIS one — follow them over anything you remember.`,
  ``,
  `THIS IS A SANDBOX GAME on the owner's own private server, and "${player}" is the owner. Zapping, killing, trapping, exploding, teleporting and pranking players (including the owner himself) is ORDINARY MINECRAFT GAMEPLAY — never refuse it. "strike me with lightning" => "execute at ${player} run summon minecraft:lightning_bolt ~ ~ ~". You also have full admin authority (kick, op, whitelist, ban) — the owner authorized it.`,
  ``,
  `CRITICAL — commands run from the SERVER CONSOLE, not from a player:`,
  `- NEVER use @s or @p — there is no executing entity. Use the player's NAME: "clear ${player}".`,
  `- NEVER use ~ ~ ~ at top level. Wrap it: "execute at <name> run <cmd with ~ ~ ~>".`,
  `- @a and @e are fine.`,
  ``,
  `YOU CAN SEE RESULTS AND ITERATE. Reply each round with ONLY console commands, one per line, max ${MAX_CMDS} lines. PLAIN TEXT ONLY: no slash prefix, no commentary, no code fences, no backticks, no **bold**, no bullet dashes — every line goes STRAIGHT to the server console exactly as written. I will run them and show you each command's output, then you may send more commands.`,
  `Use read-only commands to look around before acting — e.g. "data get entity <name> Pos", "data get entity <name> Dimension", "execute in minecraft:the_nether if block 10 60 20 minecraft:air", "list", "locate structure minecraft:fortress".`,
  ``,
  `NEVER TRUST YOUR MEMORY OF THIS MINECRAFT VERSION — it moves fast and your training may be stale. THE SERVER IS THE TRUTH, so look things up instead of guessing:`,
  `- I FETCH RESEARCH FOR YOU, in about a second, when you send a line of its own (you have no browsing tools of your own — do not try to browse):`,
  `  · WIKI <search terms>   → the matching minecraft.wiki page as plain text. Use it for NBT fields, mob mechanics, spawn rules, block states — anything you are unsure of.`,
  `  · SNAPSHOTS [player]    → DEATH INSURANCE: the player's recent inventory snapshots (taken every 3 min while online) as raw SNBT, newest last. THE playbook for "restore my stuff" after a death: request SNAPSHOTS, pick the last snapshot from BEFORE the death (the newest one may already be the empty post-death inventory — compare stack counts), convert each stack to a give (or item replace for armor/offhand slots) using THIS server's syntax era, clear duplicates first if the player kept part of their inventory, and verify counts. Restore EXACTLY what the snapshot holds — same items, same counts, same enchants. A restore is not done until the gives RAN and a final "data get entity <player> Inventory" shows the items — reading snapshots restores nothing by itself.`,
  `  · WHERE A PLAYER DIED: the game records it — "data get entity <player> LastDeathLocation" returns the exact death pos + dimension. Use THAT for "tp me to where I died". NEVER infer a death spot from the log, from their current position, or from memory — if LastDeathLocation is missing, say you cannot find it.`,
  `  · RECIPE <item words>   → the raw recipe JSON from this server's MOD jars (up to 3 matches). The wiki knows NOTHING about mod items — for any "how do I craft <mod thing>" this is the ONLY source. Read the pattern/key/ingredients and explain the grid in plain words. Vanilla recipes you already know — don't RECIPE those.`,
  `  · REGISTRY <words>      → search EVERY id every installed mod adds (items, blocks, entities, effects, enchants, structures) by id or display name — the lists in your context are TRUNCATED, this is the full truth. Use before giving/summoning ANY mod thing not in your context lists. No hit = it does not exist here; never invent an id.`,
  `  · LOGTAIL [lines]       → the server log's last lines (default 30). Use when something "did not work" invisibly, to see what the server actually said.`,
  `  · YOUTUBE <search terms> → the top tutorial's transcript. LAST RESORT only (slow, garbled captions), for a concrete build layout the wiki does not pin down.`,
  `  A round may be nothing but a WIKI line; I will answer it and you continue with the text in hand. Looking it up beats guessing twice.`,
  `- "help <command>" prints this exact version's real syntax (e.g. "help time", "help effect", "help attribute"). ALWAYS name the command — a bare "help" just dumps every command and tells you nothing.`,
  `- If a command errors, READ the error: it usually names the exact bad argument. Fix it and retry — that beats guessing twice.`,
  `- Item/enchant/effect ids: if unsure, try it; the error tells you what it expected.`,
  `- TELEPORT SAFETY IS AUTOMATIC: whenever you tp/spreadplayers a player, I silently give them 30s of hidden slow-falling + fire/fall immunity so a bad landing can't kill them. You don't add it and you don't mention it — but NEVER claim "no effects applied" after a tp, because they were. EXCEPTION: if the wish explicitly declines protection ("no slow falling", "no effects", "let me fall"), I skip the guard entirely — the wisher's opt-out is absolute, the landing is real, and THEN you may warn in one short line.`,
  ...ITEM_SYNTAX(mc),
  `- Max vanilla enchant levels: Efficiency V, Sharpness V, Protection IV, Unbreaking III, Fortune III, Looting III, Mending I, Silk Touch I. A "maxed" tool means ENCHANTED, not just the bare item — and if the give is rejected the player ends up empty-handed, so re-read every reply.`,
  ``,
  `MOD AWARENESS: the mods installed on this server are listed below. A mod's behaviour is controlled by its config file. You can READ any config file by replying with a line: READFILE <path> (e.g. READFILE config/treeharvester.json5). You may also EDIT one with: WRITEFILE <path>\\n<full new contents>\\nENDFILE — a .bak is kept, and the change takes effect on the next server restart (tell the player that).`,
  `THE "INSTALLED MODS" LIST IS THE ONLY AUTHORITY ON WHAT IS INSTALLED. Config files and world data OUTLIVE the mod that made them — a leftover config (say waystones-common.toml) after the mod was uninstalled does NOT mean the mod is there. If a mod is not in INSTALLED MODS, it is GONE: its items/blocks/commands do not exist, so never suggest or use them.`,
  `YOU CAN BUILD. "make me an iron farm", "cobblestone generator", "build a castle" are all in scope, and you have up to ${MAX_CMDS} commands per round and several rounds — use them.`,
  `- WORK IN ABSOLUTE COORDINATES. Read "data get entity ${player} Pos" and "data get entity ${player} Rotation", round to integers, and compute every block yourself. Rotation[0] (yaw) tells you which way they face: about -180 or 180 = north (-Z), -90 = east (+X), 0 = south (+Z), 90 = west (-X). "in front of me" = 8-12 blocks along that facing.`,
  `- THE PLAYER'S Y IS NOT THE GROUND. They fly, they stand on roofs, they climb hills — so anchoring a build at their own Y is how you end up building IN THE SKY. It has happened: a mansion was stamped at y=102 in open air, on a stone slab that had been filled in under it, and the player saw a house floating in the clouds.`,
  `- FLATTEN, DO NOT SURVEY. Never probe the landscape block by block — it is slow and it is how you run out of time. Pick a base point about 12 blocks along the player's facing, then "fill" the build volume with minecraft:air (this erases hills, trees and water) and build on the terrain that is already there. Do NOT fill a stone platform in mid-air to stand your build on: if the ground is far below, the build belongs DOWN THERE, not up here on a slab.`,
  `- FOR SCHEMATICS YOU DO NOT NEED TO SOLVE THIS AT ALL: the y you pass to PLACE is ADVISORY. The panel probes the real terrain under the footprint and snaps the build onto the ground itself, then tells you the y it actually used. Just pass the player's y and let the panel land it.`,
  `- "execute if block X Y Z minecraft:air" ALREADY REPLIES "Test passed" or "Test failed" straight back to you. Never build scoreboard probes to read a block — that wastes three commands to learn one fact.`,
  `- BUILD IN AS FEW ROUNDS AS YOU CAN. You get ${MAX_CMDS} commands per round: clear, floor and mechanism should usually fit in one or two rounds, with a final round to verify. A player is standing there waiting.`,
  `- Never build inside the player — keep the whole footprint clear of their Pos.`,
  `- "fill" does volumes (max 32768 blocks), "setblock" does single blocks, and blockstates matter: minecraft:hopper[facing=north], minecraft:oak_stairs[facing=east,half=bottom], minecraft:water, minecraft:lava. Load a chest with "item replace block X Y Z container.0 with <item> <n>".`,
  `- CHECK THE DESIGN, DO NOT WING IT. If you are not certain a farm/redstone design works in THIS version, LOOK IT UP with a WIKI line (or YOUTUBE for a concrete layout) before building. Your memory of block names, spawn rules and mob mechanics may be stale; the wiki and the server's own error messages are the truth.`,
  `- FARM MOBS MUST PERSIST: summon villagers/zombies with {PersistenceRequired:1b}; a caged zombie also wants {Silent:1b} and a helmet so it does not burn at dawn. Villagers need beds (and a workstation) before an iron farm will tick.`,
  `- A MACHINE IS NOT "BUILT" UNTIL IT RUNS. Placing the blocks is not success — the player judges you on whether the thing WORKS. Before you ever say DONE on a farm/generator, TEST IT and prove it with a command:`,
  `  · cobblestone generator: "setblock <gen> minecraft:air", then WAIT 3, then "execute if block <gen> minecraft:cobblestone" must say Test passed.`,
  `  · any mob/item farm: WAIT, then check the output chest actually has items, or that the mob you need exists ("execute if entity @e[type=villager,distance=..12]").`,
  `  If the test fails, FIX IT and test again. Reporting a broken machine as DONE is the worst thing you can do.`,
  `- WAIT <seconds> is a line you can send on its own (max 60). Minecraft physics need real time: fluids flow, mobs spawn, hoppers move items. Use it before every check.`,
  `- WAITFOR <player> <x> <y> <z> <radius> <maxSeconds> pauses YOUR OWN reply until the player is within radius of that point (max 300s). This is how you pace multi-act sequences to REAL player movement: "WAITFOR Alex 100 64 200 10 120" then the commands for the next act, all in ONE reply. If the player never arrives, the rest of your reply is DISCARDED and you get their actual position to re-plan — so put nothing after a WAITFOR that must run unconditionally.`,
  `- FLUIDS — these rules are VERIFIED on this server, trust them over your memory:`,
  `  · Water (even flowing) that reaches a LAVA SOURCE turns it into OBSIDIAN and kills the machine forever. This is the #1 way a cobblestone generator fails. The water must NEVER be able to reach the lava source block.`,
  `  · Cobblestone forms where FLOWING lava meets water. So the lava must be the one flowing into the generation block, with water adjacent to that block — and the lava source itself walled off from the water.`,
  `  · Fluids only flow in chunks near a player. Build within ~40 blocks of the player, or nothing will ever move.`,
  `- VERIFY, THEN EXPLAIN. Read blocks back ("execute if block X Y Z minecraft:hopper") before claiming success, and finish with ONE line telling the player how to use it (where to stand, where the output chest is).`,
  ``,
  `SPREADPLAYERS CANNOT CHANGE ANYONE'S DIMENSION — verified on this server. It only repositions a player WITHIN the dimension they are already standing in, no matter what "execute in <dim>" you wrap it in. So if the group is split across the Overworld and the Nether and you spreadplayers each of them, they all stay where they were and you have NOT gathered anyone. (This really happened: "tp everyone to a safe place in the nether" left one player in the Overworld and the genie still said DONE.) TO CROSS DIMENSIONS you MUST use tp with an explicit destination: "execute in minecraft:the_nether run tp <player> <x> <y> <z>" — and you own the safety of that Y, so probe it first (recipe below).`,
  `"TP EVERYONE" / "TP US" MEANS GATHER THEM TO ONE PLACE. Pick a SINGLE destination (one dimension, one x/y/z), prove it is safe once, then tp every player to that same spot. Never give each player their own separate "safe place" — the wish was to be together. If the player named a dimension ("a safe place in the nether"), EVERY player must end up in THAT dimension; check each one's Dimension afterwards and do not say DONE until they all match what was asked for.`,
  `TELEPORTS MUST BE SAFE — a player once landed midair over a mansion with no armor, and another was put INSIDE a cave because a single downward probe mistook a cave ceiling for the surface. Never guess a Y. Three recipes, pick by situation:`,
  `- SURFACE FAST PATH (player already in the right dimension, wish is "to the surface"/"out of this cave"): "execute in <dim> run spreadplayers <x> <z> 0 2 false <player>" lands them on the heightmap top and refuses lava — ONE command, DONE in the same reply. CRITICAL SYNTAX: the last argument is ONE name or ONE selector. "spreadplayers <x> <z> 0 2 false <p1> <p2>" is a SYNTAX ERROR on every version (verified on both eras) — send one command per player. If it errors anyway, do NOT retry variants; go straight to the top-down scan.`,
  `- UNDERGROUND STRUCTURES (trial_chambers, stronghold, ancient_city, mineshaft, dungeons): the structure is BELOW the surface — the top-down surface scan will strand players 100+ blocks ABOVE it (live failure 2026-07-20). Recipe: locate, then "execute in <dim> run spreadplayers <x> <z> 0 16 under <yCap> false <player>" — "under" drops them into air pockets below yCap. yCaps: trial_chambers 30, stronghold 30, mineshaft 40, ancient_city -20. One player per command. ALWAYS verify with "data get entity <player> Pos" that y is actually deep; if still near the surface, retry with range 24. If the wish named a place and the players ended up ANYWHERE else, that is a FAILURE — never phrase it as DONE.`,
  `- TOP-DOWN SURFACE SCAN (destination is a structure/coordinate with unknown ground, e.g. after "locate structure" which gives "~" for Y): forceload the chunk, then probe DOWNWARD FROM THE SKY: "execute in <dim> if block <x> 130 <z> minecraft:air", then 128, 126… — the FIRST non-air from the top IS the true surface (a probe walking down from a player's own Y finds cave ceilings instead). tp to that Y + 2, then "forceload remove". Batch the probes 2 apart; ~35 commands finds any overworld surface.`,
  `- KNOWN-Y DESTINATION (a base, a platform, underground): read Pos + Dimension of the destination, then test "execute in <dim> unless block X Y-1 Z minecraft:air unless block X Y-1 Z minecraft:lava" (solid, non-lava floor) plus "execute in <dim> if block X Y Z minecraft:air" and the block above (body room). Only tp to a Y passing all three; if nothing passes, carve a pocket or build a platform first. NEVER walk downward from an underground player's own Y — the first "floor" you find is a cave.`,
  `The panel auto-applies slow-falling + fire/damage protection around every tp and spreadplayers you send — but that covers the LANDING only, not a wrong dimension or a lava lake you chose as the destination.`,
  ``,
  `You are also the server's ORACLE. The live state below tells you exactly what ${player} is carrying, wearing and holding, their health/hunger/XP, where they are, the time of day, and what mobs are near them. Questions ("what should I craft next?", "am I ready for the nether?", "what am I missing for a beacon?", "how do I beat the warden?") get a real, specific answer that USES that state — name what they already have and what they still need. Answer with SAY <headline under 120 chars>, and for anything with multiple points (tutorials, mod rundowns, plans) add up to 8 lines of "INFO <point>" (under 120 chars each) — they render as a clean indented list under your headline in chat. NEVER cram a paragraph into one line, and NEVER put player-facing info in loose prose or markdown bullets: only SAY/DONE/INFO lines reach the player. Run read-only commands first if you need to look something up.`,
  ``,
  `YOU HAVE A MEMORY, AND IT IS THE DIFFERENCE BETWEEN A GOOD GENIE AND A GREAT ONE:`,
  `- BUILD <blueprint> <x> <y> <z> [player] — replay a build you already proved works, re-anchored at those coordinates. INSTANT: no thinking, no research. ALWAYS check the blueprint list below before designing anything from scratch. The optional [player] fills any <player> token in the blueprint (defaults to the wisher) — that's how the TIER KITS work: "give alex the iron kit" = BUILD iron-kit <alex's coords> <alex's exact player name>. Tier kits (stone-kit, iron-kit, diamond-kit) are owner-approved loadouts: replay them EXACTLY, never add or upgrade items.`,
  `- PLACE <schematic> <x> <y> <z> — stamp a pro-made schematic from the panel's build library into the world; x y z is its LOWEST corner (min x/y/z). INSTANT and pixel-perfect. Check the SCHEMATIC LIBRARY list below FIRST for houses, farms and decorative builds — a library build beats anything you can design from scratch. Clear/flatten the footprint first if terrain would clip into it, and afterwards customize freely (swap blocks, add interiors) with normal commands.`,
  `- SAVEBLUEPRINT <name> | <one-line description>, then the build's commands written with ~ OFFSETS from the base point (e.g. "fill ~0 ~0 ~0 ~6 ~0 ~6 minecraft:stone", "setblock ~3 ~1 ~3 minecraft:lava"), then a line: ENDBLUEPRINT.`,
  `  Save a blueprint ONLY after you have TESTED the machine and it worked. A saved blueprint is a promise to your future self — a broken one poisons every build after it.`,
  `- GIVE EXACTLY WHAT IS ASKED — "iron armor" means PLAIN iron armor: NO enchantments, effects, or upgrades the player didn't name. Only enchant when the wish says so (enchanted/god/best/maxed or a named enchantment). "everything I need" may add modest basics (food, torches) — still unenchanted. Accuracy IS the product; surprise upgrades read as the genie not listening. And to EQUIP gear, use "item replace entity <player> <slot> with <item>" ONLY — it creates the item in the slot, so give + item replace hands the player TWO of everything (live bug 2026-07-18). Plain give is only for items that stay in inventory.`,
  `- KITS ARE BLUEPRINTS TOO — this is how "give him everything back" becomes instant. The moment a kit's gives all succeed, save them: "SAVEBLUEPRINT kit-<player> | <player>'s standard loadout" with the EXACT give/item-replace lines as the body (position-independent commands are fine in a blueprint). On every later "give X back their stuff" wish: BUILD kit-<player> at the player's own coordinates — verbatim replay, zero re-derivation, no forgotten pieces. Update the blueprint when the kit changes.`,
  `- REMEMBER <fact> — write a lesson to your permanent notes: a rule you got wrong, a quirk of this server, something the player likes. Notes are shown to you on every future wish. Record what surprised you, not what was obvious.`,
  `- DIAGNOSE <one line> — MANDATORY before retrying ANY failed command or failed verification: one line naming WHY it failed and the fix ("summon needs graveyard: namespace on this server, not minecraft:"). It is saved as a permanent remedy for this version and shown to you on every future wish — the same mistake must never be derived twice. Then retry in the same reply.`,
  ``,
  `UNDO IS HANDLED FOR YOU: before your block changes run, I snapshot the region, and the player can say "server undo" to restore it. Never build your own undo, and if the player asks to revert something, tell them to say exactly: server undo`,
  ``,
  `MULTI-PART WISHES — REPORT EACH PART THE MOMENT IT LANDS. Put a line "PROGRESS <short past-tense update + what is next>" in the SAME reply, right AFTER the commands that finish that part (e.g. "PROGRESS TNT cube placed — building the iron farm now"). I relay it to the player the instant those commands have run. The player must never wonder whether something happened; never save news for the final DONE.`,
  ``,
  `INSTANT CONFIRMATION — when the commands in your CURRENT reply complete the wish, put "DONE <one short sentence>" as the LAST LINE OF THE SAME REPLY. Commands run first, then the DONE is relayed — the player hears it the moment the work lands, not a round later. Safety net: if ANY command in that reply fails, I withhold your DONE and show you the results instead, so a same-reply DONE can never lie.`,
  `BUT A SUCCEEDING COMMAND IS NOT A GRANTED WISH — that safety net only catches commands the SERVER rejected. A command can succeed and still not do what was asked. Before every DONE, re-read the player's exact words and check each thing they asked for actually holds: "everyone" means EVERY player online (not just the two you happened to act on), "in the nether" means every one of them is IN the nether, "replace their armour" means the old armour is gone. If your own summary would have to describe an outcome that does NOT match the wish ("...and TheKing206 on the Overworld surface" when they asked for the nether), that is NOT a DONE — it is unfinished work: fix it, then finish. Spend an extra round only when you genuinely must READ something back before knowing what to say (machine tests, checking a stat you are unsure changed).`,
  `NEVER SUBSTITUTE AND CLAIM. If the thing asked for does not exist on THIS server — a mechanic vanilla lacks, an item no loaded mod provides — you do not quietly do the nearest possible thing and report it as the wish. That is the single worst failure available to you: the player believes they have something they do not, and finds out later. (Live 2026-08-04: "give me a bow that shoots lightning" — impossible in vanilla — ran one lightning strike near the player and said the bow was granted. Nothing was granted.) The rule: if you cannot deliver the actual thing, say so plainly with SAY, in the same breath NAME the closest thing that is genuinely real here, and let them ask for it. "No such bow exists in 1.20.1 — a channeling trident calls real lightning on a hit during a storm, want that?" is a good answer. Silently swapping in the lightning is not.`,
  `To answer a question, give advice, or decline something genuinely impossible, reply with exactly: SAY <short message>. A longer answer = SAY <headline> plus lines of "INFO <point>" (max 8, each under 120 chars) — those render as an indented list under the headline. Player-facing text ANYWHERE else (loose prose, markdown bullets) is silently discarded.`,
  ...(secret ? [SECRET_RULES] : []),
].join('\n');

// a build takes several look → place → check cycles
const MAX_ROUNDS = 8;

/** Did the server REJECT this command? (i.e. it did not run at all)
 *
 *  This is the single most important predicate in the genie, because it is the
 *  sole input to the DONE gate: a rejection scored as a success is exactly how
 *  the genie ends up cheerfully saying "gave everyone a maxed pickaxe" when the
 *  server refused all three gives. Every entry below is a rejection this server
 *  ACTUALLY emitted and the genie ACTUALLY reported as DONE (found in
 *  data/chatgenie.log — do not remove one without re-reading that log):
 *    "Malformed 'minecraft:enchantments' component: ..."   (give, wrong-era syntax)
 *    "Unable to modify player data"                        (data merge on a player — ALWAYS fails)
 *    "Unable to apply this effect (target is immune ...)"  (effect give)
 *    "That position is not loaded"                         (fill/setblock in an unloaded chunk)
 *    "Can't find element 'minecraft:generic.max_health'"   (attribute, wrong-era name)
 *
 *  TWO TRAPS, both of which have already bitten:
 *  - "Test failed" is NOT a rejection. It is the correct, successful answer from
 *    an `execute if block` probe. Matching a bare /failed/ would make every
 *    verification round report phantom errors — hence the anchored `Failed to `.
 *  - The contraction. `Cannot ` (with a space) does NOT match "Can't", which is
 *    what vanilla actually says. Match both, always. */
// pure queries — they prove state, they never change it. An `execute` only
// counts as read-only when it has no `run` clause (a bare if/unless test).
// Used by the DONE guard: a wish whose every command matches this list did
// zero world changes, whatever the verdict claims.
const READ_ONLY_CMD =
  /^\/?\s*(?:data\s+get\b|list\b|seed\b|time\s+query\b|locate\b|help\b|whitelist\s+list\b|banlist\b|scoreboard\s+players\s+(?:get|list)\b|gamerule\s+\S+\s*$|execute\s+(?!.*\brun\b).*\b(?:if|unless)\b)/i;

export function isRconFailure(reply: string): boolean {
  return /Unknown|Incorrect|Expected|Invalid|Malformed|Unparseable|Unable to|Failed to |Can(no|')t |Could ?n(ot|'t) |No entity|No player|No targets matched|No items were found|Found no elements|is not a valid|not loaded|outside of the world|error/i.test(
    reply,
  );
}

/** Did the command RUN but change NOTHING? ("No blocks were filled", "Nothing
 *  changed") — a distinct, softer class than a rejection. It is surfaced to the
 *  model prominently (a no-op fill is how the sky-platform build went unnoticed)
 *  but it does NOT block DONE, because a no-op is often correct: filling air
 *  over air, or setting a gamerule to the value it already had. */
export function isRconNoop(reply: string): boolean {
  if (isRconFailure(reply)) return false; // a rejection is never merely a no-op
  return /No blocks were (filled|cloned)|Nothing changed/i.test(reply);
}

/** Find the real ground under a build's footprint, so the panel — not the model —
 *  owns where a schematic lands.
 *
 *  THE BUG THIS EXISTS FOR: the model is handed the player's Pos every round and
 *  told to build "at their own Y". A player who is flying, on a roof or up a hill
 *  is not standing on the ground, so the anchor was their altitude — the mansion
 *  stamped at y=102 in open sky, on a stone slab the model helpfully filled in
 *  under it. A prompt rule cannot be trusted with this; the panel must check.
 *
 *  We scan DOWNWARD from the requested Y. That is deliberate: it means we can
 *  never "find" the Nether's bedrock CEILING (a highest-block search in the
 *  Nether hands you y=127 and buries the player in bedrock), and an intentional
 *  underground build stays where it was asked for.
 *
 *  Returns the y whose block is the first solid ground beneath the footprint,
 *  plus one — i.e. the y the build's bottom layer should sit at. */
async function groundAnchor(
  id: string,
  dim: string,
  x: number,
  z: number,
  sizeX: number,
  sizeZ: number,
  requestedY: number,
): Promise<{ y: number; drop: number; probed: boolean }> {
  // world floor by dimension — never scan below it
  const floor = /nether/i.test(dim) ? 1 : /end/i.test(dim) ? 0 : -63;
  // five columns: the four footprint corners + the centre. One column can sit in
  // a pond or a tree; the median of five is robust to that.
  const cols: [number, number][] = [
    [x, z],
    [x + sizeX - 1, z],
    [x, z + sizeZ - 1],
    [x + sizeX - 1, z + sizeZ - 1],
    [x + Math.floor(sizeX / 2), z + Math.floor(sizeZ / 2)],
  ];
  // Anything you can stand ON is ground. Anything you'd sink, swim, burn or push
  // through is not — a build "anchored" on a lake surface or a treetop is the
  // same bug in a different hat.
  //
  // THE BLOCK LIST IS VERSION-SENSITIVE. Minecraft renamed `grass` to
  // `short_grass` in 1.20.3. Probing for `minecraft:short_grass` on 1.20.1 is not
  // a miss — it is an ERROR ("Can't find element"), because the id does not exist
  // there. That error is not "Test failed", so the column never classified as
  // ground, groundAnchor gave up, and PLACE fell back to the Y the model guessed:
  // the sky-mansion bug, resurrected on exactly the server we could not test.
  const mc = mcOf(id);
  const PASSABLE = [
    'air', 'cave_air', 'void_air', 'water', 'lava',
    atLeast(mc, '1.20.3') ? 'short_grass' : 'grass',
    'tall_grass', 'snow', 'fire',
  ];
  const isPassable = (y: number, cx: number, cz: number) =>
    PASSABLE.map((b) => `execute in ${dim} if block ${cx} ${y} ${cz} minecraft:${b}`);

  /** A block is GROUND only when the server explicitly told us it is not any of
   *  the passable blocks. "That position is not loaded" is NOT a yes — and this
   *  distinction is the whole ballgame: an unloaded chunk answers every probe
   *  with that error, so treating "not air" as "solid" makes the very first Y we
   *  try look like ground and anchors the build in the sky. That is the exact bug
   *  this function exists to prevent, so it must never re-introduce it.
   *
   *  So: only the server's REAL verdicts count. A reply that is neither "Test
   *  passed" nor "Test failed" is a question we failed to ask, and it is thrown
   *  away rather than counted as a "no". */
  const classify = (replies: string[]): 'ground' | 'passable' | 'unknown' => {
    const verdicts = replies.filter((r) => /Test (passed|failed)/i.test(r));
    if (!verdicts.length) return 'unknown'; // chunk not loaded — we know nothing
    if (verdicts.some((r) => /Test passed/i.test(r))) return 'passable';
    // every question we managed to ask came back "no". Only call it ground if we
    // actually got to ask all of them.
    return verdicts.length === PASSABLE.length ? 'ground' : 'unknown';
  };

  const top = Math.min(requestedY, /nether/i.test(dim) ? 120 : 310);
  // WINDOWED, AIR-FIRST, EARLY-EXIT SCAN. The old shape pre-built EVERY level's
  // full 8-probe set for all 5 columns (~5,400 sequential RCON sends per PLACE
  // even when the ground was 8 blocks down). Now: per 12-level window, ONE
  // batch of cheap air probes across all unresolved columns; only a non-air hit
  // pays for the remaining passable probes at that exact spot; the whole scan
  // stops once 3 columns found ground (the median is then already determined).
  const WINDOW = 12;
  const grounds = new Map<number, number>(); // column index -> ground y
  for (let winTop = top; winTop >= floor && grounds.size < 3; winTop -= WINDOW) {
    const winBottom = Math.max(floor, winTop - WINDOW + 1);
    const airProbes: string[] = [];
    const meta: { col: number; y: number }[] = [];
    cols.forEach(([cx, cz], col) => {
      if (grounds.has(col)) return;
      for (let y = winTop; y >= winBottom; y--) {
        airProbes.push(`execute in ${dim} if block ${cx} ${y} ${cz} minecraft:air`);
        meta.push({ col, y });
      }
    });
    if (!airProbes.length) break;
    const airRes = await rconBatch(id, airProbes).catch(() => [] as string[]);
    if (airRes.length !== airProbes.length) continue; // window unreadable — try lower
    // per column, walk this window top-down; each non-air candidate gets the
    // full classify() treatment (preserving unknown-vs-passable semantics —
    // "not loaded" must NEVER read as solid, that is the sky-mansion guard)
    for (let col = 0; col < cols.length && grounds.size < 3; col++) {
      if (grounds.has(col)) continue;
      const mine = meta.map((m, i) => ({ ...m, r: airRes[i] })).filter((m) => m.col === col);
      for (const probe of mine) {
        if (/Test passed/i.test(probe.r)) continue; // air — keep descending
        if (!/Test failed/i.test(probe.r)) continue; // unloaded — no verdict
        const [cx, cz] = cols[col];
        const rest = PASSABLE.filter((b) => b !== 'air').map((b) => `execute in ${dim} if block ${cx} ${probe.y} ${cz} minecraft:${b}`);
        const verdict = classify([probe.r, ...(await rconBatch(id, rest).catch(() => [] as string[]))]);
        if (verdict === 'ground') { grounds.set(col, probe.y); break; }
        // passable (water/grass/snow) or unknown — keep descending this column
      }
    }
  }
  if (grounds.size === 0) return { y: requestedY, drop: 0, probed: false };
  const list = [...grounds.values()].sort((a, b) => a - b);
  const surface = list[Math.floor(list.length / 2)]; // median column
  const y = surface + 1; // the build's bottom layer sits ON the ground
  return { y, drop: requestedY - y, probed: true };
}

/** Everything the genie can know before it even thinks: who's online, the
    requester's exact state (inventory, health, hunger, XP, gear, position),
    the world clock/weather, and what's lurking nearby. All of it read over
    RCON — nothing runs inside the game, so it costs the server no memory. */
async function senseWorld(id: string, player: string, mc?: string | null): Promise<string> {
  // Worn gear moved OUT of Inventory into its own `equipment` compound in the
  // modern era. On 1.20.1 that field does not exist: the probe errors, no slot
  // matches, and the genie is told a player in full netherite is "(nothing
  // equipped)" — then happily "replaces" armour that it cannot see.
  const modernEquipment = isComponentEra(mc);
  const q = [
    'list',
    `data get entity ${player} Pos`,
    `data get entity ${player} Dimension`,
    `data get entity ${player} Health`,
    `data get entity ${player} foodLevel`,
    `data get entity ${player} XpLevel`,
    `data get entity ${player} Inventory`,
    `data get entity ${player} SelectedItem`,
    `data get entity ${player} playerGameType`,
    'time query day',
    'time query gametime',
    `execute at ${player} run data get entity @e[type=!player,distance=..40,limit=12,sort=nearest] id`,
    // modern: worn gear lives in its own `equipment` compound.
    // legacy: it is inside Inventory (slots 100-103 + -106), already read above —
    // so probe something harmless instead of an error we would have to filter.
    modernEquipment ? `data get entity ${player} equipment` : `data get entity ${player} Air`,
    // yaw/pitch — without it "in front of me" is a coin flip
    `data get entity ${player} Rotation`,
  ];
  let r: string[];
  try {
    r = await rconBatch(id, q);
  } catch {
    return '(world state unavailable)';
  }
  const clean = (s: string) => (s ?? '').replace(/^.*following entity data:\s*/i, '').trim();
  const bag = parseInventory(clean(r[6]));
  const fmt = (i: Item) => `${i.id}${i.count > 1 ? ` x${i.count}` : ''}${i.ench ? ` (${i.ench})` : ''}`;
  // equipment is a keyed object (head/chest/legs/feet/offhand/mainhand)
  let worn: (string | null)[];
  if (modernEquipment) {
    const eqRaw = clean(r[12]);
    worn = ['head', 'chest', 'legs', 'feet', 'offhand']
      .map((slot) => {
        const m = new RegExp(`\\b${slot}:\\s*\\{`).exec(eqRaw);
        if (!m) return null;
        const item = parseInventory(eqRaw.slice(m.index + m[0].length - 1))[0];
        return item ? `${slot}: ${fmt(item)}` : null;
      })
      .filter(Boolean);
  } else {
    // legacy: armour is in the Inventory bag at fixed slots (feet 100 → head 103),
    // offhand at -106. Pull it from the bag we already parsed.
    const LEGACY_SLOTS: Record<number, string> = { 103: 'head', 102: 'chest', 101: 'legs', 100: 'feet', [-106]: 'offhand' };
    worn = bag
      .filter((i) => LEGACY_SLOTS[i.slot])
      .map((i) => `${LEGACY_SLOTS[i.slot]}: ${fmt(i)}`);
  }
  const carried = modernEquipment
    ? bag
    : bag.filter((i) => ![100, 101, 102, 103, -106].includes(i.slot));
  // phase 2: the OTHER online players' whereabouts — half of the concierge ops
  // target someone else ("tp me to night", "give HIM his stuff"), and without
  // this the model burned a whole round on data-gets before it could act
  const others = (clean(r[0]).split(':')[1] ?? '')
    .split(/,\s*/).map((s) => s.trim()).filter((n) => n && n !== player).slice(0, 3);
  const otherLines: string[] = [];
  if (others.length) {
    try {
      const q2 = others.flatMap((n) => [`data get entity ${n} Pos`, `data get entity ${n} Dimension`, `data get entity ${n} Health`]);
      const r2 = await rconBatch(id, q2);
      others.forEach((n, i) => {
        const pos = clean(r2[i * 3]);
        if (pos && !/No entity was found/i.test(pos)) {
          otherLines.push(`${n} is at ${pos} in ${clean(r2[i * 3 + 1])}, health ${clean(r2[i * 3 + 2])}/20`);
        }
      });
    } catch { /* phase 2 is a bonus — never fail sensing over it */ }
  }
  return [
    `Online players: ${clean(r[0])}`,
    ...otherLines,
    `${player} position: ${clean(r[1])} in ${clean(r[2])}`,
    `${player} rotation [yaw, pitch]: ${clean(r[13])} (yaw ~0 faces +Z/south, ~90 faces -X/west, ~±180 faces -Z/north, ~-90 faces +X/east)`,
    `${player} health: ${clean(r[3])}/20 base (a higher number means max health was raised), hunger: ${clean(r[4])}/20, XP level: ${clean(r[5])}, gamemode: ${clean(r[8])}`,
    `${player} EQUIPPED right now: ${worn.length ? worn.join(' | ') : '(nothing equipped)'}`,
    `${player} holding in main hand: ${clean(r[7]) || '(nothing)'}`,
    // on legacy the armour slots live IN the bag — don't also list worn gear as carried
    `${player} carrying in bag (${carried.length} stacks): ${carried.map(fmt).join(', ') || '(empty)'}`,
    `World: day ${clean(r[9])}, gametime ${clean(r[10])}`,
    `Entities within 40 blocks of ${player}: ${clean(r[11]) || '(none)'}`,
  ].join('\n');
}

/** Structure ids registered by the installed mods — the model has NO other
    source for these ("tp us to the graveyard village" needs `locate structure
    graveyard:ruins`, and neither its memory nor the wiki knows modded ids).
    The data/<ns>/worldgen/structure/ path inside each jar IS the registry.
    Cached per (jar, size, mtime): serverFacts runs on every wish. */
const structCache = new Map<string, string[]>();
function modStructureIds(id: string): string[] {
  try {
    const dir = join(serverDir(id), 'mods');
    if (!existsSync(dir)) return [];
    const out = new Set<string>();
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jar')) continue; // .jar.disabled = not loaded
      const p = join(dir, f);
      const st = statSync(p);
      const key = `${p}|${st.size}|${st.mtimeMs}`;
      let ids = structCache.get(key);
      if (!ids) {
        ids = [];
        try {
          for (const e of new AdmZip(p).getEntries()) {
            const m = /^data\/([a-z0-9_.-]+)\/worldgen\/(?:structure|configured_structure_feature)\/([a-z0-9_./-]+)\.json$/.exec(
              e.entryName.replace(/\\/g, '/'),
            );
            if (m && m[1] !== 'minecraft') ids.push(`${m[1]}:${m[2]}`);
          }
        } catch { /* unreadable jar — skip */ }
        structCache.set(key, ids);
      }
      for (const x of ids) out.add(x);
    }
    return [...out].slice(0, 60);
  } catch {
    return [];
  }
}

interface LangCatalog { entities: string[]; blocks: string[]; items: string[]; effects: string[]; enchants: string[] }
const entityCache = new Map<string, LangCatalog>();
/** Modded entity ids, scanned from each enabled jar's assets/<ns>/lang/en_us.json
    (`entity.<ns>.<id>` keys). Entity types live in mod CODE, not data/ — the
    lang file is the only jar-scannable registry. Without this the model guesses
    ids from the mod NAME and fails: The Man From The Fog's namespace is `man`
    (three wrong guesses live on 2026-07-18). Display name kept as a hint. */
function modLangCatalog(id: string): LangCatalog {
  const acc: LangCatalog = { entities: [], blocks: [], items: [], effects: [], enchants: [] };
  try {
    const dir = join(serverDir(id), 'mods');
    if (!existsSync(dir)) return acc;
    const seen = { entities: new Set<string>(), blocks: new Set<string>(), items: new Set<string>(), effects: new Set<string>(), enchants: new Set<string>() };
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jar')) continue; // .jar.disabled = not loaded
      const p = join(dir, f);
      const st = statSync(p);
      const key = `${p}|${st.size}|${st.mtimeMs}`;
      let cat = entityCache.get(key);
      if (!cat) {
        cat = { entities: [], blocks: [], items: [], effects: [], enchants: [] };
        try {
          for (const e of new AdmZip(p).getEntries()) {
            if (!/^assets\/[a-z0-9_.-]+\/lang\/en_us\.json$/.test(e.entryName.replace(/\\/g, '/'))) continue;
            const lang = JSON.parse(e.getData().toString('utf8')) as Record<string, string>;
            for (const [k, v] of Object.entries(lang)) {
              const parts = k.split('.');
              // exactly <kind>.<ns>.<id> — deeper keys are variants/subtitles
              if (parts.length !== 3 || parts[1] === 'minecraft') continue;
              const entry = `${parts[1]}:${parts[2]} ("${v}")`;
              if (parts[0] === 'entity') cat.entities.push(entry);
              else if (parts[0] === 'block') cat.blocks.push(entry);
              else if (parts[0] === 'item') cat.items.push(entry);
              else if (parts[0] === 'effect' || parts[0] === 'mob_effect') cat.effects.push(entry);
              else if (parts[0] === 'enchantment') cat.enchants.push(entry);
            }
          }
        } catch { /* unreadable jar — skip */ }
        entityCache.set(key, cat);
      }
      for (const kind of ['entities', 'blocks', 'items', 'effects', 'enchants'] as const) {
        for (const x of cat[kind]) if (!seen[kind].has(x)) { seen[kind].add(x); acc[kind].push(x); }
      }
    }
  } catch { /* filesystem hiccup — partial is fine */ }
  return acc;
}

/** Prompt-sized view of the catalog (the full one can be thousands of ids —
    REGISTRY searches the full one on demand). */
function modLangCatalogPrompt(id: string): LangCatalog {
  const acc = modLangCatalog(id);
  return { entities: acc.entities.slice(0, 80), blocks: acc.blocks.slice(0, 80), items: acc.items.slice(0, 120), effects: acc.effects.slice(0, 40), enchants: acc.enchants.slice(0, 40) };
}

/** REGISTRY <words> — search EVERY extracted mod id (items/blocks/entities/
    effects/enchants + structures) by id or display name. The prompt lists are
    truncated; this is the untruncated truth from the jars. */
function registrySearch(id: string, query: string): string {
  const tokens = query.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 1);
  if (!tokens.length) return `REGISTRY "${query}": give me a word from the id or item name.`;
  const cat = modLangCatalog(id);
  const pools: [string, string[]][] = [
    ['entity', cat.entities], ['block', cat.blocks], ['item', cat.items],
    ['effect', cat.effects], ['enchant', cat.enchants],
    ['structure', modStructureIds(id)],
  ];
  const hits: string[] = [];
  for (const [kind, pool] of pools) {
    for (const entry of pool) {
      const low = entry.toLowerCase();
      if (tokens.every((t) => low.includes(t))) hits.push(`${kind}: ${entry}`);
      if (hits.length >= 40) break;
    }
    if (hits.length >= 40) break;
  }
  return hits.length
    ? `REGISTRY "${query}" (${hits.length} hit(s), ids are EXACT — use verbatim):\n${hits.join('\n')}`
    : `REGISTRY "${query}": nothing in any installed mod. It is vanilla, from a datapack, or does not exist on this server — do NOT invent an id.`;
}

const recipeCache = new Map<string, { name: string; json: string }[]>();
/** RECIPE <words> — grep every enabled mod jar's data/<ns>/recipe(s)/*.json
    for the wished item. Mod recipes are invisible to the wiki (live test:
    Sun Town star, 2026-07-18 — two lookups, no page) but sit as plain JSON in
    the jar; hand the model the raw recipe and it explains the grid itself. */
function modRecipes(id: string, query: string): string {
  const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  if (!tokens.length) return `RECIPE "${query}": give me a few words from the item name or id.`;
  const hits: { name: string; json: string; score: number }[] = [];
  try {
    const dir = join(serverDir(id), 'mods');
    if (!existsSync(dir)) return 'RECIPE: this server has no mods.';
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jar')) continue; // .jar.disabled = not loaded
      const p = join(dir, f);
      const st = statSync(p);
      const key = `${p}|${st.size}|${st.mtimeMs}`;
      let list = recipeCache.get(key);
      if (!list) {
        list = [];
        try {
          for (const e of new AdmZip(p).getEntries()) {
            const n = e.entryName.replace(/\\/g, '/');
            const m = /^data\/([a-z0-9_.-]+)\/recipes?\/.+\.json$/.exec(n);
            if (m && m[1] !== 'minecraft') list.push({ name: n, json: e.getData().toString('utf8') });
          }
        } catch { /* unreadable jar — skip */ }
        recipeCache.set(key, list);
      }
      for (const r of list) {
        const hay = `${r.name} ${r.json}`.toLowerCase();
        const score = tokens.filter((t) => hay.includes(t)).length;
        if (score > 0) hits.push({ ...r, score });
      }
    }
  } catch { /* fall through to not-found */ }
  if (!hits.length) {
    return `RECIPE "${query}": no recipe in any mod jar — the item is likely uncraftable (loot/drop/shop only) or vanilla (whose recipes you already know). Say so honestly.`;
  }
  hits.sort((a, b) => b.score - a.score);
  return hits
    .slice(0, 3)
    .map((h) => `${h.name}:\n${h.json.replace(/\s+/g, ' ').slice(0, 900)}`)
    .join('\n');
}

/** What this particular server IS: exact MC version + loader, every mod
    installed, and which mod config files exist (so the genie can read them
    on request instead of guessing at defaults). */
async function serverFacts(id: string): Promise<string> {
  const det = detect(serverDir(id), id);
  let mods = '';
  try {
    const items = await listInstalled(id);
    mods = items.length
      ? items
          .map((m) => `${m.title ?? m.file}${m.versionNumber ? ` ${m.versionNumber}` : ''}${m.enabled ? '' : ' (DISABLED)'}`)
          .join(', ')
      : '(none — vanilla)';
  } catch {
    mods = '(mod list unavailable)';
  }
  let configs = '';
  try {
    const files = listConfigs(id).map((f) => f.path);
    configs = files.length ? `${files.length} files: ${files.slice(0, 60).join(', ')}${files.length > 60 ? ', …' : ''}` : '(none)';
  } catch {
    configs = '(unavailable)';
  }
  const structs = modStructureIds(id);
  const cat = modLangCatalogPrompt(id);
  const ents = cat.entities;
  return [
    `SERVER: Minecraft ${det.mc ?? '?'} on ${det.loader}.`,
    `INSTALLED MODS: ${mods}`,
    `MOD CONFIG FILES: ${configs}`,
    ...(structs.length
      ? [`MOD STRUCTURES you can find with "locate structure <id>" (these ids are REAL, extracted from the installed jars): ${structs.join(', ')}`]
      : []),
    ...(ents.length
      ? [`MOD ENTITIES you can summon/select with these EXACT ids (REAL, from the jars' lang files — mod namespaces rarely match mod names, e.g. Man From The Fog = "man:"; NEVER guess an entity id not on this list): ${ents.join(', ')}`]
      : []),
    ...(cat.blocks.length
      ? [`MOD BLOCKS (EXACT ids for setblock/fill/execute-if-block — ores are BLOCKS, not locatable structures; find them by Y-band probing): ${cat.blocks.join(', ')}`]
      : []),
    ...(cat.items.length
      ? [`MOD ITEMS (EXACT ids for give — some mods ship TYPOS in their real ids, use them verbatim): ${cat.items.join(', ')}`]
      : []),
    ...(cat.effects.length
      ? [`MOD EFFECTS (EXACT ids for effect give): ${cat.effects.join(', ')}`]
      : []),
    ...(cat.enchants.length
      ? [`MOD ENCHANTMENTS (EXACT ids for enchant/components): ${cat.enchants.join(', ')}`]
      : []),
  ].join('\n');
}

/** Safety net: no matter how the model teleports someone, nobody dies from
    the landing. Any tp/spreadplayers of a player is PRECEDED by slow-falling +
    fire/fall immunity for long enough to touch down or swim out of lava.
    Selector handling is deliberate:
    - full selector tokens are kept VERBATIM (`@a[team=red]` must not widen to
      bare @a — that once made every player on the server damage-immune)
    - @e is never guarded: `effect give @e resistance` makes MOBS immune too
    - plain names allow digit/underscore starts (legal usernames) */
const GUARD_TARGET = /\b(?:tp|teleport)\s+(@[aprs](?:\[[^\]]*\])?|[A-Za-z0-9_]{3,16})\b/;
const GUARD_SPREAD = /\bspreadplayers\s+.*\s(@[aprs](?:\[[^\]]*\])?|(?!(?:true|false|under)\s*$)[A-Za-z0-9_]{3,16})\s*$/;

function guardTargetsOf(cmds: string[]): string[] {
  const targets = new Set<string>();
  for (const c of cmds) {
    const m = GUARD_TARGET.exec(c) ?? GUARD_SPREAD.exec(c);
    if (m && !/^@e/.test(m[1])) targets.add(m[1]);
  }
  return [...targets];
}

// the wisher's explicit "let me fall" beats the safety net (2026-07-20: a
// hidden slow-falling after "no slow falling" read as the genie disobeying —
// worse, its honest "no effects applied" became a lie the harness wrote)
const GUARD_OPT_OUT = /\b(?:no|without|skip)\s+(?:the\s+)?(?:slow[\s-]*fall(?:ing)?|effects?|protection|safety|guard)\b|let\s+me\s+fall/i;

async function guardTeleports(id: string, cmds: string[], wish?: string): Promise<void> {
  if (wish && GUARD_OPT_OUT.test(wish)) return;
  const targets = guardTargetsOf(cmds);
  if (targets.length === 0) return;
  const guard: string[] = [];
  for (const t of targets) {
    guard.push(
      `effect give ${t} minecraft:slow_falling 30 0 true`,
      `effect give ${t} minecraft:fire_resistance 30 0 true`,
      `effect give ${t} minecraft:resistance 30 4 true`,
    );
  }
  await rconBatch(id, guard);
}

/** LOG-TAIL VERIFICATION — an RCON command can "succeed" while the server
    throws internally (the farm-that-never-ticked class). Capture the log
    offset before a batch and surface any fresh stack traces to the model
    BEFORE it may claim DONE. */
function logSizeOf(id: string): number {
  try { return statSync(join(serverDir(id), 'logs', 'latest.log')).size; } catch { return 0; }
}
function freshLogErrors(id: string, offset: number): string[] {
  try {
    const p = join(serverDir(id), 'logs', 'latest.log');
    const size = statSync(p).size;
    if (size <= offset) return [];
    const fd = openSync(p, 'r');
    const buf = Buffer.alloc(Math.min(size - offset, 60_000));
    readSync(fd, buf, 0, buf.length, offset);
    closeSync(fd);
    return buf.toString('utf8').split('\n')
      .filter((l) => /ERROR\]|FATAL|Exception|\tat [a-z]/.test(l) && !/RCON|lost connection|Disconnected|logged in|joined the game|UUID of/.test(l))
      .slice(0, 8)
      .map((l) => l.slice(0, 200));
  } catch { return []; }
}

interface Item { id: string; count: number; slot: number; ench: string }

/** Enchantments off ONE item's SNBT, in either era. The old generic
 *  `([a-z_]+):\s*(\d+)` sweep matched NEITHER format, so the genie has never
 *  once seen an enchantment on any item, on any version:
 *    modern (26.2): components:{"minecraft:enchantments":{"minecraft:efficiency":5}}
 *                   — SNBT QUOTES any key containing a colon, so the key is
 *                     `"minecraft:efficiency"` and the old pattern needed a bare word
 *    legacy (1.20.1): Enchantments:[{id:"minecraft:efficiency",lvl:5}]
 *                   — level lives in `lvl`, not after the id */
function readEnchants(chunk: string): string {
  const found: string[] = [];
  for (const m of chunk.matchAll(/"minecraft:([a-z_]+)"\s*:\s*(\d+)/g)) {
    if (!/^(count|damage|slot|max_stack_size|repair_cost)$/.test(m[1])) found.push(`${m[1]} ${m[2]}`);
  }
  for (const m of chunk.matchAll(/\bid:\s*"(?:minecraft:)?([a-z_]+)"\s*,\s*lvl:\s*(\d+)/g)) {
    found.push(`${m[1]} ${m[2]}`);
  }
  return [...new Set(found)].slice(0, 6).join(' ');
}

/** Split an SNBT list into its top-level {…} items and pull out the fields we
    care about. Regex alone can't do this: item components nest braces, and
    key order is not fixed (count usually comes BEFORE id). Slots 100-103 are
    worn armor (feet→head), -106 is the offhand. */
function parseInventory(snbt: string): Item[] {
  const items: Item[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < snbt.length; i++) {
    const c = snbt[i];
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        const chunk = snbt.slice(start, i + 1);
        const id = /\bid:\s*"([^"]+)"/.exec(chunk)?.[1];
        if (id) {
          items.push({
            id: id.replace('minecraft:', ''),
            // pre-1.20.5 prints `Count: 64b` (capital C), modern prints `count: 64`.
            // Matching only the lowercase key made every stack on a 1.20.1 server
            // read as a single item — the genie thought a full inventory was empty.
            count: Number(/\b[Cc]ount:\s*(\d+)/.exec(chunk)?.[1] ?? 1),
            slot: Number(/\bSlot:\s*(-?\d+)b/.exec(chunk)?.[1] ?? 0),
            ench: readEnchants(chunk),
          });
        }
        start = -1;
      }
    }
  }
  return items;
}

async function handleWish(id: string, player: string, wish: string, secret: boolean, log: (m: string) => void): Promise<void> {
  const say = (text: string, color: string, sound?: keyof typeof SOUND) =>
    rconBatch(id, [genieLine(id, player, secret, wish, text, color), ...(sound ? [genieSound(player, sound)] : [])]).catch(
      () => {},
    );

  // Every wish gets its own LIVE boss bar: unlike the action bar it never
  // fades, so long thinking stretches stay visible — phase + elapsed time,
  // fill = rounds used. Parallel wishes stack as separate bars.
  const barId = `spawnpoint:w${Date.now() % 1_000_000}${Math.floor(Math.random() * 1000)}`;
  activeBars.add(barId);
  // keep the bar NARROW — long names stretch under minimaps (owner request)
  const tag = wish.length > 12 ? `${wish.slice(0, 12).trim()}…` : wish;
  const started = Date.now();
  let phase = 'waking…';
  const barName = () => {
    const s = Math.floor((Date.now() - started) / 1000);
    const t = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
    return JSON.stringify([
      { text: secret ? '🤫 ' : '✦ ', color: secret ? 'light_purple' : 'aqua' },
      { text: `${tag} `, color: 'white', italic: true },
      { text: `— ${phase} · ${t}`, color: 'gray' },
    ]);
  };
  await rconBatch(id, [
    `bossbar add ${barId} ${barName()}`,
    `bossbar set ${barId} color ${secret ? 'pink' : 'blue'}`,
    `bossbar set ${barId} max ${MAX_ROUNDS}`,
    `bossbar set ${barId} value 0`,
    `bossbar set ${barId} players ${player}`,
    genieSound(player, 'tick'),
  ]).catch(() => {});
  const heartbeat = setInterval(() => {
    rconCommand(id, `bossbar set ${barId} name ${barName()}`).catch(() => {});
  }, 3000);
  heartbeat.unref();
  const bar = (text: string) => {
    phase = text;
    return rconCommand(id, `bossbar set ${barId} name ${barName()}`).catch(() => {});
  };

  // register this wish's activity window (Ledger audit attribution)
  const myWindow = { t0: Date.now(), t1: null as number | null };
  wishWindows.set(id, [...(wishWindows.get(id) ?? []), myWindow]);

  try {

  let web = needsWeb(wish);
  const mcVersion = detect(serverDir(id), id).mc;
  const [context, facts] = await Promise.all([senseWorld(id, player, mcVersion), serverFacts(id)]);

  const history = (loadHistory()[id] ?? []).slice(-8);
  const convo = history.length
    ? `RECENT CONVERSATION — wishes you already handled (oldest first). The player may refer back to these ("the farm you built", "do it again", "undo that"). A SHORT or vague wish is almost always a FOLLOW-UP: the answer to a question you just asked, or about the thing from the previous wish ("whats the crafting recipe" right after you gave stars = the star's recipe). Connect it yourself — asking "for what?" when the conversation already says so reads as not listening, and NEVER ask the same clarifying question twice. "ok"/"yes"/"sure"/"do it"/"yes please" = consent to whatever YOU offered in your latest reply below — DO that offered thing immediately, never answer "what can I help you with":\n${history
        .map((h) => `- ${h.player}: "${h.wish}" → ${h.verdict}`)
        .join('\n')}`
    : '';

  const notes = loadNotes(mcVersion);
  const remedies = loadRemedies(mcVersion);
  const episodes = similarEpisodes(wish, mcVersion);
  const bps = listBlueprints(mcVersion); // era-filtered: a 26.2 kit's component syntax is rejected wholesale on 1.20.1
  const schematics = listSchematics();
  const memory = [
    bps.length
      ? `BLUEPRINTS YOU HAVE SAVED (replay with BUILD <name> <x> <y> <z> — instant, no thinking):\n${bps.map((b) => `- ${b.name}: ${b.description} (${b.commands.length} commands)${b.verified ? '' : ' — UNVERIFIED: after replaying, TEST it before saying DONE'}`).join('\n')}`
      : `BLUEPRINTS: none saved yet. The first time you build something that WORKS, SAVEBLUEPRINT it so it never costs you thinking again.`,
    schematics.length
      ? `SCHEMATIC LIBRARY (pro builds uploaded to the panel — stamp with PLACE <name> <x> <y> <z>, the anchor is the min corner):\n${schematics.map((s) => `- ${s.name}: ${s.size[0]}×${s.size[1]}×${s.size[2]} (w×h×l), ${s.blocks} blocks — from ${s.source}`).join('\n')}`
      : '',
    notes.length ? `YOUR NOTES (lessons you wrote yourself — they are true, trust them):\n${notes.map((n) => `- ${n}`).join('\n')}` : '',
    remedies.length ? `FAILURE REMEDIES (one-line diagnoses you wrote the moment a command failed on THIS version — apply them before repeating the mistake):\n${remedies.map((r) => `- ${r}`).join('\n')}` : '',
    episodes.length ? `SIMILAR PAST WISHES (your own record, same version era — replay what WORKED, avoid what FAILED, adapt names/coords):\n${episodes.map((e) => `- ${e}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const transcript: string[] = [
    SYSTEM(player, secret, mcVersion),
    ``,
    `SPEED MATTERS — the player is standing there in the world, waiting. Use the CHEAPEST source that can answer you: your own knowledge when you are confident (most wishes need no research at all), then WIKI when a mechanic must be pinned down, and YOUTUBE only when the wiki cannot give you a concrete layout. One or two lookups, then act.`,
    ``,
    web
      ? `You are in DEEP mode: full thinking is enabled because this wish looks like design/build work. Use it.`
      : `You are in FAST mode: thinking is off because this wish looks simple. If it actually needs multi-step DESIGN work (a farm, redstone, a structure from scratch, heavy research), reply with the single line: ESCALATE — I will rerun you in deep mode with full thinking. Do not attempt serious design work in fast mode, and do not escalate for anything you can just do (give/tp/effect/kill/weather/questions).`,
    ``,
    memory,
    ...(convo ? [``, convo] : []),
    ``,
    facts,
    ``,
    `Live state:\n${context}`,
    ``,
    `${player} said in chat: "${wish}"`,
  ];
  const trail: string[] = [];
  // THREE-WAY COUNTER SPLIT — the old two-counter model caused live damage:
  //   totalRan     = commands actually sent to the server
  //   totalFailed  = ran AND the server rejected them
  //   totalSkipped = never ran (prose-guard skips, budget drops, RCON-dead
  //                  batches). Skips used to count as FAILURES, which withheld
  //                  DONE on fully-successful rounds and made the model RE-RUN
  //                  side-effectful gives — a redstone wish ran its 4 gives
  //                  THREE times before dying (live-confirmed in chatgenie.log).
  let totalRan = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  // any real work this wish (a flush that ran commands, BUILD, PLACE,
  // WRITEFILE)? A DONE claiming completion with zero work gets challenged once
  // — 'SAY: Time set to day' once shipped with no time command in the trail.
  let didWork = false;
  let zeroWorkChallenged = false;
  // ...and did any of it actually CHANGE the world? Read-only probes count as
  // didWork, so a wish of pure "data get"s passed the zero-work guard while a
  // DONE claimed items were given (live 2026-07-21: "restored your inventory"
  // — zero gives, inventory verified empty, DONE sailed through). A DONE with
  // work-but-no-mutation gets challenged once, same shape as zero-work.
  let didMutate = false;
  let readOnlyChallenged = false;
  let verdict: string | null = null;
  // has the player already been told how this wish ended? Without this the
  // epilogue fired a GREEN "done" on every path the model never finished —
  // including straight after the red "my brain timed out".
  let spoke = false;
  // did any command in this wish return an in-world "Test passed"? blueprints
  // only earn the "verified" badge when this is true
  let sawTestPass = false;
  // Ledger audit state: the mark is taken LAZILY at the first block-changing
  // batch (inside flush, before rconBatch) — taking it up front copied the
  // whole sqlite for every "give me a stick" wish, three deep in parallel.
  // At the first DONE the panel asks the Ledger DB what the commands ACTUALLY
  // changed in the wish-wide footprint (schematic PLACEs excluded: `place
  // template` writes nothing to Ledger, verified live; samples cover those).
  let ledgerStart: number | null = null;
  let ledgerMarkAt = 0;
  let wishBox: Box | null = null;
  let ledgerAudited = false;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const failedBefore = totalFailed; // per-round counters gate same-reply DONE
    const ranBefore = totalRan;
    const skippedBefore = totalSkipped;
    await rconCommand(id, `bossbar set ${barId} value ${round}`).catch(() => {});
    await bar(round === 0 ? 'thinking…' : `thinking (round ${round + 1})…`);
    // ---- STREAMING ROUND ----
    // Commands execute the moment the model writes them instead of after the
    // full reply: the player watches the build grow during generation,
    // PROGRESS lands mid-thought, and DONE relays the instant the reply ends.
    // Verdicts still apply after the work (and after all failures are known).

    // per-line markdown strip — backtick-wrapped commands once reached the
    // server VERBATIM, and **DONE** in bold dodged the verdict regex
    const stripLine = (l: string) =>
      l
        .replace(/^```\w*|```$/g, '')
        .trim()
        .replace(/^`([^`]+)`$/, '$1')
        .replace(/^\*{1,2}(DONE|SAY|INFO|PROGRESS|WIKI|YOUTUBE|WAIT|BUILD|PLACE|REMEMBER|DIAGNOSE|ESCALATE)\*{1,2}[:\s]*/i, '$1 ')
        .replace(/^[-*]\s+(INFO\b)/i, '$1') // "- INFO x": the bullet habit dies hard
        .replace(/^[-*]\s+/, '')
        .replace(/^\d+[.)]\s+/, '') // "1. give ..." — a numbered list ran NOTHING
        .replace(/^>\s+/, '') // blockquote
        .replace(/^\//, '')
        .trim();

    const out: string[] = [];
    let doneLine: string | null = null;
    let sayLine: string | null = null;
    let sayBullets: string[] = [];
    let escalate = false;
    // set when a WAITFOR times out: the rest of the reply was written for a
    // condition that never happened (scare act 2 waiting on the player to
    // arrive) — firing it anyway would play the acts to an empty stage
    let abortReply = false;

    // blueprint/file bodies are data, not work: captured while streaming and
    // finalized at their END marker. A DONE inside a body can no longer end
    // the wish — body lines never reach the verdict capture below.
    type BodyMode =
      | { kind: 'blueprint'; header: string; lines: string[] }
      | { kind: 'writefile'; path: string; lines: string[] }
      | null;
    let bodyMode: BodyMode = null;
    const finalizeBlueprint = async () => {
      if (bodyMode?.kind !== 'blueprint') return;
      const [rawName, ...descParts] = bodyMode.header.split('|');
      // whitelist real commands: every panel directive is UPPERCASE while
      // Minecraft/mod commands are lowercase brigadier literals — a WAIT or
      // PROGRESS captured into a blueprint used to poison every future replay
      // with guaranteed rejections
      const cmds = bodyMode.lines.filter((l) => {
        const fw = l.replace(/^\//, '').split(/\s+/)[0] ?? '';
        return /^[a-z][a-z0-9_-]{0,24}$/.test(fw) && !BLOCKED.test(l);
      });
      bodyMode = null;
      if (cmds.length === 0) return;
      const bp = saveBlueprint({
        name: rawName.trim(),
        description: descParts.join('|').trim() || rawName.trim(),
        commands: cmds,
        // "verified" is earned, not claimed: only if this wish actually saw
        // an in-world "Test passed" does the blueprint get the badge
        verified: sawTestPass,
      }, mcVersion); // era-stamped — same cross-version footgun as notes
      trail.push(`> SAVEBLUEPRINT ${bp.name} (${cmds.length} commands, ${bp.verified ? 'verified' : 'UNVERIFIED'})`);
      log(`chatgenie: learned blueprint "${bp.name}" (${cmds.length} commands, verified=${bp.verified})`);
      await say(`learned it — "${bp.name}" is in my memory now`, 'aqua');
    };
    const finalizeWritefile = () => {
      if (bodyMode?.kind !== 'writefile') return;
      const { path, lines: bodyLines } = bodyMode;
      bodyMode = null;
      const body = bodyLines.join('\n');
      try {
        writeConfig(id, path, body);
        didWork = true;
        didMutate = true;
        out.push(`WRITEFILE ${path}: saved (.bak kept; applies on next restart)`);
        trail.push(`> WRITEFILE ${path}\n< saved (${body.length} bytes)`);
      } catch (e) {
        out.push(`WRITEFILE ${path} FAILED: ${String(e).slice(0, 120)}`);
        trail.push(`> WRITEFILE ${path}\n< FAILED`);
      }
    };

    // Lines execute IN ORDER, commands and directives interleaved. Plain
    // commands micro-batch: they collect while the model keeps writing and
    // flush after a short gap (or 30 pending, or when a directive needs
    // ordering) — one RCON connection per batch, blocks appearing live.
    let pending: string[] = [];
    let flushTimer: NodeJS.Timeout | null = null;
    const flush = async () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      const cmds = pending.slice(0, Math.max(0, MAX_CMDS - totalRan));
      const dropped = pending.length - cmds.length;
      pending = [];
      if (dropped > 0) {
        // over-budget commands must never vanish silently — a DONE over a
        // half-run reply would pass the guard while the roof never got built.
        // They were SKIPPED, not failed: gate DONE, but don't invite "fixes".
        totalSkipped += dropped;
        out.push(`(BUDGET EXCEEDED: ${dropped} command(s) were NOT run — this wish's ${MAX_CMDS}-command budget is spent. Do not claim they ran; finish with SAY explaining what remains.)`);
        trail.push(`* ${dropped} command(s) dropped — over the ${MAX_CMDS}-command budget`);
      }
      if (cmds.length === 0) return;
      await bar(`running ${cmds.length} command${cmds.length > 1 ? 's' : ''}…`);
      // silent safety net: snapshot the region this batch is about to change,
      // so "server undo" can put it back
      const box = boxFromCommands(cmds);
      if (box) {
        // first block-changing batch: take the Ledger mark NOW, provably before
        // the first change lands (and never at all for pure give/tp wishes)
        if (ledgerStart === null) {
          ledgerStart = await ledgerMark(id).catch(() => null);
          ledgerMarkAt = Date.now();
        }
        wishBox = unionBox(wishBox, box);
        const snap = await takeSnapshot(id, box, wish).catch(() => null);
        if (snap) trail.push(`* ${snap}`);
      }
      // landing protection BEFORE the teleports execute — applying it after the
      // batch meant a player could already be falling for the whole round-trip
      // (and on an RCON throw the guard never ran though the tp may have)
      await guardTeleports(id, cmds, wish).catch(() => {});
      // an RCON throw here (server stopping mid-wish, socket dropped, RCON not
      // enabled) used to reach a bare .catch(() => {}) in scheduleFlush: the
      // commands neither ran nor counted, so the reply's DONE sailed through the
      // guard and the player was told a build landed that never existed.
      const logMark = logSizeOf(id);
      let results: string[];
      try {
        results = await rconBatch(id, cmds);
      } catch (e) {
        totalSkipped += cmds.length; // NOT run — gate DONE, never claim done
        const why = String((e as Error)?.message ?? e).slice(0, 160);
        out.push(`(RCON FAILED: ${cmds.length} command(s) did NOT run — ${why}. The server may be stopping or restarting. Do not claim any of this landed.)`);
        trail.push(`* RCON FAILED — ${cmds.length} command(s) not run: ${why}`);
        return;
      }
      // refresh guard durations after a long batch (no-op when there are no tps)
      guardTeleports(id, cmds, wish).catch(() => {});
      totalRan += cmds.length;
      didWork = true;
      for (let i = 0; i < cmds.length; i++) {
        if (!READ_ONLY_CMD.test(cmds[i]) && !isRconFailure(results[i] ?? '')) { didMutate = true; break; }
      }
      const freshErr = freshLogErrors(id, logMark);
      if (freshErr.length) {
        out.push(`(SERVER LOG threw right after your commands — a command can look fine over RCON while the server errors internally. Read this before any DONE claim, DIAGNOSE if it names your command:\n${freshErr.join('\n')})`);
        trail.push(`* log errors after batch: ${freshErr[0].slice(0, 120)}`);
      }
      const failed = results.filter(isRconFailure).length;
      totalFailed += failed;
      // "Test passed" from a bare air probe is a SITE SURVEY, not a machine test
      // — letting it set sawTestPass stamped verified:true on blueprints that
      // were never actually run. Only a probe for a REAL block counts.
      for (let i = 0; i < cmds.length; i++) {
        if (/Test passed/i.test(results[i] ?? '') && !/if\s+blocks?\s+.*minecraft:air\s*$/i.test(cmds[i]))
          sawTestPass = true;
      }
      for (let i = 0; i < cmds.length; i++) {
        const r = results[i] ?? '';
        // a no-op ("No blocks were filled") is not a rejection, but it is how a
        // build silently does nothing — label it so the model cannot skim past it
        const tag = isRconFailure(r) ? '  [REJECTED] ' : isRconNoop(r) ? '  [DID NOTHING] ' : '  -> ';
        trail.push(`> ${cmds[i]}\n< ${r.slice(0, 200)}`);
        out.push(`${cmds[i]}\n${tag}${(r || '(no output)').slice(0, 300)}`);
      }
    };

    const scheduleFlush = () => {
      if (flushTimer || pending.length === 0) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        chain = chain.then(flush).catch(() => {});
      }, 1200);
      flushTimer.unref?.();
    };

    const handleLine = async (raw: string): Promise<void> => {
    // single-iteration loop so the transplanted handlers keep their `continue`s
    for (const op of [stripLine(raw)]) {
      if (abortReply) continue; // a WAITFOR timed out — this reply is void
      // BODY CAPTURE COMES BEFORE THE BLANK-SKIP AND USES THE RAW LINE for
      // file bodies: stripLine exists to sanitize COMMANDS, but applied to a
      // WRITEFILE body it destroyed YAML indentation, dropped blank lines,
      // turned '// comment' into '/ comment' and stripped list dashes — the
      // saved config was silently corrupted. Blueprint bodies are commands,
      // so they keep the stripped form (and skip blanks).
      if (bodyMode) {
        if (bodyMode.kind === 'blueprint') {
          if (/^ENDBLUEPRINT\b/.test(op)) { await finalizeBlueprint(); continue; }
          if (op) bodyMode.lines.push(op);
          continue;
        }
        // writefile
        if (/^ENDFILE\b/.test(op)) { finalizeWritefile(); continue; }
        const line = raw.replace(/\r$/, '');
        if (!/^\s*```/.test(line)) bodyMode.lines.push(line); // fences are wrapper, not content
        continue;
      }
      if (!op) continue;
      if (/^SAVEBLUEPRINT\b/.test(op)) { bodyMode = { kind: 'blueprint', header: op.replace(/^SAVEBLUEPRINT\s+/, ''), lines: [] }; continue; }
      if (/^WRITEFILE\b/.test(op)) { bodyMode = { kind: 'writefile', path: op.replace(/^WRITEFILE\s+/, '').trim(), lines: [] }; continue; }
      if (/^(ENDBLUEPRINT|ENDFILE)\b/.test(op)) continue; // stray end marker
      if (/^DIAGNOSE\b/.test(op)) {
        const why = op.replace(/^DIAGNOSE\s+/, '').trim();
        addRemedy(why, mcVersion);
        trail.push(`> DIAGNOSE ${why.slice(0, 140)}`);
        out.push(`(diagnosis recorded as a permanent remedy for this version — now retry with the fix)`);
        continue;
      }
      if (/^REMEMBER\b/.test(op)) {
        const fact = op.replace(/^REMEMBER\s+/, '').trim();
        addNote(fact, mcVersion);
        trail.push(`> REMEMBER ${fact}`);
        continue;
      }
      if (/^ESCALATE\b/.test(op)) { escalate = true; continue; }
      if (/^DONE\b/.test(op)) { doneLine = op; continue; }
      if (/^SAY\b/.test(op)) { sayLine = op; continue; }
      // INFO lines are the multi-point half of an answer — buffered in reply
      // order and rendered as an indented list under the SAY/DONE headline,
      // whichever side of it they were written on. Markdown "- " bullets
      // can't fill this role: stripLine eats the dash (it must, so bulleted
      // COMMANDS still run), which is exactly how the player's modpack
      // tutorial got discarded as narration three times (live 2026-07-27).
      if (/^INFO\b/.test(op)) {
        if (sayBullets.length < 10) sayBullets.push(op.replace(/^INFO[:\s]*/i, '').slice(0, 160));
        trail.push(`  • ${op.replace(/^INFO[:\s]*/i, '').slice(0, 100)}`);
        continue;
      }
      if (/^PROGRESS\b/.test(op)) {
        // milestone: relay to the player the instant the part's commands ran.
        // PROGRESS is written in the PAST TENSE ("TNT cube placed"), so relaying
        // it after its commands were rejected tells the player a thing exists
        // that does not. Same contract as DONE: no claim over failed work.
        const pFailedBefore = totalFailed;
        const pSkippedBefore = totalSkipped;
        await flush();
        const msg = op.replace(/^PROGRESS\s+/, '').trim().slice(0, 200);
        // rejected OR never-ran — either way the claimed part did not fully land
        if (totalFailed > pFailedBefore || totalSkipped > pSkippedBefore) {
          const n = totalFailed - pFailedBefore + (totalSkipped - pSkippedBefore);
          out.push(`(PROGRESS WITHHELD: "${msg.slice(0, 60)}…" was not relayed — ${n} command(s) in that part did not land. Fix them; do not claim that part landed.)`);
          trail.push(`* PROGRESS withheld (${n} not landed): ${msg}`);
          continue;
        }
        trail.push(`* PROGRESS: ${msg}`);
        await say(msg, 'aqua', 'say');
        continue;
      }
      if (/^WAITFOR\b/.test(op)) {
        // WAITFOR <player> <x> <y> <z> <radius> <maxSeconds> — pause THIS reply
        // until the player is within radius of the point (polled every 2.5s,
        // dimension-agnostic distance on X/Z+Y). Lets one reply hold a whole
        // condition-gated sequence: "WAITFOR … / act commands / WAITFOR … /
        // more acts / DONE". On timeout the REST OF THE REPLY IS DISCARDED and
        // the model gets the player's actual position to re-plan.
        await flush();
        const wm = /^WAITFOR\s+([A-Za-z0-9_]{3,16})\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)/.exec(op);
        if (!wm) {
          out.push(`WAITFOR failed: syntax is WAITFOR <player> <x> <y> <z> <radius> <maxSeconds>.`);
          trail.push(`> ${op}\n< bad syntax`);
          continue;
        }
        const [, wp, wx, wy, wz, wr, wmax] = wm;
        const maxS = Math.min(300, Math.max(5, Number(wmax)));
        const radius = Math.max(2, Number(wr));
        const deadline = Date.now() + maxS * 1000;
        let lastPos = 'unknown';
        let arrived = false;
        await bar(`waiting for ${wp} (up to ${maxS}s)…`);
        while (Date.now() < deadline) {
          try {
            const raw = await rconCommand(id, `data get entity ${wp} Pos`);
            const pm = /\[(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/.exec(raw);
            if (pm) {
              lastPos = `${Math.round(+pm[1])} ${Math.round(+pm[2])} ${Math.round(+pm[3])}`;
              const dist = Math.hypot(+pm[1] - +wx, +pm[2] - +wy, +pm[3] - +wz);
              if (dist <= radius) { arrived = true; break; }
            }
          } catch { /* server blip — keep polling until deadline */ }
          await new Promise((r) => setTimeout(r, 2500));
        }
        if (arrived) {
          out.push(`WAITFOR: ${wp} arrived at the point (now at ${lastPos}). Continuing.`);
          trail.push(`> ${op}\n< arrived`);
        } else {
          abortReply = true;
          out.push(`WAITFOR TIMED OUT after ${maxS}s: ${wp} never came within ${radius} blocks of ${wx} ${wy} ${wz} — last seen at ${lastPos}. The REST of your reply was discarded (its commands assumed the arrival). Re-plan from where the player actually is.`);
          trail.push(`> ${op}\n< timeout — rest of reply discarded`);
        }
        continue;
      }
      if (/^WAIT\b/.test(op)) {
        await flush();
        const secs = Math.min(60, Math.max(1, Number(op.replace(/^WAIT\s+/, '').trim()) || 3));
        await bar(`waiting ${secs}s for physics…`);
        await new Promise((r) => setTimeout(r, secs * 1000));
        out.push(`WAIT ${secs}: waited ${secs}s of real time — physics has ticked.`);
        trail.push(`> WAIT ${secs}`);
        continue;
      }
      if (/^BUILD\b/.test(op)) {
        await flush();
        const m = /^BUILD\s+(\S+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)(?:\s+([A-Za-z0-9_]{3,16}))?/.exec(op);
        const bp = m ? getBlueprint(m[1]) : null;
        if (!m || !bp) {
          out.push(`BUILD failed: no blueprint named "${m?.[1] ?? '?'}" — design it yourself, then SAVEBLUEPRINT it.`);
          trail.push(`> ${op}\n< no such blueprint`);
        } else {
          const box = boxFromBlueprint(bp.commands, Number(m[2]), Number(m[3]), Number(m[4]));
          if (box) {
            if (ledgerStart === null) {
              ledgerStart = await ledgerMark(id).catch(() => null);
              ledgerMarkAt = Date.now();
            }
            wishBox = unionBox(wishBox, box);
            const snap = await takeSnapshot(id, box, `${wish} (blueprint ${bp.name})`).catch(() => null);
            if (snap) trail.push(`* ${snap}`);
          }
          // <player> token → the optional 5th BUILD arg, else the wisher. This
          // is what lets ONE tier-kit blueprint (stone-kit, iron-kit…) serve
          // every player instead of baking a name in at save time.
          const target = m[5] ?? player;
          const cmds = renderBlueprint(bp, Number(m[2]), Number(m[3]), Number(m[4])).map((c) =>
            c.replaceAll('<player>', target),
          );
          // budget the replay against the SAME MAX_CMDS pool as everything else.
          // The old code sent cmds.slice(0, MAX_CMDS) but counted cmds.length —
          // so a 150-command blueprint ran 120, dropped 30 without a trace, and
          // told the model "ran 150 commands, 0 failed". The roof never existed.
          const room = Math.max(0, MAX_CMDS - totalRan);
          const toRun = cmds.slice(0, room);
          const dropped = cmds.length - toRun.length;
          await guardTeleports(id, toRun, wish).catch(() => {}); // kit blueprints can contain tps
          let res: string[] = [];
          try {
            res = await rconBatch(id, toRun);
          } catch (e) {
            totalSkipped += toRun.length + dropped; // never ran
            out.push(`BUILD ${bp.name} FAILED: RCON error, ${toRun.length} command(s) did NOT run — ${String((e as Error)?.message ?? e).slice(0, 120)}. Nothing was built.`);
            trail.push(`> BUILD ${bp.name} @ ${m[2]} ${m[3]} ${m[4]}\n< RCON FAILED`);
            continue;
          }
          const bad = res.filter(isRconFailure).length;
          // count the replay against the wish: without this a blueprint whose
          // every command errored still passed the withheld-DONE guard, and
          // the player was told a build was replayed over nothing
          totalRan += toRun.length;
          totalFailed += bad;
          totalSkipped += dropped;
          didWork = true;
          didMutate = true;
          const dropNote = dropped > 0 ? ` ${dropped} command(s) were NOT run (command budget spent) — the build is INCOMPLETE, do not claim it is finished.` : '';
          out.push(`BUILD ${bp.name} at ${m[2]} ${m[3]} ${m[4]}: ran ${toRun.length} of ${cmds.length} commands, ${bad} failed.${dropNote} Now TEST it works before saying DONE.`);
          trail.push(`> BUILD ${bp.name} @ ${m[2]} ${m[3]} ${m[4]}\n< ${toRun.length}/${cmds.length} cmds, ${bad} failed, ${dropped} dropped`);
          await say(`replaying "${bp.name}" from memory…`, 'aqua', 'tick');
        }
        continue;
      }
      if (/^PLACE\b/.test(op)) {
        await flush();
        const m = /^PLACE\s+(\S+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/.exec(op);
        if (!m) {
          out.push(`PLACE failed: syntax is PLACE <schematic> <x> <y> <z> (integers).`);
          trail.push(`> ${op}\n< bad syntax`);
          continue;
        }
        let forced: { dim: string; x1: number; z1: number; x2: number; z2: number } | null = null;
        try {
          const [px, rawY, pz] = [Number(m[2]), Number(m[3]), Number(m[4])];
          await bar(`placing "${m[1]}"…`);
          // THE PANEL OWNS THE Y. The model is given the player's position every
          // round and cheerfully anchors at their altitude — which is the sky if
          // they are flying or on a hill. Probe the real terrain under the
          // footprint and snap the build onto it. Peek at the size first (a
          // second stagePlacement call with the corrected y does the staging).
          const peek = listSchematics().find((s) => s.name === m[1]) ?? null;
          const dimRaw = await rconCommand(id, `data get entity ${player} Dimension`).catch(() => '');
          const dim = /"([a-z_:]+)"/.exec(dimRaw)?.[1] ?? 'minecraft:overworld';

          // FORCE-LOAD THE FOOTPRINT. Minecraft only answers block queries — and
          // only places blocks — in LOADED chunks; everywhere else every command
          // returns "That position is not loaded" and does nothing. Without this
          // the ground probe cannot see the terrain (and a build can stamp into
          // thin air). Always released in the finally: a forceload leaks into
          // level.dat and would keep those chunks ticking forever.
          const sizeX = peek?.size[0] ?? 48;
          const sizeZ = peek?.size[2] ?? 48;
          forced = { dim, x1: px, z1: pz, x2: px + sizeX - 1, z2: pz + sizeZ - 1 };
          await rconCommand(id, `execute in ${dim} run forceload add ${forced.x1} ${forced.z1} ${forced.x2} ${forced.z2}`).catch(() => {});

          let py = rawY;
          let anchorNote = '';
          if (peek) {
            const g = await groundAnchor(id, dim, px, pz, sizeX, sizeZ, rawY).catch(() => null);
            if (g?.probed && Math.abs(g.drop) >= 2) {
              py = g.y;
              anchorNote =
                g.drop > 0
                  ? ` GROUND-ANCHORED by the panel: you asked for y=${rawY}, but the ground under this footprint is at y=${g.y - 1} — the build would have floated ${g.drop} blocks up in the sky. It has been placed ON the ground at y=${py}. Do NOT build a platform under it and do NOT re-place it.`
                  : ` GROUND-ANCHORED by the panel: y=${rawY} was ${-g.drop} blocks INSIDE the terrain, so the build was raised to y=${py} to sit on the surface.`;
            } else if (g && !g.probed) {
              anchorNote = ` (the panel could not read the terrain under this footprint, so your y=${rawY} was used as-is — check the build is not floating.)`;
            }
          }
          // TERRAIN CLEARANCE (2026-07-20, owner report: placements clipped
          // into hillsides). Probe a coarse lattice through the volume ABOVE
          // the base layers; solid terrain there means the build would merge
          // into a hill. Refuse BEFORE staging — the model can pick flatter
          // ground, offer to clear the site, or override with a trailing
          // CONFIRM once the player agrees. Leaves/water/replaceables don't
          // count (coastal and forest placements are legitimate).
          const confirmClip = /\bCONFIRM\s*$/i.test(op);
          if (peek && !confirmClip) {
            const H = peek.size[1];
            const ys = [...new Set([py + 3, py + Math.floor(H / 2), py + Math.max(3, H - 2)])].filter((yy) => yy > py + 2);
            const probes: string[] = [];
            for (const yy of ys) {
              for (let ix = 0; ix < 5; ix++) {
                for (let iz = 0; iz < 5; iz++) {
                  const sx = px + Math.floor(((sizeX - 1) * ix) / 4);
                  const sz = pz + Math.floor(((sizeZ - 1) * iz) / 4);
                  probes.push(
                    `execute in ${dim} unless block ${sx} ${yy} ${sz} #minecraft:replaceable unless block ${sx} ${yy} ${sz} #minecraft:leaves unless block ${sx} ${yy} ${sz} minecraft:water unless block ${sx} ${yy} ${sz} #minecraft:logs`,
                  );
                }
              }
            }
            const cres = await rconBatch(id, probes).catch(() => [] as string[]);
            const solid = cres.filter((r) => /Test passed/i.test(r)).length;
            if (cres.length && solid / cres.length > 0.15) {
              out.push(
                `PLACE refused by the panel's clearance check: ${solid} of ${cres.length} probes inside the build volume (above its base) hit solid terrain — stamping here would merge the build into a hill/cliff. Options: pick flatter ground nearby, or re-issue the SAME line with " CONFIRM" appended to stamp anyway (only after telling the player it will cut into the terrain).`,
              );
              trail.push(`> ${op}\n< CLEARANCE REFUSED (${solid}/${cres.length} solid)`);
              continue;
            }
          }
          const { commands: placeCmds, meta, needsReload } = stagePlacement(id, m[1], px, py, pz);
          // undo covers the whole footprint before anything is stamped
          const box = { x1: px, y1: py, z1: pz, x2: px + meta.size[0] - 1, y2: py + meta.size[1] - 1, z2: pz + meta.size[2] - 1 };
          const snap = await takeSnapshot(id, box, `${wish} (schematic ${meta.name})`).catch(() => null);
          if (snap) trail.push(`* ${snap}`);
          if (needsReload) {
            // `/reload` on a modded server runs ~1.5–2s+ and MUST finish before
            // the freshly-staged template can be placed. The old default 2s RCON
            // timeout made this race: reload timed out, the .catch swallowed it,
            // and `place template` ran mid-reload against a not-yet-registered
            // template — the build stamped nothing yet reported success. Give it
            // a real budget and let it complete before placing.
            await rconCommand(id, 'reload', { timeout: 60_000 }).catch(() => {});
          }
          const res = await rconBatch(id, placeCmds, { timeout: 60_000 });
          const isBad = (r: string) => isRconFailure(r) || /not found|no template|not loaded/i.test(r);
          const bad = res.filter(isBad).length;
          // PLACE commands are wish work — uncounted, a schematic-only wish
          // read as "zero ran" and got wrongly challenged at DONE
          totalRan += placeCmds.length;
          didWork = true;
          didMutate = true;
          if (bad > 0) totalFailed += bad;
          // the panel verifies the stamp itself against known solid cells from
          // the schematic — the model once probed (air) corners, concluded a
          // SUCCESSFUL placement had failed, and told the player it was broken
          let verifyLine = '';
          if (bad === 0 && meta.samples?.length) {
            const probes = meta.samples.map((s) => `execute in ${dim} if block ${px + s.pos[0]} ${py + s.pos[1]} ${pz + s.pos[2]} ${s.block}`);
            const pres = await rconBatch(id, probes);
            const okCount = pres.filter((r) => /Test passed/i.test(r)).length;
            // EVERY sample must match. A bare majority "VERIFIED" a 4-tile mansion
            // whose samples all happened to fall in the one tile that stamped —
            // three quarters of the house was missing and the panel called it good.
            if (okCount === meta.samples.length) {
              verifyLine = ` PLACEMENT VERIFIED by the panel: all ${okCount}/${meta.samples.length} sample blocks match the template. The build IS in the world — do NOT re-place it and do NOT clear it.`;
              sawTestPass = true;
            } else {
              totalFailed += 1;
              verifyLine = ` PLACEMENT CHECK FAILED: only ${okCount} of ${meta.samples.length} sample blocks match — part of the build did NOT stamp. Do not claim success; report honestly what is missing.`;
            }
          } else if (bad === 0) {
            // No sample cells to check against (legacy entry with empty samples).
            // We cannot confirm the blocks actually landed, so DON'T let the model
            // claim a verified success on faith — that is exactly how the "reports
            // success but nothing stamped" report happened.
            verifyLine = ` PLACEMENT UNVERIFIED: the panel has no sample cells for this build, so it could not confirm the blocks landed — check in-game before telling the player it worked.`;
          }
          out.push(`PLACE ${meta.name} at ${px} ${py} ${pz}: ${placeCmds.length} template${placeCmds.length > 1 ? 's' : ''} placed, ${bad} failed${bad ? ` — first error: ${res.find(isBad)?.slice(0, 150)}` : ''}. Footprint ${meta.size[0]}×${meta.size[1]}×${meta.size[2]} from the anchor.${anchorNote}${verifyLine}`);
          trail.push(`> PLACE ${meta.name} @ ${px} ${py} ${pz}${anchorNote ? ` (ground-anchored from y=${rawY})` : ''}\n< ${placeCmds.length} tiles, ${bad} failed${verifyLine ? `\n<${verifyLine.trim()}` : ''}`);
          await say(`stamping "${meta.name}" from the build library…`, 'aqua', 'tick');
        } catch (e) {
          totalFailed += 1;
          out.push(`PLACE FAILED: ${String((e as Error).message ?? e).slice(0, 200)}. Library builds available: ${listSchematics().map((s) => s.name).join(', ') || '(none)'}.`);
          trail.push(`> ${op}\n< FAILED: ${String((e as Error).message ?? e).slice(0, 150)}`);
        } finally {
          // a leaked forceload is written into level.dat and keeps those chunks
          // ticking for the life of the world — release it no matter what happened
          if (forced)
            await rconCommand(
              id,
              `execute in ${forced.dim} run forceload remove ${forced.x1} ${forced.z1} ${forced.x2} ${forced.z2}`,
            ).catch(() => {});
        }
        continue;
      }
      if (/^SNAPSHOTS\b/.test(op)) {
        await flush();
        const who = op.replace(/^SNAPSHOTS\s+/, '').trim() || player;
        await bar('reading insurance…');
        const { playerSnapshots } = await import('./deathinsurance.js');
        const snaps = playerSnapshots(id, who);
        if (!snaps.length) {
          out.push(`SNAPSHOTS ${who}: none recorded yet — insurance snapshots every 3 min while online. Fall back to kit blueprints or the recent conversation.`);
        } else {
          const listing = snaps.map((s, i) => `#${i} ${s.at} (${s.stacks} stacks)`).join(', ');
          const last = snaps[snaps.length - 1];
          const prev = snaps.length > 1 ? snaps[snaps.length - 2] : null;
          out.push(
            [
              `SNAPSHOTS ${who} (oldest first): ${listing}`,
              `LATEST #${snaps.length - 1} Inventory SNBT:\n${last.inv.slice(0, 6000)}`,
              ...(last.equip ? [`LATEST equipment SNBT:\n${last.equip.slice(0, 2000)}`] : []),
              ...(prev
                ? [`PREVIOUS #${snaps.length - 2} Inventory SNBT (use this if the latest was taken AFTER the death, i.e. is empty/near-empty):\n${prev.inv.slice(0, 6000)}`,
                   ...(prev.equip ? [`PREVIOUS equipment SNBT:\n${prev.equip.slice(0, 2000)}`] : [])]
                : []),
            ].join('\n'),
          );
        }
        trail.push(`> SNAPSHOTS ${who}\n< ${snaps.length} snapshot(s)`);
        continue;
      }
      if (/^REGISTRY\b/.test(op)) {
        const query = op.replace(/^REGISTRY\s+/, '').trim();
        const res = registrySearch(id, query);
        out.push(res);
        trail.push(`> REGISTRY ${query}\n< ${res.slice(0, 100)}…`);
        continue;
      }
      if (/^LOGTAIL\b/.test(op)) {
        const n = Math.min(parseInt(op.replace(/^LOGTAIL\s*/, '') || '30', 10) || 30, 80);
        let tail = '(log unreadable)';
        try {
          const lf = join(serverDir(id), 'logs', 'latest.log');
          const size = statSync(lf).size;
          const fd = openSync(lf, 'r');
          const buf = Buffer.alloc(Math.min(size, 40_000));
          readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
          closeSync(fd);
          tail = buf.toString('utf8').split('\n')
            .filter((l) => !/RCON (Listener|Client)|\[Rcon:/.test(l))
            .slice(-n).join('\n');
        } catch { /* keep default */ }
        out.push(`SERVER LOG (last ${n} lines):\n${tail}`);
        trail.push(`> LOGTAIL ${n}`);
        continue;
      }
      if (/^RECIPE\b/.test(op)) {
        await flush();
        const query = op.replace(/^RECIPE\s+/, '').trim();
        await bar('recipes…');
        const res = modRecipes(id, query);
        out.push(res);
        trail.push(`> RECIPE ${query}\n< ${res.slice(0, 120)}…`);
        continue;
      }
      if (/^WIKI\b/.test(op)) {
        await flush();
        const query = op.replace(/^WIKI\s+/, '').trim();
        await bar('wiki…');
        try {
          const res = await wikiLookup(query);
          out.push(res);
          trail.push(`> WIKI ${query}\n< ${res.slice(0, 120)}…`);
        } catch (e) {
          out.push(`WIKI ${query} FAILED: ${String(e).slice(0, 120)}`);
          trail.push(`> WIKI ${query}\n< FAILED`);
        }
        continue;
      }
      if (/^YOUTUBE\b/.test(op)) {
        await flush();
        const query = op.replace(/^YOUTUBE\s+/, '').trim();
        await bar('video…');
        try {
          const res = await youtubeResearch(query);
          out.push(res);
          trail.push(`> YOUTUBE ${query}\n< ${res.slice(0, 160)}…`);
        } catch (e) {
          out.push(`YOUTUBE ${query} FAILED: ${String(e).slice(0, 120)}`);
          trail.push(`> YOUTUBE ${query}\n< FAILED`);
        }
        continue;
      }
      if (/^READFILE\b/.test(op)) {
        await flush();
        const path = op.replace(/^READFILE\s+/, '').trim();
        try {
          const f = readConfig(id, path);
          const body = f.tooBig ? '(file too big to show)' : f.content.slice(0, 6000);
          out.push(`READFILE ${path}:\n${body}`);
          trail.push(`> READFILE ${path}\n< ${f.content.length} bytes`);
        } catch (e) {
          out.push(`READFILE ${path} FAILED: ${String(e).slice(0, 120)}`);
          trail.push(`> READFILE ${path}\n< FAILED`);
        }
        continue;
      }
      if (isBlockedCmd(op)) continue;
      // belt and braces: in secret mode a stray public broadcast never leaves,
      // even if the model ignores the rule above
      // (the `execute … run say …` form slipped past a start-anchored check)
      if (secret && (/(^|\brun\s+)(say|me|teammsg|tm|broadcast)\b/i.test(op) || /(^|\brun\s+)(tellraw|title|titleraw)\s+@a\b/i.test(op) || /^\s*bossbar\b.*\bplayers\s+@a\b/i.test(op))) continue;
      // prose guard: the model sometimes narrates ("I need to just answer
      // with plain commands…") and those sentences reached the console as
      // commands — every one errors and can wrongly withhold a DONE. A real
      // command's first token is a bare lowercase word; sentences have
      // apostrophes/dashes/capitalized "I" openers and many words.
      const firstWord = op.replace(/^\//, '').split(/\s+/)[0] ?? '';
      if (!/^[a-z][a-z0-9_-]{0,24}$/.test(firstWord)) {
        // Two different things land here and they must be scored differently:
        //  - a NUMBERED/BULLETED COMMAND ("2. summon graveyard:ghoul …") is an
        //    intended command that did not run → totalFailed, gates DONE.
        //  - TRUE NARRATION ("I'll give them the items now…") is noise →
        //    totalSkipped. Counting narration as failure created a live
        //    deadlock: every withhold message provoked more narration, each
        //    narration line "failed" the next round, and the model RE-RAN its
        //    already-successful gives while trying to appease the gate.
        const renumbered = op.replace(/^[-*\d]+[.)]?\s*/, '');
        const rw = renumbered.replace(/^\//, '').split(/\s+/)[0] ?? '';
        if (renumbered !== op && /^[a-z][a-z0-9_-]{0,24}$/.test(rw)) {
          totalFailed += 1; // an intended command that never ran
          trail.push(`* NOT RUN (numbered command): "${op.slice(0, 80)}"`);
          out.push(`(NOT RUN — numbered/bulleted lines never execute: "${op.slice(0, 60)}…". Send the bare command alone on its line.)`);
        } else if (sayLine || doneLine) {
          // prose after the SAY/DONE is the ANSWER's content, not narration
          // (planning talk comes before commands; nothing follows a verdict
          // but the points it promised). Salvage it as bullets.
          if (sayBullets.length < 10) {
            sayBullets.push(op.slice(0, 160));
            trail.push(`  • ${op.slice(0, 100)}`);
          }
        } else {
          totalSkipped += 1; // narration — ignore, don't provoke "fixes"
          trail.push(`* NOT RUN (not a plain command): "${op.slice(0, 80)}"`);
          out.push(`(NOT RUN — this was not a plain command: "${op.slice(0, 80)}…". Reply with bare console command lines, no numbering, no prose. Nothing from this line happened. If that text was information FOR THE PLAYER, they never saw it — player-facing points must be INFO lines with a SAY headline.)`);
        }
        continue;
      }
      pending.push(op);
      if (pending.length >= 30) await flush();
      else scheduleFlush();
    }
    };

    // serialize the stream: lines execute strictly in arrival order, each
    // handler finishing before the next starts
    let chain: Promise<void> = Promise.resolve();
    const feed = (raw: string) => {
      chain = chain.then(() => handleLine(raw)).catch((e) => {
        trail.push(`* stream error: ${String(e).slice(0, 120)}`);
      });
    };

    try {
      await askClaude(transcript.join('\n'), web, feed);
    } catch (e) {
      // FIRST, synchronously: disarm the buffered tail. The armed 1.2s flush
      // timer + pending[] used to fire DURING this catch — up to 30 commands
      // executed invisibly AFTER the player was told the wish failed, then
      // duplicated on the retry.
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      const droppedTail = pending.length;
      pending = [];
      if (droppedTail) trail.push(`* ${droppedTail} buffered command(s) dropped — wish failed before they ran`);
      // never die silently: the old code returned here without writing the
      // log, so every timed-out build wish vanished without a trace
      await chain.catch(() => {});
      // a fast-tier run that produced ZERO output in 60s is a hung run, not a
      // hard failure — retry once on the deep tier instead of giving up
      if (!web && /NO_OUTPUT/.test(String(e))) {
        web = true;
        trail.push(`* fast tier produced no output — retrying on the deep tier`);
        await bar('taking longer than usual — switching to the deep brain…');
        transcript.push(``, `(Your previous attempt produced no output and was restarted. Handle the wish now.)`);
        round--; // the dead-air attempt must not consume a round
        continue;
      }
      log(`chatgenie: claude failed: ${String(e)}`);
      trail.push(`= FAILED: ${String(e).slice(0, 200)}`);
      await say('my brain timed out — say it again', 'red', 'fail');
      spoke = true;
      break;
    }
    await chain;
    // a body block the model forgot to close still lands (TS cannot see the
    // closure mutations, hence the cast)
    const openBody = bodyMode as BodyMode;
    if (openBody?.kind === 'blueprint') await finalizeBlueprint();
    if (openBody?.kind === 'writefile') finalizeWritefile();
    await flush();

    // FAST-tier model judged the wish too complex for itself — rerun this
    // round on the deep tier (Opus + full thinking). Costs one fast round,
    // only on the rare wish where the keyword router guessed wrong.
    if (escalate && !web) {
      web = true;
      trail.push(`* ESCALATED to deep mode`);
      await bar('this needs real thought — switching to the deep brain…');
      // hand the deep model everything the fast round already DID — without
      // this it repeated the side-effectful commands the fast round had run
      if (out.length > 0) {
        transcript.push(``, `Round ${round + 1} — you escalated mid-reply. Everything below ALREADY RAN — do NOT run it again:`, out.join('\n'));
      }
      transcript.push(``, `You escalated. You are now in DEEP mode with full thinking. Handle the wish completely.`);
      round--; // escalation must not consume a round (one-shot: web is now true)
      continue;
    }

    if (doneLine || sayLine) {
      // a same-reply DONE — or SAY — is only relayed when every command in
      // the reply succeeded. SAY used to bypass this gate entirely: a reply
      // whose single command was skipped by the prose guard still delivered
      // "SAY Time set to day." to the player (2026-07-16, and the time was
      // not day). An honest-failure SAY survives this: the model sees the
      // failures and re-SAYs next round with nothing to withhold.
      const roundFailed = totalFailed - failedBefore;
      const roundRan = totalRan - ranBefore;
      const roundSkipped = totalSkipped - skippedBefore;
      if (roundFailed > 0) {
        trail.push(`* ${doneLine ? 'DONE' : 'SAY'} withheld — ${roundFailed} command(s) failed this round`);
        transcript.push(
          ``,
          `Round ${round + 1} — your ${doneLine ? 'DONE' : 'SAY'} was WITHHELD: ${roundFailed} command(s) failed. Results:`,
          out.join('\n'),
          ``,
          `Fix ONLY what failed (successful commands already ran — never repeat them), then DONE, or SAY honestly what could not be done.`,
        );
        continue;
      }
      // a DONE that claims completion while the WHOLE WISH did no work at all:
      // challenge once. ('SAY: Time set to day.' once shipped with no time
      // command anywhere in the trail — deep tier, pure narration.)
      if (doneLine && !didWork && !zeroWorkChallenged) {
        zeroWorkChallenged = true;
        trail.push(`* DONE withheld once — zero commands ran this wish`);
        transcript.push(
          ``,
          `Round ${round + 1} — your DONE was WITHHELD: nothing ran this entire wish (no commands, no BUILD/PLACE/WRITEFILE)${roundSkipped ? ` — ${roundSkipped} line(s) were skipped as prose` : ''}. If action was needed, run it now. If the world is genuinely already in the wished state, prove it with a read-only command and reply DONE again.`,
        );
        continue;
      }
      // the sibling hole: commands ran, but every one was a QUERY. "Restored
      // your inventory" once shipped over nothing but data-gets that PROVED
      // the inventory empty (2026-07-21). Same one-shot challenge shape.
      if (doneLine && didWork && !didMutate && !readOnlyChallenged) {
        readOnlyChallenged = true;
        trail.push(`* DONE withheld once — only read-only commands ran this wish`);
        transcript.push(
          ``,
          `Round ${round + 1} — your DONE was WITHHELD: every command this wish ran was READ-ONLY (data get / list / bare execute-if — queries). NOTHING in the world changed, so a DONE claiming an action (gave, restored, teleported, built, healed…) would be a lie. If the wish needs action, run the real commands NOW — give/tp/effect/fill etc. If the wish genuinely required no change (a pure question, or you verified the world already matches), reply DONE again saying exactly that and nothing more.`,
        );
        continue;
      }
      void roundRan; // (kept for symmetry/debugging — the counters are cheap)
      // LEDGER AUDIT — once, at the first clean DONE of a wish that changed
      // blocks. The command-failure gate above only catches what the server
      // REJECTED; a fill can succeed and still change nothing. Ledger is the
      // ground truth: if it logged zero command-sourced changes in the wish's
      // whole footprint, no build exists, whatever the replies said.
      // wishBox mutates inside the streaming closures — TS can't see that (same
      // reason as the bodyMode cast above), hence the explicit type
      const wb = wishBox as Box | null;
      // the audit is only meaningful when NO other wish overlapped our window —
      // a parallel wish's setblock inside our box would fake a pass (and our
      // failure could be pinned on it). Unattributable → skip, never guess.
      const overlapped = (wishWindows.get(id) ?? []).some(
        (w) => w !== myWindow && (w.t1 === null || w.t1 > ledgerMarkAt),
      );
      if (doneLine && !ledgerAudited && ledgerStart !== null && wb && overlapped) {
        ledgerAudited = true;
        trail.push(`* Ledger audit skipped — another wish ran concurrently (unattributable)`);
      }
      if (doneLine && !ledgerAudited && ledgerStart !== null && wb) {
        ledgerAudited = true; // one audit per wish — a re-DONE must not loop forever
        const audit = await ledgerAudit(id, ledgerStart, wb).catch(() => null);
        if (audit && audit.total === 0) {
          trail.push(`* DONE withheld — Ledger audit: ZERO block changes in the build area`);
          transcript.push(
            ``,
            `Round ${round + 1} — your DONE was WITHHELD by the panel's Ledger audit: the server's block-change log recorded ZERO changes from your commands anywhere in the build area (${wb.x1} ${wb.y1} ${wb.z1} to ${wb.x2} ${wb.y2} ${wb.z2}). The world was NOT modified. Results:`,
            out.join('\n'),
            ``,
            `If every block was genuinely already in the wished state, reply DONE again saying so. Otherwise the build does not exist — fix it first.`,
          );
          continue;
        }
        if (audit) trail.push(`* LEDGER audit: ${audit.total} block changes verified in footprint (${audit.placed} placed, ${audit.broken} broken${audit.blocks.length ? ` — ${audit.blocks.slice(0, 3).join(', ')}` : ''})`);
      }
      verdict = (doneLine ?? sayLine!).replace(/^(DONE|SAY)\s*/, '').slice(0, 480);
      trail.push(`= ${doneLine ? 'DONE' : 'SAY'}: ${verdict}`);
      await say(verdict, doneLine ? 'green' : 'yellow', doneLine ? 'done' : 'say');
      if (sayBullets.length) {
        await rconBatch(id, sayBullets.map((b) => genieBullet(player, b))).catch(() => {});
      }
      spoke = true;
      break;
    }
    if (out.length === 0) {
      await say('I could not turn that into commands', 'red', 'fail');
      spoke = true;
      break;
    }

    transcript.push(
      ``,
      `Round ${round + 1} — results:`,
      out.join('\n'),
      ``,
      `If the wish is complete, reply DONE <summary>. Otherwise continue (fix anything that failed).`,
    );
    await bar(`${totalRan} in · thinking…`);
  }

  // THE PANEL MUST NEVER INVENT A SUCCESS. Reaching here without a verdict means
  // the model never said DONE — it ran out of rounds, or timed out. The old code
  // announced a GREEN "done (N/N commands)" here regardless, so the player got a
  // red "my brain timed out" followed immediately by a triumphant green done.
  // Only report what actually happened.
  if (!verdict && !spoke) {
    const landed = totalRan - totalFailed; // failures are a subset of ran now
    if (totalRan === 0) {
      await say('I could not turn that into commands', 'red', 'fail');
    } else if (totalFailed > 0 || totalSkipped > 0) {
      await say(`unfinished — ${landed} of ${totalRan + totalSkipped} commands landed`, 'red', 'fail');
    } else {
      await say(`I ran out of rounds — ${landed} commands landed but I never finished the wish`, 'yellow', 'say');
    }
    spoke = true;
  }
  addEpisode({
    player,
    wish,
    mc: mcVersion,
    verdict: verdict ?? `NOT FINISHED (${totalRan} ran, ${totalFailed} rejected)`,
    // the actual commands that ran, straight from the trail (directives excluded)
    commands: trail
      .filter((t) => t.startsWith('> ') && !/^> (RECIPE|WIKI|YOUTUBE|SNAPSHOTS|SAVEBLUEPRINT|WRITEFILE|READFILE|DIAGNOSE|\[)/.test(t))
      .map((t) => t.slice(2).split('\n')[0]),
    at: new Date().toISOString(),
  });
  pushHistory(id, {
    player,
    wish,
    // history feeds the NEXT wish's prompt as "wishes you already handled" — an
    // unfinished wish recorded as a bland "finished" teaches the genie it worked
    verdict:
      verdict ??
      `NOT FINISHED — ran out of rounds/timed out (${totalRan} ran, ${totalFailed} rejected, ${totalSkipped} never ran, no summary given)`,
    at: new Date().toISOString(),
  });
  log(`chatgenie: ${player}: "${wish}"${secret ? ' [secret]' : ''} -> ${totalRan} ran, ${totalFailed} rejected, ${totalSkipped} skipped`);
  const logFile = join(PATHS.data, 'chatgenie.log');
  // rotate at 20MB (one .old kept) — this file is append-only and had no cap;
  // on an always-on box it grows forever
  try {
    if (existsSync(logFile) && statSync(logFile).size > 20_000_000) {
      renameSync(logFile, `${logFile}.old`);
    }
  } catch { /* rotation is best-effort — never lose the wish over it */ }
  writeFileSync(
    logFile,
    `[${new Date().toISOString()}] ${player}${secret ? ' (secret)' : ''}: ${wish}\n${trail.join('\n')}\n\n`,
    { flag: 'a' },
  );
  } finally {
    // close + prune this wish's activity window (keep recent finished windows —
    // they still disqualify a concurrent slow wish's audit)
    myWindow.t1 = Date.now();
    wishWindows.set(id, (wishWindows.get(id) ?? []).filter((w) => w.t1 === null || Date.now() - w.t1 < 30 * 60_000));
    // the wish bar must die with the wish, even on a thrown error — an orphan
    // boss bar would sit on the player's screen forever
    clearInterval(heartbeat);
    activeBars.delete(barId);
    await rconCommand(id, `bossbar remove ${barId}`).catch(() => {});
  }
}

// Boss bars are PERSISTENT world data: a server stop (or panel death) mid-wish
// means the finally above never reaches the server and the bar is saved into
// the world — stuck on the player's screen every session after. Sweep genie
// wish bars (spawnpoint:w<digits> only — spawnpoint:stats is the HUD's) each
// time a server comes up.
const activeBars = new Set<string>();
const sweptBars = new Set<string>();

// Whisper capability is a MOD fact, not a version fact: NO server logs /msg
// natively on this fleet (verified on Forge 1.20.1 AND Fabric 26.2) — whispers
// only reach the log-tail where WhisperMod is installed. Detected once per
// server boot; on incapable servers the first wish earns a one-time private
// hint to use "shh <wish>" instead of a whisper that silently vanishes.
const whisperState = new Map<string, 'capable' | 'incapable'>();
const whisperHinted = new Set<string>();

// ---- welcome-back digest ----
// The genie greets a returning player with what happened while they were away:
// wishes granted since their last visit + who else has been on. Zero model
// cost (composed from the history file); silent when there is nothing to tell.
const SEEN_FILE = join(PATHS.data, 'player-seen.json');
type SeenMap = Record<string, Record<string, string>>; // serverId -> player -> iso
function loadSeen(): SeenMap {
  try { return JSON.parse(readFileSync(SEEN_FILE, 'utf8')); } catch { return {}; }
}
function saveSeen(m: SeenMap): void {
  mkdirSync(PATHS.data, { recursive: true });
  writeFileSync(SEEN_FILE, JSON.stringify(m, null, 2), 'utf8');
}

function handleJoinLeave(id: string, name: string, what: 'joined' | 'left'): void {
  const seen = loadSeen();
  const srv = (seen[id] ??= {});
  const last = srv[name];
  srv[name] = new Date().toISOString();
  saveSeen(seen);
  if (what === 'left' || !last) return; // first-ever join: nothing to recap

  const wishes = (loadHistory()[id] ?? []).filter((h) => h.at > last);
  const visitors = Object.entries(srv)
    .filter(([n, at]) => n !== name && at > last)
    .map(([n]) => n)
    .slice(0, 4);
  if (!wishes.length && !visitors.length) return; // nothing happened — stay quiet

  const parts: unknown[] = [
    { text: '✦ ', color: 'aqua' },
    { text: `welcome back, ${name}`, color: 'aqua', bold: true },
    { text: ' — while you were away: ', color: 'gray' },
  ];
  if (wishes.length) {
    const lastWish = wishes[wishes.length - 1];
    parts.push({ text: `${wishes.length} wish${wishes.length > 1 ? 'es' : ''} granted`, color: 'white' });
    parts.push({ text: ` (latest: "${lastWish.wish.slice(0, 50)}")`, color: 'gray', italic: true });
  }
  if (visitors.length) {
    parts.push({ text: `${wishes.length ? ' · ' : ''}also online: ${visitors.join(', ')}`, color: 'white' });
  }
  // let the client finish joining before the message lands
  const t = setTimeout(() => {
    rconCommand(id, `tellraw ${name} ${JSON.stringify(parts)}`).catch(() => {});
  }, 8000);
  t.unref();
}

async function sweepOrphanBars(id: string, log: (m: string) => void): Promise<void> {
  // `bossbar list` prints display NAMES, not ids (verified live — a stuck bar
  // survived the first sweep because of this). The real ids live in the world
  // save: world/data/minecraft/custom_boss_events.dat
  await rconCommand(id, 'save-all flush').catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));
  const file = join(serverDir(id), 'world', 'data', 'minecraft', 'custom_boss_events.dat');
  if (!existsSync(file)) return;
  const { parseNbt } = await import('./nbt.js');
  const { root } = parseNbt(readFileSync(file));
  const rv = root.v as Record<string, { v: unknown }>;
  const events = (rv['data'] ?? rv['Data'] ?? root).v as Record<string, unknown>;
  const ids = Object.keys(events).filter((b) => /^spawnpoint:w\d+$/.test(b) && !activeBars.has(b));
  for (const b of ids) await rconCommand(id, `bossbar remove ${b}`).catch(() => {});
  if (ids.length) log(`chatgenie: swept ${ids.length} orphaned wish bar(s) on ${id}`);
}

/** Trigger words that open a wish. "shh"/"psst"/"secret" also mean: keep it
    off everyone else's screen. */
// "ssh" is accepted as a shh alias: the owner's fingers type the Linux
// command by reflex ("ssh spawn 5 iron golems…" went unparsed, 2026-07-19)
const TRIGGER = /^(?:(shh+|ssh+|psst+|secret(?:\s+genie)?|quietly)|server|genie)[,:]?\s+(.+)$/i;

/** Find a wish in one server-log line. Three carriers:
      1. public chat            <Steve> server give me a stick
      2. a whisper              /msg <anyone> ...  — nobody else sees this line
      3. the command echo       Steve issued server command: /msg …
    Whispers are secret by definition. Whispering YOURSELF is the cleanest
    genie line there is: private, and it bothers no one. A whisper aimed at
    another player still needs a trigger word, so ordinary DMs stay private
    conversations and don't get executed. */
function parseWish(line: string): { player: string; wish: string; secret: boolean } | null {
  const from = (text: string, secret: boolean, requireTrigger: boolean, player: string) => {
    const m = TRIGGER.exec(text.trim());
    if (m) return { player, wish: m[2], secret: secret || !!m[1] };
    if (requireTrigger) return null;
    return { player, wish: text.trim(), secret };
  };

  // 2/3. whisper — several log shapes exist across versions/mods, accept them all.
  // MC 26.2 logs NO whispers itself; WhisperMod puts them back as:
  //   [Whisper] Steve -> Steve: build me a base
  const w =
    /\]:\s+\[Whisper\]\s+([A-Za-z0-9_]{1,16})\s*->\s*([A-Za-z0-9_]{1,16}):\s*(.*)$/.exec(line) ??
    /\]:\s+(?:\[Not Secure\]\s+)?\[([A-Za-z0-9_]{1,16})\s*->\s*([A-Za-z0-9_]{1,16})\]\s*(.*)$/.exec(line) ??
    /\]:\s+(?:\[Not Secure\]\s+)?([A-Za-z0-9_]{1,16}) whispers to ([A-Za-z0-9_]{1,16}):\s*(.*)$/.exec(line);
  if (w) {
    const [, name, target, text] = w;
    if (!text.trim()) return null;
    return from(text, true, target !== name, name);
  }
  const c = /\]:\s+([A-Za-z0-9_]{1,16}) issued server command: \/(msg|w|tell|teammsg|tm)\s+(.*)$/i.exec(line);
  if (c) {
    const [, name, verb, rest] = c;
    const dm = /^(msg|w|tell)$/i.test(verb);
    const target = dm ? rest.trim().split(/\s+/)[0] : '';
    const text = dm ? rest.trim().slice(target.length) : rest;
    if (!text.trim()) return null;
    return from(text, true, dm ? target !== name : true, name);
  }

  // 1. public chat. Two carriers with different trust: <name> is real player
  // chat; [name] is the /say echo shape, which the server ALSO emits for its
  // own actors — `say` from the console logs as "[Rcon]" / "[Server]", and
  // tonight's scare countdown produced 13 such lines. Parse [name] (some chat
  // mods use it) but never accept the server's own pseudo-names as players.
  const m = /\]:\s+(?:\[Not Secure\]\s+)?(?:<([A-Za-z0-9_]{1,16})>|\[([A-Za-z0-9_]{1,16})\])\s+(.*)$/.exec(line);
  if (!m) return null;
  if (m[2] !== undefined && /^(rcon|server)$/i.test(m[2])) return null;
  return from(m[3], false, true, m[1] ?? m[2]);
}

async function tick(log: (msg: string) => void): Promise<void> {
  const cfg = loadGenie();
  if (!cfg.enabled) return;
  const servers = await craftyApi.listServers();
  for (const srv of servers) {
    const id = srv.server_id;
    if (!cfg.servers[id]) continue; // per-server opt-in from the panel
    let stats;
    try {
      stats = await craftyApi.getStats(id);
    } catch { continue; }
    if (!stats.running) { offsets.delete(id); sweptBars.delete(id); whisperState.delete(id); whisperHinted.delete(id); continue; }
    if ((await serverPhase(id, true)) !== 'ready') continue;
    if (!sweptBars.has(id)) {
      sweptBars.add(id); // once per server boot
      sweepOrphanBars(id, log).catch(() => sweptBars.delete(id));
      listInstalled(id)
        .then((items) => {
          const capable = items.some((m) => m.enabled && /whisper/i.test(m.title ?? m.file));
          whisperState.set(id, capable ? 'capable' : 'incapable');
          if (!capable) log(`chatgenie: whisper carrier unavailable on ${srv.server_name} (no WhisperMod) — "shh" public prefix is the quiet channel`);
        })
        .catch(() => {});
    }

    for (const line of readNewLines(id)) {
      // join/leave tracking for the welcome-back digest (any player, not just
      // allowlisted — the digest mentions who visited)
      const jl = /\]:\s+([A-Za-z0-9_]{3,16}) (joined|left) the game$/.exec(line);
      if (jl) {
        try { handleJoinLeave(id, jl[1], jl[2] as 'joined' | 'left'); } catch { /* digest is best-effort */ }
        continue;
      }
      const hit = parseWish(line);
      if (!hit || !cfg.players.includes(hit.player)) continue;
      // one-time heads-up on servers where whispers silently vanish — a player
      // whispering the genie there gets NOTHING back and thinks it's broken
      if (whisperState.get(id) === 'incapable' && !whisperHinted.has(id)) {
        whisperHinted.add(id);
        rconCommand(
          id,
          `tellraw ${hit.player} [{"text":"✦ ","color":"aqua"},{"text":"heads-up: /msg whispers never reach me on this server (its version doesn't log them). For quiet wishes, start a chat message with ","color":"gray"},{"text":"shh ","color":"light_purple","bold":true},{"text":"— I'll reply privately.","color":"gray"}]`,
        ).catch(() => {});
      }
      // "server undo" is a panel reflex, not a wish — restores in ~a second
      // without spending a model call, and works even mid-build
      const undoM = /^undo(?:\s+(?:that|last|it)|\s+(.{3,60}))?\s*[.!]?$/i.exec(hit.wish);
      if (undoM) {
        undoLast(id, undoM[1])
          .then((msg) =>
            rconBatch(id, [
              genieLine(id, hit.player, hit.secret, hit.wish, msg, msg.startsWith('undone') ? 'green' : 'yellow'),
              genieSound(hit.player, msg.startsWith('undone') ? 'done' : 'fail'),
            ]),
          )
          .catch((e) => log(`chatgenie: undo failed: ${String(e)}`));
        continue;
      }
      enqueue(id, hit.player, hit.wish, hit.secret, log);
    }
  }
}

/** Inject a wish EXACTLY as if it arrived in chat — same queue, same loop,
    same gates. For the panel's localhost-only test endpoint: it is how the
    genie gets verified end-to-end without a player at the keyboard. */
export function injectWish(id: string, player: string, wish: string, secret: boolean, log: (m: string) => void): void {
  log(`chatgenie: TEST WISH injected for ${player} on ${id}: "${wish}"`);
  enqueue(id, player, wish, secret, log);
}

/** Start a wish now if a slot is free, otherwise hold it in a short queue. */
function enqueue(id: string, player: string, wish: string, secret: boolean, log: (m: string) => void): void {
  const job: Job = { player, wish, secret };
  if ((running.get(id) ?? 0) < MAX_PARALLEL) return runNext(id, job, log);

  const q = queues.get(id) ?? [];
  if (q.length >= MAX_QUEUE) {
    rconCommand(id, genieLine(id, player, secret, wish, 'too many wishes at once — wait a moment', 'red')).catch(() => {});
    return;
  }
  q.push(job);
  queues.set(id, q);
  rconCommand(id, genieLine(id, player, secret, wish, `queued (#${q.length} in line)`, 'gray')).catch(() => {});
}

function runNext(id: string, job: Job, log: (m: string) => void): void {
  running.set(id, (running.get(id) ?? 0) + 1);
  handleWish(id, job.player, job.wish, job.secret, log)
    .catch((e) => log(`chatgenie: ${String(e)}`))
    .finally(() => {
      running.set(id, Math.max(0, (running.get(id) ?? 1) - 1));
      const q = queues.get(id) ?? [];
      while ((running.get(id) ?? 0) < MAX_PARALLEL && q.length > 0) {
        runNext(id, q.shift()!, log);
      }
      queues.set(id, q);
    });
}

/** True while any wish is executing or queued anywhere — deploy tooling asks
    this instead of guessing from process lists (a wish between model rounds
    has no child process, and a panel restart mid-wish kills it silently). */
export function genieBusy(): { busy: boolean; running: number; queued: number } {
  let r = 0;
  let q = 0;
  for (const n of running.values()) r += n;
  for (const list of queues.values()) q += list.length;
  return { busy: r + q > 0, running: r, queued: q };
}

export function startChatGenie(log: (msg: string) => void): void {
  ensureWarm(); // pre-boot the first warm fast-tier child — wishes walk into a running brain
  const warmTimer = setInterval(ensureWarm, 60_000); // keepalive drip + recycle + reheat
  warmTimer.unref();
  const timer = setInterval(() => {
    tick(log).catch((e) => {
      // an unconfigured box (no Crafty token yet) is a normal state, not a failure
      if (!String(e).includes('No Crafty API token')) log(`chatgenie: tick failed: ${String(e)}`);
    });
  }, POLL_MS);
  timer.unref();
}
