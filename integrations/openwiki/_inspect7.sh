#!/bin/sh
OW=/usr/local/lib/node_modules/openwiki
echo "=== openai-compatible env keys ==="
grep -n -E "OPENAI_COMPATIBLE|OPENAI_API_KEY|PROVIDER|MODEL" "$OW/dist/config/constants.js" | head -40
echo "=== openwiki-home resolve ==="
cat "$OW/dist/config/openwiki-home.js"
echo "=== personal setup files ==="
grep -R -n -E "wikiGoal|\.env|provider|modelId|selectedMode|personal" "$OW/dist/setup" 2>/dev/null | head -40
echo "=== how .env is loaded ==="
grep -R -n -E "loadOpenWikiEnv|writeEnv|OPENAI_COMPATIBLE" "$OW/dist/config" "$OW/dist/setup" 2>/dev/null | head -40