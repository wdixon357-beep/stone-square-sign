#!/bin/zsh
set -euo pipefail

readonly LABEL="com.dstechnology.stonesquare.sign.server"
readonly APP_DIR="/Users/williamdixon-saunders/dev/stone-square-sign"
readonly PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
readonly LOG_DIR="$HOME/Library/Logs/StoneSquareSign"
readonly DOMAIN="gui/$(id -u)"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

cat > "$PLIST" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.dstechnology.stonesquare.sign.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/williamdixon-saunders/dev/stone-square-sign/scripts/local-server-watch.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/williamdixon-saunders/dev/stone-square-sign</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/williamdixon-saunders/Library/Logs/StoneSquareSign/server.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/williamdixon-saunders/Library/Logs/StoneSquareSign/server-error.log</string>
</dict>
</plist>
PLIST

chmod 600 "$PLIST"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL"

echo "Stone Square Sign local service installed and started."
