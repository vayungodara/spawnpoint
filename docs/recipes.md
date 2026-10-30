# Supported servers and launch recipes

[Back to the README](../README.md)

## At a glance

| Loader | Create in Spawnpoint | Tested mod changes |
| --- | --- | --- |
| Fabric | Every stable release from 1.14 | Yes. The client test needs Minecraft 1.20 or newer. |
| Forge | Every release from 1.5.2 | Minecraft 1.20.1 with Forge 47.4.28 |
| NeoForge | Every release from 1.20.1 | Minecraft 1.21.1 with NeoForge 21.1.219 |
| Quilt | Every stable release from 1.14.4 | No |
| Paper | Every release Paper builds, from 1.7.10 | No. Plugins install without a test. |
| Purpur | Every release Purpur builds, from 1.14.1 | No. Plugins install without a test. |
| Vanilla | Every release from 1.2.5 | No |

The standalone runtime lists every Minecraft release each project publishes
a build for, and never snapshots, pre-releases or release candidates. It
defaults to the newest release. Versions not in the boot list below are
offered as untested. Crafty mode lists the same versions and lets Crafty
install them. Locked revisions refuse other FML recipes, so on other Forge
and NeoForge versions the panel refuses mod changes; start from a modpack.
Quilt mods and Paper, Purpur or Vanilla plugins and datapacks install
without a test.

## Creating servers

Spawnpoint resolves one exact recipe from each project's own metadata and
stores it in the creation job, so a retry installs the same bytes:

- **Vanilla:** Mojang's server jar, checked against the SHA-1 and size in
  Mojang's version document. That document is checked against the manifest.
- **Paper:** the newest stable Fill build, checked against its SHA-256.
- **Purpur:** the newest successful build, checked against its MD5. Purpur
  publishes nothing stronger. It catches a corrupted or swapped download
  but not a deliberate MD5 collision.
- **Fabric:** the newest stable loader. Fabric Meta's server launcher has no
  published hash, so Spawnpoint builds the same launcher locally from the
  installer, which is checked against its Maven checksum.
- **Quilt:** the newest stable loader through the official installer, which
  is checked against its Maven checksum.
- **Forge:** the certified solver profile when there is one, otherwise the
  recommended build, otherwise the newest build with a warning. The installer
  is checked against its strongest Maven checksum.
- **NeoForge:** the certified profile, otherwise the newest stable build,
  otherwise the newest beta with a warning. 1.20.1 uses NeoForge's legacy
  `net.neoforged:forge` line.

If the recipe's own artifact has no upstream checksum, or doesn't match it,
the job fails before that artifact runs. Forge, NeoForge and Paperclip check the
libraries and Mojang jar they fetch against hashes inside the verified
artifact. The Fabric and Quilt installers don't, so before the server is
sealed every file under `libraries/` and `versions/` and the Mojang jar must
match Meta's hashes, a Maven checksum, Mojang's SHA-1 or the SHA-256 in the
Mojang bundler's own file list. Anything else fails the job. Fabric's launcher
fetches its files by running once in staging, so downloaded loader and game
code executes before those files are checked. Staging is not a sandbox. A
mismatch still fails the job before anything is registered or started.

Java comes from Adoptium Temurin, checked against Adoptium's SHA-256:

| Minecraft | Fabric, Quilt | Forge, NeoForge | Paper, Purpur, Vanilla |
| --- | --- | --- | --- |
| Before 1.17 | 21 | 8 | 8 |
| 1.17 to 1.19.4 | 21 | 17 | 17 |
| 1.20 to 1.20.4 | 21 | 21 | 17 |
| 1.20.5 to 1.21.x | 25 | 21 | 21 |
| 26 and newer | 25 | 25 | 25 |

Paper, Purpur and Vanilla follow the Java major Mojang declares: Paper 1.17
refuses anything newer than 17, and older Paper and Purpur builds bundle a
profiler that crashes on Java 25.

Temurin 8 has no Apple silicon build, so Macs with Apple silicon run the x64
build under Rosetta.

A durable creation job stays fenced until the whole modpack and client sync
are configured. Required downloads must match their source hashes and sizes,
including files already present on a retry. Missing or disabled required
downloads keep the job failed and stopped. Optional CurseForge files can be
skipped with a warning. Interrupted installs retry at most three times;
failed jobs stay stopped for inspection. Paper, Purpur and Vanilla servers
get no AutoModpack: players join with a vanilla client.

## Boot-tested versions

These were created through the standalone API and booted to `Done` on
2026-10-30:

| Loader | Linux (2 CPUs, 4 GB) | macOS 27, Apple silicon |
| --- | --- | --- |
| Fabric | 26.3, 1.21.11, 1.21.1, 1.20.1, 1.16.5 | 1.21.1 |
| Forge | 26.3, 1.21.1, 1.20.1, 1.18.2, 1.16.5, 1.12.2 | 1.20.1 |
| NeoForge | 26.3, 1.21.1, 1.20.4, 1.20.1 | 26.3 |
| Quilt | 26.3, 1.21.1, 1.20.1 | |
| Paper | 26.3, 1.21.11, 1.20.1, 1.17.1, 1.16.5, 1.8.8 | 26.3 |
| Purpur | 26.3, 1.21.1, 1.20.1 | |
| Vanilla | 26.3, 1.21.1, 1.20.1, 1.16.5, 1.12.2 | 1.12.2 (x64 Java 8 under Rosetta) |

These boots prove the server starts. They don't run the client or join
tests, which cover only the loaders in the table at the top.

## Before the first revision

You approve two things before a server's first revision: a required launch
guard and managed AutoModpack publication.

The guard checks the locked files and Java before every start, including
starts from Crafty itself. It also keeps a start from racing a pack swap. It
needs Python 3 on the server host.

## Launch recipes

- **Fabric:** an explicit Tools Java path, heap flags, and
  `-jar fabric.jar nogui`. Custom launch recipes are refused.
- **Forge and NeoForge:** the official installer's unchanged argument file
  and an optional heap-only `user_jvm_args.txt`, with Tools Java 21.

## AutoModpack

AutoModpack must be the unmodified 4.0.7 build for that loader and Minecraft
version, with an explicit managed-publication config and self-updating
disabled. Unknown custom mod discovery stays inconclusive, never a feasible
plan.

Forge AutoModpack 4.0.7 cannot publish an empty pack. Restoring a pack that
contains only the AutoModpack bootstrap stops with publication refused.
Spawnpoint does not serve the stale manifest or restore the world.
