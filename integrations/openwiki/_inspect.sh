#!/bin/sh
set -e
OW=/usr/local/lib/node_modules/openwiki
echo "=== package version ==="
node -p "require('$OW/package.json').version"
echo "=== dist dirs ==="
ls "$OW/dist"
echo "=== connectors ==="
ls "$OW/dist/connectors"
echo "=== config path search ==="
grep -R -n -E "configDir|wikiDir|OPENWIKI_HOME|openwikiDir|\.run\.json|page-manifest" "$OW/dist/config" "$OW/dist/platform" "$OW/dist/cli" 2>/dev/null | head -120
echo "=== personal / mcp ==="
grep -R -n -E "personal|custom-mcp|Custom MCP" "$OW/dist/connectors" "$OW/dist/config" "$OW/dist/setup" 2>/dev/null | head -100