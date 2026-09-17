const assert = require('assert').strict
const crypto = require('crypto')
const storage = require('../bin/storage')
const store = require('../bin/nodeKnowledge/store')

async function main() {
  await storage.initSchema()
  const pool = storage.getPool()
  await store.initSchema(pool)
  const roomKey = `attachment-read-${crypto.randomUUID()}`
  const readyId = `${roomKey}-ready`
  const failedId = `${roomKey}-failed`
  try {
    await pool.query(
      `insert into rooms(room_key, title, cos_key, version)
       values ($1, 'attachment read test', $2, 1)`,
      [roomKey, `test/${roomKey}.json`]
    )
    await pool.query(
      `insert into node_attachments
         (id, room_key, node_uid, content_hash, file_name, mime_type, byte_size,
          status, error_message, extracted_text, extracted_chars, source_kind)
       values
         ($1, $2, 'node-1', $3, '合同.pdf', 'application/pdf', 1024,
          'ready', '', $4, char_length($4), 'attachment'),
         ($5, $2, 'node-9', $6, '旧合同.doc', 'application/msword', 512,
          'failed', '暂不支持文本解析', '', 0, 'attachment')`,
      [
        readyId,
        roomKey,
        `${roomKey}-hash-a`,
        '甲乙丙丁戊己庚辛',
        failedId,
        `${roomKey}-hash-b`
      ]
    )
    // node-2 reuses the deduped row, so only its own data.attachmentId links it.
    await pool.query(
      `insert into room_nodes(room_key, uid, parent_uid, position, data, is_root, node_version)
       values ($1, 'root', null, 'a0', $2::jsonb, true, 1),
              ($1, 'node-2', 'root', 'a1', $3::jsonb, false, 1)`,
      [
        roomKey,
        JSON.stringify({ uid: 'root', text: '根' }),
        JSON.stringify({ uid: 'node-2', text: '复用附件', attachmentId: readyId })
      ]
    )

    const all = await store.listMeta(pool, roomKey)
    assert.deepEqual(all.map(item => item.id).sort(), [failedId, readyId].sort())
    const ready = all.find(item => item.id === readyId)
    // The length is reported so callers can plan paging; the text stays in PG.
    assert.equal(ready.extractedChars, 8)
    assert.equal(ready.extractedText, undefined)
    assert.equal(ready.fileName, '合同.pdf')

    assert.deepEqual(
      (await store.listMeta(pool, roomKey, { nodeUid: 'node-1' })).map(i => i.id),
      [readyId]
    )
    assert.deepEqual(
      (await store.listMeta(pool, roomKey, { nodeUid: 'node-2' })).map(i => i.id),
      [readyId]
    )
    assert.deepEqual(
      (await store.listMeta(pool, roomKey, { ids: [failedId] })).map(i => i.id),
      [failedId]
    )
    assert.deepEqual(await store.listMeta(pool, roomKey, { nodeUid: 'nobody' }), [])

    const head = await store.getTextSlice(pool, roomKey, readyId, { limit: 3 })
    assert.equal(head.text, '甲乙丙')
    assert.equal(head.offset, 0)
    assert.equal(head.total_chars, 8)
    assert.equal(head.has_more, true)
    assert.equal(head.next_offset, 3)

    const tail = await store.getTextSlice(pool, roomKey, readyId, {
      offset: head.next_offset
    })
    assert.equal(tail.text, '丁戊己庚辛')
    assert.equal(tail.has_more, false)
    assert.equal(tail.next_offset, null)

    const past = await store.getTextSlice(pool, roomKey, readyId, { offset: 99 })
    assert.equal(past.text, '')
    assert.equal(past.has_more, false)

    const failed = await store.getTextSlice(pool, roomKey, failedId)
    assert.equal(failed.text, '')
    assert.equal(failed.total_chars, 0)
    assert.equal(failed.attachment.status, 'failed')
    assert.match(failed.attachment.errorMessage, /暂不支持/)

    assert.equal(await store.getTextSlice(pool, roomKey, 'no-such-id'), null)
    assert.equal(await store.getTextSlice(pool, 'other-room', readyId), null)

    console.log('node attachment read PostgreSQL tests passed')
  } finally {
    await pool
      .query('delete from node_attachments where room_key = $1', [roomKey])
      .catch(() => {})
    await pool.query('delete from rooms where room_key = $1', [roomKey]).catch(() => {})
    await pool.end()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
