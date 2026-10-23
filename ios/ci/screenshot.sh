#!/bin/bash
# Installs the simulator build, launches it with sample data and saves a screenshot.
# Usage: screenshot.sh <simulator udid> <app path> <output.png> [light|dark]
set -euo pipefail
DEVICE=$1; APP=$2; OUT=$3; APPEARANCE=${4:-light}
xcrun simctl boot "$DEVICE" 2>/dev/null || true
xcrun simctl bootstatus "$DEVICE" -b >/dev/null
xcrun simctl ui "$DEVICE" appearance "$APPEARANCE"
xcrun simctl install "$DEVICE" "$APP"
xcrun simctl terminate "$DEVICE" com.saudcreator.notakillite 2>/dev/null || true
xcrun simctl launch "$DEVICE" com.saudcreator.notakillite --ui-demo >/dev/null
sleep 8
mkdir -p "$(dirname "$OUT")"
# Xcode 27 simulators can expose several displays and then need --display; older Xcode has no such option.
if ! ERR=$(xcrun simctl io "$DEVICE" screenshot "$OUT" 2>&1 >/dev/null); then
  for DISPLAY in $(echo "$ERR" | grep -o -- '--display=[0-9]*' | cut -d= -f2); do
    xcrun simctl io "$DEVICE" screenshot --display="$DISPLAY" "${OUT%.png}-display$DISPLAY.png" >/dev/null
    echo "Saved ${OUT%.png}-display$DISPLAY.png"
  done
  ls "${OUT%.png}"-display*.png >/dev/null 2>&1 || { echo "$ERR"; exit 1; }
else
  echo "Saved $OUT"
fi
