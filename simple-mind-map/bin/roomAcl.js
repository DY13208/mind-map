const { isAuthEnabled } = require('./auth')

const ROLES = ['owner', 'editor', 'viewer']
const ROLE_RANK = { owner: 3, editor: 2, viewer: 1 }
const ACTION_RANK = { view: 1, edit: 2, manage: 3 }

function aclError(status, code, message) {
  const err = new Error(message)
  err.statusCode = status
  err.code = code
  return err
}

function normalizeUserId(value) {
  return String(value || '')
    .trim()
    .replace(/^wecom:/i, '')
    .slice(0, 160)
}

function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase()
  return ROLES.includes(role) ? role : ''
}

function actorFromReq(req) {
  const user = req && req.authUser
  if (req && req.forceAcl) {
    return { id: normalizeUserId(user && user.id), bypass: false, service: false }
  }
  if (!isAuthEnabled()) {
    return { id: normalizeUserId(user && user.id), bypass: true, service: false }
  }
  if (!user) {
    return { id: '', bypass: false, service: false }
  }
  if (user.service) {
    return { id: normalizeUserId(user.id || 'mcp-service'), bypass: true, service: true }
  }
  return { id: normalizeUserId(user.id), bypass: false, service: false }
}

function presenceDocRoomKey(docName) {
  const name = String(docName || '')
  return name.endsWith('__presence') ? name.slice(0, -'__presence'.length) : name
}

const FILE_COLLECTION_KEYS = new Set(['recent', 'favorites', 'trash'])

function inferRoomAcl(pathname, method) {
  const path = String(pathname || '')
  const match = path.match(/^\/api\/(?:files|maps|rooms)\/([^/]+)(.*)$/)
  if (!match) return null
  const roomKey = decodeURIComponent(match[1])
  const rest = match[2] || ''
  const verb = String(method || 'GET').toUpperCase()
  if (FILE_COLLECTION_KEYS.has(roomKey) && !rest) return null
  if (rest === '/members' || rest.startsWith('/members/')) {
    return { roomKey, action: verb === 'GET' ? 'view' : 'manage' }
  }
  if (rest === '/presence' || rest.startsWith('/presence/')) {
    return { roomKey, action: 'view' }
  }
  if (rest === '/versions' || rest.startsWith('/versions/')) {
    if (verb === 'GET' || verb === 'HEAD') return { roomKey, action: 'view' }
    if (/\/restore$/.test(rest) || /\/hide$/.test(rest)) {
      return { roomKey, action: 'manage' }
    }
    return { roomKey, action: 'edit' }
  }
  if (rest === '/move' || rest.startsWith('/move')) {
    return { roomKey, action: 'edit' }
  }
  if (rest === '/info' || rest.startsWith('/info')) {
    return { roomKey, action: 'view' }
  }
  if (rest === '/favorite' || rest.startsWith('/favorite')) {
    return { roomKey, action: 'view' }
  }
  if (rest === '/open' || rest.startsWith('/open')) {
    return { roomKey, action: 'view' }
  }
  if (rest === '/trash' || rest.startsWith('/trash')) {
    return { roomKey, action: 'manage' }
  }
  if (rest === '/restore' || rest.startsWith('/restore')) {
    return { roomKey, action: 'manage' }
  }
  if (rest === '/permanent' || rest.startsWith('/permanent')) {
    return { roomKey, action: 'manage' }
  }
  if (!rest) {
    if (verb === 'DELETE') {
      return { roomKey, action: 'manage' }
    }
    if (verb === 'PATCH') {
      return { roomKey, action: 'edit' }
    }
    if (verb === 'GET' || verb === 'HEAD') {
      return { roomKey, action: 'view' }
    }
    return { roomKey, action: 'edit' }
  }
  if (verb === 'GET' || verb === 'HEAD') return { roomKey, action: 'view' }
  return { roomKey, action: 'edit' }
}

function roleAllows(role, action, options = {}) {
  if (options.bypass) return true
  const need = ACTION_RANK[action] || ACTION_RANK.view
  if (options.legacyOpen) {
    return need <= ACTION_RANK.manage
  }
  const have = ROLE_RANK[role] || 0
  return have >= need
}

function accessSummary(role, options = {}) {
  const legacyOpen = !!options.legacyOpen
  const bypass = !!options.bypass
  const resolved =
    role || (bypass ? 'owner' : legacyOpen ? 'editor' : '')
  return {
    role: resolved || null,
    legacyOpen,
    canView: roleAllows(resolved, 'view', { bypass, legacyOpen }),
    canEdit: roleAllows(resolved, 'edit', { bypass, legacyOpen }),
    canManage: roleAllows(resolved, 'manage', { bypass, legacyOpen })
  }
}

async function initSchema(db) {
  await db.query(`
    create table if not exists room_members (
      room_key text not null references rooms(room_key) on delete cascade,
      user_id text not null,
      role text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (room_key, user_id),
      constraint room_members_role_chk
        check (role in ('owner', 'editor', 'viewer'))
    )
  `)
  await db.query(`
    create index if not exists room_members_user_id_idx
    on room_members(user_id)
  `)
}

function normalizeActorId(value) {
  const id = normalizeUserId(value)
  if (!id || id === 'anonymous' || id === 'mcp-service') return ''
  return id
}

async function migrateLegacyOwners(db) {
  await db.query(`
    insert into room_members (room_key, user_id, role)
    select first.room_key, first.user_id, 'owner'
    from (
      select distinct on (o.room_key)
        o.room_key,
        regexp_replace(o.actor_id, '^wecom:', '', 'i') as user_id
      from room_operations o
      left join room_tombstones t on t.room_key = o.room_key
      where t.room_key is null
        and o.actor_id is not null
        and o.actor_id <> ''
        and o.actor_id <> 'anonymous'
        and o.actor_id <> 'mcp-service'
      order by o.room_key, o.created_at asc, o.version asc
    ) first
    left join room_members m
      on m.room_key = first.room_key
    where m.user_id is null
      and first.user_id <> ''
    on conflict (room_key, user_id) do nothing
  `)
  // Other historical writers keep edit access so old maps do not lock to one person.
  await db.query(`
    insert into room_members (room_key, user_id, role)
    select distinct
      o.room_key,
      regexp_replace(o.actor_id, '^wecom:', '', 'i') as user_id,
      'editor'
    from room_operations o
    left join room_tombstones t on t.room_key = o.room_key
    where t.room_key is null
      and o.actor_id is not null
      and o.actor_id <> ''
      and o.actor_id <> 'anonymous'
      and o.actor_id <> 'mcp-service'
      and regexp_replace(o.actor_id, '^wecom:', '', 'i') <> ''
      and not exists (
        select 1 from room_members m
        where m.room_key = o.room_key
          and m.user_id = regexp_replace(o.actor_id, '^wecom:', '', 'i')
      )
    on conflict (room_key, user_id) do nothing
  `)
}

async function getAccess(db, roomKey, userId) {
  const key = String(roomKey || '')
  if (!key) {
    return { exists: false, deleted: false, role: null, legacyOpen: false, members: 0 }
  }
  const tomb = await db.query(
    `select 1 from room_tombstones where room_key = $1`,
    [key]
  )
  if (tomb.rows.length) {
    return { exists: false, deleted: true, role: null, legacyOpen: false, members: 0 }
  }
  const room = await db.query(
    `select room_key from rooms where room_key = $1`,
    [key]
  )
  if (!room.rows.length) {
    return { exists: false, deleted: false, role: null, legacyOpen: false, members: 0 }
  }
  const members = await db.query(
    `select user_id, role from room_members where room_key = $1`,
    [key]
  )
  const uid = normalizeUserId(userId)
  const mine = members.rows.find(row => row.user_id === uid)
  return {
    exists: true,
    deleted: false,
    role: mine ? mine.role : null,
    legacyOpen: members.rows.length === 0,
    members: members.rows.length
  }
}

async function assertRoomAccess(db, req, roomKey, action) {
  const actor = actorFromReq(req)
  if (actor.bypass) {
    const access = await getAccess(db, roomKey, actor.id)
    if (access.deleted) {
      throw aclError(404, 'NOT_FOUND', 'not found')
    }
    // Dev / MCP: keep WS-first create working for rooms not yet persisted.
    if (!access.exists) {
      return {
        ...accessSummary('owner', { bypass: true, legacyOpen: true }),
        exists: false,
        deleted: false,
        members: 0,
        userId: actor.id
      }
    }
    return {
      ...accessSummary(access.role, { bypass: true, legacyOpen: access.legacyOpen }),
      ...access,
      userId: actor.id
    }
  }
  if (!actor.id) {
    throw aclError(401, 'unauthorized', '请先使用企业微信扫码登录')
  }
  const access = await getAccess(db, roomKey, actor.id)
  if (access.deleted || !access.exists) {
    throw aclError(404, 'NOT_FOUND', 'not found')
  }
  const summary = accessSummary(access.role, { legacyOpen: access.legacyOpen })
  if (!roleAllows(access.role, action, { legacyOpen: access.legacyOpen })) {
    throw aclError(403, 'FORBIDDEN', '没有权限执行该操作')
  }
  return { ...summary, ...access, userId: actor.id }
}

async function ensureOwner(db, roomKey, userId) {
  const uid = normalizeUserId(userId)
  const key = String(roomKey || '')
  if (!key || !uid) return null
  const res = await db.query(
    `insert into room_members (room_key, user_id, role)
     values ($1, $2, $3)
     on conflict (room_key, user_id) do update set
       role = room_members.role,
       updated_at = now()
     returning room_key, user_id, role`,
    [key, uid, 'owner']
  )
  const existing = await db.query(
    `select 1 from room_members where room_key = $1 and role = 'owner' limit 1`,
    [key]
  )
  if (!existing.rows.length) {
    await db.query(
      `insert into room_members (room_key, user_id, role)
       values ($1, $2, $3)
       on conflict (room_key, user_id) do update set
         role = 'owner',
         updated_at = now()`,
      [key, uid, 'owner']
    )
  }
  return res.rows[0] || { room_key: key, user_id: uid, role: 'owner' }
}

async function listAccessibleRooms(db, options = {}) {
  const safeLimit = Math.min(100, Math.max(1, Number(options.limit) || 20))
  const safeOffset = Math.max(0, Number(options.offset) || 0)
  const query = String(options.q || '').trim()
  const userId = normalizeUserId(options.userId)
  const params = []
  let where = 't.room_key is null'
  if (query) {
    params.push('%' + query.replace(/[%_\\]/g, ch => '\\' + ch) + '%')
    where += ` and r.title ilike $${params.length} escape '\\'`
  }
  let userParam = 0
  if (userId) {
    params.push(userId)
    userParam = params.length
    where += ` and (
      exists (
        select 1 from room_members m
        where m.room_key = r.room_key and m.user_id = $${userParam}
      )
      or not exists (
        select 1 from room_members m
        where m.room_key = r.room_key
      )
    )`
  }
  const countRes = await db.query(
    `select count(*)::int as total
     from rooms r
     left join room_tombstones t on t.room_key = r.room_key
     where ${where}`,
    params
  )
  const listParams = params.slice()
  listParams.push(safeLimit, safeOffset)
  const roleJoin = userParam
    ? `left join room_members my on my.room_key = r.room_key and my.user_id = $${userParam}`
    : ''
  const roleSelect = userParam
    ? `, my.role as role,
       (not exists (
         select 1 from room_members mx where mx.room_key = r.room_key
       )) as legacy_open`
    : `, null::text as role, false as legacy_open`
  const listSql = `select r.room_key, r.title, r.cos_key, r.version, r.created_at, r.updated_at
         ${roleSelect}
       from rooms r
       left join room_tombstones t on t.room_key = r.room_key
       ${roleJoin}
       where ${where}
       order by r.updated_at desc
       limit $${listParams.length - 1} offset $${listParams.length}`
  const listRes = await db.query(listSql, listParams)
  return {
    list: listRes.rows,
    total: Number((countRes.rows[0] && countRes.rows[0].total) || 0),
    limit: safeLimit,
    offset: safeOffset
  }
}

async function listMembers(db, roomKey) {
  try {
    const res = await db.query(
      `select
         m.user_id,
         m.role,
         m.created_at,
         m.updated_at,
         coalesce(u.name, m.user_id) as name,
         coalesce(u.avatar, '') as avatar
       from room_members m
       left join wecom_users u on u.user_id = m.user_id
       where m.room_key = $1
       order by
         case m.role when 'owner' then 0 when 'editor' then 1 else 2 end,
         m.created_at asc`,
      [roomKey]
    )
    return res.rows
  } catch (err) {
    if (err.code !== '42P01') throw err
    const res = await db.query(
      `select user_id, role, created_at, updated_at, user_id as name, '' as avatar
       from room_members
       where room_key = $1
       order by
         case role when 'owner' then 0 when 'editor' then 1 else 2 end,
         created_at asc`,
      [roomKey]
    )
    return res.rows
  }
}

async function searchUsers(db, q, limit = 20) {
  const query = String(q || '').trim()
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 20))
  if (!query) return []
  try {
    const res = await db.query(
      `select user_id, name, avatar
       from wecom_users
       where name ilike $1 or user_id ilike $1
       order by last_login_at desc
       limit $2`,
      ['%' + query.replace(/[%_\\]/g, ch => '\\' + ch) + '%', safeLimit]
    )
    return res.rows
  } catch (err) {
    if (err.code === '42P01') return []
    throw err
  }
}

async function setMember(db, roomKey, targetUserId, role, actorUserId) {
  const uid = normalizeUserId(targetUserId)
  const nextRole = normalizeRole(role)
  if (!uid) throw aclError(400, 'BAD_REQUEST', '缺少用户')
  if (!nextRole) throw aclError(400, 'BAD_REQUEST', '无效的权限角色')
  let memberRows = (
    await db.query(`select user_id, role from room_members where room_key = $1`, [
      roomKey
    ])
  ).rows
  if (!memberRows.length) {
    const actor = normalizeUserId(actorUserId) || uid
    await ensureOwner(db, roomKey, actor)
    memberRows = (
      await db.query(
        `select user_id, role from room_members where room_key = $1`,
        [roomKey]
      )
    ).rows
  }
  const owners = memberRows.filter(row => row.role === 'owner')
  const current = memberRows.find(row => row.user_id === uid)
  if (
    current &&
    current.role === 'owner' &&
    nextRole !== 'owner' &&
    owners.length <= 1
  ) {
    throw aclError(400, 'LAST_OWNER', '不能取消最后一个所有者')
  }
  const res = await db.query(
    `insert into room_members (room_key, user_id, role)
     values ($1, $2, $3)
     on conflict (room_key, user_id) do update set
       role = excluded.role,
       updated_at = now()
     returning room_key, user_id, role, created_at, updated_at`,
    [roomKey, uid, nextRole]
  )
  return res.rows[0]
}

async function removeMember(db, roomKey, targetUserId) {
  const uid = normalizeUserId(targetUserId)
  if (!uid) throw aclError(400, 'BAD_REQUEST', '缺少用户')
  const current = await db.query(
    `select user_id, role from room_members
     where room_key = $1 and user_id = $2`,
    [roomKey, uid]
  )
  if (!current.rows.length) {
    throw aclError(404, 'NOT_FOUND', '成员不存在')
  }
  if (current.rows[0].role === 'owner') {
    const owners = await db.query(
      `select count(*)::int as total from room_members
       where room_key = $1 and role = 'owner'`,
      [roomKey]
    )
    if (Number(owners.rows[0].total) <= 1) {
      throw aclError(400, 'LAST_OWNER', '不能删除最后一个所有者')
    }
  }
  await db.query(
    `delete from room_members where room_key = $1 and user_id = $2`,
    [roomKey, uid]
  )
  return { ok: true, user_id: uid }
}

function readonlyCommandAllowed(name, data) {
  const allowed = {
    SET_NODE_ACTIVE: true,
    CLEAR_ACTIVE_NODE: true,
    SET_NODE_EXPAND: true,
    EXPAND_ALL: true,
    UNEXPAND_ALL: true,
    UNEXPAND_TO_LEVEL: true,
    GO_TARGET_NODE: true,
    SELECT_ALL: true,
    RETURN_CENTER: true,
    BACK: true,
    FORWARD: true
  }
  if (allowed[name]) return true
  if (name === 'SET_NODE_DATA' && data && typeof data === 'object') {
    const keys = Object.keys(data)
    return keys.length > 0 && keys.every(key => key === 'expand' || key === 'isActive')
  }
  return false
}

module.exports = {
  ROLES,
  normalizeUserId,
  normalizeRole,
  normalizeActorId,
  actorFromReq,
  presenceDocRoomKey,
  inferRoomAcl,
  FILE_COLLECTION_KEYS,
  roleAllows,
  accessSummary,
  initSchema,
  migrateLegacyOwners,
  getAccess,
  assertRoomAccess,
  ensureOwner,
  listAccessibleRooms,
  listMembers,
  searchUsers,
  setMember,
  removeMember,
  readonlyCommandAllowed,
  aclError
}
