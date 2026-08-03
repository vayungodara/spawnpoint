import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { IS_WIN } from './platform.js';

const run = promisify(execFile);

// Loud/Quiet mode, ported from the desktop bat files:
//   loud  = CPU 100% + turbo boost on  -> max performance, louder fans
//   quiet = CPU 90%  + turbo boost off -> cooler and near-silent, ~5-15%
//           slower peaks
// Windows: powercfg (needs the elevated token the boot task provides).
// Linux: cpufreq governors + the boost knob via sysfs (needs root, which the
// systemd unit runs as). loud = `performance` governor + boost on;
// quiet = `powersave` governor + boost off.

const SUB = 'sub_processor';

export interface PerfMode {
  mode: 'loud' | 'quiet' | 'unknown';
  throttleMax: number | null;
}

// ---- Linux sysfs helpers ----
const CPUFREQ = '/sys/devices/system/cpu';

function linuxPolicies(): string[] {
  const dir = `${CPUFREQ}/cpufreq`;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => d.startsWith('policy'))
    .map((d) => `${dir}/${d}`);
}

/** boost knobs vary by driver: acpi-cpufreq has one global file, amd-pstate
    has one per policy — write whichever exists. */
function linuxBoostFiles(): string[] {
  const files = [`${CPUFREQ}/cpufreq/boost`, ...linuxPolicies().map((p) => `${p}/boost`)];
  return files.filter((f) => existsSync(f));
}

async function getLinuxMode(): Promise<PerfMode> {
  const policies = linuxPolicies();
  if (policies.length === 0) return { mode: 'unknown', throttleMax: null };
  const gov = readFileSync(`${policies[0]}/scaling_governor`, 'utf8').trim();
  return { mode: gov === 'performance' ? 'loud' : 'quiet', throttleMax: null };
}

async function setLinuxMode(loud: boolean): Promise<PerfMode> {
  const gov = loud ? 'performance' : 'powersave';
  for (const p of linuxPolicies()) {
    try { writeFileSync(`${p}/scaling_governor`, gov); } catch { /* per-policy failures are non-fatal */ }
  }
  for (const f of linuxBoostFiles()) {
    try { writeFileSync(f, loud ? '1' : '0'); } catch { /* boost knob is optional */ }
  }
  return getLinuxMode();
}

// ---- public API ----

export async function getPerfMode(): Promise<PerfMode> {
  if (!IS_WIN) return getLinuxMode().catch(() => ({ mode: 'unknown' as const, throttleMax: null }));
  try {
    const { stdout } = await run('powercfg', ['/q', 'scheme_current', SUB, 'PROCTHROTTLEMAX']);
    const m = /AC Power Setting Index:\s*0x([0-9a-f]+)/i.exec(stdout);
    const v = m ? parseInt(m[1], 16) : null;
    return { mode: v === null ? 'unknown' : v >= 100 ? 'loud' : 'quiet', throttleMax: v };
  } catch {
    return { mode: 'unknown', throttleMax: null };
  }
}

export async function setPerfMode(loud: boolean): Promise<PerfMode> {
  if (!IS_WIN) return setLinuxMode(loud).catch(() => getPerfMode());
  const throttle = loud ? '100' : '90';
  const boost = loud ? '2' : '0';
  for (const dir of ['/setacvalueindex', '/setdcvalueindex']) {
    await run('powercfg', [dir, 'scheme_current', SUB, 'PROCTHROTTLEMAX', throttle]);
    await run('powercfg', [dir, 'scheme_current', SUB, 'PERFBOOSTMODE', boost]);
  }
  await run('powercfg', ['/setactive', 'scheme_current']);
  return getPerfMode();
}
