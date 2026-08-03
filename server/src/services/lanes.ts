import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS, loadSettings } from '../config.js';

// PUBLIC LANES — every server gets `<name>.<laneDomain>`, portless, automatically.
// A lane is three things, provisioned in one call:
//   1. a socat unit on the relay droplet forwarding :<port> over Tailscale
//      (+ ufw allow) — done over SSH with data/relay_key, same as by hand
//   2. a Vercel DNS SRV record `_minecraft._tcp.<slug>` → 0 5 <port> <laneSrvTarget>
//      (needs `vercelToken` in data/settings.json — Settings page, one paste;
//      without it the lane still works, friends just need the :port form)
//   3. the address entry in data/clientpack.json so client-pack exports and the
//      UI print the pretty name
// The default port needs no SRV (the bare srv-target A record already points
// there) but still gets its relay unit if missing. socat never inspects the MC
// handshake, so any hostname resolves fine.
//
// All four endpoints (domain, srv target, relay IP, box Tailscale IP) come
// from data/settings.json — a fresh install has none of them, and every lane
// call degrades to an honest "LAN/Tailscale-only" warning instead of guessing.

const DEFAULT_PORT = 25565;

interface LaneCfg { domain: string; srvTarget: string; relayIp: string; boxIp: string }

/** null = lanes not configured on this install. */
function laneCfg(): LaneCfg | null {
  const s = loadSettings();
  if (!s.laneDomain || !s.laneSrvTarget || !s.laneRelayIp || !s.laneBoxIp) return null;
  return { domain: s.laneDomain, srvTarget: s.laneSrvTarget, relayIp: s.laneRelayIp, boxIp: s.laneBoxIp };
}

const relayKey = () => join(PATHS.data, 'relay_key');

/** DNS label from a server name: "fun stuff" → "fun-stuff". Falls back to
    srv-<port> when nothing survives sanitizing (emoji names exist). */
export function laneSlug(name: string, port: number): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug || `srv-${port}`;
}

function sshDroplet(relayIp: string, script: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('ssh', [
      '-i', relayKey(),
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=10',
      `root@${relayIp}`,
      script,
    ]);
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ ok: code === 0, out: out.slice(0, 500) }));
    child.on('error', (e) => resolve({ ok: false, out: String(e) }));
  });
}

/** Idempotent AND self-healing: the unit file is (re)written every time, so a
    server recreated under the same name on a NEW port gets its lane repointed
    instead of silently keeping the dead old port (units are keyed by slug). */
async function ensureRelayUnit(cfg: LaneCfg, slug: string, port: number): Promise<string | null> {
  const unit = `mc-relay-${slug}`;
  const script = [
    `set -e`,
    `cat > /etc/systemd/system/${unit}.service <<'UNIT'`,
    `[Unit]`,
    `Description=Minecraft relay - ${slug} (${port})`,
    `After=network-online.target tailscaled.service`,
    `Wants=network-online.target`,
    ``,
    `[Service]`,
    `ExecStart=/usr/bin/socat -d TCP-LISTEN:${port},fork,reuseaddr,keepalive,nodelay TCP:${cfg.boxIp}:${port},keepalive,nodelay`,
    `Restart=always`,
    `RestartSec=3`,
    ``,
    `[Install]`,
    `WantedBy=multi-user.target`,
    `UNIT`,
    `systemctl daemon-reload`,
    `systemctl enable ${unit} >/dev/null 2>&1 || true`,
    `systemctl restart ${unit} || true`,
    `ufw allow ${port}/tcp >/dev/null`,
    `systemctl is-active ${unit}`,
  ].join('\n');
  const res = await sshDroplet(cfg.relayIp, script);
  if (!res.ok || !/active/.test(res.out)) {
    return `relay unit for :${port} failed on the droplet: ${res.out.slice(0, 160)}`;
  }
  return null;
}

/** The domain may live under a Vercel TEAM, in which case every API call
    needs ?teamId=… and unscoped calls 403 (verified live — personal-scope
    reads were forbidden while the team scope worked). Cached PER TOKEN, and a
    transient network failure is never cached — the old module-level cache
    locked a blip (or a since-replaced token) into "no access" until restart. */
const scopeByToken = new Map<string, string | null>();
async function vercelScope(domain: string, auth: Record<string, string>): Promise<string | null> {
  const token = auth.authorization;
  if (scopeByToken.has(token)) return scopeByToken.get(token)!;
  const readable = async (q: string) =>
    (await fetch(`https://api.vercel.com/v4/domains/${domain}/records?limit=1${q}`, { headers: auth })).ok;
  try {
    if (await readable('')) { scopeByToken.set(token, ''); return ''; }
    const teams = (await (await fetch('https://api.vercel.com/v2/teams', { headers: auth })).json()) as {
      teams?: { id: string }[];
    };
    for (const t of teams.teams ?? []) {
      const q = `&teamId=${t.id}`;
      if (await readable(q)) { scopeByToken.set(token, q); return q; }
    }
  } catch {
    return null; // transient failure — do NOT cache, next call re-probes
  }
  scopeByToken.set(token, null); // probed everything, genuinely no access
  return null;
}

/** Idempotent: create the SRV record on Vercel DNS. */
async function ensureSrvRecord(cfg: LaneCfg, slug: string, port: number): Promise<string | null> {
  const token = loadSettings().vercelToken;
  if (!token) {
    return `no Vercel token configured (Settings) — friends must use ${cfg.srvTarget}:${port} until one is added`;
  }
  const auth = { authorization: `Bearer ${token}` };
  const name = `_minecraft._tcp.${slug}`;
  try {
    const scope = await vercelScope(cfg.domain, auth);
    if (scope === null) return `the Vercel token cannot access ${cfg.domain} in any of its scopes — check the token's team`;
    const list = (await (
      await fetch(`https://api.vercel.com/v4/domains/${cfg.domain}/records?limit=100${scope}`, { headers: auth })
    ).json()) as { records?: { id: string; name: string; type: string; value?: string }[] };
    const existing = list.records?.find((r) => r.type === 'SRV' && r.name === name);
    if (existing) {
      // value looks like "5 25568 mc.example.com." — if the port still matches,
      // done; if the server was recreated on a NEW port, replace the record
      // (existence alone used to mask a stale port forever)
      if (new RegExp(`\\b${port}\\b`).test(existing.value ?? '')) return null;
      await fetch(`https://api.vercel.com/v2/domains/${cfg.domain}/records/${existing.id}${scope ? `?${scope.slice(1)}` : ''}`, {
        method: 'DELETE',
        headers: auth,
      }).catch(() => {});
    }
    const res = await fetch(`https://api.vercel.com/v2/domains/${cfg.domain}/records${scope ? `?${scope.slice(1)}` : ''}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        type: 'SRV',
        ttl: 60,
        srv: { priority: 0, weight: 5, port, target: cfg.srvTarget },
      }),
    });
    if (!res.ok) return `Vercel DNS refused the SRV record (${res.status}): ${(await res.text()).slice(0, 140)}`;
    return null;
  } catch (e) {
    return `Vercel DNS unreachable: ${String(e).slice(0, 120)}`;
  }
}

interface LaneStore {
  addresses: Record<string, string>;
  /** per-server lane facts, so CLEANUP knows exactly what to tear down —
      the slug/port can't be re-derived from a pretty address alone */
  lanes: Record<string, { slug: string; port: number }>;
}

function loadLaneStore(): LaneStore {
  const file = join(PATHS.data, 'clientpack.json');
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return { addresses: raw.addresses ?? {}, lanes: raw.lanes ?? {} };
  } catch {
    return { addresses: {}, lanes: {} };
  }
}

function saveLaneStore(store: LaneStore): void {
  mkdirSync(PATHS.data, { recursive: true });
  writeFileSync(join(PATHS.data, 'clientpack.json'), JSON.stringify(store, null, 2), 'utf8');
}

function rememberLane(serverId: string, address: string, slug: string, port: number): void {
  const store = loadLaneStore();
  store.addresses[serverId] = address;
  if (port !== DEFAULT_PORT) store.lanes[serverId] = { slug, port };
  saveLaneStore(store);
}

export interface LaneResult {
  address: string;
  warnings: string[];
}

/** Give a server its public front door. Safe to re-run (everything inside is
    idempotent); collects warnings instead of throwing — a failed DNS record
    must not fail a server creation. */
export async function ensureLane(serverId: string, name: string, port: number): Promise<LaneResult> {
  const warnings: string[] = [];
  const slug = laneSlug(name, port);
  const cfg = laneCfg();
  if (!cfg) {
    warnings.push('no public lane configured (settings: laneDomain/laneSrvTarget/laneRelayIp/laneBoxIp) — server is LAN/Tailscale-only');
    return { address: `localhost:${port}`, warnings };
  }
  // the default port is the bare-domain lane: base relay unit + srv-target A record exist
  const address = port === DEFAULT_PORT ? cfg.srvTarget : `${slug}.${cfg.domain}`;

  if (!existsSync(relayKey())) {
    warnings.push('relay_key missing — no relay lane provisioned; server is LAN/Tailscale-only');
    return { address: port === DEFAULT_PORT ? cfg.srvTarget : `${cfg.srvTarget}:${port}`, warnings };
  }

  const relayErr = port === DEFAULT_PORT ? null : await ensureRelayUnit(cfg, slug, port);
  if (relayErr) {
    warnings.push(relayErr);
    return { address: `${cfg.srvTarget}:${port}`, warnings };
  }

  if (port !== DEFAULT_PORT) {
    const dnsErr = await ensureSrvRecord(cfg, slug, port);
    if (dnsErr) {
      warnings.push(dnsErr);
      rememberLane(serverId, `${cfg.srvTarget}:${port}`, slug, port);
      return { address: `${cfg.srvTarget}:${port}`, warnings };
    }
  }

  rememberLane(serverId, address, slug, port);
  return { address, warnings };
}

// ---------------------------------------------------------------------------
// LANE CLEANUP — a server deleted in Crafty leaves its lane orphaned: a socat
// unit + open firewall port on the droplet forwarding to nothing, a dangling
// SRV record, and a stale pack address. The janitor compares recorded lanes
// against Crafty's live server list and tears down the orphans. Runs once at
// panel start and daily after; also callable via POST /api/lanes/cleanup.

async function teardownLane(slug: string, port: number): Promise<string[]> {
  const problems: string[] = [];
  const cfg = laneCfg();
  if (!cfg) return [`lane ${slug}:${port} recorded but no lane config present — nothing to tear down remotely`];
  const unit = `mc-relay-${slug}`;
  const res = await sshDroplet(
    cfg.relayIp,
    [
      `systemctl disable --now ${unit} >/dev/null 2>&1 || true`,
      `rm -f /etc/systemd/system/${unit}.service`,
      `systemctl daemon-reload`,
      `ufw delete allow ${port}/tcp >/dev/null 2>&1 || true`,
      `echo torn-down`,
    ].join('\n'),
  );
  if (!res.ok || !/torn-down/.test(res.out)) problems.push(`droplet teardown for ${unit} failed: ${res.out.slice(0, 120)}`);

  const token = loadSettings().vercelToken;
  if (token && port !== DEFAULT_PORT) {
    try {
      const auth = { authorization: `Bearer ${token}` };
      const scope = await vercelScope(cfg.domain, auth);
      if (scope !== null) {
        const name = `_minecraft._tcp.${slug}`;
        const list = (await (
          await fetch(`https://api.vercel.com/v4/domains/${cfg.domain}/records?limit=100${scope}`, { headers: auth })
        ).json()) as { records?: { id: string; name: string; type: string }[] };
        const rec = list.records?.find((r) => r.type === 'SRV' && r.name === name);
        if (rec) {
          const del = await fetch(
            `https://api.vercel.com/v2/domains/${cfg.domain}/records/${rec.id}${scope ? `?${scope.slice(1)}` : ''}`,
            { method: 'DELETE', headers: auth },
          );
          if (!del.ok) problems.push(`SRV record ${name} not deleted (${del.status})`);
        }
      }
    } catch (e) {
      problems.push(`SRV cleanup failed: ${String(e).slice(0, 100)}`);
    }
  }
  return problems;
}

export interface LaneCleanupResult {
  removed: { serverId: string; slug: string; port: number }[];
  problems: string[];
}

export async function cleanupOrphanLanes(
  liveServerIds: Set<string>,
  log: (m: string) => void,
): Promise<LaneCleanupResult> {
  const store = loadLaneStore();
  const removed: LaneCleanupResult['removed'] = [];
  const problems: string[] = [];
  for (const [serverId, lane] of Object.entries(store.lanes)) {
    if (liveServerIds.has(serverId)) continue;
    log(`lanes: server ${serverId} is gone — tearing down lane ${lane.slug}:${lane.port}`);
    problems.push(...(await teardownLane(lane.slug, lane.port)));
    delete store.lanes[serverId];
    delete store.addresses[serverId];
    removed.push({ serverId, ...lane });
  }
  // stale address entries without lane records (pre-metadata era, port 25565)
  for (const serverId of Object.keys(store.addresses)) {
    if (!liveServerIds.has(serverId) && !store.lanes[serverId]) delete store.addresses[serverId];
  }
  if (removed.length) saveLaneStore(store);
  return { removed, problems };
}

/** Daily janitor: cleanup at panel start (30s settle) and every 24h.
    Also the SELF-HEAL for missing lanes: every live server deserves a join
    address, but a lane provisioned only at creation dies silently if that
    step failed (live 2026-08-02: FreshMC was born during a panel-deploy
    window and had no public join address until noticed by hand). */
export function startLaneJanitor(
  listServers: () => Promise<{ server_id: string; server_name?: string }[]>,
  log: (m: string) => void,
): void {
  const sweep = async () => {
    try {
      const servers = await listServers();
      const ids = new Set(servers.map((s) => s.server_id));
      if (ids.size === 0) return; // Crafty down — never treat that as "all deleted"
      const res = await cleanupOrphanLanes(ids, log);
      if (res.removed.length) log(`lanes: janitor removed ${res.removed.length} orphan lane(s)`);
      for (const p of res.problems) log(`lanes: ${p}`);
      // provision what's missing — idempotent, quiet when unconfigured
      const store = loadLaneStore();
      for (const s of servers) {
        if (store.lanes[s.server_id]) continue;
        try {
          const { readProperties } = await import('./properties.js');
          const port = parseInt(readProperties(s.server_id)['server-port'] ?? '25565', 10) || 25565;
          const r = await ensureLane(s.server_id, s.server_name ?? s.server_id.slice(0, 8), port);
          if (r.address) log(`lanes: janitor provisioned missing lane for "${s.server_name}" — ${r.address}`);
        } catch (e) {
          log(`lanes: could not provision lane for ${s.server_id}: ${String(e).slice(0, 100)}`);
        }
      }
      // OWNERSHIP DOCTOR — the panel runs as root, servers as crafty; any
      // panel step that dies before its chown strands root-owned files the
      // server can't write (live 2026-08-02: FreshMC's automodpack tree —
      // configs unwritable, pack host never started, clients got nothing).
      // Hand every stray file back to its server dir's owner, daily, quietly.
      if (process.platform !== 'win32') {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const run = promisify(execFile);
        const { serverDir } = await import('./servers.js');
        for (const s of servers) {
          try {
            const dir = serverDir(s.server_id);
            const strays = (await run('find', [dir, '-xdev', '!', '-user', '#' + String((await import('node:fs')).statSync(dir).uid), '-print'], { maxBuffer: 8 * 1024 * 1024 })).stdout.split('\n').filter(Boolean);
            if (!strays.length) continue;
            await run('nice', ['-n', '19', 'find', dir, '-xdev', '!', '-user', '#' + String((await import('node:fs')).statSync(dir).uid), '-exec', 'chown', '--reference', dir, '{}', '+']);
            log(`lanes: ownership doctor healed ${strays.length} stray file(s) in "${s.server_name}" (${strays[0]}${strays.length > 1 ? ', …' : ''})`);
          } catch { /* a doctor never throws at its patient */ }
        }
      }
    } catch (e) {
      log(`lanes: janitor sweep failed: ${String(e).slice(0, 120)}`);
    }
  };
  const first = setTimeout(sweep, 30_000);
  first.unref();
  const daily = setInterval(sweep, 24 * 3600_000);
  daily.unref();
}
