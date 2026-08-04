# Spawnpoint architecture

Spawnpoint is a Fastify + TypeScript API with a Vite/React frontend, sitting in
front of [Crafty Controller](https://craftycontrol.com/). Crafty owns the
Minecraft processes (start/stop/supervise); Spawnpoint owns everything around
them — content, configuration, verification, backups, and the player-facing
niceties. The panel is deliberately a *companion*, not a replacement: if you
delete Spawnpoint tomorrow, your servers still run.

```
┌─────────────┐   HTTP    ┌──────────────┐   API+token   ┌────────────────┐
│ web (React) │ ────────▶ │ server       │ ────────────▶ │ Crafty         │
│ :25570      │           │ (Fastify)    │               │ Controller     │
└─────────────┘           │              │   RCON        │  └─ MC servers │
                          │              │ ────────────▶ │                │
                          └──────────────┘               └────────────────┘
```

## Layout

- `server/src/routes/` — HTTP surface, one file per area
- `server/src/services/` — all real logic; routes stay thin
- `server/src/clients/` — Crafty API client (token from `Shared/crafty-token.txt`)
- `web/src/pages/` — panel UI
- `data/` — runtime state, ledgers, and secrets; never committed

## The verification pipeline

The core idea: **a change to a server is unproven until a real Minecraft
process has survived it.** Four gates, cheapest first:

1. **Static dependency scan** (`jardeps.ts`) — every jar's declared mandatory
   dependencies (fabric.mod.json, mods.toml, nested jar-in-jar) are parsed in
   ~1s. Missing ids are resolved against Modrinth and installed *before* the
   first boot test. This gate never rejects on its own — it only heals; the
   boot test remains the authority.
2. **Server dry-boot** (`preflight.ts`) — installs are batched, then the whole
   batch is boot-tested in a sandbox copy with the real loader. Failures are
   parsed from the loader's own error output; the named culprit is rolled
   back (or, if the loader blames a client-only mod, that jar is shelved to
   the client-side pack and the batch retries).
3. **Headless client boot** (`launchgate.ts`) — the full pack is launched in a
   real headless Minecraft client, catching client-side crashes server-side.
4. **Multiplayer join gate** — a throwaway clone of the server is booted and a
   real client actually joins it, because some mods only break at the moment
   a player connects. A join kick names its culprit; the panel quarantines
   it, rebuilds the pack, and re-runs every gate.

Two invariants keep the gates honest:

- **Sync-after-verdict.** The client modpack (AutoModpack) is synchronized to
  players only *after* a verdict — a pass ships the jars, a rollback ships
  the removals. Never at install time: an unproven jar that reaches a
  player's client and crashes it at boot cannot be fixed remotely, because
  the crash happens before the sync mod can run.
- **Verdict fidelity.** Boot tests use fast-boot JVM flags that change speed,
  never behavior (tiered-compilation cap, parallel GC). Anything that could
  make the test lie — skipping bytecode verification, sandbox-only
  performance mods — is rejected on principle.

Gates wait until zero players are online across all servers (checked twice,
minutes apart, re-checked before the join phase), and a manifest hash lets an
unchanged pack skip re-gating entirely.

## Client sync

AutoModpack is provisioned automatically on modded servers: server-side jars,
a per-loader client comfort kit (performance mods, conflict-aware), and
client assets. Resource packs and shaders are first-class content: they land
in the host pack, sync to clients, and are force-copied to the client's real
folders so they appear in the vanilla UI.

## The chat genie (optional)

An in-game AI concierge: players type a wish in chat, the genie translates it
into commands, executes them over RCON, then **reads the world back to verify
before claiming success**. Design points:

- The engine is a CLI subprocess (Claude Code), spoken to over a strict text
  protocol — which is what makes alternative engines pluggable.
- Two model tiers: a fast default, with escalation to a stronger model for
  wishes that need planning.
- Bounded memory: per-server notes, episodic memory (top matches injected),
  and a remedies ledger — all size-capped so prompts stay flat over time.
- Off by default. Bring your own subscription token or API key.

## Self-guarding operations

- Deploys go through `POST /api/admin/exit`, which **refuses (409)** while a
  genie wish, server-creation job, launch gate, preflight batch, or mod
  download is in flight.
- A daily janitor removes orphaned public-address lanes, provisions missing
  ones, and repairs file-ownership drift in server directories.
- Failure classes get self-healing watchers rather than user-facing noise.

## Public addresses (optional)

With a relay host and DNS credentials configured, every server automatically
gets a public `name.your-domain` join address (SRV records, no port to
remember). Without them, servers are LAN/VPN-only and everything else works.

## Cross-platform honesty

The gates need a display, and there are three answers to that:

- **Headless Linux + `xvfb-run`** — the client boots invisibly in a virtual
  framebuffer.
- **macOS / Windows / a Linux desktop** — *visible-window mode*: the real
  verification client opens as a small window on the desktop for a few
  minutes, announced in the panel log so nobody closes it mid-verdict. Same
  client, same fidelity, purely cosmetic cost.
- **A display-less box that isn't Linux** — the client and join gates **skip
  with an honest "not verified" verdict** rather than pretending to pass.
  The static scan and server dry-boot run everywhere regardless.

A stubbed-GL "headless anywhere" mode was considered and rejected: stubbed
rendering can mask or invent render-init crashes, which makes the test lie —
the same reason the boot gates refuse `-Xverify:none`.
