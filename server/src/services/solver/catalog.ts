import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PATHS } from '../../config.js';
import * as modrinth from '../../clients/modrinth.js';
import * as curseforge from '../../clients/curseforge.js';
import type { Version, VersionFile } from '../../clients/modrinth.js';
import { hashes } from '../revisions.js';
import { writeFileAtomic } from '../platform.js';
import { readFabricJar } from './fabric.js';
import { readForgeJar } from './forge.js';
import { modIds, type Catalog, type NativeMeta, type SolveInput } from './index.js';

/** A bounded catalog session. Domains are complete or fail, while discovered
 * provider mappings are explicitly partial: a search hit is never proof that
 * no other project exists. Immutable artifacts are shared across sessions. */
export class NetworkCatalog implements Catalog {
  private domains = new Map<string, Promise<Version[]>>();
  private metas = new Map<string, NativeMeta>();
  private index = new Map<string, Set<string>>();
  private downloaded = 0;
  private bytes = 0;
  readonly manualDownloads: { title: string; url: string }[] = [];

  constructor(
    private filter: { mc: string; loader: SolveInput['loader']; loaderVersion?: string },
    private local: Map<string, { version: Version; path: string; clientOnly?: boolean }> = new Map(),
    private limits = { downloads: 64, bytes: 256 * 1024 * 1024 },
  ) {}

  async version(id: string): Promise<Version> {
    const local = this.local.get(id);
    if (local) return local.version;
    if (id.startsWith('cf:')) {
      const [file] = await curseforge.getFilesBulk([Number(id.slice(3))]);
      if (!file || `cf:${file.id}` !== id) throw new Error('CurseForge did not resolve the exact file ID');
      return this.cfVersion(file);
    }
    return modrinth.getVersion(id);
  }

  versions(project: string): Promise<Version[]> {
    if (!this.domains.has(project)) this.domains.set(project, this.domain(project));
    return this.domains.get(project)!;
  }

  private async domain(project: string): Promise<Version[]> {
    if (project.startsWith('local:')) return [...this.local.values()].map((f) => f.version).filter((v) => v.project_id === project);
    if (project.startsWith('cf:')) {
      return (await curseforge.getFiles(project.slice(3), { ...this.filter, all: true })).map((file) => this.cfVersion(file));
    }
    return modrinth.getVersions(project, this.filter);
  }

  private cfVersion(file: curseforge.CfFile): Version {
    const sha1 = file.hashes.find((hash) => hash.algo === 1)?.value ?? '';
    return {
      id: `cf:${file.id}`, project_id: `cf:${file.modId}`, name: file.displayName, version_number: file.displayName,
      game_versions: file.gameVersions, loaders: [this.filter.loader],
      version_type: file.releaseType === 1 ? 'release' : file.releaseType === 2 ? 'beta' : 'alpha',
      date_published: file.fileDate, downloads: 0,
      files: [{ filename: file.fileName, url: file.downloadUrl ?? '', primary: true, size: file.fileLength,
        hashes: { sha1, sha512: '' } }],
      dependencies: file.dependencies.filter((d) => [3, 5].includes(d.relationType)).map((d) => ({
        project_id: `cf:${d.modId}`, version_id: null, dependency_type: d.relationType === 3 ? 'required' : 'incompatible',
      })),
    };
  }

  private async matches(path: string, file: VersionFile): Promise<boolean> {
    const actual = await hashes(path);
    return /^[a-f\d]{40}$/i.test(file.hashes.sha1) && actual.sha1 === file.hashes.sha1.toLowerCase()
      && (!file.hashes.sha512 || actual.sha512 === file.hashes.sha512.toLowerCase())
      && (!file.size || actual.size === file.size);
  }

  async artifact(version: Version): Promise<string> {
    const local = this.local.get(version.id);
    if (local) {
      const file = local.version.files[0];
      if (!version.files.some((f) => f.hashes.sha1 === file.hashes.sha1) || !await this.matches(local.path, file)) {
        throw new Error(`Installed bytes do not match the source record for ${version.name}`);
      }
      return local.path;
    }
    const file = version.files.find((f) => f.primary) ?? version.files[0];
    if (!file || !/^[a-f\d]{40}$/i.test(file.hashes.sha1)) throw new Error(`No verifiable artifact for ${version.name}`);
    const key = file.hashes.sha512 || file.hashes.sha1;
    if (!/^[a-f\d]{40}$|^[a-f\d]{128}$/i.test(key)) throw new Error('Invalid artifact checksum');
    const path = join(PATHS.data, 'solver', 'artifacts', `${key.toLowerCase()}.jar`);
    if (existsSync(path)) {
      if (await this.matches(path, file)) return path;
      rmSync(path);
    }
    if (!file.url) {
      const url = `https://www.curseforge.com/minecraft/mc-mods/${version.project_id.slice(3)}`;
      this.manualDownloads.push({ title: version.name, url });
      throw new Error(`${version.name} requires an authorized manual download; the exact file was not substituted`);
    }
    if (++this.downloaded > this.limits.downloads) throw new Error('Solver artifact download limit reached');
    const response = await fetch(file.url, { signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'spawnpoint/1.0' } });
    if (!response.ok || !response.body) throw new Error(`Solver artifact download failed (${response.status})`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      this.bytes += chunk.byteLength;
      if (size > 64 * 1024 * 1024 || this.bytes > this.limits.bytes) throw new Error('Solver artifact byte limit reached');
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    if (createHash('sha1').update(bytes).digest('hex') !== file.hashes.sha1.toLowerCase()
      || (file.hashes.sha512 && createHash('sha512').update(bytes).digest('hex') !== file.hashes.sha512.toLowerCase())
      || (file.size && bytes.length !== file.size)) throw new Error(`Artifact checksum or size mismatch for ${version.name}`);
    writeFileAtomic(path, bytes);
    return path;
  }

  async jarMeta(version: Version): Promise<NativeMeta> {
    if (!this.metas.has(version.id)) {
      const path = await this.artifact(version);
      const file = version.files.find((file) => file.primary) ?? version.files[0];
      // Local filenames survive the solver witness. Forge discovery (including
      // service bootstraps and automatic module names) must see that same name.
      const filename = this.local.has(version.id) ? basename(path) : file.filename;
      if (this.filter.loader !== 'fabric' && !this.filter.loaderVersion) throw new Error('FML metadata needs the installed loader version');
      const meta = this.filter.loader === 'fabric' ? readFabricJar(readFileSync(path))
        : readForgeJar(readFileSync(path), filename, { mc: this.filter.mc, forge: this.filter.loaderVersion!, loader: this.filter.loader });
      const shelved = [...this.local.values()].some((f) => f.version.project_id === version.project_id && f.clientOnly);
      const project = version.project_id.startsWith('cf:') || version.project_id.startsWith('local:')
        ? undefined : await modrinth.getProject(version.project_id);
      if (shelved || project?.server_side === 'unsupported') {
        if (meta.environment === 'server') throw new Error(`Conflicting server/client declarations for ${version.name}`);
        meta.environment = 'client';
      }
      const index = (node: NativeMeta): void => {
        for (const id of modIds(node)) {
          if (!this.index.has(id)) this.index.set(id, new Set());
          this.index.get(id)!.add(version.project_id);
        }
        if ('loader' in node) node.nested.forEach((entry) => index(entry.jar));
        else node.nested.forEach(index);
      };
      index(meta);
      this.metas.set(version.id, meta);
    }
    return this.metas.get(version.id)!;
  }

  async providers(id: string): Promise<{ projects: string[]; complete: boolean }> {
    if (!this.index.has(id)) {
      const candidates = new Set<string>();
      // Fabric API ships its modules ("fabric-lifecycle-events-v1") nested, with no projects of their own
      for (const slug of id === 'fabric' || /^fabric(-[a-z0-9]+)+-v\d+$/.test(id) ? ['fabric-api'] : [id, id.replace(/_/g, '-')]) {
        try { candidates.add((await modrinth.getProject(slug)).id); }
        catch (error) { if (!(error instanceof Error) || !error.message.endsWith('-> 404')) throw error; }
      }
      const page = await modrinth.search({ query: id, type: 'mod', ...this.filter, limit: 4 });
      page.hits.forEach((hit) => candidates.add(hit.project_id));
      for (const project of candidates) {
        for (const version of await this.versions(project)) {
          await this.jarMeta(version);
          if (this.index.has(id)) break;
        }
        if (this.index.has(id)) break;
      }
    }
    return { projects: [...this.index.get(id) ?? []], complete: false };
  }
}
