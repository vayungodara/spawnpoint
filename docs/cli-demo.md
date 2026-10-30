# An agent session

A real run on the disposable Fabric fixture, on 30 October 2026. A coding
agent got this request:

> Pin FerriteCore to 7.0.2-hotfix on the server. Roll it out if the tests
> pass, then put it back.

The agent used a control token to stage the change and an approve token,
which the owner granted for this task, to approve it. These are the only
commands it ran, with their complete output.

```console
$ spawnpoint status
spawnpoint 0.1.0 · http://127.0.0.1:25570 · 1 server
  B1 Fabric proof  running  0/20 online · cpu 0% · mem 1.1 GB · fabric 1.21.1 · :25565

$ spawnpoint mods add ferrite-core@bwKMSBhn
staged FerriteCore 7.0.2-hotfix-fabric
change collecting: tests start ~12 s after the last edit → spawnpoint change --wait

$ spawnpoint change --wait --timeout 30m
status   needs-approval: approve the listed replacements, removals and config edits before promotion
revision 2026-10-30T19-01-14-091Z-1793387310077
asked    FerriteCore 7.0.2-hotfix-fabric
plan     feasible, fewest changes · 1 replace, 1 config
tests    server passed 11s · client passed 105s
approving:
  - ferritecore-7.0.3-fabric.jar → ferritecore-7.0.2-hotfix-fabric.jar
  - Write config config/ferritecore.mixin.properties
(files and loader lines: spawnpoint change --details)
next     spawnpoint change approve 2026-10-30T19-01-14-091Z-1793387310077 · change retest · change discard

$ spawnpoint change approve 2026-10-30T19-01-14-091Z-1793387310077
approved 2026-10-30T19-01-14-091Z-1793387310077
status   ready: approved; goes live when the server restarts
…
restart  change waits for restart: 0 online → spawnpoint change restart now|when-empty

$ spawnpoint change history -n 2
2026-10-30T19-01-14-091Z-baseline · 61 files · server inconclusive, client inconclusive
2026-10-30T19-01-14-091Z-1793387310077 [active] [published] · 61 files · all 10 passed · approved via API token "a"

$ spawnpoint change undo
error: undo: 1 file(s) leave, 1 come back (change 2026-10-30T19-01-14-091Z)
next: add --yes to undo the last change

$ spawnpoint change undo --yes
undo waiting: undo waits for restart: 0 online → spawnpoint change restart now|when-empty

$ spawnpoint status
spawnpoint 0.1.0 · http://127.0.0.1:25570 · 1 server
  B1 Fabric proof  running  0 online · cpu 25% · mem 19 MB · fabric 1.21.1 · :25565
```

Nobody was online, so the panel restarted the server on its own both times.
It backed up the world first, then checked the live boot and the exact
friend pack before it marked the revision active and published.

In the same run, the first test attempt failed: the client crashed once and
then passed. The CLI reported `client unverified` and offered
`change approve … --accept-gaps`. The agent ran `change retest` instead, and
the retest passed.

The whole session printed about 2.3 KB, roughly 600 tokens. The same reads
as raw API JSON cost 7 to 22 times as much per call, before any polling.
