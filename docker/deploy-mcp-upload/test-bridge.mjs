// 桥接模块运行时自测：桩掉 mcpAttachmentUpload，验证 /new → 直传字节 → __ticket__ 换真身 → 票据一次性
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const bin = path.join(dir, 'bin')

// 0) 把桥接模块和票据模块放进桩目录（src 是真实文件，不改）
fs.mkdirSync(bin, { recursive: true })
for (const f of ['mcpUploadBridge.mjs', 'mcpUploadTickets.mjs']) {
  fs.copyFileSync(path.join(dir, f), path.join(bin, f))
}

// 1) 桩 mcpAttachmentUpload：把收到的入参原样回显（只留长度，避免刷屏）
fs.writeFileSync(
  path.join(bin, 'mcpAttachmentUpload.mjs'),
  `export async function resolveAttachmentUploadInput(input = {}) {
  return {
    stub: true,
    file_name: input.file_name || null,
    mime_type: input.mime_type || null,
    decoded_bytes: Buffer.from(input.content_base64 || '', 'base64').length,
    otherExports: 'kept'
  }
}
export const otherThing = 'kept'
`
)

// 2) 造一个「服务器风格」的 mcpServer：只有 /mcp 判定，没有 /mcp-upload 路由
//    注意函数必须是 async —— 真实代码是 async (req,res) => {}，补丁会插入 await
fs.writeFileSync(
  path.join(bin, 'mcpServer.mjs'),
  `import { resolveAttachmentUploadInput } from './mcpAttachmentUpload.mjs'
const url = { pathname: '/' }
export async function route(req, res) {
  if (url.pathname !== '/mcp') {
    return 'fallback'
  }
  return resolveAttachmentUploadInput
}
`
)

// 3) 跑补丁
const { spawnSync } = await import('node:child_process')
const patch = spawnSync(process.execPath, [path.join(dir, 'patch-mcp-upload.mjs')], {
  encoding: 'utf8',
  env: { ...process.env, MCP_BIN_DIR: bin }
})
console.log('--- patch ---')
console.log(patch.stdout.trim())
if (patch.status !== 0) process.exit(1)

const patched = fs.readFileSync(path.join(bin, 'mcpServer.mjs'), 'utf8')
const hasRoute = patched.includes("url.pathname.startsWith('/mcp-upload/')")
const hasHandler = patched.includes('handleMcpUploadHttp(req, res, url)')
const swapped = patched.includes("from './mcpUploadBridge.mjs'")
const starKept = (await import(path.join(bin, 'mcpUploadBridge.mjs'))).otherThing === 'kept'
console.log(JSON.stringify({ hasRoute, hasHandler, swapped, starReexportKept: starKept }))

// 4) 起服务，走一遍真实 HTTP 流程
const bridge = await import(path.join(bin, 'mcpUploadBridge.mjs'))
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname.startsWith('/mcp-upload/')) {
    bridge.handleMcpUploadHttp(req, res, url).catch(err => {
      res.writeHead(500)
      res.end(String(err))
    })
    return
  }
  res.writeHead(404)
  res.end('nope')
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

const ticket = await fetch(
  `${base}/mcp-upload/new?room_key=room-test&node=node-1&file_name=resume.html&mime_type=text/html`,
  { method: 'POST' }
).then(r => r.json())
console.log('ticket:', JSON.stringify(ticket))

const payload = Buffer.from('<html>梁振星简历内容</html>')
const up = await fetch(`${base}/mcp-upload/${ticket.upload_id}`, { method: 'POST', body: payload }).then(r =>
  r.json()
)
console.log('upload:', JSON.stringify(up))

const resolved = await bridge.resolveAttachmentUploadInput({
  room_key: 'room-test',
  node: 'node-1',
  content_base64: `__ticket__:${ticket.upload_id}`
})
console.log('resolve:', JSON.stringify(resolved))

let secondUse
try {
  await bridge.resolveAttachmentUploadInput({
    room_key: 'room-test',
    node: 'node-1',
    content_base64: `__ticket__:${ticket.upload_id}`
  })
  secondUse = 'NO_ERROR_BAD'
} catch (err) {
  secondUse = String(err.message)
}
console.log('second use:', secondUse)

// 普通 base64 应原样透传（不被票据逻辑影响）
const plain = await bridge.resolveAttachmentUploadInput({ content_base64: Buffer.from('abc').toString('base64') })
console.log('plain passthrough:', JSON.stringify(plain))

const ok =
  hasRoute &&
  hasHandler &&
  swapped &&
  starKept &&
  up.ok === true &&
  resolved.decoded_bytes === payload.length &&
  resolved.file_name === 'resume.html' &&
  resolved.mime_type === 'text/html' &&
  /票据不存在/.test(secondUse) &&
  plain.stub === true

console.log('RESULT:', ok ? 'ALL_PASS' : 'FAILED')
server.close()
process.exit(ok ? 0 : 1)
