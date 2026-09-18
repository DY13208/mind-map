#!/bin/sh
set -eu
# Fix writable mounts then drop privileges to node (uid 1000).
for d in /data/audit /data/openwiki/jobs /data/openwiki/rooms; do
  if [ -d "$d" ]; then
    chown -R node:node "$d" 2>/dev/null || true
    chmod -R u+rwX,g+rwX "$d" 2>/dev/null || true
  else
    mkdir -p "$d" 2>/dev/null || true
    chown -R node:node "$d" 2>/dev/null || true
  fi
done
# Canonical knowledge is read-only mount; ensure traversable
if [ -d /data/knowledge ]; then
  chmod -R a+rX /data/knowledge 2>/dev/null || true
fi
exec gosu node "$@"
