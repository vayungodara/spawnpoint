# Supported servers and launch recipes

[Back to the README](../README.md)

## At a glance

| Loader | Create in Spawnpoint | Tested mod changes |
| --- | --- | --- |
| Fabric | Minecraft 1.21.1, loader 0.20.1 | Yes. The client test needs Minecraft 1.20 or newer. |
| Forge | Minecraft 1.20.1, Forge 47.4.28 | Minecraft 1.20.1 with Forge 47.4.28 |
| NeoForge | Minecraft 1.21.1, NeoForge 21.1.219 | Minecraft 1.21.1 with NeoForge 21.1.219 |
| Other server types | Through Crafty Controller | No |

To create other server types, choose Crafty in **Panel settings → Server
runtime**. Other FML recipes are refused by locked revisions.

## Creating servers

Native creation installers are hash-pinned. A durable creation job stays
fenced until the whole modpack and client sync are configured. Required
downloads must match their source hashes and sizes, including files already
present on a retry. Missing or disabled required downloads keep the job
failed and stopped. Optional CurseForge files can be skipped with a warning.
Interrupted installs retry at most three times; failed jobs stay stopped for
inspection.

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
