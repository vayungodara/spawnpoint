# The spawnpoint CLI

`spawnpoint` controls your servers from a terminal or a coding agent such as
Claude Code, Codex or Amp. It is a thin client over the panel's HTTP API,
with no second implementation and no dependencies. It starts in about 45 ms.

```console
$ spawnpoint status
spawnpoint 0.1.0 · http://127.0.0.1:25570 · 1 server
* Survival  running  2/20 online · cpu 12% · mem 1.9 GB · fabric 1.21.1 · :25565
    change needs-approval: approve the listed replacements … → spawnpoint change
```

## Install

The installer links `spawnpoint` into `~/.local/bin`. From a checkout, on
Linux, macOS or Windows (Node 22 or newer):

```sh
npm i -g ./cli
```

On the panel machine the CLI reads the admin token from the layout, so it
works with no setup. It looks in `SPAWNPOINT_ROOT`, the installer's saved
root, then `~/minecraft`. The admin token is only ever sent to a loopback URL.

## Use it from another machine

1. In **Panel settings → API tokens**, create a token with the lowest scope
   that does the job.
2. On the other machine, run `spawnpoint login --url http://<panel-host>:25570`
   and paste the token. It is saved owner-only in `~/.config/spawnpoint/cli.json`
   (`%APPDATA%\spawnpoint\cli.json` on Windows). It is sent only to that URL.

You can also set `SPAWNPOINT_URL` and `SPAWNPOINT_TOKEN`. Keep the panel on
your LAN or a VPN such as Tailscale.

| Scope | Allows |
| --- | --- |
| read | status, players, mods, test results, revisions, server and crash logs |
| control | read, plus start, stop, console commands, files, config, staging mod changes, discard and retest |
| approve | control, plus approving mod changes, undo, world restore, world resets, version switches, player-data resets and backup deletion |

Only the owner (a PIN session or the admin token) can manage tokens, change
the PIN or credentials, delete a server, import from Crafty or restart the
panel. A read token sees no file contents except plain files in `logs/` and
`crash-reports/`. It never sees the RCON password, even in
`server.properties`.

Only a read token is safe to give to a machine you do not trust. Control
and approve tokens can run code on the host, because mods are code: a
staged mod runs in the boot test as the panel's user. Treat them like shell
access. The scopes stop mistakes and keep approvals deliberate. They do not
contain an adversary.

The panel stores only a SHA-256 hash of each token and shows it once.
Revoking it takes effect on the next request. An approval made with a token
counts as the owner's consent. The revision report records which token
approved it. Create approve tokens on purpose.

`spawnpoint token create NAME --scope read --out FILE` creates a token from
the panel machine. It writes a new owner-only file and never overwrites one.
It refuses to print a token into a pipe or an agent log, and
`spawnpoint api` cannot create tokens. `SPAWNPOINT_TOKEN` is sent only to
`SPAWNPOINT_URL`.

## Commands

`spawnpoint help` lists every command, and `spawnpoint help COMMAND` shows
one. With one server, `-s` is optional. Otherwise pass `-s NAME`, set
`SPAWNPOINT_SERVER`, or run `spawnpoint use NAME` once.

| Area | Commands |
| --- | --- |
| Overview | `status`, `health` |
| Servers | `servers`, `use`, `create`, `delete` |
| Power | `start`, `stop`, `restart` (wait until ready or stopped), `autostart`, `unlock` |
| Console and logs | `console`, `send`, `logs`, `logs --crash` |
| Players | `players`, `players add/remove/kick/ban/op/deop/msg` |
| Mods | `mods`, `mods search/add/remove/enable/disable/update` |
| Mod changes | `change`, `change --wait`, `change approve/discard/retest/restart/undo/cancel-undo/history/show` |
| Backups | `backups`, `backups create/restore/delete` |
| Settings | `config`, `config set`, `config memory`, `config files/read/write` |
| Files | `files ls/cat/find/put/get/mv/mkdir/rm` |
| Chat genie | `genie`, `genie on/off/players/policy/server/wish` |
| Anything else | `api METHOD PATH [JSON]` (token scopes still apply) |

### A mod change

```sh
spawnpoint mods search sodium
spawnpoint mods add sodium          # staged; the live server is untouched
spawnpoint change --wait            # tests run on a copy
spawnpoint change approve 2026-10-30T19-01-14-091Z-1793387310077
spawnpoint status                   # the panel restarts the change in when it is safe
```

`change approve` takes the exact revision that `spawnpoint change` printed.
If the change was retested since, the CLI refuses before anything is sent.
If a test did not pass, approval also needs `--accept-gaps`. Hash checks
cannot be waived. The first change on a server asks for the launch guard
with `change approve guard`.

## Output and exit codes

- Short plain text, summary first. `--details` shows more on `change`.
  `--json` prints the exact API data.
- No colour, spinners or prompts. Only `login` prompts, and only on a TTY.
- `--lines N` (`-n`), `--since 10m` and `--grep RE` bound console and log
  output. Log times are judged on the panel's clock.
- Errors go to stderr as `error: …` and `next: …`.

| Exit | Meaning |
| --- | --- |
| 0 | ok |
| 1 | failed |
| 2 | bad usage, or the panel rejected the input |
| 3 | not signed in, or the token's scope is too low |
| 4 | not found |
| 5 | refused or busy, for example the change moved on or the server is locked |
| 6 | needs `--yes` or `--accept-gaps` |
| 7 | panel unreachable |
| 8 | timed out waiting; run the same command again |

These need `--yes`: stop or restart with players online, `players ban`,
`backups restore`, `backups delete`, `files rm`, `files get` over an existing
file, `change undo`, `change restart now` with players online, `unlock`,
`delete`, and `mods remove` on loaders that are not tested first.

## Coding agents

`spawnpoint help --agent` prints a guide of about 1,500 tokens that an agent
reads once. For Claude Code or Amp, copy
[`cli/skills/spawnpoint`](../cli/skills/spawnpoint/SKILL.md) into your
skills folder. Or add this to the project's `AGENTS.md` or `CLAUDE.md`:

```md
## Minecraft server
Use the `spawnpoint` CLI. Run `spawnpoint help --agent` once, then start with
`spawnpoint status`. Bound output with --lines and --since. Ask me before any
--yes, --accept-gaps or `change approve`.
```

### MCP

`spawnpoint mcp` serves the same commands as MCP tools over stdio. Pass
`--url` and `-s` at launch to fix the panel and default server. A tool call
cannot change the URL. There is
one tool per area (`status`, `power`, `console`, `mods`, `change`, `files` …),
and each takes the CLI arguments as one string. An MCP client can then allow
`status` freely and ask before `change` or `files`. Access and token commands
are not exposed.

```sh
claude mcp add spawnpoint -- spawnpoint mcp
amp mcp add spawnpoint -- spawnpoint mcp
codex mcp add spawnpoint -- spawnpoint mcp
```

## Token use

These are measured bytes on the disposable Fabric fixture, at about 4 bytes
per token. The dashboard column is an agent-browser accessibility snapshot
of the page an agent would have to read.

| Task | Dashboard page | Raw API JSON | CLI |
| --- | --- | --- | --- |
| Status overview | 4,822 | 4,944 (4 calls) | 222 |
| Review a tested change | 5,291 + review sheet | 4,438 | 596 |
| Installed mods | 9,326 | 6,231 | 538 |
| Search for a mod | (search page) | 26,536 | 957 |
| server.properties | — | 1,680 | 255 (key settings) |

A whole mod change takes about 1.7 KB of CLI output (`mods add`,
`change --wait`, `change approve`, `status`), or roughly 430 tokens. The same
flow over raw HTTP needs the project lookup (12.8 KB), the install response,
repeated 4.4 KB candidate polls and the approval response. That is easily
50 KB or more, before the agent writes any curl commands.

See [an agent session](cli-demo.md) for a real run.
