// 一次性直传票据 · 桥接模块（不改动 mcpAttachmentUpload.mjs 原文）
//
// 背景：Agent（WorkBuddy / OpenClaw）手里的文件在它自己机器上，MCP 服务跑在
// 远端容器里读不到；把几万字符的 base64 塞进 JSON-RPC 参数又会因为手工拼接出错
// 而报 INVALID_BASE64。
//
// 做法：给 upload_attachment 加一条「票据」通道——
//   1) POST /mcp-upload/new?room_key=...&node=...&file_name=... 拿到 upload_id
//   2) curl --data-binary @本地文件 POST /mcp-upload/<upload_id>  直传原始字节
//   3) upload_attachment(content_base64="__ticket__:<upload_id>", ...) 完成挂载
// 票据一次性，挂载成功或失败后都释放临时文件。
//
// 为什么用 content_base64 前缀而不是新增 upload_id 参数：MCP SDK 会用 zod schema
// 校验参数，schema 里没有的键会被丢掉。复用已有字段就不用改 schema，也不依赖
// 具体版本的工具注册代码结构，补丁面最小。
import {
  createUploadTicket,
  getUploadTicket,
  saveTicketBytes,
  readTicketBytes,
  discardUploadTicket,
  MAX_UPLOAD_BYTES
} from './mcpUploadTickets.mjs'
import { resolveAttachmentUploadInput as rawResolveAttachmentUploadInput } from './mcpAttachmentUpload.mjs'

// 原模块的其他导出原样透出，替换 import 路径后不丢任何能力
export * from './mcpAttachmentUpload.mjs'

const TICKET_PREFIX = '__ticket__:'

/** upload_attachment 的入参解析：票据前缀 → 真实 base64，其余原样交给原实现。 */
export async function resolveAttachmentUploadInput(input = {}) {
  const raw = typeof input.content_base64 === 'string' ? input.content_base64 : ''
  if (!raw.startsWith(TICKET_PREFIX)) {
    return rawResolveAttachmentUploadInput(input)
  }
  const uploadId = raw.slice(TICKET_PREFIX.length).trim()
  const ticket = getUploadTicket(uploadId)
  try {
    if (!ticket) {
      throw new Error('上传票据不存在或已过期，请重新 POST /mcp-upload/new 签发')
    }
    if (!ticket.receivedAt) {
      throw new Error(`票据尚未收到文件字节，请先 POST 到 /mcp-upload/${uploadId}`)
    }
    if (input.room_key && ticket.roomKey && input.room_key !== ticket.roomKey) {
      throw new Error('票据与 room_key 不匹配，请重新签发')
    }
    if (input.node && ticket.nodeRef && input.node !== ticket.nodeRef) {
      throw new Error('票据与目标节点不匹配，请重新签发')
    }
    const buffer = await readTicketBytes(ticket)
    return await rawResolveAttachmentUploadInput({
      ...input,
      content_base64: buffer.toString('base64'),
      file_name: input.file_name || ticket.fileName || undefined,
      mime_type: input.mime_type || ticket.mimeType || undefined
    })
  } finally {
    discardUploadTicket(uploadId)
  }
}

function sendJson(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let received = 0
    let tooLarge = false
    req.on('data', chunk => {
      if (tooLarge) return
      received += chunk.length
      if (received > MAX_UPLOAD_BYTES) {
        tooLarge = true
        chunks.length = 0
        req.resume() // 排空剩余字节，避免连接被粗暴截断
        resolve({ tooLarge: true, buffer: null })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve({ tooLarge, buffer: Buffer.concat(chunks) }))
    req.on('error', reject)
  })
}

/**
 * /mcp-upload/* 的 HTTP 处理：
 *   POST /mcp-upload/new?...  → 签发票据
 *   POST|PUT /mcp-upload/<id> → 接收原始字节
 *   GET  /mcp-upload/ping     → 存活自检
 */
export async function handleMcpUploadHttp(req, res, url) {
  const rest = decodeURIComponent(url.pathname.slice('/mcp-upload/'.length)).replace(/\/+$/, '')

  if (rest === 'ping') {
    sendJson(res, 200, { ok: true, route: 'mcp-upload' })
    return
  }

  if (rest === 'new') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed, use POST' })
      return
    }
    try {
      const q = url.searchParams
      const ticket = createUploadTicket({
        roomKey: q.get('room_key') || '',
        nodeRef: q.get('node') || '',
        fileName: q.get('file_name') || '',
        mimeType: q.get('mime_type') || '',
        ttlSec: q.get('ttl_sec') || undefined
      })
      sendJson(res, 200, {
        ...ticket,
        next:
          `curl -s -X POST --data-binary @<本地文件绝对路径> "<upload_url || upload_path>"，` +
          `然后 upload_attachment 传 content_base64="__ticket__:${ticket.upload_id}"`
      })
    } catch (err) {
      sendJson(res, 400, { error: 'TICKET_CREATE_FAILED', message: String(err && err.message) })
    }
    return
  }

  if (!rest) {
    sendJson(res, 400, { error: 'missing upload id' })
    return
  }
  if (req.method !== 'POST' && req.method !== 'PUT') {
    sendJson(res, 405, { error: 'method not allowed, use POST or PUT' })
    return
  }

  const ticket = getUploadTicket(rest)
  if (!ticket) {
    sendJson(res, 404, {
      error: 'TICKET_NOT_FOUND',
      message: '上传票据不存在或已过期，请重新 POST /mcp-upload/new'
    })
    return
  }
  if (ticket.receivedAt) {
    sendJson(res, 409, { error: 'TICKET_ALREADY_USED', message: '该票据已接收过文件，请重新签发' })
    return
  }
  const declared = Number(req.headers['content-length'] || 0)
  if (declared > MAX_UPLOAD_BYTES) {
    sendJson(res, 413, {
      error: 'PAYLOAD_TOO_LARGE',
      message: `文件过大（${declared} 字节，上限 ${MAX_UPLOAD_BYTES}）`
    })
    return
  }

  let body
  try {
    body = await collectBody(req)
  } catch (err) {
    sendJson(res, 400, { error: 'READ_FAILED', message: String(err && err.message) })
    return
  }
  if (body.tooLarge) {
    sendJson(res, 413, {
      error: 'PAYLOAD_TOO_LARGE',
      message: `文件超过上限（${MAX_UPLOAD_BYTES} 字节），传输已中止`
    })
    return
  }

  const saved = await saveTicketBytes(rest, body.buffer)
  if (!saved.ok) {
    sendJson(res, saved.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, {
      error: saved.code,
      message: saved.message
    })
    return
  }
  sendJson(res, 200, {
    ok: true,
    upload_id: rest,
    bytes: saved.ticket.bytes,
    file_name: ticket.fileName || undefined,
    next:
      `字节已接收。调用 upload_attachment 时把 content_base64 设为 "__ticket__:${rest}"` +
      `（room_key="${ticket.roomKey}"` +
      (ticket.nodeRef ? `，node="${ticket.nodeRef}"` : '') +
      '）；票据一次性，挂载后作废。'
  })
}
