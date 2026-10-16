'use strict'

// 节点评论 HTTP 接口。写入统一走 executeOperation(node.update)：与网页编辑同一条
// 协作提交管道（房间锁、修订号、历史、实时广播）。评论补丁在房间锁内基于最新数据
// 计算，并由 fieldMerge 按评论 id 合并，所以并发评论互不覆盖。
const crypto = require('crypto')
const { resolveDisplayName } = require('./displayName')
const {
  COMMENT_MAX_PER_NODE,
  COMMENT_ID_RE,
  liveComments,
  mergeComments,
  validateNewComment,
  listMapComments,
  commentError
} = require('./commentMerge')

const MAP_LIST_RE = /^\/api\/files\/([^/]+)\/comments$/
const NODE_RE = /^\/api\/files\/([^/]+)\/nodes\/([^/]+)\/comments(?:\/([^/]+))?$/

function decode(value) {
  try {
    return decodeURIComponent(value)
  } catch (e) {
    return value
  }
}

function matchCommentRoute(pathname) {
  const path = String(pathname || '')
  let m = path.match(MAP_LIST_RE)
  if (m) return { kind: 'map', roomKey: decode(m[1]) }
  m = path.match(NODE_RE)
  if (!m) return null
  const tail = m[3] ? decode(m[3]) : ''
  if (tail === 'resolve') return { kind: 'resolve', roomKey: decode(m[1]), nodeUid: decode(m[2]) }
  return { kind: tail ? 'comment' : 'node', roomKey: decode(m[1]), nodeUid: decode(m[2]), commentId: tail }
}

// 由「房间+节点+动作+评论 id」得到确定的 UUID(v5 形式)，同一请求重试会被提交层去重
function stableOperationId(...parts) {
  const hex = crypto.createHash('sha1').update(parts.join('\u0001')).digest('hex').slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = ['8', '9', 'a', 'b'][parseInt(hex[16], 16) % 4]
  const h = hex.join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

function actorOf(req, access = {}) {
  const user = (req && req.authUser) || {}
  const mcp = (req && req.verifiedMcpSource) || {}
  const userId = String(access.userId || user.id || mcp.principalId || 'anonymous').slice(0, 160)
  return {
    userId,
    userName: String(
      (user && Object.keys(user).length ? resolveDisplayName(user) : '') ||
        mcp.principalName ||
        userId
    ).slice(0, 64),
    avatar: String(user.avatar || '')
  }
}

// 管理员 / 房主可删除他人评论
function canModerate(access = {}) {
  return !!(access.superAdmin || access.canManage || access.role === 'owner')
}

function nodeView(roomKey, nodeUid, data = {}) {
  const comments = liveComments(data.comments)
  return {
    room_key: roomKey,
    node_uid: nodeUid,
    resolved: !!data.commentResolved,
    count: comments.length,
    comments
  }
}

function boolParam(value) {
  return value === true || value === 1 || ['1', 'true', 'yes'].includes(String(value || '').toLowerCase())
}

function sinceParam(value) {
  if (!value) return 0
  const n = Number(value)
  if (Number.isFinite(n) && n > 0) return n
  const t = Date.parse(value)
  if (Number.isFinite(t)) return t
  throw commentError('since 需要是时间戳或 ISO 时间', 'COMMENT_SINCE_INVALID')
}

function createCommentApi(deps) {
  const {
    executeOperation,
    normalizeCommand,
    loadSnapshot,
    readBody,
    sendJson,
    roomAcl,
    getPool,
    operationResponse
  } = deps

  async function loadNodes(roomKey) {
    const loaded = await loadSnapshot(roomKey)
    if (!loaded || !loaded.obj) throw commentError('脑图不存在', 'ROOM_NOT_FOUND', 404)
    const row = loaded.row || {}
    return { nodes: loaded.obj, version: Number(row.version || row.revision || 0) }
  }

  // 在房间锁内基于当前数据计算补丁；compute 返回 noop 时不产生新修订
  async function writeComments(req, roomKey, nodeUid, operationId, compute) {
    let outcome = null
    const command = normalizeCommand(req, roomKey, { operation_id: operationId }, 'node.update', {
      uid: nodeUid,
      patch: {},
      // 评论不改变 SOP 内容本身，不需要 SOP 二次确认
      confirm_sop_change: true
    })
    // 评论在锁内合并，不需要基于版本的乐观冲突检查
    command.baseVersion = null
    const committed = await executeOperation(req, roomKey, command, {
      validateBase: ({ nodes, currentVersion }) => {
        const node = nodes && nodes[nodeUid]
        if (!node) throw commentError('节点不存在', 'NODE_NOT_FOUND', 404, { node_uid: nodeUid })
        outcome = compute(node.data || {})
        if (outcome.noop) {
          return {
            noop: true,
            result: { version: currentVersion, node: { uid: nodeUid, data: node.data || {} } }
          }
        }
        command.payload.patch = outcome.patch
        return null
      }
    })
    const node = committed.noop ? committed.node : committed.nodes && committed.nodes[nodeUid]
    const data = (node && node.data) || {}
    const version = committed.noop
      ? Number(committed.version || 0)
      : Number((committed.operation && committed.operation.version) || 0)
    const op =
      !committed.noop && committed.operation && typeof operationResponse === 'function'
        ? operationResponse(roomKey, committed)
        : {}
    return {
      ...op,
      ok: true,
      ...nodeView(roomKey, nodeUid, data),
      ...((outcome && outcome.extra) || {}),
      changed: !committed.noop,
      revision: version,
      version
    }
  }

  async function addComment(req, roomKey, nodeUid, body = {}) {
    const access = await roomAcl.assertRoomAccess(getPool(), req, roomKey, 'edit')
    const actor = actorOf(req, access)
    const comment = validateNewComment(
      {
        id: body.id || body.comment_id,
        content: body.content,
        mentions: body.mentions,
        replyTo: body.reply_to || body.replyTo
      },
      actor
    )
    const operationId = body.operation_id || stableOperationId(roomKey, nodeUid, 'comment.add', comment.id, comment.userId, comment.content)
    return writeComments(req, roomKey, nodeUid, operationId, data => {
      const all = mergeComments([], data.comments, { tombstoneTtlMs: 0 })
      const existing = all.find(c => c.id === comment.id)
      if (existing) {
        if (existing.deleted) throw commentError('该评论 id 已被删除，不能复用', 'COMMENT_DELETED', 409)
        if (existing.userId === comment.userId && existing.content === comment.content) {
          return { noop: true, extra: { comment: existing, duplicate: true } }
        }
        throw commentError('评论 id 已存在', 'COMMENT_ID_CONFLICT', 409, { comment_id: comment.id })
      }
      const live = all.filter(c => !c.deleted)
      if (live.length >= COMMENT_MAX_PER_NODE) {
        throw commentError(`单个节点最多 ${COMMENT_MAX_PER_NODE} 条评论`, 'COMMENT_LIMIT', 409, { max: COMMENT_MAX_PER_NODE })
      }
      if (comment.replyTo && !live.some(c => c.id === comment.replyTo)) {
        throw commentError('回复的评论不存在', 'COMMENT_REPLY_NOT_FOUND', 404, { reply_to: comment.replyTo })
      }
      // 只提交这一条，由 fieldMerge 与现有数组按 id 合并
      const patch = { comments: [comment] }
      // 新回复重新打开已解决的讨论（与网页端一致）
      if (data.commentResolved) patch.commentResolved = false
      return { patch, extra: { comment } }
    })
  }

  async function deleteComment(req, roomKey, nodeUid, commentId, body = {}) {
    if (!COMMENT_ID_RE.test(String(commentId || ''))) throw commentError('评论 id 无效', 'COMMENT_ID_INVALID')
    const access = await roomAcl.assertRoomAccess(getPool(), req, roomKey, 'edit')
    const actor = actorOf(req, access)
    const moderator = canModerate(access)
    const operationId = body.operation_id || stableOperationId(roomKey, nodeUid, 'comment.delete', commentId)
    return writeComments(req, roomKey, nodeUid, operationId, data => {
      const all = mergeComments([], data.comments, { tombstoneTtlMs: 0 })
      const existing = all.find(c => c.id === commentId)
      if (!existing) throw commentError('评论不存在', 'COMMENT_NOT_FOUND', 404, { comment_id: commentId })
      if (existing.deleted) return { noop: true, extra: { comment_id: commentId, already_deleted: true } }
      if (existing.userId !== actor.userId && !moderator) {
        throw commentError('只能删除自己的评论', 'COMMENT_FORBIDDEN', 403)
      }
      const tomb = { id: commentId, deleted: true, deletedAt: Date.now(), deletedBy: actor.userId }
      return { patch: { comments: [tomb] }, extra: { comment_id: commentId, deleted: true } }
    })
  }

  async function resolveThread(req, roomKey, nodeUid, body = {}) {
    await roomAcl.assertRoomAccess(getPool(), req, roomKey, 'edit')
    const resolved = body.resolved === undefined ? true : boolParam(body.resolved)
    const operationId = body.operation_id || crypto.randomUUID()
    return writeComments(req, roomKey, nodeUid, operationId, data => {
      if (!liveComments(data.comments).length) throw commentError('该节点没有评论', 'COMMENT_THREAD_EMPTY', 409)
      if (!!data.commentResolved === resolved) return { noop: true }
      return { patch: { commentResolved: resolved } }
    })
  }

  async function listNode(roomKey, nodeUid) {
    const { nodes, version } = await loadNodes(roomKey)
    const node = nodes[nodeUid]
    if (!node) throw commentError('节点不存在', 'NODE_NOT_FOUND', 404, { node_uid: nodeUid })
    return { ok: true, ...nodeView(roomKey, nodeUid, node.data || {}), revision: version }
  }

  async function listMap(roomKey, params) {
    const { nodes, version } = await loadNodes(roomKey)
    const result = listMapComments(nodes, {
      unresolved: boolParam(params.get('unresolved')),
      mentioned: params.get('mentioned') || '',
      author: params.get('author') || '',
      since: sinceParam(params.get('since')),
      q: params.get('q') || '',
      limit: params.get('limit'),
      cursor: params.get('cursor') || ''
    })
    return { ok: true, room_key: roomKey, revision: version, ...result }
  }

  async function handle(req, res, { url, pathname }) {
    const route = matchCommentRoute(pathname)
    if (!route) return false
    const method = String(req.method || 'GET').toUpperCase()
    try {
      let result
      let status = 200
      if (route.kind === 'map' && method === 'GET') {
        result = await listMap(route.roomKey, url.searchParams)
      } else if (route.kind === 'node' && method === 'GET') {
        result = await listNode(route.roomKey, route.nodeUid)
      } else if (route.kind === 'node' && method === 'POST') {
        result = await addComment(req, route.roomKey, route.nodeUid, (await readBody(req)) || {})
        if (result.changed) status = 201
      } else if (route.kind === 'resolve' && (method === 'POST' || method === 'PUT')) {
        result = await resolveThread(req, route.roomKey, route.nodeUid, (await readBody(req)) || {})
      } else if (route.kind === 'comment' && method === 'DELETE') {
        result = await deleteComment(req, route.roomKey, route.nodeUid, route.commentId, {
          operation_id: url.searchParams.get('operation_id') || undefined
        })
      } else {
        sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'method not allowed' })
        return true
      }
      sendJson(res, status, result)
    } catch (err) {
      sendJson(res, err.statusCode || 400, {
        ok: false,
        code: err.code || 'COMMENT_ERROR',
        error: err.message || '评论操作失败',
        ...(err.details ? { details: err.details } : {})
      })
    }
    return true
  }

  return { handle, addComment, deleteComment, resolveThread, listNode, listMap }
}

module.exports = { createCommentApi, matchCommentRoute, stableOperationId, canModerate, actorOf }
