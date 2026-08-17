#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"
ROOT_DIR="${PROJECT_DIR:h}"
DIST_DIR="$PROJECT_DIR/dist"
APP_NAME="Stone Square Sign"
APP_DIR="$DIST_DIR/$APP_NAME.app"
ICONSET_DIR="$PROJECT_DIR/Resources/StoneSquareSign.iconset"
ICON_FILE="$PROJECT_DIR/Resources/StoneSquareSign.icns"
APP_VERSION="$(APP_PACKAGE="$ROOT_DIR/package.json" /opt/homebrew/bin/node -p "require(process.env.APP_PACKAGE).version")"
DIST_ZIP_FILE="$DIST_DIR/Stone-Square-Sign-$APP_VERSION.zip"
LOCAL_ZIP_FILE="$DIST_DIR/Stone-Square-Sign-$APP_VERSION-LOCAL-ONLY.zip"
INSTALL_TARGET="/Applications/$APP_NAME.app"
DISTRIBUTION_BUILD="${DISTRIBUTION_BUILD:-0}"
SIGNING_IDENTITY="${DEVELOPER_ID_APPLICATION:-}"
NOTARY_PROFILE="${NOTARYTOOL_PROFILE:-}"

if [[ "$DISTRIBUTION_BUILD" == "1" ]]; then
  if [[ "${1:-}" == "--install" ]]; then
    print -u2 "Distribution builds create a notarized release package and cannot use --install."
    exit 2
  fi
  if [[ -z "$SIGNING_IDENTITY" || -z "$NOTARY_PROFILE" ]]; then
    print -u2 "DISTRIBUTION_BUILD=1 requires DEVELOPER_ID_APPLICATION and NOTARYTOOL_PROFILE."
    exit 2
  fi
  if ! security find-identity -v -p codesigning | grep -Fq "\"$SIGNING_IDENTITY\""; then
    print -u2 "Configured Developer ID identity was not found: $SIGNING_IDENTITY"
    exit 2
  fi
  ZIP_FILE="$DIST_ZIP_FILE"
else
  SIGNING_IDENTITY="-"
  ZIP_FILE="$LOCAL_ZIP_FILE"
fi

sign_app() {
  local target="$1"
  if [[ "$DISTRIBUTION_BUILD" == "1" ]]; then
    codesign --force --deep --options runtime --timestamp --sign "$SIGNING_IDENTITY" \
      --entitlements "StoneSquareSign.entitlements" "$target"
  else
    codesign --force --sign - --entitlements "StoneSquareSign.entitlements" "$target"
  fi
}

cd "$PROJECT_DIR"
swift scripts/generate-icon.swift "$ICONSET_DIR"
iconutil -c icns "$ICONSET_DIR" -o "$ICON_FILE"
swift build -c release
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
install -m 755 ".build/release/StoneSquareSign" "$APP_DIR/Contents/MacOS/StoneSquareSign"
install -m 644 "Resources/Info.plist" "$APP_DIR/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $APP_VERSION" "$APP_DIR/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $APP_VERSION" "$APP_DIR/Contents/Info.plist"
install -m 644 "$ICON_FILE" "$APP_DIR/Contents/Resources/StoneSquareSign.icns"
xattr -cr "$APP_DIR"
sign_app "$APP_DIR"
codesign --verify --deep --strict --verbose=2 "$APP_DIR"
if [[ "${1:-}" == "--install" ]]; then
  INSTALL_STAGE_ROOT="$(mktemp -d /tmp/stone-square-sign-install.XXXXXX)"
  INSTALL_STAGE="$INSTALL_STAGE_ROOT/$APP_NAME.app"
  trap 'rm -rf "$INSTALL_STAGE_ROOT"' EXIT

  ditto "$APP_DIR" "$INSTALL_STAGE"
  xattr -cr "$INSTALL_STAGE"
  sign_app "$INSTALL_STAGE"
  codesign --verify --deep --strict --verbose=2 "$INSTALL_STAGE"

  rm -rf "$INSTALL_TARGET"
  mv "$INSTALL_STAGE" "$INSTALL_TARGET"
  rm -rf "$APP_DIR"
  rm -f "$DIST_ZIP_FILE" "$LOCAL_ZIP_FILE"
else
  rm -f "$DIST_ZIP_FILE" "$LOCAL_ZIP_FILE"
  ditto -c -k --keepParent --norsrc "$APP_DIR" "$ZIP_FILE"
  if [[ "$DISTRIBUTION_BUILD" == "1" ]]; then
    NOTARY_RESULT="$(xcrun notarytool submit "$ZIP_FILE" \
      --keychain-profile "$NOTARY_PROFILE" --wait --output-format json)"
    print -r -- "$NOTARY_RESULT"
    NOTARY_STATUS="$(print -r -- "$NOTARY_RESULT" | /opt/homebrew/bin/node -e \
      'let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(data).status||""))')"
    if [[ "$NOTARY_STATUS" != "Accepted" ]]; then
      print -u2 "Apple notarization did not accept the build. Status: ${NOTARY_STATUS:-unknown}"
      exit 1
    fi
    xcrun stapler staple "$APP_DIR"
    xcrun stapler validate "$APP_DIR"
    rm -f "$ZIP_FILE"
    ditto -c -k --keepParent --norsrc "$APP_DIR" "$ZIP_FILE"
    spctl --assess --type execute -vv "$APP_DIR"
  fi
fi

if [[ "${1:-}" == "--install" ]]; then
  print "Installed: $INSTALL_TARGET"
else
  print "App: $APP_DIR"
  print "ZIP: $ZIP_FILE"
  if [[ "$DISTRIBUTION_BUILD" == "1" ]]; then
    print "Distribution status: Developer ID signed, hardened, notarized, and stapled."
  else
    print -u2 "LOCAL-ONLY BUILD: ad hoc signed and not notarized. Do not distribute this ZIP."
    print -u2 "Set DISTRIBUTION_BUILD=1, DEVELOPER_ID_APPLICATION, and NOTARYTOOL_PROFILE for release packaging."
  fi
fi
