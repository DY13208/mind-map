'use strict'
const assert = require('node:assert/strict')
module.exports = async ({ call, query, state, converge, roomKey, check, compatMode }) => {
  const add = async (text, parent = 'root') => {
    const result = await call('add_node', { room_key: roomKey, parent, text })
    assert.equal(result.toolError, false, JSON.stringify(result))
    assert.ok(result.uid, JSON.stringify(result))
    return result.uid
  }
  const read = async uid => {
    const result = await query(uid, true)
    assert.equal(result.toolError, false, JSON.stringify(result))
    return { uid, subtree_token: result.items[0].subtree_token || result.subtree_token }
  }
  const remove = expected => call('delete_node', { room_key: roomKey, node: expected.uid, expected })
  await check('original sibling B token remains usable after guarded deletion of A', async () => {
    const aUid = await add('token-a'), bUid = await add('token-b')
    await add('token-b-leaf', bUid)
    const a = await read(aUid), b = await read(bUid)
    const before = Number(await state())
    assert.equal((await remove(a)).toolError, false)
    assert.deepEqual(await read(bUid), b, 'unrelated deletion must not change the token')
    const deleted = await remove(b)
    assert.equal(deleted.toolError, false, JSON.stringify(deleted))
    assert.equal(Number(await state()), before + 2)
    await converge(await state())
    return { mode: compatMode ? 'compatibility' : 'Direct', reusedOriginalToken: true }
  })
  await check('changed descendant rejects old delete token without advancing revision', async () => {
    const cUid = await add('token-c'), leafUid = await add('token-c-leaf', cUid)
    const stale = await read(cUid)
    const leaf = (await query(leafUid)).items[0]
    const updated = await call('update_node', { room_key: roomKey, node: leaf.uid, text: 'changed descendant',
      expected: { uid: leaf.uid, '__fv.text': leaf.data.__fv?.text || 0 } })
    assert.equal(updated.toolError, false, JSON.stringify(updated))
    const before = Number(await state()), rejected = await remove(stale)
    assert.equal(rejected.toolError, true, JSON.stringify(rejected))
    assert.ok(JSON.stringify(rejected).includes('REPLACE_CONFLICT'), JSON.stringify(rejected))
    assert.equal(Number(await state()), before)
    assert.equal((await query(leafUid)).items[0].data.text, 'changed descendant')
    await converge(await state())
  })
}
