'use strict'

// 节点评论的合并与校验（服务端 / MCP 共用）。
// 评论数组按 id 做并集合并：新增互不覆盖，删除用墓碑 {id, deleted:true, deletedAt}
// 表示并且删除优先；墓碑超过保留期后压缩掉。与 src/utils/nodeComment.js 的
// mergeComments 保持同一算法（有对拍测试）。

const COMMENT_MAX_LENGTH = 2000
const COMMENT_MAX_PER_NODE = 500
const COMMENT_MAX_MENTIONS = 20
const COMMENT_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const COMMENT_MAX_TOMBSTONES = 1000
const COMMENT_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(CONTROL_RE, '').slice(0, max)
}

function hashString(text) {
  let h = 2166136261
  const s = String(text)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h.toString(36)
}

function normalizeMentions(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const name = cleanText(item.name, 64).trim()
    const userId = cleanText(item.userId != null ? item.userId : item.user_id, 160).trim()
    const key = userId || name
    if (!name || seen.has(key)) continue
    seen.add(key)
    out.push({ userId, name })
    if (out.length >= COMMENT_MAX_MENTIONS) break
  }
  return out
}

function safeAvatar(value) {
  const url = String(value || '').trim()
  if (url.length > 512) return ''
  return /^(https?:)?\/\//i.test(url) || /^data:image\/(png|jpe?g|gif|webp);/i.test(url) ? url : ''
}

// 单条评论规范化；无法识别的返回 null（不抛错，保证渲染/合并不崩）
function normalizeComment(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  let id = String(item.id == null ? '' : item.id).trim()
  if (item.deleted === true) {
    if (!COMMENT_ID_RE.test(id)) return null
    const tomb = { id, deleted: true, deletedAt: Number(item.deletedAt) || 0 }
    if (item.deletedBy) tomb.deletedBy = cleanText(item.deletedBy, 160)
    return tomb
  }
  const content = cleanText(item.content, COMMENT_MAX_LENGTH).trim()
  if (!content) return null
  const time = Number(item.time) || 0
  if (!COMMENT_ID_RE.test(id)) id = `legacy_${time.toString(36)}_${hashString(content)}`
  const out = {
    id,
    userId: cleanText(item.userId, 160),
    userName: cleanText(item.userName, 64),
    avatar: safeAvatar(item.avatar),
    content,
    time
  }
  const mentions = normalizeMentions(item.mentions)
  if (mentions.length) out.mentions = mentions
  const replyTo = String(item.replyTo || '').trim()
  if (replyTo && COMMENT_ID_RE.test(replyTo)) out.replyTo = replyTo
  return out
}

function compareComments(a, b) {
  const ta = a.deleted ? a.deletedAt : a.time
  const tb = b.deleted ? b.deletedAt : b.time
  if (ta !== tb) return ta - tb
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * 合并两份评论数组（交换律、结合律、幂等）。
 * options.now / tombstoneTtlMs 控制过期墓碑压缩（0 表示不压缩）；
 * options.maxPerNode 限制存活评论数（保留最新）。
 */
function mergeComments(base, incoming, options = {}) {
  const now = Number(options.now) || Date.now()
  const ttl = options.tombstoneTtlMs == null ? COMMENT_TOMBSTONE_TTL_MS : Number(options.tombstoneTtlMs)
  const maxPerNode = Number(options.maxPerNode) || COMMENT_MAX_PER_NODE
  const byId = new Map()
  const take = list => {
    if (!Array.isArray(list)) return
    for (const raw of list) {
      const item = normalizeComment(raw)
      if (!item) continue
      const prev = byId.get(item.id)
      if (!prev) {
        byId.set(item.id, item)
      } else if (item.deleted || prev.deleted) {
        let tomb
        if (item.deleted && prev.deleted) tomb = item.deletedAt >= prev.deletedAt ? item : prev
        else tomb = item.deleted ? item : prev
        byId.set(item.id, tomb)
      } else if (compareComments(item, prev) < 0) {
        // 同 id 的两条存活评论：取较早的那份，保证结果确定
        byId.set(item.id, item)
      }
    }
  }
  take(base)
  take(incoming)
  let live = []
  let tombs = []
  for (const item of byId.values()) {
    if (item.deleted) {
      if (ttl > 0 && item.deletedAt && now - item.deletedAt > ttl) continue
      tombs.push(item)
    } else {
      live.push(item)
    }
  }
  live.sort(compareComments)
  tombs.sort(compareComments)
  if (live.length > maxPerNode) live = live.slice(live.length - maxPerNode)
  if (tombs.length > COMMENT_MAX_TOMBSTONES) tombs = tombs.slice(tombs.length - COMMENT_MAX_TOMBSTONES)
  return live.concat(tombs)
}

function liveComments(list) {
  return mergeComments([], list, { tombstoneTtlMs: 0 }).filter(item => !item.deleted)
}

function commentError(message, code, statusCode = 400, details) {
  const err = new Error(message)
  err.code = code
  err.statusCode = statusCode
  if (details) err.details = details
  return err
}

// 校验新评论输入（来自 HTTP / MCP），返回规范化后的评论
function validateNewComment(input = {}, actor = {}, now = Date.now()) {
  const rawContent = input.content == null ? '' : String(input.content)
  const content = rawContent.replace(CONTROL_RE, '').trim()
  if (!content) throw commentError('评论内容不能为空', 'COMMENT_EMPTY')
  if (content.length > COMMENT_MAX_LENGTH) {
    throw commentError(`评论不能超过 ${COMMENT_MAX_LENGTH} 字`, 'COMMENT_TOO_LONG', 400, { max: COMMENT_MAX_LENGTH })
  }
  const id = input.id == null || input.id === '' ? '' : String(input.id).trim()
  if (id && !COMMENT_ID_RE.test(id)) {
    throw commentError('评论 id 只能包含字母、数字和 _.:-，最长 80', 'COMMENT_ID_INVALID')
  }
  if (input.mentions != null && !Array.isArray(input.mentions)) {
    throw commentError('mentions 必须是数组', 'COMMENT_MENTIONS_INVALID')
  }
  if (Array.isArray(input.mentions) && input.mentions.length > COMMENT_MAX_MENTIONS) {
    throw commentError(`最多 @ ${COMMENT_MAX_MENTIONS} 人`, 'COMMENT_TOO_MANY_MENTIONS')
  }
  const replyTo = input.replyTo == null || input.replyTo === '' ? '' : String(input.replyTo).trim()
  if (replyTo && !COMMENT_ID_RE.test(replyTo)) throw commentError('reply_to 无效', 'COMMENT_REPLY_INVALID')
  return normalizeComment({
    id: id || `c_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    userId: actor.userId,
    userName: actor.userName || actor.userId,
    avatar: actor.avatar,
    content,
    time: now,
    mentions: input.mentions,
    replyTo
  })
}

function decodeCursor(cursor) {
  if (!cursor) return 0
  try {
    const value = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'))
    const offset = Number(value && value.o)
    if (Number.isSafeInteger(offset) && offset >= 0) return offset
  } catch (e) {
    // fall through
  }
  throw commentError('cursor 无效', 'COMMENT_CURSOR_INVALID')
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url')
}

function stripHtml(text) {
  return String(text || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
}

/**
 * 全图评论查询：按时间倒序分页。每次请求遍历一次节点快照，不建常驻索引；
 * @提及 等过滤条件在遍历时现算。
 */
function listMapComments(nodes, filters = {}) {
  const limit = Math.max(1, Math.min(200, Number(filters.limit) || 50))
  const offset = decodeCursor(filters.cursor)
  const since = Number(filters.since) || 0
  const mentioned = String(filters.mentioned || '').trim()
  const author = String(filters.author || '').trim()
  const q = String(filters.q || '').trim().toLowerCase()
  const unresolvedOnly = !!filters.unresolved
  const matches = []
  let threads = 0
  for (const uid of Object.keys(nodes || {})) {
    const node = nodes[uid]
    const data = (node && node.data) || {}
    if (!Array.isArray(data.comments) || !data.comments.length) continue
    const resolved = !!data.commentResolved
    if (unresolvedOnly && resolved) continue
    const live = liveComments(data.comments)
    if (!live.length) continue
    threads += 1
    for (const c of live) {
      if (since && c.time <= since) continue
      if (author && c.userId !== author) continue
      if (mentioned && !(c.mentions || []).some(m => m.userId === mentioned || m.name === mentioned)) continue
      if (q && !c.content.toLowerCase().includes(q)) continue
      matches.push({ node_uid: uid, node_text: stripHtml(data.text), resolved, comment: c })
    }
  }
  matches.sort((a, b) => b.comment.time - a.comment.time || (a.comment.id < b.comment.id ? -1 : 1))
  const page = matches.slice(offset, offset + limit)
  const nextOffset = offset + page.length
  return {
    total: matches.length,
    threads,
    list: page,
    has_more: nextOffset < matches.length,
    next_cursor: nextOffset < matches.length ? encodeCursor(nextOffset) : null
  }
}

module.exports = {
  COMMENT_MAX_LENGTH,
  COMMENT_MAX_PER_NODE,
  COMMENT_MAX_MENTIONS,
  COMMENT_TOMBSTONE_TTL_MS,
  COMMENT_MAX_TOMBSTONES,
  COMMENT_ID_RE,
  normalizeComment,
  normalizeMentions,
  mergeComments,
  liveComments,
  validateNewComment,
  listMapComments,
  encodeCursor,
  decodeCursor,
  commentError
}
