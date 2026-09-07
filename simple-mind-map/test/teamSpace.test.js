const assert = require('assert')
const teamSpace = require('../bin/teamSpace')
const auth = require('../bin/auth')
const { createFileSystem, createMemoryFileStore } = require('../bin/fileSystem')

function dbForTeam(allowedCorp = 'corp-a') {
  const calls = []
  const roomMembers = []
  return {
    calls,
    roomMembers,
    async query(sql, params) {
      const text = String(sql)
      calls.push({ text, params })
      if (text.includes('from teams t')) {
        if (params[0] !== allowedCorp) return { rows: [] }
        return {
          rows: [{
            id: params[1], corp_id: params[0], name: '研发空间', description: '',
            source_type: 'custom', owner_id: 'alice', role: 'owner',
            member_count: 1, file_count: 1
          }]
        }
      }
      if (text.includes('from wecom_users where corp_id')) {
        return { rows: [{ user_id: 'bob', wecom_userid: 'bob' }] }
      }
      if (text.includes('from team_members tm')) {
        return { rows: [{ user_id: 'alice', role: 'owner', joined_at: new Date(), name: 'Alice', avatar: '', departments: [] }] }
      }
      if (text.includes('update room_members') && text.includes('team_role = null')) {
        roomMembers.forEach(row => {
          if (row.source_team_id === params[0] && row.user_id === params[1] && row.direct_role) {
            row.team_role = null
            row.role = row.direct_role
            row.source = 'direct_share'
            row.source_team_id = null
          }
        })
        return { rows: [] }
      }
      if (text.includes('delete from room_members')) {
        for (let i = roomMembers.length - 1; i >= 0; i--) {
          if (roomMembers[i].source_team_id === params[0] && roomMembers[i].user_id === params[1] && !roomMembers[i].direct_role) roomMembers.splice(i, 1)
        }
        return { rows: [] }
      }
      if (text.includes('delete from team_members')) return { rows: [{ user_id: params[2] }] }
      if (text.includes('insert into teams')) {
        return { rows: [{ id: params[0], corp_id: params[1], name: params[2], description: params[3], source_type: 'custom', owner_id: params[4] }] }
      }
      return { rows: [] }
    }
  }
}

assert.deepStrictEqual(
  teamSpace.identity({ authUser: { id: 'alice', corpId: 'corp-a' } }),
  { userId: 'alice', corpId: 'corp-a', wecomUserId: 'alice' }
)
assert.throws(
  () => teamSpace.identity({ authUser: { id: 'alice', corpId: 'corp-a', service: true } }),
  err => err.code === 'unauthorized'
)
assert.notStrictEqual(
  auth.__test.collisionInternalUserId('corp-a', 'same-user'),
  auth.__test.collisionInternalUserId('corp-b', 'same-user')
)

;(async () => {
  const db = dbForTeam()
  const who = { userId: 'alice', corpId: 'corp-a' }
  const created = await teamSpace.createTeam(db, who, { name: '研发空间' })
  assert.strictEqual(created.role, 'owner')
  assert.strictEqual(created.sourceType, 'CUSTOM_TEAM')
  assert.strictEqual(db.calls[0].params[1], 'corp-a')

  const members = await teamSpace.addMembers(db, who, created.id, ['bob'])
  assert.strictEqual(members[0].role, 'owner')
  const sync = db.calls.find(call => call.text.includes("insert into room_members") && call.text.includes("'team'"))
  assert(sync, 'adding a Team member must persist a Team room ACL source')

  db.roomMembers.push({
    room_key: 'room-a', user_id: 'bob', direct_role: 'viewer', team_role: 'editor',
    role: 'editor', source: 'direct_share', source_team_id: created.id
  })
  const removed = await teamSpace.removeMember(db, who, created.id, 'bob')
  assert.deepStrictEqual(removed, { ok: true, userId: 'bob' })
  const cleanup = db.calls.find(call => call.text.includes('delete from room_members'))
  assert(cleanup.text.includes('source_team_id'))
  assert(cleanup.text.includes('direct_role is null'))
  assert.deepStrictEqual(db.roomMembers, [{
    room_key: 'room-a', user_id: 'bob', direct_role: 'viewer', team_role: null,
    role: 'viewer', source: 'direct_share', source_team_id: null
  }])

  await assert.rejects(
    teamSpace.getTeam(db, 'corp-b', created.id, 'alice'),
    err => err.statusCode === 404 && err.code === 'TEAM_NOT_FOUND'
  )
  const crossCorpQuery = db.calls.find(call => call.text.includes('from teams t') && call.params[0] === 'corp-b')
  assert(crossCorpQuery, 'cross-corp lookup must bind the current corp_id')

  const store = createMemoryFileStore()
  const fs = createFileSystem({ store })
  const insertMember = store.insertMember.bind(store)
  store.insertMember = async row => {
    if (row.source === 'team') throw new Error('模拟 ACL 写入失败')
    return insertMember(row)
  }
  await assert.rejects(
    fs.createRoom({ title: '事务回滚', userId: 'alice', teamId: created.id, teamMembers: [{ userId: 'bob' }] }),
    /ACL 写入失败/
  )
  assert.strictEqual(store.rooms.size, 0)
  assert.strictEqual(store.nodes.size, 0)
  assert.strictEqual(store.members.length, 0)
  console.log('teamSpace tests passed')
})().catch(err => {
  console.error(err)
  process.exit(1)
})
