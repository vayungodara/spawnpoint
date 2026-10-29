// Executed by the independent owner, never by a detached panel child. Reuse
// the source-of-truth revision/publication checks for manual AND automatic starts.
import { nativeRecord, transferRecord } from './native.js';
import { nativeInstallJob } from './nativeinstall.js';
import { verifyActiveRevision, revisionState, writeLaunchGate } from './revisions.js';
import { holdHosting } from './automodpack.js';

try {
  const id = process.argv[2];
  if (!nativeRecord(id)) throw new Error('native ownership is required');
  if (transferRecord(id)) throw new Error('ownership transfer requires recovery');
  const install = nativeInstallJob(id);
  if (install && install.phase !== 'done') throw new Error('installation is incomplete');
  await verifyActiveRevision(id);
  if (revisionState(id).active) {
    holdHosting(id);
    writeLaunchGate(id);
  }
} catch (error) {
  process.stderr.write(String(error));
  process.exitCode = 1;
}
