'use strict'

// Real PostgreSQL, temporary tables only; never load the repository .env.
process.env.MIND_MAP_SKIP_ROOT_ENV = '1'
const assert = require('node:assert/strict')
const { Client } = require('../simple-mind-map/node_modules/pg')
const { replaceRoomNodes } = require('../simple-mind-map/bin/roomNodes')
const { readSubtreeRows, subtreeToken } = require('../simple-mind-map/bin/subtreeToken')

async function main() {
  const client = new Client({ host: '127.0.0.1', port: 25492, database: 'mcp_incremental_test',
    user: 'mcp_test', password: 'mcp-incremental-test-db-password' })
  await client.connect()
  try {
    await client.query(`create temporary table room_nodes (
      room_key text, uid text, parent_uid text, position text, data jsonb,
      is_root boolean, node_version bigint, deleted_at timestamptz, updated_at timestamptz,
      primary key(room_key,uid)
    )`)
    await client.query('create unique index room_nodes_one_root_idx on room_nodes(room_key) where is_root and deleted_at is null')
    const room = 'temporary-token-regression'
    const graph = {
      root: { isRoot: true, data: { text: 'Root' }, children: ['a', 'b'], position: 'a0' },
      a: { data: { text: 'A' }, children: [], position: 'a1' },
      b: { data: { text: 'B' }, children: ['leaf'], position: 'a2' },
      leaf: { data: { text: 'Leaf' }, children: [], position: 'a0' }
    }
    const token = async uid => subtreeToken(await readSubtreeRows(client, room, uid))
    const rows = async () => (await client.query('select uid,node_version::int as version from room_nodes where room_key=$1 and deleted_at is null order by uid', [room])).rows
    await replaceRoomNodes(client, room, graph, 1)
    const original = await rows(), originalB = await token('b')
    await replaceRoomNodes(client, room, graph, 2)
    assert.deepEqual(await rows(), original, 'identical full write must preserve every node version, including the root')
    delete graph.a
    graph.root.children = ['b']
    await replaceRoomNodes(client, room, graph, 3)
    assert.equal(await token('b'), originalB, 'deleting sibling A must preserve the original B subtree token')
    assert.equal((await client.query('select deleted_at is not null as deleted from room_nodes where uid=\'a\'')).rows[0].deleted, true)
    graph.leaf.data.text = 'Changed leaf'
    await replaceRoomNodes(client, room, graph, 4)
    assert.notEqual(await token('b'), originalB, 'editing a descendant must invalidate the B token')
    assert.equal((await rows()).find(row => row.uid === 'leaf').version, 4)
    const beforeMove = await token('leaf')
    graph.b.children = []
    graph.root.children.push('leaf')
    await replaceRoomNodes(client, room, graph, 5)
    assert.notEqual(await token('leaf'), beforeMove, 'moving the subtree must invalidate its token')
    // Explicit restore revives tombstones and must establish a new version.
    graph.a = { data: { text: 'A' }, children: [], position: 'a1' }
    graph.root.children.push('a')
    await replaceRoomNodes(client, room, graph, 6, { allowRestore: true })
    assert.equal((await rows()).find(row => row.uid === 'a').version, 6)
    // Changing root UID must still respect the partial unique root index.
    graph.root.isRoot = false
    graph.root.children = graph.root.children.filter(uid => uid !== 'b')
    graph.b.isRoot = true
    graph.b.children = ['root']
    await replaceRoomNodes(client, room, graph, 7)
    assert.deepEqual((await client.query('select uid from room_nodes where is_root and deleted_at is null')).rows, [{ uid: 'b' }])
    console.log('PASS PostgreSQL full writes preserve unchanged versions; sibling tokens survive deletion; descendant edits/moves invalidate tokens; restore and root replacement work')
  } finally { await client.end() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
