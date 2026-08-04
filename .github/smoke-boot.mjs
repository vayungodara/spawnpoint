// CI boot smoke: the built panel must BOOT and serve /api/health on an EMPTY
// layout on every OS — no Crafty, no JDK, no servers, no token. Watchers are
// expected to log errors on the way up; the bar is "starts, serves, and
// degrades honestly", which is exactly what a first-run install looks like.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const PORT = 25571;
const root = mkdtempSync(join(tmpdir(), 'spawnpoint-smoke-'));
mkdirSync(join(root, 'Spawnpoint', 'data'), { recursive: true });
writeFileSync(join(root, 'Spawnpoint', 'data', 'settings.json'), JSON.stringify({ port: PORT }));

let exited = false;
const child = spawn(process.execPath, ['server/dist/index.js'], {
  env: { ...process.env, SPAWNPOINT_ROOT: root },
  stdio: 'inherit',
});
child.on('exit', (code) => {
  exited = true;
  console.error(`panel exited before the health check passed (code ${code})`);
  process.exit(1);
});

const deadline = Date.now() + 90_000;
while (Date.now() < deadline && !exited) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    if (res.ok) {
      console.log('panel boots and serves /api/health on', process.platform);
      child.removeAllListeners('exit');
      child.kill();
      process.exit(0);
    }
  } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 1000));
}
console.error('panel did not serve /api/health within 90s');
child.removeAllListeners('exit');
child.kill();
process.exit(1);
