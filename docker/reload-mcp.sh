#!/bin/sh
# 渲染 nginx 模板并热加载；重启容器内 MCP 进程（supervise 会自动拉起）
# 与 start.sh 保持一致的默认值
YIRAN_UPSTREAM=${YIRAN_UPSTREAM:-http://host.docker.internal:18232}
JOBHUB_UPSTREAM=${JOBHUB_UPSTREAM:-http://host.docker.internal:5051}
BRIDGE_UPSTREAM=${BRIDGE_UPSTREAM:-http://host.docker.internal:8799}
COGNEE_UPSTREAM=${COGNEE_API:-${COGNEE_UPSTREAM:-http://192.168.0.204:8320}}
case "$(printf '%s' "${FILE_KB_ENABLED:-false}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) FILE_KB_NGINX_FLAG=1 ;;
  *) FILE_KB_NGINX_FLAG=0 ;;
esac
sed -e "s|__YIRAN_UPSTREAM__|$YIRAN_UPSTREAM|g" \
    -e "s|__FILE_KB_ENABLED__|$FILE_KB_NGINX_FLAG|g" \
    -e "s|__COGNEE_UPSTREAM__|$COGNEE_UPSTREAM|g" \
    -e "s|__COGNEE_API_KEY__|$COGNEE_API_KEY|g" \
    -e "s|__JOBHUB_UPSTREAM__|$JOBHUB_UPSTREAM|g" \
    -e "s|__BRIDGE_UPSTREAM__|$BRIDGE_UPSTREAM|g" \
  /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf
if nginx -t; then
  nginx -s reload && echo NGINX_OK
else
  echo NGINX_TEST_FAILED
  exit 1
fi

MCP_PID=$(cat /tmp/mcp.pid 2>/dev/null)
echo "mcp.pid=$MCP_PID"
if [ -n "$MCP_PID" ] && kill -0 "$MCP_PID" 2>/dev/null; then
  kill "$MCP_PID" && echo "MCP($MCP_PID) killed, supervise will restart it"
else
  echo "MCP pid not running; checking pgid process list"
  for p in /proc/[0-9]*/cmdline; do
    if tr '\0' ' ' < "$p" 2>/dev/null | grep -q 'mcpServer.mjs'; then
      pid=$(basename "$(dirname "$p")")
      echo "found mcpServer at pid $pid, killing"
      kill "$pid" 2>/dev/null
    fi
  done
fi
