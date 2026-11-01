import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
if (process.platform === 'linux') {
  for (const [cmd, ...args] of [
    ['bwrap', '--version'],
    ['ls', '-l', '/usr/bin/bwrap'],
    ['sysctl', 'kernel.apparmor_restrict_unprivileged_userns', 'user.max_user_namespaces'],
    ['sudo', 'sh', '-c', "dmesg | grep -E 'apparmor.*(bwrap|userns)' | tail -12"],
  ]) { const r = spawnSync(cmd, args, {encoding:'utf8'}); console.log(r.status, r.stdout, r.stderr); }
}
if (process.platform === 'win32') {
  const dir = mkdtempSync(join(tmpdir(), 'spawnpoint-profile-control-'));
  try {
    const r = spawnSync('python', ['-I', '-c', `
import importlib.util, ctypes as c, os, sys
spec = importlib.util.spec_from_file_location('testsandbox', sys.argv.pop(1))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
name = 'spawnpointProfileControl'
sid = c.c_void_p()
hr = m.userenv.CreateAppContainerProfile(name, name, name, None, 0, c.byref(sid))
print('CreateAppContainerProfile result', hr, flush=True)
try:
    m.main()
finally:
    m.userenv.DeleteAppContainerProfile.argtypes = [c.c_wchar_p]
    print('DeleteAppContainerProfile result', m.userenv.DeleteAppContainerProfile(name), flush=True)
`, resolve('server/dist/services/testsandbox.py'), '--name', 'spawnpointProfileControl', '--capability', 'spawnpointProfileControlScratch', '--mem-mb', '1024', '--cwd', dir, '--write', dir, '--', join(process.env.SystemRoot, 'System32', 'cmd.exe'), '/d', '/c', 'exit 0'], { encoding: 'utf8', timeout:60000 });
    console.log('Profile-backed probe exit', r.status, r.stdout, r.stderr);
  } finally { rmSync(dir, {recursive:true,force:true}); }
}
