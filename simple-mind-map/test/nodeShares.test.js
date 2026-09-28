const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const { assertOperationScope, shareRecipients, requestedRecipients, canManageShare } = require('../bin/nodeShares')
const roomAcl = require('../bin/roomAcl')

function fakeClient() {
  return {
    async query(sql) {
      if (sql.includes('from node_shares')) {
        return { rows: [{ role: 'editor', recipient_user_id: 'recipient', recipient_user_ids: ['recipient', 'second'], created_by: 'creator' }] }
      }
      if (sql.includes('with recursive branch')) {
        return { rows: ['root', 'child', 'grandchild'].map(uid => ({ uid })) }
      }
      throw new Error('unexpected query')
    }
  }
}

const share = { id: 'share-id', room_key: 'room-test', root_uid: 'root' }
const operation = (type, payload) => ({ type, payload, userId: 'recipient' })

test('shared editor may update nodes and add children inside the branch', async () => {
  await assert.doesNotReject(assertOperationScope(fakeClient(), share, operation('node.update', { uid: 'child', patch: { text: 'ok' } })))
  await assert.doesNotReject(assertOperationScope(fakeClient(), share, operation('node.insert', { parentUid: 'child', uid: 'new' })))
  await assert.doesNotReject(assertOperationScope(fakeClient(), share, { ...operation('node.update', { uid: 'child' }), userId: 'second' }))
  await assert.rejects(assertOperationScope(fakeClient(), share, { ...operation('node.update', { uid: 'child' }), userId: 'outsider' }), { code: 'FORBIDDEN' })
})

test('recipient lists deduplicate ids and preserve legacy single-recipient links', () => {
  assert.deepEqual(requestedRecipients({ recipientUserIds: ['first', 'second', 'first', ' '] }), ['first', 'second'])
  assert.deepEqual(shareRecipients({ recipient_user_id: 'legacy', recipient_user_ids: null }), ['legacy'])
  assert.deepEqual(shareRecipients({ recipient_user_id: 'first', recipient_user_ids: ['first', 'second'] }), ['first', 'second'])
  assert.throws(() => requestedRecipients({ recipientUserIds: Array(51).fill('person') }), { code: 'BAD_RECIPIENTS' })
})

test('editors manage their own shares; owners manage all shares', () => {
  const share = { created_by: 'creator' }
  assert.equal(canManageShare({ canManage: false }, share, 'creator'), true)
  assert.equal(canManageShare({ canManage: false }, share, 'other-editor'), false)
  assert.equal(canManageShare({ canManage: true }, share, 'owner'), true)
})

test('share creator can edit only while their room editing access was verified', async () => {
  const creatorOp = { ...operation('node.update', { uid: 'child', patch: { text: 'ok' } }), userId: 'creator' }
  await assert.doesNotReject(assertOperationScope(fakeClient(), { ...share, created_by: 'creator', creatorCanEdit: true }, creatorOp))
  await assert.rejects(assertOperationScope(fakeClient(), { ...share, created_by: 'creator' }, creatorOp), { code: 'FORBIDDEN' })
})

test('shared editor cannot reach outside or delete the shared root', async () => {
  for (const op of [
    operation('node.update', { uid: 'sibling', patch: { text: 'no' } }),
    operation('node.insert', { parentUid: 'sibling', uid: 'new' }),
    operation('node.move', { uid: 'child', parentUid: 'sibling' }),
    operation('node.move', { uid: 'child' }),
    operation('node.update', { uid: 'child', parentUid: 'sibling' }),
    operation('node.delete', { uid: 'root' }),
    operation('map.replace', { nodes: {} })
  ]) {
    await assert.rejects(assertOperationScope(fakeClient(), share, op), { code: 'OUT_OF_SCOPE' })
  }
})

test('permission changes stop a pending edit before commit', async () => {
  const client = fakeClient()
  client.query = async () => ({ rows: [{ role: 'viewer', recipient_user_id: 'recipient' }] })
  await assert.rejects(assertOperationScope(client, share, operation('node.update', { uid: 'child' })), { code: 'FORBIDDEN' })
})

test('a valid share link grants full-room view or edit only to its recipients', async () => {
  const id = '8207e21b-6cd2-4b52-8107-66c25312bcf5'
  const token = 'test_share_token_with_enough_length_123'
  const cookie = `${roomAcl.nodeShareCookieName('room-test')}=${id}.${token}`
  const hash = crypto.createHash('sha256').update(token).digest('hex')
  let active = true
  let role = 'viewer'
  const db = {
    async query(sql, params) {
      if (sql.includes('from room_tombstones')) return { rows: [] }
      if (sql.includes('from rooms')) return { rows: [{ room_key: 'room-test' }] }
      if (sql.includes('from room_members')) return { rows: [{ user_id: 'owner', role: 'owner' }] }
      if (sql.includes('from node_shares')) {
        return { rows: active && params[2] === hash
          ? [{ id, role, recipient_user_ids: ['recipient'] }]
          : [] }
      }
      throw new Error(`Unexpected query: ${sql}`)
    }
  }
  const req = userId => ({ authUser: { id: userId }, forceAcl: true, headers: { cookie } })
  assert.equal((await roomAcl.assertRoomAccess(db, req('recipient'), 'room-test', 'view')).shareId, id)
  await assert.rejects(roomAcl.assertRoomAccess(db, req('recipient'), 'room-test', 'edit'), { code: 'FORBIDDEN' })
  role = 'editor'
  assert.equal((await roomAcl.assertRoomAccess(db, req('recipient'), 'room-test', 'edit')).canEdit, true)
  await assert.rejects(roomAcl.assertRoomAccess(db, req('outsider'), 'room-test', 'view'), { code: 'FORBIDDEN' })
  active = false
  await assert.rejects(roomAcl.assertRoomAccess(db, req('recipient'), 'room-test', 'view'), { code: 'FORBIDDEN' })
})
