import { craftyApi } from '../clients/crafty.js';
import { rconCommand } from '../clients/rcon.js';

// Joinability detection. Crafty says "running" as soon as java exists, but a
// modded server takes 30s+ before players can join. Clocks proved unreliable
// (Crafty's `started` is not in the log's timezone) and log order alone can't
// tell a fresh boot from the previous session's leftover "Done" in the
// buffer. The truth signal: Minecraft starts its RCON listener immediately
// AFTER "Done (…)!", so a successful RCON round-trip == joinable.

export type Phase = 'stopped' | 'starting' | 'ready';

// once a boot is confirmed ready, remember until the server stops — avoids
// an RCON round-trip on every stats poll
const readyCache = new Set<string>();

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    t.unref();
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// fallback for servers without RCON: ready if a "Done (…)!" follows the last
// boot-start marker in the log buffer. Flaw (why it's only the fallback): in
// the first seconds of a boot, before java logs anything, the buffer still
// ends with the previous session's Done.
const BOOT_RE = /\]: (Starting minecraft server version|Loading Minecraft .* with Fabric|ModLauncher running)/i;
const DONE_RE = /\]: Done \(/;

async function logHeuristic(id: string): Promise<boolean> {
  try {
    const lines = await craftyApi.getLogs(id);
    let lastBoot = -1;
    let lastDone = -1;
    for (let i = 0; i < lines.length; i++) {
      if (BOOT_RE.test(lines[i])) lastBoot = i;
      else if (DONE_RE.test(lines[i])) lastDone = i;
    }
    if (lastBoot >= 0) return lastDone > lastBoot;
    return true; // no boot marker in the buffer: long-running server
  } catch {
    return true; // logs unavailable — don't block the UI on it
  }
}

export async function serverPhase(id: string, running: boolean): Promise<Phase> {
  if (!running) {
    readyCache.delete(id);
    return 'stopped';
  }
  if (readyCache.has(id)) return 'ready';
  let ready: boolean;
  try {
    await withTimeout(rconCommand(id, 'list'), 2000);
    ready = true;
  } catch (e) {
    ready = /not enabled/i.test(String(e))
      ? await logHeuristic(id) // no RCON on this server
      : false; // RCON refused/timed out — the listener isn't up yet, still booting
  }
  if (ready) readyCache.add(id);
  return ready ? 'ready' : 'starting';
}


/** Pre-fill the ready cache for servers that are ALREADY running when the
    panel starts. Without this, every panel deploy blanked the cache and every
    running server's card flashed "STARTING…" until its first probe — the
    owner read it as "starting one server starts all three" (2026-07-20). */
export async function warmPhaseCache(list: () => Promise<{ server_id: string }[]>, running: (id: string) => Promise<boolean>): Promise<void> {
  try {
    for (const s of await list()) {
      try {
        if (await running(s.server_id)) await serverPhase(s.server_id, true);
      } catch { /* per-server best-effort */ }
    }
  } catch { /* crafty not up yet — stats requests will fill the cache lazily */ }
}