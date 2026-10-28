import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The layout root holds Crafty/servers, Shared, Tools, Backups and
// Spawnpoint/data. SPAWNPOINT_ROOT overrides the per-OS default.
export const ROOT =
  process.env.SPAWNPOINT_ROOT ??
  (process.platform === 'win32' ? 'C:\\MinecraftServers' : '/srv/minecraft');
export const PATHS = {
  root: ROOT,
  craftyServers: join(ROOT, 'Crafty', 'servers'),
  shared: join(ROOT, 'Shared'),
  activeServerFile: join(ROOT, 'Shared', 'active-server.txt'),
  craftyTokenFile: join(ROOT, 'Shared', 'crafty-token.txt'),
  data: join(ROOT, 'Spawnpoint', 'data'),
  settingsFile: join(ROOT, 'Spawnpoint', 'data', 'settings.json'),
  ledgerFile: join(ROOT, 'Spawnpoint', 'data', 'install-ledger.json'),
  downloads: join(ROOT, 'Spawnpoint', 'data', 'downloads'),
  // the built web app: ROOT/Spawnpoint/web/dist in the standard layout,
  // otherwise the checkout this file runs from (server/dist -> ../../web/dist)
  webDist: (() => {
    const canonical = join(ROOT, 'Spawnpoint', 'web', 'dist');
    if (existsSync(canonical)) return canonical;
    return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
  })(),
};

export interface Settings {
  port: number;
  /** legacy plaintext PIN, hashed into pinHash on first read */
  pin: string | null;
  /** scrypt$salt$hash (or a legacy sha256 hex, upgraded on next login) */
  pinHash: string | null;
  curseforgeApiKey: string | null;
  /** genie credential: an Anthropic API key (sk-ant-api…) or a Claude Code
      OAuth token from `claude setup-token` (sk-ant-oat…) */
  anthropicApiKey: string | null;
  craftyUrl: string;
  /** contact appended to the Modrinth User-Agent, as their API etiquette asks */
  modrinthContact: string | null;
}

const DEFAULTS: Settings = {
  port: 25570,
  pin: null,
  pinHash: null,
  curseforgeApiKey: null,
  anthropicApiKey: null,
  craftyUrl: 'https://localhost:8443',
  modrinthContact: null,
};

let settingsCache: Settings | null = null;

/** Settings from data/settings.json (cached; saveSettings refreshes it). */
export function loadSettings(): Settings {
  if (settingsCache) return { ...settingsCache };
  const s = { ...DEFAULTS };
  try {
    // a UTF-8 BOM (PowerShell-written JSON) would break JSON.parse
    const raw = JSON.parse(readFileSync(PATHS.settingsFile, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
    for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) if (k in raw) (s as Record<string, unknown>)[k] = raw[k];
  } catch { /* missing or unreadable: defaults */ }
  settingsCache = s;
  return { ...s };
}

export function saveSettings(s: Settings): void {
  mkdirSync(PATHS.data, { recursive: true });
  // holds API keys: owner-only (mode applies on create; chmod fixes older files)
  writeFileSync(PATHS.settingsFile, JSON.stringify(s, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(PATHS.settingsFile, 0o600); } catch { /* Windows */ }
  settingsCache = { ...s };
}

let tokenCache: string | null = null;

/** The Crafty API token the setup wizard stored, or null before setup. */
export function craftyToken(): string | null {
  if (tokenCache) return tokenCache;
  if (!existsSync(PATHS.craftyTokenFile)) return null;
  const t = readFileSync(PATHS.craftyTokenFile, 'utf8').trim();
  tokenCache = t || null;
  return tokenCache;
}
