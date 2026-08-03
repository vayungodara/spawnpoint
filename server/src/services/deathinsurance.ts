import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../config.js';
import { craftyApi } from '../clients/crafty.js';
import { rconCommand } from '../clients/rcon.js';
import { detect } from './detect.js';
import { serverDir } from './servers.js';
import { isComponentEra } from './mcversion.js';
import { loadGenie } from './chatgenie.js';

// DEATH INSURANCE — rolling inventory snapshots so "server restore my stuff"
// after a death returns EXACTLY what the player carried, not a kit
// approximation. Motivation: 6 manual kit-restores in one Horror session.
//
// Design: the panel only ever READS inventories (data get works on every
// version); the RESTORE side is the genie's job — it receives the raw SNBT
// via the SNAPSHOTS directive and composes era-correct give/item-replace
// commands itself, which keeps the cross-version knowledge in ONE place (the
// model + its era-tagged prompt) instead of duplicating give-syntax here.
//
// Era note: on 1.20.1 worn armor lives in Inventory slots 100-103 so one read
// covers everything; on 26.2 worn gear moved to the entity's `equipment`
// field, so we read that too and store both.

const SNAP_DIR = join(PATHS.data, 'deathsnaps');
const KEEP = 6; // ~18 min of history at one snapshot per 3 min
const INTERVAL_MS = 3 * 60_000;

export interface InvSnapshot {
  at: string;
  /** raw `data get entity <p> Inventory` reply (SNBT list) */
  inv: string;
  /** raw `data get entity <p> equipment` reply — component era only */
  equip?: string;
  /** rough item-stack count parsed from the SNBT, for at-a-glance display */
  stacks: number;
}
type SnapFile = Record<string, InvSnapshot[]>; // player -> newest last

const snapFile = (id: string) => join(SNAP_DIR, `${id}.json`);

function loadSnaps(id: string): SnapFile {
  try {
    return JSON.parse(readFileSync(snapFile(id), 'utf8')) as SnapFile;
  } catch {
    return {};
  }
}

function saveSnaps(id: string, s: SnapFile): void {
  mkdirSync(SNAP_DIR, { recursive: true });
  writeFileSync(snapFile(id), JSON.stringify(s, null, 2), 'utf8');
}

/** Strip the "<name> has the following entity data: " prefix — the payload
    is the SNBT after the colon. A "no entity"/error reply returns null. */
function payload(reply: string): string | null {
  const i = reply.indexOf('entity data: ');
  if (i === -1) return null;
  return reply.slice(i + 'entity data: '.length).trim();
}

function countStacks(snbt: string): number {
  // every item stack carries an id: tag — cheap and version-proof
  return (snbt.match(/\bid:\s*"/g) ?? []).length;
}

async function snapshotServer(id: string, mc: string | null | undefined): Promise<void> {
  const list = await rconCommand(id, 'list');
  const names = (list.split(':')[1] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((n) => /^[A-Za-z0-9_]{3,16}$/.test(n));
  if (!names.length) return;
  const snaps = loadSnaps(id);
  for (const name of names) {
    const invReply = await rconCommand(id, `data get entity ${name} Inventory`).catch(() => '');
    const inv = payload(invReply);
    if (inv === null) continue; // offline mid-poll or data unreadable — skip, never store junk
    const snap: InvSnapshot = { at: new Date().toISOString(), inv, stacks: countStacks(inv) };
    if (isComponentEra(mc)) {
      const eqReply = await rconCommand(id, `data get entity ${name} equipment`).catch(() => '');
      const eq = payload(eqReply);
      if (eq !== null) {
        snap.equip = eq;
        snap.stacks += countStacks(eq);
      }
    }
    snaps[name] = [...(snaps[name] ?? []), snap].slice(-KEEP);
  }
  saveSnaps(id, snaps);
}

/** Snapshot history for one player, newest LAST — the genie's SNAPSHOTS
    directive reads this. */
export function playerSnapshots(id: string, player: string): InvSnapshot[] {
  return loadSnaps(id)[player] ?? [];
}

export function startDeathInsurance(log: (msg: string) => void): void {
  const tick = async (): Promise<void> => {
    const cfg = loadGenie();
    if (!cfg.enabled) return; // insurance rides the genie switch — no genie, no restores
    const servers = await craftyApi.listServers().catch(() => []);
    for (const srv of servers) {
      const id = srv.server_id;
      if (!cfg.servers[id]) continue;
      let stats;
      try {
        stats = await craftyApi.getStats(id);
      } catch {
        continue;
      }
      if (!stats.running) continue;
      const mc = detect(serverDir(id), id).mc;
      await snapshotServer(id, mc).catch((e) => log(`deathinsurance: ${srv.server_name}: ${String(e).slice(0, 100)}`));
    }
  };
  const timer = setInterval(() => {
    tick().catch((e) => log(`deathinsurance: tick failed: ${String(e).slice(0, 120)}`));
  }, INTERVAL_MS);
  timer.unref();
  // first pass shortly after boot so a fresh panel restart doesn't leave a
  // multi-minute uninsured window mid-session
  const first = setTimeout(() => {
    tick().catch(() => {});
  }, 20_000);
  first.unref();
}
