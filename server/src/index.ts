import { startScheduler } from './services/scheduler.js';
import { startTpsMonitor } from './services/tpsmonitor.js';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { loadSettings, PATHS } from './config.js';
import serverRoutes from './routes/servers.js';
import configRoutes from './routes/configRoutes.js';
import contentRoutes from './routes/contentRoutes.js';
import maintenanceRoutes from './routes/maintenanceRoutes.js';
import chunkyRoutes from './routes/chunkyRoutes.js';
import fileRoutes from './routes/fileRoutes.js';
import settingsRoutes from './routes/settingsRoutes.js';
import { adminToken, authed, pinConfigured } from './auth.js';
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
import { resumeCandidates, txnBusy } from './services/packtxn.js';
import { listJobs } from './services/servercreate.js';
import { isServerId } from './services/servers.js';
import { craftyApi } from './clients/crafty.js';

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const settings = loadSettings();
const app = Fastify({ logger: true });

// Every /api route needs a session or the admin token, except health, login
// and the setup wizard (which demands the setup code instead).
const OPEN = new Set(['/api/health', '/api/auth', '/api/auth/check']);
app.addHook('onRequest', async (req, reply) => {
  // decide on the matched route, not the raw URL: the router decodes
  // percent-escapes, so "/%61pi/..." reaches an /api route too
  const route = req.routeOptions.url ?? '';
  if (!route.startsWith('/api/') || OPEN.has(route) || route.startsWith('/api/wizard/')) return;
  const by = authed(req.headers);
  if (!by) {
    return reply.code(401).send({ error: pinConfigured() ? 'PIN required' : 'finish setup first' });
  }
  // a cookie rides along on cross-site requests; refuse writes from other origins
  if (by === 'session' && req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
    let host = '';
    try { host = new URL(req.headers.origin).host; } catch { /* "null" origin */ }
    if (host !== req.headers.host) return reply.code(403).send({ error: 'cross-origin request refused' });
  }
  // one check for every /api/servers/:id route: ids become folder paths
  if (route.startsWith('/api/servers/:id') && !isServerId((req.params as { id?: string }).id ?? '')) {
    return reply.code(400).send({ error: 'bad server id' });
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

// Graceful self-restart for deploy tooling (systemd relaunches the panel).
// Refuses while a wish, a server creation or a mod change is in flight,
// since in-memory work dies with the process; `force: true` overrides.
app.post<{ Body?: { force?: boolean } }>('/api/admin/exit', async (req, reply) => {
  if (!req.body?.force) {
    const reasons: string[] = [];
    const b = genieBusy();
    if (b.busy) reasons.push(`wish in flight (${b.running} running, ${b.queued} queued)`);
    const active = listJobs().filter((j) => !j.done).length;
    if (active) reasons.push(`${active} server-creation job(s) running`);
    if (txnBusy()) reasons.push('a mod change is being tested');
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
  version: VERSION,
  time: new Date().toISOString(),
}));

// Serve the built web app (in dev, Vite proxies /api here instead). Hashed
// assets are immutable; index.html is always revalidated. The build writes
// .br/.gz siblings, served to browsers that accept them.
if (existsSync(PATHS.webDist)) {
  await app.register(fastifyStatic, {
    root: PATHS.webDist,
    preCompressed: true,
    cacheControl: false,
    setHeaders: (reply, path) => {
      reply.header('cache-control', /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
}

const log = (msg: string): void => app.log.info(msg);
startAutostopWatcher(log);
startIngameHud(log);
startAutobackup(log);
startChatGenie(log);
startDeathInsurance(log);
startDepDoctor(log);
startPlayerTriggers(log);
startScheduler(log);
startTpsMonitor();
startChunkyWatcher(log);
startBootRestore(log);
startCraftyDoctor(log);
resumeCandidates(log);
// pre-fill the joinability cache so a panel restart doesn't flash running servers as "starting"
setTimeout(() => {
  void import('./services/phase.js').then(({ warmPhaseCache }) =>
    warmPhaseCache(
      () => craftyApi.listServers(),
      async (id) => (await craftyApi.getStats(id)).running === true,
    ),
  );
}, 3_000);

await app.listen({ host: '0.0.0.0', port: settings.port });
adminToken(); // scripts on this machine read it from data/admin-token
// data/ holds the session secret, the admin token and API keys: owner-only
try { chmodSync(PATHS.data, 0o700); } catch { /* Windows */ }

if (wizardActive()) {
  app.log.info(`spawnpoint: finish setup at http://localhost:${settings.port}/setup#code=${setupCode()} (setup code ${setupCode()})`);
}
