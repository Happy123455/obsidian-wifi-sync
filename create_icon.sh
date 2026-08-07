#!/bin/bash
set -e

PNG_FILE="$1"
OUT_ICNS="$2"

if [ -z "$PNG_FILE" ] || [ -z "$OUT_ICNS" ]; then
    echo "Usage: $0 <input.png> <output.icns>"
    exit 1
fi

ICONSET="icon.iconset"
mkdir -p "$ICONSET"

echo "Generating icons of various sizes..."
sips -s format png -z 16 16     "$PNG_FILE" --out "$ICONSET/icon_16x16.png" > /dev/null
sips -s format png -z 32 32     "$PNG_FILE" --out "$ICONSET/icon_16x16@2x.png" > /dev/null
sips -s format png -z 32 32     "$PNG_FILE" --out "$ICONSET/icon_32x32.png" > /dev/null
sips -s format png -z 64 64     "$PNG_FILE" --out "$ICONSET/icon_32x32@2x.png" > /dev/null
sips -s format png -z 128 128   "$PNG_FILE" --out "$ICONSET/icon_128x128.png" > /dev/null
sips -s format png -z 256 256   "$PNG_FILE" --out "$ICONSET/icon_128x128@2x.png" > /dev/null
sips -s format png -z 256 256   "$PNG_FILE" --out "$ICONSET/icon_256x256.png" > /dev/null
sips -s format png -z 512 512   "$PNG_FILE" --out "$ICONSET/icon_256x256@2x.png" > /dev/null
sips -s format png -z 512 512   "$PNG_FILE" --out "$ICONSET/icon_512x512.png" > /dev/null
sips -s format png -z 1024 1024 "$PNG_FILE" --out "$ICONSET/icon_512x512@2x.png" > /dev/null

echo "Compiling to .icns format..."
iconutil -c icns "$ICONSET" -o "$OUT_ICNS"

echo "Cleaning up temporary files..."
rm -rf "$ICONSET"
rm -rf test.iconset

echo "Success! Created $OUT_ICNS"
