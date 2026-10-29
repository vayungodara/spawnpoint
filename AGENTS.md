# Working on Spawnpoint

The panel is a Node.js/TypeScript server and a React/Vite web app. Crafty owns
the Minecraft processes. Read `ARCHITECTURE.md` before changing pack tests,
promotion, publication, or process ownership.

## Checks

Run `npm ci` and `npm run build`, then:

```sh
node .github/smoke-boot.mjs
node .github/wizard-e2e.mjs
node .github/revision-guard.mjs
npx oxlint server/src
npm run lint -w web
```

The guard checks run on Linux, macOS, and Windows in CI. They exercise real
processes, file locks, hash drift and TCP listeners, but do not replace the
Crafty/Fabric proof below. The current baseline has five server lint warnings
and two web lint warnings. Do not suppress them to make a change look green.

## Disposable orb integration environment

`.agents/setup` installs prerequisites, JDKs 25 and 21, HeadlessMC and locked
npm dependencies, then builds the panel. It is safe to rerun. Start supervised
services with `amp orb services ensure`. The `sp` service exposes the panel
through an Amp portal. Use its returned URL for user review.

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

## Pack-change acceptance

For pack or lifecycle changes, prove the affected paths on real Crafty and
Fabric before pushing. Do not turn an inconclusive test into a pass.

- Install FerriteCore `bwKMSBhn` (7.0.2-hotfix) over 7.0.3. Confirm the final
  sealed configs pass server, client, join and AutoModpack handshake checks.
  Verify nothing live changes before explicit replacement/config consent.
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
exact pushed SHA and check all OS jobs plus gitleaks. Do not modify the
deliberately open Dependabot PRs #1 through #6.

There is no production panel in this repository to inspect after a code
push. Rebuild and restart the disposable `sp` service, check `/api/health`,
and verify the shipped lifecycle path there. A website check alone does not
prove the self-hosted panel works. Publishing releases or changing a public
deployment still needs explicit approval.
