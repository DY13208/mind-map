#!/bin/sh
set -eu
node /app/simple-mind-map/bin/collabServer.js &
collab_pid=$!
node /app/simple-mind-map/bin/mcpServer.mjs --http &
mcp_pid=$!
trap 'kill "$collab_pid" "$mcp_pid" 2>/dev/null || true' TERM INT EXIT
wait "$collab_pid"
