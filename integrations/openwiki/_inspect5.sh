#!/bin/sh
echo "=== wiki ==="; find /data/openwiki/wiki -type f | head -50; ls -la /data/openwiki/wiki
echo "=== conversation_history ==="; find /data/openwiki/conversation_history -type f | head -20
echo "=== skills ==="; find /data/openwiki/skills -type f | head -20
echo "=== try openwiki personal help noninteractive ==="
# Capture what personal --init needs
openwiki personal --help 2>&1 | head -80 || true
echo "=== env files in home ==="
ls -la /data/openwiki/.env 2>/dev/null || echo 'no .env'