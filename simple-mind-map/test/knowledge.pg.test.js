const assert = require('assert')
const fs = require('fs/promises')
const path = require('path')
const { randomUUID } = require('crypto')
const { spawn } = require('child_process')
process.env.COLLAB_V2 = '1'
process.env.WECOM_AUTH_ENABLED = '0'
const h = require('./collabV2.pgHarness')
const storage = require('../bin/storage')
const { KnowledgeCompiler } = require('../bin/knowledge/compiler')
const { readSnapshot } = require('../bin/knowledge/snapshot')
const { ChangeTracker } = require('../bin/knowledge/changeTracker')
const { readManifest, recover } = require('../bin/knowledge/manifestStore')
const { hash } = require('../bin/knowledge/utils')
const { readCanonical } = require('../bin/knowledge/adapters/canonicalInput')
const { semantic, markdown } = require('../bin/knowledge/markdownRenderer')
const dir = process.env.KNOWLEDGE_TEST_OUTPUT || '/app/knowledge/.test-' + randomUUID()
const roomId = 'kc-test-' + randomUUID()
const otherRoom = 'kc-test-' + randomUUID()
const roomIds = [roomId, otherRoom]
const report = { cases: [], acceptance: null }
let server, a, b, pool
const compiler = () => new KnowledgeCompiler({ pool, outputDir: dir })
async function fingerprints(id = roomId) {
  const manifest = await readManifest(path.join(dir, id))
  const files = {}
  for (const file of Object.keys(manifest.documents)) {
    const full = path.join(dir, id, file)
    files[file] = { hash: hash(await fs.readFile(full, 'utf8')), mtimeMs: (await fs.stat(full)).mtimeMs }
  }
  return { lastCompiledVersion: manifest.lastCompiledVersion, lastSourceRevision: manifest.lastSourceRevision, files }
}
async function seed(id, count = 0) {
  const rows = [
    { uid: 'root', parent_uid: null, position: 'a0', is_root: true, data: { text: '业务知识' } },
    { uid: 'hiring', parent_uid: 'root', position: 'a1', is_root: false, data: { text: '招聘' } },
    { uid: 'finance', parent_uid: 'root', position: 'a2', is_root: false, data: { text: '财务' } },
    { uid: 'h1', parent_uid: 'hiring', position: 'a0', is_root: false, data: { text: '面试', note: '原始备注' } },
    { uid: 'f1', parent_uid: 'finance', position: 'a0', is_root: false, data: { text: '报销' } }
  ]
  for (let i = 0; i < count; i++) rows.push({ uid: 'large-' + i, parent_uid: i % 2 ? 'hiring' : 'finance', position: String(i).padStart(8, '0'), is_root: false, data: { text: '业务节点 ' + i } })
  await pool.query("insert into rooms(room_key,title,cos_key,nodes,version) values($1,'KC isolated test',$2,'{}',0)", [id, 'test/' + id])
  await pool.query(`insert into room_nodes(room_key,uid,parent_uid,position,data,is_root,node_version)
    select $1,x.uid,x.parent_uid,x.position,x.data,x.is_root,0
    from jsonb_to_recordset($2::jsonb) as x(uid text,parent_uid text,position text,data jsonb,is_root boolean)`, [id, JSON.stringify(rows)])
}
async function op(type, payload, client = a) {
  const { result } = await h.submitOp(client, type, payload)
  assert.strictEqual(result.ok, true, JSON.stringify(result))
  return result
}
async function test(label, task) {
  await task()
  report.cases.push(label)
  console.log('PASS', label)
}
async function crash(point) {
  const child = spawn(process.execPath, [path.join(__dirname, 'knowledge.crash.cjs'), dir, roomId, point], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', x => { output += x })
  child.stderr.on('data', x => { output += x })
  const code = await new Promise(resolve => child.on('exit', resolve))
  assert.strictEqual(code, 73, output)
}
async function main() {
  const api = await h.tryPg()
  if (api.error) throw api.error
  pool = api.getPool()
  await require('../bin/knowledge/sourceChanges').initSchema(pool)
  await seed(roomId); await seed(otherRoom)
  server = await h.startV2Server()
  a = await h.joinClient(server.url, roomId, randomUUID())
  b = await h.joinClient(server.url, otherRoom, randomUUID())
  let kc = compiler()
  await test('first full compile', async () => {
    const result = await kc.compile(roomId)
    assert.strictEqual(result.mode, 'full')
    assert.deepStrictEqual(result.changedFiles.sort(), ['README.md', 'branches/finance.md', 'branches/hiring.md'])
  })
  await test('no changes preserve hash and mtime of every file', async () => {
    const before = await fingerprints()
    assert.deepStrictEqual((await kc.compile(roomId)).changedFiles, [])
    assert.deepStrictEqual(await fingerprints(), before)
  })
  await test('real V2 edit affects only hiring Markdown', async () => {
    const before = await fingerprints()
    await op('node.update', { uid: 'h1', patch: { note: '更新的面试知识' } })
    const result = await kc.compile(roomId)
    const after = await fingerprints()
    assert.deepStrictEqual(result.changedFiles, ['branches/hiring.md'])
    assert.deepStrictEqual(after.files['branches/finance.md'], before.files['branches/finance.md'])
    assert.deepStrictEqual(after.files['README.md'], before.files['README.md'])
    assert.notStrictEqual(after.files['branches/hiring.md'].hash, before.files['branches/hiring.md'].hash)
    assert.strictEqual(after.lastCompiledVersion, 1)
    report.acceptance = { roomId, before, after, affectedUids: result.affectedUids, affectedMarkdown: result.affectedMarkdown, changedFiles: result.changedFiles }
  })
  await test('REPEATABLE READ: edit after version read stays out of this snapshot', async () => {
    const old = await readManifest(path.join(dir, roomId))
    const snapshot = await readSnapshot(pool, roomId, old, { force: true, afterVersionRead: async version => {
      assert.strictEqual(version, 1)
      await op('node.update', { uid: 'h1', patch: { note: '并发编辑 N+1' } })
    } })
    assert.strictEqual(snapshot.snapshotVersion, 1)
    assert.strictEqual(snapshot.data.get('h1').note, '更新的面试知识')
    await kc.compile(roomId)
    assert.strictEqual((await fingerprints()).lastCompiledVersion, 2)
  })
  await test('edit during rendering remains queued for the next compile', async () => {
    await op('node.update', { uid: 'h1', patch: { note: '渲染前 N' } })
    const result = await kc.compile(roomId, { afterSnapshot: async input => {
      const next = await op('node.update', { uid: 'f1', patch: { note: '渲染中 N+1' } })
      kc.tracker.mark(roomId, next.serverRevision, ['f1'])
      assert.strictEqual(input.snapshotVersion, 3)
    } })
    assert.strictEqual(result.lastCompiledVersion, 3)
    assert.strictEqual(kc.tracker.count(roomId), 1)
    assert.deepStrictEqual((await kc.compile(roomId)).changedFiles, ['branches/finance.md'])
    assert.strictEqual(kc.tracker.count(roomId), 0)
  })
  await test('stopped compiler recovers edits using persisted operation versions', async () => {
    await op('node.update', { uid: 'h1', patch: { note: '停机期间知识' } })
    kc = compiler()
    assert.strictEqual(kc.tracker.count(roomId), 0)
    assert.deepStrictEqual((await kc.compile(roomId)).changedFiles, ['branches/hiring.md'])
  })
  await test('insert and delete remove stale Markdown', async () => {
    await op('node.insert', { uid: 'new', parentUid: 'hiring', text: '新增知识' })
    await kc.compile(roomId)
    assert.ok((await fs.readFile(path.join(dir, roomId, 'branches/hiring.md'), 'utf8')).includes('新增知识'))
    await op('node.delete', { uid: 'new' })
    await kc.compile(roomId)
    assert.ok(!(await fs.readFile(path.join(dir, roomId, 'branches/hiring.md'), 'utf8')).includes('新增知识'))
  })
  await test('cross-branch move updates old and new documents', async () => {
    await op('node.move', { uid: 'h1', parentUid: 'finance', index: 0 })
    assert.deepStrictEqual((await kc.compile(roomId)).changedFiles.sort(), ['branches/finance.md', 'branches/hiring.md'])
    assert.strictEqual((await readManifest(path.join(dir, roomId))).nodes.h1.documentRootUid, 'finance')
    await op('node.move', { uid: 'h1', parentUid: 'hiring', index: 0 }); await kc.compile(roomId)
  })
  await test('rename keeps stable UID path; unrelated branch mtime unchanged', async () => {
    const before = await fingerprints()
    await op('node.update', { uid: 'hiring', patch: { text: '人才招聘 SOP' } })
    const result = await kc.compile(roomId)
    assert.deepStrictEqual(result.changedFiles.sort(), ['README.md', 'branches/hiring.md'])
    assert.deepStrictEqual((await fingerprints()).files['branches/finance.md'], before.files['branches/finance.md'])
  })
  await test('undo and redo through real V2 operations', async () => {
    const changed = await op('node.update', { uid: 'h1', patch: { note: 'UNDO_REDO_PROBE' } })
    await kc.compile(roomId)
    const changedId = changed.operation.operation_id || changed.operation.opId
    const undone = await op('operation.undo', { targetOperationId: changedId })
    await kc.compile(roomId)
    assert.ok(!(await fs.readFile(path.join(dir, roomId, 'branches/hiring.md'), 'utf8')).includes('UNDO_REDO_PROBE'))
    await op('operation.redo', { targetOperationId: changedId })
    await kc.compile(roomId)
    assert.ok((await fs.readFile(path.join(dir, roomId, 'branches/hiring.md'), 'utf8')).includes('UNDO_REDO_PROBE'))
  })
  await test('many edits deduplicate to one affected document', async () => {
    const tracker = new ChangeTracker()
    for (let i = 0; i < 10; i++) tracker.mark(roomId, i, ['h1'])
    assert.strictEqual(tracker.count(roomId), 1)
    for (let i = 0; i < 5; i++) await op('node.update', { uid: 'h1', patch: { note: '合并编辑 ' + i } })
    assert.deepStrictEqual((await kc.compile(roomId)).changedFiles, ['branches/hiring.md'])
  })
  await test('compiler write failure rolls back files/version; V2 keeps editing', async () => {
    const before = await fingerprints()
    await op('node.update', { uid: 'h1', patch: { note: 'FAILURE_RECOVERY' } })
    await assert.rejects(kc.compile(roomId, { beforeWrite: file => { if (file === 'manifest.json') throw new Error('injected write failure') } }), /injected/)
    const failed = await fingerprints()
    assert.strictEqual(failed.lastCompiledVersion, before.lastCompiledVersion)
    for (const file of Object.keys(before.files)) assert.strictEqual(failed.files[file].hash, before.files[file].hash)
    await op('node.update', { uid: 'h1', patch: { note: '协同仍然正常' } })
    await kc.compile(roomId)
  })
  for (const point of ['after-markdown', 'before-manifest']) await test('process crash recovery: ' + point, async () => {
    const before = await fingerprints()
    await op('node.update', { uid: 'h1', patch: { note: 'CRASH_' + point } })
    await crash(point)
    await assert.rejects(readCanonical(dir, roomId), /pending/)
    await recover(path.join(dir, roomId))
    const recovered = await fingerprints()
    assert.strictEqual(recovered.lastCompiledVersion, before.lastCompiledVersion)
    for (const file of Object.keys(before.files)) assert.strictEqual(recovered.files[file].hash, before.files[file].hash)
    assert.deepStrictEqual((await compiler().compile(roomId)).changedFiles, ['branches/hiring.md'])
  })
  await test('crash between directory renames restores the complete old directory', async () => {
    const before = await fingerprints()
    await op('node.update', { uid: 'h1', patch: { note: 'CRASH_BEFORE_SWAP' } })
    await crash('before-swap')
    await recover(path.join(dir, roomId))
    assert.deepStrictEqual(await fingerprints(), before)
    assert.deepStrictEqual((await compiler().compile(roomId)).changedFiles, ['branches/hiring.md'])
  })
  await test('crash after directory commit retains complete new files and version', async () => {
    const before = await fingerprints()
    await op('node.update', { uid: 'h1', patch: { note: 'CRASH_AFTER_SWAP' } })
    await crash('after-swap')
    await recover(path.join(dir, roomId))
    const after = await fingerprints()
    assert.strictEqual(after.lastCompiledVersion, before.lastCompiledVersion + 1)
    assert.deepStrictEqual(after.files['branches/finance.md'], before.files['branches/finance.md'])
    assert.deepStrictEqual((await compiler().compile(roomId)).changedFiles, [])
  })
  await test('operation log gap explicitly triggers full baseline', async () => {
    await op('node.update', { uid: 'h1', patch: { note: 'LOG_GAP' } })
    const v = Number((await pool.query('select version from rooms where room_key=$1', [roomId])).rows[0].version)
    await pool.query('delete from room_operations where room_key=$1 and version=$2', [roomId, v])
    const result = await kc.compile(roomId)
    assert.strictEqual(result.mode, 'full'); assert.strictEqual(result.reason, 'operation_log_gap')
  })
  await test('async extraction invalidates referenced document without a V2 operation', async () => {
    const id = randomUUID()
    await pool.query("insert into node_attachments(id,room_key,node_uid,content_hash,file_name,status) values($1,$2,'h1',$1,'素材.txt','processing')", [id, roomId])
    await kc.compile(roomId)
    const before = await fingerprints()
    await pool.query("update node_attachments set status='ready',extracted_text='异步提取知识',updated_at=now() where id=$1", [id])
    const result = await kc.compile(roomId)
    const after = await fingerprints()
    assert.deepStrictEqual(result.changedFiles, ['branches/hiring.md'])
    assert.strictEqual(after.lastCompiledVersion, before.lastCompiledVersion)
    assert.ok(after.lastSourceRevision > before.lastSourceRevision)
    assert.deepStrictEqual(after.files['branches/finance.md'], before.files['branches/finance.md'])
  })
  await test('same room coalesces; advisory lock prevents separate compilers racing; different rooms independent', async () => {
    await kc.compile(otherRoom)
    const beforeOther = await fingerprints(otherRoom)
    await op('node.update', { uid: 'h1', patch: { note: 'LOCK_PROBE' } })
    let release, entered
    const gate = new Promise(r => { release = r })
    const ready = new Promise(r => { entered = r })
    const first = kc.compile(roomId, { afterSnapshot: async () => { entered(); await gate } })
    assert.strictEqual(kc.compile(roomId), first)
    await ready
    assert.strictEqual((await compiler().compile(roomId)).status, 'busy')
    await op('node.update', { uid: 'f1', patch: { note: '另一个房间' } }, b)
    assert.strictEqual((await compiler().compile(otherRoom)).status, 'idle')
    release(); await first
    assert.notStrictEqual((await fingerprints(otherRoom)).lastCompiledVersion, beforeOther.lastCompiledVersion)
  })
  await test('style-only edit does not rewrite Markdown', async () => {
    const before = await fingerprints()
    await op('node.update', { uid: 'h1', patch: { expand: false, color: '#ff0000' } })
    assert.deepStrictEqual((await kc.compile(roomId)).changedFiles, [])
    assert.deepStrictEqual((await fingerprints()).files, before.files)
  })
  await test('Knowledge HTTP APIs enforce existing room ACL and expose durable pending state', async () => {
    const knowledge = require('../bin/knowledge')
    process.env.KNOWLEDGE_COMPILER_ENABLED = 'true'
    process.env.KNOWLEDGE_OUTPUT_DIR = dir
    await knowledge.start({ pool, operationEvents: storage.operationEvents, sourceNotifications: false })
    knowledge.getScheduler().stop()
    const { Readable } = require('stream')
    async function request(action, userId, method, body = {}) {
      const req = Readable.from([Buffer.from(JSON.stringify(body))])
      req.method = method; req.authUser = userId ? { id: userId } : null; req.forceAcl = true
      const result = {}
      const res = { writeHead(code) { result.code = code }, end(value) { result.body = JSON.parse(value) } }
      await knowledge.handleApi(req, res, `/api/knowledge/${action}/${otherRoom}`)
      return result
    }
    await pool.query("insert into room_members(room_key,user_id,role,direct_role,source) values($1,'kc-viewer','viewer','viewer','direct_share')", [otherRoom])
    await require('../bin/roomAcl').ensureOwner(pool, otherRoom, b.userId)
    assert.strictEqual((await request('status', '', 'GET')).code, 401)
    assert.strictEqual((await request('status', 'kc-stranger', 'GET')).code, 403)
    assert.strictEqual((await request('compile', 'kc-stranger', 'POST')).code, 403)
    assert.strictEqual((await request('compile', 'kc-viewer', 'POST')).code, 403)
    assert.strictEqual((await request('status', 'kc-viewer', 'GET')).code, 200)
    await op('node.update', { uid: 'f1', patch: { note: 'API_PENDING' } }, b)
    assert.ok((await request('status', b.userId, 'GET')).body.pendingOperations > 0)
    assert.strictEqual((await request('compile', b.userId, 'POST', { force: false })).code, 200)
    assert.strictEqual((await request('compile', b.userId, 'POST', { force: 'false' })).code, 400)
  })
  await test('legacy persisted save uses independent durable revision', async () => {
    const before = await fingerprints(otherRoom)
    const nodes = {
      root: { isRoot: true, data: { uid: 'root', text: '业务知识' }, children: ['hiring', 'finance'] },
      hiring: { data: { uid: 'hiring', text: '招聘' }, children: ['h1'] },
      finance: { data: { uid: 'finance', text: '财务' }, children: ['f1'] },
      h1: { data: { uid: 'h1', text: '面试', note: 'LEGACY_SAVE' }, children: [] },
      f1: { data: { uid: 'f1', text: '报销', note: 'API_PENDING' }, children: [] }
    }
    await storage.upsertRoom(otherRoom, 'legacy knowledge test', { nodes, allowFullTree: true })
    const result = await kc.compile(otherRoom)
    assert.strictEqual(result.reason, 'legacy_save')
    assert.strictEqual((await fingerprints(otherRoom)).lastCompiledVersion, before.lastCompiledVersion)
    assert.ok((await fingerprints(otherRoom)).lastSourceRevision > before.lastSourceRevision)
  })
  await test('deletion during compile cannot republish the deleted room', async () => {
    const temp = 'kc-delete-' + randomUUID(); roomIds.push(temp)
    await seed(temp); await kc.compile(temp)
    const result = await kc.compile(temp, { force: true, afterSnapshot: () => pool.query('update rooms set deleted_at=now() where room_key=$1', [temp]) })
    assert.strictEqual(result.status, 'archived')
    assert.ok(await readManifest(result.archivedTo))
    await assert.rejects(fs.stat(path.join(dir, temp)), /ENOENT/)
  })
  await test('replace graph removes old document files and establishes new roots', async () => {
    await op('map.replace', { nodes: {
      root: { isRoot: true, data: { uid: 'root', text: '替换导图' }, children: ['replacement'] },
      replacement: { data: { uid: 'replacement', text: '替换业务分支' }, children: [] }
    } })
    const result = await kc.compile(roomId)
    assert.strictEqual(result.mode, 'full')
    assert.deepStrictEqual(result.deletedFiles.sort(), ['branches/finance.md', 'branches/hiring.md'])
    assert.ok((await readManifest(path.join(dir, roomId))).documents['branches/replacement.md'])
  })
  await test('room deletion archives output; restart reconciles missed deletion', async () => {
    await pool.query('insert into room_tombstones(room_key) values($1)', [roomId])
    const result = await compiler().compile(roomId)
    assert.strictEqual(result.status, 'archived')
    assert.ok(await readManifest(result.archivedTo))
    await assert.rejects(fs.stat(path.join(dir, roomId)), /ENOENT/)
  })
  await test('export contract handles Markdown notes, rich titles, tags, summaries; excludes UI state', async () => {
    assert.strictEqual(markdown('<p><strong>富文本</strong></p>'), '**富文本**')
    assert.strictEqual(markdown('## 备注\n\n- 条目'), '## 备注\n\n- 条目')
    assert.deepStrictEqual(semantic({ text: 'x', expand: false, color: '#fff' }, []), semantic({ text: 'x', expand: true }, []))
    const value = semantic({ text: 'x', tag: ['知识'], generalization: [{ text: '概括', range: [0, 1] }], hyperlink: 'javascript:alert(1)' }, [])
    assert.deepStrictEqual(value.tag, ['知识']); assert.strictEqual(value.generalization[0].text, '概括'); assert.strictEqual(value.hyperlink, '')
  })
  await test('10k-node file increment reads/hashes only affected branch content', async () => {
    const largeRoom = 'kc-large-' + randomUUID(); roomIds.push(largeRoom)
    await seed(largeRoom, 10000)
    await compiler().compile(largeRoom)
    const client = await h.joinClient(server.url, largeRoom, randomUUID())
    try {
      await op('node.update', { uid: 'h1', patch: { note: '一万节点增量' } }, client)
      const old = await readManifest(path.join(dir, largeRoom))
      const input = await readSnapshot(pool, largeRoom, old)
      assert.deepStrictEqual(input.changedRoots, ['hiring'])
      assert.ok(input.data.size < 5100, 'Unchanged branch semantic data must not be loaded')
      const before = await fingerprints(largeRoom)
      const result = await compiler().compile(largeRoom)
      const after = await fingerprints(largeRoom)
      assert.deepStrictEqual(after.files['branches/finance.md'], before.files['branches/finance.md'])
      report.largeMap = { nodeCount: 10005, loadedSemanticNodes: input.data.size, changedFiles: result.changedFiles, durationMs: result.durationMs }
    } finally { client.socket.disconnect() }
  })
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'verification.json'), JSON.stringify(report, null, 2))
  console.log('KNOWLEDGE_REPORT', JSON.stringify(report))
}
main().catch(err => { console.error(err.stack); process.exitCode = 1 }).finally(async () => {
  if (a) a.socket.disconnect(); if (b) b.socket.disconnect()
  if (server) { server.presence?.close?.(); await new Promise(resolve => server.server.close(resolve)) }
  if (pool) {
    for (const id of roomIds) {
      for (const table of ['node_attachments', 'knowledge_source_changes', 'knowledge_source_state', 'room_outbox', 'room_operations', 'room_operations_archive', 'room_snapshots', 'room_nodes', 'room_members', 'room_tombstones', 'rooms']) {
        await pool.query(`delete from ${table} where room_key=$1`, [id]).catch(() => {})
      }
    }
    await pool.end()
  }
})
