import { craftyApi as legacy, type CraftyServer, type CraftyStats } from './crafty-adapter.js';
import { loadSettings } from '../config.js';
import { nativeRecord, nativeRecords, supervisor, transferRecord, transferRecords } from '../services/native.js';

// Preserve the existing callers' data contract while ownership moves one
// server at a time. A native outage NEVER falls back to the old owner.
export { CraftyError } from './crafty-adapter.js';
export type { CraftyServer, CraftyStats } from './crafty-adapter.js';
const nativeStats = new Map<string, { at: number; value: Promise<CraftyStats> }>();
export const craftyApi = {
  listingError: undefined as string | undefined,
  async listServers(): Promise<CraftyServer[]> {
    const native = nativeRecords();
    const local = [...native, ...transferRecords().filter((t) => !native.some((n) => n.server_id === t.id)).map((t) => t.source)];
    let old: CraftyServer[] = [];
    craftyApi.listingError = undefined;
    if (loadSettings().runtime !== 'standalone') {
      try { old = await legacy.listServers(); }
      catch (error) {
        if (!local.length) throw error;
        craftyApi.listingError = 'Crafty is unavailable. Showing only imported and transferring servers; other Crafty servers may still be running.';
      }
    }
    return [...old.filter((s) => !local.some((n) => n.server_id === s.server_id)), ...local];
  },
  reportedPath: (id: string): string | undefined => nativeRecord(id)?.path ?? transferRecord(id)?.path ?? legacy.reportedPath(id),
  getServer: (id: string): Promise<CraftyServer> => nativeRecord(id) || transferRecord(id)
    ? Promise.resolve(nativeRecord(id) ?? transferRecord(id)!.source) : legacy.getServer(id),
  getStats(id: string): Promise<CraftyStats> {
    if (!nativeRecord(id)) return legacy.getStats(id);
    const hit = nativeStats.get(id);
    if (hit && Date.now() - hit.at < 2_000) return hit.value;
    const value = supervisor<CraftyStats>('stats', { id }).then(async (stats) => {
      if (!stats.running) return stats;
      // Unknown is not empty: quiet tests and automatic restarts must wait.
      stats.online = -1;
      try {
        const { rconCommand } = await import('./rcon.js');
        const answer = await rconCommand(id, 'list', { timeout: 2_000 });
        const count = /There are (\d+) of a max of (\d+) players online:?\s*(.*)/i.exec(answer);
        if (count) { stats.online = Number(count[1]); stats.max = Number(count[2]); stats.players = count[3]; }
      } catch { /* starting or unavailable: retain unknown */ }
      return stats;
    });
    nativeStats.set(id, { at: Date.now(), value });
    value.catch(() => nativeStats.delete(id));
    return value;
  },
  getLogs: (id: string): Promise<string[]> => nativeRecord(id) ? supervisor('logs', { id }) : legacy.getLogs(id),
  createServer: legacy.createServer,
  jarCatalog: () => legacy.jarCatalog(),
  patchServer: async (id: string, fields: Record<string, unknown>) => {
    if (transferRecord(id)) throw new Error('ownership transfer requires completion or abort before edits');
    if (!nativeRecord(id)) return legacy.patchServer(id, fields);
    if ('execution_command' in fields || 'executable' in fields || 'path' in fields) {
      const { assertUnsealed } = await import('../services/revisions.js');
      assertUnsealed(id);
    }
    return supervisor('patch', { id, fields });
  },
  useRevisionCommand: async (id: string, revision: string) => {
    if (!nativeRecord(id)) return legacy.useRevisionCommand(id, revision);
    const { assertRevisionMutation, verifyRevision } = await import('../services/revisions.js');
    assertRevisionMutation(id);
    const lock = await verifyRevision(id, revision);
    await supervisor('patch', { id, fields: { execution_command: lock.command } });
  },
  action: async (id: string, action: 'start_server' | 'stop_server' | 'restart_server' | 'kill_server' | 'accept_eula') => {
    if (transferRecord(id) && action !== 'stop_server' && action !== 'kill_server') throw new Error('ownership transfer requires completion or abort before starting');
    if (!nativeRecord(id)) return legacy.action(id, action);
    const result = await supervisor('action', { id, action });
    nativeStats.delete(id);
    // The watcher registers the new boot attempt, not a restart request while
    // the old JVM is still stopping. Otherwise publication blocks that restart.
    return result;
  },
  sendStdin: (id: string, cmd: string) => nativeRecord(id) ? supervisor('stdin', { id, cmd, attempt: nativeRecord(id)!.attempt?.id }) : legacy.sendStdin(id, cmd),
  deleteServer: (id: string) => nativeRecord(id) ? supervisor('delete', { id }) : legacy.deleteServer(id),
};
