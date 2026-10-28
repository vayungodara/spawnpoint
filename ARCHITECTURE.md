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

1. **Dependency scan** (`jardeps.ts`): reads each jar's declared mandatory
   dependencies (`fabric.mod.json`, `mods.toml`, nested jars). Missing ids
   are installed from Modrinth into the candidate.
2. **Server boot test** (`preflight.ts`): a sandbox gets the server's loader
   and libraries, hard links (or copies) of the candidate's jars, and
   `eula=false`. The loader resolves dependencies, applies mixins and runs
   mod initialisers, then stops at the EULA check. Missing ids named by the
   loader are installed and the test repeats; a client-only mod that crashes
   the server is moved to the client shelf.
3. **Client test** (`launchgate.ts`, AutoModpack servers, Fabric and Forge):
   HeadlessMC boots the matching Minecraft version and loader version with
   the files a player would receive, then quick-plays into a throwaway copy
   of the server on port 25999. A crash, a failed join or a kick fails the
   test.

Each test returns `passed`, `failed` or `unverified`:

- All passed: the candidate is applied. Replaced files move to
  `data/revisions/<id>/<txn>/` (five kept), staged files move into `mods/`
  or the client shelf, the install ledger is updated, and only then is the
  AutoModpack pack regenerated.
- Failed: before blaming the change, the same test runs on the live set
  without it. If the live set passes, the candidate is deleted and recorded
  in the rejection history. If the live set fails too, the change was not
  the cause and the candidate waits for the owner.
- Unverified (no JDK yet, unsupported loader, the test client could not
  start, the join could not run): the candidate waits for the owner to
  apply or discard it.

Removing or disabling a jar is not boot-tested; instead it is refused when
another installed mod declares it as a dependency.

Client tests wait while anyone is online on any server, and run one at a
time under `nice`.

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
