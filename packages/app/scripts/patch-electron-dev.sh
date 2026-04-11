#!/bin/bash
# Patch Electron.app bundle for dev mode: custom name + icon
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$SCRIPT_DIR/.."
ELECTRON_APP="$APP_DIR/node_modules/electron/dist/Electron.app"
PLIST="$ELECTRON_APP/Contents/Info.plist"
ICNS_SRC="$APP_DIR/build/icon.icns"
ICNS_DST="$ELECTRON_APP/Contents/Resources/electron.icns"

# Patch icon
if [ -f "$ICNS_SRC" ]; then
  cp "$ICNS_SRC" "$ICNS_DST"
fi

# Patch app name in Info.plist
/usr/libexec/PlistBuddy -c "Set :CFBundleName trace-mcp" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName trace-mcp" "$PLIST" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string trace-mcp" "$PLIST" 2>/dev/null || true

echo "Electron.app patched for dev: name=trace-mcp, icon=custom"
