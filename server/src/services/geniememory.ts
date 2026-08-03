import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../config.js';
import { eraOf, type Era } from './mcversion.js';

// The genie's long-term memory. Two kinds, because they do different jobs:
//
//   NOTES — facts it learned the hard way ("water touching a lava SOURCE makes
//   obsidian, not cobblestone"). Injected into every prompt, so a lesson is
//   learned once and never re-learned.
//
//   BLUEPRINTS — builds that were verified to actually WORK, stored as commands
//   relative to a base point. A remembered build replays in seconds with no
//   thinking and no research: the whole reason a second iron farm should not
//   cost what the first one did.

const NOTES_FILE = join(PATHS.data, 'genie-notes.json');
const BP_DIR = join(PATHS.data, 'blueprints');
const MAX_NOTES = 40;

/** A remembered lesson, TAGGED WITH THE ERA IT WAS LEARNED ON.
 *
 *  Notes are handed to the genie as "lessons you wrote yourself — they are true,
 *  trust them", so an untagged pool is a cross-version footgun: the note
 *  "This server runs Minecraft 26.2: worn gear lives in the entity's 'equipment'
 *  field, NOT in Inventory slots 100-103" was being injected into the 1.20.1
 *  Forge server's prompt, where it is exactly backwards — and it outranks the
 *  system prompt's own version rules because the genie is told to trust it. */
/** 'universal' = true in every era (fluid physics, verify-before-claim, RCON
    probe semantics) — always injected. Era-specific syntax stays era-tagged. */
interface Note { text: string; era: Era | 'universal' }

function loadRaw(): Note[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(NOTES_FILE, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  // migrate the original flat string[]: every existing note was learned on the
  // 26.2 Fabric servers (the only ones the genie has ever run a wish on)
  return parsed.map((n) =>
    typeof n === 'string' ? { text: n, era: 'component' as Era } : (n as Note),
  ).filter((n) => n && typeof n.text === 'string');
}

/** Notes that are TRUE on this server. Pass the server's MC version; a note
 *  learned in the other era is withheld rather than presented as fact. */
export function loadNotes(mc?: string | null): string[] {
  const era = eraOf(mc);
  return loadRaw().filter((n) => n.era === era || n.era === 'universal').map((n) => n.text);
}

export function addNote(note: string, mc?: string | null): void {
  const clean = note.trim().slice(0, 300);
  if (clean.length < 8) return;
  const notes = loadRaw();
  const era = eraOf(mc);
  // don't hoard near-duplicates of the same lesson (within the same era)
  const key = clean.toLowerCase().replace(/[^a-z0-9 ]/g, '');
  if (notes.some((n) => n.era === era && n.text.toLowerCase().replace(/[^a-z0-9 ]/g, '') === key)) return;
  notes.push({ text: clean, era });
  mkdirSync(PATHS.data, { recursive: true });
  writeFileSync(NOTES_FILE, JSON.stringify(notes.slice(-MAX_NOTES), null, 2), 'utf8');
}

export interface Blueprint {
  name: string;
  description: string;
  /** commands using ~ offsets, run from a base point via `execute positioned` */
  commands: string[];
  verified: boolean;
  savedAt: string;
  /** era the commands were written for — same cross-version footgun as notes:
      a kit blueprint saved on 26.2 uses component syntax that 1.20.1 rejects
      wholesale. Untagged legacy blueprints default to 'component' (all were
      saved on the 26.2 servers). 'universal' = plain-item commands with no
      NBT/components (the hand-authored tier kits) — valid in every era. */
  era?: Era | 'universal';
}

const safeName = (n: string) => n.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 40);

/** Blueprints usable on this server's era only (pass the MC version). */
export function listBlueprints(mc?: string | null): Blueprint[] {
  if (!existsSync(BP_DIR)) return [];
  const era = eraOf(mc);
  return readdirSync(BP_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(BP_DIR, f), 'utf8')) as Blueprint;
      } catch {
        return null;
      }
    })
    .filter((b): b is Blueprint => !!b)
    .filter((b) => (b.era ?? 'component') === era || b.era === 'universal');
}

export function getBlueprint(name: string): Blueprint | null {
  const file = join(BP_DIR, `${safeName(name)}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Blueprint;
  } catch {
    return null;
  }
}

export function saveBlueprint(bp: Omit<Blueprint, 'savedAt' | 'era'>, mc?: string | null): Blueprint {
  const full: Blueprint = { ...bp, name: safeName(bp.name), savedAt: new Date().toISOString(), era: eraOf(mc) };
  mkdirSync(BP_DIR, { recursive: true });
  writeFileSync(join(BP_DIR, `${full.name}.json`), JSON.stringify(full, null, 2), 'utf8');
  return full;
}

/** Re-anchor a blueprint at a new base. The stored commands use ~ offsets, so
    `execute positioned` does the translation for us — no coordinate rewriting,
    no parsing of the commands themselves. */
export function renderBlueprint(bp: Blueprint, x: number, y: number, z: number): string[] {
  return bp.commands.map((c) => `execute positioned ${x} ${y} ${z} run ${c.replace(/^\//, '')}`);
}

// ---- EPISODES — every completed wish becomes a retrievable memory ----------
// (2026-07-20 research: Voyager/JARVIS-1's core lesson — agents compound when
// "the last time someone wished something LIKE this" is retrieved before
// planning, failures included. Token-overlap retrieval; at a few hundred
// episodes an embedding index buys nothing.)

const EPISODES_FILE = join(PATHS.data, 'genie-episodes.json');
const MAX_EPISODES = 400;

export interface Episode {
  wish: string;
  player: string;
  mc: string | null;
  verdict: string;
  commands: string[];
  at: string;
}

function loadEpisodes(): Episode[] {
  try {
    return JSON.parse(readFileSync(EPISODES_FILE, 'utf8')) as Episode[];
  } catch {
    return [];
  }
}

export function addEpisode(e: Episode): void {
  const eps = loadEpisodes();
  eps.push({ ...e, wish: e.wish.slice(0, 300), verdict: e.verdict.slice(0, 400), commands: e.commands.slice(0, 30).map((c) => c.slice(0, 200)) });
  mkdirSync(PATHS.data, { recursive: true });
  writeFileSync(EPISODES_FILE, JSON.stringify(eps.slice(-MAX_EPISODES), null, 1), 'utf8');
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'you', 'can', 'please', 'server', 'make', 'give', 'get', 'put', 'him', 'her', 'them', 'his', 'their', 'have', 'need', 'want', 'some', 'just', 'like', 'from', 'into', 'onto']);
function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 2 && !STOP.has(t)));
}

/** Top-k past episodes similar to this wish, same era only (a 26.2 command
    replayed on 1.20.1 is the recurring cross-version bug class). Failures are
    returned too — knowing what did NOT work is half the value. */
export function similarEpisodes(wish: string, mc?: string | null, k = 3): string[] {
  const era = eraOf(mc);
  const want = tokens(wish);
  if (want.size === 0) return [];
  const scored = loadEpisodes()
    .filter((e) => eraOf(e.mc) === era)
    .map((e) => {
      const have = tokens(e.wish);
      let score = 0;
      for (const t of want) if (have.has(t)) score++;
      return { e, score };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score || b.e.at.localeCompare(a.e.at))
    .slice(0, k);
  return scored.map(({ e }) =>
    `[${e.at.slice(0, 10)}] ${e.player}: "${e.wish}" → ${e.verdict}${e.commands.length ? `\n  commands used: ${e.commands.slice(0, 8).join(' ; ')}` : ''}`,
  );
}

// ---- REMEDIES — one-line failure diagnoses, era-tagged ---------------------
// Written by the genie's DIAGNOSE directive the moment a command fails; shown
// on future wishes in the same era so the same mistake is never derived twice.

const REMEDIES_FILE = join(PATHS.data, 'genie-remedies.json');
const MAX_REMEDIES = 80;

export function addRemedy(text: string, mc?: string | null): void {
  const clean = text.trim().slice(0, 250);
  if (clean.length < 12) return;
  let list: { text: string; era: string; at: string }[] = [];
  try { list = JSON.parse(readFileSync(REMEDIES_FILE, 'utf8')); } catch { /* first */ }
  const era = eraOf(mc);
  const key = clean.toLowerCase().replace(/[^a-z0-9 ]/g, '');
  if (list.some((r) => r.era === era && r.text.toLowerCase().replace(/[^a-z0-9 ]/g, '') === key)) return;
  list.push({ text: clean, era, at: new Date().toISOString() });
  mkdirSync(PATHS.data, { recursive: true });
  writeFileSync(REMEDIES_FILE, JSON.stringify(list.slice(-MAX_REMEDIES), null, 1), 'utf8');
}

export function loadRemedies(mc?: string | null, k = 15): string[] {
  const era = eraOf(mc);
  try {
    const list = JSON.parse(readFileSync(REMEDIES_FILE, 'utf8')) as { text: string; era: string }[];
    return list.filter((r) => r.era === era || r.era === 'universal').slice(-k).map((r) => r.text);
  } catch {
    return [];
  }
}
