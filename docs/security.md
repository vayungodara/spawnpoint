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
trees. Launcher caches are copied before execution. Confined tests cannot
write shared tools or sealed inputs. The panel refuses linked output paths,
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
- **Windows:** if the low-privilege AppContainer (LPAC) runtime or loopback
  probe fails, candidate tests still run as the panel's user and report
  **Not isolated**. LPAC currently rejects its own TCP sockets with error
  10013 on the tested host. The fallback applies to server boot, client boot
  and the join's test processes. It uses no AppContainer, retains Job Object
  resource limits and shutdown handling, and keeps the allowlisted environment
  and output-path checks. Those measures do not provide a security boundary:
  a staged mod can read or modify panel data, other servers and the user's
  home, and access the host network before approval. Use only trusted mods
  and control tokens on Windows. Boot and join outcomes remain separate
  from isolation; a passed boot never changes Not isolated to a pass.
  Windows CI exercises actual unisolated JVM execution and records permitted
  access to disposable host canaries. This is not a confinement pass.
  When the probe succeeds, LPAC ignores ambient All Application Packages
  grants and has no network capabilities or host-loopback exemption.
  A join pair shares a fresh container identity, with separate scratch
  capabilities. A Job Object per launched process tree limits memory, CPU
  and process count. The helper confirms that all descendants have exited
  before the panel accepts outputs. Without confirmation, the test is
  inconclusive and its scratch is retained.
  Windows requires a temporary AppContainer profile. Its filesystem tree
  denies the container access; candidate writes use only the granted scratch.
  The parent removes the profile after confirmed shutdown.

On Linux and macOS, an unavailable sandbox reports **Not isolated** and
refuses execution. Windows uses the unisolated fallback described above.
`SPAWNPOINT_UNSANDBOXED=1` explicitly disables execution on every OS; it
does not request the Windows fallback. A confinement check does
not prove that Minecraft booted, rendered or completed its join handshake.
Those checks have separate results.

## Live server permissions

On default Linux and macOS installs, live server mods run as the panel's
user. The supervisor keeps that UID so the one-line install needs no sudo
or separate service account. Live mods can read and modify the user's panel
data, settings and home. Candidate test isolation does not protect these
files after a mod goes live.

Replacements, removals, config edits and inconclusive functional tests require the
owner's approval of the tested revision. Clean additions can go live
automatically after passing tests. An approve token delegates owner consent,
including acceptance of test gaps. A passed test is not a security audit
of the mod. Control and approve tokens therefore remain host-trusted.

Windows uses a separate supervisor service account, but its existing grants
still allow writes across the layout, including panel code and data. This
release does not change live-server accounts or repair those permissions.

## Optional hardened install (design only)

The hardened install is not implemented and has no install command yet.
It would be opt-in and require administrator assistance; the default
Linux and macOS install would remain sudo-free.

The trusted coordinator would retain the registry, install and publication
journals, IPC credentials and lifetime fences. It would launch JVMs through
a separate restricted executor account. That account could write only the
server directories it runs. Panel code, data, settings, tools, service
definitions and fence parent directories would remain unwritable by it.
Control files inside server trees would also need protection or relocation
before the coordinator could trust them. Restricting the current supervisor's
ACLs alone would break its trusted-state writes without separating mod code.

Opt-in migration would stop and drain every live JVM, preserve server bytes
and fence identities, revoke old recursive grants, and install the account
and service boundary. Updates to a hardened install would repeat the repair
idempotently and refuse starts on failure. Acceptance must exercise real
live mods and restart, import, publication, Undo and recovery paths on each
OS, including an upgrade from today's broad-permission layout. None of
those hardened-install guarantees apply to this release.

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
