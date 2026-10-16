#!/bin/zsh
set -euo pipefail

readonly LABEL="com.dstechnology.stonesquare.sign.report-sync"
readonly APP_DIR="${0:A:h:h}"
readonly PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
readonly LOG_DIR="$HOME/Library/Logs/StoneSquareSign"
readonly DOMAIN="gui/$(id -u)"
readonly NODE="$(command -v node)"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
/usr/bin/python3 - "$PLIST" "$APP_DIR" "$LOG_DIR" "$NODE" "$LABEL" <<'PY'
import plistlib, sys
target, app, logs, node, label = sys.argv[1:]
with open(target, 'wb') as output:
    plistlib.dump({
        'Label': label,
        'ProgramArguments': [node, app + '/scripts/sync-dispensation-reports.mjs', '--apply'],
        'WorkingDirectory': app,
        'RunAtLoad': True,
        'StartInterval': 60,
        'ProcessType': 'Background',
        'StandardOutPath': logs + '/report-sync.log',
        'StandardErrorPath': logs + '/report-sync-error.log',
    }, output)
PY
chmod 600 "$PLIST"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart "$DOMAIN/$LABEL"
print 'Dispensation report folder sync is installed. Only the two designated report folders are scanned.'
