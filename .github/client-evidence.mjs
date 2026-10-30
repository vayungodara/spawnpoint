// What a client-test log proves about rendering. Lines are verbatim from real
// runs: macOS HeadlessMC offline (stubbed LWJGL), Linux xvfb (Mesa llvmpipe),
// a Mac VM through MoltenVK, and an older client without device lines.
import assert from 'node:assert/strict';
import { renderingEvidence } from '../server/dist/services/launchgate.js';

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
