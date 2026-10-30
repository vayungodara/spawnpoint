---
name: spawnpoint
description: Run Minecraft servers managed by a Spawnpoint panel with the `spawnpoint` CLI. Covers status, start and stop, console, players, mods, the tested mod-change flow, backups, config and files. Use when the user asks to check, fix, mod or operate their Spawnpoint Minecraft server.
---

# Spawnpoint

Run `spawnpoint help --agent` once per session. It lists every command, the
exit codes and the safety rules in about 1,500 tokens.

## How to work

- Start with `spawnpoint status`. It shows each server, its players and any
  open mod change.
- Output is short plain text. Add `--json` only when you need exact fields.
- Keep output bounded: `console -n 40`, `logs --since 30m --grep "ERROR|Exception"`.
  Do not use `--follow`.
- With several servers, pass `-s NAME`.
- On an error, stderr has `error:` and `next:` lines. Do what `next:` says.
  Exit 6 means the action needs `--yes` or `--accept-gaps`. Exit 8 means it is
  still running: run the same command again.

## Ask the owner first

These count as the owner's decision. Pass them only when the owner said so in
this conversation:

- `--yes` on stop or restart with players online, `players ban`,
  `backups restore`, `files rm`, `change undo` and `delete`
- `change approve REVISION`, and `--accept-gaps` above all

Before you approve, show the owner the `approving:` lines and any test that did
not pass, as printed by `spawnpoint change`.

## Add or update a mod

```sh
spawnpoint mods search sodium
spawnpoint mods add sodium            # staged; the live server is untouched
spawnpoint change --wait              # tests run on a copy (minutes)
spawnpoint change approve <revision>  # only with the owner's go-ahead
spawnpoint status                     # the panel restarts in when it is safe
```

A failed test deletes the change, and nothing live changes. To roll back the
last applied change, run `spawnpoint change undo --yes`. It needs the owner's
go-ahead.

## Debug a crash

```sh
spawnpoint status
spawnpoint logs --since 30m --grep "ERROR|Exception|Caused by"
spawnpoint logs --crash
```

For anything without a command, use `spawnpoint api GET /api/...`. Token
scopes still apply.
