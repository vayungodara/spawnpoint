# Security

[Back to the README](../README.md)

## Network

Keep the panel on your LAN or a VPN such as Tailscale. Do not expose port
25570 to the internet. [Remote access](remote-access.md) shows a setup that
keeps it private.

## Authentication

Every API call except the health check, PIN unlock and the first-run setup
(which needs the one-time setup code) requires a PIN session or the admin
token. There is no "trusted local address": a reverse proxy on the same
machine would make every visitor look local.

PINs are stored as scrypt hashes. Wrong guesses are throttled per address
and globally. Sessions expire after 30 days or when the PIN changes. A
session-authenticated write whose `Origin` header names a different host and
port than the request's `Host` header is refused.

## RCON

The panel turns on RCON for each server it starts, on the game port plus
10000, with a random password. Minecraft binds RCON to every interface, so
forward only the game port, never the RCON port.

## Admin token

Scripts on the panel machine can use the admin token in
`<layout>/Spawnpoint/data/admin-token`:

```bash
curl -H "Authorization: Bearer $(cat ~/minecraft/Spawnpoint/data/admin-token)" localhost:25570/api/servers
```

## API tokens

Coding agents and other machines should use a scoped token from **Panel
settings → API tokens**, not the admin token. Read tokens see status, logs
and test results. Control tokens can start and stop servers, edit files and
stage mod changes. Approve tokens can also approve changes, undo and restore
worlds as you. Mods are code, so treat control and approve tokens like shell
access. See [cli.md](cli.md).

## Supervisor IPC

The supervisor's runtime directory contains a private IPC capability. Never
publish it. See [the supervisor docs](supervisor.md).

## Candidate test isolation

The server boot, client boot and join tests run candidate code in disposable
scratch directories. The join's server and client have separate writable
trees. Launcher caches are copied before execution. Shared tools and sealed
inputs are not writable by a test. The panel refuses linked output paths,
including links in intermediate directories, before reading generated files.
Only an allowlisted environment reaches a test process.

- **Linux:** bubblewrap creates private filesystem, process and network
  namespaces. A join pair shares its own loopback network, not the host's.
  A root panel drops to `spawnpoint-sandbox` through `setpriv` first.
  An unprivileged panel uses its own UID inside the namespaces. A systemd
  scope limits memory, CPU and tasks when the account has a working service
  manager. Otherwise the report states that only Java's heap is bounded.
  Xvfb runs inside the sandbox; the host desktop is never shared.
  Layouts and home directories inside its OS mounts, such as `/usr`, refuse
  testing rather than expose their files through a read-only mount.
  Ubuntu can require an administrator-installed
  [dedicated AppArmor profile](cli.md#enable-candidate-tests-on-ubuntu).
  Spawnpoint does not disable host AppArmor restrictions automatically.
- **macOS:** a default-deny `sandbox-exec` profile permits OS libraries,
  declared runtimes and the process's scratch tree. Writes stay in scratch.
  TCP binds and connections have separate loopback-port allowlists. The
  process retains the panel's UID, but root panels refuse testing. Forks
  are denied; HeadlessMC loads the client in the confined JVM. Java's heap
  does not limit native memory. Packs incompatible with stubbed graphics
  receive an inconclusive client result, not a rendering pass.
- **Windows:** a low-privilege AppContainer ignores ambient All Application
  Packages grants and has no network capabilities or host-loopback exemption.
  A join pair shares a fresh container identity, with separate scratch
  capabilities. A Job Object per launched process tree limits memory, CPU
  and process count. The helper confirms that all descendants have exited
  before the panel accepts outputs. Without confirmation, the test is
  inconclusive and its scratch is retained.
  Windows requires a temporary AppContainer profile. Its filesystem tree
  denies the container access; candidate writes use only the granted scratch.
  The parent removes the profile after confirmed shutdown.

If the OS sandbox cannot start, the report says **Not isolated** and the
test does not execute candidate code. `SPAWNPOINT_UNSANDBOXED=1` also refuses
execution; it does not enable an unsafe fallback. A confinement check does
not prove that Minecraft booted, rendered or completed its join handshake.
Those checks have separate results.

This boundary covers candidate tests, not live Minecraft servers. The
supervisor still owns trusted registry, installation and publication state.
Its existing account permissions must not be treated as a sandbox for live
mods. Control and approve tokens therefore remain host-trusted.

## Chat genie

The genie is optional and off until you connect an AI account in Settings →
Genie AI account. **Connect Claude subscription** signs in with the Claude
Pro or Max plan you already have (Linux and macOS); you can also paste a
`claude setup-token` token or an Anthropic API key. The token goes straight
into `data/settings.json` (mode 0600) and is never logged or sent back to the
browser. Settings shows whether it works, an expired or rejected login, and
how much of the subscription's 5-hour and weekly limits is used. Players on
your list type `server <wish>` in chat, and Claude Code turns the wish into
server commands, then checks the result before reporting success.

It runs Claude Code with no tools, no MCP servers and a minimal environment,
as the `nobody` user when the panel runs as root. Its server commands go
over RCON. By default it cannot run `op`, `deop`, `ban`, `kick`,
`whitelist`, `stop` or `save-off`. Set `"commandPolicy": "full"` in
`data/chatgenie.json` to allow everything except `stop` and `save-off`. Refused commands, including ones inside saved
blueprints, never run and count as failures, so the genie cannot report them
as done.
