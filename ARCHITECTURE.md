# Spawnpoint architecture

Spawnpoint is a Fastify and TypeScript API with a Vite and React frontend. It
runs next to [Crafty Controller](https://craftycontrol.com/): Crafty starts,
stops and supervises the Minecraft processes, and Spawnpoint handles
everything around them (content, configuration, testing, backups, in-game
features). If you remove Spawnpoint, your servers keep running in Crafty.

```
┌─────────────┐   HTTP    ┌──────────────┐   API + token   ┌────────────────┐
│ web (React) │ ────────▶ │ server       │ ──────────────▶ │ Crafty         │
│ :25570      │           │ (Fastify)    │                 │ Controller     │
└─────────────┘           │              │   RCON          │  └─ MC servers │
                          │              │ ──────────────▶ │                │
                          └──────────────┘                 └────────────────┘
```

## Code layout

- `server/src/index.ts`: app setup, the auth hook, background watchers
- `server/src/auth.ts`: PIN hashing, sessions, the admin token, throttling
- `server/src/routes/`: HTTP routes, one file per area; routes stay thin
- `server/src/services/`: the logic
- `server/src/clients/`: Crafty, Modrinth, CurseForge and RCON clients
- `web/src/pages/`: one file per panel page; pages other than Servers load
  on first visit
- `data/` (under the layout's `Spawnpoint/`): runtime state and secrets

## Access

Every `/api` route needs a PIN session cookie or the admin token
(`data/admin-token`), except `/api/health`, `/api/auth`, `/api/auth/check`
and the setup wizard. The check runs once, in an `onRequest` hook, on the
matched route rather than the raw URL. The same hook refuses cookie-carrying
writes from another origin and rejects any `/api/servers/:id` request whose
id is not a UUID, since ids become folder paths. File routes resolve real
paths and refuse anything outside the server folder.

The setup wizard is open until the panel has a Crafty token and a PIN. Its
two write routes need the setup code printed by the installer and the panel
log.

## Mod changes are transactions (`packtxn.ts`)

Installs, updates, dependency fixes and jars uploaded into `mods/` do not
write to the server. They download into one candidate per server
(`data/candidates/<id>/`). Twelve seconds after the last addition, the
candidate is tested:

1. **Whole-pack solver** (`solver/`, Fabric and certified Forge and NeoForge profiles):
   reads native dependency ranges, breaks, provides aliases, nested jars and
   environment scopes. The catalog
   loads complete compatible Modrinth or paginated CurseForge domains and
   verifies artifact hashes and size. The bounded search minimizes changes
   to the original live inventory while retaining requested projects and
   exact owner pins. Unidentified local jars are immutable requested roots.
   New owner requests reconcile the complete staged jar overlay, preserving
   config proposals and explicit removals or disables. Before tests, the
   sealed inventory must match the complete solver witness. Approval and
   promotion both require this check to pass for that exact revision.
   Owner consent cannot override an inventory mismatch.
2. **Server boot test** (`preflight.ts`): a sandbox gets the locked loader,
   libraries, configs and copies of the candidate's jars. Fabric uses
   `eula=false`, resolves dependencies, applies mixins and runs mod
   initialisers before the EULA check. Forge and NeoForge initialize after that
   check, so they must reach `Done` in a fresh flat world on a loopback-only ephemeral
   port, then stop before configs are captured. Native metadata determines
   client-only placement. Crash text and filenames cannot authorize moving
   a mod to the client shelf or guessing a dependency. Other loaders are
   not supported by locked revisions yet.
3. **Client test** (`launchgate.ts`, Fabric and certified Forge and NeoForge AutoModpack revisions):
   HeadlessMC boots the matching Minecraft version and loader version with
   the files a player would receive, then quick-plays into a throwaway copy
   of the server on port 25999. A crash, a failed join or a kick fails the
   test. On supported AutoModpack servers the join also runs AutoModpack's handshake
   against the throwaway server (trusting only its certificate) and compares
   the files the client ends up with against the tested set by path, size
   and SHA-1. After the handshake, SHA-512 checks cover both client locations,
   the bootstrap jar and unexpected executable inputs. The observed game JVM
   must use the locked Java executable, even when HeadlessMC has other cached
   JREs. No handshake evidence means `unverified`, never `passed`.

The catalog's mod-id provider index is partial: observed jar metadata, slug
lookups and search hits discover candidates but cannot prove absence. The
solver returns `ok` only when minimum changes are proved. An `inconclusive`
result can carry a complete feasible `tentative` plan with an optimality
warning. The installer may stage that plan, but retests retain its original
live basis and the report keeps feasibility and optimality separate. Limits
without a complete witness stage nothing. CurseForge file IDs are exact,
and disabled API downloads require manual work without cross-source swaps.

Typed automatic repairs (`repairs.ts`) change one coherent candidate plan
before repeating its tests. The native solver supplies missing libraries.
A wrong-loader upload needs an exact hash-verified source and a compatible
build from the same project with the same native mod identities. An installed
compatible build takes precedence over an upgrade. Exact owner pins cannot
be substituted. Automatic deduplication removes only byte-identical top-level
jars in the same server or client-shelf scope. Shared nested IDs and aliases
are not duplicates.

A Java repair needs an `UnsupportedClassVersionError` naming one class whose
header matches the reported version in the candidate. Fabric can propose
Tools Java 21 or 25. Both certified FML recipes remain on Java 21. The proposal
preserves Minecraft and loader versions and leaves the live command unchanged
until consented promotion. Activation, Undo, and interrupted recovery switch
the exact locked command under the stopped revision fence.

The candidate persists at most three repairs and refuses a repeated inventory.
Its repair record, file overlay, and proposed Java commit in one atomic
manifest write. Superseded staged bytes remain until that write succeeds.
Automatic repairs refuse to overwrite different staged bytes at the same
filename. Wrong-loader planning checks at most eight builds with 128 MB of
downloads and a 60-second planning deadline. Limits and uncertain evidence
leave the candidate for review. All repaired candidates require exact-revision
owner consent before promotion.

Each test returns `passed`, `failed` or `unverified`:

- All passed: replacements, removals and config edits still require explicit
  owner consent for that exact revision. A candidate then becomes `ready`
  and waits for a verified restart (see Promotion). Journaled swaps retain
  replaced pack files in `data/revisions/<id>/<txn>/` (five kept).
- Failed: before blaming the change, the same test runs on the live set
  without it. If the live set passes, the candidate is deleted and recorded
  in the rejection history. If the live set fails too, the change was not
  the cause and the candidate waits for the owner.
- Unverified (no JDK yet, unsupported loader, the test client could not
  start, the join could not run): the candidate waits for the owner to
  apply or discard it.

Fabric removals and disables use the same tested candidate and consent flow.
They are also refused when another installed mod declares the jar as a dependency.

Client tests wait while anyone is online on any server, and run one at a
time under `nice`. Every test JVM first waits (up to 10 minutes, then
`unverified`) until `MemAvailable` minus the memory promised to other
running tests covers it (`withMemory` in `platform.ts`): 1 GB for the
server test; 1, 2 or 4.5 GB for the client test and 2, 3.5 or 8 GB for the
join, by mod count (up to 50, up to 150, more). On a 4 GB machine a client
test next to the live server and a server copy otherwise gets the panel
OOM-killed.

## Revision locks (`revisions.ts`)

`data/locked-revisions/<id>/<revision>/` holds immutable copied inputs,
`lock.json`, and a mutable `report.json`. The lock records Minecraft, loader
and loader version, the exact launch command, Java's executable and native
runtime inputs, and each pack file's path, side, SHA-512, size and source IDs.
Requested mods and dependency projects have separate lists. SHA-1 is retained
only for AutoModpack's manifest protocol. `state.json` distinguishes the
active pack from the published pack.

Only pack-owned roots can enter a lock or move journal. Worlds, credentials,
and Java trust stores are excluded. Generated test configs are staged as
proposals, resealed and retested, at most three times. The owner reviews the
before/after bytes before approving config writes. Report entries retain
passed, failed, skipped or inconclusive results and their renderer. An
observed rollback baseline is explicitly not a client-certified revision.

The owner must first approve the mandatory Crafty launch guard and managed
publication. Locked revisions currently accept Fabric's explicit Tools Java
command with heap flags and `-jar fabric.jar nogui`, or the certified Forge
1.20.1/47.4.28 and NeoForge 1.21.1/21.1.219 installers' exact OS argument files
and heap-only user arguments. The NeoForge recipe requires Java 21.
An explicit locked Java 21 path remains valid after Java 25 is downloaded.
Both FML loaders seal `defaultconfigs/` and refuse custom `defaultConfigPath`
values. NeoForge dependency overrides and artifacts competing with its bundled
MixinExtras or coremods libraries return inconclusive rather than a feasible
solver witness. Unknown discovery services also prevent a feasible witness.
Unsupported loaders and custom recipes are refused before adoption, not
treated as verified.
Direct config, pack, import or runtime edits cannot bypass an active lock.
World restore remains a separate owner-approved operation.

`launchguard.py` is copied into the server and packaged with the panel. It
checks the locked command, runtime, complete file inventory and hashes before
launching Java, even when Crafty starts it outside Spawnpoint. The guard and
stopped swaps share an OS fence for the entire JVM lifetime. Unix inherits
the locked descriptor through `exec`; Windows inherits an exclusive-share
file handle and uses a kill-on-close Job Object. A persisted mutation marker
blocks starts until interrupted journals are recovered. Python 3 must exist
on the Crafty host.

## Promotion (`promote.ts`)

Server mods only change while the server is stopped. A `ready` candidate, or
an undo while the server runs, gets a promotion record in
`data/promotions/<id>.json`, polled every 15 seconds only while one exists.
A `ready` candidate names its immutable revision and keeps the SHA-1 of every
tested client file for AutoModpack's protocol. Further candidate changes
invalidate its approval and test results.

- Running, RCON `list` says empty twice in a row: restart now. Without an
  RCON answer the count is unknown and the panel never restarts on its own.
- Running, players online: one chat warning, then the owner's choice. `now`
  counts down 30 seconds; `when-empty` waits for the server to empty.
- Stopped: the change goes in on the next start from the panel (Start,
  Restart, scheduled start or restart, config restart). These all go
  through `startServer` / `restartServer`; a server started outside the
  panel runs the old mods and gets the change on its next restart.

With the server confirmed stopped and the OS fence held, promotion backs up
the world before applying or undoing the pack. It checks source hashes and
journals every pack move and the ledger. Rollback restores locked pack files
and configs but never restores the world backup.

The record carries a stage, so a panel restart resumes it: `countdown`
(released, the stop never happened), `stopping` (stop, then apply or undo
that exact transaction), `applied` (start, wait up to 10 minutes for this
boot to prove it is up, then compare AutoModpack's manifest from this
start with the stored hashes). Proof of the boot is strict: RCON answers,
or without RCON the server's `logs/latest.log` is newer than the start and
contains `Done`; unavailable logs never count. If the server does not come
up, or a tested change's pack differs from the stored hashes (or no fresh
manifest appears within a minute of the boot), exactly that
transaction is undone, the server is started again, and the candidate is
rejected with the reason (the loader's last `- Mod '…'` line, or the
differing files). While a stage is set, installs, discards, undos, undo
cancels, crash sweeps and file writes on that server are refused.

Maintenance is one fence per server in `data/maintenance.json`
(`{op, since, pid, note}`). `beginMaintenance` refuses while another
operation holds it; `endMaintenance` only ends the caller's own. Starts
and restarts from the dashboard, the scheduler, config changes and the
dependency doctor go through `startServer` / `restartServer`, which refuse
a fenced server; the background watchers skip fenced servers. An entry
from an earlier panel process, or one with a `note` (an apply or undo that
could not be rolled back), is `interrupted`: starts, stops and other
operations return 409 until the owner clears it on the dashboard.

### Display modes for the client test

- `xvfb`: Linux with `xvfb-run` installed renders on a virtual display.
- `window`: macOS, Windows or a Linux desktop open a small real window.
- `headless`: anything else runs with HeadlessMC's stubbed LWJGL. Mod
  loading, mixins and init are tested; rendering is not, and the verdict
  says so.

## Client sync

New modded servers get AutoModpack (pinned to its 4.x release line, since
client and server must run the same line) and a config that requires it on
clients. Client-only mods live on a shelf (`data/clientmods/<id>/`);
`publishPack` mirrors the shelf into AutoModpack's extras folder and asks
the server to regenerate the pack. The starter pack a friend imports carries
the server's own AutoModpack build and loader version.

On a locked revision, hosting stays off in the on-disk startup configuration.
After fresh boot proof, `packCheck` compares the manifest with the promoted
client inventory and SHA-512-checks the actual served bytes, including shelf
mirrors. Only then does `releaseHosting` reload the enabled configuration and
start the host through Crafty's console, waiting for each command's terminal
log acknowledgement. RCON returns before AutoModpack's asynchronous commands
finish, and disabled RCON broadcasts hide their later feedback. One open,
non-reconnecting RCON session checks that publication stays on the same boot.
A shared publication mutex prevents a concurrent direct start from exposing
an unverified pack. On ambiguous completion or publisher death, recovery
stops the old JVM and acquires its lifetime fence before restoring paused
bytes and releasing the mutex. Failure rolls the pack back.

## Chat genie (optional)

Players on the genie list type `server <wish>` in chat. The panel runs
Claude Code (`claude -p`) with no tools, no MCP servers and a whitelisted
environment, as `nobody` when the panel runs as root. The model replies in
a line protocol (commands, `SAY`, `DONE`); the panel runs the commands over
RCON, reads the world back, and challenges a `DONE` that the evidence does
not support. Admin commands are blocked unless `commandPolicy` is `full`.
The genie only runs (and keeps a warm process) while it is enabled, has a
credential, and a player is online on an opted-in server.

## Background watchers

Started once in `index.ts`: idle shutdown, in-game status bar, automatic
backups, the genie, death insurance, the dependency doctor (reads crash
logs and fixes missing dependencies through a candidate), player triggers,
scheduled tasks, TPS sampling, the chunk pre-generation watcher, crash
recovery after a reboot, and a Crafty watchdog. Crafty calls are cached
briefly (server list 10 s, stats 2 s) and shared between watchers.

## Self-guarding restarts

`POST /api/admin/exit` (used by deploy scripts) refuses with 409 while a
wish, a server creation or a candidate test is running, unless the body has
`"force": true`.
