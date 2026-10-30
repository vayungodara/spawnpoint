# Crafty Controller: keep it or import from it

[Back to the README](../README.md)

Existing [Crafty Controller](https://craftycontrol.com/) installations can
keep running their servers through Crafty, or move them into Spawnpoint one
at a time from the panel. **Panel settings → Server runtime**
controls new creation and whether unimported Crafty servers appear. Changing
that choice does not transfer ownership.

To connect Crafty during setup, paste an API key from a non-admin account
that can see your servers, or log in once to mint a token. The password is
not stored.

## Import a server

Open the server's **Server** tab. **Move to Spawnpoint** has two steps:

1. **Create first tested version.** One click approves the launch guard and
   managed AutoModpack publication, then tests the live pack: a server boot
   on a copy and, with AutoModpack, a real client that joins and completes
   the handshake. When two versions of one mod are installed (for example two
   `fabric-api` jars), the section lists them and the button becomes **Keep
   newest and test**. Removals still wait for your approval of the exact
   tested revision, which shows each check and what it proved.
2. **Move to Spawnpoint.** Stop the server first. On Linux, a panel running as
   root moves just this server while Crafty keeps running its others. It
   freezes the server's Crafty launch settings. Then it pauses Crafty and all
   its workers (its other servers freeze for about a second), checks that no
   process still has a working directory, directory or writable file inside
   the folder, and atomically moves it into `Servers/<uuid>` on the same
   filesystem before Crafty resumes. The tested bytes are checked again
   after the move. It then hands every file to the supervisor's account, and that account
   itself confirms it can write the whole tree and `data/pack-hosting`. A busy
   or unwritable folder goes back to Crafty unchanged, with the reason shown.
   Elsewhere, or when the panel cannot inspect every process, the section
   walks you through stopping Crafty and shows whether its web port and
   processes are gone.

Crafty keeps a disabled entry, and its schedules for that server stop
working. An interrupted move finishes forward from the same section. Never
re-enable the old Crafty record.

## Run the panel as a normal user

A root panel is needed only while Crafty's own account owns server folders.
Once they are imported, move the panel to an unprivileged account:

```bash
sudo python3 server/dist/services/nativeservice.py panel --user "$USER" --root /path/to/layout --node "$(command -v node)"
```

The command refuses if the supervisor runs as another account, or if Crafty
server folders remain that the new account could not write (pass
`--keep-crafty-servers` to accept that). It asks the running panel to exit
and refuses while a test, wish or server creation runs. It hands the panel's
checkout, `Spawnpoint/`, `Shared/`, `Tools/`, `Backups/` and `Servers/` to
that user, keeping `settings.json`, tokens and `data/` private. It rewrites
`/etc/systemd/system/spawnpoint.service` with `User=`, keeps its
`EnvironmentFile=` and ordering lines, saves the old unit as
`spawnpoint.service.root-backup`, and waits until the panel answers as that
user. Minecraft keeps running throughout.

## Limits

- Linked or external worlds and cross-volume moves are refused. World
  confinement is checked again at commit and recovery.
- Import requires plain `key=value` properties. Escaped keys, continuations
  and alternate separators must be normalized before preparation.

## After import

The world and UUID stay the same, and no world restore happens. The Crafty
watchdog stays paused while any transfer journal exists. Imported servers
never fall back to Crafty, even if the supervisor is offline.
