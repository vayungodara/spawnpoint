import { request } from 'undici';
import { loadSettings } from '../config.js';
import { getProjects } from './modrinth.js';
import type { ContentType, Side } from './modrinth.js';

// CurseForge API v1 client. Only used when a key is configured
// (data/settings.json -> curseforgeApiKey). Mirrors the modrinth client's
// search shape so the routes/UI can treat both sources uniformly.

const BASE = 'https://api.curseforge.com/v1';
const GAME_MC = 432;

const CLASS_IDS: Record<ContentType, number> = {
  mod: 6,
  plugin: 5,
  modpack: 4471,
  resourcepack: 12,
  shader: 6552,
  datapack: 6945,
};
/** CF files plugins under their own class — on a Paper/Spigot server the
    "Mods" tab must search THAT, or CF returns Fabric/Forge mods the server
    cannot load. (Modrinth needs no such special case: it tags plugins with
    paper/spigot loader categories, which the normal loader facet already
    matches.) */
const CF_PLUGIN_CLASS = 5;
const PLUGIN_LOADERS = new Set(['paper', 'spigot', 'bukkit', 'purpur', 'folia']);

// CF ModLoaderType enum
const LOADERS: Record<string, number> = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };

// CF sortField enum (2=Popularity, 3=LastUpdated, 6=TotalDownloads, 11=ReleasedDate)
const SORTS: Record<string, number> = { relevance: 2, downloads: 6, updated: 3, newest: 11 };

export class CurseforgeError extends Error {}

async function cf<T>(path: string, body?: unknown): Promise<T> {
  const key = loadSettings().curseforgeApiKey;
  if (!key) throw new CurseforgeError('No CurseForge API key configured (data/settings.json)');
  const res = await request(`${BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'x-api-key': key,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.body.text();
  if (res.statusCode >= 400) {
    throw new CurseforgeError(`CurseForge ${path} -> ${res.statusCode}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as T;
}

export interface CfMod {
  id: number;
  slug: string;
  name: string;
  summary: string;
  downloadCount: number;
  logo: { thumbnailUrl: string } | null;
  authors: { name: string }[];
  links: { websiteUrl: string };
  categories: { name: string }[];
  /** per-file version/loader tags — loader is OFTEN missing on older uploads */
  latestFilesIndexes?: { gameVersion: string; modLoader?: number | null }[];
}

export interface CfFile {
  id: number;
  modId: number;
  displayName: string;
  fileName: string;
  downloadUrl: string | null; // null = author opted out of API downloads
  fileDate: string;
  gameVersions: string[];
  hashes: { value: string; algo: number }[]; // algo 1 = sha1
  fileFingerprint: number; // murmur2 of whitespace-stripped bytes
  dependencies: { modId: number; relationType: number }[]; // 3 = required
}

// same hit shape the panel already renders for Modrinth
export interface CfSearchPage {
  hits: {
    project_id: string;
    slug: string;
    title: string;
    description: string;
    icon_url: string | null;
    downloads: number;
    categories: string[];
    author: string;
    url: string;
    source: 'curseforge';
    client_side?: Side;
    server_side?: Side;
  }[];
  offset: number;
  total_hits: number;
}

export async function search(opts: {
  query?: string;
  type: ContentType;
  mc?: string;
  loader?: string;
  sort?: string;
  offset?: number;
  limit?: number;
}): Promise<CfSearchPage> {
  const pluginServer = !!opts.loader && PLUGIN_LOADERS.has(opts.loader.toLowerCase());
  const p = new URLSearchParams({
    gameId: String(GAME_MC),
    classId: String(opts.type === 'mod' && pluginServer ? CF_PLUGIN_CLASS : CLASS_IDS[opts.type]),
    sortField: String(SORTS[opts.sort ?? 'downloads'] ?? 6),
    sortOrder: 'desc',
    index: String(opts.offset ?? 0),
    pageSize: String(opts.limit ?? 20),
  });
  if (opts.query) p.set('searchFilter', opts.query);
  if (opts.mc) p.set('gameVersion', opts.mc);
  // CF's search ANDs gameVersion+modLoaderType against a SINGLE file-index
  // entry, and older uploads often lack the loader tag — Dynamic Trees' real
  // 26.1.2 Fabric build vanished from mc+loader searches (live repro
  // 2026-07-19: each filter alone found it, both together didn't). So when mc
  // is set, ask CF for the version only and loader-filter HERE, leniently:
  // an index entry with no loader tag is "unknown", never "wrong".
  const loaderId = opts.loader && LOADERS[opts.loader] && (opts.type === 'mod' || opts.type === 'modpack')
    ? LOADERS[opts.loader]
    : null;
  const lenientLoader = !!(loaderId && opts.mc);
  if (loaderId && !lenientLoader) p.set('modLoaderType', String(loaderId));
  const res = await cf<{ data: CfMod[]; pagination: { index: number; totalCount: number } }>(
    `/mods/search?${p}`,
  );
  if (lenientLoader) {
    res.data = res.data.filter((m) => {
      const idx = (m.latestFilesIndexes ?? []).filter((f) => f.gameVersion === opts.mc);
      if (idx.length === 0) return true; // no index data — let it through, the install step decides
      return idx.some((f) => f.modLoader === loaderId || f.modLoader === null || f.modLoader === undefined);
    });
  }
  const hits: CfSearchPage['hits'] = res.data.map((m) => ({
    project_id: String(m.id),
    slug: m.slug,
    title: m.name,
    description: m.summary,
    icon_url: m.logo?.thumbnailUrl ?? null,
    downloads: m.downloadCount,
    categories: m.categories.map((c) => c.name),
    author: m.authors[0]?.name ?? '',
    url: m.links.websiteUrl,
    source: 'curseforge',
  }));
  // CF's API has no client/server-side field. Most CF projects of any size are
  // also published on Modrinth under the SAME slug, so borrow the sides from
  // there (one bulk call; Modrinth silently drops unknown slugs — verified).
  // A CF-exclusive mod just stays untagged, which was every hit's fate before.
  try {
    const cross = await getProjects(hits.map((h) => h.slug));
    const bySlug = new Map(cross.map((pr) => [pr.slug, pr]));
    for (const h of hits) {
      const pr = bySlug.get(h.slug);
      if (pr) { h.client_side = pr.client_side; h.server_side = pr.server_side; }
    }
  } catch { /* enrichment is best-effort — CF search must not fail over Modrinth */ }
  return {
    hits,
    offset: res.pagination.index,
    total_hits: Math.min(res.pagination.totalCount, 10_000),
  };
}

export async function getMod(id: number | string): Promise<CfMod> {
  return (await cf<{ data: CfMod }>(`/mods/${id}`)).data;
}

/** Version+loader matched files, newest first (CF returns them sorted). */
export async function getFiles(
  id: number | string,
  opts: { mc?: string; loader?: string } = {},
): Promise<CfFile[]> {
  const p = new URLSearchParams({ pageSize: '50' });
  if (opts.mc) p.set('gameVersion', opts.mc);
  if (opts.loader && LOADERS[opts.loader]) p.set('modLoaderType', String(LOADERS[opts.loader]));
  return (await cf<{ data: CfFile[] }>(`/mods/${id}/files?${p}`)).data;
}

/** Bulk file lookup (modpack manifests reference hundreds of fileIDs). */
export async function getFilesBulk(fileIds: number[]): Promise<CfFile[]> {
  const out: CfFile[] = [];
  for (let i = 0; i < fileIds.length; i += 50) {
    const chunk = fileIds.slice(i, i + 50);
    const res = await cf<{ data: CfFile[] }>('/mods/files', { fileIds: chunk });
    out.push(...res.data);
  }
  return out;
}

export async function getModsBulk(modIds: number[]): Promise<CfMod[]> {
  if (modIds.length === 0) return [];
  return (await cf<{ data: CfMod[] }>('/mods', { modIds })).data;
}

const stripHtml = (html: string): string =>
  html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** File changelog as plain text (the API returns HTML). */
export async function getChangelog(modId: number | string, fileId: number | string): Promise<string> {
  return stripHtml((await cf<{ data: string }>(`/mods/${modId}/files/${fileId}/changelog`)).data);
}

/** Project long description as plain text (the API returns HTML). */
export async function getDescription(modId: number | string): Promise<string> {
  return stripHtml((await cf<{ data: string }>(`/mods/${modId}/description`)).data);
}

/** Identify jars by CF fingerprint (murmur2 of whitespace-stripped bytes). */
export async function fingerprintMatch(
  fingerprints: number[],
): Promise<{ id: number; file: CfFile }[]> {
  if (fingerprints.length === 0) return [];
  const res = await cf<{ data: { exactMatches: { id: number; file: CfFile }[] } }>(
    '/fingerprints/432',
    { fingerprints },
  );
  return res.data.exactMatches;
}

/** Map CF category names onto the tokens our classifier understands. */
export function mapCategories(cats: { name: string }[]): string[] {
  const names = cats.map((c) => c.name.toLowerCase());
  const out: string[] = [];
  if (names.some((n) => n.includes('performance'))) out.push('optimization');
  if (names.some((n) => n.includes('library') || n.includes('api'))) out.push('library');
  return out;
}
