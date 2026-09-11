const crypto = require('crypto')

const ROLES = ['owner', 'admin', 'member']

function error(statusCode, code, message) {
  const err = new Error(message)
  err.statusCode = statusCode
  err.code = code
  return err
}

function identity(req) {
  const user = req && req.authUser
  if (!user || user.service || !user.id) {
    throw error(401, 'unauthorized', '请先使用企业微信扫码登录')
  }
  const corpId = String(user.corpId || '').trim()
  if (!corpId) throw error(401, 'wecom_identity_required', '缺少企业微信企业身份')
  return { corpId, userId: String(user.id).trim(), wecomUserId: String(user.wecomUserId || user.id).trim() }
}

function teamId(value) {
  const id = String(value || '').trim()
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw error(400, 'INVALID_TEAM_ID', '团队标识无效')
  return id
}

function name(value) {
  const result = String(value || '').trim().slice(0, 100)
  if (!result) throw error(400, 'INVALID_TEAM_NAME', '团队名称不能为空')
  return result
}

async function transaction(db, fn) {
  if (typeof db.connect !== 'function') return fn(db)
  const client = await db.connect()
  try {
    await client.query('begin')
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

function dto(row) {
  return {
    id: row.id,
    corpId: row.corp_id,
    // Prefer a human corp name; never fall back to opaque corp_id in UI payloads.
    corpName: row.corp_name || '',
    name: row.name,
    description: row.description || '',
    ownerId: row.owner_id,
    owner: row.owner_name || row.owner_id,
    role: row.role || null,
    memberCount: Number(row.member_count || 0),
    fileCount: Number(row.file_count || 0),
    roomCount: Number(row.file_count || 0),
    sourceType: row.source_type === 'custom' ? 'CUSTOM_TEAM' : 'WECOM_DEPARTMENT',
    sourceId: row.source_id || null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  }
}

function memberDto(row) {
  return {
    id: row.user_id,
    userId: row.user_id,
    wecomUserId: row.wecom_userid || row.user_id,
    name: row.name || row.user_id,
    avatar: row.avatar || '',
    position: row.position || '',
    departments: Array.isArray(row.departments) ? row.departments : [],
    role: row.role,
    joinedAt: row.joined_at instanceof Date ? row.joined_at.toISOString() : row.joined_at
  }
}

async function initSchema(db) {
  await db.query(`
    create table if not exists teams (
      id text primary key, corp_id text not null, name text not null,
      description text not null default '', source_type text not null default 'custom',
      source_id text, owner_id text not null, created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(), deleted_at timestamptz,
      constraint teams_source_type_chk check (source_type in ('custom', 'wecom_department'))
    )`)
  await db.query(`alter table teams add column if not exists corp_id text`)
  await db.query(`alter table teams add column if not exists description text not null default ''`)
  await db.query(`alter table teams add column if not exists source_type text not null default 'custom'`)
  await db.query(`alter table teams add column if not exists source_id text`)
  await db.query(`alter table teams add column if not exists owner_id text`)
  await db.query(`alter table teams add column if not exists deleted_at timestamptz`)
  await db.query(`create index if not exists teams_corp_updated_idx on teams(corp_id, updated_at desc) where deleted_at is null`)
  await db.query(`
    create table if not exists team_members (
      team_id text not null references teams(id) on delete cascade, corp_id text not null,
      user_id text not null, wecom_userid text not null default '', role text not null, joined_at timestamptz not null default now(),
      updated_at timestamptz not null default now(), primary key (team_id, user_id),
      constraint team_members_role_chk check (role in ('owner', 'admin', 'member'))
    )`)
  await db.query(`alter table team_members add column if not exists corp_id text`)
  await db.query(`alter table team_members add column if not exists wecom_userid text not null default ''`)
  await db.query(`alter table team_members add column if not exists joined_at timestamptz not null default now()`)
  await db.query(`alter table team_members add column if not exists updated_at timestamptz not null default now()`)
  await db.query(`create index if not exists team_members_corp_user_idx on team_members(corp_id, user_id)`)
  await db.query(`alter table rooms add column if not exists team_id text`)
  await db.query(`create index if not exists rooms_team_updated_idx on rooms(team_id, updated_at desc) where team_id is not null`)
  await db.query(`alter table room_members add column if not exists source text not null default 'direct_share'`)
  await db.query(`alter table room_members add column if not exists source_team_id text`)
  await db.query(`alter table room_members add column if not exists direct_role text`)
  await db.query(`alter table room_members add column if not exists team_role text`)
  await db.query(`update room_members set source = 'direct_share' where source is null`)
  await db.query(`
    update room_members
    set direct_role = role
    where direct_role is null and source = 'direct_share'
  `)
  await db.query(`
    update room_members
    set team_role = role
    where team_role is null and source = 'team'
  `)
  await db.query(`create index if not exists room_members_team_source_idx on room_members(source, source_team_id) where source = 'team'`)
}

async function ensureConstraint(db, name, statement) {
  const existing = await db.query(
    `select 1 from pg_constraint where conname = $1 limit 1`,
    [name]
  )
  if (!existing.rows.length) await db.query(statement)
}

async function initCorpConstraints(db) {
  await db.query(`create unique index if not exists teams_id_corp_uq on teams(id, corp_id)`)
  await db.query(`create unique index if not exists wecom_users_corp_user_id_uq on wecom_users(corp_id, user_id)`)
  await ensureConstraint(
    db,
    'team_members_team_corp_fk',
    `alter table team_members add constraint team_members_team_corp_fk
     foreign key (team_id, corp_id) references teams(id, corp_id) on delete cascade`
  )
  await ensureConstraint(
    db,
    'team_members_user_corp_fk',
    `alter table team_members add constraint team_members_user_corp_fk
     foreign key (corp_id, user_id) references wecom_users(corp_id, user_id)`
  )
  await ensureConstraint(
    db,
    'team_members_wecom_identity_fk',
    `alter table team_members add constraint team_members_wecom_identity_fk
     foreign key (corp_id, wecom_userid) references wecom_users(corp_id, wecom_userid)`
  )
  await ensureConstraint(
    db,
    'teams_owner_corp_fk',
    `alter table teams add constraint teams_owner_corp_fk
     foreign key (corp_id, owner_id) references wecom_users(corp_id, user_id)`
  )
  await ensureConstraint(
    db,
    'rooms_team_fk',
    `alter table rooms add constraint rooms_team_fk
     foreign key (team_id) references teams(id)`
  )
}

async function getTeam(db, corpId, id, userId) {
  const result = await db.query(`
    select t.*, m.role, coalesce(owner.name, t.owner_id) as owner_name,
      (select count(*)::int from team_members tm where tm.team_id = t.id) as member_count,
      (select count(*)::int from rooms r left join room_tombstones rt on rt.room_key = r.room_key
       where r.team_id = t.id and r.deleted_at is null and rt.room_key is null) as file_count
    from teams t join team_members m on m.team_id = t.id and m.user_id = $3 and m.corp_id = $1
    left join wecom_users owner on owner.user_id = t.owner_id and owner.corp_id = t.corp_id
    where t.id = $2 and t.corp_id = $1 and t.deleted_at is null`, [corpId, id, userId])
  if (!result.rows.length) throw error(404, 'TEAM_NOT_FOUND', '团队不存在')
  return result.rows[0]
}

function manager(team) {
  if (!team || !['owner', 'admin'].includes(team.role)) throw error(403, 'FORBIDDEN', '只有团队所有者或管理员可以执行该操作')
}

async function listTeams(db, who) {
  const result = await db.query(`
    select t.*, m.role, coalesce(owner.name, t.owner_id) as owner_name,
      (select count(*)::int from team_members tm where tm.team_id = t.id) as member_count,
      (select count(*)::int from rooms r left join room_tombstones rt on rt.room_key = r.room_key
       where r.team_id = t.id and r.deleted_at is null and rt.room_key is null) as file_count
    from teams t join team_members m on m.team_id = t.id and m.user_id = $2 and m.corp_id = $1
    left join wecom_users owner on owner.user_id = t.owner_id and owner.corp_id = t.corp_id
    where t.corp_id = $1 and t.deleted_at is null order by t.updated_at desc`, [who.corpId, who.userId])
  return result.rows.map(dto)
}

async function createTeam(db, who, body = {}) {
  const sourceType = String(body.sourceType || 'custom').toLowerCase()
  if (!['custom', 'custom_team'].includes(sourceType)) throw error(400, 'INVALID_SOURCE_TYPE', '当前只支持 CUSTOM_TEAM')
  const id = `team-${crypto.randomUUID()}`
  return transaction(db, async tx => {
    const result = await tx.query(`
      insert into teams (id, corp_id, name, description, source_type, source_id, owner_id)
      values ($1, $2, $3, $4, 'custom', null, $5) returning *`,
    [id, who.corpId, name(body.name), String(body.description || '').trim().slice(0, 500), who.userId])
    await tx.query(`insert into team_members (team_id, corp_id, user_id, wecom_userid, role) values ($1, $2, $3, $4, 'owner')`, [id, who.corpId, who.userId, who.wecomUserId])
    return dto({ ...result.rows[0], role: 'owner', member_count: 1, file_count: 0 })
  })
}

async function listMembers(db, who, id) {
  await getTeam(db, who.corpId, id, who.userId)
  const result = await db.query(`
    select tm.user_id, coalesce(nullif(tm.wecom_userid, ''), u.wecom_userid, tm.user_id) as wecom_userid,
      tm.role, tm.joined_at, coalesce(u.name, tm.user_id) as name,
      coalesce(u.avatar, '') as avatar, coalesce(u.position, '') as position,
      coalesce(u.departments, '[]'::jsonb) as departments
    from team_members tm left join wecom_users u on u.user_id = tm.user_id and u.corp_id = tm.corp_id
    where tm.team_id = $1 and tm.corp_id = $2
    order by case tm.role when 'owner' then 0 when 'admin' then 1 else 2 end, tm.joined_at`, [id, who.corpId])
  return result.rows.map(memberDto)
}

async function syncRoomMembers(db, id, userId) {
  await db.query(`
    insert into room_members (room_key, user_id, role, direct_role, team_role, source, source_team_id)
    select r.room_key, $2, 'editor', null, 'editor', 'team', $1 from rooms r
    left join room_tombstones rt on rt.room_key = r.room_key
    where r.team_id = $1 and r.deleted_at is null and rt.room_key is null
    on conflict (room_key, user_id) do update set
      team_role = excluded.team_role,
      role = case
        when room_members.direct_role = 'owner' or excluded.team_role = 'owner' then 'owner'
        when room_members.direct_role = 'editor' or excluded.team_role = 'editor' then 'editor'
        when room_members.direct_role = 'viewer' or excluded.team_role = 'viewer' then 'viewer'
        else coalesce(room_members.direct_role, excluded.team_role)
      end,
      source = case when room_members.direct_role is not null then 'direct_share' else 'team' end,
      source_team_id = excluded.source_team_id,
      updated_at = now()`, [id, userId])
}

async function resolveMemberId(db, who, value) {
  const raw = String(value || '').trim()
  if (!raw) return raw
  const result = await db.query(
    `select user_id from wecom_users where corp_id = $1 and (wecom_userid = $2 or user_id = $2) limit 1`,
    [who.corpId, raw]
  )
  return result.rows[0] ? result.rows[0].user_id : raw
}

async function addMembers(db, who, id, ids) {
  const values = Array.from(new Set((Array.isArray(ids) ? ids : []).map(value => String(value || '').trim()).filter(Boolean))).slice(0, 100)
  if (!values.length) throw error(400, 'INVALID_MEMBERS', '请选择企业微信成员')
  return transaction(db, async tx => {
    const team = await getTeam(tx, who.corpId, id, who.userId)
    manager(team)
    const contactsResult = await tx.query(`select user_id, wecom_userid from wecom_users where corp_id = $1 and wecom_userid = any($2::text[])`, [who.corpId, values])
    const found = new Map(contactsResult.rows.map(row => [row.wecom_userid || row.user_id, row.user_id]))
    if (values.some(value => !found.has(value))) throw error(400, 'WECOM_MEMBER_NOT_FOUND', '只能添加当前企业微信通讯录成员')
    for (const wecomUserId of values) {
      const userId = found.get(wecomUserId)
      await tx.query(`
        insert into team_members (team_id, corp_id, user_id, wecom_userid, role) values ($1, $2, $3, $4, 'member')
        on conflict (team_id, user_id) do update set corp_id = excluded.corp_id, updated_at = now()
        where team_members.role <> 'owner'`, [id, who.corpId, userId, wecomUserId])
      await syncRoomMembers(tx, id, userId)
    }
    return listMembers(tx, who, id)
  })
}

async function updateMember(db, who, id, target, role) {
  const team = await getTeam(db, who.corpId, id, who.userId)
  manager(team)
  const targetId = await resolveMemberId(db, who, target)
  const next = String(role || '').toLowerCase()
  if (!['admin', 'member'].includes(next)) throw error(400, 'INVALID_TEAM_ROLE', '角色必须是 admin 或 member')
  const result = await db.query(`update team_members set role = $4, updated_at = now() where team_id = $1 and corp_id = $2 and user_id = $3 and role <> 'owner' returning user_id`, [id, who.corpId, targetId, next])
  if (!result.rows.length) throw error(404, 'TEAM_MEMBER_NOT_FOUND', '团队成员不存在或不能修改所有者')
  const members = await listMembers(db, who, id)
  return members.find(member => member.id === target) || members
}

async function removeMember(db, who, id, target) {
  return transaction(db, async tx => {
    const team = await getTeam(tx, who.corpId, id, who.userId)
    manager(team)
    const targetId = await resolveMemberId(tx, who, target)
    const result = await tx.query(`delete from team_members where team_id = $1 and corp_id = $2 and user_id = $3 and role <> 'owner' returning user_id`, [id, who.corpId, targetId])
    if (!result.rows.length) throw error(404, 'TEAM_MEMBER_NOT_FOUND', '团队成员不存在或不能移除所有者')
    await tx.query(`
      update room_members
      set team_role = null,
          role = direct_role,
          source = 'direct_share',
          source_team_id = null,
          updated_at = now()
      where source_team_id = $1 and user_id = $2 and direct_role is not null`, [id, targetId])
    await tx.query(`
      delete from room_members
      where source_team_id = $1 and user_id = $2 and direct_role is null`, [id, targetId])
    return { ok: true, userId: target }
  })
}

async function listRooms(db, who, id) {
  await getTeam(db, who.corpId, id, who.userId)
  const result = await db.query(`
    select r.room_key, r.title, r.folder_id, r.owner_id, r.created_at, r.updated_at,
      m.role, coalesce(state.is_favorite, false) as is_favorite,
      coalesce(owner.name, r.owner_id) as owner_name, coalesce(owner.avatar, '') as owner_avatar
    from rooms r left join room_tombstones rt on rt.room_key = r.room_key
    left join room_members m on m.room_key = r.room_key and m.user_id = $2
    left join room_user_state state on state.room_key = r.room_key and state.user_id = $2
    left join wecom_users owner on owner.user_id = r.owner_id and owner.corp_id = $3
    where r.team_id = $1 and r.deleted_at is null and rt.room_key is null order by r.updated_at desc`, [id, who.userId, who.corpId])
  return result.rows.map(row => ({
    id: row.room_key,
    roomKey: row.room_key,
    title: row.title,
    folderId: row.folder_id || null,
    owner: { id: row.owner_id || '', name: row.owner_name || row.owner_id || '', avatar: row.owner_avatar || '' },
    role: row.role || null,
    favorite: !!row.is_favorite,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }))
}

async function assignRoom(db, who, id, roomKey) {
  const key = String(roomKey || '').trim()
  if (!key) throw error(400, 'BAD_REQUEST', '缺少脑图标识')
  return transaction(db, async tx => {
    await getTeam(tx, who.corpId, id, who.userId)
    const room = await tx.query(
      `select room_key, owner_id, team_id, deleted_at from rooms where room_key = $1`,
      [key]
    )
    if (!room.rows.length || room.rows[0].deleted_at) {
      throw error(404, 'ROOM_NOT_FOUND', '脑图不存在')
    }
    const currentTeam = room.rows[0].team_id || null
    if (currentTeam && currentTeam !== id) {
      throw error(409, 'ROOM_ALREADY_IN_TEAM', '该脑图已属于其他团队')
    }
    if (currentTeam === id) return { roomKey: key, teamId: id }

    const membership = await tx.query(
      `select role, direct_role from room_members where room_key = $1 and user_id = $2`,
      [key, who.userId]
    )
    const member = membership.rows[0]
    const isOwner =
      room.rows[0].owner_id === who.userId ||
      (member &&
        (member.direct_role === 'owner' || member.role === 'owner'))
    if (!isOwner) {
      throw error(403, 'FORBIDDEN', '只有脑图所有者可以将其移入团队空间')
    }

    await tx.query(
      `update rooms set team_id = $2, updated_at = now() where room_key = $1`,
      [key, id]
    )
    await tx.query(`update teams set updated_at = now() where id = $1`, [id])
    const members = await tx.query(
      `select user_id from team_members where team_id = $1 and corp_id = $2`,
      [id, who.corpId]
    )
    for (const teamMember of members.rows) {
      await tx.query(
        `
      insert into room_members (room_key, user_id, role, direct_role, team_role, source, source_team_id) values ($1, $2, 'editor', null, 'editor', 'team', $3)
      on conflict (room_key, user_id) do update set
        team_role = excluded.team_role,
        role = case
          when room_members.direct_role = 'owner' or excluded.team_role = 'owner' then 'owner'
          when room_members.direct_role = 'editor' or excluded.team_role = 'editor' then 'editor'
          when room_members.direct_role = 'viewer' or excluded.team_role = 'viewer' then 'viewer'
          else coalesce(room_members.direct_role, excluded.team_role)
        end,
        source = case when room_members.direct_role is not null then 'direct_share' else 'team' end,
        source_team_id = excluded.source_team_id,
        updated_at = now()`,
        [key, teamMember.user_id, id]
      )
    }
    return { roomKey: key, teamId: id }
  })
}

async function creationMembers(db, who, id) {
  await getTeam(db, who.corpId, id, who.userId)
  const result = await db.query(
    `select user_id, wecom_userid, role from team_members where team_id = $1 and corp_id = $2`,
    [id, who.corpId]
  )
  return result.rows
}

async function contacts(db, who, options = {}, fetchRemote, upsertContact) {
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 20))
  const offset = Math.max(0, Number(options.offset) || 0)
  if (typeof fetchRemote === 'function') {
    try {
      let remote = await fetchRemote(options)
      const query = String(options.q || options.search || '').trim().toLowerCase()
      if (query) remote = remote.filter(item => `${item.userId} ${item.name}`.toLowerCase().includes(query))
      if (options.departmentId) remote = remote.filter(item => (item.departments || []).map(String).includes(String(options.departmentId)))
      for (const item of remote) {
        if (typeof upsertContact === 'function') {
          await upsertContact({ ...item, corpId: who.corpId, wecomUserId: item.userId, id: item.userId })
          continue
        }
        await db.query(`
          insert into wecom_users (user_id, corp_id, wecom_userid, name, avatar, position, departments, last_login_at)
          values ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
          on conflict (corp_id, wecom_userid) do update set name = excluded.name,
            avatar = excluded.avatar, position = excluded.position, departments = excluded.departments,
            updated_at = now()`,
        [item.userId, who.corpId, item.userId, item.name, item.avatar || '', item.position || '', JSON.stringify(item.departments || [])])
      }
      const items = remote.slice(offset, offset + limit).map(item => ({
        id: item.userId, wecomUserId: item.userId, name: item.name || item.userId,
        avatar: item.avatar || '', position: item.position || '', departments: item.departments || []
      }))
      return { items, list: items, total: remote.length, nextCursor: offset + limit < remote.length ? String(offset + limit) : null, source: 'wecom' }
    } catch (err) {
      if (err && err.code === 'wecom_contacts_forbidden') throw err
      // Network/API outages can use the last synchronized mirror below.
    }
  }
  const params = [who.corpId]
  const where = ['corp_id = $1']
  const query = String(options.q || options.search || '').trim()
  if (query) { params.push(`%${query.replace(/[%_\\]/g, ch => `\\${ch}`)}%`); where.push(`(name ilike $${params.length} escape '\\' or user_id ilike $${params.length} escape '\\' or wecom_userid ilike $${params.length} escape '\\')`) }
  if (options.departmentId) { params.push(String(options.departmentId)); where.push(`departments::text ilike '%' || $${params.length} || '%'`) }
  const count = await db.query(`select count(*)::int as total from wecom_users where ${where.join(' and ')}`, params)
  const page = params.concat([limit + 1, offset])
  const result = await db.query(`select user_id, wecom_userid, name, avatar, position, departments from wecom_users where ${where.join(' and ')} order by name, user_id limit $${page.length - 1} offset $${page.length}`, page)
  const rows = result.rows.slice(0, limit).map(row => ({ id: row.user_id, wecomUserId: row.wecom_userid || row.user_id, name: row.name || row.user_id, avatar: row.avatar || '', position: row.position || '', departments: Array.isArray(row.departments) ? row.departments : [] }))
  return { items: rows, list: rows, total: Number(count.rows[0] && count.rows[0].total) || 0, nextCursor: result.rows.length > limit ? String(offset + limit) : null, source: 'mirror' }
}

async function handleApi(req, res, options) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const path = url.pathname
  const { db, readBody, sendJson, createRoom } = options
  try {
    const relevant = path === '/api/teams' || path.startsWith('/api/teams/') || path === '/api/wecom/contacts' || path === '/api/wecom/departments'
    if (!relevant) return false
    const who = identity(req)
    if (req.method === 'GET' && path === '/api/wecom/contacts') {
      sendJson(res, 200, await contacts(db, who, Object.fromEntries(url.searchParams), options.fetchWecomContacts, options.upsertWecomContact))
      return true
    }
    if (req.method === 'GET' && path === '/api/wecom/departments') {
      const list = typeof options.fetchWecomDepartments === 'function' ? await options.fetchWecomDepartments() : []
      sendJson(res, 200, { ok: true, list })
      return true
    }
    if (path === '/api/teams' && req.method === 'GET') { const items = await listTeams(db, who); sendJson(res, 200, { items, list: items }); return true }
    if (path === '/api/teams' && req.method === 'POST') { sendJson(res, 201, await createTeam(db, who, await readBody(req))); return true }
    const match = path.match(/^\/api\/teams\/([^/]+)(?:\/(members|rooms)(?:\/([^/]+))?)?$/)
    if (!match) return false
    const id = teamId(decodeURIComponent(match[1])); const sub = match[2]; const target = match[3] ? decodeURIComponent(match[3]) : ''
    if (!sub && req.method === 'GET') { sendJson(res, 200, dto(await getTeam(db, who.corpId, id, who.userId))); return true }
    if (!sub && req.method === 'PATCH') {
      const team = await getTeam(db, who.corpId, id, who.userId); manager(team); const body = await readBody(req); const fields = []; const params = [who.corpId, id]
      if (body.name !== undefined) { fields.push(`name = $${params.length + 1}`); params.push(name(body.name)) }
      if (body.description !== undefined) { fields.push(`description = $${params.length + 1}`); params.push(String(body.description || '').trim().slice(0, 500)) }
      if (!fields.length) throw error(400, 'INVALID_TEAM_UPDATE', '没有可更新字段')
      fields.push('updated_at = now()'); const updated = await db.query(`update teams set ${fields.join(', ')} where corp_id = $1 and id = $2 and deleted_at is null returning *`, params)
      sendJson(res, 200, dto({ ...updated.rows[0], role: team.role, member_count: team.member_count, file_count: team.file_count })); return true
    }
    if (sub === 'members' && req.method === 'GET' && !target) { const items = await listMembers(db, who, id); sendJson(res, 200, { items, list: items }); return true }
    if (sub === 'members' && req.method === 'POST' && !target) { const body = await readBody(req); const items = await addMembers(db, who, id, body.wecomUserIds); sendJson(res, 200, { items, list: items }); return true }
    if (sub === 'members' && target && req.method === 'PATCH') { sendJson(res, 200, await updateMember(db, who, id, target, (await readBody(req)).role)); return true }
    if (sub === 'members' && target && req.method === 'DELETE') { sendJson(res, 200, await removeMember(db, who, id, target)); return true }
    if (sub === 'rooms' && req.method === 'GET') { const items = await listRooms(db, who, id); sendJson(res, 200, { items, list: items }); return true }
    if (sub === 'rooms' && req.method === 'POST') {
      const body = await readBody(req)
      const existingKey = String(body.roomKey || body.room_key || '').trim()
      if (existingKey) {
        sendJson(res, 200, await assignRoom(db, who, id, existingKey))
        return true
      }
      if (typeof createRoom !== 'function') throw error(501, 'TEAM_ROOM_UNAVAILABLE', '团队房间创建不可用')
      sendJson(res, 201, await createRoom(req, who, id, body))
      return true
    }
    return false
  } catch (err) {
    if (err && err.statusCode) { sendJson(res, err.statusCode, { ok: false, code: err.code || 'TEAM_ERROR', error: err.message }); return true }
    throw err
  }
}

module.exports = { initSchema, initCorpConstraints, identity, getTeam, listTeams, createTeam, listMembers, addMembers, updateMember, removeMember, listRooms, assignRoom, creationMembers, contacts, handleApi, error }
