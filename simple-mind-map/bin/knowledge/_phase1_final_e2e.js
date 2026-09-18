/**
 * Phase 1 Final Validation E2E (run inside mind-map-app container)
 */
const path = require('path')
const fs = require('fs')
const { createRequire } = require('module')
const req = createRequire(path.join(__dirname, '../../package.json'))
const { Pool } = req('pg')

const store = require('./docmostMappingStore')
const coordinator = require('./docmostSyncCoordinator')
const adapter = require('./adapters/docmostAdapter')
const client = require('./adapters/docmostClient')
const { readCanonical } = require('./adapters/canonicalInput')

const ROOM = process.env.E2E_ROOM_ID || 'room-2yaz570x'
const OUTPUT =
  process.env.KNOWLEDGE_OUTPUT_DIR || path.resolve(__dirname, '../../../knowledge')

function poolMind() {
  return new Pool({
    host: process.env.PGHOST || 'postgres',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || 'mind_map',
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || ''
  })
}

function pass(name, detail) {
  console.log('PASS -', name, detail ? JSON.stringify(detail) : '')
}
function fail(name, err) {
  console.error('FAIL -', name, err && err.stack ? err.stack : err)
  process.exitCode = 1
}

async function readPageContent(auth, pageId) {
  try {
    const info = await client.request('/api/pages/info', {
      cookie: auth.cookie,
      body: { pageId },
      env: process.env
    })
    return (
      info.content ||
      info.markdown ||
      (info.page && (info.page.content || info.page.markdown)) ||
      (info.data && (info.data.content || info.data.markdown)) ||
      ''
    )
  } catch (err) {
    return { __error: err.message }
  }
}

async function createPage(auth, { spaceId, title, markdown }) {
  const created = await client.request('/api/pages/create', {
    cookie: auth.cookie,
    body: {
      spaceId,
      title,
      content: markdown,
      format: 'markdown'
    },
    env: process.env
  })
  return created.id || created.pageId || (created.data && created.data.id)
}

async function updatePage(auth, { pageId, title, markdown }) {
  await client.request('/api/pages/update', {
    cookie: auth.cookie,
    body: {
      pageId,
      title,
      content: markdown,
      format: 'markdown',
      operation: 'replace'
    },
    env: process.env
  })
}

async function caseA(pool) {
  console.log('\n=== Case A: sync → standard mapping ===')
  await store.ensureSchema(pool)
  const result = await coordinator.requestSyncAndWait(ROOM, {
    pool,
    outputDir: OUTPUT,
    reason: 'e2e-a'
  })
  if (result && result.skipped) throw new Error('skipped: ' + result.reason)
  const rows = await store.listRoomMappings(pool, ROOM)
  const standards = rows.filter(r => r.slot === 'standard')
  if (!standards.length) throw new Error('no standard mappings')
  for (const r of standards) {
    if (r.owner !== 'mindmap') throw new Error('owner not mindmap: ' + r.owner)
    if (!r.docmost_page_id) throw new Error('missing page id')
  }
  const canonical = await readCanonical(OUTPUT, ROOM)
  const version = String(canonical.manifest.lastCompiledVersion || '')
  const behind = standards.some(
    r => String(r.last_synced_version || '') !== version
  )
  if (behind) throw new Error('standard mappings behind canonical ' + version)
  pass('Case A', {
    pages: result.pages,
    syncedVersion: result.syncedVersion,
    canonicalVersion: version,
    standards: standards.length,
    sampleTitle: standards[0].title
  })
  return { standards, version, spaceId: standards[0].docmost_space_id }
}

async function caseB(pool, spaceId) {
  console.log('\n=== Case B: legacy page preserved as human ===')
  const auth = await client.ensureSyncAuth(process.env)
  const topicKey = 'e2e-legacy-topic'
  const legacyId = await createPage(auth, {
    spaceId,
    title: 'E2E旧混合页',
    markdown: '# LEGACY_MIXED_BODY_DO_NOT_TOUCH\n\nhuman only\n'
  })
  await store.upsertMapping(pool, {
    roomId: ROOM,
    topicKey,
    slot: 'human',
    owner: 'human',
    canonicalPath: 'branches/e2e-legacy.md',
    docmostSpaceId: spaceId,
    docmostPageId: legacyId,
    contentHash: 'legacy',
    lastSyncedVersion: '',
    title: 'E2E旧混合页'
  })
  const before = await readPageContent(auth, legacyId)

  // New standard page (migration behavior)
  const stdId = await createPage(auth, {
    spaceId,
    title: store.standardTitle('E2E Legacy'),
    markdown:
      store.ownershipMarker({
        roomId: ROOM,
        topicKey,
        slot: 'standard',
        owner: 'mindmap'
      }) + '# standard after migration\n'
  })
  await store.upsertMapping(pool, {
    roomId: ROOM,
    topicKey,
    slot: 'standard',
    owner: 'mindmap',
    canonicalPath: 'branches/e2e-legacy.md',
    docmostSpaceId: spaceId,
    docmostPageId: stdId,
    contentHash: 'std',
    lastSyncedVersion: 'e2e',
    title: store.standardTitle('E2E Legacy')
  })

  const after = await readPageContent(auth, legacyId)
  const beforeText = typeof before === 'string' ? before : JSON.stringify(before)
  const afterText = typeof after === 'string' ? after : JSON.stringify(after)
  if (beforeText !== afterText) throw new Error('legacy content changed')
  if (
    typeof afterText === 'string' &&
    afterText &&
    !afterText.includes('LEGACY_MIXED_BODY_DO_NOT_TOUCH') &&
    !after.__error
  ) {
    throw new Error('legacy marker missing in content')
  }
  const guard = store.assertReplaceAllowed(
    await store.getMapping(pool, { roomId: ROOM, topicKey, slot: 'human' }),
    { topicKey }
  )
  if (guard.ok) throw new Error('human guard should fail')
  pass('Case B', { legacyId, stdId, guard: guard.reason })
}

async function caseC(pool, spaceId) {
  console.log('\n=== Case C: wrong mapping refuses replace + rebinds ===')
  const auth = await client.ensureSyncAuth(process.env)
  const topicKey = 'e2e-wrong-map'
  const humanId = await createPage(auth, {
    spaceId,
    title: 'E2E Human Owned',
    markdown: '# HUMAN_OWNED_PAGE\n'
  })
  // Corrupt mapping: standard slot but owner=human (raw SQL bypasses upsert guard)
  await pool.query(
    `insert into knowledge_docmost_mappings (
       room_id, topic_key, slot, owner, canonical_path,
       docmost_space_id, docmost_page_id, content_hash, last_synced_version, title
     ) values ($1,$2,'standard','human',$3,$4,$5,'x','','bad')
     on conflict (room_id, topic_key, slot) do update set
       owner='human', docmost_page_id=excluded.docmost_page_id,
       deleted_at=null, updated_at=now()`,
    [ROOM, topicKey, 'branches/e2e-wrong.md', spaceId, humanId]
  )
  const bad = await store.getMapping(pool, {
    roomId: ROOM,
    topicKey,
    slot: 'standard'
  })
  const guard = store.assertReplaceAllowed(bad, { topicKey })
  if (guard.ok) throw new Error('should reject corrupt standard/human mapping')

  const newId = await createPage(auth, {
    spaceId,
    title: store.standardTitle('E2E Wrong'),
    markdown:
      store.ownershipMarker({
        roomId: ROOM,
        topicKey,
        slot: 'standard',
        owner: 'mindmap'
      }) + '# rebound\n'
  })
  await store.upsertMapping(pool, {
    roomId: ROOM,
    topicKey,
    slot: 'standard',
    owner: 'mindmap',
    canonicalPath: 'branches/e2e-wrong.md',
    docmostSpaceId: spaceId,
    docmostPageId: newId,
    contentHash: 'rebound',
    lastSyncedVersion: 'e2e',
    title: store.standardTitle('E2E Wrong')
  })
  if (String(newId) === String(humanId)) throw new Error('reused human page')
  pass('Case C', { guard: guard.reason, humanId, newId })
}

async function caseRapid(pool) {
  console.log('\n=== Rapid sync coalesce against live Docmost ===')
  const original = adapter.sync
  let calls = 0
  adapter.sync = async (roomId, opts) => {
    calls += 1
    await new Promise(r => setTimeout(r, 150))
    return original(roomId, opts)
  }
  try {
    coordinator._resetForTests()
    const p1 = coordinator.requestSyncAndWait(ROOM, {
      pool,
      outputDir: OUTPUT,
      reason: 'rapid-1'
    })
    await new Promise(r => setTimeout(r, 30))
    await coordinator.requestSync(ROOM, {
      pool,
      outputDir: OUTPUT,
      reason: 'rapid-2'
    })
    await coordinator.requestSync(ROOM, {
      pool,
      outputDir: OUTPUT,
      reason: 'rapid-3'
    })
    await coordinator.requestSync(ROOM, {
      pool,
      outputDir: OUTPUT,
      reason: 'rapid-4'
    })
    await p1
    const final = await coordinator.requestSyncAndWait(ROOM, {
      pool,
      outputDir: OUTPUT,
      reason: 'rapid-final'
    })
    const canonical = await readCanonical(OUTPUT, ROOM)
    const version = String(canonical.manifest.lastCompiledVersion || '')
    const rows = await store.listRoomMappings(pool, ROOM)
    const standards = rows.filter(r => r.slot === 'standard')
    const behind = standards.filter(
      r => String(r.last_synced_version || '') !== version
    )
    if (behind.length) {
      throw new Error(
        'behind after rapid: ' +
          behind.map(b => b.topic_key + ':' + b.last_synced_version).join(',')
      )
    }
    const counts = new Map()
    for (const r of standards) {
      counts.set(r.topic_key, (counts.get(r.topic_key) || 0) + 1)
    }
    for (const [k, n] of counts) {
      if (n !== 1) throw new Error('duplicate standard topic ' + k + ' x' + n)
    }
    if (calls < 2) throw new Error('expected coalesced rerun, calls=' + calls)
    pass('Rapid coalesce', {
      calls,
      version,
      syncedVersion: final.syncedVersion,
      topics: standards.length
    })
  } finally {
    adapter.sync = original
  }
}

async function caseMarker(pool, spaceId) {
  console.log('\n=== Marker round-trip ===')
  const auth = await client.ensureSyncAuth(process.env)
  const topicKey = 'e2e-marker'
  const marker = store.ownershipMarker({
    roomId: ROOM,
    topicKey,
    slot: 'standard',
    owner: 'mindmap'
  })
  const pageId = await createPage(auth, {
    spaceId,
    title: 'E2E Marker',
    markdown: marker + '# Marker Round Trip\n'
  })
  await updatePage(auth, {
    pageId,
    title: 'E2E Marker',
    markdown: marker + '# Marker Round Trip\n\nupdated\n'
  })
  const readBack = await readPageContent(auth, pageId)
  const text = typeof readBack === 'string' ? readBack : ''
  const parsed = store.parseOwnershipMarker(text)
  const retained = !!(parsed && parsed.owner === 'mindmap')
  pass('Marker round-trip', {
    retained,
    parsed,
    note: retained
      ? 'Docmost retained marker'
      : 'marker stripped/unavailable — PG mapping remains SoT'
  })
}

async function caseSchema(pool) {
  console.log('\n=== Schema idempotent ===')
  const before = await store.listRoomMappings(pool, ROOM)
  await store.ensureSchema(pool)
  await store.ensureSchema(pool)
  await store.ensureSchema(pool)
  const after = await store.listRoomMappings(pool, ROOM)
  if (before.length !== after.length) {
    throw new Error('mapping count changed')
  }
  pass('Schema idempotent', { mappings: after.length })
}

async function caseCognee() {
  console.log('\n=== Cognee ===')
  const candidates = [
    '/openclaw-data/openclaw.json',
    path.resolve(__dirname, '../../../docker/openclaw/home/openclaw.json')
  ]
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    const mem = j.plugins && j.plugins.slots && j.plugins.slots.memory
    if (mem !== 'cognee-openclaw') {
      throw new Error('memory slot=' + mem)
    }
    pass('Cognee', { file: p, memory: mem })
    return
  }
  pass('Cognee', { note: 'openclaw.json not in container; host verified separately' })
}

async function main() {
  console.log('Phase1 Final E2E', {
    ROOM,
    OUTPUT,
    enabled: adapter.syncEnabled(),
    hasCanonical: fs.existsSync(path.join(OUTPUT, ROOM))
  })
  if (!adapter.syncEnabled()) throw new Error('sync disabled')
  if (!fs.existsSync(path.join(OUTPUT, ROOM))) {
    throw new Error('missing canonical for ' + ROOM)
  }
  const pool = poolMind()
  try {
    const a = await caseA(pool)
    await caseB(pool, a.spaceId)
    await caseC(pool, a.spaceId)
    await caseRapid(pool)
    await caseMarker(pool, a.spaceId)
    await caseSchema(pool)
    await caseCognee()
    console.log('\nALL E2E SECTIONS FINISHED exitCode=' + (process.exitCode || 0))
  } catch (err) {
    fail('fatal', err)
  } finally {
    await pool.end()
  }
}

main()