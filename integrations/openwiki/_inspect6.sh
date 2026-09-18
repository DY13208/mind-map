#!/bin/sh
OW=/usr/local/lib/node_modules/openwiki
echo "=== providers ==="
node -e 'import("/usr/local/lib/node_modules/openwiki/dist/config/constants.js").then(m=>console.log(Object.keys(m.PROVIDER_CONFIGS||{}).join("\n"))).catch(e=>console.error(e))'
echo "=== openai compatible refs ==="
grep -R -n -i "deepseek\|openai-compatible\|baseURL\|OPENAI_BASE" "$OW/dist/config" "$OW/dist/setup" 2>/dev/null | head -40
echo "=== personal ingest flow refs ==="
grep -R -n -E "ingest|custom-mcp|writeWiki|localWiki" "$OW/dist/ingestion" "$OW/dist/connectors" 2>/dev/null | head -50