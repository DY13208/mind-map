#!/bin/sh
set -eu

# Run the exact image source with the test preload inherited by the collab
# process. The production start.sh intentionally sets its own memory-only
# NODE_OPTIONS; this test-only copy preserves those limits and adds our observer.
sed 's|env NODE_OPTIONS=--max-old-space-size=3072 node |env NODE_OPTIONS="--max-old-space-size=3072 ${NODE_OPTIONS:-}" node |' \
  /app/start.sh > /tmp/mcp-incremental-start.sh
exec /bin/sh /tmp/mcp-incremental-start.sh
