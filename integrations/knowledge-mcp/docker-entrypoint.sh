#!/bin/sh
set -eu
# Fix writable mounts then drop privileges to node (uid 1000).
# Do NOT chmod -R /data/knowledge (ro bind mount; can hang on large trees).
for d in /data/audit /data/openwiki/jobs /data/openwiki/rooms; do
  mkdir -p "$d" 2>/dev/null || true
  chown -R node:node "$d" 2>/dev/null || true
  chmod -R u+rwX,g+rwX "$d" 2>/dev/null || true
done
exec gosu node "$@"
