# Crafty Controller: keep it or import from it

[Back to the README](../README.md)

Existing [Crafty Controller](https://craftycontrol.com/) installations can
keep running their servers through Crafty, or move stopped, certified
servers into Spawnpoint one at a time. **Panel settings → Server runtime**
controls new creation and whether unimported Crafty servers appear. Changing
that choice does not transfer ownership.

To connect Crafty during setup, paste an API key from a non-admin account
that can see your servers, or log in once to mint a token. The password is
not stored.

## Import a server

1. Stop the server and finish all Crafty imports, updates and backups. Adopt
   and certify a revision with its required launch guard.
2. In the server's **Server** tab, under **Server runtime**, approve
   **Prepare Crafty import**. This freezes the source launch command and
   disables autostart, crash recovery and update watching. Before commit,
   **Cancel** restores those settings.
3. Stop the entire local Crafty service or container and confirm its workers
   have exited. This also stops its other servers. A refused web connection
   alone does not prove worker exit, so the panel asks for your explicit
   confirmation.
4. Approve the displayed revision and **Commit exact revision**. The panel
   checks the closed ports, directory identity, runtime fence and exact
   sealed bytes, then atomically moves the whole directory into
   `Servers/<uuid>` on the same filesystem.
5. If commit is interrupted, complete forward recovery in the same section.
   Never re-enable the old Crafty record. After commit, restart Crafty if
   needed and start the imported server from Spawnpoint.

## Limits

- Linked or external worlds and cross-volume moves are refused. World
  confinement is checked again at commit and recovery.
- Import requires plain `key=value` properties. Escaped keys, continuations
  and alternate separators must be normalized before preparation.

## After import

The world and UUID stay the same, and no world restore happens. The Crafty
watchdog stays paused while any transfer journal exists. Imported servers
never fall back to Crafty, even if the supervisor is offline.
