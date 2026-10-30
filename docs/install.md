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

A supervisor that is already running is left alone, so your servers keep
running. It keeps its old code until you restart it
(`systemctl --user restart spawnpoint-supervisor.service` on Linux, or log
out and back in on macOS), which stops running servers; do that while nobody
is playing. Servers with autostart enabled start again with the supervisor.

A panel you started by hand is never replaced. The installer tells you to
stop it and run the command again so it can switch to the login service.

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

On Windows, build the checkout the same way, then install the supervisor
from an elevated PowerShell as described in
[the supervisor docs](supervisor.md#windows).
