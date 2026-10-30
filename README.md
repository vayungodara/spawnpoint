<h1 align="center">Spawnpoint</h1>

<p align="center">
  <b>Add mods to your Minecraft server, test them on a copy first, and give your friends exactly the version that passed.</b>
</p>

<p align="center">
  <img alt="Status: alpha" src="https://img.shields.io/badge/status-alpha-e9c53e?style=flat-square">
  <a href="https://github.com/vayungodara/spawnpoint/actions/workflows/ci.yml"><img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/vayungodara/spawnpoint/ci.yml?branch=main&style=flat-square&label=ci"></a>
  <img alt="Runs on Linux, macOS and Windows" src="https://img.shields.io/badge/runs%20on-Linux%20%C2%B7%20macOS%20%C2%B7%20Windows-262b33?style=flat-square">
  <img alt="Node.js 22 or newer" src="https://img.shields.io/badge/node-22%2B-262b33?style=flat-square">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-4ec97a?style=flat-square"></a>
</p>

<p align="center">
  <a href="https://spawnpoint.vayun.net/media/tour.mp4"><img src="docs/screenshots/tour.webp" width="820" alt="Spawnpoint: Add mods. Test them on a copy. Then let friends in. Watch the 90-second tour."></a>
</p>

<p align="center">
  <a href="https://spawnpoint.vayun.net/media/tour.mp4"><b>Watch the 90-second tour</b></a>
  ·
  <a href="https://spawnpoint.vayun.net">Website</a>
  ·
  <a href="#quick-start">Quick start</a>
  ·
  <a href="#documentation">Docs</a>
  <br>
  <sub>Recorded on a real server: create it, add a mod, approve, go live, a friend joins.</sub>
</p>

## Quick start

On Linux or macOS, run this as the normal user that will own your servers
(not root):

```bash
curl -fsSL https://raw.githubusercontent.com/vayungodara/spawnpoint/main/install.sh | bash
```

When it finishes, it prints a setup link with a one-time code:

```text
http://localhost:25570/setup#code=…
```

Open it on that machine, or go to `http://<server-address>:25570` from
another device and enter the code. Pick a PIN and create your first server.
Java downloads itself the first time a server needs it.

You need Node.js 22+, Python 3 and git, plus `zip` and `unzip` on Linux.
Windows, manual installs and updating are in [docs/install.md](docs/install.md).

> [!WARNING]
> Spawnpoint is alpha. Expect rough edges, and keep backups of worlds you
> care about.

## Why Spawnpoint

Adding a mod to a modded server usually means changing the live server,
restarting, and hoping everyone can still join. Spawnpoint tries the change
on a copy first. It checks the whole pack's dependencies, boots a copy of
the server, and on AutoModpack servers starts a real Minecraft client that
joins it. Your live server and your friends' pack only change after the
test passes, or after you've approved what couldn't be tested.

On my Linux server it reached health OK in 0.56 s, using about 60 MB
(panel only, game servers stopped).

- **Mods and plugins from Modrinth and CurseForge.** Dependencies are
  resolved for the whole pack, keeping your existing versions where
  possible.
- **Mod changes tested on a copy.** A server boot, then a real client that
  joins with the files your friends would get (Fabric, Forge and NeoForge;
  see [supported servers](#supported-servers)).
- **Friends stay in sync.**
  [AutoModpack](https://modrinth.com/mod/automodpack) means they install
  one starter pack once and get every later change when they join.
- **See what was tested.** Each change shows what passed, failed, was
  skipped or is uncertain. *Undo last change* puts back the files a change
  replaced, for the last five changes.
- **Servers keep running when the panel stops.** A separate OS service owns
  Java and the console on Linux, macOS and Windows.
- **Already on Crafty Controller?** Keep using it, or import stopped servers
  one at a time.

Also included: new servers from modpacks, a config editor, world slots,
nightly world backups (only when the world changed; newest three kept), a
file manager and console, TPS and memory monitoring, scheduled restarts, an
in-game status bar, idle shutdown, chunk pre-generation, a storage cleaner,
and an optional chat genie.

Each server opens in its own workspace with **Overview**, **Console**,
**Changes**, **Mods** (or **Plugins**), **Players**, **Worlds**,
**Automation**, **Files** and **Server** tabs. Panel-wide options, such as
the PIN and the server runtime, live in **Panel settings**.

![A server's Overview on desktop and on a phone: the latest mod change passed every step from plan to friend sync](docs/screenshots/overview.webp)

## How a change goes live

Each server's **Overview** follows the open change through these steps:

1. **Plan.** A whole-pack dependency check against your Minecraft, loader
   and Java versions. Downloads must match their declared hashes.
2. **Server boot.** A sandbox boots your server's loader with the new mods.
3. **Client join.** On AutoModpack servers, a real Minecraft client boots
   with your friends' files, joins a throwaway copy and runs AutoModpack's
   handshake.
4. **Your approval.** Replacements, removals, config edits and anything
   that couldn't be fully tested wait for you in a review sheet.
5. **Restart.** Mods only change while the server is stopped. With nobody
   online it restarts on its own; with players online, you choose when.
   The world is backed up first.
6. **Friends synced.** AutoModpack serves the new pack only after the live
   boot passes and the published files match.

If the live boot or publication fails, the pack rolls back and the server
starts without the change. Pack rollback doesn't touch the world.

![Review sheet: the plan, both test results, and the config edit waiting for approval](docs/screenshots/review.webp)

More detail, including memory needs and what happens when a test can't run:
[docs/testing.md](docs/testing.md).

## Supported servers

| Loader | Create in Spawnpoint | Tested mod changes |
| --- | --- | --- |
| Fabric | 1.21.1, loader 0.20.1 | Yes (client test on 1.20+) |
| Forge | 1.20.1, Forge 47.4.28 | 1.20.1 with 47.4.28 |
| NeoForge | 1.21.1, NeoForge 21.1.219 | 1.21.1 with 21.1.219 |
| Other server types | Through Crafty Controller | No |

Launch recipes and AutoModpack requirements: [docs/recipes.md](docs/recipes.md).

## Requirements

- Linux, macOS or Windows
- Node.js 22 or newer and Python 3
- On Linux, `zip` and `unzip` for world backups, and optionally `xvfb` so
  the client test can render on a headless machine
- Enough free memory for tests: about 1 GB for the server test and 2 to
  8 GB for the join test, depending on the mods. Tests wait instead of
  starving the live server.
- Optional: Crafty Controller on the same machine

## Remote access

Keep port 25570 off the public internet. To use the panel from your phone
or away from home, join the machine to [Tailscale](https://tailscale.com)
and run `sudo tailscale serve --bg 25570` for a private HTTPS address. Full
steps: [docs/remote-access.md](docs/remote-access.md).

## Security

- Keep the panel on your LAN or a VPN. Don't expose port 25570 to the
  internet.
- Every API call except health, PIN unlock and first-run setup needs a PIN
  session or the admin token. There is no trusted local address.
- Forward only the game port. The panel turns on RCON at the game port plus
  10000 with a random password, and Minecraft binds it to every interface.

Details, including the admin token and the chat genie's limits:
[docs/security.md](docs/security.md).

## Documentation

| Page | What's in it |
| --- | --- |
| [Install and update](docs/install.md) | The installer, first-run setup, manual and Windows installs |
| [How mod changes are tested](docs/testing.md) | Tests, approvals, going live, rollback, memory and display |
| [Supported servers](docs/recipes.md) | Loader versions, launch recipes, the launch guard, AutoModpack |
| [The supervisor](docs/supervisor.md) | The OS service on Linux, macOS and Windows |
| [Crafty Controller](docs/crafty-import.md) | Keeping Crafty or importing servers from it |
| [Remote access](docs/remote-access.md) | Phones and remote use over Tailscale |
| [Security](docs/security.md) | Auth, RCON, the admin token, the chat genie |
| [Architecture](ARCHITECTURE.md) | How the parts fit together |

## Development

```bash
npm ci
npm run dev:server   # API on :25570
npm run dev:web      # Vite dev server, proxies /api
```

- `server/`: Fastify and TypeScript API; serves the built web app on :25570
- `web/`: Vite, React and Tailwind frontend
- `site/`: the landing page, deployed as a Cloudflare Worker
- `data/` (under the layout's `Spawnpoint/`): runtime state and secrets,
  never committed

The checks CI runs are listed in [AGENTS.md](AGENTS.md#checks).

## License

[MIT](LICENSE)
