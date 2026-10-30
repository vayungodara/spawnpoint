// CI boot smoke: the built panel must BOOT and serve /api/health on an EMPTY
// layout on every OS — no Crafty, no JDK, no servers, no token. Watchers are
// expected to log errors on the way up; the bar is "starts, serves, and
// degrades honestly", which is exactly what a first-run install looks like.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const PORT = 25571;
const root = mkdtempSync(join(tmpdir(), 'spawnpoint-smoke-'));
mkdirSync(join(root, 'Spawnpoint', 'data'), { recursive: true });
writeFileSync(join(root, 'Spawnpoint', 'data', 'settings.json'), JSON.stringify({ port: PORT }));

let exited = false;
let webChecked = false;
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
      // Installation assets must work before sign-in too: a phone may install
      // directly from the PIN gate or the first-run wizard.
      webChecked = true;
      const base = `http://127.0.0.1:${PORT}`;
      const html = await (await fetch(base)).text();
      assert.match(html, /rel="manifest" href="\/manifest.webmanifest"/);
      assert.match(html, /name="theme-color" content="#16191f"/);
      const manifestResponse = await fetch(`${base}/manifest.webmanifest`);
      assert.match(manifestResponse.headers.get('content-type') ?? '', /manifest\+json/);
      const manifest = await manifestResponse.json();
      assert.equal(manifest.name, 'Spawnpoint');
      assert.equal(manifest.display, 'standalone');
      assert.equal(manifest.start_url, '/');
      assert.equal(manifest.scope, '/');
      assert.deepEqual(manifest.icons.map((i) => i.sizes).sort(), ['192x192', '512x512']);
      for (const icon of [...manifest.icons, { src: '/apple-touch-icon.png', sizes: '180x180' }]) {
        const r = await fetch(`${base}${icon.src}`);
        assert.equal(r.status, 200);
        assert.match(r.headers.get('content-type') ?? '', /image\/png/);
        const png = Buffer.from(await r.arrayBuffer());
        assert.equal(png.subarray(1, 4).toString(), 'PNG');
        assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes);
      }
      console.log('PWA manifest and phone icons served before sign-in');
      console.log('panel boots and serves /api/health on', process.platform);
      child.removeAllListeners('exit');
      child.kill();
      process.exit(0);
    }
  } catch (error) {
    if (webChecked) {
      console.error('PWA asset check failed:', error);
      child.removeAllListeners('exit');
      child.kill();
      process.exit(1);
    }
    // not up yet
  }
  await new Promise((r) => setTimeout(r, 1000));
}
console.error('panel did not serve /api/health within 90s');
child.removeAllListeners('exit');
child.kill();
process.exit(1);
