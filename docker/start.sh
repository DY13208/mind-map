#!/bin/sh
set -eu

echo "[gateway] waiting for postgres ${PGHOST:-postgres}:${PGPORT:-5432}..."
i=0
while [ "$i" -lt 60 ]; do
  if node -e "
    const { Client } = require('/app/simple-mind-map/node_modules/pg')
    const c = new Client()
    c.connect()
      .then(() => c.query('select 1'))
      .then(() => c.end())
      .then(() => process.exit(0))
      .catch(() => process.exit(1))
  " >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 1
done

if [ "$i" -ge 60 ]; then
  echo "[gateway] postgres is not ready" >&2
  exit 1
fi

echo "[gateway] starting collab / mcp / ai / nginx"

node /app/simple-mind-map/bin/collabServer.js &
node /app/simple-mind-map/bin/mcpServer.mjs --http &
node /app/web/scripts/ai.js &

exec nginx -g 'daemon off;'
