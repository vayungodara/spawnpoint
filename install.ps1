# Spawnpoint installer for Windows: one command from a fresh PC to the
# first-run wizard. Run it in a normal PowerShell window (not as administrator):
#   irm https://raw.githubusercontent.com/vayungodara/spawnpoint/main/install.ps1 | iex
# Re-runnable: an existing checkout and layout are updated, never clobbered.
# Env overrides: SPAWNPOINT_ROOT (layout folder), SPAWNPOINT_DIR (checkout
# folder, Crafty mode only), SPAWNPOINT_RUNTIME=crafty (keep an existing Crafty service),
# SPAWNPOINT_NO_OPEN=1 (don't open a browser), SPAWNPOINT_WINGET=1 or 0
# (install missing tools with winget without asking, or never), NO_COLOR=1.
# Written for Windows PowerShell 5.1 and PowerShell 7. It runs as a script
# block, so no execution policy applies to it, and it never calls `exit`,
# which would close the window it was pasted into. Children get
# -EncodedCommand or cmd.exe for the same reason. Non-ASCII glyphs are built
# from code points because a saved copy may be read as ANSI by 5.1.

try { & {
$ProgressPreference = 'SilentlyContinue'
$PanelStopped = $false
$Clock = [Diagnostics.Stopwatch]::StartNew()
# cmd.exe would expand %NAME% in a path; a Temp path with % falls back to Windows' Temp.
$TempDir = [IO.Path]::GetTempPath(); if ($TempDir -match '%') { $TempDir = "$env:SystemRoot\Temp" }
$Log = Join-Path $TempDir ('spawnpoint-install-' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.log')
$Cmd = "$env:SystemRoot\System32\cmd.exe"
$Sys32 = "$env:SystemRoot\System32"
[IO.File]::WriteAllText($Log, '')
$global:LASTEXITCODE = 0

# ---- look ------------------------------------------------------------------
$Tty = -not [Console]::IsOutputRedirected
$Color = $Tty -and -not $env:NO_COLOR
# Windows Terminal, the default on Windows 11, and VS Code have fonts with
# these glyphs; Windows 10's console font has no tick or braille. A window
# Windows hands over to Terminal doesn't set WT_SESSION, hence the build check.
$U = [bool]($env:WT_SESSION -or $env:TERM_PROGRAM -eq 'vscode' -or [Environment]::OSVersion.Version.Build -ge 22000)
function C([int[]]$codes) { -join ($codes | ForEach-Object { [char]$_ }) }
if ($U) { $OK = C 0x2713; $NO = C 0x2717; $DOT = C 0x25C6; $Frames = 0x280B, 0x2819, 0x2839, 0x2838, 0x283C, 0x2834, 0x2826, 0x2827, 0x2807, 0x280F | ForEach-Object { [string][char]$_ } }
else { $OK = 'ok'; $NO = 'x'; $DOT = '*'; $Frames = '-', '\', '|', '/' }

function Out-Part([string]$text, [string]$color) {
  if ($Color -and $color) { Write-Host $text -NoNewline -ForegroundColor $color } else { Write-Host $text -NoNewline }
}
function Took([double]$s) { $s = [int][Math]::Floor($s); if ($s -ge 60) { '{0}m {1:00}s' -f [int][Math]::Floor($s / 60), ($s % 60) } else { "${s}s" } }
function Head([string]$t) { Write-Host ''; Out-Part $DOT Green; Out-Part " $t" White; Write-Host '' }
function Ok([string]$t, [string]$dim) { Out-Part "  $OK" Green; Out-Part " $t"; if ($dim) { Out-Part " $dim" DarkGray }; Write-Host '' }
function Note([string]$t) { Out-Part '  !' Yellow; Write-Host " $t" }
function Say([string]$t) { Write-Host "    $t" }
function Fix([string]$t) { Out-Part "    $t" Cyan; Write-Host '' }
function Fail([string]$t, [string[]]$more) {
  Write-Host ''; Out-Part "  $NO" Red; Out-Part " $t" White; Write-Host ''
  foreach ($line in $more) { Write-Host "    $line" }
  # an update that stopped the panel and then failed restarts what is there
  if ($PanelStopped) { Start-ScheduledTask -TaskName 'Spawnpoint Panel' -ErrorAction SilentlyContinue }
  Write-Host ''; Out-Part '    Fix that, then run the same install command again. It picks up where it stopped.' DarkGray; Write-Host ''; Write-Host ''
  throw 'spawnpoint-abort'
}
function Add-Log([string]$t) { [IO.File]::AppendAllText($Log, "$t`r`n") }
function Show-Tail { Get-Content -LiteralPath $Log -Tail 12 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "      $_" } }

function Spin([string]$label, [Diagnostics.Stopwatch]$t, [int]$i) {
  if ($Tty) { Out-Part ("`r  " + $Frames[$i % $Frames.Count]) Green; Out-Part " $label "; Out-Part (Took $t.Elapsed.TotalSeconds) DarkGray; Out-Part ' ' }
}
function Clear-Spin([string]$label) { if ($Tty) { Write-Host ("`r" + (' ' * ($label.Length + 16)) + "`r") -NoNewline } }
# Wait for $proc with a spinner, then print a tick and the time it took.
function Wait-Step([string]$label, $proc, [Diagnostics.Stopwatch]$t) {
  $i = 0
  while (-not $proc.HasExited) { Spin $label $t $i; $i++; Start-Sleep -Milliseconds 100 }
  $proc.WaitForExit()
  Clear-Spin $label
  $proc.ExitCode
}
function Step-Done([string]$label, [Diagnostics.Stopwatch]$t) { Out-Part "  $OK" Green; Out-Part " $label "; Out-Part (Took $t.Elapsed.TotalSeconds) DarkGray; Write-Host '' }
function Step-Failed([string]$label) { Out-Part "  $NO" Red; Write-Host " $label"; Show-Tail }

# Run one program with its output appended to the log. cmd.exe does the
# redirection so stderr can't turn into PowerShell errors, and npm runs as
# npm.cmd, never the npm.ps1 that a Restricted execution policy blocks.
function Q([string]$s) { '"' + $s + '"' }
function Run([string]$label, [string]$exe, [string]$argline) {
  $t = [Diagnostics.Stopwatch]::StartNew()
  Add-Log "`r`n== $label"
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $Cmd
  $psi.Arguments = '/d /v:off /s /c "' + (Q $exe) + ' ' + $argline + ' >>' + (Q $Log) + ' 2>&1 <nul"'
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.WorkingDirectory = (Get-Location).ProviderPath
  $code = Wait-Step $label ([Diagnostics.Process]::Start($psi)) $t
  if ($code -ne 0) { Step-Failed $label; return $false }
  Step-Done $label $t
  $true
}

# ---- banner ----------------------------------------------------------------
Write-Host ''
if ($U) {
  Out-Part ('  ' + (C 0x2590, 0x2580, 0x2580, 0x2580, 0x2584)) Green; Write-Host ''
  Out-Part ('  ' + (C 0x2590, 0x2580, 0x2580, 0x2580)) Green; Out-Part '   SPAWNPOINT' White; Write-Host ''
  Out-Part ('  ' + (C 0x2590)) DarkGray; Out-Part '      a Minecraft server your friends can join' DarkGray; Write-Host ''
} else {
  Out-Part '  SPAWNPOINT' White; Write-Host ''
  Out-Part '  a Minecraft server your friends can join' DarkGray; Write-Host ''
}

# ---- this machine ----------------------------------------------------------
Head 'Checking this machine'
if ([Environment]::OSVersion.Platform -ne 'Win32NT') { Fail 'This installer is for Windows.' @('On Linux and macOS, use install.sh from the README.') }
# conhost --headless, which hides the panel's console, arrived in Windows 10 1809.
if ([Environment]::OSVersion.Version.Build -lt 17763) { Fail 'Spawnpoint needs Windows 10 (version 1809) or newer.' }

$Me = [Security.Principal.WindowsIdentity]::GetCurrent()
$Sid = $Me.User.Value
$Elevated = ([Security.Principal.WindowsPrincipal]$Me).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($Elevated -and $env:SPAWNPOINT_RUNTIME -ne 'crafty') {
  $lua = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction SilentlyContinue).EnableLUA
  if ($lua -eq 0) {
    Fail 'User Account Control is off, so everything here runs as administrator.' @(
      'Minecraft servers and their mods shouldn''t run with full control of this PC.',
      'Sign in with a standard account (or turn User Account Control back on), then run the install command there.')
  }
  Fail 'Please don''t run this as administrator.' @(
    'Minecraft servers and their mods shouldn''t run with full control of this PC.',
    'Open PowerShell from the Start menu the normal way (not "Run as administrator") and run the same command.',
    'Spawnpoint asks Windows for permission once, by itself, to install its service.')
}

# Tools installed after this window opened aren't on its PATH yet.
function Update-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine'); $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}
# The supervisor service runs as its own account, which can't read anything
# inside your user folder, so Python and Node must be installed for all users.
$Profile_ = [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\') + '\'
function In-Profile([string]$path) { $path -and $path.StartsWith($Profile_, [StringComparison]::OrdinalIgnoreCase) }
function Find-Exe([string]$name) {
  # skip the Microsoft Store's python.exe stub, which opens the Store instead
  Get-Command $name -CommandType Application -ErrorAction SilentlyContinue |
    Where-Object { $_.Source -notlike '*\WindowsApps\*' } | Select-Object -First 1 -ExpandProperty Source
}
$Want = @{
  node   = 'winget install -e --id OpenJS.NodeJS.LTS'
  git    = 'winget install -e --id Git.Git'
  python = 'winget install -e --id Python.Python.3.13 --scope machine --override "/quiet InstallAllUsers=1 PrependPath=1"'
}

function Check-Tools {
  $script:Missing = New-Object Collections.ArrayList
  $script:Python = Find-Exe python; $script:NodeExe = Find-Exe node; $script:GitExe = Find-Exe git
  $script:PyReal = $null
  if ($Python) {
    # no double quotes in -c: Windows PowerShell 5.1 doesn't escape them for programs
    $info = @(& $Python -c 'import os, sys; print(''.''.join(map(str, sys.version_info[:3]))); print(sys.version_info >= (3, 9)); print(os.path.realpath(sys.executable))' 2>$null)
    if ($info.Count -ge 3 -and $info[1] -eq 'True' -and -not (In-Profile $info[2])) { $script:PyReal = $info[2]; Ok "Python $($info[0])" }
    elseif ($info.Count -ge 3 -and $info[1] -eq 'True') { Note "Python $($info[0]) is installed just for you, in $(Split-Path $info[2])"; Say 'The server supervisor runs as its own account and needs Python installed for all users.'; [void]$Missing.Add('python') }
    elseif ($info.Count -ge 1 -and $info[0]) { Note "Python $($info[0]) is too old. Spawnpoint needs 3.9 or newer."; [void]$Missing.Add('python') }
    else { [void]$Missing.Add('python') }
  } else { [void]$Missing.Add('python') }
  if ($NodeExe) {
    $v = (& $NodeExe -v 2>$null | Select-Object -First 1)
    $major = 0; if ("$v" -match '^v(\d+)') { $major = [int]$Matches[1] }
    # nvm-windows links Program Files\nodejs into your user folder
    $real = $NodeExe; if ($PyReal) { $real = (& $Python -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' $NodeExe 2>$null | Select-Object -First 1) }
    if ($major -lt 22) { Note "Node.js $("$v".TrimStart('v')) is too old. Spawnpoint needs version 22 or newer."; [void]$Missing.Add('node') }
    elseif (In-Profile $real) { Note "Node.js $("$v".TrimStart('v')) is installed just for you, in $(Split-Path $real)"; Say 'The server supervisor needs Node.js installed for all users.'; [void]$Missing.Add('node') }
    elseif (-not (Find-Exe npm)) { Note 'npm is missing from this Node.js install.'; [void]$Missing.Add('node') }
    else { $script:NodeExe = $real; Ok "Node.js $("$v".TrimStart('v'))" }
  } else { [void]$Missing.Add('node') }
  if ($GitExe) { Ok 'git' } else { [void]$Missing.Add('git') }
}
Check-Tools

if ($Missing.Count -gt 0) {
  $names = @{ node = 'Node.js 22+'; git = 'git'; python = 'Python 3.9+ (for all users)' }
  Note ('Missing: ' + (($Missing | ForEach-Object { $names[$_] }) -join ', '))
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) { foreach ($m in $Missing) { Fix $Want[$m] } }
  else {
    Say 'Install them from these pages (choose "for all users" where asked):'
    $pages = @{ node = 'https://nodejs.org/en/download'; git = 'https://git-scm.com/download/win'; python = 'https://www.python.org/downloads/windows/' }
    foreach ($m in $Missing) { Fix $pages[$m] }
  }
  $ask = $winget -and $env:SPAWNPOINT_WINGET -ne '0' -and ($env:SPAWNPOINT_WINGET -eq '1' -or (-not [Console]::IsInputRedirected -and [Environment]::UserInteractive))
  $yes = $env:SPAWNPOINT_WINGET -eq '1'
  if ($ask -and -not $yes) {
    Write-Host ''
    $answer = Read-Host '  Install them now with winget? Windows asks for permission once [Y/n]'
    $yes = $answer -match '^\s*(y|yes)?\s*$'
  }
  if (-not $yes) {
    Write-Host ''; Out-Part '  Almost there.' White; Write-Host ' Install those, open a new PowerShell window, then run the same install command again.'; Write-Host ''
    $global:LASTEXITCODE = 1; return
  }
  # One elevated window installs everything, so Windows asks once.
  $lines = foreach ($m in $Missing) { $Want[$m] + ' --accept-source-agreements --accept-package-agreements --disable-interactivity' }
  $script = '$ErrorActionPreference = ''Continue''; ' + (($lines | ForEach-Object { "& $_" }) -join '; ') + '; Start-Sleep 2'
  $t = [Diagnostics.Stopwatch]::StartNew()
  try {
    $p = Start-Process powershell.exe -Verb RunAs -PassThru -ArgumentList ('-NoProfile -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script)))
  } catch { Fail 'Windows didn''t give permission to install the tools.' @('Run the install command again and choose Yes, or install them yourself with the commands above.') }
  $null = Wait-Step 'Installing the missing tools with winget' $p $t
  Update-Path
  Step-Done 'Installing the missing tools with winget' $t
  Check-Tools
  if ($Missing.Count -gt 0) { Fail 'Some tools still aren''t ready.' @('Install them with the commands above, open a new PowerShell window, then run the install command again.') }
}

if ("$PyReal$NodeExe" -match '%') { Fail "Python or Node.js is installed in a folder with % in its name." @($PyReal, $NodeExe, 'The command prompt would misread it. Reinstall it in a plain folder.') }

# Memory: a modded server wants 4 GB of heap and the mod test boots a second copy.
$MemGb = [int][Math]::Floor((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
if ($MemGb -lt 3) { Note "$MemGb GB of memory. Vanilla works; modded servers need about 4 GB." }
elseif ($MemGb -lt 6) { Ok "$MemGb GB of memory" '(fine for a small modded server)' }
else { Ok "$MemGb GB of memory" }

# ---- layout ----------------------------------------------------------------
# Everything Spawnpoint manages lives here: servers, Shared, Tools (Java
# downloads itself into it), Backups and the panel's own data. The default
# is the folder the panel itself assumes on Windows. It can't be in your user
# folder (or OneDrive): Java resolves real paths by listing every parent
# folder, and the supervisor's account can't list yours. Java launch files split on spaces.
# It sits directly on a local drive, so no folder above it can be swapped for
# a link by another account between these checks and the elevated step.
$Plain = '^[A-Za-z]:\\[A-Za-z0-9_.-]+$'
$Runtime = if ($env:SPAWNPOINT_RUNTIME) { $env:SPAWNPOINT_RUNTIME } else { 'standalone' }
if ($Runtime -ne 'standalone' -and $Runtime -ne 'crafty') { Fail 'SPAWNPOINT_RUNTIME must be standalone or crafty.' }
$Root = if ($env:SPAWNPOINT_ROOT) { [IO.Path]::GetFullPath($env:SPAWNPOINT_ROOT).TrimEnd('\') } else { $env:SystemDrive + '\MinecraftServers' }
if ($Root -notmatch $Plain) {
  Fail "The layout folder has to be a plain folder directly on a drive: $Root" @(
    'No spaces or special characters (Java launch files split on them), and no folders above it. For example:', '  $env:SPAWNPOINT_ROOT = ''D:\MinecraftServers''')
}
if ((New-Object IO.DriveInfo ($Root.Substring(0, 1))).DriveType -ne 'Fixed') { Fail "The layout folder has to be on a local drive: $Root" @('Network and removable drives can disappear while servers run.') }

# an existing Crafty connection keeps its backend
if (-not $env:SPAWNPOINT_RUNTIME -and (Test-Path -LiteralPath "$Root\Shared\crafty-token.txt")) { $Runtime = 'crafty' }
# The elevated step runs code from the checkout, so nobody but you, the system
# and administrators may be able to change the layout or the checkout.
# write data, append, attributes, delete, delete children, permissions, owner, generic write/all
$WriteMask = 0x500D0156
function Get-OtherWriters([string]$path, [int]$mask = $WriteMask, [switch]$NoServices) {
  $acl = Get-Acl -LiteralPath $path
  # you, SYSTEM, Administrators, CREATOR OWNER, TrustedInstaller
  $ok = @($Sid, 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-0', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  # S-1-5-80: service accounts and TrustedInstaller. The supervisor's is one
  # of them, and Minecraft mods run as it, so elevated inputs don't trust them.
  $trusted = { param($s) ($ok -contains $s) -or (-not $NoServices -and $s -like 'S-1-5-80-*') }
  $who = foreach ($a in $acl.Access) {
    if ($a.AccessControlType -ne 'Allow' -or ([int]$a.FileSystemRights -band $mask) -eq 0) { continue }
    if ($a.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { continue } # applies to children only
    $s = try { $a.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { "$($a.IdentityReference)" }
    if (-not (& $trusted $s)) { "$($a.IdentityReference)" }
  }
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if (-not (& $trusted $owner)) { $who = @($who) + "owner $owner" }
  @($who | Select-Object -Unique)
}
# Whoever may delete children of the drive root, or change its permissions,
# could swap the layout folder for another. Windows' defaults don't allow that.
$Drive = $Root.Substring(0, 3)
$driveOthers = Get-OtherWriters $Drive (0x40 -bor 0x40000 -bor 0x80000 -bor 0x10000000)
if ($driveOthers.Count) {
  Fail "Other accounts on this PC can rename or delete folders on $Drive" @(($driveOthers -join ', '), 'Pick a layout on a drive with the standard permissions, with $env:SPAWNPOINT_ROOT.')
}
# A new layout is created private in one step: created first and fixed after,
# it would briefly inherit "Authenticated Users: Modify" from the drive root.
if (-not (Test-Path -LiteralPath $Root)) {
  $sec = New-Object Security.AccessControl.DirectorySecurity
  $sec.SetAccessRuleProtection($true, $false)
  foreach ($who in $Sid, 'S-1-5-18', 'S-1-5-32-544') {
    $sec.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule ((New-Object Security.Principal.SecurityIdentifier $who), 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
  }
  $sec.SetOwner((New-Object Security.Principal.SecurityIdentifier $Sid))
  $di = New-Object IO.DirectoryInfo $Root
  try { if ($PSVersionTable.PSEdition -eq 'Core') { [IO.FileSystemAclExtensions]::Create($di, $sec) } else { $di.Create($sec) } }
  catch { Fail "Can't create $Root." @('Pick a folder you can write to with $env:SPAWNPOINT_ROOT = ''D:\SomeFolder''.') }
}
if ((Get-Item -LiteralPath $Root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail "The layout folder is a link to somewhere else: $Root" @('Point $env:SPAWNPOINT_ROOT at the real folder.') }
# An existing folder others could change is refused, never adopted: fixing it
# now couldn't vouch for what they may already have put inside.
$others = Get-OtherWriters $Root
if ($others.Count) {
  Fail "Other accounts on this PC can change $Root." @(($others -join ', '),
    'Spawnpoint runs code from it as administrator once, so it must be yours alone.',
    'Pick a new folder with $env:SPAWNPOINT_ROOT = ''D:\MinecraftServers''.')
}
try { foreach ($d in 'Crafty\servers', 'Shared', 'Tools', 'Backups') { New-Item -ItemType Directory -Force -Path (Join-Path $Root $d) -ErrorAction Stop | Out-Null } }
catch { Fail "Can't create folders in $Root." }
$FreeGb = [int][Math]::Floor((New-Object IO.DriveInfo ($Root.Substring(0, 1))).AvailableFreeSpace / 1GB)
if ($FreeGb -lt 5) { Note "Only $FreeGb GB free on $($Root.Substring(0, 2)). Worlds and backups grow; 10 GB is comfortable." }

# ---- running panel ---------------------------------------------------------
# An update first asks the running panel to exit, before any file in the
# checkout changes: a panel that refuses keeps exactly the bytes it runs.
$Data = "$Root\Spawnpoint\data"
# The panel runs as you, from a scheduled task at sign-in. A task needs no
# administrator rights to create or update, restarts the panel if it exits,
# and conhost --headless keeps its console window out of the way.
$Settings = "$Data\settings.json"
$Port = 25570
try { $j = [IO.File]::ReadAllText($Settings).TrimStart([char]0xFEFF) | ConvertFrom-Json; if ($j.port) { $Port = [int]$j.port } } catch { }
$PanelLog = "$Data\panel.log"
$PidFile = "$Data\panel-task.pid"
$Task = 'Spawnpoint Panel'

function Get-Health([int]$port) {
  try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$port/api/health").Content -match '"name":"spawnpoint"' } catch { $false }
}
function Test-Listening([int]$port) {
  $c = New-Object Net.Sockets.TcpClient
  try { $c.ConnectAsync('127.0.0.1', $port).Wait(500) -and $c.Connected } catch { $false } finally { $c.Close() }
}
function Get-Listener([int]$port) {
  Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess
}
function Who-Listens([int]$port) {
  $id = Get-Listener $port
  if ($id) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p) { "$($p.ProcessName) (pid $id)" } }
}
# The task's wrapper records its PID; the panel is the node.exe under it.
function Get-TaskTree {
  $root = 0; try { $root = [int]([IO.File]::ReadAllText($PidFile).Trim()) } catch { }
  if (-not $root) { return @() }
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name
  # a reused PID would be a younger process than the file it supposedly wrote
  $wrapper = Get-CimInstance Win32_Process -Filter "ProcessId=$root" -ErrorAction SilentlyContinue
  $written = (Get-Item -LiteralPath $PidFile).LastWriteTime
  if (-not $wrapper -or $wrapper.Name -ne 'powershell.exe' -or $wrapper.CreationDate -gt $written -or $wrapper.CreationDate -lt $written.AddMinutes(-2)) { return @() }
  if ((Invoke-CimMethod -InputObject $wrapper -MethodName GetOwnerSid).Sid -ne $Sid) { return @() }
  $tree = @($root); $grew = $true
  while ($grew) {
    $grew = $false
    foreach ($p in $all) { if ($tree -contains $p.ParentProcessId -and -not ($tree -contains $p.ProcessId)) { $tree += $p.ProcessId; $grew = $true } }
  }
  $tree
}
# The panel counts as ours only when our task runs it and that process is the
# one on the port; a leftover task proves nothing.
$Ours = 0
$TaskState = (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue).State
$TaskRunning = "$TaskState" -eq 'Running'
$Tree = @(); if ($TaskRunning) { $Tree = @(Get-TaskTree) }
$PanelPid = 0
if ($Tree.Count) {
  $lpid = Get-Listener $Port
  if ($lpid -and ($Tree -contains $lpid)) { $Ours = 1; $PanelPid = [int]$lpid }
  elseif (-not $lpid -and -not (Test-Listening $Port)) { $Ours = 2 } # up but not on the port yet (recovering, or crash-looping)
}
if ($Ours -eq 1 -and (Get-Health $Port)) {
  # Ask first: the panel refuses to exit mid-wish, mid-create or mid-mod-test.
  $answer = ''
  try {
    $token = [IO.File]::ReadAllText("$Data\admin-token").Trim()
    $answer = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Method Post -ContentType 'application/json' -Body '{}' -Headers @{ authorization = "Bearer $token" } "http://127.0.0.1:$Port/api/admin/exit").Content
  } catch { $answer = "$($_.ErrorDetails.Message)" }
  if ($answer -notmatch '"ok":true') {
    Write-Host ''; Out-Part '  !' Yellow; Write-Host ' The running panel didn''t agree to restart, so the new build waits.'
    if ($answer -match 'mid-work') { Say 'It''s in the middle of something. Run this again in a few minutes; nothing was interrupted.' }
    else { Say "Nothing was interrupted. Its log: $PanelLog" }
    $global:LASTEXITCODE = 0; return
  }
  # Keep the task from restarting the old process, then wait for it to go.
  Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
  $PanelStopped = $true
  $gone = $false
  for ($i = 0; $i -lt 60; $i++) { if (-not (Get-Process -Id $PanelPid -ErrorAction SilentlyContinue)) { $gone = $true; break }; Start-Sleep -Milliseconds 500 }
  if (-not $gone) { Fail "The old panel (pid $PanelPid) didn't exit." @("Its log: $PanelLog") }
} elseif ($TaskRunning) {
  # Running but not answering, or not provably the panel on this port: it may
  # be recovering an interrupted change, so never rebuild beneath it.
  Write-Host ''; Out-Part '  !' Yellow; Write-Host ' The panel task is running but not answering yet, so the new build waits.'
  Say "Give it a minute and run this again; nothing was interrupted. Its log: $PanelLog"
  Say "If it stays stuck: Stop-ScheduledTask -TaskName '$Task'"
  $global:LASTEXITCODE = 0; return
}
if (-not $PanelStopped -and (Get-Health $Port)) {
  Write-Host ''; Out-Part '  !' Yellow; Write-Host " A Spawnpoint panel you started by hand is already running on port $Port."
  Say 'Nothing was changed. Stop that panel and run this again to switch it to a sign-in task.'
  $global:LASTEXITCODE = 0; return
}

# ---- code ------------------------------------------------------------------
Head "Installing Spawnpoint into $Root"
$Here = Join-Path (Get-Location).ProviderPath 'package.json'
$InPlace = (Test-Path -LiteralPath $Here) -and ((Get-Content -LiteralPath $Here -Raw -ErrorAction SilentlyContinue) -match '"name":\s*"spawnpoint"')
$Dir = if ($InPlace) { (Get-Location).ProviderPath } elseif ($env:SPAWNPOINT_DIR) { [IO.Path]::GetFullPath($env:SPAWNPOINT_DIR).TrimEnd('\') } else { "$Root\Spawnpoint" }
if ($Dir -match '[%"]') { Fail "The checkout folder can't contain % or quotes: $Dir" }
if ((Test-Path -LiteralPath $Dir) -and ((Get-Item -LiteralPath $Dir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  Fail "The checkout folder is a link to somewhere else: $Dir" @('Use the real folder.')
}
# The supervisor's account runs scripts from the checkout and can read only the
# layout, which this installer has also made yours alone. A fixed place, with
# no folder in between that could be a link, keeps the elevated step's code there.
if ($Runtime -eq 'standalone' -and $Dir -ne "$Root\Spawnpoint") {
  Fail "The checkout has to be $Root\Spawnpoint, not $Dir" @(
    'The server supervisor runs as its own account, which can only read the layout.',
    'Run the install command from another folder to use the standard checkout.')
}
if ($InPlace) {
  if (-not (Run 'Updating the checkout here' $GitExe 'pull --ff-only')) { Note "Couldn't fast-forward this checkout; building what's here." }
} elseif (Test-Path -LiteralPath "$Dir\.git") {
  if (-not (Run 'Updating Spawnpoint' $GitExe ('-C ' + (Q $Dir) + ' pull --ff-only'))) { Note "Couldn't fast-forward $Dir; building what's there." }
} else {
  if (-not (Run 'Downloading Spawnpoint' $GitExe ('clone --depth 1 https://github.com/vayungodara/spawnpoint ' + (Q $Dir)))) {
    Fail "Couldn't download Spawnpoint from GitHub." @('Check this PC''s internet connection.')
  }
}
Set-Location -LiteralPath $Dir
New-Item -ItemType Directory -Force -Path $Data | Out-Null
$Npm = Join-Path (Split-Path $NodeExe) 'npm.cmd'
if (-not (Test-Path -LiteralPath $Npm)) { $Npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source) }
if (-not (Run 'Installing dependencies' $Npm 'ci --no-audit --no-fund')) { Fail 'npm couldn''t install the dependencies.' @("The full log is in $Log.") }
if (-not (Run 'Building the panel' $Npm 'run build')) { Fail 'The build failed.' @("The full log is in $Log.") }

# `spawnpoint` for terminals and coding agents. On this PC it reads the admin
# token from the layout, so it needs no login.
$Bin = Join-Path $env:LOCALAPPDATA 'Spawnpoint\bin'
try {
  New-Item -ItemType Directory -Force -Path $Bin | Out-Null
  [IO.File]::WriteAllText("$Bin\spawnpoint.cmd", "@echo off`r`n" + (Q $NodeExe) + ' ' + (Q "$Dir\cli\spawnpoint.mjs") + " %*`r`n")
  $cfgDir = Join-Path $env:APPDATA 'spawnpoint'
  New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
  $cfg = [ordered]@{}
  if (Test-Path -LiteralPath "$cfgDir\cli.json") {
    try { ([IO.File]::ReadAllText("$cfgDir\cli.json") | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $cfg[$_.Name] = $_.Value } } catch { }
  }
  $cfg['root'] = $Root
  [IO.File]::WriteAllText("$cfgDir\cli.json", ($cfg | ConvertTo-Json))
  # Add it to your PATH once, keeping %VARIABLES% in the existing entries.
  $envKey = Get-Item 'HKCU:\Environment'
  $userPath = [string]$envKey.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
  if (-not (($userPath -split ';') -contains $Bin)) {
    Set-ItemProperty 'HKCU:\Environment' -Name Path -Type ExpandString -Value ((@($userPath.TrimEnd(';'), $Bin) | Where-Object { $_ }) -join ';')
    # tell Explorer, so new windows see it without signing out
    Add-Type -Namespace Spawnpoint -Name Env -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);'
    $r = [UIntPtr]::Zero; [void][Spawnpoint.Env]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 2000, [ref]$r)
  }
  if (-not (($env:Path -split ';') -contains $Bin)) { $env:Path = "$env:Path;$Bin" }
} catch { Add-Log "CLI setup: $_" }

# ---- supervisor ------------------------------------------------------------
# The SCM service is the only step that needs administrator rights. A running
# one is left alone: restarting it would stop your servers.
$Service = 'SpawnpointSupervisor'
$Svc = Get-CimInstance Win32_Service -Filter "Name='$Service'" -ErrorAction SilentlyContinue
function Elevate([string]$label, [string]$cmdline) {
  Say 'Windows will ask for permission once, to install the server supervisor as a service.'
  Add-Log "`r`n== $label (elevated)"
  $t = [Diagnostics.Stopwatch]::StartNew()
  try {
    $p = Start-Process $Cmd -Verb RunAs -WindowStyle Hidden -PassThru -WorkingDirectory $Sys32 -ArgumentList ('/d /v:off /s /c "' + $cmdline + '"')
  } catch {
    Fail 'Windows didn''t give permission to install the supervisor.' @(
      'Spawnpoint needs it once, to run your servers as a service that starts with Windows.',
      'Run the install command again and choose Yes.')
  }
  $code = Wait-Step $label $p $t
  if ($code -ne 0) { Step-Failed $label; return $false }
  Step-Done $label $t; $true
}
if ($Runtime -eq 'standalone' -and $Svc) {
  if ($Svc.PathName -notmatch [regex]::Escape(' --root ' + $Root + ' ')) {
    Fail 'This PC''s supervisor service belongs to another layout.' @($Svc.PathName,
      'Run the installer for that layout instead, with $env:SPAWNPOINT_ROOT set to its folder.')
  }
  if ($Svc.State -eq 'Running') { Ok 'Server supervisor already running' }
  elseif (-not (Elevate 'Starting the server supervisor' ((Q "$Sys32\sc.exe") + ' start ' + $Service + ' >>' + (Q $Log) + ' 2>&1'))) {
    Fail 'The supervisor service didn''t start.' @("The full log is in $Log.", "Its own log: $Data\runtime\service.log")
  }
} elseif ($Runtime -eq 'standalone') {
  # Everything the elevated Python loads, every folder above it, and Python
  # itself must be changeable only by you, the system and administrators.
  $services = "$Dir\server\dist\services"
  $pyHome = Split-Path $PyReal
  $inputs = @($Root, $Dir, "$Dir\server", "$Dir\server\dist", $services) + @(Get-ChildItem -LiteralPath $services -Force | ForEach-Object { $_.FullName }) +
    @($pyHome) + @(Get-ChildItem -LiteralPath $pyHome -File -Force | ForEach-Object { $_.FullName })
  # The whole standard library, but not site-packages or the stdlib's own tests,
  # which -S and the script never load. A secure folder can hold an insecure file.
  foreach ($tree in 'Lib', 'DLLs' | ForEach-Object { Join-Path $pyHome $_ } | Where-Object { Test-Path -LiteralPath $_ }) {
    $inputs += $tree
    $inputs += @(Get-ChildItem -LiteralPath $tree -Recurse -Force -ErrorAction SilentlyContinue |
      Where-Object { $f = $_.FullName + '\'; -not (@('Lib\site-packages\', 'Lib\test\') | Where-Object { $f.StartsWith("$pyHome\$_", [StringComparison]::OrdinalIgnoreCase) }) } | ForEach-Object { $_.FullName })
  }
  # Nobody else may rename, delete or re-permission a folder above Python
  # either, or they could swap it for another between this check and the prompt.
  $replace = 0x10000 -bor 0x40 -bor 0x40000 -bor 0x80000 -bor 0x10000000
  for ($up = Split-Path $pyHome; $up; $up = Split-Path $up) {
    if ($up.Length -gt 3 -and ((Get-Item -LiteralPath $up -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { Fail "Python is installed under a link: $up" @('Reinstall Python for all users, for example with the winget command for Python, then run this again.') }
    $w = Get-OtherWriters $up $replace -NoServices
    if ($w.Count) { Fail "Other accounts can rename or replace $up, which holds Python." @(($w -join ', '), 'Reinstall Python for all users, for example with the winget command for Python, then run this again.') }
  }
  foreach ($path in $inputs) {
    if ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail "$path is a link." @('Delete the checkout folder and run the install command again.') }
    $w = Get-OtherWriters $path -NoServices
    if ($w.Count) {
      $how = if ($path.StartsWith($pyHome, [StringComparison]::OrdinalIgnoreCase)) { 'Reinstall Python for all users, for example with the winget command for Python, then run this again.' } else { 'Delete the checkout folder and run the install command again.' }
      Fail "Other accounts can change $path." @(($w -join ', '), 'The installer runs it as administrator once.', $how)
    }
  }
  # Friends on your home network reach servers on 25565 and up and the panel
  # on 25570; services get no firewall prompt, so allow those ports once here.
  $netsh = Q "$Sys32\netsh.exe"
  $fw = "$netsh advfirewall firewall delete rule name=Spawnpoint >nul 2>&1 & $netsh advfirewall firewall add rule name=Spawnpoint dir=in action=allow protocol=TCP localport=25565-25599 profile=private,domain >>" + (Q $Log) + ' 2>&1 & '
  # -I: no PYTHON* variables, user site-packages or script folder on the path;
  # -S: no site-packages or .pth files at all. The script needs only the stdlib.
  $py = (Q $PyReal) + ' -I -S ' + (Q "$Dir\server\dist\services\nativeservice.py") + ' install --root ' + (Q $Root) + ' --node ' + (Q $NodeExe) + ' --owner-sid ' + $Sid + ' >>' + (Q $Log) + ' 2>&1'
  if (-not (Elevate 'Starting the server supervisor' ($fw + $py))) {
    Fail 'The supervisor service didn''t start.' @("The full log is in $Log.", "Its own log: $Data\runtime\service.log")
  }
  & "$Sys32\netsh.exe" advfirewall firewall show rule name=Spawnpoint 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Note 'Couldn''t add the firewall rule, so friends on your network may not reach your servers. The log has details.' }
}

# ---- panel -----------------------------------------------------------------
if ($Ours -eq 0 -and (Test-Listening $Port)) {
  if (Get-Health $Port) {
    Write-Host ''; Out-Part '  !' Yellow; Write-Host " A Spawnpoint panel you started by hand is already running on port $Port."
    Say 'The new build is ready. Stop that panel and run this again to switch it to a sign-in task.'
    $global:LASTEXITCODE = 0; return
  }
  $busyBy = Who-Listens $Port
  $by = if ($busyBy) { " by $busyBy" } else { '' }
  if (Test-Path -LiteralPath $Settings) {
    Fail "Port $Port is already in use$by." @("Stop that program, or set another `"port`" in $Settings, then run this again.")
  }
  $newPort = 0
  for ($p = $Port + 1; $p -le $Port + 20; $p++) { if (-not (Test-Listening $p)) { $newPort = $p; break } }
  if (-not $newPort) { Fail "Ports $Port to $($Port + 20) are all in use." }
  Note "Port $Port is taken$by, so the panel will use $newPort."
  [IO.File]::WriteAllText($Settings, "{`n  `"port`": $newPort`n}`n")
  $Port = $newPort
}

function Sq([string]$s) { "'" + $s.Replace("'", "''") + "'" }
function Start-Panel {
  # The wrapper sets the layout, records its PID, and restarts the panel three
  # seconds after it exits, like the systemd unit's Restart=always.
  $run = '/d /v:off /s /c "' + (Q $NodeExe) + ' ' + (Q "$Dir\server\dist\index.js") + ' >>' + (Q $PanelLog) + ' 2>&1"'
  $wrapper = @(
    '$env:SPAWNPOINT_ROOT = ' + (Sq $Root)
    '[IO.File]::WriteAllText(' + (Sq $PidFile) + ', [string]$PID)'
    'Set-Location -LiteralPath ' + (Sq $Dir)
    'while ($true) {'
    '  $p = Start-Process -FilePath ' + (Sq $Cmd) + ' -ArgumentList ' + (Sq $run) + ' -NoNewWindow -PassThru'
    '  $p.WaitForExit(); Start-Sleep -Seconds 3'
    '}'
  ) -join "`n"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($wrapper))
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -WorkingDirectory $Dir `
    -Argument ('--headless ' + (Q "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe") + ' -NoProfile -NonInteractive -EncodedCommand ' + $encoded)
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $Me.Name
  $principal = New-ScheduledTaskPrincipal -UserId $Me.Name -LogonType Interactive -RunLevel Limited
  # A task stops after 72 hours, and on battery, unless told otherwise.
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $Task -Description 'Starts the Spawnpoint panel when you sign in.' -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
  Start-ScheduledTask -TaskName $Task -ErrorAction Stop
}
function Start-AndWait([Diagnostics.Stopwatch]$t) {
  try { Start-Panel } catch { Add-Log "scheduled task: $_"; return "Windows refused the sign-in task: $($_.Exception.Message)" }
  $frame = 0
  while ($t.Elapsed.TotalSeconds -lt 45) {
    if (Get-Health $Port) {
      # the answer must come from the task's process, not a stray panel
      $lpid = Get-Listener $Port
      if ($lpid -and ((Get-TaskTree) -contains $lpid)) { return '' }
      return "port $Port answers from pid $lpid, not the panel task"
    }
    for ($k = 0; $k -lt 8; $k++) { Spin 'Starting the panel' $t $frame; $frame++; Start-Sleep -Milliseconds 100 }
  }
  "the panel did not answer on port $Port within 45s"
}
if (-not (Test-Path -LiteralPath $PanelLog)) { [IO.File]::WriteAllText($PanelLog, '') }
$Mark = (Get-Item -LiteralPath $PanelLog).Length
$t = [Diagnostics.Stopwatch]::StartNew()
Add-Log "`r`n== Starting the panel"
$err = Start-AndWait $t
Clear-Spin 'Starting the panel'
if ($err) {
  Add-Log $err
  Step-Failed 'Starting the panel'
  $fs = [IO.File]::Open($PanelLog, 'Open', 'Read', 'ReadWrite'); $fs.Position = [Math]::Min($Mark, $fs.Length)
  $tail = (New-Object IO.StreamReader $fs).ReadToEnd(); $fs.Close()
  if ($tail -match 'EADDRINUSE') { Fail "Something else grabbed port $Port while the panel started." @("Stop it, or set another `"port`" in $Settings, then run this again.") }
  Fail "The panel didn't answer on port $Port." @($err, "Its log: $PanelLog")
}
Step-Done 'Starting the panel' $t

# ---- done ------------------------------------------------------------------
$Code = ''; try { $Code = [IO.File]::ReadAllText("$Data\setup-code.txt").Trim() } catch { }
$Suffix = if ($Code) { "/setup#code=$Code" } else { '' }
# the address on the interface with the default route, not a Hyper-V or WSL switch
$Lan = $null
try {
  $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop | Sort-Object { $_.RouteMetric + $_.InterfaceMetric } | Select-Object -First 1
  $Lan = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex -ErrorAction Stop | Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1 -ExpandProperty IPAddress
} catch { }
# Over SSH the browser is on another computer: lead with the address that
# computer used to reach this one.
$SshHost = if ($env:SSH_CONNECTION) { ($env:SSH_CONNECTION -split ' ')[2] } else { '' }
if ($SshHost) { $Main = "http://${SshHost}:$Port$Suffix"; $Other = '' }
else { $Main = "http://localhost:$Port$Suffix"; $Other = if ($Lan) { "http://${Lan}:$Port$Suffix" } else { '' } }

Write-Host ''
Out-Part '  Spawnpoint is ready.' Green; Out-Part (' Installed in ' + (Took $Clock.Elapsed.TotalSeconds) + '.') DarkGray; Write-Host ''; Write-Host ''
if ($Code) { Write-Host '  Open this link to finish setup:' } else { Write-Host '  Open your panel:' }
Write-Host ''; Out-Part "    $Main" Green; Write-Host ''; Write-Host ''
if ($Other) { Out-Part '  From a phone or another computer on your network:' DarkGray; Write-Host ''; Out-Part "  $Other" DarkGray; Write-Host ''; Write-Host '' }
if ($Runtime -eq 'crafty') {
  $crafty = $false
  try { $crafty = Test-Listening 8443 } catch { }
  if (-not $crafty) { Note 'Crafty Controller isn''t answering on https://localhost:8443. Install or start it, then choose Crafty in setup.' }
}
Out-Part '  Command line and coding agents: spawnpoint status' DarkGray; Write-Host ''
Out-Part '  Your servers start with Windows; the panel starts when you sign in.' DarkGray; Write-Host ''
Out-Part "  Log: $PanelLog" DarkGray; Write-Host ''; Write-Host ''

if (-not $env:SPAWNPOINT_NO_OPEN -and -not $SshHost) { try { Start-Process $Main } catch { } }
$global:LASTEXITCODE = 0
} } catch {
  # Fail() aborts with this marker; anything else is a bug worth showing.
  if ("$_" -ne 'spawnpoint-abort') {
    Write-Host ''; Write-Host "  The installer stopped unexpectedly: $_" -ForegroundColor Red
    Write-Host "    $($_.InvocationInfo.PositionMessage)" -ForegroundColor DarkGray
  }
  $global:LASTEXITCODE = 1
}
