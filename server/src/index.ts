import { startScheduler } from './services/scheduler.js';
import { startTpsMonitor } from './services/tpsmonitor.js';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { loadSettings, PATHS } from './config.js';
import serverRoutes from './routes/servers.js';
import configRoutes from './routes/configRoutes.js';
import contentRoutes from './routes/contentRoutes.js';
import maintenanceRoutes from './routes/maintenanceRoutes.js';
import chunkyRoutes from './routes/chunkyRoutes.js';
import fileRoutes from './routes/fileRoutes.js';
import settingsRoutes, { cookieAuthed } from './routes/settingsRoutes.js';
import wizardRoutes, { wizardActive, setupCode } from './routes/wizardRoutes.js';
import { startAutostopWatcher } from './services/autostop.js';
import { startIngameHud } from './services/ingamehud.js';
import { startAutobackup } from './services/autobackup.js';
import { startChatGenie, genieBusy } from './services/chatgenie.js';
import { startDeathInsurance } from './services/deathinsurance.js';
import { startDepDoctor } from './services/depdoctor.js';
import { startPlayerTriggers } from './services/triggers.js';
import { startChunkyWatcher } from './services/chunky.js';
import { startBootRestore } from './services/bootrestore.js';
import { startCraftyDoctor } from './services/craftydoctor.js';
import { startLaneJanitor } from './services/lanes.js';
import { craftyApi } from './clients/crafty.js';

const settings = loadSettings();
const app = Fastify({ logger: true });

// PIN gate on the API (when a PIN is set in Settings). Localhost is always
// allowed — deploy tooling and the crash-loop wrapper live there. The SPA
// shell itself stays public; every byte of real data is behind /api/.
app.addHook('onRequest', async (req, reply) => {
  if (!req.url.startsWith('/api/')) return;
  if (req.url.startsWith('/api/auth') || req.url === '/api/health') return;
  // first-run wizard: reachable pre-PIN by definition; every route in the
  // family self-guards on wizardActive() (token file absent), so a
  // configured install exposes nothing here beyond {active:false}
  if (req.url.startsWith('/api/wizard/')) return;
  if (req.ip === '127.0.0.1' || req.ip === '::1') return;
  if (!cookieAuthed(req.headers.cookie)) {
    return reply.code(401).send({ error: 'PIN required' });
  }
});

await app.register(settingsRoutes);
await app.register(wizardRoutes);
await app.register(serverRoutes);
await app.register(configRoutes);
await app.register(contentRoutes);
await app.register(maintenanceRoutes);
await app.register(chunkyRoutes);
await app.register(fileRoutes);

// Graceful self-restart: systemd relaunches us with fresh code. Localhost-only
// guard — remote devices can't kill the panel. REFUSES while a wish is in
// flight: on 2026-07-18 a deploy script displayed the busy check instead of
// gating on it and killed a player's wish mid-flight. The panel is the last
// line of defense, not the deploy script's discipline. `force:true` overrides
// for emergencies (hung wish).
app.post<{ Body?: { force?: boolean } }>('/api/admin/exit', async (req, reply) => {
  if (req.ip !== '127.0.0.1' && req.ip !== '::1') return reply.code(403).send({ error: 'localhost only' });
  // THE PANEL DEFENDS ITS OWN IN-FLIGHT WORK. A restart killed a wish once
  // (2026-07-18) and on 2026-08-02 one killed a server-creation job mid-
  // provision (root-owned automodpack tree, no lane — FreshMC) and a
  // preflight batch (Better Caves shipped ungated). In-memory work dies with
  // the process, so the process refuses to die while any exists.
  if (!req.body?.force) {
    const reasons: string[] = [];
    const b = genieBusy();
    if (b.busy) reasons.push(`wish in flight (${b.running} running, ${b.queued} queued)`);
    try {
      const { listJobs } = await import('./services/servercreate.js');
      const active = listJobs().filter((j) => !j.done).length;
      if (active) reasons.push(`${active} server-creation job(s) running`);
    } catch { /* probe must never block an exit */ }
    try {
      const { gateBusy } = await import('./services/launchgate.js');
      if (gateBusy()) reasons.push('launch gate running or queued');
    } catch { /* same */ }
    try {
      const { preflightBusy } = await import('./services/preflight.js');
      if (preflightBusy()) reasons.push('preflight batch pending or dry-boot running');
    } catch { /* same */ }
    try {
      const { installerBusy } = await import('./services/installer.js');
      if (installerBusy()) reasons.push('mod install downloading');
    } catch { /* same */ }
    if (reasons.length) {
      return reply.code(409).send({ error: 'panel is mid-work', reasons, hint: 'retry when clear, or pass {"force":true}' });
    }
  }
  setTimeout(() => process.exit(0), 200);
  return { ok: true, restarting: true };
});

app.get('/api/health', async () => ({
  ok: true,
  name: 'spawnpoint',
  version: '0.1.0',
  time: new Date().toISOString(),
}));

// Serve the built SPA when it exists (production); in dev, Vite proxies /api here.
if (existsSync(PATHS.webDist)) {
  await app.register(fastifyStatic, { root: PATHS.webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
}

startAutostopWatcher((msg) => app.log.info(msg));
startIngameHud((msg) => app.log.info(msg));
startAutobackup((msg) => app.log.info(msg));
startChatGenie((msg) => app.log.info(msg));
startDeathInsurance((msg) => app.log.info(msg));
startDepDoctor((msg) => app.log.info(msg));
startPlayerTriggers((msg) => app.log.info(msg));
startScheduler((msg) => app.log.info(msg));
startTpsMonitor((msg) => app.log.info(msg));
startChunkyWatcher((msg) => app.log.info(msg));
startBootRestore((msg) => app.log.info(msg));
startCraftyDoctor((msg) => app.log.info(msg));
// gate every AutoModpack regenerate, even boot-time ones the routes never see
void import('./services/launchgate.js').then(({ startLaunchGateWatcher }) =>
  startLaunchGateWatcher(async () => (await craftyApi.listServers()).map((s) => s.server_id), (msg) => app.log.info(msg)),
);
// pre-fill the joinability cache so a panel deploy doesn't flash every
// running server's card as "STARTING…" (owner read that as all-servers-start)
setTimeout(() => {
  void import('./services/phase.js').then(({ warmPhaseCache }) =>
    warmPhaseCache(
      () => craftyApi.listServers(),
      async (id) => (await craftyApi.getStats(id)).running === true,
    ),
  );
}, 3_000);
startLaneJanitor(() => craftyApi.listServers(), (msg) => app.log.info(msg));

await app.listen({ host: '0.0.0.0', port: settings.port });

// fresh install: surface the setup claim code once, so finishing setup from
// another device is a copy-paste and not a hunt through the filesystem
if (wizardActive()) {
  app.log.info(`spawnpoint: first-run setup is open at http://localhost:${settings.port} — setup code for remote browsers: ${setupCode()}`);
}
