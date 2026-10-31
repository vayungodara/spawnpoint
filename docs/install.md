# Install and update

[Back to the README](../README.md)

## One-line install (Linux and macOS)

Run this as the unprivileged account that will own your servers:

```bash
curl -fsSL https://raw.githubusercontent.com/vayungodara/spawnpoint/main/install.sh | bash
```

The installer:

- checks for git, curl, Node.js 22+, Python 3.9+ (for the supervisor), on
  Linux `zip`, `unzip` and a systemd user session, and on macOS Apple's
  Command Line Tools. Anything missing is listed with the command that
  installs it, and nothing is started until it's fixed
- refuses to run as root (servers and their mods shouldn't run as root)
- creates the layout under `~/minecraft` (set `SPAWNPOINT_ROOT` to use
  another folder without spaces)
- clones and builds the panel in `~/minecraft/Spawnpoint`
- installs the [supervisor](supervisor.md) as your OS user service
- installs the panel as a login service too (a systemd user unit or a
  LaunchAgent), so the panel and your servers come back after a reboot
- starts the panel on port **25570**, or the next free port if something else
  has 25570 on a fresh install, prints a setup link with a one-time setup
  code, and opens it in your browser on macOS and desktop Linux

Existing Crafty connections keep their backend. Set
`SPAWNPOINT_RUNTIME=crafty` to skip the supervisor and connect
[Crafty](crafty-import.md) instead.

## One-line install (Windows)

On Windows 10 (1809 or newer) or Windows 11, open PowerShell from the Start
menu the normal way, not with "Run as administrator", and paste:

```powershell
irm https://raw.githubusercontent.com/vayungodara/spawnpoint/main/install.ps1 | iex
```

It works in Windows PowerShell 5.1 and PowerShell 7. The command runs the
script in memory, so you don't need to change the execution policy. The
installer:

- checks for Node.js 22+, git and Python 3.9+. The supervisor service runs
  as its own account, which can't read your user folder, so Node.js and
  Python must be installed for all users, somewhere only administrators
  can change, such as Program Files (winget and the official installers do
  this). Anything missing is listed with
  its `winget` command, and the installer offers to run them for you in one
  administrator window (one extra permission prompt)
- refuses to run as administrator. The panel and your servers' files belong
  to your normal account
- stops the running panel first when updating, and only if it agrees, so a
  panel that's busy keeps running the exact files it started with
- creates the layout in `C:\MinecraftServers`, readable only by you,
  administrators and the supervisor. Set `$env:SPAWNPOINT_ROOT` first to
  use another folder, such as `D:\MinecraftServers`. It has to sit directly
  on a local drive with no spaces in its name. Your user folder and OneDrive
  won't work, because the supervisor's own account can't look inside them
- clones and builds the panel in `<layout>\Spawnpoint`. The checkout has
  to stay inside the layout, because that's the only folder the supervisor's
  account can read
- asks Windows for permission once, to install the
  [supervisor](supervisor.md#windows) as a service that starts with Windows
  and to allow TCP ports 25565 to 25599 on private networks, so friends on
  your network can reach your servers and the panel
- starts the panel from a scheduled task, `Spawnpoint Panel`, which runs as
  you whenever you sign in, in the background with no window, and restarts
  the panel if it exits
- starts the panel on port **25570**, or the next free port if something else
  has 25570 on a fresh install, prints a setup link with a one-time setup
  code, and opens it in your default browser
- adds the `spawnpoint` command to your PATH

Your servers start with Windows, before anyone signs in. The panel starts
when you sign in. If you saved `install.ps1` instead of pasting the command,
run it with `powershell -ExecutionPolicy Bypass -File install.ps1`.

## First-run setup

Open the printed link on that machine, or open `http://<server-address>:25570`
from another device and enter the setup code. The setup page asks for:

1. **Get started** connects the Spawnpoint service the installer set up. If
   you already run servers in Crafty Controller, pick that link instead and
   paste an API key from a non-admin account that can see your servers, or
   log in once to mint a token. The password is not stored.
2. A **PIN** of 6 to 12 digits, typed twice. Every browser needs it once
   every 30 days.
3. An optional Claude subscription or API key for the chat genie. Skip it
   if you like; Settings has the same control, plus the optional CurseForge
   key that adds their catalog.

Then **Create my first server** opens the new-server form with Fabric
picked, and **Start it** starts the server once it's built.

Modrinth installs, dependency healing, the tests and client sync need no API
keys.

## Update

Run the install command again. It fast-forwards the checkout (or builds the
existing one if it can't), rebuilds the panel and restarts the panel
service. It asks the running panel first. If the panel is in the middle of a
wish, a server creation or a mod test, or isn't answering, the installer
stops without touching it and asks you to run it again later.

On Windows, paste the PowerShell command again. Updates need no
administrator permission.

A supervisor that is already running is left alone, so your servers keep
running. It keeps its old code until you restart it
(`systemctl --user restart spawnpoint-supervisor.service` on Linux, log
out and back in on macOS, or `Restart-Service SpawnpointSupervisor` in an
administrator PowerShell on Windows), which stops running servers; do that
while nobody is playing. Servers with autostart enabled start again with the
supervisor.

A panel you started by hand is never replaced. The installer tells you to
stop it and run the command again so it can switch to the login service (the
sign-in task on Windows).

This only applies to the installer's default user service. If you installed
a Linux system unit, don't rerun the installer: it would add a competing
user service. Pull and rebuild the checkout (`git pull`, `npm ci`,
`npm run build`), then run
`sudo systemctl restart spawnpoint-supervisor.service` and restart the
panel.

## Manual install

```bash
git clone https://github.com/vayungodara/spawnpoint
cd spawnpoint
npm ci
npm run build
python3 server/dist/services/nativeservice.py install --root /path/to/your/layout --node "$(command -v node)"
SPAWNPOINT_ROOT=/path/to/your/layout node server/dist/index.js
```

`SPAWNPOINT_ROOT` is the folder that holds `Servers/`, `Crafty/servers`,
`Shared/`, `Tools/` and `Spawnpoint/`. The panel log prints the setup link on
first start.

On Windows, prefer the one-line installer. To do it by hand, build the
checkout the same way, then install the supervisor from an elevated
PowerShell as described in [the supervisor docs](supervisor.md#windows).
