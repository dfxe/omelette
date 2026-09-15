#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

APP_NAME="Omelette"
SRC_DIR="Omelette"
BUILD_DIR="build"
APP_BUNDLE="$BUILD_DIR/$APP_NAME.app"
CONTENTS="$APP_BUNDLE/Contents"
MACOS_DIR="$CONTENTS/MacOS"

rm -rf "$BUILD_DIR"
mkdir -p "$MACOS_DIR" "$CONTENTS/Resources"

ARCH="$(uname -m)"

swiftc \
    -target "${ARCH}-apple-macos13.0" \
    -O \
    -parse-as-library \
    -framework SwiftUI \
    -framework AppKit \
    -framework Foundation \
    -framework Combine \
    -framework UniformTypeIdentifiers \
    -o "$MACOS_DIR/$APP_NAME" \
    "$SRC_DIR"/*.swift

cp "$SRC_DIR/Info.plist" "$CONTENTS/Info.plist"
cp "$SRC_DIR/Resources/omelette.png" "$CONTENTS/Resources/omelette.png"
iconutil -c icns "$SRC_DIR/Resources/Omelette.iconset" -o "$CONTENTS/Resources/Omelette.icns"

# Ad-hoc sign so Gatekeeper allows running locally.
codesign --force --sign - "$APP_BUNDLE" >/dev/null

echo "built: $APP_BUNDLE"
echo "run:   open $APP_BUNDLE"
