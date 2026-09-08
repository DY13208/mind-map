const assert = require('assert')
const crypto = require('crypto')
const storage = require('../bin/storage')

async function expectCode(run, code) {
  await assert.rejects(run, err => err && err.code === code)
}

async function main() {
  await storage.initSchema()
  const pool = storage.getPool()
  const roomKey = `node-query-${crypto.randomUUID()}`
  try {
    await pool.query(
      `insert into rooms(room_key, title, cos_key, version)
       values ($1, 'node query test', $2, 1)`,
      [roomKey, `test/${roomKey}.json`]
    )
    const rows = [
      ['root', null, 'a0', {
        uid: 'root',
        text: '<p>根&nbsp;节点</p>',
        imgMap: { original: 'data:image/png;base64,not-for-mcp' },
        image: 'data:image/png;base64,not-for-mcp'
      }, true],
      ['wide', 'root', 'a0', { uid: 'wide', text: '无关分支' }, false],
      ['wide-leaf', 'wide', 'a0', { uid: 'wide-leaf', text: '无关叶子' }, false],
      ['target', 'root', 'a1', { uid: 'target', text: '<span>目标</span>' }, false],
      ['detail', 'target', 'a0', {
        uid: 'detail', text: '详细信息', note: '只属于目标分支',
        image: 'https://example.invalid/detail.png', imageTitle: '详情图', imageSize: { width: 20, height: 10 }
      }, false],
      ['copy-a', 'root', 'a2', { uid: 'copy-a', text: '重复节点' }, false],
      ['copy-b', 'root', 'a3', { uid: 'copy-b', text: '重复节点' }, false],
      ['large', 'target', 'a1', { uid: 'large', text: 'x'.repeat(30000) }, false]
    ]
    for (const [uid, parentUid, position, data, isRoot] of rows) {
      await pool.query(
        `insert into room_nodes(room_key, uid, parent_uid, position, data, is_root, node_version)
         values ($1, $2, $3, $4, $5::jsonb, $6, 1)`,
        [roomKey, uid, parentUid, position, JSON.stringify(data), isRoot]
      )
    }

    const byPath = await storage.queryRoomNodes(roomKey, {
      selector: { type: 'path', segments: ['根 节点', '目标'] },
      scope: 'subtree',
      page_size: 10
    })
    assert.deepStrictEqual(byPath.items.map(item => item.uid), ['target', 'detail'])
    assert.strictEqual(byPath.has_more, true)
    assert.ok(!byPath.items.some(item => item.uid === 'wide' || item.uid === 'wide-leaf'))
    assert.strictEqual(byPath.items[1].data.image, 'https://example.invalid/detail.png')
    assert.deepStrictEqual(byPath.items[1].data.imageSize, { width: 20, height: 10 })

    const rootOnly = await storage.queryRoomNodes(roomKey, {
      selector: { type: 'uid', value: 'root' }, scope: 'self'
    })
    assert.ok(!Object.prototype.hasOwnProperty.call(rootOnly.items[0].data, 'imgMap'))
    assert.strictEqual(rootOnly.items[0].data.image, null)
    assert.ok(rootOnly.omitted_fields.includes('data.imgMap'))
    assert.ok(rootOnly.omitted_fields.includes('data.image(base64)'))

    const absolute = await storage.queryRoomNodes(roomKey, {
      scope: 'level', level: 1, level_mode: 'absolute', page_size: 10
    })
    assert.deepStrictEqual(absolute.items.map(item => item.uid), ['wide', 'target', 'copy-a', 'copy-b'])

    const relative = await storage.queryRoomNodes(roomKey, {
      selector: { type: 'uid', value: 'target' },
      scope: 'level', level: 1, level_mode: 'relative', page_size: 10
    })
    assert.deepStrictEqual(relative.items.map(item => item.uid), ['detail'])
    assert.strictEqual(relative.has_more, true)

    await expectCode(
      () => storage.queryRoomNodes(roomKey, {
        selector: { type: 'name', value: '重复节点' }, scope: 'self'
      }),
      'NODE_AMBIGUOUS'
    )

    const fuzzy = await storage.queryRoomNodes(roomKey, {
      selector: { type: 'name', value: '目标x', match: 'fuzzy' }, scope: 'self'
    })
    assert.strictEqual(fuzzy.match_status, 'candidates')
    assert.ok(fuzzy.candidates.some(item => item.uid === 'target'))

    await pool.query(
      `update room_nodes
       set data = jsonb_set(data, '{text}', to_jsonb('已重命名目标'::text))
       where room_key = $1 and uid = 'target'`,
      [roomKey]
    )
    const renamed = await storage.queryRoomNodes(roomKey, {
      selector: { type: 'name', value: '已重命名目标' }, scope: 'self'
    })
    assert.strictEqual(renamed.items[0].uid, 'target')

    const first = await storage.queryRoomNodes(roomKey, {
      selector: { type: 'uid', value: 'root' }, scope: 'subtree', page_size: 1
    })
    assert.strictEqual(first.items.length, 1)
    assert.strictEqual(first.has_more, true)
    const second = await storage.queryRoomNodes(roomKey, {
      selector: { type: 'uid', value: 'root' }, scope: 'subtree', page_size: 1, cursor: first.next_cursor
    })
    assert.strictEqual(second.items.length, 1)
    assert.notStrictEqual(second.items[0].uid, first.items[0].uid)

    const fragmented = await storage.queryRoomNodes(roomKey, {
      selector: { type: 'uid', value: 'large' }, scope: 'self'
    })
    assert.ok(fragmented.items[0].content_fragment)
    assert.ok(Buffer.byteLength(JSON.stringify(fragmented), 'utf8') <= fragmented.byte_limit)
    assert.strictEqual(fragmented.has_more, true)

    await pool.query('update rooms set version = 2 where room_key = $1', [roomKey])
    await expectCode(
      () => storage.queryRoomNodes(roomKey, {
        selector: { type: 'uid', value: 'root' }, scope: 'subtree', page_size: 1, cursor: first.next_cursor
      }),
      'STALE_CURSOR'
    )
    console.log('nodeQuery PostgreSQL tests passed')
  } finally {
    await pool.query('delete from rooms where room_key = $1', [roomKey]).catch(() => {})
    await pool.end()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
