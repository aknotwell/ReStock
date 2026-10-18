#!/usr/bin/env bash
# Render scripts/og-image.html to src/web/public/og.png (1200×630), the link preview image for restock.select.
# Needs Google Chrome (headless) and a network connection for the Google Fonts.
set -euo pipefail
cd "$(dirname "$0")/.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
"$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1200,630 --virtual-time-budget=5000 \
  --screenshot="$PWD/src/web/public/og.png" "file://$PWD/scripts/og-image.html"
