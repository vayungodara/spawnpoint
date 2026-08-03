import { craftyApi } from '../clients/crafty.js';
import { rconBatch } from '../clients/rcon.js';
import { serverPhase } from './phase.js';

// PLAYER TRIGGERS — vanilla /trigger commands any player can use without OP.
// The server itself can't react to a trigger; the panel is the redstone: it
// periodically runs a batch that acts on set triggers, confirms, resets, and
// re-enables. Same mechanism as the /trigger hud opt-in, generalized.
//
//   /trigger setspawn  → personal spawnpoint set to where the player stands
//
// Cadence: 4s while the server had players last look, 30s when empty — every
// RCON connection logs two console lines, so an empty server isn't spammed.

const FAST_MS = 4_000;
const SLOW_EVERY = 8; // 8 * 4s = ~30s when empty
const emptyTicks = new Map<string, number>();

const BATCH = [
  // idempotent bootstrap — "already exists" is a no-op error
  'scoreboard objectives add setspawn trigger',
  // act on anyone who pulled the trigger since last pass
  'execute as @a[scores={setspawn=1..}] at @s run spawnpoint @s ~ ~ ~',
  `tellraw @a[scores={setspawn=1..}] ["",{"text":"✦ ","color":"aqua"},{"text":"spawn point set — you will respawn right here","color":"gray"}]`,
  'scoreboard players reset @a[scores={setspawn=1..}] setspawn',
  // a trigger must be re-enabled per player after every use (and for joiners)
  'scoreboard players enable @a setspawn',
  'list',
];

export function startPlayerTriggers(log: (msg: string) => void): void {
  const tick = async (): Promise<void> => {
    const servers = await craftyApi.listServers().catch(() => []);
    for (const srv of servers) {
      const id = srv.server_id;
      const skip = emptyTicks.get(id) ?? 0;
      if (skip > 0) {
        emptyTicks.set(id, skip - 1);
        continue;
      }
      let stats;
      try {
        stats = await craftyApi.getStats(id);
      } catch {
        continue;
      }
      if (!stats.running) continue;
      if ((await serverPhase(id, true)) !== 'ready') continue;
      try {
        const res = await rconBatch(id, BATCH);
        const listReply = res[res.length - 1] ?? '';
        const online = /There are (\d+)/.exec(listReply)?.[1];
        emptyTicks.set(id, online === '0' ? SLOW_EVERY : 0);
      } catch (e) {
        log(`triggers: ${srv.server_name}: ${String(e).slice(0, 100)}`);
        emptyTicks.set(id, SLOW_EVERY); // errored server — back off too
      }
    }
  };
  const timer = setInterval(() => {
    tick().catch(() => {});
  }, FAST_MS);
  timer.unref();
}
