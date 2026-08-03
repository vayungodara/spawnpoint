// Modrinth API v2 client with a short-lived cache and polite User-Agent.
// Modrinth asks for a contact in the UA — settings-driven so the string is
// per-install, not the project author's.
import { loadSettings } from '../config.js';
const contact = loadSettings().modrinthContact;
const UA = `spawnpoint/1.0 (self-hosted MC panel${contact ? `; ${contact}` : ''})`;
const BASE = 'https://api.modrinth.com/v2';

export type ContentType = 'mod' | 'plugin' | 'resourcepack' | 'shader' | 'datapack' | 'modpack';

// Modrinth project_type facet values per our content types
const PROJECT_TYPE: Record<ContentType, string> = {
  mod: 'mod',
  plugin: 'plugin', // Bukkit/Spigot/Paper/Purpur/Folia plugins — a real facet
  resourcepack: 'resourcepack',
  shader: 'shader',
  datapack: 'datapack', // datapacks are mods with loader "datapack" on Modrinth
  modpack: 'modpack',
};

/** Loaders that load PLUGINS (jar in plugins/) rather than MODS (jar in mods/). */
export const PLUGIN_LOADERS = ['paper', 'spigot', 'bukkit', 'purpur', 'folia'];
export const isPluginLoader = (l?: string): boolean => !!l && PLUGIN_LOADERS.includes(l);

const cache = new Map<string, { at: number; data: unknown }>();
const TTL = 60_000;

async function mr<T>(path: string): Promise<T> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < TTL) return hit.data as T;
  const res = await fetch(`${BASE}${path}`, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`Modrinth ${path} -> ${res.status}`);
  const data = (await res.json()) as T;
  cache.set(path, { at: Date.now(), data });
  if (cache.size > 500) {
    for (const [k, v] of cache) if (Date.now() - v.at > TTL) cache.delete(k);
  }
  return data;
}

export interface SearchQuery {
  query?: string;
  type: ContentType;
  mc?: string;
  loader?: string;
  categories?: string[];
  sort?: 'relevance' | 'downloads' | 'follows' | 'newest' | 'updated';
  offset?: number;
  limit?: number;
}

/** Which side a jar has to be installed on. Modrinth reports this per project;
 *  it is the difference between "this works" and "nothing happens" — a
 *  client-only mod dropped in mods/ is dead weight the server never loads. */
export type Side = 'required' | 'optional' | 'unsupported' | 'unknown';

export interface ProjectSummary {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  icon_url: string | null;
  downloads: number;
  follows: number;
  categories: string[];
  versions: string[];
  author: string;
  client_side: Side;
  server_side: Side;
}

export interface SearchResult {
  hits: ProjectSummary[];
  offset: number;
  limit: number;
  total_hits: number;
}

export function search(q: SearchQuery): Promise<SearchResult> {
  const facets: string[][] = [[`project_type:${PROJECT_TYPE[q.type]}`]];
  if (q.mc) facets.push([`versions:${q.mc}`]);
  // loader facet applies to mods/plugins/modpacks (datapacks use loader "datapack")
  if ((q.type === 'mod' || q.type === 'plugin' || q.type === 'modpack') && q.loader)
    facets.push([`categories:${q.loader}`]);
  if (q.type === 'datapack') facets.push(['categories:datapack']);
  if (q.categories?.length) facets.push(q.categories.map((c) => `categories:${c}`));

  const params = new URLSearchParams({
    facets: JSON.stringify(facets),
    index: q.sort ?? 'relevance',
    offset: String(q.offset ?? 0),
    limit: String(Math.min(q.limit ?? 20, 50)),
  });
  if (q.query) params.set('query', q.query);
  return mr<SearchResult>(`/search?${params}`);
}

export interface ProjectDetail {
  id: string;
  slug: string;
  title: string;
  description: string;
  body: string;
  icon_url: string | null;
  downloads: number;
  followers: number;
  categories: string[];
  game_versions: string[];
  loaders: string[];
  gallery: { url: string; title: string | null }[];
  source_url: string | null;
  project_type: string;
  client_side: Side;
  server_side: Side;
}

export function getProject(idOrSlug: string): Promise<ProjectDetail> {
  return mr<ProjectDetail>(`/project/${encodeURIComponent(idOrSlug)}`);
}

/** Bulk project lookup (one call for N projects). */
export function getProjects(ids: string[]): Promise<ProjectDetail[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return mr<ProjectDetail[]>(`/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`);
}

export interface VersionFile {
  url: string;
  filename: string;
  primary: boolean;
  size: number;
  hashes: { sha1: string };
}
export interface Version {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  game_versions: string[];
  loaders: string[];
  version_type: 'release' | 'beta' | 'alpha';
  changelog?: string | null;
  date_published: string;
  downloads: number;
  files: VersionFile[];
  dependencies: { project_id: string | null; version_id: string | null; dependency_type: string }[];
}

export function getVersions(
  idOrSlug: string,
  filter: { mc?: string; loader?: string },
): Promise<Version[]> {
  const params = new URLSearchParams();
  if (filter.loader) params.set('loaders', JSON.stringify([filter.loader]));
  if (filter.mc) params.set('game_versions', JSON.stringify([filter.mc]));
  const qs = params.toString();
  return mr<Version[]>(`/project/${encodeURIComponent(idOrSlug)}/version${qs ? `?${qs}` : ''}`);
}

export function getVersion(versionId: string): Promise<Version> {
  return mr<Version>(`/version/${encodeURIComponent(versionId)}`);
}

/** Identify local jars by sha1 (for the installed-mods view). */
export async function identifyByHashes(sha1s: string[]): Promise<Record<string, Version>> {
  const res = await fetch(`${BASE}/version_files`, {
    method: 'POST',
    headers: { 'user-agent': UA, 'content-type': 'application/json' },
    body: JSON.stringify({ hashes: sha1s, algorithm: 'sha1' }),
  });
  if (!res.ok) return {};
  return (await res.json()) as Record<string, Version>;
}
