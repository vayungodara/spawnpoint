# Install and update

[Back to the README](../README.md)

## One-line install (Linux and macOS)

Run this as the unprivileged account that will own your servers:

```bash
curl -fsSL https://raw.githubusercontent.com/vayungodara/spawnpoint/main/install.sh | bash
```

The installer:

- checks for git, curl, Node.js 22+, Python 3 (for the supervisor) and, on
  Linux, `zip` and `unzip`
- creates the layout under `~/minecraft` (set `SPAWNPOINT_ROOT` to use
  another folder without spaces)
- clones and builds the panel in `~/minecraft/Spawnpoint`
- installs the [supervisor](supervisor.md) as your OS user service
- starts the panel on port **25570** and prints a setup link with a
  one-time setup code

Existing Crafty connections keep their backend. Set
`SPAWNPOINT_RUNTIME=crafty` to skip the supervisor and connect
[Crafty](crafty-import.md) instead.

The panel itself is a normal process, not a service. The installer prints
the command to start it again after a reboot.

## First-run setup

Open the printed link on that machine, or open `http://<server-address>:25570`
from another device and enter the setup code. The setup page asks for:

1. A **runtime**. Choose Spawnpoint to use its installed OS service without
   a Crafty account. For Crafty, paste an API key from a non-admin account
   that can see your servers, or log in once to mint a token. The password
   is not stored.
2. A **PIN** of 6 to 12 digits. Every browser needs it once every 30 days.
3. Optional keys: CurseForge (adds their catalog) and a credential for the
   chat genie.

Modrinth installs, dependency healing, the tests and client sync need no API
keys.

## Update

There is no one-click update yet. Running the install command again tries
to fast-forward the checkout (it builds the existing checkout if it can't),
rebuilds the panel and reinstalls the supervisor service:

- On macOS this restarts the supervisor right away, which stops running
  servers.
- On Linux the running supervisor keeps its old code until you restart it
  with `systemctl --user restart spawnpoint-supervisor.service`, which also
  stops running servers.
- A panel that is already running keeps the old build until you restart it
  with the start command the installer printed.

So update while nobody is playing: stop your servers, run the installer,
restart the supervisor on Linux, then restart the panel. Servers with
autostart enabled start again with the supervisor.

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
