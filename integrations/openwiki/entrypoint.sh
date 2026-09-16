#!/bin/sh
set -eu
mkdir -p "$OPENWIKI_CONFIG_DIR"
node /runtime/setup.cjs
if [ "$#" -eq 0 ]; then set -- personal; fi
# Official OpenWiki requires HTTPS except localhost. A command-scoped loopback
# bridge reaches Mind Map through Docker DNS without patching the upstream CLI.
node /runtime/proxy.cjs &
proxy_pid=$!
trap 'kill "$proxy_pid" 2>/dev/null || true' EXIT INT TERM
if [ "${1:-}" = "runtime-check" ]; then
  node /runtime/probe.cjs
else
  openwiki "$@"
fi
