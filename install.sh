#!/usr/bin/env bash
# Spawnpoint installer — one command from a fresh box to the first-run wizard.
#   curl -fsSL https://raw.githubusercontent.com/vayungodara/spawnpoint/main/install.sh | bash
# Re-runnable: an existing checkout/layout is updated, never clobbered.
# Env overrides: SPAWNPOINT_ROOT (layout dir), SPAWNPOINT_DIR (checkout dir).
set -euo pipefail

say()  { printf '\033[1;32m[spawnpoint]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[spawnpoint]\033[0m %s\n' "$*" >&2; exit 1; }

# ---- prerequisites ---------------------------------------------------------
command -v git >/dev/null 2>&1 || fail "git is required — install it (apt install git / brew install git) and re-run"
command -v curl >/dev/null 2>&1 || fail "curl is required — install it (apt install curl) and re-run"
command -v node >/dev/null 2>&1 || fail "Node.js 22+ is required — https://nodejs.org or 'nvm install 22', then re-run"
command -v npm >/dev/null 2>&1 || fail "npm is required (comes with Node.js 22+)"
NODE_MAJOR=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
[ "$NODE_MAJOR" -ge 22 ] 2>/dev/null || fail "Node.js $(node -v) is too old — Spawnpoint needs 22+ ('nvm install 22' is the quickest fix)"

# ---- layout root -----------------------------------------------------------
# The layout holds everything Spawnpoint manages: Crafty/servers, Shared,
# Tools (JDKs land here automatically), Backups, and the panel's own data.
ROOT="${SPAWNPOINT_ROOT:-$HOME/minecraft}"
case "$ROOT" in *" "*) fail "the layout path must not contain spaces ($ROOT) — Java launch commands are split on them";; esac
# NOTE: everything EXCEPT $ROOT/Spawnpoint — that is the checkout destination
# below, and git refuses to clone into a directory that already has content.
mkdir -p "$ROOT/Crafty/servers" "$ROOT/Shared" "$ROOT/Tools" "$ROOT/Backups" \
  || fail "cannot create the layout under $ROOT — pick a writable SPAWNPOINT_ROOT"

# ---- get the code ----------------------------------------------------------
if [ -f package.json ] && grep -q '"name": *"spawnpoint"' package.json 2>/dev/null; then
  DIR="$(pwd)"
  say "using the checkout at $DIR"
  git pull --ff-only 2>/dev/null || say "note: could not fast-forward this checkout — building what is here"
else
  DIR="${SPAWNPOINT_DIR:-$ROOT/Spawnpoint}"
  if [ -d "$DIR/.git" ]; then
    say "updating the checkout at $DIR"
    git -C "$DIR" pull --ff-only 2>/dev/null || say "note: could not fast-forward — building the existing checkout"
  else
    say "cloning into $DIR"
    git clone --depth 1 https://github.com/vayungodara/spawnpoint "$DIR"
  fi
  cd "$DIR"
fi
mkdir -p "$ROOT/Spawnpoint/data" || fail "cannot create $ROOT/Spawnpoint/data"

# ---- build -----------------------------------------------------------------
say "installing dependencies (a few minutes on first run)"
npm ci
say "building the panel"
npm run build

# ---- start -----------------------------------------------------------------
# the same BOM tolerance loadSettings() has — a PowerShell-written settings
# file really does start with one, and reading the wrong port here would make
# a healthy panel look dead
PORT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$ROOT/Spawnpoint/data/settings.json','utf8').replace(/^﻿/,'')).port||25570)}catch{console.log(25570)}")

# refuse to start a second panel on a taken port: the old process would answer
# the health check and the installer would report success for code that never
# started (and print a pid that is already dead)
if curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"name":"spawnpoint"'; then
  say ""
  say "A panel is already running on port $PORT — the new build is ready but not live."
  say "Restart it to pick this build up, then open http://localhost:$PORT"
  exit 0
fi

LOG="$ROOT/Spawnpoint/data/panel.log"
say "starting the panel (log: $LOG)"
SPAWNPOINT_ROOT="$ROOT" nohup node server/dist/index.js >"$LOG" 2>&1 &
PANEL_PID=$!

for _ in $(seq 1 30); do
  sleep 1
  # liveness first: a crashed child (port taken, bad build) must never be
  # reported as success by someone else's healthy panel
  kill -0 "$PANEL_PID" 2>/dev/null || fail "the panel exited during startup — check $LOG"
  if curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"name":"spawnpoint"'; then
    CODE=$(tr -d '\r\n' < "$ROOT/Spawnpoint/data/setup-code.txt" 2>/dev/null || true)
    say ""
    say "Spawnpoint is running (pid $PANEL_PID)."
    say ""
    say "  Open  http://localhost:$PORT  to finish setup in the browser —"
    say "  the first-run wizard connects Crafty with one admin login."
    if ! curl -fskS "https://localhost:8443" >/dev/null 2>&1; then
      say ""
      say "  Heads up: nothing is answering on https://localhost:8443, so Crafty"
      say "  Controller does not look installed yet. Spawnpoint manages servers"
      say "  THROUGH Crafty — install it first (https://craftycontrol.com), then"
      say "  finish the wizard."
    fi
    # NOTE: an `if`, not `[ … ] && say …` — under set -e a false test would
    # end the script right here, swallowing the hints below
    if [ -n "$CODE" ]; then say "  Setting up from another device? Setup code: $CODE"; fi
    say ""
    say "  stop:    kill $PANEL_PID"
    say "  start:   SPAWNPOINT_ROOT=\"$ROOT\" node \"$DIR/server/dist/index.js\""
    say "  (tip: wrap that start command in a systemd unit or login item to run on boot)"
    exit 0
  fi
done

kill "$PANEL_PID" 2>/dev/null || true # don't orphan a panel we can't confirm
fail "the panel did not answer on port $PORT within 30s — check $LOG"
