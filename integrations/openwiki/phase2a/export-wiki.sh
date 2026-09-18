#!/bin/sh
set -eu
echo "=== TREE ==="
find /data/openwiki/wiki -type f | sort
echo "=== LAST ==="
cat /data/openwiki/wiki/.last-update.json 2>/dev/null || echo NO_LAST
echo "=== MDS ==="
find /data/openwiki/wiki -name '*.md' -type f | sort | while read -r f; do
  echo "--- $f ---"
  wc -c "$f"
  head -15 "$f"
done