import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { serverDir } from './servers.js';

// Offline-mode UUID: version-3 UUID from MD5("OfflinePlayer:<name>").
// Vanilla `whitelist add` stores the ONLINE uuid, which rejects players on
// offline servers — so we write whitelist.json/ops.json directly.
// (Port of Get-OfflineUuid in MCServer.psm1.)
export function offlineUuid(name: string): string {
  const hash = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface WhitelistEntry { uuid: string; name: string }
interface OpsEntry extends WhitelistEntry { level: number; bypassesPlayerLimit: boolean }

function readJson<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  try {
    // strip a UTF-8 BOM (PowerShell's utf8 writes one; JSON.parse rejects it)
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeJson(file: string, items: unknown[]): void {
  writeFileSync(file, JSON.stringify(items, null, 2), 'utf8');
}

export interface PlayerView { name: string; uuid: string; whitelisted: boolean; op: boolean }

export function listPlayers(uuid: string): PlayerView[] {
  const dir = serverDir(uuid);
  const wl = readJson<WhitelistEntry>(join(dir, 'whitelist.json'));
  const ops = readJson<OpsEntry>(join(dir, 'ops.json'));
  const names = new Map<string, PlayerView>();
  for (const e of wl) names.set(e.name, { name: e.name, uuid: e.uuid, whitelisted: true, op: false });
  for (const e of ops) {
    const v = names.get(e.name) ?? { name: e.name, uuid: e.uuid, whitelisted: false, op: false };
    v.op = true;
    names.set(e.name, v);
  }
  return [...names.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function upsertPlayer(serverUuid: string, name: string, opts: { whitelist: boolean; op: boolean }): PlayerView {
  const dir = serverDir(serverUuid);
  const id = offlineUuid(name);
  const wlFile = join(dir, 'whitelist.json');
  const opsFile = join(dir, 'ops.json');

  const wl = readJson<WhitelistEntry>(wlFile).filter((e) => e.name !== name);
  if (opts.whitelist) wl.push({ uuid: id, name });
  writeJson(wlFile, wl);

  const ops = readJson<OpsEntry>(opsFile).filter((e) => e.name !== name);
  if (opts.op) ops.push({ uuid: id, name, level: 4, bypassesPlayerLimit: false });
  writeJson(opsFile, ops);

  return { name, uuid: id, whitelisted: opts.whitelist, op: opts.op };
}

export function removePlayer(serverUuid: string, name: string): void {
  upsertPlayer(serverUuid, name, { whitelist: false, op: false });
}

export function deopAll(serverUuid: string): void {
  writeJson(join(serverDir(serverUuid), 'ops.json'), []);
}
