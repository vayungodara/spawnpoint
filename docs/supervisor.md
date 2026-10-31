# The supervisor (OS service)

[Back to the README](../README.md)

Spawnpoint's independent supervisor owns Java and the console, so your
Minecraft servers keep running when the panel exits. The installers set it
up as a user service on Linux and macOS and as a Windows service. They run
the panel itself as your login service: a systemd user unit, a LaunchAgent,
or the `Spawnpoint Panel` scheduled task on Windows.

Use absolute paths and a layout path without spaces. Run the panel as the
layout's owner, or as root while Crafty's own account still owns server
folders. Do not run Java as root or install a second owner for the
same layout.

## Linux

The default installer uses `systemctl --user`. To start before login, enable
lingering:

```bash
sudo loginctl enable-linger "$USER"
```

On a host without a user service manager, install a system unit instead. The
layout must belong to that unprivileged user.

```bash
sudo python3 server/dist/services/nativeservice.py install --system --user "$USER" --root /path/to/layout --node "$(command -v node)"
```

Inspect it with `systemctl status spawnpoint-supervisor.service` (add
`--user` for a user unit).

## macOS

The default installer creates the current user's `com.spawnpoint.supervisor`
LaunchAgent. It starts at login and stops at logout, so keep that user logged
in for unattended servers. Inspect it with:

```bash
launchctl print gui/$(id -u)/com.spawnpoint.supervisor
```

## Windows

The [one-line installer](install.md#one-line-install-windows) does this for
you. By hand: install Python 3 and Node 22 machine-wide, build the checkout
(see [manual install](install.md#manual-install)), then run this in an
elevated PowerShell:

```powershell
python server/dist/services/nativeservice.py install --root C:/MinecraftServers --node "C:/Program Files/nodejs/node.exe"
```

Run the panel as the layout's installing user with `SPAWNPOINT_ROOT` set to
the same directory. When a standard user elevates with another
administrator's password, pass `--owner-sid` with the standard user's SID
so the layout stays theirs. SCM runs `SpawnpointSupervisor` at boot as its own
virtual service account, with access limited to the layout. Inspect it with
`sc.exe queryex SpawnpointSupervisor`. An existing service is not replaced;
stop it and use `sc.exe config` to update executable paths.

## Health, logs and the IPC capability

The installer waits for the service's authenticated health response and
checks its PID against the OS service manager. Service output is in the
journal on Linux and in `<layout>/Spawnpoint/data/runtime/service.log` on
macOS and Windows.

The runtime directory contains a private IPC capability. Never publish it.
Keep the checkout, Python, Node and Tools Java readable by the service
account.

## Autostart and crash recovery

Set per-server autostart in the server's **Server** tab, under **Server
runtime**. The supervisor restarts a crashed server at most three times in
ten minutes. An explicit Stop disables crash recovery; autostart still
applies on the next service startup if enabled.

Console output is drained without a browser, with a bounded live tail and
three retained files of up to 8 MB each. On Unix, force-killing an
unresponsive server restarts the whole owner service to reap its
descendants. Other desired servers then recover through their restart
budgets.
