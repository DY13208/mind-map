const assert = require('assert')
const roomAcl = require('../bin/roomAcl')

function testNormalizeAndInfer() {
  assert.strictEqual(roomAcl.normalizeUserId('wecom:zhangsan'), 'zhangsan')
  assert.strictEqual(roomAcl.normalizeRole('Owner'), 'owner')
  assert.strictEqual(roomAcl.normalizeRole('guest'), '')

  assert.deepStrictEqual(
    roomAcl.inferRoomAcl('/api/files/room-a/preview', 'GET'),
    { roomKey: 'room-a', action: 'view' }
  )
  assert.deepStrictEqual(
    roomAcl.inferRoomAcl('/api/files/room-a/nodes/n1', 'PATCH'),
    { roomKey: 'room-a', action: 'edit' }
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
  assert.strictEqual(roomAcl.roleAllows('viewer', 'edit'), false)
  assert.strictEqual(roomAcl.roleAllows('editor', 'edit'), true)
  assert.strictEqual(
    roomAcl.presenceDocRoomKey('room-a__presence'),
    'room-a'
  )
}

function testRoleMatrix() {
  assert.strictEqual(roomAcl.roleAllows('viewer', 'view'), true)
  assert.strictEqual(roomAcl.roleAllows('viewer', 'edit'), false)
  assert.strictEqual(roomAcl.roleAllows('viewer', 'manage'), false)
  assert.strictEqual(roomAcl.roleAllows('editor', 'edit'), true)
  assert.strictEqual(roomAcl.roleAllows('editor', 'manage'), false)
  assert.strictEqual(roomAcl.roleAllows('owner', 'manage'), true)
  assert.strictEqual(roomAcl.roleAllows(null, 'edit', { legacyOpen: true }), true)
  assert.strictEqual(roomAcl.roleAllows(null, 'view', { bypass: true }), true)
  assert.strictEqual(roomAcl.roleAllows(null, 'view'), false)
  const restoreHit = roomAcl.inferRoomAcl('/api/files/room-a/versions/v1/restore', 'POST')
  assert.strictEqual(restoreHit.action, 'manage')
  assert.strictEqual(roomAcl.roleAllows('editor', restoreHit.action), false)
  assert.strictEqual(roomAcl.roleAllows('owner', restoreHit.action), true)
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
  return {
    rooms,
    tombs,
    members,
    async query(sql, params) {
      const text = String(sql)
      if (text.includes('from room_tombstones')) {
        return { rows: tombs.has(params[0]) ? [{}] : [] }
      }
      if (text.includes('select room_key from rooms')) {
        return { rows: rooms.has(params[0]) ? [{ room_key: params[0] }] : [] }
      }
      if (text.includes('select user_id, role from room_members where room_key')) {
        return {
          rows: members.filter(item => item.room_key === params[0])
        }
      }
      if (text.includes('insert into room_members') && text.includes('on conflict')) {
        const roomKey = params[0]
        const userId = params[1]
        const role =
          params[2] || (text.includes("'owner'") ? 'owner' : 'editor')
        const keepExisting = text.includes('role = room_members.role')
        const current = members.find(
          item => item.room_key === roomKey && item.user_id === userId
        )
        if (current) {
          if (!keepExisting) current.role = role
        } else {
          members.push({ room_key: roomKey, user_id: userId, role })
        }
        const row = members.find(
          item => item.room_key === roomKey && item.user_id === userId
        )
        return { rows: [row] }
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
      if (text.includes('delete from room_members')) {
        const idx = members.findIndex(
          item => item.room_key === params[0] && item.user_id === params[1]
        )
        if (idx >= 0) members.splice(idx, 1)
        return { rows: [] }
      }
      if (text.includes('select user_id, role from room_members') && text.includes('and user_id')) {
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
                item => item.room_key === params[0] && item.role === 'owner'
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

testNormalizeAndInfer()
testRoleMatrix()
testAccessAndMembers()
  .then(() => {
    console.log('roomAcl tests passed')
  })
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
