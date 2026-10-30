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

## Chat genie

The genie is optional and off until you add a credential (a Claude token or
an Anthropic API key). Players on your list type `server <wish>` in chat,
and Claude Code turns the wish into server commands, then checks the result
before reporting success.

It runs Claude Code with no tools, no MCP servers and a minimal environment,
as the `nobody` user when the panel runs as root. Its server commands go
over RCON. By default it cannot run `op`, `deop`, `ban`, `kick`,
`whitelist`, `stop` or `save-off`. Set `"commandPolicy": "full"` in
`data/chatgenie.json` to allow everything except `stop` and `save-off`.
