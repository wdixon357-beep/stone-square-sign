#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"
DIST_DIR="$PROJECT_DIR/dist"
APP_NAME="Stone Square Sign"
APP_DIR="$DIST_DIR/$APP_NAME.app"
ICONSET_DIR="$PROJECT_DIR/Resources/StoneSquareSign.iconset"
ICON_FILE="$PROJECT_DIR/Resources/StoneSquareSign.icns"
ZIP_FILE="$DIST_DIR/Stone-Square-Sign-1.2.0.zip"
INSTALL_TARGET="/Applications/$APP_NAME.app"

cd "$PROJECT_DIR"
swift scripts/generate-icon.swift "$ICONSET_DIR"
iconutil -c icns "$ICONSET_DIR" -o "$ICON_FILE"
swift build -c release
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
install -m 755 ".build/release/StoneSquareSign" "$APP_DIR/Contents/MacOS/StoneSquareSign"
install -m 644 "Resources/Info.plist" "$APP_DIR/Contents/Info.plist"
install -m 644 "$ICON_FILE" "$APP_DIR/Contents/Resources/StoneSquareSign.icns"
xattr -cr "$APP_DIR"
codesign --force --sign - --entitlements "StoneSquareSign.entitlements" "$APP_DIR"
codesign --verify --deep --strict --verbose=2 "$APP_DIR"
rm -f "$ZIP_FILE"
ditto -c -k --keepParent --norsrc "$APP_DIR" "$ZIP_FILE"

if [[ "${1:-}" == "--install" ]]; then
  if [[ -e "$INSTALL_TARGET" ]]; then
    BACKUP_DIR="$DIST_DIR/install-backups/$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$BACKUP_DIR"
    mv "$INSTALL_TARGET" "$BACKUP_DIR/$APP_NAME.app"
  fi
  ditto "$APP_DIR" "$INSTALL_TARGET"
  xattr -cr "$INSTALL_TARGET"
  codesign --force --sign - --entitlements "StoneSquareSign.entitlements" "$INSTALL_TARGET"
  codesign --verify --deep --strict --verbose=2 "$INSTALL_TARGET"
fi

print "App: $APP_DIR"
print "ZIP: $ZIP_FILE"
[[ "${1:-}" == "--install" ]] && print "Installed: $INSTALL_TARGET"
