import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve, sep, extname } from 'node:path';
import { serverDir } from './servers.js';

// Mod config file browser/editor. Every server mod keeps its developer
// options in text files under config/ (Fabric/Forge) or serverconfig/
// (Forge per-world) — there is no other UI for these anywhere.

const ROOTS = ['config', 'serverconfig', join('world', 'serverconfig')];
const TEXT_EXT = new Set([
  '.json', '.json5', '.jsonc', '.toml', '.yaml', '.yml', '.properties',
  '.cfg', '.conf', '.txt', '.snbt', '.ini', '.hocon',
]);
const MAX_FILES = 800;
const MAX_SIZE = 512 * 1024; // editor cap

export interface ConfigFileInfo {
  path: string; // relative to server dir, forward slashes
  sizeKb: number;
  modifiedAt: string;
}

/** Resolve a client-supplied relative path, confined to the config roots. */
function confine(uuid: string, rel: string): string {
  const base = resolve(serverDir(uuid));
  const p = resolve(base, rel);
  const ok = ROOTS.some((r) => {
    const root = resolve(base, r);
    return p === root || p.startsWith(root + sep);
  });
  if (!ok) throw new Error('path outside config directories');
  return p;
}

export function listConfigs(uuid: string): ConfigFileInfo[] {
  const base = serverDir(uuid);
  const out: ConfigFileInfo[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 4 || out.length >= MAX_FILES) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (out.length >= MAX_FILES) return;
      const full = join(dir, n);
      const r = `${rel}/${n}`;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, r, depth + 1);
      } else if (TEXT_EXT.has(extname(n).toLowerCase()) && !n.endsWith('.bak')) {
        out.push({
          path: r,
          sizeKb: Math.max(1, Math.round(st.size / 1024)),
          modifiedAt: st.mtime.toISOString(),
        });
      }
    }
  };
  for (const root of ROOTS) {
    const dir = join(base, root);
    if (existsSync(dir)) walk(dir, root.replaceAll(sep, '/'), 0);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function readConfig(uuid: string, rel: string): { path: string; content: string; tooBig: boolean } {
  const p = confine(uuid, rel);
  const st = statSync(p);
  if (st.size > MAX_SIZE) return { path: rel, content: '', tooBig: true };
  // strip BOM so editors don't save it back doubled
  return { path: rel, content: readFileSync(p, 'utf8').replace(/^﻿/, ''), tooBig: false };
}

export function writeConfig(uuid: string, rel: string, content: string): { ok: true; backup: string } {
  const p = confine(uuid, rel);
  if (!existsSync(p)) throw new Error('file not found — configs can only be edited, not created');
  const bak = `${p}.bak`;
  copyFileSync(p, bak);
  writeFileSync(p, content, 'utf8'); // no BOM
  return { ok: true, backup: `${rel}.bak` };
}
