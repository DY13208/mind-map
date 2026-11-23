const acl = require('../roomAcl')

const rank = { viewer: 1, editor: 2, manager: 3 }

// Resolve all ancestor grants without copying them into folder_members. This
// keeps revocation at the source possible, including for future child folders.
async function inheritedMembers(store, folderId, db) {
  const members = new Map()
  const seen = new Set()
  let folder = await store.getFolder(folderId, db)
  const team = folder && (folder.team_id || null)
  while (folder && !folder.deleted_at && !seen.has(folder.id) && (folder.team_id || null) === team) {
    seen.add(folder.id)
    for (const member of await store.listFolderMembers(folder.id, db)) {
      const previous = members.get(member.user_id)
      if (rank[member.role] && (!previous || rank[member.role] > rank[previous.role])) {
        members.set(member.user_id, { ...member, source_folder_id: folder.id })
      }
    }
    folder = folder.parent_id ? await store.getFolder(folder.parent_id, db) : null
  }
  return [...members.values()]
}

// Serialize container ACL writes with file creation/moves. The lock is held by
// the caller's transaction, so a concurrent move cannot retain a revoked grant.
async function lockInheritance(db) {
  if (!Array.isArray(db.members)) {
    await db.query("select pg_advisory_xact_lock(hashtext('folder-file-inheritance-v1'))")
  }
}

async function refreshFolderFileRoles(store, db, { roomKey = null, folderId = null } = {}) {
  if (store.kind === 'memory') {
    const ids = folderId ? new Set(await store.listFolderSubtreeIds(folderId)) : null
    for (const room of store.rooms.values()) {
      if (room.deleted_at || (roomKey && room.room_key !== roomKey) || (ids && !ids.has(room.folder_id))) continue
      await acl.clearRoomFolderRoles(store, room.room_key)
      if (!room.folder_id) continue
      for (const member of await inheritedMembers(store, room.folder_id)) {
        await acl.setFolderRole(store, room.room_key, member.user_id, member.role, member.source_folder_id)
      }
    }
    return
  }

  // Compute the desired grants in bulk, including descendants, while retaining
  // direct file grants and explicit per-file overrides. Cycles stop at path.
  const desired = `with recursive subtree as (
    select id from folders where id = $2::uuid and deleted_at is null
    union
    select f.id from folders f join subtree s on f.parent_id = s.id where f.deleted_at is null
  ), selected as (
    select r.room_key, r.folder_id, r.team_id from rooms r
    where r.deleted_at is null and ($1::text is null or r.room_key = $1)
      and ($2::uuid is null or r.folder_id in (select id from subtree))
  ), chain as (
    select r.room_key, f.id, f.parent_id, f.team_id, array[f.id] as path, 0 as depth
    from selected r join folders f on f.id = r.folder_id
    where f.deleted_at is null and f.team_id is not distinct from r.team_id
    union all
    select c.room_key, f.id, f.parent_id, f.team_id, c.path || f.id, c.depth + 1
    from chain c join folders f on f.id = c.parent_id
    where f.deleted_at is null and not f.id = any(c.path)
      and f.team_id is not distinct from c.team_id
  ), desired as (
    select distinct on (c.room_key, fm.user_id)
      c.room_key, fm.user_id, fm.role as folder_role, c.id::text as source_folder_id
    from chain c join folder_members fm on fm.folder_id = c.id
    order by c.room_key, fm.user_id,
      case fm.role when 'manager' then 3 when 'editor' then 2 else 1 end desc, c.depth
  )`
  const params = [roomKey, folderId]
  const stale = `m.room_key in (select room_key from selected) and m.folder_role is not null
    and not exists (select 1 from desired d where d.room_key = m.room_key and d.user_id = m.user_id)`
  await db.query(`${desired} delete from room_members m where ${stale}
    and m.direct_role is null and m.team_role is null
    and (not coalesce(m.acl_v2, false) or m.override_role is null)`, params)
  await db.query(`${desired} update room_members m set folder_role = null, source_folder_id = null,
    role = ${acl.sqlResolveMemberRole('m.direct_role', 'm.team_role', 'null::text', 'm.role', 'm.override_role', 'm.acl_v2')},
    source = case when m.acl_v2 then case when m.override_role is null then 'inherit' else 'override' end
      else ${acl.sqlPrimarySource('m.direct_role', 'm.team_role', 'null::text')} end,
    updated_at = now() where ${stale}`, params)
  const role = acl.sqlResolveMemberRole('room_members.direct_role', 'room_members.team_role', 'excluded.folder_role', 'room_members.role', 'room_members.override_role', 'room_members.acl_v2')
  const source = `case when room_members.acl_v2 then
    case when room_members.override_role is null then 'inherit' else 'override' end
    else ${acl.sqlPrimarySource('room_members.direct_role', 'room_members.team_role', 'excluded.folder_role')} end`
  const result = await db.query(`${desired} insert into room_members
    (room_key, user_id, role, direct_role, folder_role, source, source_folder_id)
    select room_key, user_id, case when folder_role = 'manager' then 'editor' else folder_role end,
      null, folder_role, 'folder', source_folder_id from desired
    on conflict (room_key, user_id) do update set folder_role = excluded.folder_role,
      source_folder_id = excluded.source_folder_id, role = ${role}, source = ${source}, updated_at = now()
    where (room_members.folder_role, room_members.source_folder_id, room_members.role, room_members.source)
      is distinct from (excluded.folder_role, excluded.source_folder_id, ${role}, ${source})
    returning room_key`, params)
  // Return every affected file for cache invalidation after commit, including
  // revocations that only delete rows.
  const affected = await db.query(`${desired} select room_key from selected`, params)
  return [...new Set([...(affected.rows || []), ...(result.rows || [])].map(row => row.room_key))]
}

async function withInheritanceTransaction(store, fn) {
  const affected = []
  const result = await store.withTx(async conn => {
    const db = conn || store
    await lockInheritance(db)
    return fn(db, async scope => {
      affected.push(...(await refreshFolderFileRoles(store, db, scope) || []))
    })
  })
  for (const key of new Set(affected)) acl.notifyAclChanged(key)
  return result
}

module.exports = { inheritedMembers, lockInheritance, refreshFolderFileRoles, withInheritanceTransaction }
