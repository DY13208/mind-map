#!/bin/sh
set -eu

STOP_FLAG=/tmp/gateway-stopping
rm -f "$STOP_FLAG" /tmp/collab.pid /tmp/mcp.pid /tmp/ai.pid

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

supervise() {
  name=$1
  pidfile=$2
  shift 2
  delay=1
  while [ ! -f "$STOP_FLAG" ]; do
    echo "[gateway] starting $name"
    "$@" &
    pid=$!
    echo "$pid" > "$pidfile"
    set +e
    wait "$pid"
    status=$?
    set -e
    rm -f "$pidfile"
    if [ -f "$STOP_FLAG" ]; then
      break
    fi
    echo "[gateway] $name exited ($status); restart in ${delay}s" >&2
    sleep "$delay"
    delay=$((delay * 2))
    if [ "$delay" -gt 30 ]; then
      delay=30
    fi
  done
}

supervise collab /tmp/collab.pid env NODE_OPTIONS=--max-old-space-size=3072 node /app/simple-mind-map/bin/collabServer.js &
collab_loop=$!

echo "[gateway] waiting for collab http://127.0.0.1:1234/api/health ..."
i=0
while [ "$i" -lt 120 ]; do
  if node -e "
    require('http')
      .get('http://127.0.0.1:1234/api/health', res => {
        res.resume()
        process.exit(res.statusCode === 200 ? 0 : 1)
      })
      .on('error', () => process.exit(1))
  " >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 1
done

if [ "$i" -ge 120 ]; then
  echo "[gateway] collab is not ready" >&2
  exit 1
fi

echo "[gateway] collab is ready"
supervise mcp /tmp/mcp.pid node /app/simple-mind-map/bin/mcpServer.mjs --http &
mcp_loop=$!
supervise ai /tmp/ai.pid node /app/web/scripts/ai.js &
ai_loop=$!
nginx -g 'daemon off;' &
nginx_pid=$!

kill_pidfile() {
  file=$1
  if [ -f "$file" ]; then
    pid=$(cat "$file")
    kill "$pid" 2>/dev/null || true
  fi
}

cleanup() {
  touch "$STOP_FLAG"
  kill_pidfile /tmp/collab.pid
  kill_pidfile /tmp/mcp.pid
  kill_pidfile /tmp/ai.pid
  kill "$collab_loop" "$mcp_loop" "$ai_loop" "$nginx_pid" 2>/dev/null || true
  wait "$collab_loop" "$mcp_loop" "$ai_loop" "$nginx_pid" 2>/dev/null || true
}

shutdown() {
  trap - TERM INT
  cleanup
  exit 0
}

trap shutdown TERM INT

set +e
wait "$nginx_pid"
nginx_status=$?
set -e
echo "[gateway] nginx exited ($nginx_status)" >&2
cleanup
exit 1
