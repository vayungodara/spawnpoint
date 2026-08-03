import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { PATHS } from '../config.js';

export type Loader = 'forge' | 'neoforge' | 'fabric' | 'paper' | 'purpur' | 'vanilla' | 'unknown';

export interface Detection {
  loader: Loader;
  mc: string | null; // null => needs manual override (e.g. NeoForge)
}

// Per-server manual overrides (NeoForge can't be auto-detected) live in
// data/settings-overrides.json: { "<uuid>": { "loader": "...", "mc": "..." } }
const overridesFile = join(PATHS.data, 'detection-overrides.json');

function loadOverrides(): Record<string, Partial<Detection>> {
  try {
    return JSON.parse(readFileSync(overridesFile, 'utf8'));
  } catch {
    return {};
  }
}

export function setOverride(uuid: string, d: Partial<Detection>): void {
  const all = loadOverrides();
  all[uuid] = { ...all[uuid], ...d };
  writeFileSync(overridesFile, JSON.stringify(all, null, 2), 'utf8');
}

/** Detect loader + MC version for a Crafty server folder. Ported from Add-PerfMods.ps1. */
export function detect(serverDir: string, uuid?: string): Detection {
  const override = uuid ? loadOverrides()[uuid] : undefined;

  let loader: Loader = 'unknown';
  let mc: string | null = null;

  const forgeLib = join(serverDir, 'libraries', 'net', 'minecraftforge', 'forge');
  const neoLib = join(serverDir, 'libraries', 'net', 'neoforged', 'neoforge');

  if (existsSync(forgeLib)) {
    loader = 'forge';
    const dirs = readdirSync(forgeLib, { withFileTypes: true }).filter((d) => d.isDirectory());
    if (dirs.length > 0) mc = dirs[0].name.split('-')[0];
  } else if (existsSync(neoLib)) {
    loader = 'neoforge'; // NeoForge version !== MC version; override required
  } else {
    // Fabric: launcher jar carries install.properties with game-version
    const fabricJar = readdirSync(serverDir)
      .filter((f) => f.toLowerCase().includes('fabric') && f.endsWith('.jar'))
      .map((f) => join(serverDir, f))[0];
    if (fabricJar) {
      loader = 'fabric';
      try {
        const zip = new AdmZip(fabricJar);
        const entry = zip.getEntry('install.properties');
        if (entry) {
          const m = /game-version=([^\r\n]+)/.exec(entry.getData().toString('utf8'));
          if (m) mc = m[1].trim();
        }
      } catch {
        /* corrupt jar — leave mc null */
      }
    } else if (existsSync(join(serverDir, '.fabric'))) {
      loader = 'fabric';
    } else {
      const jars = readdirSync(serverDir).filter((f) => f.endsWith('.jar'));
      if (jars.some((j) => /paper/i.test(j))) loader = 'paper';
      else if (jars.some((j) => /purpur/i.test(j))) loader = 'purpur';
      else if (jars.some((j) => /vanilla|server/i.test(j))) loader = 'vanilla';

      // …and their MC VERSION, which we never read: every Bukkit-family server
      // reported mc = null, so the panel showed "?" everywhere, Content could not
      // version-match a plugin, and javaFor() had no version to pick a JDK from.
      // Paper/Purpur write it themselves on first boot:
      //   version_history.json -> {"currentVersion":"1.21.11-132-c5eb079 (MC: 1.21.11)"}
      try {
        const vh = join(serverDir, 'version_history.json');
        if (existsSync(vh)) {
          const cur = JSON.parse(readFileSync(vh, 'utf8')) as { currentVersion?: string };
          // "(MC: 1.21.11)" is authoritative; the leading "1.21.11-132-…" is the build
          const m = /\(MC:\s*([0-9][^)]*)\)/.exec(cur.currentVersion ?? '') ??
            /^([0-9]+(?:\.[0-9]+)+)/.exec(cur.currentVersion ?? '');
          if (m) mc = m[1].trim();
        }
      } catch {
        /* unreadable — leave mc null rather than guess */
      }
    }
  }

  return {
    loader: (override?.loader as Loader) ?? loader,
    mc: override?.mc ?? mc,
  };
}
