#!/bin/sh
# 负向测试：缺少票据模块时，补丁必须整体放弃且不改动原文件
set -e
T=/tmp/negtest
rm -rf $T
mkdir -p $T/bin
printf '%s\n' "import { resolveAttachmentUploadInput } from './mcpAttachmentUpload.mjs'" \
  "export async function route(req, res) {" \
  "  if (url.pathname !== '/mcp') {" \
  "    return 'fallback'" \
  "  }" \
  "  return resolveAttachmentUploadInput" \
  "}" > $T/bin/mcpServer.mjs
printf '%s\n' "export async function resolveAttachmentUploadInput(input = {}) { return input }" > $T/bin/mcpAttachmentUpload.mjs
cp /tmp/deploy/mcpUploadBridge.mjs $T/bin/mcpUploadBridge.mjs
MD5_BEFORE=$(md5sum $T/bin/mcpServer.mjs | cut -d' ' -f1)
echo "=== 缺 mcpUploadTickets.mjs ==="
MCP_BIN_DIR=$T/bin node /tmp/deploy/patch-mcp-upload.mjs || true
# 补上票据模块后再缺 mcpAttachmentUpload 的导出
rm $T/bin/mcpAttachmentUpload.mjs
printf '%s\n' "export async function someOtherFn() {}" > $T/bin/mcpAttachmentUpload.mjs
cp /tmp/deploy/mcpUploadTickets.mjs $T/bin/mcpUploadTickets.mjs
echo "=== 缺 resolveAttachmentUploadInput 导出 ==="
MCP_BIN_DIR=$T/bin node /tmp/deploy/patch-mcp-upload.mjs || true
MD5_AFTER=$(md5sum $T/bin/mcpServer.mjs | cut -d' ' -f1)
echo "=== 原文件是否被改动 ==="
if [ "$MD5_BEFORE" = "$MD5_AFTER" ]; then echo "UNCHANGED_OK"; else echo "MODIFIED_BAD"; fi
