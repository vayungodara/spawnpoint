# How mod changes are tested

[Back to the README](../README.md)

This page covers what happens between adding a mod and your friends getting
it. Tested revisions support Fabric and certified Forge and NeoForge recipes;
see [supported servers](recipes.md) for the exact versions.

## Candidates

Installs, updates and jars uploaded into `mods/` collect into a candidate
for that server. A few seconds after the last change, the candidate is
tested. Nothing on the live server changes while that happens.

Removing or disabling a Fabric mod is staged, tested and approved like an
install. It is refused while another installed mod depends on it.

## The tests

1. **Whole-pack dependency check** (Fabric and certified Forge and NeoForge
   versions). The solver reads native jar metadata, nested libraries and side
   constraints. It checks compatible version histories against your
   Minecraft, loader and Java versions, keeping existing versions where
   possible. Requested mods stay in the pack, and an exact version request
   stays pinned. Downloads must match their declared hashes and size before
   they join the candidate.
2. **Server boot test.** A sandbox boots the server's own loader with the
   candidate's mods. Forge and NeoForge must finish starting in a fresh
   disposable world, because their EULA check happens before mod
   initialization. Runtime and mixin failures still stop the change.
3. **Client test** (servers with AutoModpack). A real Minecraft client boots
   with the files your friends would receive, then joins a throwaway server
   with the same mods and a fresh world. This uses
   [HeadlessMC](https://github.com/headlesshq/headlessmc) on Minecraft 1.20
   and newer. The Fabric and certified Forge and NeoForge joins also run
   AutoModpack's own handshake and check that the client ends up with
   exactly the tested files.

![Review sheet: the plan, both test results, and the config edit waiting for approval](screenshots/review.webp)

## When a test fails or can't run

A candidate that fails is deleted and nothing live changes, but only after
the same test passes on the current pack without it and the failure
repeats. Otherwise Spawnpoint does not blame the change.

A change that could not be fully tested waits for you: the pack already
fails, the test is unreliable, there is no JDK yet, there is not enough free
memory, or the loader is unsupported. You can approve the test gaps, test
again, or discard it. Unsupported launch recipes and failed hash checks
cannot be waived.

## What a revision locks

Each revision locks Minecraft, the loader and its version, Java, and every
pack-owned file's path, side, SHA-512, size and source IDs. Requested mods
are recorded separately from dependencies. Tests use copies of those exact
inputs. Configs generated during testing become proposals and are retested.

Replacements, removals and config edits always need your explicit approval.
Spawnpoint never treats dropping a requested mod as success and never
changes Minecraft or the loader automatically on an existing world.

## The revision report

Each revision shows passed, failed, skipped or inconclusive results, the
renderer used, and the loader's own error lines. The report separates a
feasible pack from a proved minimum-change plan. Mod-id discovery on
Modrinth is incomplete, so when a complete feasible plan exists but fewer
replacements might be possible, the report says so. A catalog or download
limit without a complete plan installs nothing.

CurseForge requests keep their exact project and file IDs. If an author
disables API downloads, Spawnpoint asks for a manual download rather than
substituting a Modrinth release.

## Going live

A passed, approved candidate waits for a verified restart. Server mods only
change while the server is stopped:

- Nobody online: Spawnpoint restarts the server on its own, but only when
  RCON confirms the server is empty.
- Players online: they get a chat warning, and you pick *Restart now*
  (30 second countdown) or *When everyone has left*.
- Server stopped: the change goes in when you start the server from the
  panel (Start, Restart or a scheduled start).

Spawnpoint backs up the world while the server is stopped, journals the pack
swap, starts the server, and waits for that boot to become ready. AutoModpack
hosting stays off until its fresh manifest and the published bytes match the
promoted revision. Friends receive only that revision's client files.

## Rollback and undo

If the server fails to start or publication fails, the pack is rolled back
and the server starts without the change. The failed revision keeps its
test results and reason.

Pack rollback restores locked configs and pack files, **not the world**.
World restore is a separate operation that needs your approval. *Undo last
change* follows the same restart rules and covers the last five changes per
server.

If the panel itself restarts in the middle, it picks up where it stopped. If
a change cannot be rolled back cleanly, the server stays stopped and locked
until you check it and clear the lock on the server's **Overview** tab.

## Memory

Tests wait until the machine has enough free memory, so they do not starve
the live server: about 1 GB for the server test, 1 to 4.5 GB for the client
test and 2 to 8 GB for the join, depending on the number of mods. After 10
minutes a test gives up and the change waits for you. On a 4 GB machine with
the server running, expect the join test to wait.

## Display

The client test needs a display. On a headless Linux machine, install `xvfb`
(`sudo apt install xvfb`) so the client renders on a virtual screen. Without
it the client runs with stubbed graphics: mod loading is tested, rendering is
not, and the verdict says so. On macOS, Windows or a Linux desktop the test
client opens as a small window for a few minutes.

Either way the test runs on this machine's graphics, so it cannot vouch for
every friend's GPU, driver or shader pack.
