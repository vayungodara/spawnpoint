#!/usr/bin/env bash
# Spawnpoint installer: one command from a fresh Linux or macOS box to the
# first-run wizard.
#   curl -fsSL https://raw.githubusercontent.com/vayungodara/spawnpoint/main/install.sh | bash
# Re-runnable: an existing checkout and layout are updated, never clobbered.
# Env overrides: SPAWNPOINT_ROOT (layout dir, default ~/minecraft),
# SPAWNPOINT_DIR (checkout dir), SPAWNPOINT_RUNTIME=crafty (keep an existing
# Crafty service), SPAWNPOINT_NO_OPEN=1 (don't open a browser), NO_COLOR=1.
# Written for bash 3.2 too, because that is what macOS ships.
set -euo pipefail

START=$SECONDS
OS=$(uname -s)
LOG=$(mktemp "${TMPDIR:-/tmp}/spawnpoint-install.XXXXXX")

# ---- look ------------------------------------------------------------------
# Colour and glyphs only on a real UTF-8 terminal; plain text everywhere else.
TTY=0; [ -t 1 ] && TTY=1
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in *UTF-8*|*utf8*|*UTF8*|*utf-8*) U=1 ;; *) U=0 ;; esac
[ "$OS" = Darwin ] && U=1 # Terminal and iTerm are UTF-8 even when LANG is unset
if [ "$TTY" = 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != dumb ]; then
  G=$'\033[38;5;78m'; Y=$'\033[38;5;221m'; R=$'\033[38;5;203m'; D=$'\033[2m'; B=$'\033[1m'; X=$'\033[0m'
else
  G=; Y=; R=; D=; B=; X=
fi
if [ "$U" = 1 ]; then OK='✓'; WARN='!'; NO='✗'; DOT='◆'; FRAMES=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
else OK='ok'; WARN='!'; NO='x'; DOT='*'; FRAMES=('-' '\' '|' '/'); fi

took() { local s=$1; if [ "$s" -ge 60 ]; then printf '%dm %02ds' $((s / 60)) $((s % 60)); else printf '%ds' "$s"; fi; }
head_() { printf '\n%s%s%s %s%s%s\n' "$G" "$DOT" "$X" "$B" "$1" "$X"; }
ok()    { printf '  %s%s%s %s\n' "$G" "$OK" "$X" "$1"; }
note()  { printf '  %s%s%s %s\n' "$Y" "$WARN" "$X" "$1"; }
say()   { printf '    %s\n' "$1"; }
fix()   { printf '    %s$%s %s\n' "$D" "$X" "$1"; }
die() {
  printf '\n  %s%s%s %s%s%s\n' "$R" "$NO" "$X" "$B" "$1" "$X" >&2
  shift
  local line; for line in "$@"; do printf '    %s\n' "$line" >&2; done
  printf '\n    %sFix that, then run the same install command again. It picks up where it stopped.%s\n\n' "$D" "$X" >&2
  exit 1
}

# run LABEL CMD...: CMD's output goes to the log; the screen shows a spinner,
# then a tick and the time it took. On failure the last log lines are shown.
run() {
  local label=$1 t0=$SECONDS pid rc=0 i=0; shift
  printf '\n== %s\n' "$label" >>"$LOG"
  if [ "$TTY" = 1 ]; then
    "$@" >>"$LOG" 2>&1 </dev/null &
    pid=$!
    while kill -0 "$pid" 2>/dev/null; do
      printf '\r  %s%s%s %s %s%s%s ' "$G" "${FRAMES[$((i % ${#FRAMES[@]}))]}" "$X" "$label" "$D" "$(took $((SECONDS - t0)))" "$X"
      i=$((i + 1)); sleep 0.1
    done
    wait "$pid" || rc=$?
    printf '\r\033[K'
  else
    "$@" >>"$LOG" 2>&1 </dev/null || rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    printf '  %s%s%s %s\n' "$R" "$NO" "$X" "$label" >&2
    tail -n 12 "$LOG" | sed 's/^/      /' >&2
    return "$rc"
  fi
  printf '  %s%s%s %s %s%s%s\n' "$G" "$OK" "$X" "$label" "$D" "$(took $((SECONDS - t0)))" "$X"
}

# ---- banner ----------------------------------------------------------------
if [ "$U" = 1 ]; then
  printf '\n  %s▐▀▀▀▄%s\n' "$G" "$X"
  printf '  %s▐▀▀▀%s   %sSPAWNPOINT%s\n' "$G" "$X" "$B" "$X"
  printf '  %s▐%s      %sa Minecraft server your friends can join%s\n' "$D" "$X" "$D" "$X"
else
  printf '\n  SPAWNPOINT\n  a Minecraft server your friends can join\n'
fi

# ---- this machine ----------------------------------------------------------
head_ "Checking this machine"
[ "$OS" = Linux ] || [ "$OS" = Darwin ] || die "This installer is for Linux and macOS." \
  "On Windows, run this in PowerShell instead:" \
  "  irm https://raw.githubusercontent.com/vayungodara/spawnpoint/main/install.ps1 | iex"

if [ "$(id -u)" = 0 ] && [ "${SPAWNPOINT_RUNTIME:-}" != crafty ]; then
  if [ "$OS" = Darwin ]; then
    die "Please don't run this with sudo." "Run the same command as yourself, without sudo."
  fi
  die "Please don't install as root." \
    "Minecraft servers and their mods shouldn't run with full control of the machine." \
    "Make a normal user for them, then run the install command as that user:" \
    "" \
    "  ${D}\$${X} adduser minecraft" \
    "  ${D}\$${X} loginctl enable-linger minecraft" \
    "  ${D}\$${X} su - minecraft"
fi

PKG=
if [ "$OS" = Darwin ]; then PKG=brew
else for p in apt-get dnf pacman zypper; do command -v "$p" >/dev/null 2>&1 && { PKG=$p; break; }; done; fi
install_cmd() {
  case "$PKG" in
    brew) echo "brew install $*" ;;
    apt-get) echo "sudo apt-get install -y $*" ;;
    dnf) echo "sudo dnf install -y $*" ;;
    pacman) echo "sudo pacman -S --needed $*" ;;
    zypper) echo "sudo zypper install -y $*" ;;
    *) echo "install with your package manager: $*" ;;
  esac
}
xvfb_pkg() { case "$PKG" in apt-get) echo xvfb ;; dnf) echo xorg-x11-server-Xvfb ;; pacman) echo xorg-server-xvfb ;; zypper) echo xorg-x11-server-Xvfb ;; *) echo xvfb ;; esac; }
node_fix() {
  case "$PKG" in
    brew) fix "brew install node" ;;
    apt-get) fix "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"; fix "sudo apt-get install -y nodejs" ;;
    pacman) fix "sudo pacman -S --needed nodejs npm" ;;
    *) fix "curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash"
       fix ". ~/.nvm/nvm.sh && nvm install 22" ;;
  esac
}

MISSING=() # packages for one install line
BLOCKED=0

# Without the Command Line Tools, macOS's git and python3 are stubs that pop
# up an installer dialog instead of running.
if [ "$OS" = Darwin ] && ! xcode-select -p >/dev/null 2>&1; then
  note "Apple's Command Line Tools are missing (they provide git and Python)"
  fix "xcode-select --install"
  say "Click Install in the window that opens, wait for it to finish, then run this again."
  BLOCKED=1
fi

if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  NODE_V=$(node -v 2>/dev/null || echo v0)
  NODE_MAJOR=$(echo "$NODE_V" | sed 's/^v\([0-9]*\).*/\1/')
  if [ "${NODE_MAJOR:-0}" -ge 22 ] 2>/dev/null; then ok "Node.js ${NODE_V#v}"
  else
    note "Node.js ${NODE_V#v} is too old. Spawnpoint needs version 22 or newer."
    if command -v nvm >/dev/null 2>&1 || [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then fix "nvm install 22"; else node_fix; fi
    BLOCKED=1
  fi
else
  note "Node.js 22 or newer is needed"
  node_fix
  BLOCKED=1
fi

if [ "$OS" != Darwin ] || xcode-select -p >/dev/null 2>&1; then
  if command -v git >/dev/null 2>&1 && git --version >/dev/null 2>&1; then :; else MISSING+=(git); fi
  if command -v python3 >/dev/null 2>&1 && python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null; then
    ok "Python $(python3 -c 'import platform; print(platform.python_version())')"
  else MISSING+=(python3); fi
fi
command -v curl >/dev/null 2>&1 || MISSING+=(curl)
if [ "$OS" = Linux ]; then
  command -v zip >/dev/null 2>&1 || MISSING+=(zip)
  command -v unzip >/dev/null 2>&1 || MISSING+=(unzip)
  [ ${#MISSING[@]} -eq 0 ] && ok "git, zip and unzip"
fi
if [ ${#MISSING[@]} -gt 0 ]; then
  note "Missing: ${MISSING[*]}"
  fix "$(install_cmd "${MISSING[@]}")"
  BLOCKED=1
fi

# Memory: a modded server wants 4 GB of heap and the mod test boots a second
# copy, so small boxes work but feel it.
if [ "$OS" = Darwin ]; then MEM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
else MEM_GB=$(( $(awk '/^MemTotal:/ {print $2}' /proc/meminfo) / 1048576 )); fi
if [ "$MEM_GB" -lt 3 ]; then
  note "${MEM_GB} GB of memory. Vanilla works; modded servers need about 4 GB."
elif [ "$MEM_GB" -lt 6 ]; then
  ok "${MEM_GB} GB of memory ${D}(fine for a small modded server)${X}"
else ok "${MEM_GB} GB of memory"; fi

XVFB_HINT=0
if [ "$OS" = Linux ] && [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && ! command -v xvfb-run >/dev/null 2>&1; then XVFB_HINT=1; fi

# The supervisor is a systemd user service. `su - user` and `sudo -iu user`
# sessions have a user manager only when lingering is on, and they don't set
# XDG_RUNTIME_DIR, so find it before deciding it is missing.
ROOT="${SPAWNPOINT_ROOT:-$HOME/minecraft}"
RUNTIME="${SPAWNPOINT_RUNTIME:-standalone}"
case "$RUNTIME" in standalone|crafty) ;; *) die "SPAWNPOINT_RUNTIME must be standalone or crafty.";; esac
# an existing Crafty connection keeps its backend
[ -z "${SPAWNPOINT_RUNTIME+x}" ] && [ -f "$ROOT/Shared/crafty-token.txt" ] && RUNTIME=crafty
USER_SYSTEMD=0
if [ "$OS" = Linux ] && command -v systemctl >/dev/null 2>&1; then
  if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then export XDG_RUNTIME_DIR="/run/user/$(id -u)"; fi
  systemctl --user show-environment >/dev/null 2>&1 && USER_SYSTEMD=1
fi
if [ "$OS" = Linux ] && [ "$RUNTIME" = standalone ] && [ "$USER_SYSTEMD" = 0 ]; then
  note "Can't reach your systemd user session"
  say "Spawnpoint keeps your servers running as a user service. Turn that on once:"
  fix "sudo loginctl enable-linger $(id -un)"
  say "Then log out, log back in (a fresh SSH login, not su), and run this again."
  BLOCKED=1
fi

if [ "$BLOCKED" = 1 ]; then
  printf '\n  %sAlmost there.%s Fix the steps above, then run the same install command again.\n\n' "$B" "$X" >&2
  exit 1
fi

# ---- layout ----------------------------------------------------------------
# Everything Spawnpoint manages lives here: servers, Shared, Tools (Java
# downloads itself into it), Backups and the panel's own data.
case "$ROOT" in *" "*) die "The layout folder can't contain spaces: $ROOT" \
  "Java launch commands split on them. Pick another folder:" "  SPAWNPOINT_ROOT=/path/without/spaces";; esac
# not $ROOT/Spawnpoint: git refuses to clone into a folder that has content
mkdir -p "$ROOT/Crafty/servers" "$ROOT/Shared" "$ROOT/Tools" "$ROOT/Backups" 2>/dev/null \
  || die "Can't create $ROOT." "Pick a folder you can write to with SPAWNPOINT_ROOT=/some/folder."
DISK_GB=$(df -Pk "$ROOT" | awk 'NR==2 {print int($4 / 1048576)}')
if [ "${DISK_GB:-99}" -lt 5 ]; then note "Only ${DISK_GB} GB free in $ROOT. Worlds and backups grow; 10 GB is comfortable."; fi

# ---- code ------------------------------------------------------------------
head_ "Installing Spawnpoint into $ROOT"
if [ -f package.json ] && grep -q '"name": *"spawnpoint"' package.json 2>/dev/null; then
  DIR="$(pwd)"
  run "Updating the checkout here" git pull --ff-only || note "Couldn't fast-forward this checkout; building what's here."
else
  DIR="${SPAWNPOINT_DIR:-$ROOT/Spawnpoint}"
  if [ -d "$DIR/.git" ]; then
    run "Updating Spawnpoint" git -C "$DIR" pull --ff-only || note "Couldn't fast-forward $DIR; building what's there."
  else
    run "Downloading Spawnpoint" git clone --depth 1 https://github.com/vayungodara/spawnpoint "$DIR" \
      || die "Couldn't download Spawnpoint from GitHub." "Check this machine's internet connection."
  fi
  cd "$DIR"
fi
DATA="$ROOT/Spawnpoint/data"
mkdir -p "$DATA" || die "Can't create $DATA."
run "Installing dependencies" npm ci --no-audit --no-fund \
  || die "npm couldn't install the dependencies." "The full log is in $LOG."
run "Building the panel" npm run build || die "The build failed." "The full log is in $LOG."

# `spawnpoint` for terminals and coding agents. On this machine it reads the
# admin token from the layout, so it needs no login.
BIN="$HOME/.local/bin"
if mkdir -p "$BIN" 2>/dev/null && ln -sf "$DIR/cli/spawnpoint.mjs" "$BIN/spawnpoint" 2>/dev/null; then
  SPAWNPOINT_ROOT="$ROOT" node -e "const p=require('path'),fs=require('fs'),f=p.join(process.env.XDG_CONFIG_HOME||p.join(require('os').homedir(),'.config'),'spawnpoint','cli.json');let c={};try{c=JSON.parse(fs.readFileSync(f,'utf8'))}catch{}c.root=process.env.SPAWNPOINT_ROOT;fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(c,null,2),{mode:0o600})" >>"$LOG" 2>&1 || true
fi

NODE_BIN=$(command -v node)
# A running supervisor is left alone: reinstalling restarts it, and on macOS
# launchd then stops its process group, Minecraft included.
sup_running() {
  if [ "$OS" = Darwin ]; then launchctl print "gui/$(id -u)/com.spawnpoint.supervisor" >/dev/null 2>&1
  else systemctl --user is-active --quiet spawnpoint-supervisor.service 2>/dev/null; fi
}
if [ "$RUNTIME" = standalone ] && sup_running; then
  ok "Server supervisor already running"
elif [ "$RUNTIME" = standalone ]; then
  run "Starting the server supervisor" python3 "$DIR/server/dist/services/nativeservice.py" install --root "$ROOT" --node "$NODE_BIN" \
    || die "The supervisor service didn't start." "The full log is in $LOG." \
      "Its own log: $DATA/runtime/service.log"
  # Without lingering, systemd stops user services, Minecraft included, at logout.
  if [ "$OS" = Linux ] && [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo no)" != yes ]; then
    loginctl enable-linger "$(id -un)" >/dev/null 2>&1 </dev/null || true
    [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo no)" = yes ] || LINGER_HINT=1
  fi
fi

# ---- panel -----------------------------------------------------------------
# The same BOM tolerance loadSettings() has: a PowerShell-written settings
# file starts with one, and the wrong port here makes a healthy panel look dead.
SETTINGS="$DATA/settings.json"
PORT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8').replace(/^\uFEFF/,'')).port||25570)}catch{console.log(25570)}" "$SETTINGS")
PANEL_LOG="$DATA/panel.log"
health() { curl -fsS --max-time 2 "http://127.0.0.1:$1/api/health" 2>/dev/null | grep -q '"name":"spawnpoint"'; }
listening() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
listener_pid() {
  if command -v lsof >/dev/null 2>&1; then lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -n1
  elif command -v ss >/dev/null 2>&1; then ss -ltnpH "sport = :$1" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -n1; fi
}
svc_pid() {
  if [ "$OS" = Darwin ]; then launchctl print "gui/$(id -u)/com.spawnpoint.panel" 2>/dev/null | awk '$1 == "pid" {print $3; exit}'
  else systemctl --user show -p MainPID --value spawnpoint-panel.service 2>/dev/null; fi
}
who_listens() {
  if command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1" (pid "$2")"}'
  elif command -v ss >/dev/null 2>&1; then ss -ltnpH "sport = :$1" 2>/dev/null | sed -n 's/.*users:(("\([^"]*\)",pid=\([0-9]*\).*/\1 (pid \2)/p' | head -n1; fi
}

UNIT="$HOME/.config/systemd/user/spawnpoint-panel.service"
PLIST="$HOME/Library/LaunchAgents/com.spawnpoint.panel.plist"
# The panel counts as ours only when our login service runs it and that
# process is the one on the port; a leftover unit file proves nothing.
OURS=0
SVC_PID=$(svc_pid || true); SVC_PID=${SVC_PID:-0}
CAN_INSPECT=0; { command -v lsof >/dev/null 2>&1 || command -v ss >/dev/null 2>&1; } && CAN_INSPECT=1
if [ "$SVC_PID" -gt 0 ] 2>/dev/null; then
  LPID=$(listener_pid "$PORT" || true)
  if [ -n "$LPID" ] && [ "$LPID" = "$SVC_PID" ]; then OURS=1
  # the service is up but not on the port yet (recovering, or crash-looping)
  elif [ -z "$LPID" ] && ! listening "$PORT"; then OURS=2; fi
fi
stop_service() {
  if [ "$OS" = Darwin ]; then launchctl bootout "gui/$(id -u)/com.spawnpoint.panel" >/dev/null 2>&1 || true
  else systemctl --user stop spawnpoint-panel.service >/dev/null 2>&1 || true; fi
}
if [ "$OURS" = 1 ] && health "$PORT"; then
  # Ask first: the panel refuses to exit mid-wish, mid-create or mid-mod-test.
  # The token goes through stdin, never argv, so ps can't show it.
  ANSWER=$(printf 'authorization: Bearer %s\n' "$(cat "$DATA/admin-token" 2>/dev/null)" | curl -s --max-time 10 -X POST -H @- \
    -H 'content-type: application/json' -d '{}' "http://127.0.0.1:$PORT/api/admin/exit" 2>/dev/null || true)
  if ! echo "$ANSWER" | grep -q '"ok":true'; then
    printf '\n  %s%s%s The running panel didn'"'"'t agree to restart, so the new build waits.\n' "$Y" "$WARN" "$X"
    if echo "$ANSWER" | grep -q 'mid-work'; then say "It's in the middle of something. Run this again in a few minutes; nothing was interrupted."
    else say "Nothing was interrupted. Its log: $PANEL_LOG"; fi
    exit 0
  fi
  # Keep the service manager from restarting the old process, then wait for it to go.
  stop_service
  for _ in $(seq 1 60); do kill -0 "$SVC_PID" 2>/dev/null || break; sleep 0.5; done
  kill -0 "$SVC_PID" 2>/dev/null && die "The old panel (pid $SVC_PID) didn't exit." "Its log: $PANEL_LOG"
elif [ "$OURS" = 1 ] || [ "$OURS" = 2 ]; then
  # Alive but not answering: it may be recovering an interrupted change, so
  # never stop it without its agreement.
  printf '\n  %s%s%s The panel service is running but not answering yet, so the new build waits.\n' "$Y" "$WARN" "$X"
  say "Give it a minute and run this again; nothing was interrupted. Its log: $PANEL_LOG"
  if [ "$OS" = Darwin ]; then say "If it stays stuck: launchctl bootout gui/$(id -u)/com.spawnpoint.panel"
  else say "If it stays stuck: systemctl --user stop spawnpoint-panel"; fi
  exit 0
fi
if [ "$OURS" = 0 ] && listening "$PORT"; then
  if health "$PORT"; then
    printf '\n  %s%s%s A Spawnpoint panel you started by hand is already running on port %s.\n' "$Y" "$WARN" "$X" "$PORT"
    say "The new build is ready. Stop that panel and run this again to switch it to a login service."
    exit 0
  fi
  BUSY_BY=$(who_listens "$PORT" || true)
  if [ -f "$SETTINGS" ]; then
    die "Port $PORT is already in use${BUSY_BY:+ by $BUSY_BY}." \
      "Stop that program, or set another \"port\" in $SETTINGS, then run this again."
  fi
  for p in $(seq $((PORT + 1)) $((PORT + 20))); do listening "$p" || { NEW_PORT=$p; break; }; done
  [ -n "${NEW_PORT:-}" ] || die "Ports $PORT to $((PORT + 20)) are all in use."
  note "Port $PORT is taken${BUSY_BY:+ by $BUSY_BY}, so the panel will use $NEW_PORT."
  printf '{\n  "port": %s\n}\n' "$NEW_PORT" >"$SETTINGS"
  chmod 600 "$SETTINGS"
  PORT=$NEW_PORT
fi

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
USES_SERVICE=1; { [ "$OS" = Linux ] && [ "$USER_SYSTEMD" = 0 ]; } && USES_SERVICE=0
start_panel() {
  if [ "$OS" = Linux ] && [ "$USER_SYSTEMD" = 1 ]; then
    mkdir -p "$(dirname "$UNIT")"
    cat >"$UNIT" <<EOF
[Unit]
Description=Spawnpoint panel
After=network-online.target spawnpoint-supervisor.service

[Service]
Type=simple
Environment="SPAWNPOINT_ROOT=$ROOT"
Environment="PATH=$PATH"
WorkingDirectory=$DIR
ExecStart="$NODE_BIN" "$DIR/server/dist/index.js"
Restart=always
RestartSec=3
StandardOutput=append:$PANEL_LOG
StandardError=append:$PANEL_LOG

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload && systemctl --user enable spawnpoint-panel.service >/dev/null 2>&1 \
      && systemctl --user restart spawnpoint-panel.service
  elif [ "$OS" = Darwin ]; then
    mkdir -p "$(dirname "$PLIST")"
    cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.spawnpoint.panel</string>
  <key>ProgramArguments</key><array><string>$(xml "$NODE_BIN")</string><string>$(xml "$DIR/server/dist/index.js")</string></array>
  <key>WorkingDirectory</key><string>$(xml "$DIR")</string>
  <key>EnvironmentVariables</key><dict>
    <key>SPAWNPOINT_ROOT</key><string>$(xml "$ROOT")</string>
    <key>PATH</key><string>$(xml "$PATH")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$(xml "$PANEL_LOG")</string>
  <key>StandardErrorPath</key><string>$(xml "$PANEL_LOG")</string>
</dict>
</plist>
EOF
    local domain="gui/$(id -u)" i
    launchctl bootout "$domain/com.spawnpoint.panel" >/dev/null 2>&1 || true
    # bootout returns before launchd has removed the old job
    for i in $(seq 1 100); do launchctl print "$domain/com.spawnpoint.panel" >/dev/null 2>&1 || break; sleep 0.2; done
    launchctl bootstrap "$domain" "$PLIST"
  else
    # Crafty mode on a box without a systemd user session: a plain background process
    SPAWNPOINT_ROOT="$ROOT" nohup "$NODE_BIN" server/dist/index.js >>"$PANEL_LOG" 2>&1 </dev/null &
    echo $! >"$DATA/panel.pid"
  fi
}
start_and_wait() {
  local i
  start_panel || return 1
  for i in $(seq 1 45); do
    if health "$PORT"; then
      local sp lp
      # with a login service, the answer must come from its process, not a stray panel
      [ -f "$DATA/panel.pid" ] && [ "$USES_SERVICE" = 0 ] && return 0
      [ "$CAN_INSPECT" = 0 ] && return 0 # no lsof or ss here: health is all we can check
      sp=$(svc_pid || true); lp=$(listener_pid "$PORT" || true)
      if [ -n "$sp" ] && [ "$sp" != 0 ] && [ "$sp" = "$lp" ]; then return 0; fi
      echo "port $PORT answers from pid ${lp:-unknown}, not the panel service (pid ${sp:-none})"; return 1
    fi
    sleep 1
  done
  echo "the panel did not answer on port $PORT within 45s"
  return 1
}
: >>"$PANEL_LOG"
PANEL_MARK=$(wc -l <"$PANEL_LOG")
if ! run "Starting the panel" start_and_wait; then
  if tail -n +"$((PANEL_MARK + 1))" "$PANEL_LOG" | grep -q EADDRINUSE; then
    die "Something else grabbed port $PORT while the panel started." \
      "Stop it, or set another \"port\" in $SETTINGS, then run this again."
  fi
  die "The panel didn't answer on port $PORT." "Its log: $PANEL_LOG"
fi

# ---- done ------------------------------------------------------------------
CODE=$(tr -d '\r\n' 2>/dev/null <"$DATA/setup-code.txt" || true)
SUFFIX=; [ -n "$CODE" ] && SUFFIX="/setup#code=$CODE"
lan_ip() {
  if [ "$OS" = Darwin ]; then ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true
  else hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9.]+$' | grep -v '^169\.254\.' | grep -v '^172\.17\.' | head -n1 || true; fi
}
# Over SSH the browser is on another computer: lead with the address that
# computer used to reach this one.
SSH_HOST=$(echo "${SSH_CONNECTION:-}" | awk '{print $3}')
LAN=$(lan_ip)
if [ -n "$SSH_HOST" ]; then MAIN="http://$SSH_HOST:$PORT$SUFFIX"; OTHER=
else MAIN="http://localhost:$PORT$SUFFIX"; OTHER=${LAN:+http://$LAN:$PORT$SUFFIX}; fi

printf '\n  %s%sSpawnpoint is ready.%s %sInstalled in %s.%s\n\n' "$G" "$B" "$X" "$D" "$(took $((SECONDS - START)))" "$X"
if [ -n "$CODE" ]; then printf '  Open this link to finish setup:\n\n'; else printf '  Open your panel:\n\n'; fi
printf '    %s%s%s\n\n' "$B$G" "$MAIN" "$X"
[ -n "$OTHER" ] && printf '  %sFrom a phone or another computer on your network:%s\n  %s%s%s\n\n' "$D" "$X" "$D" "$OTHER" "$X"

if [ "$RUNTIME" = crafty ] && ! curl -fskS --max-time 3 "https://localhost:8443" >/dev/null 2>&1; then
  note "Crafty Controller isn't answering on https://localhost:8443. Install or start it, then choose Crafty in setup."
fi
if [ "$XVFB_HINT" = 1 ]; then
  note "Optional: $(install_cmd "$(xvfb_pkg)") lets mod tests render the game on this headless box."
fi
if [ "${LINGER_HINT:-0}" = 1 ]; then
  note "So servers keep running after you log out: sudo loginctl enable-linger $(id -un)"
fi
case ":$PATH:" in *":$BIN:"*) CLI_HINT="spawnpoint status" ;; *) CLI_HINT="$BIN/spawnpoint status (add $BIN to PATH for the short form)" ;; esac
printf '  %sCommand line and coding agents: %s%s\n' "$D" "$CLI_HINT" "$X"
printf '  %sThe panel and your servers start on their own after a reboot. Log: %s%s\n\n' "$D" "$PANEL_LOG" "$X"

if [ -z "${SPAWNPOINT_NO_OPEN:-}" ] && [ -z "$SSH_HOST" ]; then
  if [ "$OS" = Darwin ]; then open "$MAIN" >/dev/null 2>&1 || true
  elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null 2>&1; then xdg-open "$MAIN" >/dev/null 2>&1 </dev/null & fi
fi
