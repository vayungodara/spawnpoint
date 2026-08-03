import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { serverDir } from './servers.js';
import type { Box } from './undo.js';

// Ledger-powered build verification. The Ledger mod (Fabric) records every
// block change into world/ledger.sqlite — action, exact x/y/z, block id and a
// source, with console-driven fill/setblock attributed to source "command"
// (verified live 2026-07-17). That makes it an independent oracle for the
// genie: after a build wish, ask the DATABASE what actually changed instead of
// trusting the model's own spot probes.
//
// Two hard limits found by testing, do not "fix" them away:
//  - `place template` (the schematic PLACE path) writes NOTHING to Ledger —
//    schematics keep their sample-block verification, this module cannot help.
//  - `lg search` output goes to chat components the RCON socket never sees, so
//    the panel reads the sqlite file directly. The live DB is WAL-journaled and
//    locked by the server; we copy db+wal+shm and query the copy.

const MAX_DB_BYTES = 200_000_000; // a huge history is not worth the copy time

const dbPath = (id: string) => join(serverDir(id), 'world', 'ledger.sqlite');

export function ledgerAvailable(id: string): boolean {
  return existsSync(dbPath(id));
}

/** Copy the live DB (plus WAL sidecars) somewhere quiet and open that.
    Async copies — a multi-MB copyFileSync on the event loop froze the whole
    panel (every route, every poller) for the copy's duration, three wishes
    deep in parallel. */
async function openCopy(id: string): Promise<{ db: DatabaseSync; dir: string } | null> {
  const src = dbPath(id);
  if (!existsSync(src) || statSync(src).size > MAX_DB_BYTES) return null;
  const dir = join(tmpdir(), `spawnpoint-ledger-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  await copyFile(src, join(dir, 'ledger.sqlite'));
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(src + ext)) await copyFile(src + ext, join(dir, `ledger.sqlite${ext}`));
  }
  return { db: new DatabaseSync(join(dir, 'ledger.sqlite')), dir };
}

async function withCopy<T>(id: string, fn: (db: DatabaseSync) => T): Promise<T | null> {
  let handle: { db: DatabaseSync; dir: string } | null = null;
  try {
    handle = await openCopy(id);
    if (!handle) return null;
    return fn(handle.db);
  } catch {
    return null;
  } finally {
    try { handle?.db.close(); } catch { /* already closed */ }
    if (handle) rmSync(handle.dir, { recursive: true, force: true });
  }
}

/** Bookmark the log at wish start. Row ids are monotonic, so "what did THIS
    wish change" is simply id > mark — no clock parsing, no timezone traps
    (Ledger stamps rows in local time, which is exactly the kind of thing a
    time-based query would eventually get wrong). */
export async function ledgerMark(id: string): Promise<number | null> {
  return withCopy(id, (db) => {
    const row = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM actions').get() as { m: number };
    return row.m;
  });
}

export interface LedgerAudit {
  placed: number;
  broken: number;
  changed: number;
  total: number;
  /** top block ids seen, e.g. "minecraft:stone ×40" */
  blocks: string[];
}

/** What did console commands actually change inside `box` since `mark`?
    Returns null when Ledger is absent/unreadable — callers treat that as
    "no audit", never as a failure. */
export async function ledgerAudit(id: string, mark: number, box: Box): Promise<LedgerAudit | null> {
  return withCopy(id, (db) => {
    const where = `
      FROM actions a
      JOIN ActionIdentifiers ai ON ai.id = a.action_id
      JOIN sources s ON s.id = a.source
      WHERE a.id > ? AND s.name = 'command'
        AND ai.action_identifier IN ('block-place', 'block-break', 'block-change')
        AND a.x BETWEEN ? AND ? AND a.y BETWEEN ? AND ? AND a.z BETWEEN ? AND ?`;
    const params = [mark, box.x1, box.x2, box.y1, box.y2, box.z1, box.z2];
    const counts = db
      .prepare(`SELECT ai.action_identifier AS act, COUNT(*) AS n ${where} GROUP BY act`)
      .all(...params) as { act: string; n: number }[];
    const by = Object.fromEntries(counts.map((r) => [r.act, r.n]));
    const placed = by['block-place'] ?? 0;
    const broken = by['block-break'] ?? 0;
    const changed = by['block-change'] ?? 0;
    const blocks = (
      db
        .prepare(
          `SELECT oi.identifier AS b, COUNT(*) AS n ${where.replace('FROM actions a', 'FROM actions a JOIN ObjectIdentifiers oi ON oi.id = a.object_id')} GROUP BY b ORDER BY n DESC LIMIT 5`,
        )
        .all(...params) as { b: string; n: number }[]
    ).map((r) => `${r.b} ×${r.n}`);
    return { placed, broken, changed, total: placed + broken + changed, blocks };
  });
}

/** Union of two boxes (for accumulating a wish-wide build footprint). */
export function unionBox(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  return {
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
    z1: Math.min(a.z1, b.z1),
    x2: Math.max(a.x2, b.x2),
    y2: Math.max(a.y2, b.y2),
    z2: Math.max(a.z2, b.z2),
  };
}
