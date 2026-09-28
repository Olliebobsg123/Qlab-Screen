#!/bin/bash
# Run QLab Connect as a background service on a Mac: starts when you log in, restarts itself if it
# ever stops, and keeps the Mac from sleeping while it runs.
#
#   npm run mac:install     install (or reinstall) and start it
#   npm run mac:restart     restart after an update (git pull)
#   npm run mac:status      is it running? plus the last log lines
#   npm run mac:logs        follow the log
#   npm run mac:uninstall   stop it and remove it
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.qlabconnect.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/QLab Connect"
LOG_FILE="$LOG_DIR/server.log"
DOMAIN="gui/$(id -u)"

if [ "$(uname)" != "Darwin" ]; then
  echo "This script is for macOS. On Ubuntu use scripts/install-ubuntu.sh." >&2
  exit 1
fi

install_service() {
  local node
  node="$(command -v node || true)"
  if [ -z "$node" ]; then
    echo "Node.js isn't installed. Install the LTS version from https://nodejs.org and run this again." >&2
    exit 1
  fi

  echo "Installing packages…"
  (cd "$APP_DIR" && npm install --no-audit --no-fund >/dev/null)

  if (cd "$APP_DIR" && node scripts/admin-password.mjs --is-default); then
    echo
    echo "Choose an admin password (at least 6 characters). You'll log in to Admin with"
    echo "username 'admin' and this password. You can change it later in Admin → Server."
    while true; do
      read -r -s -p "Admin password: " password; echo
      read -r -s -p "Type it again:  " confirm; echo
      if [ "${#password}" -lt 6 ]; then echo "Too short, try again."; continue; fi
      if [ "$password" != "$confirm" ]; then echo "They don't match, try again."; continue; fi
      break
    done
    (cd "$APP_DIR" && node scripts/admin-password.mjs --set "$password")
  fi

  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-i</string>
    <string>$node</string>
    <string>$APP_DIR/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$node"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>QLAB_CONNECT_SERVICE</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$LOG_FILE</string>
  <key>StandardErrorPath</key><string>$LOG_FILE</string>
</dict>
</plist>
PLIST

  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$PLIST"
  sleep 2
  echo
  echo "QLab Connect is running in the background and will start every time you log in."
  echo "Open http://localhost:3030/start.html"
  echo "Logs: $LOG_FILE"
  echo
  echo "Tip for a show Mac: turn on automatic login (System Settings → Users & Groups) so it"
  echo "comes back by itself after a power cut."
}

case "${1:-install}" in
  install) install_service ;;
  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "Restarted."
    ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      launchctl print "$DOMAIN/$LABEL" | grep -E "^\s*(state|pid|last exit code) =" || true
    else
      echo "Not installed. Run: npm run mac:install"
    fi
    [ -f "$LOG_FILE" ] && { echo "--- last log lines ---"; tail -n 15 "$LOG_FILE"; }
    ;;
  logs) tail -n 50 -f "$LOG_FILE" ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed. (Your settings and logs are kept.)"
    ;;
  *) echo "Usage: $0 install|restart|status|logs|uninstall" >&2; exit 2 ;;
esac
