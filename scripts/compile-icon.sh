#!/bin/sh
# Compiles the Icon Composer file into what the app bundle needs:
#   Assets.car     — Liquid Glass icon for macOS 26+ (via CFBundleIconName)
#   icon.icns      — flat fallback for macOS 13–15
#   icon.png       — used by Tauri's build
# Requires Xcode 26+. Outputs are committed, so building the app doesn't need Xcode.
set -eu
cd "$(dirname "$0")/.."

SRC=src-tauri/icons/Pinboarder.icon
OUT=src-tauri/icons/compiled
[ -d "$SRC" ] || { echo "Missing $SRC — save it from Icon Composer first" >&2; exit 1; }

rm -rf "$OUT" && mkdir -p "$OUT"
xcrun actool "$SRC" \
  --compile "$OUT" \
  --app-icon Pinboarder \
  --platform macosx \
  --target-device mac \
  --minimum-deployment-target 13.0 \
  --output-partial-info-plist "$OUT/partial.plist" >/dev/null

cp "$OUT/Assets.car" src-tauri/icons/Assets.car
cp "$OUT/Pinboarder.icns" src-tauri/icons/icon.icns
rm -rf "$OUT"

# Tauri's build also needs a PNG (default window icon)
"$(xcode-select -p)/../Applications/Icon Composer.app/Contents/Executables/ictool" "$SRC" \
  --export-image --output-file src-tauri/icons/icon.png \
  --platform macOS --rendition Default --width 512 --height 512 --scale 1 >/dev/null
# ictool writes 16-bit PNGs; Tauri needs 8-bit RGBA or the app aborts at launch
command -v magick >/dev/null || { echo "ImageMagick (magick) is required: brew install imagemagick" >&2; exit 1; }
magick src-tauri/icons/icon.png -depth 8 PNG32:src-tauri/icons/icon.png

echo "Updated src-tauri/icons/Assets.car, icon.icns and icon.png"
