import { existsSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { serverDir } from './servers.js';

// CurseForge modpack manifests don't tag client-only mods, so packs install
// them onto the server and the first boot dies in FML mod-loading. The crash
// report names every failed mod WITH its jar path — this reads the newest
// report and disables those jars (.jar.disabled, reversible in Installed).

export interface SweepResult {
  disabled: string[];
  alreadyDisabled: string[];
  report: string | null;
  reportAgeMin: number | null;
}

export function sweepCrashedClientMods(uuid: string): SweepResult {
  const dir = serverDir(uuid);
  const crashDir = join(dir, 'crash-reports');
  const none: SweepResult = { disabled: [], alreadyDisabled: [], report: null, reportAgeMin: null };
  if (!existsSync(crashDir)) return none;

  const newest = readdirSync(crashDir)
    .filter((f) => f.endsWith('.txt'))
    .map((f) => ({ f, t: statSync(join(crashDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0];
  if (!newest) return none;

  const text = readFileSync(join(crashDir, newest.f), 'utf8');
  const result: SweepResult = {
    disabled: [],
    alreadyDisabled: [],
    report: newest.f,
    reportAgeMin: Math.round((Date.now() - newest.t) / 60_000),
  };

  // blocks look like:
  //   Mod File: /C:/…/mods/connectedness-2.0.1a.jar
  //   Failure message: Connectedness (connectedness) has failed to load correctly
  const re = /Mod File:\s*\S*?[\\/]mods[\\/]([^\s\\/]+\.jar)\s*[\r\n]+\s*Failure message:[^\r\n]*has failed to load correctly/g;
  const modsDir = join(dir, 'mods');
  for (const m of text.matchAll(re)) {
    const jar = m[1];
    const path = join(modsDir, jar);
    if (existsSync(`${path}.disabled`)) {
      result.alreadyDisabled.push(jar);
      continue;
    }
    if (!existsSync(path)) continue;
    renameSync(path, `${path}.disabled`);
    result.disabled.push(jar);
  }
  return result;
}
