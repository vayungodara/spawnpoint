import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PATHS } from '../config.js';
import { craftyApi } from '../clients/crafty.js';
import { rconCommand } from '../clients/rcon.js';
import { serverPhase } from './phase.js';
import { setPerfMode } from './perfmode.js';
import { isRunningSafe, isUnderMaintenance } from './maintenance.js';

// Task scheduler: "restart daily at 04:00", "announce every 2h", "run this
// command every morning". One 30s tick drives everything; each task fires at
// most once per due-window (lastRun guards double-fires across ticks and
// panel restarts).

const FILE = join(PATHS.data, 'scheduler.json');

export type TaskKind = 'restart' | 'command' | 'announce' | 'start' | 'stop' | 'loud' | 'quiet';

export interface Schedule {
  type: 'daily' | 'interval';
  time?: string; // daily: "HH:MM" (server-local)
  minutes?: number; // interval: every N minutes
}

export interface SchedTask {
  id: string;
  enabled: boolean;
  serverId: string; // which server it applies to ('' for host-level kinds)
  kind: TaskKind;
  arg?: string; // command text / announce text
  schedule: Schedule;
  lastRun?: string;
}

export function loadTasks(): SchedTask[] {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveTasks(tasks: SchedTask[]): void {
  mkdirSync(PATHS.data, { recursive: true });
  writeFileSync(FILE, JSON.stringify(tasks, null, 2), 'utf8');
}

export function upsertTask(t: Partial<SchedTask> & { id?: string }): SchedTask[] {
  const tasks = loadTasks();
  if (t.id) {
    const i = tasks.findIndex((x) => x.id === t.id);
    if (i >= 0) tasks[i] = { ...tasks[i], ...t } as SchedTask;
  } else {
    tasks.push({
      id: randomBytes(5).toString('hex'),
      enabled: true,
      serverId: String(t.serverId ?? ''),
      kind: (t.kind ?? 'announce') as TaskKind,
      arg: t.arg,
      schedule: t.schedule ?? { type: 'daily', time: '04:00' },
      // born "already ran": a daily task added at 5pm must wait for TOMORROW's
      // 04:00, not fire the moment it is saved
      lastRun: new Date().toISOString(),
    });
  }
  saveTasks(tasks);
  return tasks;
}

export function deleteTask(id: string): SchedTask[] {
  const tasks = loadTasks().filter((t) => t.id !== id);
  saveTasks(tasks);
  return tasks;
}

function isDue(t: SchedTask, now: Date): boolean {
  const last = t.lastRun ? new Date(t.lastRun) : null;
  if (t.schedule.type === 'interval') {
    const mins = Math.max(5, Number(t.schedule.minutes) || 60);
    return !last || now.getTime() - last.getTime() >= mins * 60_000;
  }
  // daily at HH:MM — due once per calendar day, any tick at/after the time
  const [hh, mm] = String(t.schedule.time ?? '04:00').split(':').map(Number);
  const due = new Date(now);
  due.setHours(hh || 0, mm || 0, 0, 0);
  if (now < due) return false;
  return !last || last < due;
}

async function isReady(serverId: string): Promise<boolean> {
  try {
    const stats = await craftyApi.getStats(serverId);
    if (!stats.running) return false;
    return (await serverPhase(serverId, true)) === 'ready';
  } catch {
    return false;
  }
}

async function run(t: SchedTask, log: (m: string) => void): Promise<void> {
  // a server mid-surgery (preset patch, world switch/reset, restore) has its
  // files moving: starting or stopping it now corrupts the operation
  if (t.serverId && isUnderMaintenance(t.serverId)) {
    log(`scheduler: skip ${t.kind} of ${t.serverId} — maintenance in progress`);
    return;
  }
  switch (t.kind) {
    case 'announce': {
      if (!(await isReady(t.serverId))) return; // nobody to hear it
      await rconCommand(
        t.serverId,
        `tellraw @a [{"text":"⏰ ","color":"gold"},{"text":${JSON.stringify(t.arg ?? '')},"color":"yellow"}]`,
      );
      return;
    }
    case 'command': {
      if (!(await isReady(t.serverId))) return;
      await rconCommand(t.serverId, String(t.arg ?? '').replace(/^\//, ''));
      return;
    }
    case 'restart': {
      // only a running server gets restarted — a stopped one stays stopped.
      // players get a one-minute warning; an empty server restarts silently.
      if (!(await isReady(t.serverId))) return;
      let players = 0;
      try {
        const m = /There are (\d+)/.exec(await rconCommand(t.serverId, 'list'));
        players = m ? Number(m[1]) : 0;
      } catch { /* treat unknown as occupied */ players = 1; }
      if (players > 0) {
        await rconCommand(t.serverId, `tellraw @a [{"text":"⏰ ","color":"gold"},{"text":"scheduled restart in 60 seconds","color":"red","bold":true}]`).catch(() => {});
        await new Promise((r) => setTimeout(r, 50_000));
        await rconCommand(t.serverId, `tellraw @a [{"text":"⏰ restarting in 10 seconds — you can rejoin right after","color":"red"}]`).catch(() => {});
        await new Promise((r) => setTimeout(r, 10_000));
      }
      await craftyApi.action(t.serverId, 'restart_server');
      return;
    }
    case 'start':
      await craftyApi.action(t.serverId, 'start_server');
      return;
    case 'stop': {
      // NEVER stop a server we cannot PROVE is empty. The old code only ran
      // the player check when the server was RCON-ready and otherwise FELL
      // THROUGH to the stop — so a transient RCON hiccup on a populated server
      // meant "stop it". Now an unverifiable server is left alone, full stop.
      if (!(await isReady(t.serverId))) {
        if (await isRunningSafe(t.serverId)) {
          log(`scheduler: skip stop of ${t.serverId} — running but not RCON-verifiable`);
          return;
        }
        return; // already stopped: nothing to do
      }
      try {
        const m = /There are (\d+)/.exec(await rconCommand(t.serverId, 'list'));
        if (!m || Number(m[1]) > 0) {
          log(`scheduler: skip stop of ${t.serverId} — players online or unverifiable`);
          return;
        }
      } catch {
        return;
      }
      await craftyApi.action(t.serverId, 'stop_server');
      return;
    }
    case 'loud':
      await setPerfMode(true);
      return;
    case 'quiet':
      await setPerfMode(false);
      return;
  }
}

let ticking = false;

async function tick(log: (m: string) => void): Promise<void> {
  if (ticking) return; // a restart task sleeps 60s — don't stack ticks
  ticking = true;
  try {
    const now = new Date();
    for (const t of loadTasks()) {
      if (!t.enabled || !isDue(t, now)) continue;
      // stamp BEFORE running so a slow task can't double-fire
      upsertTask({ id: t.id, lastRun: now.toISOString() });
      log(`scheduler: running ${t.kind}${t.arg ? ` (${t.arg.slice(0, 40)})` : ''}`);
      await run(t, log).catch((e) => log(`scheduler: ${t.kind} failed: ${String(e).slice(0, 120)}`));
    }
  } finally {
    ticking = false;
  }
}

export function startScheduler(log: (msg: string) => void): void {
  const timer = setInterval(() => {
    tick(log).catch((e) => log(`scheduler: tick failed: ${String(e)}`));
  }, 30_000);
  timer.unref();
}
