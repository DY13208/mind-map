const crypto = require('crypto')
const { EventEmitter } = require('events')
const { isAuthEnabled } = require('./auth')

const ROLES = ['owner', 'manager', 'editor', 'viewer']
const FOLDER_ROLES = ['manager', 'editor', 'viewer']
const OVERRIDE_ROLES = ['manager', 'editor', 'viewer']
const ROLE_RANK = { owner: 4, manager: 3, editor: 2, viewer: 1 }
const ACTION_RANK = { view: 1, edit: 2, manage: 3 }

// In-process notification so live collaboration can drop cached write access
// right after an ACL change and re-check on the next operation. Multi-instance
// deployments keep the existing short TTL as the cross-instance fallback.
const aclChangeEvents = new EventEmitter()
aclChangeEvents.setMaxListeners(200)
function notifyAclChanged(roomKey) {
  const key = String(roomKey || '')
  if (!key) return
  try {
    aclChangeEvents.emit('changed', key)
  } catch (err) {
    // A broken listener must never fail a committed grant.
  }
}

/**
 * Historical merge: max(direct, team, folder, summary). Kept for rows that
 * predate the per-file override model (acl_v2 = false) so existing grants
 * never change meaning until an admin edits that member.
 */
function effectiveRole(directRole, teamRole, folderRole, legacyRole) {
  const roleValues = [directRole, teamRole, folderRole, legacyRole]
  const roles = roleValues.map(normalizeRole).filter(Boolean)
  if (roles.includes('owner')) return 'owner'
  if ([directRole, teamRole, legacyRole].map(normalizeRole).includes('manager')) return 'manager'
  if (roles.includes('editor')) return 'editor'
  if (roleValues.map(normalizeFolderRole).includes('manager')) return 'editor'
  if (roles.includes('viewer')) return 'viewer'
  return ''
}

/**
 * Per-file override model (acl_v2 = true):
 *  - override_role = viewer|editor|manager → wins over inherited grants,
 *    raising or lowering the folder/team result.
 *  - override_role = null → follow inheritance: the existing default
 *    folder/team merge rules apply unchanged.
 * Owner identity always wins and is never produced by inheritance or the
 * ordinary role selector. The summary `role` column is a derived result and
 * is never re-merged as a grant source: it only backs very old rows that
 * carry no scoped grant columns at all.
 */
function resolveMemberRole(row = {}) {
  const direct = normalizeRole(row.direct_role)
  const summary = normalizeRole(row.role)
  if (direct === 'owner' || summary === 'owner') return 'owner'
  if (row.acl_v2) {
    const override = normalizeOverrideRole(row.override_role)
    if (override) return override
    return effectiveRole(null, row.team_role, row.folder_role, null)
  }
  const scoped =
    normalizeRole(row.direct_role) ||
    normalizeRole(row.team_role) ||
    normalizeFolderRole(row.folder_role)
  return effectiveRole(row.direct_role, row.team_role, row.folder_role, scoped ? '' : row.role)
}

/** True when this member has a per-file setting that overrides inheritance. */
function overrideLocksShare(row = {}) {
  const direct = normalizeRole(row.direct_role)
  const summary = normalizeRole(row.role)
  if (direct === 'owner' || summary === 'owner') return false
  return !!row.acl_v2 && !!normalizeOverrideRole(row.override_role)
}

/** Which rule actually produced the member's access (for UI and diagnostics). */
function memberAccessSource(row = {}) {
  const direct = normalizeRole(row.direct_role)
  const summary = normalizeRole(row.role)
  if (direct === 'owner' || summary === 'owner') return 'owner'
  if (row.acl_v2) {
    if (normalizeOverrideRole(row.override_role)) return 'override'
    if (normalizeFolderRole(row.folder_role)) return 'folder'
    if (normalizeRole(row.team_role)) return 'team'
    return 'none'
  }
  return sourceForRoles(row.direct_role, row.team_role, row.folder_role) || 'none'
}

function sourceForRoles(directRole, teamRole, folderRole) {
  if (normalizeRole(directRole)) return 'direct_share'
  if (normalizeRole(teamRole)) return 'team'
  if (normalizeFolderRole(folderRole)) return 'folder'
  return null
}

/** SQL CASE for max(direct, team, folder) — columns are trusted identifiers only. */
function sqlEffectiveRole(directCol, teamCol, folderCol) {
  return `case
    when coalesce(${directCol}, '') = 'owner'
      or coalesce(${teamCol}, '') = 'owner'
      or coalesce(${folderCol}, '') = 'owner' then 'owner'
    when coalesce(${directCol}, '') = 'manager'
      or coalesce(${teamCol}, '') = 'manager' then 'manager'
    when coalesce(${directCol}, '') = 'editor'
      or coalesce(${teamCol}, '') = 'editor'
      or coalesce(${folderCol}, '') in ('editor', 'manager') then 'editor'
    when coalesce(${directCol}, '') = 'viewer'
      or coalesce(${teamCol}, '') = 'viewer'
      or coalesce(${folderCol}, '') = 'viewer' then 'viewer'
    else coalesce(
      nullif(${directCol}, ''),
      nullif(${teamCol}, ''),
      nullif(${folderCol}, '')
    )
  end`
}

function sqlPrimarySource(directCol, teamCol, folderCol) {
  return `case
    when ${directCol} is not null then 'direct_share'
    when ${teamCol} is not null then 'team'
    when ${folderCol} is not null then 'folder'
    else 'direct_share'
  end`
}

/**
 * SQL mirror of resolveMemberRole for ACL rows. Columns are trusted
 * identifiers or expressions only. An override row that follows inheritance
 * (override_role is null) reuses the existing default merge; a row left
 * without any usable source yields null and trips the role NOT NULL
 * constraint instead of silently falling back to open access.
 */
function sqlResolveMemberRole(directCol, teamCol, folderCol, roleCol, overrideCol, aclV2Col) {
  return `case
    when coalesce(${directCol}, '') = 'owner'
      or coalesce(${roleCol}, '') = 'owner' then 'owner'
    when ${aclV2Col} then
      case
        when coalesce(${overrideCol}, '') in ('manager', 'editor', 'viewer') then ${overrideCol}
        else ${sqlEffectiveRole('null::text', teamCol, folderCol)}
      end
    else ${sqlEffectiveRole(directCol, teamCol, folderCol)}
  end`
}

function aclError(status, code, message) {
  const err = new Error(message)
  err.statusCode = status
  err.code = code
  return err
}

function normalizeUserId(value) {
  const raw = String(value || '')
    .trim()
    .slice(0, 160)
  // Collision ids are `wecom:<48 hex>` and must stay intact across team/room ACL.
  if (/^wecom:[a-f0-9]{48}$/i.test(raw)) return raw
  return raw.replace(/^wecom:/i, '')
}

function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase()
  return ROLES.includes(role) ? role : ''
}

function normalizeFolderRole(value) {
  const role = String(value || '').trim().toLowerCase()
  return FOLDER_ROLES.includes(role) ? role : ''
}

function normalizeOverrideRole(value) {
  const role = String(value || '').trim().toLowerCase()
  return OVERRIDE_ROLES.includes(role) ? role : ''
}

/**
 * Comma/space/semicolon-separated internal user ids or WeCom userids.
 * Example: MIND_MAP_SUPER_ADMIN_IDS=zhangsan,lisi
 */
function parseSuperAdminIds(env = process.env) {
  return String(env.MIND_MAP_SUPER_ADMIN_IDS || '')
    .split(/[,;\s]+/)
    .map(item => normalizeUserId(item))
    .filter(Boolean)
}

function isSuperAdminUser(user, env = process.env) {
  if (!user) return false
  const allow = parseSuperAdminIds(env)
  if (!allow.length) return false
  const candidates = [
    normalizeUserId(user.id),
    normalizeUserId(user.wecomUserId),
    normalizeUserId(user.wecom_userid)
  ].filter(Boolean)
  return candidates.some(id => allow.includes(id))
}

function actorFromReq(req, env = process.env) {
  const user = req && req.authUser
  if (req && req.forceAcl) {
    return {
      id: normalizeUserId(user && user.id),
      bypass: false,
      service: false,
      superAdmin: false
    }
  }
  if (!user) {
    if (!isAuthEnabled()) {
      return { id: '', bypass: true, service: false, superAdmin: false }
    }
    return { id: '', bypass: false, service: false, superAdmin: false }
  }
  if (user.service) {
    return {
      id: normalizeUserId(user.id || 'mcp-service'),
      bypass: true,
      service: true,
      superAdmin: false
    }
  }
  const superAdmin = isSuperAdminUser(user, env)
  if (!isAuthEnabled()) {
    return {
      id: normalizeUserId(user.id),
      bypass: true,
      service: false,
      superAdmin
    }
  }
  return {
    id: normalizeUserId(user.id),
    bypass: superAdmin,
    service: false,
    superAdmin
  }
}

function presenceDocRoomKey(docName) {
  const name = String(docName || '')
  return name.endsWith('__presence') ? name.slice(0, -'__presence'.length) : name
}

function nodeShareCookieName(roomKey) {
  return `mind_map_share_${crypto.createHash('sha256').update(String(roomKey)).digest('hex').slice(0, 16)}`
}

async function getNodeShareAccess(db, req, roomKey, userId) {
  const cookieName = nodeShareCookieName(roomKey)
  const rawCookie = String((req && req.headers && req.headers.cookie) || '')
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(`${cookieName}=`))
  if (!rawCookie) return null
  let value
  try { value = decodeURIComponent(rawCookie.slice(cookieName.length + 1)) } catch (err) { return null }
  const match = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,120})$/i.exec(value)
  if (!match) return null
  const tokenHash = crypto.createHash('sha256').update(match[2]).digest('hex')
  let result
  try {
    result = await db.query(
      `select id, role, recipient_user_id, recipient_user_ids from node_shares
       where id = $1 and room_key = $2 and token_hash = $3 and revoked_at is null
         and (expires_at is null or expires_at > now())`,
      [match[1], roomKey, tokenHash]
    )
  } catch (err) {
    if (err && err.code === '42P01') return null
    throw err
  }
  const share = result.rows[0]
  if (!share) return null
  const recipients = Array.isArray(share.recipient_user_ids) && share.recipient_user_ids.length
    ? share.recipient_user_ids
    : share.recipient_user_id ? [share.recipient_user_id] : []
  if (recipients.length && !recipients.includes(userId)) return null
  if (!recipients.length && share.role !== 'viewer') return null
  return { ...accessSummary(share.role), shareId: share.id }
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
  if (rest === '/transfer-ownership') {
    return { roomKey, action: 'manage' }
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
  if (rest === '/sop-runs/authorize' || rest.startsWith('/sop-runs/')) {
    return { roomKey, action: 'edit' }
  }
  if (rest === '/nodes/query') {
    return { roomKey, action: 'view' }
  }
  if (rest === '/export-tree') {
    return { roomKey, action: 'view' }
  }
  if (rest === '/info' || rest.startsWith('/info')) {
    return { roomKey, action: 'view' }
  }
  if (rest === '/card-preview' || rest.startsWith('/card-preview')) {
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
    // Legacy open rooms are editable by any signed-in user, but not trashable.
    return need <= ACTION_RANK.edit
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
      direct_role text,
      team_role text,
      folder_role text,
      override_role text,
      acl_v2 boolean not null default false,
      direct_role_archive text,
      source text not null default 'direct_share',
      source_team_id text,
      source_folder_id text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (room_key, user_id),
      constraint room_members_role_chk
        check (role in ('owner', 'manager', 'editor', 'viewer'))
    )
  `)
  await db.query(`do $$ begin
    if exists (select 1 from pg_constraint where conrelid = 'room_members'::regclass
      and conname = 'room_members_role_chk' and pg_get_constraintdef(oid) not like '%manager%') then
      alter table room_members drop constraint room_members_role_chk;
      alter table room_members add constraint room_members_role_chk check (role in ('owner', 'manager', 'editor', 'viewer'));
    end if;
  end $$`)
  await db.query(`
    create index if not exists room_members_user_id_idx
    on room_members(user_id)
  `)
  await db.query(`alter table room_members add column if not exists source text not null default 'direct_share'`)
  await db.query(`alter table room_members add column if not exists source_team_id text`)
  await db.query(`alter table room_members add column if not exists direct_role text`)
  await db.query(`alter table room_members add column if not exists team_role text`)
  await db.query(`alter table room_members add column if not exists folder_role text`)
  await db.query(`alter table room_members add column if not exists source_folder_id text`)
  // Per-file override model (viewer/editor). acl_v2 = false keeps the
  // historical merge, so existing rows never silently change meaning before
  // an admin edits that member; direct_role_archive preserves the previous
  // direct grant when a row is converted to the new semantics.
  await db.query(`alter table room_members add column if not exists override_role text`)
  await db.query(`alter table room_members add column if not exists acl_v2 boolean not null default false`)
  await db.query(`alter table room_members add column if not exists direct_role_archive text`)
  await db.query(`
    update room_members
    set direct_role = role
    where direct_role is null
      and folder_role is null
      and role in ('owner', 'manager', 'editor', 'viewer')
      and coalesce(source, 'direct_share') = 'direct_share'
  `)
  await db.query(`
    update room_members
    set team_role = role
    where team_role is null and role in ('owner', 'manager', 'editor', 'viewer') and source = 'team'
  `)
  await db.query(`
    create index if not exists room_members_folder_source_idx
    on room_members(source_folder_id)
    where source_folder_id is not null
  `)
  await migrateFolderRoles(db)
}

/**
 * Idempotent backfill: backup overlapping grants, migrate exact folder-inherited
 * non-owner direct shares, then ensure current folder_members → folder_role.
 */
async function migrateFolderRoles(db) {
  await db.query(`
    create table if not exists room_members_folder_mig_backup (
      room_key text not null,
      user_id text not null,
      role text,
      direct_role text,
      team_role text,
      folder_role text,
      source text,
      source_team_id text,
      source_folder_id text,
      created_at timestamptz,
      updated_at timestamptz,
      folder_id text,
      backed_up_at timestamptz not null default now(),
      primary key (room_key, user_id)
    )
  `)
  await db.query(`
    insert into room_members_folder_mig_backup (
      room_key, user_id, role, direct_role, team_role, folder_role, source,
      source_team_id, source_folder_id, created_at, updated_at, folder_id
    )
    select
      m.room_key,
      m.user_id,
      m.role,
      m.direct_role,
      m.team_role,
      m.folder_role,
      m.source,
      m.source_team_id,
      m.source_folder_id,
      m.created_at,
      m.updated_at,
      r.folder_id::text
    from room_members m
    join rooms r on r.room_key = m.room_key
    join folder_members fm
      on fm.folder_id = r.folder_id and fm.user_id = m.user_id
    where r.folder_id is not null
      and r.deleted_at is null
    on conflict (room_key, user_id) do nothing
  `)
  await db.query(`
    update room_members m
    set
      folder_role = fm.role,
      source_folder_id = r.folder_id::text,
      direct_role = null,
      role = ${sqlEffectiveRole('null::text', 'm.team_role', 'fm.role')},
      source = ${sqlPrimarySource('null::text', 'm.team_role', 'fm.role')},
      updated_at = now()
    from rooms r
    join folder_members fm on fm.folder_id = r.folder_id
    where m.room_key = r.room_key
      and fm.user_id = m.user_id
      and r.folder_id is not null
      and r.deleted_at is null
      and m.role <> 'owner'
      and coalesce(m.direct_role, '') <> 'owner'
      and m.direct_role <> 'manager'
      and m.direct_role is not null
      and m.direct_role = fm.role
      and m.folder_role is null
  `)
  await db.query(`
    insert into room_members (
      room_key, user_id, role, direct_role, team_role, folder_role, source, source_folder_id
    )
    select
      r.room_key,
      fm.user_id,
      ${sqlEffectiveRole('null::text', 'null::text', 'fm.role')},
      null,
      null,
      fm.role,
      'folder',
      r.folder_id::text
    from rooms r
    join folder_members fm on fm.folder_id = r.folder_id
    where r.folder_id is not null
      and r.deleted_at is null
    on conflict (room_key, user_id) do update set
      folder_role = excluded.folder_role,
      source_folder_id = excluded.source_folder_id,
      role = ${sqlEffectiveRole(
        'room_members.direct_role',
        'room_members.team_role',
        'excluded.folder_role'
      )},
      source = ${sqlPrimarySource(
        'room_members.direct_role',
        'room_members.team_role',
        'excluded.folder_role'
      )},
      updated_at = now()
  `)
}

function normalizeActorId(value) {
  const id = normalizeUserId(value)
  if (!id || id === 'anonymous' || id === 'mcp-service') return ''
  return id
}

async function migrateLegacyOwners(db) {
  await db.query(`
    insert into room_members (room_key, user_id, role, direct_role, source)
    select first.room_key, first.user_id, 'owner', 'owner', 'direct_share'
    from (
      select distinct on (o.room_key)
        o.room_key,
        regexp_replace(o.actor_id, '^wecom:', '', 'i') as user_id
      from room_operations o
      join rooms r on r.room_key = o.room_key
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
    insert into room_members (room_key, user_id, role, direct_role, source)
    select distinct
      o.room_key,
      regexp_replace(o.actor_id, '^wecom:', '', 'i') as user_id,
       'editor', 'editor', 'direct_share'
    from room_operations o
    join rooms r on r.room_key = o.room_key
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
  const empty = {
    exists: false, deleted: false, role: null, legacyOpen: false,
    aclV2: false, overrideRole: null, overrideActive: false, source: null, members: 0
  }
  const key = String(roomKey || '')
  if (!key) return { ...empty }
  const tomb = await db.query(
    `select 1 from room_tombstones where room_key = $1`,
    [key]
  )
  if (tomb.rows.length) {
    return { ...empty, deleted: true }
  }
  const room = await db.query(
    `select room_key from rooms where room_key = $1`,
    [key]
  )
  if (!room.rows.length) {
    return { ...empty }
  }
  const members = await db.query(
    `select user_id, role, direct_role, team_role, folder_role, override_role, acl_v2
     from room_members where room_key = $1`,
    [key]
  )
  const uid = normalizeUserId(userId)
  const mine = members.rows.find(row => row.user_id === uid)
  return {
    exists: true,
    deleted: false,
    role: mine ? resolveMemberRole(mine) || null : null,
    aclV2: mine ? !!mine.acl_v2 : false,
    overrideRole: mine ? normalizeOverrideRole(mine.override_role) || null : null,
    overrideActive: mine ? overrideLocksShare(mine) : false,
    source: mine ? memberAccessSource(mine) : null,
    legacyOpen: members.rows.length === 0,
    members: members.rows.length
  }
}

// Server-issued authorization contexts remain unforgeable inside public engine
// inputs. WeakMap metadata does not alter response DTOs or retain old requests.
const issuedRoomAccess = new WeakMap()
function issueRoomAccess(access, roomKey) {
  issuedRoomAccess.set(access, { roomKey: String(roomKey), userId: normalizeUserId(access.userId),
    wholeRoom: !!access.canView && !access.shareId })
  return access
}
function consumeRoomAccess(access, roomKey, userId) {
  const proof = access && issuedRoomAccess.get(access)
  const trusted = !!(proof && proof.wholeRoom && proof.roomKey === String(roomKey) &&
    proof.userId === normalizeUserId(userId))
  // Reuse only once within the current HTTP request. Retained objects are not
  // permission caches and cannot authorize a later request after revocation.
  if (trusted) issuedRoomAccess.delete(access)
  return trusted
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
      return issueRoomAccess({
        ...accessSummary('owner', { bypass: true, legacyOpen: true }),
        exists: false,
        deleted: false,
        members: 0,
        userId: actor.id
      }, roomKey)
    }
    const summary = accessSummary(access.role || 'owner', {
      bypass: true,
      legacyOpen: access.legacyOpen
    })
    return issueRoomAccess({
      ...access,
      ...summary,
      role: summary.role || 'owner',
      userId: actor.id,
      superAdmin: !!actor.superAdmin
    }, roomKey)
  }
  if (!actor.id) {
    throw aclError(401, 'unauthorized', '请先使用企业微信扫码登录')
  }
  const access = await getAccess(db, roomKey, actor.id)
  if (access.deleted || !access.exists) {
    throw aclError(404, 'NOT_FOUND', 'not found')
  }
  let summary = accessSummary(access.role, { legacyOpen: access.legacyOpen })
  let shareId = null
  // A per-file setting caps what share credentials may grant: once a member
  // has an explicit viewer/editor setting, another share link cannot raise it.
  // Inherit rows keep the historical behaviour where a share can raise the role.
  if (!summary.canManage && !access.overrideActive && req && req.headers && req.headers.cookie) {
    const shared = await getNodeShareAccess(db, req, roomKey, actor.id)
    if (shared && ROLE_RANK[shared.role] > (ROLE_RANK[summary.role] || 0)) {
      summary = shared
      shareId = shared.shareId
    }
  }
  if (!roleAllows(summary.role, action, { legacyOpen: summary.legacyOpen })) {
    throw aclError(403, 'FORBIDDEN', '没有权限执行该操作')
  }
  return issueRoomAccess({ ...access, ...summary, userId: actor.id, shareId }, roomKey)
}

async function ensureOwner(db, roomKey, userId) {
  const uid = normalizeUserId(userId)
  const key = String(roomKey || '')
  if (!key || !uid) return null
  const res = await db.query(
    `insert into room_members (room_key, user_id, role, direct_role, source)
     values ($1, $2, $3, $3, 'direct_share')
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
      `insert into room_members (room_key, user_id, role, direct_role, source)
       values ($1, $2, $3, $3, 'direct_share')
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
    ? `, ${sqlResolveMemberRole(
        'my.direct_role',
        'my.team_role',
        'my.folder_role',
        'my.role',
        'my.override_role',
        'my.acl_v2'
      )} as role,
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
         coalesce(u.wecom_userid, m.user_id) as wecom_userid,
         m.role,
         m.direct_role,
         m.team_role,
         m.folder_role,
         m.override_role,
         m.acl_v2,
         m.source,
         m.source_team_id,
         m.source_folder_id,
         m.created_at,
         m.updated_at,
         coalesce(u.name, m.user_id) as name,
         coalesce(u.avatar, '') as avatar
       from room_members m
       left join wecom_users u on u.user_id = m.user_id
       where m.room_key = $1
       order by
         case m.role when 'owner' then 0 when 'manager' then 1 when 'editor' then 2 else 3 end,
         m.created_at asc`,
      [roomKey]
    )
    return res.rows
  } catch (err) {
    if (err.code !== '42P01') throw err
    const res = await db.query(
       `select user_id, user_id as wecom_userid, role, direct_role, team_role, folder_role, override_role, acl_v2, source, source_team_id, source_folder_id, created_at, updated_at, user_id as name, '' as avatar
       from room_members
       where room_key = $1
       order by
         case role when 'owner' then 0 when 'manager' then 1 when 'editor' then 2 else 3 end,
         created_at asc`,
      [roomKey]
    )
    return res.rows
  }
}

async function searchUsers(db, q, limit = 20, corpId = '') {
  const query = String(q || '').trim()
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 20))
  if (!query) return []
  try {
    const pattern =
      '%' + query.replace(/[%_\\]/g, ch => '\\' + ch) + '%'
    const params = [pattern, safeLimit]
    const corp = String(corpId || '').trim().slice(0, 255)
    const corpFilter = corp ? ' and corp_id = $3' : ''
    if (corp) params.push(corp)
    const res = await db.query(
      `select user_id, wecom_userid, name, avatar
       from wecom_users
       where (name ilike $1 escape '\\' or user_id ilike $1 escape '\\' or wecom_userid ilike $1 escape '\\')${corpFilter}
       order by last_login_at desc
       limit $2`,
      params
    )
    return res.rows
  } catch (err) {
    if (err.code === '42P01') return []
    throw err
  }
}

async function resolveUserId(db, value, corpId = '') {
  const uid = normalizeUserId(value)
  if (!uid || !corpId) return uid
  if (!db || typeof db.query !== 'function') return uid
  const result = await db.query(
    `select user_id from wecom_users
     where corp_id = $1 and (wecom_userid = $2 or user_id = $2)
     limit 1`,
    [corpId, uid]
  )
  return result.rows[0] ? result.rows[0].user_id : uid
}

async function transferOwnership(db, roomKey, targetUserId, actorUserId, corpId = '') {
  const key = String(roomKey || '').trim()
  const actor = normalizeUserId(actorUserId)
  const target = await resolveUserId(db, targetUserId, corpId)
  if (!key) throw aclError(400, 'BAD_REQUEST', '缺少脑图标识')
  if (!actor) throw aclError(401, 'UNAUTHORIZED', '请先登录')
  if (!target) throw aclError(400, 'BAD_REQUEST', '请选择新的所有者')
  if (actor === target) throw aclError(400, 'BAD_REQUEST', '不能将所有权转移给自己')

  if (Array.isArray(db.members)) {
    const room =
      (db.rooms && typeof db.rooms.get === 'function' && db.rooms.get(key)) ||
      (Array.isArray(db.rooms) && db.rooms.find(item => item.room_key === key)) ||
      null
    if (!room || room.deleted_at) throw aclError(404, 'NOT_FOUND', '脑图不存在')
    let memberRows = db.members.filter(item => item.room_key === key)
    if (!memberRows.length) {
      db.members.push({
        room_key: key,
        user_id: actor,
        role: 'owner',
        direct_role: 'owner',
        team_role: null,
        folder_role: null,
        source: 'direct_share',
        source_team_id: null,
        source_folder_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      memberRows = db.members.filter(item => item.room_key === key)
    }
    const actorRow = memberRows.find(row => row.user_id === actor)
    const actorIsOwner =
      (actorRow && resolveMemberRole(actorRow) === 'owner') ||
      room.owner_id === actor
    if (!actorIsOwner) {
      throw aclError(403, 'FORBIDDEN', '只有所有者可以转移所有权')
    }
    room.owner_id = target
    room.updated_at = new Date().toISOString()
    let targetRow = db.members.find(
      item => item.room_key === key && item.user_id === target
    )
    if (!targetRow) {
      targetRow = {
        room_key: key,
        user_id: target,
        role: 'owner',
        direct_role: 'owner',
        team_role: null,
        folder_role: null,
        override_role: null,
        acl_v2: false,
        source: 'direct_share',
        source_team_id: null,
        source_folder_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
      db.members.push(targetRow)
    } else {
      targetRow.direct_role = 'owner'
      targetRow.override_role = null
      targetRow.acl_v2 = false
      targetRow.role = 'owner'
      targetRow.source = 'direct_share'
      targetRow.updated_at = new Date().toISOString()
    }
    for (const previous of memberRows) {
      if (previous.user_id === target) continue
      if (resolveMemberRole(previous) !== 'owner') {
        continue
      }
      previous.direct_role = 'editor'
      previous.override_role = null
      previous.acl_v2 = false
      previous.role = effectiveRole(
        previous.direct_role,
        previous.team_role,
        previous.folder_role
      )
      previous.source = 'direct_share'
      previous.updated_at = new Date().toISOString()
    }
    notifyAclChanged(key)
    return db.members
      .filter(item => item.room_key === key)
      .map(item => ({
        user_id: item.user_id,
        wecom_userid: item.user_id,
        role: item.role,
        direct_role: item.direct_role,
        team_role: item.team_role,
        folder_role: item.folder_role,
        override_role: item.override_role || null,
        acl_v2: !!item.acl_v2,
        source: item.source,
        source_team_id: item.source_team_id,
        source_folder_id: item.source_folder_id,
        created_at: item.created_at,
        updated_at: item.updated_at,
        name: item.user_id,
        avatar: ''
      }))
  }

  const run = async conn => {
    const room = await conn.query(
      `select room_key, owner_id from rooms where room_key = $1 and deleted_at is null`,
      [key]
    )
    if (!room.rows.length) throw aclError(404, 'NOT_FOUND', '脑图不存在')

    let memberRows = (
      await conn.query(
        `select user_id, role, direct_role, team_role, folder_role, override_role, acl_v2 from room_members where room_key = $1`,
        [key]
      )
    ).rows
    if (!memberRows.length) {
      await ensureOwner(conn, key, actor)
      memberRows = (
        await conn.query(
          `select user_id, role, direct_role, team_role, folder_role, override_role, acl_v2 from room_members where room_key = $1`,
          [key]
        )
      ).rows
    }

    const actorRow = memberRows.find(row => row.user_id === actor)
    const actorIsOwner =
      (actorRow && resolveMemberRole(actorRow) === 'owner') ||
      room.rows[0].owner_id === actor
    if (!actorIsOwner) {
      throw aclError(403, 'FORBIDDEN', '只有所有者可以转移所有权')
    }

    await conn.query(
      `update rooms set owner_id = $2, updated_at = now() where room_key = $1`,
      [key, target]
    )

    await conn.query(
      `insert into room_members (room_key, user_id, role, direct_role, team_role, folder_role, override_role, acl_v2, source, source_team_id, source_folder_id)
       values ($1, $2, 'owner', 'owner', null, null, null, false, 'direct_share', null, null)
       on conflict (room_key, user_id) do update set
         direct_role = 'owner',
         override_role = null,
         acl_v2 = false,
         role = 'owner',
         source = 'direct_share',
         updated_at = now()`,
      [key, target]
    )

    const previousOwners = memberRows.filter(
      row => row.user_id !== target && resolveMemberRole(row) === 'owner'
    )
    for (const previous of previousOwners) {
      await conn.query(
        `update room_members
         set direct_role = 'editor',
             override_role = null,
             acl_v2 = false,
             role = ${sqlEffectiveRole(
               `'editor'`,
               'team_role',
               'folder_role'
             )},
             source = 'direct_share',
             updated_at = now()
         where room_key = $1 and user_id = $2`,
        [key, previous.user_id]
      )
    }

    notifyAclChanged(key)
    return listMembers(conn, key)
  }

  if (typeof db.connect === 'function') {
    const client = await db.connect()
    try {
      await client.query('begin')
      const list = await run(client)
      await client.query('commit')
      return list
    } catch (err) {
      try {
        await client.query('rollback')
      } catch (_) {}
      throw err
    } finally {
      client.release()
    }
  }
  return run(db)
}

async function setMember(db, roomKey, targetUserId, role, actorUserId, corpId = '', options = {}) {
  const uid = await resolveUserId(db, targetUserId, corpId)
  const rawRole = String(role || '').trim().toLowerCase()
  const nextRole = normalizeRole(rawRole)
  const overrideRole = normalizeOverrideRole(rawRole)
  const inherit = rawRole === 'inherit'
  if (!uid) throw aclError(400, 'BAD_REQUEST', '缺少用户')
  if (!nextRole && !overrideRole && !inherit) {
    throw aclError(400, 'BAD_REQUEST', '无效的权限角色')
  }
  const columns = `user_id, role, direct_role, team_role, folder_role, override_role, acl_v2`
  let memberRows = (
    await db.query(`select ${columns} from room_members where room_key = $1`, [roomKey])
  ).rows
  if (!memberRows.length) {
    const actor = normalizeUserId(actorUserId) || uid
    await ensureOwner(db, roomKey, actor)
    memberRows = (
      await db.query(`select ${columns} from room_members where room_key = $1`, [roomKey])
    ).rows
  }
  const owners = memberRows.filter(row => resolveMemberRole(row) === 'owner')
  const current = memberRows.find(row => row.user_id === uid)
  const actor = memberRows.find(row => row.user_id === normalizeUserId(actorUserId))
  const actorRole = actor ? resolveMemberRole(actor) : ''
  const managerActor = !options.bypass && actorRole === 'manager'
  const currentEffective = current ? resolveMemberRole(current) : ''
  if (managerActor && (nextRole === 'owner' || currentEffective === 'owner')) {
    throw aclError(403, 'OWNER_REQUIRED', '只有所有者可以授予或修改所有者权限')
  }

  const returning = `room_key, user_id, role, direct_role, team_role, folder_role, override_role, acl_v2, source, source_team_id, source_folder_id, created_at, updated_at`

  if (nextRole === 'owner') {
    const res = await db.query(
      `insert into room_members (room_key, user_id, role, direct_role, team_role, folder_role, override_role, acl_v2, source, source_team_id, source_folder_id)
       values ($1, $2, 'owner', 'owner', null, null, null, false, 'direct_share', null, null)
       on conflict (room_key, user_id) do update set
         direct_role = 'owner',
         override_role = null,
         acl_v2 = false,
         role = 'owner',
         source = 'direct_share',
         updated_at = now()
       returning ${returning}`,
      [roomKey, uid]
    )
    if (!res.rows.length) throw aclError(403, 'OWNER_REQUIRED', '只有所有者可以修改所有者权限')
    notifyAclChanged(roomKey)
    return res.rows[0]
  }

  if (inherit) {
    if (!current) {
      // Nothing to restore: no per-file setting and no inherited source.
      return { room_key: roomKey, user_id: uid, role: null, restored: 'none' }
    }
    if (currentEffective === 'owner') {
      throw aclError(400, 'OWNER_REQUIRED', '所有者身份请使用所有权转移流程')
    }
    if (!normalizeFolderRole(current.folder_role) && !normalizeRole(current.team_role)) {
      const del = await db.query(
        `delete from room_members where room_key = $1 and user_id = $2`,
        [roomKey, uid]
      )
      notifyAclChanged(roomKey)
      return { room_key: roomKey, user_id: uid, role: null, restored: 'none', removed: true, deleted: del.rowCount }
    }
    const res = await db.query(
      `update room_members
       set acl_v2 = true,
           override_role = null,
           direct_role_archive = coalesce(direct_role_archive, direct_role),
           direct_role = null,
           role = ${sqlResolveMemberRole('null::text', 'team_role', 'folder_role', 'null::text', 'null::text', 'true')},
           source = ${sqlPrimarySource('null::text', 'team_role', 'folder_role')},
           updated_at = now()
       where room_key = $1 and user_id = $2
       returning ${returning}`,
      [roomKey, uid]
    )
    if (!res.rows.length) throw aclError(404, 'NOT_FOUND', '成员不存在')
    notifyAclChanged(roomKey)
    return res.rows[0]
  }

  if (currentEffective === 'owner' && owners.length <= 1) {
    throw aclError(400, 'LAST_OWNER', '不能取消最后一个所有者')
  }
  const res = await db.query(
    `insert into room_members (room_key, user_id, role, direct_role, team_role, folder_role, override_role, acl_v2, source, source_team_id, source_folder_id)
     values ($1, $2, $3, null, null, null, $3, true, 'override', null, null)
     on conflict (room_key, user_id) do update set
       direct_role_archive = coalesce(room_members.direct_role_archive, room_members.direct_role),
       direct_role = null,
       override_role = $3,
       acl_v2 = true,
       role = ${sqlResolveMemberRole(
         'null::text',
         'room_members.team_role',
         'room_members.folder_role',
         'null::text',
         '$3',
         'true'
       )},
       source = 'override',
       updated_at = now()
     where not $4::boolean or room_members.role <> 'owner'
     returning ${returning}`,
    [roomKey, uid, overrideRole, managerActor]
  )
  if (!res.rows.length) throw aclError(403, 'OWNER_REQUIRED', '只有所有者可以修改所有者权限')
  notifyAclChanged(roomKey)
  return res.rows[0]
}

async function removeMember(db, roomKey, targetUserId, corpId = '', actorUserId = '', options = {}) {
  const uid = await resolveUserId(db, targetUserId, corpId)
  if (!uid) throw aclError(400, 'BAD_REQUEST', '缺少用户')
  const current = await db.query(
    `select user_id, role, direct_role, team_role, folder_role, override_role, acl_v2 from room_members
      where room_key = $1 and user_id = $2`,
    [roomKey, uid]
  )
  if (!current.rows.length) {
    throw aclError(404, 'NOT_FOUND', '成员不存在')
  }
  const currentRow = current.rows[0]
  const currentEffective = resolveMemberRole(currentRow)
  const actor = !options.bypass && actorUserId ? await getAccess(db, roomKey, actorUserId) : null
  const managerActor = !!(actor && actor.role === 'manager')
  if (managerActor && currentEffective === 'owner') {
    throw aclError(403, 'OWNER_REQUIRED', '只有所有者可以移除所有者权限')
  }
  if (currentEffective === 'owner') {
    const owners = await db.query(
      `select count(*)::int as total from room_members
       where room_key = $1 and role = 'owner' and user_id <> $2`,
      [roomKey, uid]
    )
    if (Number(owners.rows[0].total) < 1) {
      throw aclError(400, 'LAST_OWNER', '不能删除最后一个所有者')
    }
  }
  let result
  if (currentRow.acl_v2) {
    // Override rows: removing the per-file setting restores inheritance when
    // a folder/team source exists, otherwise the member loses access.
    if (!normalizeFolderRole(currentRow.folder_role) && !normalizeRole(currentRow.team_role)) {
      result = await db.query(
        `delete from room_members where room_key = $1 and user_id = $2 and (not $3::boolean or role <> 'owner')`,
        [roomKey, uid, managerActor]
      )
    } else {
      result = await db.query(
        `update room_members
         set override_role = null,
             acl_v2 = true,
             direct_role_archive = coalesce(direct_role_archive, direct_role),
             direct_role = null,
             role = ${sqlResolveMemberRole('null::text', 'team_role', 'folder_role', 'null::text', 'null::text', 'true')},
             source = ${sqlPrimarySource('null::text', 'team_role', 'folder_role')},
             updated_at = now()
         where room_key = $1 and user_id = $2 and (not $3::boolean or role <> 'owner')`,
        [roomKey, uid, managerActor]
      )
    }
  } else if (currentRow.team_role || currentRow.folder_role) {
    result = await db.query(
      `update room_members
       set direct_role = null,
           role = ${sqlEffectiveRole('null::text', 'team_role', 'folder_role')},
           source = ${sqlPrimarySource('null::text', 'team_role', 'folder_role')},
           updated_at = now()
       where room_key = $1 and user_id = $2 and (not $3::boolean or role <> 'owner')`,
      [roomKey, uid, managerActor]
    )
  } else {
    result = await db.query(
      `delete from room_members where room_key = $1 and user_id = $2 and (not $3::boolean or role <> 'owner')`,
      [roomKey, uid, managerActor]
    )
  }
  if (managerActor && result.rowCount === 0) throw aclError(403, 'OWNER_REQUIRED', '成员权限已变化，请刷新后重试')
  notifyAclChanged(roomKey)
  return { ok: true, user_id: uid }
}

/**
 * Set / update folder-inherited role only — never touches direct_role or team_role.
 */
async function setFolderRole(db, roomKey, targetUserId, role, folderId, corpId = '') {
  const uid = await resolveUserId(db, targetUserId, corpId)
  const nextRole = normalizeFolderRole(role)
  const folder = String(folderId || '').trim()
  if (!uid) throw aclError(400, 'BAD_REQUEST', '缺少用户')
  if (!nextRole || nextRole === 'owner') {
    throw aclError(400, 'BAD_REQUEST', '文件夹权限必须是可编辑或可查看')
  }
  if (!folder) throw aclError(400, 'BAD_REQUEST', '缺少文件夹')
  if (Array.isArray(db.members)) {
    const key = String(roomKey || '')
    let current = db.members.find(item => item.room_key === key && item.user_id === uid)
    if (!current) {
      current = {
        room_key: key,
        user_id: uid,
        role: effectiveRole(null, null, nextRole),
        direct_role: null,
        team_role: null,
        folder_role: nextRole,
        override_role: null,
        acl_v2: false,
        source: 'folder',
        source_team_id: null,
        source_folder_id: folder,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
      db.members.push(current)
    } else {
      current.folder_role = nextRole
      current.source_folder_id = folder
      current.role = resolveMemberRole(current)
      current.source = current.acl_v2
        ? current.override_role ? 'override' : 'inherit'
        : sourceForRoles(current.direct_role, current.team_role, current.folder_role)
      current.updated_at = new Date().toISOString()
    }
    notifyAclChanged(key)
    return { ...current }
  }
  const res = await db.query(
    `insert into room_members (
       room_key, user_id, role, direct_role, team_role, folder_role, source, source_folder_id
     ) values ($1, $2, ${sqlEffectiveRole('null::text', 'null::text', '$3')}, null, null, $3, 'folder', $4)
     on conflict (room_key, user_id) do update set
       folder_role = excluded.folder_role,
       source_folder_id = excluded.source_folder_id,
       role = ${sqlResolveMemberRole(
         'room_members.direct_role',
         'room_members.team_role',
         'excluded.folder_role',
         'room_members.role',
         'room_members.override_role',
         'room_members.acl_v2'
       )},
       source = case
         when room_members.acl_v2 and room_members.override_role is not null then 'override'
         when room_members.acl_v2 then 'inherit'
         else ${sqlPrimarySource(
           'room_members.direct_role',
           'room_members.team_role',
           'excluded.folder_role'
         )}
       end,
       updated_at = now()
     returning room_key, user_id, role, direct_role, team_role, folder_role, override_role, acl_v2, source, source_team_id, source_folder_id, created_at, updated_at`,
    [roomKey, uid, nextRole, folder]
  )
  notifyAclChanged(roomKey)
  return res.rows[0]
}

/**
 * Clear folder-inherited role only — keeps direct_share and team grants.
 */
async function clearFolderRole(db, roomKey, targetUserId, corpId = '') {
  const uid = await resolveUserId(db, targetUserId, corpId)
  if (!uid) throw aclError(400, 'BAD_REQUEST', '缺少用户')
  if (Array.isArray(db.members)) {
    const key = String(roomKey || '')
    const idx = db.members.findIndex(item => item.room_key === key && item.user_id === uid)
    if (idx < 0) return { ok: true, user_id: uid, removed: false }
    const row = db.members[idx]
    if (!row.folder_role) return { ok: true, user_id: uid, removed: false }
    const hasOtherSource =
      !!row.direct_role || !!row.team_role || (!!row.acl_v2 && !!row.override_role)
    if (hasOtherSource) {
      row.folder_role = null
      row.source_folder_id = null
      row.role = resolveMemberRole(row)
      row.source = row.acl_v2
        ? row.override_role ? 'override' : 'inherit'
        : sourceForRoles(row.direct_role, row.team_role, null)
      row.updated_at = new Date().toISOString()
    } else {
      db.members.splice(idx, 1)
    }
    notifyAclChanged(key)
    return { ok: true, user_id: uid, removed: true }
  }
  const current = await db.query(
    `select user_id, role, direct_role, team_role, folder_role, override_role, acl_v2 from room_members
      where room_key = $1 and user_id = $2`,
    [roomKey, uid]
  )
  if (!current.rows.length) {
    return { ok: true, user_id: uid, removed: false }
  }
  const row = current.rows[0]
  if (!row.folder_role) {
    return { ok: true, user_id: uid, removed: false }
  }
  const hasOtherSource =
    !!row.direct_role || !!row.team_role || (!!row.acl_v2 && !!normalizeOverrideRole(row.override_role))
  if (hasOtherSource) {
    await db.query(
      `update room_members
       set folder_role = null,
           source_folder_id = null,
           role = ${sqlResolveMemberRole(
             'direct_role',
             'team_role',
             'null::text',
             'role',
             'override_role',
             'acl_v2'
           )},
           source = case
             when acl_v2 and override_role is not null then 'override'
             when acl_v2 then 'inherit'
             else ${sqlPrimarySource('direct_role', 'team_role', 'null::text')}
           end,
           updated_at = now()
       where room_key = $1 and user_id = $2`,
      [roomKey, uid]
    )
  } else {
    await db.query(
      `delete from room_members where room_key = $1 and user_id = $2`,
      [roomKey, uid]
    )
  }
  notifyAclChanged(roomKey)
  return { ok: true, user_id: uid, removed: true }
}

/** Clear every folder_role on a room (used when leaving a folder). */
async function clearRoomFolderRoles(db, roomKey) {
  const key = String(roomKey || '')
  if (!key) return { ok: true }
  if (Array.isArray(db.members)) {
    for (let i = db.members.length - 1; i >= 0; i--) {
      const row = db.members[i]
      if (row.room_key !== key || !row.folder_role) continue
      const hasOtherSource =
        !!row.direct_role || !!row.team_role || (!!row.acl_v2 && !!row.override_role)
      if (hasOtherSource) {
        row.folder_role = null
        row.source_folder_id = null
        row.role = resolveMemberRole(row)
        row.source = row.acl_v2
          ? row.override_role ? 'override' : 'inherit'
          : sourceForRoles(row.direct_role, row.team_role, null)
        row.updated_at = new Date().toISOString()
      } else {
        db.members.splice(i, 1)
      }
    }
    notifyAclChanged(key)
    return { ok: true }
  }
  // Remove folder-only grants before recomputing role: their remaining role
  // would be null, which violates room_members.role's NOT NULL constraint.
  await db.query(
    `delete from room_members
     where room_key = $1
       and folder_role is not null
       and direct_role is null
       and team_role is null
       and (not coalesce(acl_v2, false) or override_role is null)`,
    [key]
  )
  await db.query(
    `update room_members
     set folder_role = null,
         source_folder_id = null,
         role = ${sqlResolveMemberRole(
           'direct_role',
           'team_role',
           'null::text',
           'role',
           'override_role',
           'acl_v2'
         )},
         source = case
           when acl_v2 and override_role is not null then 'override'
           when acl_v2 then 'inherit'
           else ${sqlPrimarySource('direct_role', 'team_role', 'null::text')}
         end,
         updated_at = now()
     where room_key = $1 and folder_role is not null
       and (direct_role is not null or team_role is not null
         or (coalesce(acl_v2, false) and override_role is not null))`,
    [key]
  )
  notifyAclChanged(key)
  return { ok: true }
}

/**
 * Apply current folder_members as folder_role for one room (after move-in).
 * members: [{ user_id, role }]
 */
async function applyFolderRoles(db, roomKey, folderId, members) {
  const key = String(roomKey || '')
  const folder = String(folderId || '').trim()
  if (!key || !folder) return { ok: true, count: 0 }
  let count = 0
  for (const member of members || []) {
    const uid = normalizeUserId(member.user_id || member.userId)
    const role = normalizeFolderRole(member.role)
    if (!uid || !role) continue
    await setFolderRole(db, key, uid, role, folder)
    count += 1
  }
  return { ok: true, count }
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
  FOLDER_ROLES,
  OVERRIDE_ROLES,
  normalizeUserId,
  normalizeRole,
  normalizeFolderRole,
  normalizeOverrideRole,
  effectiveRole,
  resolveMemberRole,
  overrideLocksShare,
  memberAccessSource,
  sourceForRoles,
  sqlEffectiveRole,
  sqlResolveMemberRole,
  sqlPrimarySource,
  normalizeActorId,
  parseSuperAdminIds,
  isSuperAdminUser,
  actorFromReq,
  presenceDocRoomKey,
  nodeShareCookieName,
  inferRoomAcl,
  FILE_COLLECTION_KEYS,
  roleAllows,
  accessSummary,
  initSchema,
  migrateLegacyOwners,
  migrateFolderRoles,
  getAccess,
  assertRoomAccess,
  consumeRoomAccess,
  ensureOwner,
  listAccessibleRooms,
  listMembers,
  searchUsers,
  resolveUserId,
  setMember,
  transferOwnership,
  removeMember,
  setFolderRole,
  clearFolderRole,
  clearRoomFolderRoles,
  applyFolderRoles,
  aclChangeEvents,
  notifyAclChanged,
  readonlyCommandAllowed,
  aclError
}
