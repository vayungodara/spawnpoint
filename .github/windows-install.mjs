// End-to-end proof of install.ps1 on a real Windows machine (CI's
// windows-latest). The runner's own account is the built-in administrator,
// which UAC doesn't filter, so the test makes a normal administrator account
// and signs it in over loopback Remote Desktop. Its programs then run with a
// real UAC-filtered token, elevation works as it does on a home PC, and
// signing out and in again fires the panel's sign-in task for real.
// The installer runs as the pasted one-liner, `irm … | iex`, in a PowerShell
// window in that session. Scenarios: missing prerequisites, a fresh install
// with port 25570 taken, the first-run wizard through to a running Fabric
// server, a rerun as an update from PowerShell 7 that keeps the server
// running, and sign-out and sign-in. Screenshots land in
// .amp/in/windows-install for the artifact.
// It installs a real service, scheduled tasks, a firewall rule and a local
// account, so it refuses to run on a machine that already has any of them.
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTcp, connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

assert.equal(process.platform, 'win32', 'install.ps1 runs on Windows only');
const user = 'spuser';
const work = 'C:\\sp-ci';
const root = 'C:\\MinecraftServers';
// This checkout, copied where the installer keeps its own, so the one-liner
// installs this commit instead of cloning main.
const source = join(root, 'Spawnpoint');
const shots = resolve('.amp/in/windows-install');
const home = `C:\\Users\\${user}`;
const data = join(root, 'Spawnpoint', 'data');
// under a folder named test, so the library audit can't be fooled by an ancestor's name
const pyBase = 'C:\\Program Files\\SpTest';
const pyCopy = join(pyBase, 'test', 'Python');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// CI steps run in PowerShell 7, whose PSModulePath breaks module loading in 5.1
const psEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'psmodulepath'));
const ps = (script) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 300_000, env: psEnv }).trim();
const sc = (...args) => spawnSync('sc.exe', args, { encoding: 'utf8' });
let checks = 0;
const check = (name, condition, detail = '') => { assert.ok(condition, `${name}${detail ? `: ${detail}` : ''}`); checks++; console.log('PASS:', name); };

assert.equal(sc('query', 'SpawnpointSupervisor').status, 1060, 'never replace an installed supervisor in a test');
assert.equal(ps(`[bool](Get-LocalUser -Name ${user} -ErrorAction SilentlyContinue)`), 'False', `never reuse an existing ${user} account`);
assert.equal(ps("[bool](Get-ScheduledTask -TaskName 'Spawnpoint Panel' -ErrorAction SilentlyContinue)"), 'False', 'never replace a panel task');
assert.ok(!existsSync(root), `never touch an existing layout at ${root}`);
for (const dir of [work, pyBase]) assert.ok(!existsSync(dir), `refusing to reuse ${dir}; this test needs a disposable machine`);
assert.notEqual(spawnSync('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=Spawnpoint']).status, 0, 'never replace a Spawnpoint firewall rule');
mkdirSync(shots, { recursive: true });
mkdirSync(work, { recursive: true });

// Serve install.ps1 from this checkout so the one-liner is the real one.
const web = createServer((req, res) => {
  if (req.url !== '/install.ps1') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(readFileSync('install.ps1'));
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const oneLiner = `irm http://127.0.0.1:${web.address().port}/install.ps1 | iex`;

async function until(probe, message, timeout = 60_000, every = 1000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const r = await probe(); if (r) return r; } catch (e) { if (e.fatal) throw e; /* settling */ }
    await pause(every);
  }
  throw new Error(message);
}
const sessionId = () => (ps('(query user 2>$null | Out-String); exit 0').match(new RegExp(`\\b${user}\\s+\\S+\\s+(\\d+)\\s+Active`)) ?? [])[1];
function consoleShot(name) {
  ps(`Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object Drawing.Bitmap $b.Width, $b.Height
[Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location, [Drawing.Point]::Empty, $b.Size); $bmp.Save('${join(shots, `${name}.png`)}')`);
}
async function signIn() {
  ps("Start-Process mstsc '/v:127.0.0.2 /w:1000 /h:700'");
  try { await until(sessionId, `${user} did not sign in over Remote Desktop`, 120_000, 2000); } catch (e) { consoleShot('rdp-failed'); throw e; }
  await pause(10_000); // let Explorer settle
}
async function signOut() {
  ps(`logoff ${sessionId()}`);
  await until(() => !sessionId(), `${user} did not sign out`, 120_000, 2000);
}

// A normal administrator, signed in over loopback RDP (127.0.0.2 so it gets
// its own session next to the runner's console session).
const password = `Sp-${randomBytes(12).toString('base64url')}-9a`;
ps(`$ErrorActionPreference = 'Stop'
New-LocalUser -Name ${user} -Password (ConvertTo-SecureString '${password}' -AsPlainText -Force) -PasswordNeverExpires | Out-Null
Add-LocalGroupMember -Group Administrators -Member ${user}
Set-ItemProperty 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server' fDenyTSConnections 0
Set-ItemProperty 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp' UserAuthentication 0
Start-Service TermService
New-Item 'HKCU:\\Software\\Microsoft\\Terminal Server Client' -Force | Out-Null
New-ItemProperty 'HKCU:\\Software\\Microsoft\\Terminal Server Client' -Name AuthenticationLevelOverride -Value 0 -PropertyType DWord -Force | Out-Null
cmdkey /generic:TERMSRV/127.0.0.2 /user:${user} /pass:'${password}' | Out-Null
# The tool cache inherits C:\\'s Authenticated Users: Modify, which the
# installer rightly refuses for the Python it runs elevated. Copy it where
# winget and python.org put an all-users install, under Program Files.
robocopy (Split-Path (Get-Command python.exe).Source) '${pyCopy}' /E /NFL /NDL /NJH /NJS /NP | Out-Null
# Edge's first-run pages would cover the setup link in the screenshots
New-Item 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge' -Force | Out-Null
New-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge' -Name HideFirstRunExperience -Value 1 -PropertyType DWord -Force | Out-Null
icacls '${work}' /grant '${user}:(OI)(CI)M' | Out-Null
robocopy '${resolve('.')}' '${source}' /E /XD node_modules .amp /NFL /NDL /NJH /NJS /NP | Out-Null
# the installer refuses a checkout other accounts can change, so give it to the test account alone
# as the installer leaves a layout: the user's alone, with children inheriting
icacls '${root}' /setowner ${user} /T /Q | Out-Null
icacls '${root}' /inheritance:r /grant:r '${user}:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /Q | Out-Null
icacls '${root}\\*' /reset /T /Q | Out-Null
exit 0`);
await signIn();

// Run the one-liner in a visible PowerShell window in the test account's
// session, as that account's normal (filtered) token. The window screenshots
// its own desktop when the installer finishes.
async function install(name, { shell = 'powershell.exe', env = {}, path = null, open = false, after = [] } = {}) {
  const log = join(work, `${name}.txt`), done = join(work, `${name}.exit`), png = join(work, `${name}.png`);
  for (const f of [log, done, png]) rmSync(f, { force: true });
  const vars = Object.entries({ ...(open ? {} : { SPAWNPOINT_NO_OPEN: '1' }), ...env }).map(([k, v]) => `$env:${k} = '${v}'`);
  vars.push(path !== null ? `$env:Path = '${path}'` : `$env:Path = '${pyCopy};' + $env:Path`);
  writeFileSync(join(work, `${name}.ps1`), [
    `Start-Transcript -LiteralPath '${log}' | Out-Null`,
    `"admin: " + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`,
    `"integrity: " + ((whoami /groups | Select-String 'Mandatory Label') -replace '\\s+', ' ')`,
    `"powershell: " + $PSVersionTable.PSVersion`,
    ...vars,
    `Set-Location -LiteralPath '${source}'`,
    'Clear-Host',
    oneLiner,
    '$code = $LASTEXITCODE',
    ...after,
    'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
    'function Shot($file) { $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object Drawing.Bitmap $b.Width, $b.Height; [Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location, [Drawing.Point]::Empty, $b.Size); $bmp.Save($file) }',
    // the browser opens over the console: capture it, note its URL, close it, then capture the console
    ...(open ? ['Start-Sleep -Seconds 12', `Shot '${join(work, `${name}-browser.png`)}'`,
      `Set-Content -LiteralPath '${join(work, `${name}.edge.txt`)}' -Value ((Get-CimInstance Win32_Process -Filter "Name='msedge.exe'").CommandLine -join ' ')`, 'Stop-Process -Name msedge -Force -ErrorAction SilentlyContinue'] : []),
    'Start-Sleep -Seconds 2',
    `Shot '${png}'`,
    'Stop-Transcript | Out-Null',
    `Set-Content -LiteralPath '${done}' -Value $code`,
  ].join('\r\n'));
  const exe = shell === 'pwsh.exe' ? ps('(Get-Command pwsh.exe).Source') : 'powershell.exe';
  const task = `SP-CI ${name}`;
  ps(`$a = New-ScheduledTaskAction -Execute '${exe}' -Argument '-NoProfile -ExecutionPolicy Bypass -File "${join(work, `${name}.ps1`)}"'
$p = New-ScheduledTaskPrincipal -UserId '${user}' -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName '${task}' -Action $a -Principal $p -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0) -Force | Out-Null
Start-ScheduledTask -TaskName '${task}'`);
  await until(() => existsSync(done), `${name}: the installer did not finish`, 30 * 60_000, 2000);
  ps(`Unregister-ScheduledTask -TaskName '${task}' -Confirm:$false`);
  for (const f of [png, join(work, `${name}-browser.png`)]) if (existsSync(f)) copyFileSync(f, join(shots, f.slice(work.length + 1)));
  const transcript = readFileSync(log, 'utf8');
  console.log(`----- ${name} transcript -----\n${transcript}\n-----`);
  return { code: Number(readFileSync(done, 'utf8').trim()), transcript };
}

const count = (text, needle) => text.split(needle).length - 1;
const json = (script) => JSON.parse(ps(`${script} | ConvertTo-Json -Compress -Depth 4`) || 'null');
const listener = (port) => Number(ps(`(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`) || 0);
function taskTree() {
  const rootPid = Number(readFileSync(join(data, 'panel-task.pid'), 'utf8').trim());
  const all = json('Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name');
  const tree = new Set([rootPid]);
  for (let grew = true; grew;) { grew = false; for (const p of all) if (tree.has(p.ParentProcessId) && !tree.has(p.ProcessId)) { tree.add(p.ProcessId); grew = true; } }
  return { tree, all };
}
const owner = (pid) => ps(`(Invoke-CimMethod -InputObject (Get-CimInstance Win32_Process -Filter "ProcessId=${pid}") -MethodName GetOwner).User`);
async function health(port) {
  try { return (await (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5000) })).json()).name === 'spawnpoint'; } catch { return false; }
}
// Minecraft's server list ping: a running server answers with its version.
function ping(port) {
  // a hard deadline: a half-open connection must not hang the whole test
  return Promise.race([rawPing(port), pause(8000).then(() => { throw new Error('ping deadline'); })]);
}
function rawPing(port) {
  return new Promise((resolvePing, reject) => {
    const s = connect(port, '127.0.0.1');
    const varint = (n) => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return Buffer.from(b); };
    const packet = (...parts) => { const body = Buffer.concat(parts); return Buffer.concat([varint(body.length), body]); };
    const host = Buffer.from('localhost');
    let received = Buffer.alloc(0);
    s.setTimeout(5000, () => { s.destroy(); reject(new Error('ping timeout')); });
    s.on('error', reject);
    s.on('connect', () => {
      const portBuf = Buffer.alloc(2); portBuf.writeUInt16BE(port);
      s.write(packet(varint(0), varint(767), varint(host.length), host, portBuf, varint(1)));
      s.write(packet(varint(0)));
    });
    s.on('data', (d) => {
      received = Buffer.concat([received, d]);
      const text = received.toString('utf8');
      const start = text.indexOf('{');
      if (start >= 0) { try { const status = JSON.parse(text.slice(start)); s.destroy(); resolvePing(status); } catch { /* partial */ } }
    });
  });
}

let failure;
try {
  // 1. Missing prerequisites: no Node, git or Python on PATH. Nothing may be
  // created, and every missing tool gets its exact winget command.
  {
    const apps = join(home, 'AppData\\Local\\Microsoft\\WindowsApps'); // winget lives here
    const r = await install('1-missing-prereqs', { path: `C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0;${apps}`, env: { SPAWNPOINT_WINGET: '0' } });
    check('the installer runs with a filtered, non-administrator token', /admin: False/.test(r.transcript) && /Medium Mandatory Level/.test(r.transcript));
    check('missing prerequisites fail the install', r.code === 1, String(r.code));
    for (const id of ['OpenJS.NodeJS.LTS', 'Git.Git', 'Python.Python.3.13 --scope machine']) check(`winget command for ${id.split(' ')[0]}`, r.transcript.includes(`winget install -e --id ${id}`));
    check('nothing installed before prerequisites are met', !existsSync(join(root, 'Tools')) && sc('query', 'SpawnpointSupervisor').status === 1060);
  }

  // A layout folder with a space, nested under another folder, is refused before anything changes.
  {
    const r = await install('1b-bad-layout', { env: { SPAWNPOINT_ROOT: 'C:\\Minecraft Servers\\mine' } });
    check('a nested layout path with spaces is refused', r.code === 1 && r.transcript.includes('has to be a plain folder directly on a drive'));
    check('nothing created for the refused layout', !existsSync('C:\\Minecraft Servers') && !existsSync(join(root, 'Tools')));
  }

  // A new layout is born private and owned by the user; it stops at the
  // checkout check because this run's checkout lives in the main layout.
  {
    const fresh = 'C:\\SpFresh';
    const r = await install('1c-fresh-layout-acl', { env: { SPAWNPOINT_ROOT: fresh } });
    const acl = json(`$a = Get-Acl -LiteralPath '${fresh}'; [pscustomobject]@{ Protected = $a.AreAccessRulesProtected; Owner = $a.GetOwner([Security.Principal.NTAccount]).Value; Who = @($a.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }) }`);
    console.log('fresh layout ACL:', JSON.stringify(acl));
    const userSid = ps(`(New-Object Security.Principal.NTAccount '${user}').Translate([Security.Principal.SecurityIdentifier]).Value`);
    check('a new layout is created private to the user, SYSTEM and Administrators', acl.Protected === true && acl.Owner.toLowerCase().endsWith(user)
      && [acl.Who].flat().every((w) => [userSid, 'S-1-5-18', 'S-1-5-32-544'].includes(w)), JSON.stringify(acl));
    check('a checkout outside <layout>\\Spawnpoint is refused', r.code === 1 && r.transcript.includes(`has to be ${fresh}\\Spawnpoint`));
    ps(`Remove-Item -LiteralPath '${fresh}' -Recurse -Force`);
  }
  // An existing folder other accounts can change is refused, not adopted.
  {
    const shared = 'C:\\SpShared';
    mkdirSync(shared); // inherits Authenticated Users: Modify from C:\
    writeFileSync(join(shared, 'planted.txt'), 'x');
    const r = await install('1d-shared-layout', { env: { SPAWNPOINT_ROOT: shared } });
    check('an existing layout other accounts can change is refused', r.code === 1 && r.transcript.includes(`Other accounts on this PC can change ${shared}`));
    check('the refused layout is left as it was', !existsSync(join(shared, 'Tools')));
    ps(`Remove-Item -LiteralPath '${shared}' -Recurse -Force`);
  }

  // A stdlib file anyone can change, under otherwise protected folders, stops
  // the install before the elevated step runs Python.
  {
    const planted = join(pyCopy, 'Lib', 'json', 'planted.py');
    writeFileSync(planted, '');
    ps(`icacls '${planted}' /grant '*S-1-1-0:M' | Out-Null`);
    const r = await install('1e-unsafe-python');
    check('a writable file in Python\'s library is refused before elevation', r.code === 1
      && r.transcript.includes(`Other accounts can change ${planted}`) && !r.transcript.includes('Windows will ask for permission'));
    check('no service after the refusal', sc('query', 'SpawnpointSupervisor').status === 1060);
    rmSync(planted);
  }

  // 2. Fresh install with the panel's default port already taken.
  const squatter = createTcp().listen(25570, '0.0.0.0');
  await new Promise((r) => squatter.once('listening', r));
  const port = 25571;
  {
    const r = await install('2-fresh', {
      open: true,
      // the new command works in the same window, and PATH keeps it for new ones
      after: [`"user path: " + (Get-Item 'HKCU:\\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')`],
    });
    squatter.close();
    check('fresh install succeeds', r.code === 0, String(r.code));
    check('exactly one elevation, for the service', count(r.transcript, 'Windows will ask for permission once') === 1);
    check('falls back to the next free port', new RegExp(`Port 25570 is taken by node \\(pid \\d+\\), so the panel will use ${port}`).test(r.transcript));
    check('settings keep the new port', JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8')).port === port);
    const link = r.transcript.match(new RegExp(`http://localhost:${port}/setup#code=([0-9A-F]{20})`));
    check('prints the setup link', !!link);
    check('setup code matches the panel', link[1] === readFileSync(join(data, 'setup-code.txt'), 'utf8').trim());
    check('reports ready', r.transcript.includes('Spawnpoint is ready.'));
    const svc = json("Get-CimInstance Win32_Service -Filter \"Name='SpawnpointSupervisor'\" | Select-Object State, StartMode, StartName");
    check('supervisor service runs at boot as its virtual account', svc.State === 'Running' && svc.StartMode === 'Auto' && svc.StartName === 'NT SERVICE\\SpawnpointSupervisor', JSON.stringify(svc));
    const task = json("$t = Get-ScheduledTask -TaskName 'Spawnpoint Panel'; [pscustomobject]@{ Trigger = $t.Triggers[0].CimClass.CimClassName; User = $t.Triggers[0].UserId; Logon = [string]$t.Principal.LogonType; Run = [string]$t.Principal.RunLevel; Limit = $t.Settings.ExecutionTimeLimit; Battery = $t.Settings.DisallowStartIfOnBatteries; Stop = $t.Settings.StopIfGoingOnBatteries; Exe = $t.Actions[0].Execute; Args = $t.Actions[0].Arguments }");
    check('panel task starts at sign-in for this user', task.Trigger === 'MSFT_TaskLogonTrigger' && task.User.toLowerCase().endsWith(user), JSON.stringify(task));
    check('panel task runs unelevated with no time limit, on battery too', task.Logon === 'Interactive' && task.Run === 'Limited' && task.Limit === 'PT0S' && task.Battery === false && task.Stop === false, JSON.stringify(task));
    check('panel task hides its console', /conhost\.exe$/i.test(task.Exe) && task.Args.startsWith('--headless '));
    const { tree, all } = taskTree();
    const lp = listener(port);
    check('the task\'s node.exe is the process on the panel port', tree.has(lp) && all.find((p) => p.ProcessId === lp)?.Name === 'node.exe');
    check('the panel runs as the user, not elevated', owner(lp) === user);
    check('panel answers /api/health', await health(port));
    check('firewall rule for servers and panel on private networks', /25565-25599/.test(ps('netsh advfirewall firewall show rule name=Spawnpoint')));
    check('CLI folder is on the user PATH', /user path: .*\\AppData\\Local\\Spawnpoint\\bin/.test(r.transcript));
    check('the setup link opened in the default browser', readFileSync(join(work, '2-fresh.edge.txt'), 'utf8').includes(`localhost:${port}/setup#code=${link[1]}`));
  }

  // 3. The wizard, as the browser drives it, through to a running Fabric server.
  const base = `http://127.0.0.1:${port}/api`;
  const code = readFileSync(join(data, 'setup-code.txt'), 'utf8').trim();
  let cookie = '';
  async function api(path, body) {
    const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', cookie }, signal: AbortSignal.timeout(90_000), ...(body ? { body: JSON.stringify(body) } : {}) });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const result = await res.json();
    assert.ok(res.ok, `${path}: ${res.status} ${JSON.stringify(result)}`);
    return result;
  }
  const status = await api('/wizard/status');
  check('wizard sees the installed supervisor', status.active && status.supervisor === true, JSON.stringify(status));
  await api('/wizard/standalone', { code });
  await api('/wizard/finish', { code, pin: '814207' });
  check('PIN set and signed in', !!cookie);
  const { jobId } = await api('/servers/create', { loader: 'fabric', mc: '1.21.1', name: 'Windows Fabric', memGb: 2 });
  let last = '';
  const job = await until(async () => {
    const j = await api(`/create-jobs/${jobId}`);
    if (j.status !== last) console.log('create:', (last = j.status));
    if (j.error) throw Object.assign(new Error(j.error), { fatal: true });
    return j.done && j.serverId ? j : null;
  }, 'Fabric server creation did not finish', 20 * 60_000, 3000);
  const id = job.serverId;
  check('Fabric 1.21.1 server created', !!id);
  const gamePort = Number(readFileSync(join(root, 'Servers', id, 'server.properties'), 'utf8').match(/^server-port=(\d+)/m)[1]);
  console.log('starting the server on port', gamePort);
  await until(async () => {
    try { console.log('start:', JSON.stringify(await api(`/servers/${id}/action`, { action: 'start' }))); return true; }
    catch (e) { console.log('start refused:', e.message); throw e; }
  }, 'start refused', 5 * 60_000, 5000);
  console.log('waiting for a server list ping');
  let polls = 0;
  const pong = await until(async () => {
    if (++polls % 5 === 0) console.log('server stats:', JSON.stringify(await api(`/servers/${id}/stats`).catch((e) => e.message)));
    return ping(gamePort);
  }, 'Fabric server never answered a server list ping', 10 * 60_000, 3000);
  check('Fabric server answers players', pong.version?.name?.includes('1.21.1'), JSON.stringify(pong.version));
  const javaPid = listener(gamePort);
  check('Java runs as the supervisor\'s account, not the user', owner(javaPid) === 'SpawnpointSupervisor', owner(javaPid));

  // 4. Rerun as an update from PowerShell 7: no elevation, the server keeps
  // running, and the panel restarts on the new build.
  {
    const oldPanel = listener(port);
    const r = await install('3-update', { shell: 'pwsh.exe', after: ['"cli: " + ((spawnpoint status 2>&1) -join " | ")', '"cli exit: $LASTEXITCODE"'] });
    check('update succeeds', r.code === 0, String(r.code));
    check('update ran in PowerShell 7', /powershell: 7\./.test(r.transcript));
    check('update leaves the running supervisor alone', r.transcript.includes('Server supervisor already running'));
    check('update needs no elevation', count(r.transcript, 'Windows will ask for permission') === 0);
    check('update offers the panel, not the wizard', new RegExp(`Open your panel:\\s+http://localhost:${port}\\s`).test(r.transcript));
    const newPanel = listener(port);
    check('panel restarted as a new process', newPanel && newPanel !== oldPanel, `${oldPanel} -> ${newPanel}`);
    check('the spawnpoint command works from PATH', /cli exit: 0/.test(r.transcript) && r.transcript.includes('Windows Fabric'), r.transcript.match(/cli: .*/)?.[0]);
    check('Minecraft kept running through the update', listener(gamePort) === javaPid && !!(await ping(gamePort)));
  }

  // 5. Sign out: the panel stops with the session, Minecraft keeps running.
  // Sign in: the task's logon trigger brings the panel back.
  {
    await signOut();
    await until(async () => !(await health(port)), 'panel outlived the sign-out', 60_000);
    check('servers keep running while nobody is signed in', listener(gamePort) === javaPid && !!(await ping(gamePort)));
    await signIn();
    await until(() => health(port), 'panel did not start at sign-in', 120_000, 2000);
    check('signing in starts the panel from the task', taskTree().tree.has(listener(port)));
    // the task's console stays hidden: no console window on the desktop
    const windows = json(`Get-Process -IncludeUserName | Where-Object { $_.UserName -like '*\\${user}' -and $_.MainWindowHandle -ne 0 } | Select-Object ProcessName, MainWindowTitle`);
    console.log('windows after sign-in:', JSON.stringify(windows));
    check('no panel window after sign-in', ![windows].flat().some((w) => /conhost|powershell|node|WindowsTerminal/i.test(w?.ProcessName ?? '')));
  }
  await api(`/servers/${id}/action`, { action: 'stop' }).catch(() => {});
  await until(async () => { try { await ping(gamePort); return false; } catch { return true; } }, 'server did not stop', 120_000);
} catch (error) {
  failure = error;
  console.error(error);
  try { console.error('server log:', readFileSync(join(root, 'Servers', readdirSync(join(root, 'Servers'))[0], 'logs', 'latest.log'), 'utf8').split('\n').slice(-60).join('\n')); } catch { /* no server yet */ }
  const installs = join(data, 'runtime', 'installs');
  const installLogs = existsSync(installs) ? readdirSync(installs).filter((f) => f.endsWith('.log')).map((f) => join(installs, f)) : [];
  for (const f of [join(data, 'panel.log'), join(data, 'runtime/service.log'), ...installLogs]) {
    if (existsSync(f)) console.error(`----- ${f} -----\n${readFileSync(f, 'utf8').split('\n').slice(-80).join('\n')}`);
  }
  try {
    console.error(ps(`Get-ChildItem '${home}\\AppData\\Local\\Temp' -Filter 'spawnpoint-install-*.log' -ErrorAction SilentlyContinue | ForEach-Object { '----- ' + $_.FullName; Get-Content $_.FullName -Tail 60 }`));
  } catch { /* nothing to show */ }
} finally {
  web.close();
  // Leave nothing installed: the task, the service, the firewall rule, the account and the layout.
  try {
    if (sessionId()) await signOut();
    ps(`Unregister-ScheduledTask -TaskName 'Spawnpoint Panel' -Confirm:$false -ErrorAction SilentlyContinue
Stop-Service SpawnpointSupervisor -ErrorAction SilentlyContinue
netsh advfirewall firewall delete rule name=Spawnpoint | Out-Null
sc.exe delete SpawnpointSupervisor | Out-Null
cmdkey /delete:TERMSRV/127.0.0.2 | Out-Null
Remove-LocalUser -Name ${user} -ErrorAction SilentlyContinue
Get-CimInstance Win32_UserProfile | Where-Object { $_.LocalPath -eq '${home}' } | Remove-CimInstance -ErrorAction SilentlyContinue
exit 0`);
    // git objects are read-only, which rmSync can't remove on Windows
    // the service's files belong to its account, and git objects are read-only
    ps(`foreach ($d in '${work}', '${root}', '${pyBase}') { if (Test-Path -LiteralPath $d) {
  takeown.exe /f $d /r /d y | Out-Null; icacls.exe $d /reset /T /Q | Out-Null
  Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue } }
exit 0`);
  } catch (cleanupError) { console.error('Cleanup failure:', cleanupError); }
}
if (failure) process.exit(1);
console.log(`windows installer: ${checks} checks passed`);
process.exit(0);
