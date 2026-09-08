const { randomUUID } = require('crypto')
const roomAcl = require('./roomAcl')

function error(statusCode, code, message) {
  const err = new Error(message)
  err.statusCode = statusCode
  err.code = code
  return err
}

async function initSchema(db) {
  await db.query(`
    create table if not exists room_access_requests (
      id uuid primary key,
      room_key text not null references rooms(room_key) on delete cascade,
      requester_id text not null,
      requested_role text not null default 'viewer',
      status text not null default 'pending',
      decided_by text,
      decided_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint room_access_requests_role_chk check (requested_role in ('viewer', 'editor')),
      constraint room_access_requests_status_chk check (status in ('pending', 'approved', 'rejected'))
    )
  `)
  await db.query(`create unique index if not exists room_access_requests_pending_uniq
    on room_access_requests(room_key, requester_id) where status = 'pending'`)
  await db.query(`create index if not exists room_access_requests_room_status_idx
    on room_access_requests(room_key, status, created_at desc)`)
}

function actor(req) {
  const value = roomAcl.actorFromReq(req)
  if (!value.id) throw error(401, 'unauthorized', '请先使用企业微信扫码登录')
  return value
}

async function requestAccess(db, req, body) {
  const who = actor(req)
  const roomKey = String(body.roomKey || body.room_key || '').trim()
  const requestedRole = String(body.role || body.requestedRole || 'viewer').toLowerCase()
  if (!roomKey) throw error(400, 'BAD_REQUEST', '缺少房间号')
  if (!['viewer', 'editor'].includes(requestedRole)) {
    throw error(400, 'BAD_REQUEST', '申请权限必须是只读或可编辑')
  }
  const access = await roomAcl.getAccess(db, roomKey, who.id)
  if (!access.exists || access.deleted) throw error(404, 'NOT_FOUND', '房间不存在')
  if (access.role || access.legacyOpen) {
    return { status: 'already_allowed', roomKey, role: access.role || 'editor' }
  }
  const id = randomUUID()
  const result = await db.query(
    `insert into room_access_requests (id, room_key, requester_id, requested_role)
     values ($1, $2, $3, $4)
     on conflict (room_key, requester_id) where status = 'pending'
     do update set requested_role = excluded.requested_role, updated_at = now()
     returning *`,
    [id, roomKey, who.id, requestedRole]
  )
  return result.rows[0]
}

async function mine(db, req, roomKey) {
  const who = actor(req)
  const result = await db.query(
    `select id, room_key, requested_role, status, created_at, updated_at, decided_at
     from room_access_requests
     where room_key = $1 and requester_id = $2
     order by created_at desc limit 1`,
    [roomKey, who.id]
  )
  return result.rows[0] || null
}

async function listInbox(db, req) {
  const who = actor(req)
  const result = await db.query(
    `select ar.id, ar.room_key, ar.requester_id, ar.requested_role, ar.status,
            ar.created_at, ar.updated_at, r.title,
            coalesce(u.name, ar.requester_id) as requester_name,
            coalesce(u.avatar, '') as requester_avatar
     from room_access_requests ar
     join rooms r on r.room_key = ar.room_key
     join room_members owner on owner.room_key = ar.room_key
       and owner.user_id = $1 and owner.role = 'owner'
     left join wecom_users u on u.user_id = ar.requester_id
     where ar.status = 'pending'
     order by ar.created_at desc limit 100`,
    [who.id]
  )
  return result.rows
}

async function decide(db, req, id, decision) {
  const who = actor(req)
  if (!['approve', 'reject'].includes(decision)) {
    throw error(400, 'BAD_REQUEST', '无效的审批操作')
  }
  const found = await db.query(
    `select ar.* from room_access_requests ar
     join room_members owner on owner.room_key = ar.room_key
       and owner.user_id = $2 and owner.role = 'owner'
     where ar.id = $1 and ar.status = 'pending' for update`,
    [id, who.id]
  )
  const row = found.rows[0]
  if (!row) throw error(404, 'NOT_FOUND', '申请不存在或已处理')
  if (decision === 'approve') {
    await roomAcl.setMember(db, row.room_key, row.requester_id, row.requested_role, who.id,
      req.authUser && req.authUser.corpId)
  }
  const status = decision === 'approve' ? 'approved' : 'rejected'
  const result = await db.query(
    `update room_access_requests set status = $2, decided_by = $3,
       decided_at = now(), updated_at = now() where id = $1 returning *`,
    [id, status, who.id]
  )
  return result.rows[0]
}

module.exports = { initSchema, requestAccess, mine, listInbox, decide, error }
