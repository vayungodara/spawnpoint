import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Canonical environment paths — the panel operates on the same files the
// PowerShell tooling uses, so both stay in sync.
// SPAWNPOINT_ROOT overrides for the Linux box (systemd sets it); the layout
// under the root (Crafty/servers, Shared, Spawnpoint, Tools, Backups) is
// identical on both platforms — the migration bootstrap recreates it.
export const ROOT =
  process.env.SPAWNPOINT_ROOT ??
  (process.platform === 'win32' ? 'C:\\MinecraftServers' : '/srv/minecraft');
export const PATHS = {
  root: ROOT,
  craftyServers: join(ROOT, 'Crafty', 'servers'),
  shared: join(ROOT, 'Shared'),
  activeServerFile: join(ROOT, 'Shared', 'active-server.txt'),
  craftyTokenFile: join(ROOT, 'Shared', 'crafty-token.txt'),
  perfManifest: join(ROOT, 'Shared', 'perf-mods.json'),
  data: join(ROOT, 'Spawnpoint', 'data'),
  settingsFile: join(ROOT, 'Spawnpoint', 'data', 'settings.json'),
  ledgerFile: join(ROOT, 'Spawnpoint', 'data', 'install-ledger.json'),
  downloads: join(ROOT, 'Spawnpoint', 'data', 'downloads'),
  // web UI: the canonical layout keeps the repo at ROOT/Spawnpoint, but a
  // stranger may clone anywhere — fall back to the checkout this very file
  // runs from (server/dist/config.js -> ../../web/dist), so the panel never
  // boots healthy-but-UI-less just because of a directory name
  webDist: (() => {
    const canonical = join(ROOT, 'Spawnpoint', 'web', 'dist');
    if (existsSync(canonical)) return canonical;
    return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
  })(),
};

export interface Settings {
  port: number;
  /** LEGACY plaintext PIN — auto-migrated to pinHash on first read, then null.
      Kept in the type so old settings.json files load cleanly. */
  pin: string | null;
  pinHash: string | null; // sha256(pin+salt); null = PIN gate disabled
  curseforgeApiKey: string | null;
  /** genie auth for installs without a system-wide Claude login — passed to
      the CLI as ANTHROPIC_API_KEY at spawn time, never logged */
  anthropicApiKey: string | null;
  vercelToken: string | null; // lets lanes.ts create <name>.<laneDomain> SRV records
  craftyUrl: string;
  /** PUBLIC LANE CONFIG — all four must be set for lanes to provision; a
      fresh install leaves them null and servers stay LAN/Tailscale-only
      (lanes.ts warns honestly instead of guessing an address). */
  laneDomain: string | null; //     e.g. example.com
  laneSrvTarget: string | null; //  e.g. mc.example.com (A record → relay)
  laneRelayIp: string | null; //    the relay droplet's public IP (SSH target)
  laneBoxIp: string | null; //      this box's Tailscale IP (relay forward target)
  /** contact appended to the Modrinth User-Agent (their API etiquette asks
      for one); null = UA without contact */
  modrinthContact: string | null;
}

// Port 25570 sits inside the firewall's existing "Minecraft Server" allow
// range (25565-25570), so the panel is reachable over Tailscale without
// needing an elevated firewall change.
const DEFAULTS: Settings = {
  port: 25570,
  pin: null,
  pinHash: null,
  curseforgeApiKey: null,
  anthropicApiKey: null,
  vercelToken: null,
  craftyUrl: 'https://localhost:8443',
  laneDomain: null,
  laneSrvTarget: null,
  laneRelayIp: null,
  laneBoxIp: null,
  modrinthContact: null,
};

export function loadSettings(): Settings {
  if (!existsSync(PATHS.settingsFile)) return { ...DEFAULTS };
  try {
    // strip UTF-8 BOM — PowerShell-written JSON starts with
    return { ...DEFAULTS, ...JSON.parse(readFileSync(PATHS.settingsFile, 'utf8').replace(/^﻿/, '')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  mkdirSync(PATHS.data, { recursive: true });
  // this file holds API keys and tokens — owner-only, like the session secret
  // and the Crafty token file
  writeFileSync(PATHS.settingsFile, JSON.stringify(s, null, 2), { encoding: 'utf8', mode: 0o600 });
}

export function craftyToken(): string | null {
  if (!existsSync(PATHS.craftyTokenFile)) return null;
  const t = readFileSync(PATHS.craftyTokenFile, 'utf8').trim();
  return t.length > 0 ? t : null;
}
