'use strict'
const { httpError } = require('./errors')
const { withTx } = require('./tx')

const RANK = { viewer: 1, editor: 2, manager: 3, owner: 4 }
const ROLES = new Set(Object.keys(RANK))
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function rank(role) { return RANK[role] || 0 }

function capabilities(role) {
  const out = []
  if (rank(role) >= RANK.manager) out.push('grant', 'revoke')
  if (rank(role) >= RANK.owner) out.push('transfer')
  return out
}

async function transactional(db, fn) {
  if (db && typeof db.connect === 'function' && typeof db.release !== 'function') return withTx(db, fn)
  return fn(db)
}

function visibleSql(user, kind, alias, params) {
  if (kind !== 'file' && kind !== 'folder') throw new Error('bad kind')
  params.push(user.id)
  const parts = [`kb.effective_role('${kind}', ${alias}.id, $${params.length}) is not null`]
  if (Array.isArray(user.scopeFolderIds)) {
    params.push(user.scopeFolderIds)
    const folderExpr = kind === 'file' ? `${alias}.folder_id` : `${alias}.id`
    parts.push(`kb.folder_in_scope(${folderExpr}, $${params.length}::uuid[])`)
  }
  return parts.join(' and ')
}

async function effectiveRole(db, kind, id, user) {
  if (!UUID.test(String(id || ''))) return null
  const r = await db.query('select kb.effective_role($1, $2, $3) as role', [kind, id, user.id])
  const role = r.rows[0] && r.rows[0].role
  if (!role) return null
  if (Array.isArray(user.scopeFolderIds)) {
    let folderId = id
    if (kind === 'file') {
      const f = await db.query('select folder_id from kb.files where id = $1 and deleted_at is null', [id])
      if (!f.rows[0]) return null
      folderId = f.rows[0].folder_id
    }
    const s = await db.query('select kb.folder_in_scope($1, $2::uuid[]) as ok', [folderId, user.scopeFolderIds])
    if (!s.rows[0] || s.rows[0].ok !== true) return null
  }
  return role
}

async function requireRole(db, user, kind, id, minRole) {
  const role = await effectiveRole(db, kind, id, user)
  if (rank(role) < rank(minRole)) throw httpError(404, 'missing', 'not found')
  return role
}

async function assertNoCycle(db, folderId, parentId) {
  if (!parentId) return
  if (!UUID.test(parentId)) throw httpError(400, 'bad_parent_id')
  if (folderId && folderId === parentId) throw httpError(400, 'folder_cycle', 'folder cannot contain itself')
  if (!folderId) return
  const r = await db.query(
    `with recursive walk as (
       select id, parent_id, 1 as n from kb.folders where id = $1 and deleted_at is null
       union all
       select f.id, f.parent_id, w.n + 1
         from kb.folders f
         join walk w on f.id = w.parent_id
        where f.deleted_at is null and w.n < 64
     )
     select 1 from walk where id = $2`, [parentId, folderId])
  if (r.rows[0]) throw httpError(400, 'folder_cycle', 'folder cannot be moved under its descendant')
}

function subjectOf(body) {
  const subjectType = body && (body.subjectType || body.principalType)
  const subjectId = body && (body.subjectId || body.principalId)
  if (subjectType !== 'user' && subjectType !== 'team') throw httpError(400, 'INVALID_SUBJECT')
  const id = String(subjectId || '').trim()
  if (subjectType === 'team') {
    if (!UUID.test(id)) throw httpError(400, 'INVALID_SUBJECT')
  } else if (!/^[\w.@:-]{1,64}$/.test(id)) throw httpError(400, 'INVALID_SUBJECT')
  return { subjectType, subjectId: id }
}

async function loadResource(db, kind, id) {
  const table = kind === 'file' ? 'kb.files' : 'kb.folders'
  const r = await db.query(`select * from ${table} where id = $1 and deleted_at is null`, [id])
  return r.rows[0] || null
}

async function describeAcl(db, user, kind, id) {
  const role = await requireRole(db, user, kind, id, 'viewer')
  const resource = await loadResource(db, kind, id)
  if (!resource) throw httpError(404, 'missing', 'not found')
  const chain = await db.query(
    `select c.depth, c.target_kind, c.target_id, a.principal_type, a.principal_id, a.role,
            fo.name as folder_name
       from kb.resource_chain($1, $2) c
       left join kb.acl a on (
         (c.target_kind = 'file' and a.file_id = c.target_id) or
         (c.target_kind = 'folder' and a.folder_id = c.target_id)
       )
       left join kb.folders fo on c.target_kind = 'folder' and fo.id = c.target_id
      order by c.depth asc, a.principal_type, a.principal_id`, [kind, id])
  const bySubject = new Map()
  for (const row of chain.rows) {
    if (!row.principal_id) continue
    const key = `${row.principal_type}:${row.principal_id}`
    const direct = row.depth === 0
    const entry = bySubject.get(key) || { subjectType: row.principal_type, subjectId: row.principal_id, direct: null, inherited: null }
    if (direct) entry.direct = row
    else if (!entry.inherited) entry.inherited = row
    bySubject.set(key, entry)
  }
  const grants = []
  const ownerApplied = !Array.from(bySubject.values()).some(e => e.subjectType === 'user' && e.subjectId === resource.owner_id && e.direct && e.direct.role === 'owner')
  grants.push({
    subjectType: 'user', subjectId: resource.owner_id, role: 'owner', source: 'owner', applied: true
  })
  for (const entry of bySubject.values()) {
    if (entry.subjectType === 'user' && entry.subjectId === resource.owner_id && (!entry.direct || entry.direct.role === 'owner')) {
      continue
    }
    if (entry.direct) {
      const overridden = entry.subjectType === 'user' && entry.subjectId === resource.owner_id
      grants.push({
        subjectType: entry.subjectType, subjectId: entry.subjectId, role: entry.direct.role,
        source: 'direct', applied: !overridden
      })
      if (entry.inherited) {
        grants.push(inheritedGrant(entry.inherited, false))
      }
    } else if (entry.inherited) {
      grants.push(inheritedGrant(entry.inherited, true))
    }
  }
  if (!ownerApplied) {
    // anchor row already added
  }
  return {
    name: resource.name,
    inherit: resource.inherit_acl !== false,
    ownerUserId: resource.owner_id,
    effectiveRole: role,
    capabilities: capabilities(role),
    grants
  }
}

function inheritedGrant(row, applied) {
  return {
    subjectType: row.principal_type,
    subjectId: row.principal_id,
    role: row.role,
    source: 'inherited',
    applied,
    inheritedFrom: { id: row.target_id, name: row.folder_name || null }
  }
}

async function putGrant(db, user, kind, id, body) {
  return transactional(db, async c => {
    const actor = await requireRole(c, user, kind, id, 'manager')
    const { subjectType, subjectId } = subjectOf(body)
    if (!ROLES.has(body.role) || body.role === 'owner') throw httpError(400, 'OWNER_SINGLE', 'owner_id is the only owner; use transfer')
    if (rank(body.role) > rank(actor)) throw httpError(403, 'forbidden')
    const resource = await loadResource(c, kind, id)
    if (!resource) throw httpError(404, 'missing', 'not found')
    if (subjectType === 'user' && subjectId === resource.owner_id) {
      throw httpError(409, 'OWNER_ANCHOR', 'the owner anchor cannot be downgraded')
    }
    if (subjectType === 'team') {
      const team = await c.query('select id from kb.teams where id = $1', [subjectId])
      if (!team.rows[0]) throw httpError(400, 'UNKNOWN_TEAM')
    }
    const fileId = kind === 'file' ? id : null
    const folderId = kind === 'folder' ? id : null
    await c.query(
      `delete from kb.acl
        where principal_type = $1 and principal_id = $2
          and file_id is not distinct from $3 and folder_id is not distinct from $4`,
      [subjectType, subjectId, fileId, folderId])
    await c.query(
      `insert into kb.acl (file_id, folder_id, principal_type, principal_id, role, created_by)
       values ($1, $2, $3, $4, $5, $6)`,
      [fileId, folderId, subjectType, subjectId, body.role, user.id])
    await c.query(
      `insert into kb.audit (actor, action, target, meta) values ($1, 'acl.grant', $2, $3)`,
      [user.id, id, { kind, subjectType, subjectId, role: body.role }])
    return describeAcl(c, user, kind, id)
  })
}

async function deleteGrant(db, user, kind, id, body) {
  return transactional(db, async c => {
    await requireRole(c, user, kind, id, 'manager')
    const { subjectType, subjectId } = subjectOf(body)
    const resource = await loadResource(c, kind, id)
    if (!resource) throw httpError(404, 'missing', 'not found')
    if (subjectType === 'user' && subjectId === resource.owner_id) {
      throw httpError(409, 'OWNER_ANCHOR', 'transfer ownership before removing the owner')
    }
    await c.query(
      `delete from kb.acl
        where principal_type = $1 and principal_id = $2
          and file_id is not distinct from $3 and folder_id is not distinct from $4`,
      [subjectType, subjectId, kind === 'file' ? id : null, kind === 'folder' ? id : null])
    await c.query(
      `insert into kb.audit (actor, action, target, meta) values ($1, 'acl.revoke', $2, $3)`,
      [user.id, id, { kind, subjectType, subjectId }])
    return describeAcl(c, user, kind, id)
  })
}

async function transferOwner(db, user, kind, id, body) {
  return transactional(db, async c => {
    const resource = await loadResource(c, kind, id)
    if (!resource || resource.owner_id !== user.id) throw httpError(404, 'missing', 'not found')
    const nextId = String((body && (body.userId || body.subjectId)) || '').trim()
    if (!/^[\w.@:-]{1,64}$/.test(nextId) || nextId === resource.owner_id) throw httpError(400, 'INVALID_SUBJECT')
    const table = kind === 'file' ? 'kb.files' : 'kb.folders'
    const fileId = kind === 'file' ? id : null
    const folderId = kind === 'folder' ? id : null
    await c.query(`update ${table} set owner_id = $2, updated_at = now() where id = $1`, [id, nextId])
    await c.query(
      `delete from kb.acl
        where principal_type = 'user' and principal_id = any($1::text[])
          and file_id is not distinct from $2 and folder_id is not distinct from $3`,
      [[resource.owner_id, nextId], fileId, folderId])
    await c.query(
      `insert into kb.acl (file_id, folder_id, principal_type, principal_id, role, created_by)
       values ($1, $2, 'user', $3, 'manager', $4)`,
      [fileId, folderId, resource.owner_id, user.id])
    await c.query(
      `insert into kb.audit (actor, action, target, meta) values ($1, 'owner.transfer', $2, $3)`,
      [user.id, id, { kind, from: resource.owner_id, to: nextId }])
    return describeAcl(c, { ...user, id: nextId }, kind, id)
  })
}

module.exports = {
  rank, capabilities, visibleSql, effectiveRole, requireRole, assertNoCycle,
  describeAcl, putGrant, deleteGrant, transferOwner
}
