const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { WikiCompiler } = require('../../simple-mind-map/bin/wikiCompiler/index')
const { issueIdentity } = require('../../simple-mind-map/bin/wikiCompiler/access')
const { createWikiServer, roomBundles } = require('./server.cjs')
const attachmentStore = require('../../simple-mind-map/bin/nodeKnowledge/store')

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] || 0
}

function assertHistoryPgTestEnvironment(env = process.env) {
  assert.equal(env.MIND_MAP_SKIP_ROOT_ENV, '1', 'Set MIND_MAP_SKIP_ROOT_ENV=1 before running the real-PG fixture')
  const host = String(env.PGHOST || '').trim().toLowerCase()
  assert(['127.0.0.1', 'localhost', '::1'].includes(host), 'PGHOST must be an explicit loopback address')
  const database = String(env.PGDATABASE || '').trim()
  assert(database && database !== 'mind_map' && /(?:test|qa|benchmark)/i.test(database),
    'PGDATABASE must be an explicit disposable database whose name includes test, qa, or benchmark')
  assert(env.PGUSER && env.PGPASSWORD, 'PGUSER and PGPASSWORD must be supplied explicitly')
  const port = Number(env.PGPORT)
  assert(Number.isInteger(port) && port > 0 && port <= 65535, 'PGPORT must be explicit')
  return { host, port, user: env.PGUSER, password: env.PGPASSWORD, database }
}

test('PostgreSQL Wiki attachment reads validate generations, mounts, budgets and request savings', {
  skip: process.env.WIKI_ATTACHMENT_PG_TEST !== '1'
}, async t => {
  const { Pool } = require('../../simple-mind-map/node_modules/pg')
  const options = assertHistoryPgTestEnvironment(process.env)
  const rootPool = new Pool({ ...options, max: 1 })
  const schema = 'wiki_attachment_test_' + randomUUID().replace(/-/g, '')
  await rootPool.query('create schema ' + schema)
  const pool = new Pool({ ...options, options: '-c search_path=' + schema, max: 8 })
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-attachment-pg-'))
  const contractsDir = path.join(outputDir, 'contracts')
  await fs.mkdir(contractsDir)
  const compilerEnv = {
    WIKI_COMPILER_OUTPUT_DIR: outputDir,
    WIKI_COMPILER_CONTRACTS_DIR: contractsDir,
    WIKI_COMPILER_SYNC_ENABLED: 'false',
    KNOWLEDGE_COMPILER_ENABLED: 'false',
    DOCMOST_SYNC_ENABLED: 'false'
  }
  const service = new WikiCompiler({ pool, env: compilerEnv, log: () => {} })
  let server
  let legacyServer
  t.after(async () => {
    for (const activeServer of [server, legacyServer]) if (activeServer?.listening) {
      await new Promise(resolve => { activeServer.closeAllConnections?.(); activeServer.close(resolve) })
    }
    await pool.end().catch(() => {})
    try { await rootPool.query('drop schema ' + schema + ' cascade') } catch (_) {}
    await rootPool.end().catch(() => {})
    await fs.rm(outputDir, { recursive: true, force: true })
  })

  await pool.query(`
    create table rooms(room_key text primary key,title text,owner_id text,version bigint default 0,
      nodes jsonb default '{}',updated_at timestamptz default now(),deleted_at timestamptz);
    create table room_tombstones(room_key text primary key);
    create table room_nodes(room_key text,uid text,parent_uid text,position text,is_root boolean,data jsonb,deleted_at timestamptz);
    create table room_operations(room_key text,version bigint,operation_type text,payload jsonb,event jsonb,inverse_payload jsonb);
    create table room_members(room_key text,user_id text,role text);
    create table wecom_users(user_id text,wecom_userid text);
    create table node_attachments(
      id text not null, room_key text not null, node_uid text, content_hash text, file_name text,
      mime_type text, byte_size bigint default 0, status text, error_message text default '',
      extracted_text text not null default '', extracted_chars integer default 0, source_kind text,
      created_by text default '', created_at timestamptz default now(), updated_at timestamptz default now(),
      primary key(room_key,id)
    );
  `)
  await service.initialize()

  const roomId = 'attachment-' + randomUUID().replace(/-/g, '')
  const nodeA = 'node-a-' + randomUUID().slice(0, 8)
  const nodeB = 'node-b-' + randomUUID().slice(0, 8)
  const attachmentId = 'file-' + randomUUID().slice(0, 12)
  const text = ('审批周期：供应商费用须保留“合同与报价单”，路径 C:\\审批\\流程\\，示例文本。').repeat(220) + '\u0001'.repeat(5000)
  await pool.query('insert into rooms(room_key,title,owner_id,version) values($1,$2,$3,0)', [roomId, 'Wiki 附件验收', 'reader'])
  await pool.query('insert into room_members(room_key,user_id,role) values($1,$2,$3)', [roomId, 'reader', 'owner'])
  await pool.query(`insert into room_nodes(room_key,uid,parent_uid,position,is_root,data) values
    ($1,'root',null,'000',true,$2::jsonb),($1,$3,'root','100',false,$4::jsonb),($1,$5,'root','200',false,$6::jsonb)`, [
    roomId, JSON.stringify({ text: '附件测试图' }), nodeA, JSON.stringify({ text: '审批规则 A', attachmentId }),
    nodeB, JSON.stringify({ text: '审批规则 B', attachmentId })
  ])
  await pool.query(`insert into node_attachments(id,room_key,node_uid,content_hash,file_name,mime_type,byte_size,status,
      extracted_text,extracted_chars,source_kind,created_by)
    values($1,$2,$3,$4,$5,'text/plain',$6,'ready',$7,$8,'attachment','reader')`, [
    attachmentId, roomId, nodeA, 'sha256-' + attachmentId, '审批规则.txt', Buffer.byteLength(text), text, text.length
  ])
  await service.reconcile(roomId)
  const bundle = roomBundles(outputDir, new Set([roomId]))[0]
  assert.equal(bundle.attachmentSourceIndexVersion, 1)
  const topicA = bundle.topics.find(topic => topic.nodeUid === nodeA)
  const topicB = bundle.topics.find(topic => topic.nodeUid === nodeB)
  assert.equal(topicA.attachmentSources[0].attachment_id, attachmentId)
  assert.equal(topicB.attachmentSources[0].node_uid, nodeB, 'same attachment ID is indexed at every mounted node')

  const env = { WIKI_COMPILER_INTERNAL_SECRET: 'p'.repeat(64) }
  server = createWikiServer({ dir: outputDir, pool, env })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  const headers = () => ({ 'X-Wiki-Compiler-Identity': issueIdentity('reader', env), 'Content-Type': 'application/json' })
  const searchBody = { room_key: roomId, node_uid: nodeA, query: '审批周期', top_k: 5 }
  const searchResponse = await fetch(base + '/api/attachments/search', { method: 'POST', headers: headers(), body: JSON.stringify(searchBody) })
  const searchRaw = await searchResponse.text()
  const searchResult = JSON.parse(searchRaw)
  assert.equal(searchResult.status, 'ok')
  assert.equal(searchResult.complete, false)
  assert.ok(searchResult.items.length <= 5)
  assert.ok(searchResult.items.every(item => item.attachment_id === attachmentId && item.source.node_uid === nodeA))
  assert.ok(Buffer.byteLength(searchRaw, 'utf8') <= 12 * 1024, 'search budget includes escaped JSON metadata and text')

  const secondNodeSearch = await (await fetch(base + '/api/attachments/search', {
    method: 'POST', headers: headers(), body: JSON.stringify({ room_key: roomId, node_uid: nodeB, query: '审批周期' })
  })).json()
  assert.equal(secondNodeSearch.status, 'ok')
  assert.ok(secondNodeSearch.items.every(item => item.source.node_uid === nodeB))

  const readBody = { room_key: roomId, node_uid: nodeA, attachment_id: attachmentId, length: 10000 }
  let cursor = null
  let offset = 0
  let complete = false
  while (!complete) {
    const pageResponse = await fetch(base + '/api/attachments/read', {
      method: 'POST', headers: headers(), body: JSON.stringify({ ...readBody, cursor })
    })
    const raw = await pageResponse.text()
    const page = JSON.parse(raw)
    assert.equal(page.status, 'ok')
    assert.ok(Buffer.byteLength(raw, 'utf8') <= 20 * 1024, 'read budget includes escaped control characters and metadata')
    assert.equal(page.offset, offset)
    offset += page.text.length
    cursor = page.next_cursor
    complete = page.complete
    if (!complete) assert.ok(cursor)
  }
  assert.equal(offset, text.length)

  // ACL is read live for every request. A room with members is private to the
  // listed readers; changing the member role revokes access immediately.
  await pool.query("update room_members set role='blocked' where room_key=$1 and user_id='reader'", [roomId])
  const revokedResponse = await fetch(base + '/api/attachments/search', {
    method: 'POST', headers: headers(), body: JSON.stringify(searchBody)
  })
  assert.equal(revokedResponse.status, 404)
  assert.deepEqual(await revokedResponse.json(), { status: 'not_found' })
  await pool.query("update room_members set role='owner' where room_key=$1 and user_id='reader'", [roomId])

  // A metadata-only attachment update increments the source revision while
  // keeping the extracted text intact, so the old Wiki generation must go stale.
  await pool.query('update node_attachments set file_name=file_name where room_key=$1 and id=$2', [roomId, attachmentId])
  const staleResult = await (await fetch(base + '/api/attachments/read', {
    method: 'POST', headers: headers(), body: JSON.stringify(readBody)
  })).json()
  assert.equal(staleResult.status, 'stale')
  assert.equal(staleResult.fallback.tool, 'read_attachment')
  await service.reconcile(roomId)

  // Simulate a bundle published before the source index existed, then verify
  // the one-room controlled upgrade CLI rebuilds it and records the generation.
  const current = roomBundles(outputDir, new Set([roomId]))[0]
  const pointerFile = path.join(outputDir, 'rooms', roomId, 'current.json')
  const oldPointer = JSON.parse(await fs.readFile(pointerFile, 'utf8'))
  const bundleFile = path.join(outputDir, 'rooms', roomId, 'generations', current.generation, 'bundle.json')
  const oldBundle = JSON.parse(await fs.readFile(bundleFile, 'utf8'))
  oldBundle.attachmentSourceIndexVersion = 0
  oldBundle.sourceHash = 'legacy-' + randomUUID()
  oldPointer.sourceHash = oldBundle.sourceHash
  await fs.writeFile(bundleFile, JSON.stringify(oldBundle) + '\n')
  await fs.writeFile(pointerFile, JSON.stringify(oldPointer) + '\n')
  const manifestFile = path.join(outputDir, '.canonical', roomId, 'manifest.json')
  const oldManifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'))
  for (const document of Object.values(oldManifest.documents)) {
    document.attachmentSourceIndexVersion = 0
    delete document.attachmentSources
  }
  await fs.writeFile(manifestFile, JSON.stringify(oldManifest) + '\n')
  const upgradeRequired = await (await fetch(base + '/api/attachments/read', {
    method: 'POST', headers: headers(), body: JSON.stringify(readBody)
  })).json()
  assert.equal(upgradeRequired.status, 'index_upgrade_required')
  assert.equal(upgradeRequired.fallback.tool, 'read_attachment')

  const connection = new URL('postgresql://' + encodeURIComponent(options.user) + ':' + encodeURIComponent(options.password) +
    '@' + options.host + ':' + options.port + '/' + encodeURIComponent(options.database))
  connection.searchParams.set('options', '-c search_path=' + schema)
  const upgrade = spawnSync(process.execPath, [
    path.resolve(__dirname, '../../scripts/wiki-compile-model.js'),
    '--only-room', roomId,
    '--upgrade-attachment-index',
    '--wiki-dir', outputDir,
    '--contracts', contractsDir
  ], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      ...compilerEnv,
      MIND_MAP_DATABASE_URL: connection.href,
      MIND_MAP_SKIP_ROOT_ENV: '1'
    }
  })
  assert.equal(upgrade.error, undefined, 'controlled index upgrade process starts')
  const currentAfterUpgrade = roomBundles(outputDir, new Set([roomId]))[0] || null
  const liveAfterUpgrade = (await pool.query(`select r.version, coalesce(s.revision,0) as revision from rooms r
    left join knowledge_source_state s using(room_key) where r.room_key=$1`, [roomId])).rows[0]
  const canonicalManifest = JSON.parse(await fs.readFile(path.join(outputDir, '.canonical', roomId, 'manifest.json'), 'utf8'))
  const upgradeDiagnostics = [upgrade.stdout, upgrade.stderr].filter(Boolean).join('\n')
    .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, 'postgresql://[redacted]@').slice(0, 1600)
  assert.equal(upgrade.status, 0, 'controlled index upgrade succeeds without exposing DB credentials: ' + upgradeDiagnostics +
    ' bundle=' + JSON.stringify(currentAfterUpgrade && { version: currentAfterUpgrade.version, revision: currentAfterUpgrade.revision,
      attachmentSourceIndexVersion: currentAfterUpgrade.attachmentSourceIndexVersion, generation: currentAfterUpgrade.generation }) +
    ' live=' + JSON.stringify(liveAfterUpgrade) + ' canonical=' + JSON.stringify(Object.entries(canonicalManifest.documents)
      .map(([file, doc]) => [file, doc.attachmentSourceIndexVersion, Array.isArray(doc.attachmentSources)])))
  const reportLine = String(upgrade.stdout || '').split(/\r?\n/).find(line => line.trim().startsWith('{'))
  assert.ok(reportLine, 'upgrade command emits a JSON report')
  const upgradeReport = JSON.parse(reportLine)
  assert.equal(upgradeReport.successful[0].room_key, roomId)
  const upgradedBundle = roomBundles(outputDir, new Set([roomId]))[0]
  assert.equal(upgradedBundle.attachmentSourceIndexVersion, 1)
  assert.equal(upgradedBundle.version, Number((await pool.query('select version from rooms where room_key=$1', [roomId])).rows[0].version))
  assert.equal(upgradedBundle.revision, Number((await pool.query('select revision from knowledge_source_state where room_key=$1', [roomId])).rows[0].revision))
  const postUpgrade = await (await fetch(base + '/api/attachments/read', {
    method: 'POST', headers: headers(), body: JSON.stringify(readBody)
  })).json()
  assert.equal(postUpgrade.status, 'ok')

  const metrics = { before: { requests: 0, bytes: 0, ms: [] }, after: { requests: 0, bytes: 0, ms: [] } }
  legacyServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const slice = await attachmentStore.getTextSlice(pool, roomId, attachmentId, {
        offset: Number(url.searchParams.get('offset') || 0), limit: 4000
      })
      const body = JSON.stringify(slice)
      res.writeHead(slice ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(body)
    } catch (_) {
      res.writeHead(500); res.end('{}')
    }
  })
  await new Promise(resolve => legacyServer.listen(0, '127.0.0.1', resolve))
  const legacyBase = 'http://127.0.0.1:' + legacyServer.address().port + '/read'
  for (let trial = 0; trial < 20; trial++) {
    let start = performance.now()
    let nextOffset = 0
    let fullText = ''
    do {
      const response = await fetch(legacyBase + '?offset=' + nextOffset)
      const raw = await response.text()
      metrics.before.requests += 1
      metrics.before.bytes += Buffer.byteLength(raw, 'utf8')
      const page = JSON.parse(raw)
      fullText += page.text
      nextOffset = page.next_offset
    } while (nextOffset != null)
    assert.equal(fullText, text)
    metrics.before.ms.push(Number((performance.now() - start).toFixed(3)))

    start = performance.now()
    const response = await fetch(base + '/api/attachments/search', { method: 'POST', headers: headers(), body: JSON.stringify(searchBody) })
    const raw = await response.text()
    metrics.after.requests += 1
    metrics.after.bytes += Buffer.byteLength(raw, 'utf8')
    assert.equal(JSON.parse(raw).status, 'ok')
    metrics.after.ms.push(Number((performance.now() - start).toFixed(3)))
  }
  const report = {
    environment: 'local PostgreSQL integration fixture; legacy DB text-slice HTTP adapter vs Wiki attachment search HTTP endpoint',
    trials: 20,
    before: { requests: metrics.before.requests, requests_per_task: metrics.before.requests / 20,
      response_bytes: metrics.before.bytes, p50_ms: percentile(metrics.before.ms, 0.50), p95_ms: percentile(metrics.before.ms, 0.95) },
    after: { requests: metrics.after.requests, requests_per_task: metrics.after.requests / 20,
      response_bytes: metrics.after.bytes, p50_ms: percentile(metrics.after.ms, 0.50), p95_ms: percentile(metrics.after.ms, 0.95) }
  }
  console.log('ATTACHMENT_WIKI_LOCAL_HTTP_BENCHMARK ' + JSON.stringify(report))
})

module.exports = { assertHistoryPgTestEnvironment }
