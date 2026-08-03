// Tracks servers with saved-but-not-applied changes ("restart required").
// In-memory is fine: flags reset when the panel restarts, and a stale flag is
// harmless (worst case the UI suggests a restart that isn't needed).
const flags = new Set<string>();

export const restartFlags = {
  set: (uuid: string) => flags.add(uuid),
  clear: (uuid: string) => flags.delete(uuid),
  has: (uuid: string) => flags.has(uuid),
};
