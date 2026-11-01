// What a client-test log proves about rendering. Lines are verbatim from real
// runs: macOS HeadlessMC offline (stubbed LWJGL), Linux xvfb (Mesa llvmpipe),
// a Mac VM through MoltenVK, and an older client without device lines.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clientInputDifference, renderingEvidence } from '../server/dist/services/launchgate.js';

const stubbedMac = `[18:59:07] [main/WARNING] [LaunchOptions]: You are offline, game will start in headless mode!
[18:59:18] [Render thread/INFO]: Using graphics backend OpenGL, using drivers: 
[18:59:18] [Render thread/INFO]: Using graphics device:  ()
[18:59:18] [Render thread/INFO]: Using graphics device extensions: `;
const xvfb = `[19:01:26] [Render thread/INFO]: Using graphics backend OpenGL, using drivers: 4.5 (Core Profile) Mesa 22.3.6
[19:01:26] [Render thread/INFO]: Using graphics device: llvmpipe (LLVM 15.0.6, 256 bits) (Mesa/X.org)`;
const paravirtual = `[18:48:12] [Render thread/INFO]: Using graphics backend Vulkan, using drivers: 1.2.334 MoltenVK 1.4.2
[18:48:12] [Render thread/INFO]: Using graphics device: Apple Paravirtual device (APPLE)`;
const gpu = `[20:00:00] [Render thread/INFO]: Using graphics backend OpenGL, using drivers: 4.6.0 NVIDIA 550.54.14
[20:00:00] [Render thread/INFO]: Using graphics device: NVIDIA GeForce RTX 3060/PCIe/SSE2 (NVIDIA Corporation)`;
const silent = `[18:54:16] [Render thread/INFO]: Backend library: LWJGL version 3.3.3-snapshot`;

for (const mode of ['window', 'xvfb', 'headless']) {
  const stub = renderingEvidence(stubbedMac, mode);
  assert.notEqual(stub.result, 'passed', `stubbed LWJGL never passes rendering in ${mode} mode`);
  assert.equal(stub.stubbed, true);
  assert.notEqual(renderingEvidence(silent, mode).result, 'passed', `no driver or device never passes rendering in ${mode} mode`);
}
assert.notEqual(renderingEvidence(xvfb, 'headless').result, 'passed', 'headless mode is stubbed whatever the log claims');
const software = renderingEvidence(xvfb, 'xvfb');
assert.equal(software.result, 'passed');
assert.match(software.detail, /llvmpipe.*not verified on real hardware/);
assert.match(renderingEvidence(paravirtual, 'window').detail, /Apple Paravirtual device.*not verified on real hardware/);
const real = renderingEvidence(gpu, 'window');
assert.equal(real.result, 'passed');
assert.doesNotMatch(real.detail, /not verified on real hardware/);
console.log('client rendering evidence: 5 log shapes checked');

// The join client rewrites the root options.txt in its game directory while
// it runs. That copy is exempt only after launch; the pristine pack copy and
// every other input stay byte-exact.
const rundir = mkdtempSync(join(tmpdir(), 'spawnpoint-join-inputs-'));
try {
  const pack = join(rundir, 'automodpack', 'modpacks', 'spawnpoint-join-test');
  const files = { 'options.txt': 'enableVsync:false\nmaxFps:260\nentityDistanceScaling:0.75\n', 'config/x.json': '{}', 'mods/a.jar': 'jar bytes' };
  for (const base of [rundir, pack]) for (const [rel, text] of Object.entries(files)) { mkdirSync(join(base, rel, '..'), { recursive: true }); writeFileSync(join(base, rel), text); }
  const expected = new Map(Object.entries(files).map(([rel, text]) => [rel, createHash('sha512').update(text).digest('hex')]));
  assert.equal(clientInputDifference(rundir, expected, false), null, 'untouched inputs match before launch');
  writeFileSync(join(rundir, 'options.txt'), 'enableVsync:false\nmaxFps:260\nentityDistanceScaling:0.75\nonboardAccessibility:false\nlastServer:127.0.0.1\n');
  assert.equal(clientInputDifference(rundir, expected, true), null, 'the client rewriting its game-dir options.txt during the join is not a pack difference');
  assert.equal(clientInputDifference(rundir, expected, false), 'options.txt', 'before launch, a changed options.txt is refused');
  writeFileSync(join(pack, 'options.txt'), 'maxFps:30\n');
  assert.equal(clientInputDifference(rundir, expected, true), 'options.txt', 'the pristine pack copy of options.txt stays byte-exact after launch');
  writeFileSync(join(pack, 'options.txt'), files['options.txt']);
  writeFileSync(join(rundir, 'config/x.json'), '{"changed":true}');
  assert.equal(clientInputDifference(rundir, expected, true), 'config/x.json', 'other client inputs stay byte-exact after launch');
  writeFileSync(join(rundir, 'config/x.json'), '{}');
  writeFileSync(join(rundir, 'mods/extra.jar'), 'x');
  assert.equal(clientInputDifference(rundir, expected, true), 'mods/extra.jar (unexpected executable input)');
  console.log('join client inputs: options.txt rewrite exempt only in the game dir after launch');
} finally { rmSync(rundir, { recursive: true, force: true }); }
