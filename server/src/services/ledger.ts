import { readFileSync } from 'node:fs';
import { PATHS } from '../config.js';
import { writeFileAtomic } from './platform.js';

// The install ledger remembers where each panel-installed jar came from, so
// updates, dedup and the Installed list can identify it without re-hashing.

export interface LedgerEntry {
  file: string;
  projectId: string;
  versionId: string;
  versionNumber: string;
  title: string;
  source: 'modrinth' | 'curseforge';
  sha1: string;
  installedAt: string;
  via?: 'direct' | 'dependency';
  categories?: string[];
  /** lives on the client shelf (data/clientmods/<id>/), never in mods/ */
  clientOnly?: boolean;
}
type Ledger = Record<string, LedgerEntry[]>;

function load(): Ledger {
  try {
    return JSON.parse(readFileSync(PATHS.ledgerFile, 'utf8')) as Ledger;
  } catch {
    return {};
  }
}

export function ledgerEntries(serverId: string): LedgerEntry[] {
  return load()[serverId] ?? [];
}

/** Read-modify-write one server's entries. `fn` must stay synchronous: an
    await between the read and the write would let two installs overwrite
    each other's entries. */
export function updateLedger(serverId: string, fn: (entries: LedgerEntry[]) => LedgerEntry[]): void {
  const ledger = load();
  ledger[serverId] = fn(ledger[serverId] ?? []);
  writeFileAtomic(PATHS.ledgerFile, JSON.stringify(ledger, null, 2));
}
