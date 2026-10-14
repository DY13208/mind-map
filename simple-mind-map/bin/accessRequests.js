const { randomUUID } = require('crypto')
const roomAcl = require('./roomAcl')
const events = require('./accessRequestEvents')
const GRANT_ROLES = ['viewer', 'editor', 'manager']
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
function error(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code })
}
async function transaction(pool, work) {
  const db = await pool.connect()
  try {
    await db.query('begin')
    const result = await work(db)
    await db.query('commit')
    return result
  } catch (err) {
    await db.query('rollback')
    throw err
  } finally {
    db.release()
  }
}
async function initSchema(db) {
  await db.query(`create table if not exists room_access_requests (
    id uuid primary key, room_key text not null references rooms(room_key) on delete cascade,
    requester_id text not null, requested_role text not null default 'viewer', status text not null default 'pending',
    decided_by text, decided_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    constraint room_access_requests_role_chk check (requested_role in ('viewer','editor')),
    constraint room_access_requests_status_chk check (status in ('pending','approved','rejected')))`)
  await db.query(`alter table room_access_requests add column if not exists granted_role text,
    add column if not exists request_reason text not null default '',
    add column if not exists decision_reason text not null default '',
    add column if not exists requester_seen_at timestamptz`)
  await db.query(`do $$ begin
    if not exists(select 1 from pg_constraint where conrelid='room_access_requests'::regclass and conname='room_access_requests_granted_role_chk') then
      alter table room_access_requests add constraint room_access_requests_granted_role_chk check(granted_role is null or granted_role in ('viewer','editor','manager'));
    end if; end $$`)
  await db.query(
    `update room_access_requests set granted_role=requested_role where status='approved' and granted_role is null`
  )
  await db.query(
    `create unique index if not exists room_access_requests_pending_uniq on room_access_requests(room_key,requester_id) where status='pending'`
  )
  await db.query(
    `create index if not exists room_access_requests_room_status_idx on room_access_requests(room_key,status,created_at desc)`
  )
  await db.query(
    `create index if not exists room_access_requests_requester_result_idx on room_access_requests(requester_id,decided_at desc) where status <> 'pending'`
  )
}
function actor(req) {
  const who = roomAcl.actorFromReq(req)
  if (!who.id) throw error(401, 'unauthorized', '请先登录后再操作')
  return who
}
const text = value =>
  String(value || '')
    .trim()
    .slice(0, 500)
const ownerCondition = user =>
  `(r.owner_id = ${user} or exists(select 1 from room_members owner where owner.room_key=r.room_key and owner.user_id=${user} and owner.role='owner'))`
const activeRoom = `r.deleted_at is null and not exists(select 1 from room_tombstones tomb where tomb.room_key=r.room_key)`
async function recipients(db, roomKey) {
  const { rows } = await db.query(
    `select user_id from room_members where room_key=$1 and role='owner'
    union select owner_id as user_id from rooms where room_key=$1`,
    [roomKey]
  )
  return rows.map(row => row.user_id)
}
async function requestAccess(pool, req, body) {
  const who = actor(req),
    roomKey = String(body.roomKey || body.room_key || '').trim()
  const role = String(body.role || body.requestedRole || 'viewer').toLowerCase()
  if (!roomKey) throw error(400, 'BAD_REQUEST', '缺少房间号')
  if (!['viewer', 'editor'].includes(role))
    throw error(400, 'BAD_REQUEST', '申请权限必须是可查看或可编辑')
  return transaction(pool, async db => {
    const room = await db.query(
      `select room_key,title from rooms r where room_key=$1 and ${activeRoom} for share`,
      [roomKey]
    )
    if (!room.rows.length)
      throw error(404, 'NOT_FOUND', '文件不存在或已移入回收站')
    const access = await roomAcl.getAccess(db, roomKey, who.id)
    if (access.role || access.legacyOpen)
      return {
        status: 'already_allowed',
        roomKey,
        role: access.role || 'editor'
      }
    const result = await db.query(
      `insert into room_access_requests(id,room_key,requester_id,requested_role,request_reason)
      values($1,$2,$3,$4,$5) on conflict(room_key,requester_id) where status='pending' do update
      set requested_role=excluded.requested_role, request_reason=excluded.request_reason, updated_at=now()
      where room_access_requests.requested_role is distinct from excluded.requested_role or room_access_requests.request_reason is distinct from excluded.request_reason
      returning *`,
      [randomUUID(), roomKey, who.id, role, text(body.reason)]
    )
    if (result.rows.length) {
      await events.publish(db, await recipients(db, roomKey))
      return { ...result.rows[0], title: room.rows[0].title }
    }
    const existing = (
      await db.query(
        `select * from room_access_requests where room_key=$1 and requester_id=$2 and status='pending'`,
        [roomKey, who.id]
      )
    ).rows[0]
    return { ...existing, title: room.rows[0].title }
  })
}
async function mine(db, req, roomKey) {
  const who = actor(req)
  const result = await db.query(
    `select ar.*,r.title,r.deleted_at from room_access_requests ar join rooms r using(room_key)
    where ar.room_key=$1 and ar.requester_id=$2 order by ar.created_at desc,ar.id desc limit 1`,
    [roomKey, who.id]
  )
  const access = await roomAcl.getAccess(db, roomKey, who.id)
  const active =
    access.exists &&
    !access.deleted &&
    !(result.rows[0] && result.rows[0].deleted_at)
  return {
    ...(result.rows[0] || {}),
    access: {
      ...roomAcl.accessSummary(access.role, {
        legacyOpen: active && access.legacyOpen
      }),
      canView:
        active &&
        roomAcl.roleAllows(access.role, 'view', {
          legacyOpen: access.legacyOpen
        })
    },
    exists: active
  }
}
async function listInbox(db, req, filters = {}) {
  const who = actor(req),
    limit = Math.min(50, Math.max(1, Math.floor(Number(filters.limit)) || 20)),
    offset = Math.min(
      10000,
      Math.max(0, Math.floor(Number(filters.offset)) || 0)
    )
  const result = await db.query(
    `select ar.*,r.title,coalesce(u.name,ar.requester_id) requester_name,coalesce(u.avatar,'') requester_avatar,
    count(*) over()::int as total_count from room_access_requests ar join rooms r using(room_key)
    left join wecom_users u on u.user_id=ar.requester_id
    where ar.status='pending' and ${activeRoom} and ${ownerCondition('$1')}
    order by ar.created_at desc,ar.id desc limit $2 offset $3`,
    [who.id, limit, offset]
  )
  // Keep count accurate on an empty/out-of-range page without returning all rows.
  const total = result.rows.length
    ? result.rows[0].total_count
    : Number(
        (
          await db.query(
            `select count(*)::int total from room_access_requests ar join rooms r using(room_key) where ar.status='pending' and ${activeRoom} and ${ownerCondition(
              '$1'
            )}`,
            [who.id]
          )
        ).rows[0].total
      )
  return {
    list: result.rows.map(({ total_count, ...row }) => row),
    total,
    limit,
    offset
  }
}
async function listResults(db, req, filters = {}) {
  const who = actor(req),
    limit = Math.min(50, Math.max(1, Math.floor(Number(filters.limit)) || 20)),
    offset = Math.min(
      10000,
      Math.max(0, Math.floor(Number(filters.offset)) || 0)
    )
  const [items, count] = await Promise.all([
    db.query(
      `select ar.*,r.title from room_access_requests ar join rooms r using(room_key) where requester_id=$1 and status <> 'pending' order by decided_at desc,ar.id desc limit $2 offset $3`,
      [who.id, limit, offset]
    ),
    db.query(
      `select count(*)::int total,count(*) filter(where requester_seen_at is null)::int unread from room_access_requests where requester_id=$1 and status <> 'pending'`,
      [who.id]
    )
  ])
  return {
    list: items.rows,
    total: count.rows[0].total,
    unread: count.rows[0].unread,
    limit,
    offset
  }
}
async function markSeen(db, req, ids) {
  const who = actor(req)
  const safeIds = (Array.isArray(ids) ? ids : [])
    .filter(id => UUID.test(String(id)))
    .slice(0, 50)
  const result = await db.query(
    `update room_access_requests set requester_seen_at=now() where requester_id=$1 and id=any($2::uuid[]) and status <> 'pending' and requester_seen_at is null returning id`,
    [who.id, safeIds]
  )
  if (result.rows.length) await events.publish(db, [who.id])
  return { ok: true }
}
async function decide(pool, req, id, decision, options = {}) {
  const who = actor(req)
  if (!UUID.test(String(id))) throw error(400, 'BAD_REQUEST', '无效的申请编号')
  if (!['approve', 'reject'].includes(decision))
    throw error(400, 'BAD_REQUEST', '无效的审批操作')
  const requestedGrant = options.role && String(options.role).toLowerCase()
  if (requestedGrant && !GRANT_ROLES.includes(requestedGrant))
    throw error(400, 'BAD_REQUEST', '只能授予可查看、可编辑或可管理权限')
  return transaction(pool, async db => {
    // Lock the room too: ownership transfer and deletion cannot race approval.
    const found = await db.query(
      `select ar.* from room_access_requests ar join rooms r using(room_key)
      where ar.id=$1 and ${activeRoom} and ${ownerCondition(
        '$2'
      )} for update of ar,r`,
      [id, who.id]
    )
    const row = found.rows[0]
    if (!row)
      throw error(404, 'NOT_FOUND', '申请不存在、文件不可用或你已不是所有者')
    if (row.status !== 'pending') {
      if (
        row.decided_by === who.id &&
        row.status === (decision === 'approve' ? 'approved' : 'rejected') &&
        (!requestedGrant || row.granted_role === requestedGrant)
      )
        return { ...row, already_processed: true }
      throw error(409, 'ALREADY_DECIDED', '申请已被处理，请刷新消息中心')
    }
    const role =
      decision === 'approve' ? requestedGrant || row.requested_role : null
    if (role)
      await roomAcl.setMember(
        db,
        row.room_key,
        row.requester_id,
        role,
        who.id,
        req.authUser && req.authUser.corpId
      )
    const result = await db.query(
      `update room_access_requests set status=$2,decided_by=$3,decided_at=now(),updated_at=now(),granted_role=$4,decision_reason=$5,requester_seen_at=null where id=$1 returning *`,
      [
        id,
        decision === 'approve' ? 'approved' : 'rejected',
        who.id,
        role,
        text(options.reason)
      ]
    )
    await events.publish(db, [
      ...(await recipients(db, row.room_key)),
      row.requester_id
    ])
    return result.rows[0]
  })
}
module.exports = {
  initSchema,
  requestAccess,
  mine,
  listInbox,
  listResults,
  markSeen,
  decide,
  actor,
  error
}
