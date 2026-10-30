# Working on Spawnpoint

The panel is a Node.js/TypeScript server and a React/Vite web app. The independent
supervisor owns native Minecraft processes; Crafty retains unimported servers.
Read `ARCHITECTURE.md` before changing pack tests,
promotion, publication, or process ownership.

## Checks

Run `npm ci` and `npm run build`, then:

```sh
node .github/smoke-boot.mjs
node .github/wizard-e2e.mjs
node .github/native-runtime.mjs
node .github/revision-guard.mjs
node .github/publication-guard.mjs
node .github/solver-test.mjs
node .github/solver-install.mjs
npx oxlint server/src
npm run lint -w web
```

The guard checks run on Linux, macOS, and Windows in CI. They exercise real
processes, file locks, hash drift and TCP listeners, but do not replace the
Crafty/Fabric proof below. The installer checks need Java on `PATH` and use
an isolated layout with controlled catalog/CDN responses. The current
baseline has five server lint warnings and two web lint warnings. Do not
suppress them to make a change look green.
In a seeded orb, prepend the installed `Tools/jdk-21…/bin` directory to
`PATH` for the installer checks. The setup script installs Java there.
Stop the `crafty` container (`sudo docker stop crafty`) before
`native-runtime.mjs` and start it again afterwards: the import contract
treats Crafty listening on 8443 as a running Crafty service and fails.

CI also runs `node .github/native-runtime.mjs --service` on each OS. This
installs and removes a disposable systemd unit, LaunchAgent or SCM service,
and refuses to replace an existing service. It uses Node as the Java stand-in;
it does not replace real Minecraft lifecycle proof. Windows requires an elevated
runner. A Linux system unit uses the current unprivileged account. The test
must start with no runtime directory so fresh service-account permissions are exercised.

## Disposable orb integration environment

`.agents/setup` installs prerequisites, JDKs 25 and 21, HeadlessMC and locked
npm dependencies, then builds the panel. It is safe to rerun. Start supervised
services with `amp orb services ensure`. The `sp` service exposes the panel
through an Amp portal. Use its returned URL for user review.
The disposable `owner` service runs the same packaged supervisor without OS
installation. If testing the real systemd installer, stop `owner` first and do
not run `services ensure` until the system unit is removed. Never run two owners
against one layout.

On a fresh orb only, run:

```sh
SPAWNPOINT_ROOT=/srv/sp AMP_ORB=1 node .github/setup-integration.mjs
amp orb service restart sp
```

The seed script resets only the disposable Crafty admin to a generated
password, connects without printing credentials, and sets panel PIN `814207`.
It refuses an existing connection. Never run it against a real installation.
Never read `.env`, token files, private keys, certificates, or credential
stores. Authenticate test HTTP requests through `POST /api/auth` with the
disposable PIN and keep the session cookie in memory.

The fixture ID is in `/srv/sp/test-server-id`. It has Fabric 1.21.1, loader
0.20.1, AutoModpack 4.0.7, nine server jars, and four additional client-shelf
jars. The seed pins exact Modrinth version IDs. ImmediatelyFast is absent so
the xvfb run can check the real AutoModpack handshake without omitting a mod.
The script boots the fixture once and leaves it stopped. The container name
is `crafty`; mounts and the pinned image digest are in `.amp/services.yaml`.

For Forge acceptance, import a separate disposable Minecraft 1.20.1 server
from the official Forge 47.4.28 installer. Crafty imports ZIPs from
`/srv/sp/Crafty/import/upload/`, not the import root. Wait for Crafty's
`importing` flag to clear before seeding files or starting. Use Tools Java 21,
the unchanged OS argument file and heap-only `user_jvm_args.txt`. Keep a nonempty
baseline: AutoModpack `KcBYU5P0` and FerriteCore `DG5Fn9Sz`. Request Waystones
`Y0IgdaoP`; its Balm dependency is `dDN38ae7`. Require the native server and
client graph to include `automodpack_mod`, not the service-only bootstrap's
outer `automodpack` metadata. The config must explicitly use version 2,
hosting and generation enabled, and `selfUpdater:false`.
Boot and stop this baseline before sealing, as the Fabric seed does, so the
lock includes AutoModpack's expanded defaults. Hash drift on a later live
boot must still refuse publication, even when only config formatting changed.
Keep `broadcast-rcon-to-ops=false`: publication uses Crafty's stdin endpoint
and waits for native console completion. Check interrupted reload and host
start: kill the publisher before acknowledgement, then restart the panel.
Recovery must retain the publication mutex until the old JVM exits and its
lifetime fence can be acquired, then restore exact paused config bytes.

Forge must reach `Done` before the server test passes. A constructor-failing
mod must fail after the EULA check. Repeat the full HTTP consent, promotion,
publication and Undo checks below. Also probe renamed ledger-identified
AutoModpack jars, missing managed config, custom `defaultConfigPath`, changed
`defaultconfigs/`, and a cached Java 17 competing with locked Java 21. Unknown
discovery must yield no feasible witness. A bootstrap-only baseline cannot
publish because AutoModpack rejects empty packs; retain the publication
refusal as a failure, not a successful Undo proof.

## Pack-change acceptance

For pack or lifecycle changes, prove the affected paths on real Crafty and
Fabric before pushing. Do not turn an inconclusive test into a pass.

- Install FerriteCore `bwKMSBhn` (7.0.2-hotfix) over 7.0.3. Confirm the final
  sealed configs pass server, client, join and AutoModpack handshake checks.
  Verify nothing live changes before explicit replacement/config consent.
- Promote Balm `Pz0YXByM` and Waystones `pCpQ1Jxr` together, then request
  Waystones `nSAwjAk4`. It needs Balm `EghJxg4h` because the native mod ID
  changed. Verify that only those two projects change, all requested roots
  remain, and feasibility passes while optimality stays inconclusive with
  the partial provider index. Repeat the full boot, handshake and publication
  checks, including consent and unchanged live bytes before promotion.
- Refuse absent consent, stale-revision approval and altered sealed bytes.
  Tamper a locked config and a shelf mirror while stopped. Direct Crafty
  starts must refuse before Java; publication must reject changed bytes even
  when the manifest is unchanged. Restore the exact bytes after each probe.
- Confirm a stopped-world backup precedes the swap and active/published
  pointers agree only after this boot and exact client pack pass.
- Kill and restart the panel at persisted countdown, stopping, applied and
  rollback stages. Exercise interrupted activation and undo journals,
  including copy-before-unlink and not-yet-started moves.
- Explicitly inject FerriteCore `unerR5MN` (6.0.1 for Minecraft 1.20.1) into
  a sealed ready fixture to force a live boot failure. Label bypassed tests
  skipped/inconclusive, never passed. Verify byte-identical mod and ledger
  rollback and successful baseline publication. Write a world sentinel after
  the backup and confirm pack rollback does not restore the older world.
- Exercise owner-requested Undo through the panel. Inspect the consent and
  revision-report UI at desktop and narrow widths. Record pointer/keyboard
  interactions when they change.
- Keep a separate real 4 GB/2 CPU run: with the live server up, trigger a
  client/join test under memory pressure. It must wait, remain responsive,
  and become inconclusive after ten minutes if memory never becomes
  available. Then stop the server and retry. Record whether the complete
  handshake actually ran. An 8 GB run does not prove this small-box case.

## Delivery

Use the configured noreply git identity. Phase pushes to main require live
proof and a blocker-free `plugins.oracle` review. Subscribe to CI for the
exact pushed SHA and check all OS jobs plus gitleaks. Dependabot PRs #1
through #6 were closed on 2026-10-30, when main's history was rewritten to
remove an old video. Ask the owner before merging or closing new Dependabot
PRs.

There is no production panel in this repository to inspect after a code
push. Rebuild and restart the disposable `sp` service, check `/api/health`,
and verify the shipped lifecycle path there. A website check alone does not
prove the self-hosted panel works. Publishing releases or changing a public
deployment still needs explicit approval.

The site's `worker.js` answers byte-range requests for `/media/*`, because
static assets ignore `Range` and browsers then can't seek the tour video
(Safari won't play it). `wrangler dev` in `site/` runs it locally. After a
site deploy, check that `curl -s -o /dev/null -w '%{http_code}' -H 'Range:
bytes=0-1' https://spawnpoint.vayun.net/media/tour.mp4` prints `206`, then
scrub the tour on a phone.
