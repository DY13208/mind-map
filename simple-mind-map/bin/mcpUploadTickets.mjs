import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

// Agent 侧（WorkBuddy / OpenClaw）的文件在 MCP 进程所在容器里读不到，
// 而把上万字符的 base64 塞进 JSON-RPC 参数又不可靠。票据直传给字节流开
// 一条专用通道：create_upload_ticket 签发一次性 id，agent 用 curl 把原始
// 字节 PUT 到 /mcp-upload/<id>，再用 upload_attachment(upload_id=...) 落库。
export const MAX_UPLOAD_BYTES = 24 * 1024 * 1024
const DEFAULT_TTL_SEC = 900
const MAX_TTL_SEC = 3600
const MIN_TTL_SEC = 60
const TICKET_DIR = path.join(os.tmpdir(), 'mcp-upload-tickets')

/** uploadId → ticket record. In-process only: a restart invalidates pending tickets. */
const tickets = new Map()

function ensureDir() {
  fs.mkdirSync(TICKET_DIR, { recursive: true })
}

function ticketFile(uploadId) {
  return path.join(TICKET_DIR, `${uploadId}.bin`)
}

function publicBase() {
  return String(
    process.env.MCP_PUBLIC_BASE_URL ||
      process.env.MCP_PUBLIC_BASE ||
      process.env.PUBLIC_BASE_URL ||
      ''
  )
    .trim()
    .replace(/\/+$/, '')
}

function dropTicket(uploadId) {
  tickets.delete(uploadId)
  fs.rm(ticketFile(uploadId), { force: true }, () => {})
}

function prune(now = Date.now()) {
  for (const [id, rec] of tickets) {
    if (rec.expiresAt <= now) dropTicket(id)
  }
}

let sweeper = null
function ensureSweeper() {
  if (sweeper) return
  sweeper = setInterval(() => prune(), 60 * 1000)
  if (typeof sweeper.unref === 'function') sweeper.unref()
}

/**
 * Issue a one-shot upload ticket bound to a room (and optionally a node).
 * The returned upload_url is what the agent should curl the bytes to.
 */
export function createUploadTicket({
  roomKey,
  nodeRef = '',
  fileName = '',
  mimeType = '',
  ttlSec
} = {}) {
  const room = String(roomKey || '').trim()
  if (!room) throw new Error('缺少 room_key，未签发上传票据')
  const requested = Number(ttlSec)
  const ttl = Math.min(
    MAX_TTL_SEC,
    Math.max(MIN_TTL_SEC, Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_TTL_SEC)
  )
  ensureDir()
  ensureSweeper()
  prune()

  const uploadId = randomBytes(24).toString('hex')
  const expiresAt = Date.now() + ttl * 1000
  tickets.set(uploadId, {
    uploadId,
    roomKey: room,
    nodeRef: String(nodeRef || '').trim(),
    fileName: String(fileName || '').trim(),
    mimeType: String(mimeType || '').trim(),
    expiresAt,
    bytes: 0,
    receivedAt: 0,
    consumedAt: 0
  })

  const base = publicBase()
  const uploadPath = `/mcp-upload/${uploadId}`
  return {
    upload_id: uploadId,
    upload_path: uploadPath,
    upload_url: base ? `${base}${uploadPath}` : '',
    room_key: room,
    node: tickets.get(uploadId).nodeRef || undefined,
    file_name: tickets.get(uploadId).fileName || undefined,
    max_bytes: MAX_UPLOAD_BYTES,
    ttl_sec: ttl,
    expires_at: new Date(expiresAt).toISOString(),
    hint:
      '用 curl -s -X POST --data-binary @<本地文件绝对路径> "<upload_url>" 直传原始字节（不要 base64）；' +
      '传完再调 upload_attachment 并带上 upload_id'
  }
}

/** Ticket lookup with expiry enforcement. Returns null when unknown/expired. */
export function getUploadTicket(uploadId) {
  const id = String(uploadId || '').trim()
  if (!id) return null
  const rec = tickets.get(id)
  if (!rec) return null
  if (rec.expiresAt <= Date.now()) {
    dropTicket(id)
    return null
  }
  return rec
}

/** Persist the bytes an agent just pushed to /mcp-upload/<id>. */
export async function saveTicketBytes(uploadId, buffer) {
  const rec = getUploadTicket(uploadId)
  if (!rec) {
    return { ok: false, code: 'TICKET_NOT_FOUND', message: '上传票据不存在或已过期' }
  }
  if (rec.receivedAt) {
    return { ok: false, code: 'TICKET_ALREADY_USED', message: '该票据已接收过文件，请重新签发' }
  }
  const size = buffer && buffer.length ? buffer.length : 0
  if (size === 0) {
    return { ok: false, code: 'EMPTY_PAYLOAD', message: '未收到文件字节' }
  }
  if (size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      code: 'PAYLOAD_TOO_LARGE',
      message: `文件过大（${size} 字节，上限 ${MAX_UPLOAD_BYTES}）`
    }
  }
  ensureDir()
  await fsp.writeFile(ticketFile(rec.uploadId), buffer)
  rec.bytes = size
  rec.receivedAt = Date.now()
  return { ok: true, ticket: rec }
}

export async function readTicketBytes(rec) {
  return fsp.readFile(ticketFile(rec.uploadId))
}

/** Release the temp file and the ticket, whether the mount succeeded or not. */
export function discardUploadTicket(uploadId) {
  const id = String(uploadId || '').trim()
  if (!id) return
  dropTicket(id)
}

/** Diagnostics: how many tickets are outstanding right now. */
export function uploadTicketStats() {
  prune()
  return {
    pending: tickets.size,
    dir: TICKET_DIR,
    max_bytes: MAX_UPLOAD_BYTES
  }
}
