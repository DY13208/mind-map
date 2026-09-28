const crypto = require('crypto')
const { getPool, sendJson, readBody, safeRoomKey, commitDirectRoomOperation } = require('./storage')
const { comparePositions } = require('./fractionalIndex')
const roomAcl = require('./roomAcl')
const { normalizeOperation, toCommand, fromCommitted, isOpId } = require('./collabV2/protocol')
const { applyDirect } = require('./collabV2/directApplier')
const { createPgStore } = require('./collabV2/directStore')
const attachmentStore = require('./nodeKnowledge/store')
const { attachmentResponseHeaders } = require('./nodeKnowledge/limits')

let schemaReady
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = getPool().query(`
      create table if not exists node_shares (
        id uuid primary key,
        token_hash text not null,
        room_key text not null,
        root_uid text not null,
        role text not null check (role in ('viewer', 'editor')),
        recipient_user_id text,
        recipient_user_ids text[],
        created_by text not null,
        expires_at timestamptz,
        revoked_at timestamptz,
        created_at timestamptz not null default now()
      )
    `).then(() => getPool().query('alter table node_shares add column if not exists recipient_user_ids text[]')).then(() => getPool().query(`
      create table if not exists node_share_presence (
        share_id uuid not null references node_shares(id) on delete cascade,
        client_id text not null,
        user_id text not null,
        name text not null,
        editing_uid text,
        expires_at timestamptz not null,
        primary key (share_id, client_id)
      )
    `)).then(() => getPool().query(`
      create table if not exists node_share_audit (
        id bigserial primary key,
        share_id uuid not null references node_shares(id) on delete cascade,
        user_id text not null,
        operation_type text not null,
        target_uid text,
        room_version bigint not null,
        created_at timestamptz not null default now()
      )
    `)).catch(err => { schemaReady = null; throw err })
  }
  return schemaReady
}

function fail(statusCode, code, message) {
  const err = new Error(message)
  err.statusCode = statusCode
  err.code = code
  throw err
}

function actor(req) {
  if (req.authUser && req.authUser.service) fail(403, 'FORBIDDEN', '服务账号不能使用节点分享')
  const id = String(req.authUser && req.authUser.id || '').trim()
  if (!id) fail(401, 'UNAUTHORIZED', '请先登录')
  return id
}

function digest(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex')
}

function shareRecipients(row) {
  if (Array.isArray(row.recipient_user_ids) && row.recipient_user_ids.length) return row.recipient_user_ids
  return row.recipient_user_id ? [row.recipient_user_id] : []
}

function requestedRecipients(body, current = []) {
  if (body.recipientUserIds === undefined && body.recipientUserId === undefined) return current
  const raw = body.recipientUserIds !== undefined ? body.recipientUserIds : [body.recipientUserId]
  if (!Array.isArray(raw) || raw.length > 50) fail(400, 'BAD_RECIPIENTS', '接收账号最多 50 人')
  const recipients = [...new Set(raw.map(value => String(value || '').trim()).filter(Boolean))]
  if (recipients.some(value => value.length > 160)) fail(400, 'BAD_RECIPIENTS', '接收账号格式无效')
  return recipients
}

function publicShare(row) {
  const recipients = shareRecipients(row)
  return {
    id: row.id,
    roomKey: row.room_key,
    rootUid: row.root_uid,
    role: row.role,
    recipientUserId: recipients[0] || '',
    recipientUserIds: recipients,
    createdBy: row.created_by,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at
  }
}

function setRoomShareCookie(req, res, row, token) {
  const maxAge = row.expires_at
    ? Math.max(1, Math.min(30 * 86400, Math.ceil((new Date(row.expires_at).getTime() - Date.now()) / 1000)))
    : 30 * 86400
  const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || !!(req.socket && req.socket.encrypted)
  const cookie = [
    `${roomAcl.nodeShareCookieName(row.room_key)}=${encodeURIComponent(`${row.id}.${token}`)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`,
    ...(secure ? ['Secure'] : [])
  ].join('; ')
  const existing = res.getHeader('Set-Cookie')
  res.setHeader('Set-Cookie', existing ? [].concat(existing, cookie) : cookie)
}

function canManageShare(access, row, userId) {
  return Boolean(access.canManage || row.created_by === userId)
}

async function assertShareManager(req, row) {
  const access = await roomAcl.assertRoomAccess(getPool(), req, row.room_key, 'edit')
  if (access.shareId) fail(403, 'FORBIDDEN', '分享链接不能继续转发分享权限')
  if (!canManageShare(access, row, actor(req))) {
    fail(403, 'FORBIDDEN', '只能管理自己创建的分享')
  }
}

async function loadShare(req, id, token, action = 'view') {
  await ensureSchema()
  const result = await getPool().query('select * from node_shares where id = $1', [id])
  const row = result.rows[0]
  if (!row || row.revoked_at || (row.expires_at && new Date(row.expires_at) <= new Date())) {
    fail(404, 'SHARE_UNAVAILABLE', '分享不存在或已失效')
  }
  const given = Buffer.from(digest(token), 'hex')
  const expected = Buffer.from(row.token_hash, 'hex')
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    fail(403, 'FORBIDDEN', '分享链接无效')
  }
  const userId = actor(req)
  const recipients = shareRecipients(row)
  let creatorCanEdit = false
  if (recipients.length && !recipients.includes(userId)) {
    if (userId !== row.created_by) fail(403, 'SHARE_RECIPIENT_DENIED', '当前账号不是分享接收人')
    await roomAcl.assertRoomAccess(getPool(), req, row.room_key, 'edit')
    creatorCanEdit = true
  }
  if (action === 'edit' && (row.role !== 'editor' || !recipients.length)) {
    fail(403, 'FORBIDDEN', '没有此分支的编辑权限')
  }
  return { ...row, creatorCanEdit }
}

async function subtree(row, knownVersion = 0) {
  const db = getPool()
  const meta = await db.query(
    `select r.version from rooms r where r.room_key = $1 and r.deleted_at is null
     and not exists (select 1 from room_tombstones t where t.room_key = r.room_key)`,
    [row.room_key]
  )
  if (!meta.rows.length) fail(410, 'ROOM_REMOVED', '原脑图已被删除')
  const version = Number(meta.rows[0].version || 0)
  if (Number(knownVersion) > 0 && Number(knownVersion) === version) {
    return { uid: row.root_uid, version, unchanged: true }
  }
  const result = await db.query(
    `with recursive branch as (
       select uid, parent_uid, position, data, array[uid] as path
       from room_nodes where room_key = $1 and uid = $2 and deleted_at is null
       union all
       select n.uid, n.parent_uid, n.position, n.data, b.path || n.uid
       from room_nodes n join branch b on n.parent_uid = b.uid
       where n.room_key = $1 and n.deleted_at is null and not n.uid = any(b.path)
     ) select uid, parent_uid, position, data from branch limit 2001`,
    [row.room_key, row.root_uid]
  )
  if (!result.rows.length) fail(410, 'NODE_REMOVED', '分享的节点已被删除')
  if (result.rows.length > 2000) fail(413, 'SUBTREE_TOO_LARGE', '分支超过当前分享上限')
  const nodes = new Map()
  result.rows.forEach(item => {
    nodes.set(item.uid, {
      data: { ...(item.data || {}), uid: item.uid },
      children: [],
      position: item.position || ''
    })
  })
  result.rows.sort((a, b) => comparePositions(a.position, b.position, a.uid, b.uid))
  result.rows.forEach(item => {
    if (item.uid === row.root_uid) return
    const parent = nodes.get(item.parent_uid)
    if (parent) parent.children.push(nodes.get(item.uid))
  })
  return { uid: row.root_uid, tree: nodes.get(row.root_uid), version, node_count: result.rows.length, unchanged: false }
}

async function createShare(req, body) {
  const roomKey = safeRoomKey(body.roomKey)
  const rootUid = String(body.rootUid || '').trim()
  if (!roomKey || !rootUid || rootUid.length > 160) fail(400, 'BAD_REQUEST', '缺少脑图或节点')
  const access = await roomAcl.assertRoomAccess(getPool(), req, roomKey, 'edit')
  if (access.shareId) fail(403, 'FORBIDDEN', '分享链接不能继续转发分享权限')
  const role = body.role === 'editor' ? 'editor' : 'viewer'
  const recipients = requestedRecipients(body, [])
  if (role === 'editor' && !recipients.length) fail(400, 'RECIPIENT_REQUIRED', '编辑分享必须指定接收账号')
  let expiresAt = null
  if (body.expiresAt) {
    expiresAt = new Date(body.expiresAt)
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) {
      fail(400, 'BAD_EXPIRY', '有效期必须晚于当前时间')
    }
  }
  const node = await getPool().query(
    'select 1 from room_nodes where room_key = $1 and uid = $2 and deleted_at is null limit 1',
    [roomKey, rootUid]
  )
  if (!node.rows.length) fail(404, 'NODE_REMOVED', '分享的节点已被删除')
  const id = crypto.randomUUID()
  const token = crypto.randomBytes(32).toString('base64url')
  const inserted = await getPool().query(
    `insert into node_shares (id, token_hash, room_key, root_uid, role, recipient_user_id, recipient_user_ids, created_by, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [id, digest(token), roomKey, rootUid, role, recipients[0] || null, recipients, actor(req), expiresAt]
  )
  return { ...publicShare(inserted.rows[0]), token }
}

async function listShares(req, roomKey, rootUid) {
  const access = await roomAcl.assertRoomAccess(getPool(), req, roomKey, 'edit')
  if (access.shareId) fail(403, 'FORBIDDEN', '分享链接不能继续转发分享权限')
  const userId = actor(req)
  const rows = await getPool().query(
    `select * from node_shares where room_key = $1 and root_uid = $2
     and ($3::boolean or created_by = $4) order by created_at desc`,
    [roomKey, rootUid, access.canManage, userId]
  )
  return rows.rows.map(publicShare)
}

async function manageShare(req, id, method, body) {
  const result = await getPool().query('select * from node_shares where id = $1', [id])
  const row = result.rows[0]
  if (!row) fail(404, 'NOT_FOUND', '分享不存在')
  await assertShareManager(req, row)
  if (method === 'DELETE') {
    await getPool().query('update node_shares set revoked_at = now() where id = $1', [id])
    return { revoked: true }
  }
  const role = body.role === 'editor' ? 'editor' : body.role === 'viewer' ? 'viewer' : row.role
  const recipients = requestedRecipients(body, shareRecipients(row))
  if (role === 'editor' && !recipients.length) fail(400, 'RECIPIENT_REQUIRED', '编辑分享必须指定接收账号')
  const expiresAt = body.expiresAt === undefined ? row.expires_at : body.expiresAt ? new Date(body.expiresAt) : null
  if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date())) fail(400, 'BAD_EXPIRY', '有效期必须晚于当前时间')
  const updated = await getPool().query(
    'update node_shares set role = $2, recipient_user_id = $3, recipient_user_ids = $4, expires_at = $5 where id = $1 returning *',
    [id, role, recipients[0] || null, recipients, expiresAt]
  )
  return publicShare(updated.rows[0])
}

async function rotateShare(req, id) {
  const current = await getPool().query('select * from node_shares where id = $1', [id])
  const row = current.rows[0]
  if (!row || row.revoked_at) fail(404, 'SHARE_UNAVAILABLE', '分享不存在或已撤销')
  await assertShareManager(req, row)
  const token = crypto.randomBytes(32).toString('base64url')
  const updated = await getPool().query('update node_shares set token_hash = $2 where id = $1 returning *', [id, digest(token)])
  return { ...publicShare(updated.rows[0]), token }
}

async function sharePresence(req, row, method, body) {
  const userId = actor(req)
  if (method === 'POST') {
    const clientId = String(body.clientId || '').trim().slice(0, 160)
    if (!clientId) fail(400, 'BAD_REQUEST', '缺少 clientId')
    let editingUid = row.role === 'editor' ? String(body.editingUid || '').trim() : ''
    if (editingUid) {
      const node = await getPool().query(
        `with recursive branch as (
           select uid from room_nodes where room_key = $1 and uid = $2 and deleted_at is null
           union all
           select n.uid from room_nodes n join branch b on n.parent_uid = b.uid
           where n.room_key = $1 and n.deleted_at is null
         ) select 1 from branch where uid = $3 limit 1`,
        [row.room_key, row.root_uid, editingUid]
      )
      if (!node.rows.length) editingUid = ''
    }
    await getPool().query(
      `insert into node_share_presence (share_id, client_id, user_id, name, editing_uid, expires_at)
       values ($1,$2,$3,$4,$5,now() + interval '12 seconds')
       on conflict (share_id, client_id) do update set
         user_id = excluded.user_id, name = excluded.name,
         editing_uid = excluded.editing_uid, expires_at = excluded.expires_at`,
      [row.id, clientId, userId, String(req.authUser.name || userId).slice(0, 100), editingUid || null]
    )
  } else if (method === 'DELETE') {
    const clientId = String(body.clientId || '').trim()
    await getPool().query('delete from node_share_presence where share_id = $1 and client_id = $2 and user_id = $3', [row.id, clientId, userId])
  }
  const peers = await getPool().query(
    `select client_id, user_id, name, editing_uid from node_share_presence
     where share_id = $1 and expires_at > now() order by name, client_id`,
    [row.id]
  )
  return peers.rows.map(item => ({ clientId: item.client_id, userId: item.user_id, name: item.name, editingUid: item.editing_uid || '' }))
}

async function downloadAttachment(row, id, res) {
  const linked = await getPool().query(
    `with recursive branch as (
       select uid from room_nodes where room_key = $1 and uid = $2 and deleted_at is null
       union all
       select n.uid from room_nodes n join branch b on n.parent_uid = b.uid
       where n.room_key = $1 and n.deleted_at is null
     ) select 1 from room_nodes n join branch b on n.uid = b.uid
     where n.room_key = $1 and n.data->>'attachmentId' = $3 limit 1`,
    [row.room_key, row.root_uid, id]
  )
  if (!linked.rows.length) fail(404, 'NOT_FOUND', '附件不在分享范围内')
  const content = await attachmentStore.getContentById(getPool(), row.room_key, id)
  if (!content) fail(404, 'NOT_FOUND', '附件不存在')
  const headers = attachmentResponseHeaders(content.attachment.fileName || 'attachment')
  headers['Content-Disposition'] = String(headers['Content-Disposition']).replace(/^inline/, 'attachment')
  res.writeHead(200, { ...headers, 'Content-Length': content.buffer.length, 'Cache-Control': 'no-store' })
  res.end(content.buffer)
}

async function assertOperationScope(client, row, op) {
  const fresh = await client.query(
    `select role, recipient_user_id, recipient_user_ids, created_by from node_shares where id = $1 and revoked_at is null
     and (expires_at is null or expires_at > now()) for share`,
    [row.id]
  )
  if (!fresh.rows.length) fail(403, 'SHARE_UNAVAILABLE', '分享已撤销或过期')
  const creatorCanEdit = row.creatorCanEdit && row.created_by === op.userId && fresh.rows[0].created_by === op.userId
  if (fresh.rows[0].role !== 'editor' || (!shareRecipients(fresh.rows[0]).includes(op.userId) && !creatorCanEdit)) {
    fail(403, 'FORBIDDEN', '编辑权限已变化')
  }
  const allowed = new Set()
  const result = await client.query(
    `with recursive branch as (
       select uid from room_nodes where room_key = $1 and uid = $2 and deleted_at is null
       union all
       select n.uid from room_nodes n join branch b on n.parent_uid = b.uid
       where n.room_key = $1 and n.deleted_at is null
     ) select uid from branch`,
    [row.room_key, row.root_uid]
  )
  result.rows.forEach(item => allowed.add(item.uid))
  if (!allowed.has(row.root_uid)) fail(410, 'NODE_REMOVED', '分享的节点已被删除')
  const payload = op.payload || {}
  const uid = String(payload.uid || op.targetId || '')
  const parent = String(payload.parentUid || payload.parent_uid || payload.parent || '')
  if (!['node.insert', 'node.update', 'node.move', 'node.reorder', 'node.delete'].includes(op.type)) {
    fail(403, 'OUT_OF_SCOPE', '此操作不能用于分支分享')
  }
  if (op.type === 'node.insert') {
    if (!allowed.has(parent)) fail(403, 'OUT_OF_SCOPE', '不能在分享范围之外添加节点')
    if (uid && allowed.has(uid)) fail(409, 'UID_EXISTS', '节点已存在')
  } else {
    if (!allowed.has(uid)) fail(403, 'OUT_OF_SCOPE', '不能修改分享范围之外的节点')
    if (uid === row.root_uid && ['node.move', 'node.reorder', 'node.delete'].includes(op.type)) {
      fail(403, 'OUT_OF_SCOPE', '不能移动或删除分享根节点')
    }
    if (parent && !allowed.has(parent)) fail(403, 'OUT_OF_SCOPE', '不能把节点移出分享范围')
    if (op.type === 'node.move' && !parent) {
      fail(403, 'OUT_OF_SCOPE', '移动节点必须指定分支内的父节点')
    }
    if (op.type === 'node.update' && (payload.parentUid !== undefined || payload.parent_uid !== undefined || payload.parent !== undefined || payload.index !== undefined || payload.position !== undefined)) {
      if (uid === row.root_uid || !parent || !allowed.has(parent)) fail(403, 'OUT_OF_SCOPE', '不能把节点移出分享范围')
    }
  }
}

async function submitShareOperation(req, row, raw) {
  const op = normalizeOperation({ ...raw, roomKey: row.room_key })
  if (!isOpId(op.opId)) fail(400, 'BAD_OP_ID', '操作 ID 必须是 UUID')
  op.userId = actor(req)
  const command = toCommand(op)
  const committed = await commitDirectRoomOperation(row.room_key, command, async ({ client, currentVersion, room }) => {
    await assertOperationScope(client, row, op)
    const store = createPgStore(client, row.room_key)
    if (store.setMeta) store.setMeta((room && room.metadata) || {})
    const applied = await applyDirect(store, op, { version: currentVersion + 1 })
    await client.query(
      `insert into node_share_audit (share_id, user_id, operation_type, target_uid, room_version)
       values ($1,$2,$3,$4,$5)`,
      [row.id, op.userId, op.type, String(op.payload && op.payload.uid || op.targetId || '') || null, currentVersion + 1]
    )
    return applied
  })
  return { duplicate: !!committed.duplicate, operation: fromCommitted(committed.operation, { roomKey: row.room_key }) }
}

async function handleNodeShareApi(req, res, pathname) {
  if (!pathname.startsWith('/api/node-shares')) return false
  try {
    await ensureSchema()
    actor(req)
    const url = new URL(req.url, 'http://localhost')
    const parts = pathname.split('/').filter(Boolean)
    let data
    if (parts.length === 2 && req.method === 'POST') data = await createShare(req, await readBody(req))
    else if (parts.length === 2 && req.method === 'GET') {
      const roomKey = safeRoomKey(url.searchParams.get('roomKey'))
      const rootUid = String(url.searchParams.get('rootUid') || '')
      data = await listShares(req, roomKey, rootUid)
    } else if (parts.length >= 3) {
      const id = parts[2]
      if (!/^[0-9a-f-]{36}$/i.test(id)) fail(400, 'BAD_REQUEST', '无效分享 ID')
      if (parts.length === 4 && parts[3] === 'redeem' && req.method === 'POST') {
        const body = await readBody(req)
        const row = await loadShare(req, id, body.token)
        setRoomShareCookie(req, res, row, body.token)
        data = { roomKey: row.room_key, rootUid: row.root_uid, role: row.role }
      } else if (parts.length === 3 && (req.method === 'DELETE' || req.method === 'PATCH')) {
        data = await manageShare(req, id, req.method, req.method === 'PATCH' ? await readBody(req) : {})
      } else if (parts.length === 4 && parts[3] === 'rotate' && req.method === 'POST') {
        data = await rotateShare(req, id)
      } else if (parts.length === 3 && req.method === 'GET') {
        const row = await loadShare(req, id, url.searchParams.get('token'))
        data = publicShare(row)
      } else if (parts.length === 4 && parts[3] === 'tree' && req.method === 'GET') {
        const row = await loadShare(req, id, url.searchParams.get('token'))
        data = { share: publicShare(row), subtree: await subtree(row, url.searchParams.get('knownVersion')) }
      } else if (parts.length === 4 && parts[3] === 'history' && req.method === 'GET') {
        const row = await loadShare(req, id, url.searchParams.get('token'))
        const log = await getPool().query(
          `select user_id, operation_type, target_uid, room_version, created_at
           from node_share_audit where share_id = $1 order by id desc limit 50`, [row.id]
        )
        data = log.rows.map(item => ({ userId: item.user_id, type: item.operation_type, targetUid: item.target_uid, version: Number(item.room_version), createdAt: item.created_at }))
      } else if (parts.length === 4 && parts[3] === 'operations' && req.method === 'POST') {
        const body = await readBody(req)
        const row = await loadShare(req, id, body.token, 'edit')
        data = await submitShareOperation(req, row, body.operation || {})
      } else if (parts.length === 4 && parts[3] === 'presence' && ['GET', 'POST', 'DELETE'].includes(req.method)) {
        const body = req.method === 'GET' ? {} : await readBody(req)
        const row = await loadShare(req, id, req.method === 'GET' ? url.searchParams.get('token') : body.token)
        data = await sharePresence(req, row, req.method, body)
      } else if (parts.length === 5 && parts[3] === 'attachments' && parts[4] && req.method === 'GET') {
        const row = await loadShare(req, id, url.searchParams.get('token'))
        await downloadAttachment(row, decodeURIComponent(parts[4]), res)
        return true
      } else return false
    } else return false
    sendJson(res, 200, { ok: true, data })
  } catch (err) {
    sendJson(res, err.statusCode || 500, { ok: false, code: err.code || 'SHARE_ERROR', error: err.message })
  }
  return true
}

module.exports = { handleNodeShareApi, assertOperationScope, shareRecipients, requestedRecipients, canManageShare }
