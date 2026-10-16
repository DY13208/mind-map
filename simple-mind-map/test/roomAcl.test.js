const assert = require('assert')
const roomAcl = require('../bin/roomAcl')

function testNormalizeAndInfer() {
  assert.strictEqual(roomAcl.normalizeUserId('wecom:zhangsan'), 'zhangsan')
  const collisionId = 'wecom:' + 'ab'.repeat(24)
  assert.strictEqual(roomAcl.normalizeUserId(collisionId), collisionId)
  assert.strictEqual(roomAcl.normalizeRole('Owner'), 'owner')
  assert.strictEqual(roomAcl.normalizeRole('guest'), '')

  assert.deepStrictEqual(
    roomAcl.inferRoomAcl('/api/files/recent', 'GET'),
    null
  )
  assert.deepStrictEqual(
    roomAcl.inferRoomAcl('/api/files/favorites', 'GET'),
    null
  )
  assert.deepStrictEqual(
    roomAcl.inferRoomAcl('/api/files/trash', 'GET'),
    null
  )
  assert.deepStrictEqual(
    roomAcl.inferRoomAcl('/api/files/room-a/favorite', 'POST'),
    { roomKey: 'room-a', action: 'view' }
  )
  assert.deepStrictEqual(
    roomAcl.inferRoomAcl('/api/files/room-a/trash', 'POST'),
    { roomKey: 'room-a', action: 'manage' }
  )
  assert.deepStrictEqual(
    roomAcl.inferRoomAcl('/api/files/room-a/restore', 'POST'),
    { roomKey: 'room-a', action: 'manage' }
  )
  assert.deepStrictEqual(
    roomAcl.inferRoomAcl('/api/files/room-a/permanent', 'DELETE'),
    { roomKey: 'room-a', action: 'manage' }
  )
  assert.strictEqual(roomAcl.roleAllows('editor', 'manage'), false)
  assert.strictEqual(roomAcl.roleAllows('viewer', 'manage'), false)
  assert.strictEqual(roomAcl.roleAllows('owner', 'manage'), true)
  assert.deepStrictEqual(
    roomAcl.inferRoomAcl('/api/files/room-a/preview', 'GET'),
    { roomKey: 'room-a', action: 'view' }
  )
  assert.deepStrictEqual(
    roomAcl.inferRoomAcl('/api/files/room-a/nodes/n1', 'PATCH'),
    { roomKey: 'room-a', action: 'edit' }
  )
  assert.deepStrictEqual(
    roomAcl.inferRoomAcl('/api/files/room-a/nodes/query', 'POST'),
    { roomKey: 'room-a', action: 'view' }
  )
  assert.deepStrictEqual(
    roomAcl.inferRoomAcl('/api/files/room-a/export-tree', 'POST'),
    { roomKey: 'room-a', action: 'view' }
  )
  assert.deepStrictEqual(
    roomAcl.inferRoomAcl('/api/files/room-a/export-tree', 'GET'),
    { roomKey: 'room-a', action: 'view' }
  )
  assert.deepStrictEqual(
    roomAcl.inferRoomAcl('/api/files/room-a', 'PATCH'),
    { roomKey: 'room-a', action: 'edit' }
  )
  assert.deepStrictEqual(
    roomAcl.inferRoomAcl('/api/files/room-a', 'DELETE'),
    { roomKey: 'room-a', action: 'manage' }
  )
  assert.deepStrictEqual(
    roomAcl.inferRoomAcl('/api/files/room-a/ref-resolve', 'GET'),
    { roomKey: 'room-a', action: 'view' }
  )
  assert.deepStrictEqual(
    roomAcl.inferRoomAcl('/api/files/room-a/members', 'POST'),
    { roomKey: 'room-a', action: 'manage' }
  )
  assert.deepStrictEqual(
    roomAcl.inferRoomAcl('/api/files/room-a/transfer-ownership', 'POST'),
    { roomKey: 'room-a', action: 'manage' }
  )
  assert.deepStrictEqual(
    roomAcl.inferRoomAcl('/api/files/room-a/presence', 'POST'),
    { roomKey: 'room-a', action: 'view' }
  )
  assert.deepStrictEqual(
    roomAcl.inferRoomAcl('/api/maps/room-a/operations', 'POST'),
    { roomKey: 'room-a', action: 'edit' }
  )
  assert.deepStrictEqual(
    roomAcl.inferRoomAcl('/api/files/room-a/move', 'POST'),
    { roomKey: 'room-a', action: 'edit' }
  )
  assert.deepStrictEqual(
    roomAcl.inferRoomAcl('/api/files/room-a/sop-runs/authorize', 'POST'),
    { roomKey: 'room-a', action: 'edit' }
  )
  assert.strictEqual(roomAcl.roleAllows('viewer', 'edit'), false)
  assert.strictEqual(roomAcl.roleAllows('editor', 'edit'), true)
  assert.strictEqual(
    roomAcl.presenceDocRoomKey('room-a__presence'),
    'room-a'
  )
}

function testRoleMatrix() {
  assert.strictEqual(roomAcl.normalizeRole('Manager'), 'manager')
  for (const action of ['view', 'edit', 'manage']) {
    assert.strictEqual(roomAcl.roleAllows('manager', action), true)
  }
  assert.strictEqual(roomAcl.effectiveRole('manager', 'editor', 'viewer'), 'manager')
  assert.strictEqual(roomAcl.effectiveRole(null, null, 'manager'), 'editor')
  assert.strictEqual(roomAcl.effectiveRole('viewer', null, 'manager'), 'editor')
  assert.strictEqual(roomAcl.effectiveRole('owner', 'manager', 'editor'), 'owner')
  assert.strictEqual(roomAcl.roleAllows('viewer', 'view'), true)
  assert.strictEqual(roomAcl.roleAllows('viewer', 'edit'), false)
  assert.strictEqual(roomAcl.roleAllows('viewer', 'manage'), false)
  assert.strictEqual(roomAcl.roleAllows('editor', 'edit'), true)
  assert.strictEqual(roomAcl.roleAllows('editor', 'manage'), false)
  assert.strictEqual(roomAcl.roleAllows('owner', 'manage'), true)
  assert.strictEqual(roomAcl.roleAllows(null, 'edit', { legacyOpen: true }), true)
  assert.strictEqual(roomAcl.roleAllows(null, 'manage', { legacyOpen: true }), false)
  assert.strictEqual(roomAcl.roleAllows(null, 'view', { bypass: true }), true)
  assert.strictEqual(roomAcl.roleAllows(null, 'view'), false)
  const restoreHit = roomAcl.inferRoomAcl('/api/files/room-a/versions/v1/restore', 'POST')
  assert.strictEqual(restoreHit.action, 'manage')
  assert.strictEqual(roomAcl.roleAllows('editor', restoreHit.action), false)
  assert.strictEqual(roomAcl.roleAllows('owner', restoreHit.action), true)
  const hideHit = roomAcl.inferRoomAcl('/api/files/room-a/versions/v1/hide', 'POST')
  assert.strictEqual(hideHit.action, 'manage')
  const versionWrite = roomAcl.inferRoomAcl('/api/files/room-a/versions', 'POST')
  assert.strictEqual(versionWrite.action, 'edit')
  assert.strictEqual(roomAcl.roleAllows('viewer', versionWrite.action), false)
  assert.strictEqual(roomAcl.roleAllows('editor', versionWrite.action), true)
  const versionRead = roomAcl.inferRoomAcl('/api/rooms/room-a/versions', 'GET')
  assert.strictEqual(versionRead.action, 'view')
  assert.strictEqual(roomAcl.roleAllows('viewer', versionRead.action), true)
  const writeHit = roomAcl.inferRoomAcl('/api/files/room-a/nodes', 'POST')
  assert.strictEqual(writeHit.action, 'edit')
  assert.strictEqual(roomAcl.roleAllows('viewer', writeHit.action), false)
  assert.strictEqual(roomAcl.roleAllows('editor', writeHit.action), true)
  const deleteHit = roomAcl.inferRoomAcl('/api/files/room-a', 'DELETE')
  assert.strictEqual(roomAcl.roleAllows('editor', deleteHit.action), false)
  assert.strictEqual(roomAcl.roleAllows('owner', deleteHit.action), true)
  const refHit = roomAcl.inferRoomAcl('/api/files/room-b/ref-resolve', 'GET')
  assert.strictEqual(refHit.action, 'view')
  assert.strictEqual(roomAcl.roleAllows(null, refHit.action), false)
  assert.strictEqual(roomAcl.readonlyCommandAllowed('INSERT_NODE'), false)
  assert.strictEqual(roomAcl.readonlyCommandAllowed('SET_NODE_EXPAND'), true)
  assert.strictEqual(
    roomAcl.readonlyCommandAllowed('SET_NODE_DATA', { expand: false }),
    true
  )
  assert.strictEqual(
    roomAcl.readonlyCommandAllowed('SET_NODE_DATA', { text: 'x' }),
    false
  )
}

function memoryDb() {
  const rooms = new Set()
  const tombs = new Set()
  const members = []
  const nodeShares = []
  const findRow = (roomKey, userId) =>
    members.find(item => item.room_key === roomKey && item.user_id === userId)
  const recompute = row => {
    const resolved = roomAcl.resolveMemberRole(row)
    if (resolved) row.role = resolved
    return row
  }
  return {
    rooms,
    tombs,
    members,
    nodeShares,
    async query(sql, params) {
      const text = String(sql)
      if (text.includes('from room_tombstones')) {
        return { rows: tombs.has(params[0]) ? [{}] : [] }
      }
      if (text.includes('from node_shares')) {
        const share = nodeShares.find(
          item =>
            item.id === params[0] &&
            item.room_key === params[1] &&
            item.token_hash === params[2] &&
            !item.revoked_at
        )
        return { rows: share ? [share] : [] }
      }
      if (text.includes('select room_key from rooms')) {
        return { rows: rooms.has(params[0]) ? [{ room_key: params[0] }] : [] }
      }
      if (
        text.includes('from room_members') &&
        text.includes('where room_key') &&
        !text.includes('and user_id') &&
        !text.includes('count(*)')
      ) {
        return {
          rows: members.filter(item => item.room_key === params[0])
        }
      }
      if (text.includes('insert into room_members') && text.includes('on conflict')) {
        const roomKey = params[0]
        const userId = params[1]
        if (text.includes("'override'")) {
          const next = String(params[2] || '').toLowerCase()
          let row = findRow(roomKey, userId)
          if (!row) {
            row = {
              room_key: roomKey,
              user_id: userId,
              role: next,
              direct_role: null,
              team_role: null,
              folder_role: null,
              override_role: next,
              acl_v2: true,
              source: 'override'
            }
            members.push(row)
          } else {
            row.direct_role_archive = row.direct_role_archive || row.direct_role || null
            row.direct_role = null
            row.override_role = next
            row.acl_v2 = true
            row.source = 'override'
            recompute(row)
          }
          return { rows: [row] }
        }
        const role = params[2] || (text.includes("'owner'") ? 'owner' : 'editor')
        const keepExisting = text.includes('role = room_members.role')
        const isTeam = text.includes("'team'")
        const current = findRow(roomKey, userId)
        if (current) {
          if (!keepExisting) current.role = role
          if (isTeam) current.team_role = role
          else current.direct_role = role
          if (text.includes("direct_role = 'owner'")) {
            current.direct_role = 'owner'
            current.override_role = null
            current.acl_v2 = false
            current.role = 'owner'
          } else {
            recompute(current)
          }
        } else {
          members.push({
            room_key: roomKey,
            user_id: userId,
            role,
            direct_role: isTeam ? null : role,
            team_role: isTeam ? role : null,
            folder_role: null
          })
        }
        return { rows: [findRow(roomKey, userId)] }
      }
      if (text.includes("role = 'owner'") && text.includes('select 1')) {
        return {
          rows: members.some(
            item => item.room_key === params[0] && item.role === 'owner'
          )
            ? [{}]
            : []
        }
      }
      if (
        text.includes('update room_members') &&
        text.includes('acl_v2 = true') &&
        text.includes('direct_role_archive')
      ) {
        const row = findRow(params[0], params[1])
        if (row) {
          row.direct_role_archive = row.direct_role_archive || row.direct_role || null
          row.direct_role = null
          row.override_role = null
          row.acl_v2 = true
          recompute(row)
        }
        return { rows: row ? [row] : [] }
      }
      if (text.includes('update room_members') && text.includes('direct_role = null')) {
        const current = findRow(params[0], params[1])
        if (current) {
          current.direct_role = null
          recompute(current)
          current.source = current.team_role
            ? 'team'
            : current.folder_role
              ? 'folder'
              : 'direct_share'
        }
        return { rows: [] }
      }
      if (text.includes('delete from room_members')) {
        const idx = members.findIndex(
          item => item.room_key === params[0] && item.user_id === params[1]
        )
        if (idx >= 0) members.splice(idx, 1)
        return { rows: [] }
      }
      if (text.includes('select user_id') && text.includes('from room_members') && text.includes('and user_id')) {
        return {
          rows: members.filter(
            item => item.room_key === params[0] && item.user_id === params[1]
          )
        }
      }
      if (text.includes("role = 'owner'") && text.includes('count')) {
        return {
          rows: [
            {
              total: members.filter(
                item =>
                  item.room_key === params[0] &&
                  item.role === 'owner' &&
                  (!text.includes('user_id <>') || item.user_id !== params[1])
              ).length
            }
          ]
        }
      }
      throw new Error('unexpected query: ' + text)
    }
  }
}

async function testAccessAndMembers() {
  const db = memoryDb()
  db.rooms.add('room-a')
  await roomAcl.ensureOwner(db, 'room-a', 'wecom:alice')
  const owner = await roomAcl.getAccess(db, 'room-a', 'alice')
  assert.strictEqual(owner.role, 'owner')
  assert.strictEqual(owner.legacyOpen, false)

  const stranger = await roomAcl.getAccess(db, 'room-a', 'bob')
  assert.strictEqual(stranger.role, null)
  assert.strictEqual(
    roomAcl.roleAllows(stranger.role, 'view', { legacyOpen: stranger.legacyOpen }),
    false
  )

  await roomAcl.setMember(db, 'room-a', 'bob', 'editor')
  const editor = await roomAcl.getAccess(db, 'room-a', 'bob')
  assert.strictEqual(editor.role, 'editor')
  assert.strictEqual(roomAcl.roleAllows(editor.role, 'edit'), true)
  assert.strictEqual(roomAcl.roleAllows(editor.role, 'manage'), false)

  await roomAcl.setMember(db, 'room-a', 'carol', 'viewer')
  const viewer = await roomAcl.getAccess(db, 'room-a', 'carol')
  assert.strictEqual(viewer.role, 'viewer')
  assert.strictEqual(roomAcl.roleAllows(viewer.role, 'edit'), false)

  await roomAcl.setMember(db, 'room-a', 'manager', 'Manager', 'alice')
  await roomAcl.setMember(db, 'room-a', 'managed-user', 'editor', 'manager')
  assert.strictEqual((await roomAcl.getAccess(db, 'room-a', 'manager')).role, 'manager')
  await assert.rejects(roomAcl.setMember(db, 'room-a', 'managed-user', 'owner', 'manager'), error => error.code === 'OWNER_REQUIRED')
  await assert.rejects(roomAcl.setMember(db, 'room-a', 'alice', 'viewer', 'manager'), error => error.code === 'OWNER_REQUIRED')
  await assert.rejects(roomAcl.removeMember(db, 'room-a', 'alice', '', 'manager'), error => error.code === 'OWNER_REQUIRED')
  await roomAcl.removeMember(db, 'room-a', 'managed-user', '', 'manager')

  let lastOwnerFailed = false
  try {
    await roomAcl.removeMember(db, 'room-a', 'alice')
  } catch (err) {
    lastOwnerFailed = err.code === 'LAST_OWNER'
  }
  assert.strictEqual(lastOwnerFailed, true)

  let lastOwnerDowngradeFailed = false
  try {
    await roomAcl.setMember(db, 'room-a', 'alice', 'viewer', 'alice')
  } catch (err) {
    lastOwnerDowngradeFailed = err.code === 'LAST_OWNER'
  }
  assert.strictEqual(lastOwnerDowngradeFailed, true)

  await roomAcl.setMember(db, 'room-a', 'carol', 'editor', 'alice')
  const promoted = await roomAcl.getAccess(db, 'room-a', 'carol')
  assert.strictEqual(promoted.role, 'editor')
  await roomAcl.setMember(db, 'room-a', 'carol', 'viewer', 'alice')
  const demoted = await roomAcl.getAccess(db, 'room-a', 'carol')
  assert.strictEqual(demoted.role, 'viewer')

  await roomAcl.setMember(db, 'room-a', 'dave', 'owner')
  await roomAcl.removeMember(db, 'room-a', 'alice')
  const gone = await roomAcl.getAccess(db, 'room-a', 'alice')
  assert.strictEqual(gone.role, null)

  db.rooms.add('legacy')
  const legacy = await roomAcl.getAccess(db, 'legacy', 'anyone')
  assert.strictEqual(legacy.legacyOpen, true)
  assert.strictEqual(
    roomAcl.roleAllows(null, 'edit', { legacyOpen: true }),
    true
  )

  const missing = await roomAcl.getAccess(db, 'nope', 'alice')
  assert.strictEqual(missing.exists, false)
}

async function testMultiSourceGrants() {
  const db = memoryDb()
  db.rooms.add('room-shared')
  await roomAcl.ensureOwner(db, 'room-shared', 'owner')
  await roomAcl.setMember(db, 'room-shared', 'member-1', 'viewer')
  const shared = db.members.find(item => item.user_id === 'member-1')
  shared.team_role = 'editor'
  shared.source = 'direct_share'
  shared.source_team_id = 'team-1'
  shared.role = 'editor'

  await roomAcl.removeMember(db, 'room-shared', 'member-1')
  const afterDirectRemoval = db.members.find(item => item.user_id === 'member-1')
  assert(afterDirectRemoval, 'team grant must keep the ACL row after direct-share removal')
  assert.strictEqual(afterDirectRemoval.direct_role, null)
  assert.strictEqual(afterDirectRemoval.team_role, 'editor')
  assert.strictEqual(afterDirectRemoval.role, 'editor')
  assert.strictEqual((await roomAcl.getAccess(db, 'room-shared', 'member-1')).role, 'editor')
}

async function testSearchUsersPassesCorpId() {
  let captured = null
  const db = {
    query: async (sql, params) => {
      captured = { sql, params }
      return { rows: [{ user_id: 'u1', wecom_userid: 'u1', name: '龙', avatar: '' }] }
    }
  }
  const rows = await roomAcl.searchUsers(db, '龙', 8, 'corp-demo')
  assert.strictEqual(rows.length, 1)
  assert.ok(captured.sql.includes('corp_id = $3'))
  assert.deepStrictEqual(captured.params, ['%龙%', 8, 'corp-demo'])
}

async function testFolderRoleSource() {
  const db = memoryDb()
  db.rooms.add('room-folder')
  await roomAcl.ensureOwner(db, 'room-folder', 'owner')
  await roomAcl.setMember(db, 'room-folder', 'bob', 'viewer')
  await roomAcl.setFolderRole(db, 'room-folder', 'bob', 'editor', 'folder-1')
  const bob = db.members.find(item => item.user_id === 'bob')
  assert.strictEqual(bob.acl_v2, true)
  assert.strictEqual(bob.override_role, 'viewer')
  assert.strictEqual(bob.direct_role, null)
  assert.strictEqual(bob.folder_role, 'editor')
  assert.strictEqual(bob.role, 'viewer')
  assert.strictEqual((await roomAcl.getAccess(db, 'room-folder', 'bob')).role, 'viewer')

  await roomAcl.clearFolderRole(db, 'room-folder', 'bob')
  const afterClear = db.members.find(item => item.user_id === 'bob')
  assert.strictEqual(afterClear.folder_role, null)
  assert.strictEqual(afterClear.override_role, 'viewer')
  assert.strictEqual(afterClear.role, 'viewer')

  await roomAcl.setFolderRole(db, 'room-folder', 'carol', 'viewer', 'folder-1')
  await roomAcl.clearFolderRole(db, 'room-folder', 'carol')
  assert.strictEqual(
    db.members.find(item => item.user_id === 'carol'),
    undefined
  )

  await roomAcl.setFolderRole(db, 'room-folder', 'dave', 'manager', 'folder-1')
  const daveHasFolder = db.members.find(item => item.user_id === 'dave')
  assert.strictEqual(daveHasFolder.folder_role, 'manager')
  assert.strictEqual(daveHasFolder.role, 'editor')
  await roomAcl.clearRoomFolderRoles(db, 'room-folder')
  assert.strictEqual(
    db.members.find(item => item.user_id === 'dave'),
    undefined
  )
  assert.strictEqual(
    (await roomAcl.getAccess(db, 'room-folder', 'bob')).role,
    'viewer'
  )
}

async function testClearRoomFolderRolesSqlOrder() {
  const calls = []
  await roomAcl.clearRoomFolderRoles({
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [] }
    }
  }, 'room-folder')
  assert.strictEqual(calls.length, 2)
  assert.match(calls[0].sql, /delete from room_members/)
  assert.match(calls[0].sql, /folder_role is not null/)
  assert.match(calls[0].sql, /direct_role is null/)
  assert.match(calls[0].sql, /team_role is null/)
  assert.match(calls[1].sql, /update room_members/)
  assert.match(calls[1].sql, /direct_role is not null or team_role is not null/)
  calls.forEach(call => assert.deepStrictEqual(call.params, ['room-folder']))
}

function testResolveMemberRoleMatrix() {
  // Per-file viewer lowers a folder/team editor grant.
  assert.strictEqual(
    roomAcl.resolveMemberRole({ acl_v2: true, override_role: 'viewer', folder_role: 'editor', team_role: 'editor', role: 'editor' }),
    'viewer'
  )
  // Per-file editor raises a folder/team viewer grant.
  assert.strictEqual(
    roomAcl.resolveMemberRole({ acl_v2: true, override_role: 'editor', folder_role: 'viewer', team_role: 'viewer' }),
    'editor'
  )
  // Follow inheritance keeps the existing default merge unchanged.
  assert.strictEqual(
    roomAcl.resolveMemberRole({ acl_v2: true, override_role: null, folder_role: 'viewer', team_role: 'editor' }),
    'editor'
  )
  assert.strictEqual(
    roomAcl.resolveMemberRole({ acl_v2: true, override_role: null, folder_role: 'editor' }),
    'editor'
  )
  assert.strictEqual(
    roomAcl.resolveMemberRole({ acl_v2: true, override_role: null }),
    ''
  )
  // Pre-migration rows keep the historical max() merge.
  assert.strictEqual(
    roomAcl.resolveMemberRole({ direct_role: 'viewer', folder_role: 'editor', role: 'editor' }),
    'editor'
  )
  assert.strictEqual(
    roomAcl.resolveMemberRole({ direct_role: 'editor', team_role: 'viewer', role: 'editor' }),
    'editor'
  )
  // The summary column is a derived result and never raises the role again.
  assert.strictEqual(
    roomAcl.resolveMemberRole({ direct_role: 'viewer', role: 'editor' }),
    'viewer'
  )
  // Owner identity always wins.
  assert.strictEqual(
    roomAcl.resolveMemberRole({ direct_role: 'owner', acl_v2: true, override_role: 'viewer' }),
    'owner'
  )
  // SQL mirror carries the same distinct columns and no removed states.
  const sql = roomAcl.sqlResolveMemberRole(
    'direct_role', 'team_role', 'folder_role', 'role', 'override_role', 'acl_v2'
  )
  assert.match(sql, /acl_v2/)
  assert.match(sql, /override_role/)
  assert.ok(!sql.includes('denied'))
}

async function testPerFileOverrideModel() {
  const db = memoryDb()
  db.rooms.add('room-x')
  await roomAcl.ensureOwner(db, 'room-x', 'owner')

  // Folder editor + per-file viewer → the member stays viewer (reported bug).
  await roomAcl.setFolderRole(db, 'room-x', 'bob', 'editor', 'folder-1')
  assert.strictEqual((await roomAcl.getAccess(db, 'room-x', 'bob')).role, 'editor')
  await roomAcl.setMember(db, 'room-x', 'bob', 'viewer', 'owner')
  let bob = db.members.find(item => item.user_id === 'bob')
  assert.strictEqual(bob.acl_v2, true)
  assert.strictEqual(bob.override_role, 'viewer')
  assert.strictEqual(bob.folder_role, 'editor')
  assert.strictEqual(bob.role, 'viewer')
  let access = await roomAcl.getAccess(db, 'room-x', 'bob')
  assert.strictEqual(access.role, 'viewer')
  assert.strictEqual(access.overrideActive, true)
  assert.strictEqual(access.source, 'override')

  // Folder permission changes do not override the per-file setting.
  await roomAcl.setFolderRole(db, 'room-x', 'bob', 'manager', 'folder-1')
  assert.strictEqual((await roomAcl.getAccess(db, 'room-x', 'bob')).role, 'viewer')

  // Restoring inheritance adopts the current folder result.
  await roomAcl.setMember(db, 'room-x', 'bob', 'inherit', 'owner')
  bob = db.members.find(item => item.user_id === 'bob')
  assert.strictEqual(bob.override_role, null)
  assert.strictEqual(bob.acl_v2, true)
  assert.strictEqual(bob.folder_role, 'manager')
  assert.strictEqual((await roomAcl.getAccess(db, 'room-x', 'bob')).role, 'editor')

  // Folder viewer + per-file editor → editor.
  await roomAcl.setFolderRole(db, 'room-x', 'carol', 'viewer', 'folder-1')
  await roomAcl.setMember(db, 'room-x', 'carol', 'editor', 'owner')
  access = await roomAcl.getAccess(db, 'room-x', 'carol')
  assert.strictEqual(access.role, 'editor')
  assert.strictEqual(access.overrideActive, true)

  // Removing the per-file setting drops back to the inherited result.
  await roomAcl.removeMember(db, 'room-x', 'carol', '', 'owner')
  access = await roomAcl.getAccess(db, 'room-x', 'carol')
  assert.strictEqual(access.role, 'viewer')
  assert.strictEqual(access.overrideActive, false)

  // One member's setting does not leak to other members.
  assert.strictEqual(
    (await roomAcl.getAccess(db, 'room-x', 'owner')).role,
    'owner'
  )
}

async function testLegacyRowConvertsOnEdit() {
  const db = memoryDb()
  db.rooms.add('room-legacy')
  await roomAcl.ensureOwner(db, 'room-legacy', 'owner')
  await roomAcl.setFolderRole(db, 'room-legacy', 'bob', 'editor', 'folder-1')
  // Simulate a pre-migration direct grant that was raised by the folder.
  const row = db.members.find(item => item.user_id === 'bob')
  row.direct_role = 'viewer'
  row.role = 'editor'
  assert.strictEqual((await roomAcl.getAccess(db, 'room-legacy', 'bob')).role, 'editor')

  // The first explicit edit through the new UI takes over with new semantics.
  await roomAcl.setMember(db, 'room-legacy', 'bob', 'viewer', 'owner')
  const updated = db.members.find(item => item.user_id === 'bob')
  assert.strictEqual(updated.acl_v2, true)
  assert.strictEqual(updated.override_role, 'viewer')
  assert.strictEqual(updated.direct_role, null)
  assert.strictEqual(updated.direct_role_archive, 'viewer')
  assert.strictEqual((await roomAcl.getAccess(db, 'room-legacy', 'bob')).role, 'viewer')
}

async function testShareCannotRaiseOverride() {
  const crypto = require('crypto')
  const db = memoryDb()
  db.rooms.add('room-share')
  await roomAcl.ensureOwner(db, 'room-share', 'owner')
  await roomAcl.setFolderRole(db, 'room-share', 'bob', 'viewer', 'folder-1')
  await roomAcl.setMember(db, 'room-share', 'bob', 'viewer', 'owner')
  await roomAcl.setFolderRole(db, 'room-share', 'carol', 'viewer', 'folder-1')

  const token = 'share-token-abcdefghijklmnopqrstuvwxyz123456'
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  const shareId = '11111111-2222-4333-8444-555555555555'
  const cookie =
    roomAcl.nodeShareCookieName('room-share') +
    '=' +
    encodeURIComponent(`${shareId}.${token}`)
  db.nodeShares.push({
    id: shareId,
    room_key: 'room-share',
    role: 'editor',
    token_hash: tokenHash,
    recipient_user_id: null,
    recipient_user_ids: ['bob', 'carol'],
    expires_at: null,
    revoked_at: null
  })

  // A member with an explicit per-file viewer stays viewer even when an
  // editor share link points at the same account (acceptance scenario 8).
  const bobReq = { authUser: { id: 'bob' }, forceAcl: true, headers: { cookie } }
  await assert.rejects(
    roomAcl.assertRoomAccess(db, bobReq, 'room-share', 'edit'),
    error => error.statusCode === 403
  )
  const bobView = await roomAcl.assertRoomAccess(db, bobReq, 'room-share', 'view')
  assert.strictEqual(bobView.role, 'viewer')
  assert.strictEqual(bobView.canEdit, false)

  // Members without a per-file setting keep the historical share behaviour.
  const carolReq = { authUser: { id: 'carol' }, forceAcl: true, headers: { cookie } }
  const carolEdit = await roomAcl.assertRoomAccess(db, carolReq, 'room-share', 'edit')
  assert.strictEqual(carolEdit.canEdit, true)
  assert.strictEqual(carolEdit.shareId, shareId)
}

function testSuperAdminActor() {
  const prev = process.env.MIND_MAP_SUPER_ADMIN_IDS
  process.env.MIND_MAP_SUPER_ADMIN_IDS = 'alice, wecom:bob'
  try {
    assert.deepStrictEqual(roomAcl.parseSuperAdminIds(), ['alice', 'bob'])
    assert.strictEqual(
      roomAcl.isSuperAdminUser({ id: 'alice', wecomUserId: 'alice' }),
      true
    )
    assert.strictEqual(
      roomAcl.isSuperAdminUser({ id: 'carol', wecomUserId: 'bob' }),
      true
    )
    assert.strictEqual(
      roomAcl.isSuperAdminUser({ id: 'dave', wecomUserId: 'dave' }),
      false
    )
    const actor = roomAcl.actorFromReq({
      authUser: { id: 'alice', wecomUserId: 'alice', name: 'Alice' }
    })
    // Auth may be disabled in unit tests → bypass already true; still mark superAdmin.
    assert.strictEqual(actor.superAdmin, true)
    assert.strictEqual(actor.bypass, true)
    assert.strictEqual(actor.id, 'alice')
  } finally {
    if (prev === undefined) delete process.env.MIND_MAP_SUPER_ADMIN_IDS
    else process.env.MIND_MAP_SUPER_ADMIN_IDS = prev
  }
}

testNormalizeAndInfer()
testRoleMatrix()
testSuperAdminActor()
testResolveMemberRoleMatrix()
testAccessAndMembers()
  .then(testMultiSourceGrants)
  .then(testFolderRoleSource)
  .then(testClearRoomFolderRolesSqlOrder)
  .then(testSearchUsersPassesCorpId)
  .then(testPerFileOverrideModel)
  .then(testLegacyRowConvertsOnEdit)
  .then(testShareCannotRaiseOverride)
  .then(() => {
    console.log('roomAcl tests passed')
  })
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
