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
xcrun simctl io "$DEVICE" screenshot "$OUT" >/dev/null
echo "Saved $OUT"
