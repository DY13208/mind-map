#!/bin/sh
set -e
OW=/usr/local/lib/node_modules/openwiki
echo "=== constants.js ==="
cat "$OW/dist/config/constants.js"
echo
echo "=== paths / home ==="
grep -R -n -E "OPEN_WIKI|openWikiHome|HOME|CONFIG|connectorsDisplay|localWiki" "$OW/dist/config" "$OW/dist/platform" 2>/dev/null | head -80
echo "=== sample personal wiki layout from README ==="
grep -n -E "openwiki/|INSTRUCTIONS|Claims|OKF|\.run\.json" "$OW/README.md" | head -60