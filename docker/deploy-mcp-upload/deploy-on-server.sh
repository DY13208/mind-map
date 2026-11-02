#!/bin/sh
# 在**服务器主机**上执行（需要 docker 权限）。
# 作用：把「一次性直传票据」补丁装进 mind-map 的 MCP 容器。
# 用法：sh deploy-on-server.sh [容器名]   # 默认 mind-map-app-1
set -e
CONTAINER=${1:-mind-map-app-1}
DIR=$(cd "$(dirname "$0")" && pwd)

echo "== 1/4 拷贝模块到容器 =="
docker cp "$DIR/mcpUploadTickets.mjs" "$CONTAINER:/app/simple-mind-map/bin/mcpUploadTickets.mjs"
docker cp "$DIR/mcpUploadBridge.mjs"  "$CONTAINER:/app/simple-mind-map/bin/mcpUploadBridge.mjs"
docker exec "$CONTAINER" mkdir -p /tmp/deploy
docker cp "$DIR/patch-mcp-upload.mjs" "$CONTAINER:/tmp/deploy/patch-mcp-upload.mjs"

echo "== 2/4 打补丁（锚点缺失会整体放弃并保留备份） =="
docker exec "$CONTAINER" node /tmp/deploy/patch-mcp-upload.mjs

echo "== 3/4 重启 MCP 进程 =="
docker exec "$CONTAINER" sh -c 'P=$(cat /tmp/mcp.pid 2>/dev/null); if [ -n "$P" ]; then kill "$P"; echo "killed $P"; else echo "no pid file"; fi'
sleep 8
docker exec "$CONTAINER" sh -c 'cat /tmp/mcp.pid 2>/dev/null || echo "WARN: mcp.pid 未生成，请查 docker logs 或改执行: docker restart '"$CONTAINER"'"'

echo "== 4/4 容器内自检（容器可能没有 curl，用 node 自带 fetch） =="
docker exec "$CONTAINER" node -e "fetch('http://127.0.0.1:3847/mcp-upload/ping',{method:'POST'}).then(r=>r.text()).then(t=>console.log('ping:',t)).catch(e=>console.log('ping failed:',e.message))"

echo ""
echo "完成。若上面 ping 返回 {\"ok\":true,...}，说明 MCP 侧已就绪。"
echo "还需要在 nginx 加 /mcp-upload/ 转发（见 README 第 4 节），否则公网访问会 405。"
echo "回滚：docker cp /app/simple-mind-map/bin/mcpServer.mjs.bak-<时间戳> 覆盖回去再重启 MCP"
