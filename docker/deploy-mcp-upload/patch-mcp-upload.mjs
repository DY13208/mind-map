// 在容器内给 mcpServer.mjs 打「一次性直传票据」补丁。
//   docker cp mcpUploadTickets.mjs mcpUploadBridge.mjs patch-mcp-upload.mjs <容器>:/tmp/
//   docker exec <容器> node /tmp/patch-mcp-upload.mjs
// 特点：幂等（已打过就跳过）、锚点缺失则整体放弃并恢复备份、改完做 node --check。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const BIN = process.env.MCP_BIN_DIR || '/app/simple-mind-map/bin'
const target = path.join(BIN, 'mcpServer.mjs')

function fail(message, extra) {
  console.log(JSON.stringify({ ok: false, step: 'patch', message, ...extra }, null, 2))
  process.exit(1)
}

if (!fs.existsSync(target)) fail('找不到 mcpServer.mjs', { target })

const original = fs.readFileSync(target, 'utf8')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = `${target}.bak-${stamp}`

let patched = original
const changes = []

// ---- 1) import 路径改指向桥接模块 ----
const SPEC = "from './mcpAttachmentUpload.mjs'"
const SPEC_ALT = 'from "./mcpAttachmentUpload.mjs"'
const bridgeSpec = "from './mcpUploadBridge.mjs'"
if (patched.includes(bridgeSpec)) {
  console.log(JSON.stringify({ ok: true, alreadyPatched: true, target }))
  process.exit(0)
}
if (patched.includes(SPEC)) {
  patched = patched.split(SPEC).join(bridgeSpec)
  changes.push('import: mcpAttachmentUpload.mjs -> mcpUploadBridge.mjs')
} else if (patched.includes(SPEC_ALT)) {
  patched = patched.split(SPEC_ALT).join(bridgeSpec)
  changes.push('import: mcpAttachmentUpload.mjs -> mcpUploadBridge.mjs (double quotes)')
} else {
  fail('找不到 mcpAttachmentUpload 的 import，可能该版本结构不同，未做任何修改')
}

// ---- 2) 补一个 handleMcpUploadHttp 的 import ----
const importLine = "import { handleMcpUploadHttp } from './mcpUploadBridge.mjs'"
if (!patched.includes(importLine)) {
  const bridgeImportIdx = patched.indexOf(bridgeSpec)
  if (bridgeImportIdx < 0) fail('桥接 import 插入点异常，未做任何修改')
  const lineEnd = patched.indexOf('\n', bridgeImportIdx)
  if (lineEnd < 0) fail('桥接 import 行尾异常，未做任何修改')
  patched = `${patched.slice(0, lineEnd + 1)}${importLine}\n${patched.slice(lineEnd + 1)}`
  changes.push('import: handleMcpUploadHttp added')
}

// ---- 3) HTTP 路由：插在 /mcp 判定之前 ----
if (!patched.includes("url.pathname.startsWith('/mcp-upload/')")) {
  const routeRe = /([ \t]*)if \(url\.pathname !== ['"]\/mcp['"]\) \{/
  const m = routeRe.exec(patched)
  if (!m) {
    fail('找不到 /mcp 路由判定锚点，可能该版本结构不同，未做任何修改', {
      tried: "if (url.pathname !== '/mcp') {"
    })
  }
  const indent = m[1]
  const routeBlock =
    `${indent}if (url.pathname.startsWith('/mcp-upload/')) {\n` +
    `${indent}  await handleMcpUploadHttp(req, res, url)\n` +
    `${indent}  return\n` +
    `${indent}}\n\n`
  const at = m.index
  patched = patched.slice(0, at) + routeBlock + patched.slice(at)
  changes.push('route: /mcp-upload/* inserted before /mcp check')
}

// ---- 4) 落盘 + 语法校验，失败即回滚 ----
fs.writeFileSync(backup, original)
fs.writeFileSync(target, patched)

const check = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' })
if (check.status !== 0) {
  fs.writeFileSync(target, original)
  fail('node --check 未通过，已恢复原文件', { stderr: String(check.stderr).slice(0, 1200) })
}

console.log(
  JSON.stringify(
    { ok: true, target, backup, changes, restart: 'kill $(cat /tmp/mcp.pid) 后由 supervise 自动拉起' },
    null,
    2
  )
)
