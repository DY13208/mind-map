'use strict'
// Owned acceptance databases only. Never reads the repository .env.
const assert = require('node:assert/strict')
const path = require('node:path')
assert.equal(process.env.MIND_MAP_SKIP_ROOT_ENV, '1')
assert.equal(process.env.PGHOST, '127.0.0.1')
assert.match(process.env.PGDATABASE || '', /^mcp_guards_test_[a-f0-9]{12}$/)
const storage = require('../simple-mind-map/bin/storage')
process.once('message', async message => {
  try {
    assert.match(message.roomKey, /^mcp-guards-[a-f0-9]{12}$/)
    const nodes = { root: { isRoot: true, data: { uid: 'root', text: '协同保护验收', expand: true }, children: [] } }
    let count = 1
    for (let b = 0; b < 100; b++) {
      const uid = 'branch-' + b
      nodes.root.children.push(uid)
      nodes[uid] = { data: { uid, text: '分支 ' + b, expand: false }, children: [] }
      count++
      for (let n = 0; n < 99 && count < 10000; n++, count++) {
        const child = `${uid}-leaf-${n}`
        nodes[uid].children.push(child)
        nodes[child] = { data: { uid: child, text: '节点 ' + b + '/' + n }, children: [] }
      }
    }
    assert.equal(Object.keys(nodes).length, 10000)
    await storage.upsertRoom(message.roomKey, 'MCP 协同保护隔离验收', { nodes, allowFullTree: true })
    const pool = storage.getPool()
    for (let i = 0; i < message.userIds.length; i++) {
      const role = i ? 'editor' : 'owner'
      await pool.query('insert into room_members(room_key,user_id,role,direct_role,source) values($1,$2,$3,$3,\'direct_share\')', [message.roomKey, message.userIds[i], role])
    }
    const actual = await pool.query('select count(*)::int as n from room_nodes where room_key=$1 and deleted_at is null', [message.roomKey])
    assert.equal(actual.rows[0].n, 10000)
    process.send({ ok: true, nodes: actual.rows[0].n })
    await pool.end()
  } catch (error) {
    if (process.send) process.send({ error: error.message })
    process.exitCode = 1
  } finally { if (process.connected) process.disconnect() }
})
