/**
 * Phase 1 ownership behavior tests (fake pg pool, no Docmost HTTP).
 */
const assert = require('assert')
const store = require('./docmostMappingStore')

function createMemoryPool() {
  const rows = []
  let idSeq = 1
  return {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
      if (
        q.startsWith('create table') ||
        q.startsWith('create index') ||
        q.startsWith('alter table')
      ) {
        return { rows: [] }
      }
      if (q.startsWith('select') && q.includes('from knowledge_docmost_mappings')) {
        const roomId = params[0]
        const topicKey = params[1]
        const slot = params[2]
        let list = rows.filter(r => r.room_id === String(roomId) && !r.deleted_at)
        if (topicKey != null && slot != null) {
          list = list.filter(r => r.topic_key === String(topicKey) && r.slot === slot)
        }
        list = list.slice().sort((a, b) =>
          String(a.topic_key).localeCompare(b.topic_key) || String(a.slot).localeCompare(b.slot)
        )
        if (q.includes('limit 1')) return { rows: list.slice(0, 1) }
        return { rows: list }
      }
      if (q.startsWith('insert into knowledge_docmost_mappings')) {
        const [
          roomId,
          topicKey,
          slot,
          owner,
          canonicalPath,
          spaceId,
          pageId,
          contentHash,
          lastSyncedVersion,
          title,
          lastSyncSource = '',
          mindmapHash = ''
        ] = params
        const existing = rows.find(
          r =>
            r.room_id === String(roomId) &&
            r.topic_key === String(topicKey) &&
            r.slot === slot
        )
        if (existing) {
          Object.assign(existing, {
            owner,
            canonical_path: canonicalPath,
            docmost_space_id: spaceId,
            docmost_page_id: pageId,
            content_hash: contentHash,
            last_synced_version: lastSyncedVersion,
            title,
            last_sync_source:
              lastSyncSource || existing.last_sync_source || '',
            mindmap_hash: mindmapHash || existing.mindmap_hash || '',
            updated_at: new Date().toISOString(),
            deleted_at: null
          })
          return { rows: [existing] }
        }
        const row = {
          id: idSeq++,
          room_id: String(roomId),
          topic_key: String(topicKey),
          slot,
          owner,
          canonical_path: canonicalPath,
          docmost_space_id: spaceId,
          docmost_page_id: pageId,
          content_hash: contentHash,
          last_synced_version: lastSyncedVersion,
          title,
          last_sync_source: lastSyncSource || '',
          mindmap_hash: mindmapHash || '',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          deleted_at: null
        }
        rows.push(row)
        return { rows: [row] }
      }
      if (q.startsWith('update knowledge_docmost_mappings')) {
        const roomId = params[0]
        const topicKey = params[1]
        const slot = params[2]
        for (const r of rows) {
          if (
            r.room_id === String(roomId) &&
            r.topic_key === String(topicKey) &&
            r.slot === slot &&
            !r.deleted_at
          ) {
            r.deleted_at = new Date().toISOString()
            r.updated_at = r.deleted_at
          }
        }
        return { rows: [] }
      }
      throw new Error('unsupported sql in fake pool: ' + q.slice(0, 120))
    },
    _rows: rows
  }
}

async function run() {
  const db = createMemoryPool()
  await store.ensureSchema(db)

  // 1) new topic -> standard mapping created
  const standard = await store.upsertMapping(db, {
    roomId: 'room-a',
    topicKey: 'README',
    slot: 'standard',
    owner: 'mindmap',
    canonicalPath: 'README.md',
    docmostSpaceId: 'space-1',
    docmostPageId: 'page-std-1',
    contentHash: 'hash1',
    lastSyncedVersion: 'v1',
    title: store.standardTitle('主题A')
  })
  assert.strictEqual(standard.owner, 'mindmap')
  assert.strictEqual(standard.slot, 'standard')
  assert.ok(store.assertReplaceAllowed(standard, { topicKey: 'README' }).ok)

  // 2) human slot lazy: default absent
  const human0 = await store.getMapping(db, {
    roomId: 'room-a',
    topicKey: 'README',
    slot: 'human'
  })
  assert.strictEqual(human0, null)

  // 3) legacy migration simulation: preserve human, new standard
  await store.upsertMapping(db, {
    roomId: 'room-b',
    topicKey: 'branches/hire.md',
    slot: 'human',
    owner: 'human',
    canonicalPath: 'branches/hire.md',
    docmostSpaceId: 'space-1',
    docmostPageId: 'legacy-mixed-page',
    contentHash: 'old',
    title: '招聘 SOP'
  })
  const stdB = await store.upsertMapping(db, {
    roomId: 'room-b',
    topicKey: 'branches/hire.md',
    slot: 'standard',
    owner: 'mindmap',
    canonicalPath: 'branches/hire.md',
    docmostSpaceId: 'space-1',
    docmostPageId: 'new-standard-page',
    contentHash: 'new',
    title: store.standardTitle('招聘 SOP')
  })
  const humanB = await store.getMapping(db, {
    roomId: 'room-b',
    topicKey: 'branches/hire.md',
    slot: 'human'
  })
  assert.strictEqual(humanB.docmost_page_id, 'legacy-mixed-page')
  assert.strictEqual(stdB.docmost_page_id, 'new-standard-page')
  assert.strictEqual(
    store.assertReplaceAllowed(humanB, { topicKey: 'branches/hire.md' }).ok,
    false
  )
  assert.ok(store.assertReplaceAllowed(stdB, { topicKey: 'branches/hire.md' }).ok)

  // 4) mapping wrongly pointing human must block replace
  const wrong = {
    slot: 'human',
    owner: 'human',
    topic_key: 'README',
    docmost_page_id: 'p-human'
  }
  const blocked = store.assertReplaceAllowed(wrong, { topicKey: 'README' })
  assert.strictEqual(blocked.ok, false)

  // 5) ai slot never replaceable by canonical
  await store.upsertMapping(db, {
    roomId: 'room-a',
    topicKey: 'README',
    slot: 'ai',
    owner: 'ai',
    canonicalPath: 'README.md',
    docmostSpaceId: 'space-1',
    docmostPageId: 'page-ai-1',
    title: '主题A · AI整理'
  })
  const ai = await store.getMapping(db, {
    roomId: 'room-a',
    topicKey: 'README',
    slot: 'ai'
  })
  assert.strictEqual(store.assertReplaceAllowed(ai, { topicKey: 'README' }).ok, false)

  // 6) delete canonical -> soft-delete standard only
  await store.softDeleteStandardByTopic(db, {
    roomId: 'room-a',
    topicKey: 'README'
  })
  const stdGone = await store.getMapping(db, {
    roomId: 'room-a',
    topicKey: 'README',
    slot: 'standard'
  })
  const aiStill = await store.getMapping(db, {
    roomId: 'room-a',
    topicKey: 'README',
    slot: 'ai'
  })
  assert.strictEqual(stdGone, null)
  assert.ok(aiStill)
  assert.strictEqual(aiStill.docmost_page_id, 'page-ai-1')

  // 7) restart persistence: list still has human from room-b
  const listed = await store.listRoomMappings(db, 'room-b')
  assert.strictEqual(listed.length, 2)
  assert.deepStrictEqual(
    listed.map(r => r.slot).sort(),
    ['human', 'standard']
  )

  console.log('all phase1 ownership behavior tests passed')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})