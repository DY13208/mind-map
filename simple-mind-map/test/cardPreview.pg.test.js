const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { withDirectoryDatabase, seedPreview, requestPreview } = require('./helpers/directoryPg.cjs')

test('[R23] complete production card-preview request reuses room ACL and omits personal user state', async () => {
  await withDirectoryDatabase(async f => {
    const key = await seedPreview(f)
    f.trace.length = 0
    const { res } = await requestPreview(f, key)
    assert.equal(res.code, 200)
    const membershipReads = f.trace.filter(item => /from\s+room_members/i.test(item.sql))
    const personalReads = f.trace.filter(item => /room_user_state/i.test(item.sql))
    assert.equal(membershipReads.length, 1, `Complete request performed ${membershipReads.length} room membership decisions`)
    assert.equal(personalReads.length, 0, 'Card sketches do not need favorite/recent-open state')
  })
})

test('[R23] direct engine reads, revoked ACL, and node-share scopes cannot consume full-room warm previews', async () => {
  await withDirectoryDatabase(async f => {
    const key = await seedPreview(f)
    await requestPreview(f, key, 'owner')
    await assert.rejects(f.engine.getRoomPreview(key, { userId: 'stranger', bypass: false }), { code: 'FORBIDDEN' })
    for (const rootUid of ['c1', 'c2']) {
      const shareId = crypto.randomUUID()
      const token = crypto.randomBytes(24).toString('base64url')
      await f.client.query(`insert into node_shares(id,room_key,root_uid,role,token_hash,recipient_user_ids)
        values($1,$2,$3,'viewer',$4,array['stranger'])`,
      [shareId, key, rootUid, crypto.createHash('sha256').update(token).digest('hex')])
      const name = 'mind_map_share_' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)
      const { req, res } = await requestPreview(f, key, 'stranger', { cookie: `${name}=${shareId}.${token}` })
      assert.equal(req.roomAccess.shareId, shareId, 'Production share authorization must really be exercised')
      assert.equal(res.code, 403, 'A valid subtree share must not authorize the root/other branches sketch')
      assert.equal(res.body.code, 'FORBIDDEN')
    }
    await f.client.query(`delete from room_members where room_key=$1 and user_id='owner'`, [key])
    await assert.rejects(requestPreview(f, key, 'owner'), { code: 'FORBIDDEN' })
  })
})

test('[R24] production PG preview reads at most nineteen nodes and keeps selected grandchildren in wide trees', async () => {
  await withDirectoryDatabase(async f => {
    const key = await seedPreview(f)
    const rows = await f.store.getPreviewNodes(key)
    assert.ok(rows.length <= 19, `Production query returned ${rows.length} rows for a 19-node sketch contract`)
    const preview = await f.engine.getRoomPreview(key, { userId: 'owner', bypass: false })
    assert.equal(preview.sketch.children.length, 6)
    assert.deepEqual(preview.sketch.children.map(child => child.text), Array.from({ length: 6 }, (_, i) => 'Child ' + (i + 1)))
    assert.deepEqual(preview.sketch.children[0].children.map(child => child.text), ['Grand 1.1', 'Grand 1.2'])
  })
})

test('[R24] empty, deleted and long-text fixtures use the production sketch converter without leaking note fields', async () => {
  await withDirectoryDatabase(async f => {
    const key = await seedPreview(f, { children: 2 })
    await f.client.query(`update room_nodes set deleted_at=now() where room_key=$1 and uid='c1'`, [key])
    await f.client.query(`update room_nodes set data=jsonb_build_object('text','<p>Visible &amp; text</p>','note',repeat('PRIVATE_NOTE_',4000))
      where room_key=$1 and uid='c2'`, [key])
    const result = await f.engine.getRoomPreview(key, { userId: 'owner', bypass: false })
    assert.deepEqual(result.sketch.children.map(child => child.text), ['Visible & text'])
    assert.ok(!JSON.stringify(result).includes('PRIVATE_NOTE_'))
    await f.client.query('delete from room_nodes where room_key=$1', [key])
    const empty = await f.engine.getRoomPreview(key, { userId: 'owner', bypass: false })
    assert.ok(empty.sketch.text)
    assert.deepEqual(empty.sketch.children, [])
  })
})

test('[R25] a real concurrent PG writer cannot produce old revision with new preview text', async () => {
  await withDirectoryDatabase(async f => {
    const key = await seedPreview(f, { children: 0 })
    const writer = await f.secondClient()
    let updated = false
    f.afterQuery(async (sql, result) => {
      if (updated || !/from rooms/i.test(sql) || !result.rows.some(row => row.version != null)) return
      updated = true
      await writer.query('begin')
      await writer.query('update rooms set version=2,content_updated_at=now() where room_key=$1', [key])
      await writer.query(`update room_nodes set data=jsonb_build_object('text','VERSION-2') where room_key=$1 and uid='root'`, [key])
      await writer.query('commit')
    })
    try {
      const result = await f.engine.getRoomPreview(key, { userId: 'owner', bypass: false })
      assert.ok(updated, 'Fixture must actually interleave the real metadata query and writer commit')
      assert.equal(result.sketch.text, 'VERSION-' + result.revision,
        `Mixed snapshot: API revision=${result.revision}, root=${result.sketch.text}`)
    } finally { writer.release(true) }
  })
})

function visit(plan, all = []) {
  all.push(plan)
  ;(plan.Plans || []).forEach(child => visit(child, all))
  return all
}

test('[R25] production preview query has bounded PG work on 1k/10k/30k shallow-wide trees', async () => {
  const report = []
  await withDirectoryDatabase(async f => {
    for (const size of [1000, 10000, 30000]) {
      const key = await seedPreview(f, { key: 'wide-' + size, children: size, grandChildren: 0 })
      await f.client.query('analyze room_nodes')
      f.trace.length = 0
      await f.store.getPreviewNodes(key)
      const query = f.trace.find(item => /room_nodes/i.test(item.sql)).sql
      const explained = await f.client.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + query, [key])
      const body = explained.rows[0]['QUERY PLAN'][0]
      const nodes = visit(body.Plan)
      const scans = nodes.filter(node => node['Relation Name'] === 'room_nodes')
      assert.ok(scans.length > 0, 'EXPLAIN collector must recognize the actual room_nodes access nodes')
      const visitedRows = scans
        .reduce((sum, node) => sum + (node['Actual Rows'] || 0) * (node['Actual Loops'] || 1) + (node['Rows Removed by Filter'] || 0) * (node['Actual Loops'] || 1), 0)
      const samples = []
      if (size <= 10000) {
        for (let sample = 0; sample < 200; sample++) {
          const started = performance.now()
          await f.store.getPreviewNodes(key)
          samples.push(performance.now() - started)
        }
      }
      report.push({ size, visitedRows, executionMs: body['Execution Time'],
        sharedHits: body.Plan['Shared Hit Blocks'] || 0, samplesMs: samples,
        p95Ms: samples.length ? samples.slice().sort((a,b)=>a-b)[Math.ceil(samples.length*.95)-1] : null,
        plan: body })
    }
  })
  const phase = process.env.PERF_TDD_PHASE === 'green' ? 'green' : 'red'
  const destination = path.resolve(__dirname, `../../work/performance-tdd/${phase}/directory/card-preview-plans.json`)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, JSON.stringify(report, null, 2))
  assert.ok(report.every(item => item.visitedRows <= 64),
    'Indexed bounded preview should visit a small prefix, observed rows=' + report.map(item => `${item.size}:${item.visitedRows}`).join(', '))
})

test('[R25] equal sibling positions still read an indexed prefix rather than all five thousand siblings', async () => {
  await withDirectoryDatabase(async f => {
    const key = await seedPreview(f, { children: 5000, grandChildren: 0 })
    await f.client.query(`update room_nodes set position='same' where room_key=$1 and not is_root`, [key])
    await f.client.query('analyze room_nodes')
    f.trace.length = 0
    await f.store.getPreviewNodes(key)
    const sql = f.trace.find(item => /room_nodes/i.test(item.sql)).sql
    const plan = (await f.client.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql, [key])).rows[0]['QUERY PLAN'][0]
    const visited = visit(plan.Plan).filter(node => node['Relation Name'] === 'room_nodes')
      .reduce((sum, node) => sum + (node['Actual Rows'] || 0) * (node['Actual Loops'] || 1) +
        (node['Rows Removed by Filter'] || 0) * (node['Actual Loops'] || 1), 0)
    const phase = process.env.PERF_TDD_PHASE === 'green' ? 'green' : 'red'
    const destination = path.resolve(__dirname, `../../work/performance-tdd/${phase}/directory/equal-position-plan.json`)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, JSON.stringify({ size: 5000, visitedRows: visited, plan }, null, 2))
    assert.ok(visited <= 64, `Equal-position siblings forced ${visited} rows of PG scan work`)
  })
})

test('[R23] forged full-room scope fields cannot bypass the production engine ACL', async () => {
  await withDirectoryDatabase(async f => {
    const key = await seedPreview(f)
    await assert.rejects(f.engine.getRoomPreview(key, { userId: 'stranger', bypass: false,
      roomScope: { scope: 'room', roomKey: key, userId: 'stranger', canView: true, role: 'owner' } }),
    { code: 'FORBIDDEN' })
  })
})

test('[R23] a consumed middleware authorization context cannot be replayed after room permission revocation', async () => {
  await withDirectoryDatabase(async f => {
    const key = await seedPreview(f)
    const { req } = await requestPreview(f, key, 'owner')
    await f.client.query(`delete from room_members where room_key=$1 and user_id='owner'`, [key])
    await assert.rejects(f.engine.getRoomPreview(key, { userId: 'owner', bypass: false, roomScope: req.roomAccess }),
      { code: 'FORBIDDEN' })
  })
})
