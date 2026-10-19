const crypto = require('crypto')
const { httpError } = require('../auth')
const { allows } = require('./rules')

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''))
}

function scopeOf(user) {
  if (!user || !Object.prototype.hasOwnProperty.call(user, 'scopeFolderIds') || user.scopeFolderIds == null) {
    return null
  }
  return user.scopeFolderIds
}

async function roleOf(db, user, type, id) {
  const found = await db.query(
    'select knowledge.effective_role($1, $2, $3::uuid) as role',
    [user.id, type, id]
  )
  return found.rows[0] ? found.rows[0].role : null
}

async function insideScope(db, user, type, id) {
  const scope = scopeOf(user)
  if (scope == null) return true
  const found = await db.query(
    'select knowledge.resource_in_scope($1, $2::uuid, $3::uuid[]) as ok',
    [type, id, scope]
  )
  return !!(found.rows[0] && found.rows[0].ok)
}

async function assertAccess(db, user, action, type, id) {
  if (!isUuid(id)) throw httpError(400, 'INVALID_ID', '资源 ID 无效')
  const role = await roleOf(db, user, type, id)
  const scoped = role ? await insideScope(db, user, type, id) : false
  if (!role || !scoped || !allows(role, action)) {
    await db.query(
      `insert into knowledge.audit (user_id, action, file_id, resource_type, resource_id, detail)
       values ($1, 'access_denied', $2, $3, $4::uuid, $5::jsonb)`,
      [user.id, type === 'file' ? id : null, type, id, JSON.stringify({ need: action })]
    ).catch(() => {})
    throw httpError(404, 'NOT_FOUND', '资源不存在或没有权限')
  }
  return role
}

async function writeAudit(db, user, action, type, id, detail) {
  await db.query(
    `insert into knowledge.audit (user_id, action, file_id, resource_type, resource_id, detail)
     values ($1, $2, $3, $4, $5::uuid, $6::jsonb)`,
    [user.id, action, type === 'file' ? id : null, type, id, JSON.stringify(detail || {})]
  )
}

async function loadResource(db, type, id) {
  if (type === 'file') {
    const row = await db.query(
      `select id, owner_user_id, folder_id, inherit_acl, file_name as name
       from knowledge.files where id = $1`,
      [id]
    )
    return row.rows[0] || null
  }
  const row = await db.query(
    `select id, owner_user_id, parent_id as folder_id, inherit_acl, name
     from knowledge.folders where id = $1`,
    [id]
  )
  return row.rows[0] || null
}

async function displayName(db, userId) {
  try {
    const row = await db.query('select name from wecom_users where user_id = $1', [userId])
    return (row.rows[0] && row.rows[0].name) || userId
  } catch (err) {
    if (err.code === '42P01') return userId
    throw err
  }
}

async function describeAccess(db, user, type, id) {
  const actorRole = await assertAccess(db, user, 'grant', type, id)
  const resource = await loadResource(db, type, id)
  const direct = await db.query(
    `select subject_type, subject_id, role from knowledge.acl
     where resource_type = $1 and resource_id = $2`,
    [type, id]
  )
  const chain = []
  let cursor = type === 'file' ? resource.folder_id : resource.folder_id
  if (resource.inherit_acl) {
    let guard = 0
    while (cursor && guard < 64) {
      const folder = await db.query(
        'select id, parent_id, inherit_acl, name from knowledge.folders where id = $1',
        [cursor]
      )
      if (!folder.rows[0]) break
      const visible = await roleOf(db, user, 'folder', folder.rows[0].id)
      chain.push({
        id: folder.rows[0].id,
        name: visible ? folder.rows[0].name : null,
        inherit: folder.rows[0].inherit_acl
      })
      if (!folder.rows[0].inherit_acl) break
      cursor = folder.rows[0].parent_id
      guard += 1
    }
  }
  const inheritedRows = []
  for (const folder of chain) {
    const grants = await db.query(
      `select subject_type, subject_id, role from knowledge.acl
       where resource_type = 'folder' and resource_id = $1`,
      [folder.id]
    )
    grants.rows.forEach(row => inheritedRows.push({ ...row, folder }))
  }
  const entries = []
  const seen = new Set()
  async function pushEntry(row, source, folder) {
    const key = `${row.subject_type}:${row.subject_id}`
    const overridden = source === 'inherited' && seen.has(key)
    if (!overridden) seen.add(key)
    let subjectName = row.subject_id
    if (row.subject_type === 'user') subjectName = await displayName(db, row.subject_id)
    if (row.subject_type === 'team') {
      const team = await db.query('select name from knowledge.teams where id = $1', [row.subject_id])
      subjectName = (team.rows[0] && team.rows[0].name) || row.subject_id
    }
    entries.push({
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      subjectName,
      role: row.role,
      source,
      inheritedFrom: folder ? folder.id : null,
      inheritedFromName: folder ? folder.name : null,
      applied: source === 'direct' || !overridden
    })
  }
  for (const row of direct.rows) await pushEntry(row, 'direct', null)
  for (const row of inheritedRows) await pushEntry(row, 'inherited', row.folder)
  if (!direct.rows.some(row => row.subject_type === 'user' && row.subject_id === resource.owner_user_id)) {
    entries.unshift({
      subjectType: 'user',
      subjectId: resource.owner_user_id,
      subjectName: await displayName(db, resource.owner_user_id),
      role: 'owner',
      source: 'owner',
      inheritedFrom: null,
      inheritedFromName: null,
      applied: true
    })
  }
  return {
    resourceType: type,
    resourceId: id,
    name: resource.name,
    inherit: resource.inherit_acl,
    ownerUserId: resource.owner_user_id,
    actorRole,
    entries
  }
}

async function setGrant(db, user, type, id, input) {
  const actorRole = await assertAccess(db, user, 'grant', type, id)
  const subjectType = input.subjectType === 'team' ? 'team' : 'user'
  const subjectId = String(input.subjectId || '').trim().slice(0, 160)
  const role = input.role == null || input.role === '' ? null : String(input.role)
  if (!subjectId) throw httpError(400, 'INVALID_SUBJECT', '授权对象无效')
  if (role && !['owner', 'manager', 'editor', 'viewer'].includes(role)) {
    throw httpError(400, 'INVALID_ROLE', '角色无效')
  }
  if (subjectType === 'team') {
    const team = await db.query('select id from knowledge.teams where id = $1', [subjectId])
    if (!team.rows[0]) throw httpError(400, 'UNKNOWN_TEAM', '团队不存在')
  }
  const resource = await loadResource(db, type, id)
  if (subjectType === 'user' && subjectId === resource.owner_user_id && role !== 'owner') {
    throw httpError(409, 'OWNER_ANCHOR', '资源所有者不能被降级，请先移交所有权')
  }
  const existing = await db.query(
    `select role from knowledge.acl
     where resource_type = $1 and resource_id = $2 and subject_type = $3 and subject_id = $4`,
    [type, id, subjectType, subjectId]
  )
  if ((role === 'owner' || (existing.rows[0] && existing.rows[0].role === 'owner')) && actorRole !== 'owner') {
    throw httpError(403, 'FORBIDDEN', '只有所有者可以授予或取消所有者')
  }
  if (!role) {
    await db.query(
      `delete from knowledge.acl
       where resource_type = $1 and resource_id = $2 and subject_type = $3 and subject_id = $4`,
      [type, id, subjectType, subjectId]
    )
    await writeAudit(db, user, 'acl_revoke', type, id, { subjectType, subjectId })
  } else {
    await db.query(
      `insert into knowledge.acl
         (id, resource_type, resource_id, subject_type, subject_id, role, granted_by)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (resource_type, resource_id, subject_type, subject_id)
       do update set role = excluded.role, granted_by = excluded.granted_by, updated_at = now()`,
      [crypto.randomUUID(), type, id, subjectType, subjectId, role, user.id]
    )
    await writeAudit(db, user, 'acl_grant', type, id, { subjectType, subjectId, role })
  }
  return describeAccess(db, user, type, id)
}

async function setInherit(db, user, type, id, inherit) {
  await assertAccess(db, user, 'inherit', type, id)
  const table = type === 'file' ? 'knowledge.files' : 'knowledge.folders'
  await db.query(`update ${table} set inherit_acl = $2, updated_at = now() where id = $1`, [id, !!inherit])
  await writeAudit(db, user, 'acl_inherit', type, id, { inherit: !!inherit })
  return describeAccess(db, user, type, id)
}

async function transferOwner(db, user, type, id, nextOwnerId) {
  await assertAccess(db, user, 'transfer', type, id)
  const nextOwner = String(nextOwnerId || '').trim().slice(0, 160)
  if (!nextOwner) throw httpError(400, 'INVALID_SUBJECT', '新的所有者无效')
  const resource = await loadResource(db, type, id)
  const previous = resource.owner_user_id
  const table = type === 'file' ? 'knowledge.files' : 'knowledge.folders'
  await db.query(`update ${table} set owner_user_id = $2, updated_at = now() where id = $1`, [id, nextOwner])
  if (previous !== nextOwner) {
    await db.query(
      `update knowledge.acl
       set role = 'manager', granted_by = $4, updated_at = now()
       where resource_type = $1 and resource_id = $2 and subject_type = 'user'
         and subject_id = $3 and role = 'owner'`,
      [type, id, previous, user.id]
    )
  }
  await db.query(
    `insert into knowledge.acl
       (id, resource_type, resource_id, subject_type, subject_id, role, granted_by)
     values ($1,$2,$3,'user',$4,'owner',$5)
     on conflict (resource_type, resource_id, subject_type, subject_id)
     do update set role = 'owner', granted_by = excluded.granted_by, updated_at = now()`,
    [crypto.randomUUID(), type, id, nextOwner, user.id]
  )
  await writeAudit(db, user, 'acl_transfer', type, id, { ownerUserId: nextOwner, previousOwnerUserId: previous })
  return describeAccess(db, user, type, id)
}

async function createFolder(db, user, input) {
  const name = String(input.name || '').trim().slice(0, 180)
  if (!name) throw httpError(400, 'INVALID_NAME', '文件夹名称无效')
  const parentId = input.parentId || null
  if (parentId) await assertAccess(db, user, 'create', 'folder', parentId)
  const id = crypto.randomUUID()
  await db.query(
    `insert into knowledge.folders (id, parent_id, owner_user_id, org_id, name)
     values ($1,$2,$3,$4,$5)`,
    [id, parentId, user.id, user.orgId || '', name]
  )
  await db.query(
    `insert into knowledge.acl
       (id, resource_type, resource_id, subject_type, subject_id, role, granted_by)
     values ($1,'folder',$2,'user',$3,'owner',$3)`,
    [crypto.randomUUID(), id, user.id]
  )
  await writeAudit(db, user, 'folder_create', 'folder', id, { name, parentId })
  return { id, name, parentId, inherit: true, ownerUserId: user.id, effectiveRole: 'owner' }
}

async function listFolders(db, user) {
  const rows = await db.query(
    `select id, parent_id, name, inherit_acl, owner_user_id,
            knowledge.effective_role($1, 'folder', id) as effective_role
     from knowledge.folders
     where knowledge.role_rank(knowledge.effective_role($1, 'folder', id)) >= 1
       and knowledge.resource_in_scope('folder', id, $2::uuid[])
     order by name`,
    [user.id, scopeOf(user)]
  )
  return {
    folders: rows.rows.map(row => ({
      id: row.id,
      parentId: row.parent_id,
      name: row.name,
      inherit: row.inherit_acl,
      ownerUserId: row.owner_user_id,
      effectiveRole: row.effective_role
    }))
  }
}

async function renameFolder(db, user, id, name) {
  await assertAccess(db, user, 'rename', 'folder', id)
  const next = String(name || '').trim().slice(0, 180)
  if (!next) throw httpError(400, 'INVALID_NAME', '文件夹名称无效')
  await db.query('update knowledge.folders set name = $2, updated_at = now() where id = $1', [id, next])
  return { id, name: next }
}

async function deleteFolder(db, user, id) {
  await assertAccess(db, user, 'remove', 'folder', id)
  const children = await db.query('select id from knowledge.folders where parent_id = $1', [id])
  const files = await db.query('select id from knowledge.files where folder_id = $1', [id])
  for (const child of children.rows) await assertAccess(db, user, 'remove', 'folder', child.id)
  for (const file of files.rows) await assertAccess(db, user, 'remove', 'file', file.id)
  if (children.rows.length || files.rows.length) {
    throw httpError(409, 'FOLDER_NOT_EMPTY', '请先清空子文件夹和文件后再删除')
  }
  await writeAudit(db, user, 'folder_delete', 'folder', id, {})
  await db.query('delete from knowledge.folders where id = $1', [id])
  return { id, deleted: true }
}

async function createTeam(db, user, name) {
  const label = String(name || '').trim().slice(0, 120)
  if (!label) throw httpError(400, 'INVALID_NAME', '团队名称无效')
  const id = `team-${crypto.randomUUID()}`
  await db.query(
    'insert into knowledge.teams (id, name, owner_user_id) values ($1,$2,$3)',
    [id, label, user.id]
  )
  await db.query(
    'insert into knowledge.team_members (team_id, user_id) values ($1,$2)',
    [id, user.id]
  )
  await writeAudit(db, user, 'team_create', 'folder', null, { teamId: id, name: label })
  return { id, name: label }
}

async function addTeamMember(db, user, teamId, memberId) {
  const team = await db.query('select owner_user_id from knowledge.teams where id = $1', [teamId])
  if (!team.rows[0] || team.rows[0].owner_user_id !== user.id) {
    throw httpError(404, 'NOT_FOUND', '团队不存在或没有权限')
  }
  const member = String(memberId || '').trim().slice(0, 160)
  if (!member) throw httpError(400, 'INVALID_SUBJECT', '成员无效')
  await db.query(
    `insert into knowledge.team_members (team_id, user_id) values ($1,$2)
     on conflict do nothing`,
    [teamId, member]
  )
  await writeAudit(db, user, 'team_member_add', 'folder', null, { teamId, memberId: member })
  return { teamId, userId: member }
}

async function removeTeamMember(db, user, teamId, memberId) {
  const team = await db.query('select owner_user_id from knowledge.teams where id = $1', [teamId])
  if (!team.rows[0] || team.rows[0].owner_user_id !== user.id) {
    throw httpError(404, 'NOT_FOUND', '团队不存在或没有权限')
  }
  if (memberId === team.rows[0].owner_user_id) {
    throw httpError(409, 'OWNER_ANCHOR', '不能移除团队所有者')
  }
  await db.query('delete from knowledge.team_members where team_id = $1 and user_id = $2', [teamId, memberId])
  await writeAudit(db, user, 'team_member_remove', 'folder', null, { teamId, memberId })
  return { teamId, userId: memberId, removed: true }
}

module.exports = {
  assertAccess,
  describeAccess,
  setGrant,
  setInherit,
  transferOwner,
  createFolder,
  listFolders,
  renameFolder,
  deleteFolder,
  createTeam,
  addTeamMember,
  removeTeamMember,
  scopeOf
}
