const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { publishRoom } = require('../../simple-mind-map/bin/wikiCompiler/compiler')
const { issueIdentity } = require('../../simple-mind-map/bin/wikiCompiler/access')
const { INDEX_VERSION, signCursor } = require('./attachmentSources.cjs')

async function setup(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-attachments-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const roomId = 'attachment-room'
  const nodeUid = 'attachment-node'
  const attachmentId = 'file-1'
  const attachmentIds = options.attachmentIds || [attachmentId]
  const text = options.text == null ? '供应商报销规则：业务费用须完成审批，保留发票和合同。'.repeat(30) : options.text
  const markdownPrefix = '# 附件节点\n\n'
  let markdown = markdownPrefix
  const sourceTexts = new Map()
  const attachmentSources = attachmentIds.map((id, index) => {
    if (index) markdown += '\n\n'
    const sourceText = options.textById?.[id] ?? text
    const start = markdown.length
    markdown += sourceText
    const end = markdown.length
    sourceTexts.set(id, sourceText)
    return {
      room_key: roomId, node_uid: nodeUid, attachment_id: id, name: `报销规则-${id}.txt`,
      content_hash: `sha256-content-${id}`, status: options.status || 'ready',
      start: options.status === 'failed' ? null : start,
      end: options.status === 'failed' ? null : end,
      total_chars: options.status === 'failed' ? 0 : sourceText.length,
      range_unit: 'utf16', index_version: INDEX_VERSION, version: 4, source_revision: 2
    }
  })
  const input = {
    roomId, title: '附件测试', version: 4, revision: 2,
    attachmentSourceIndexVersion: options.legacy ? 0 : INDEX_VERSION,
    topics: [{ nodeUid, title: '附件节点', markdown,
      ...(options.legacy || options.missingSource ? {} : { attachmentSourceIndexVersion: INDEX_VERSION, attachmentSources }) }]
  }
  await publishRoom(dir, input)
  const state = {
    allowed: true,
    version: 4,
    revision: 2,
    mountedIds: options.mountedIds || (options.mountedId ? [options.mountedId] : attachmentIds),
    attachments: new Map(attachmentIds.map(id => [id, {
      id, status: options.status || 'ready', content_hash: `sha256-content-${id}`,
      total_chars: sourceTexts.get(id).length, name: `报销规则-${id}.txt`
    }])),
    userAllowList: options.userAllowList || null
  }
  const pool = {
    async query(sql, params = []) {
      if (/from room_members/.test(sql)) {
        const user = params[0]
        const readable = state.allowed && (!state.userAllowList || state.userAllowList.has(user))
        return { rows: readable ? [{ room_key: roomId }] : [] }
      }
      if (/join room_nodes n/.test(sql)) {
        return { rows: [{ version: state.version, source_revision: state.revision,
          uid: nodeUid, data: { attachmentIds: state.mountedIds } }] }
      }
      if (/from node_attachments/.test(sql)) {
        return { rows: (params[1] || []).map(id => state.attachments.get(id)).filter(Boolean).map(attachment => ({
          id: attachment.id, node_uid: nodeUid, file_name: attachment.name,
          status: attachment.status, content_hash: attachment.content_hash, total_chars: attachment.total_chars
        })) }
      }
      throw new Error('Unexpected SQL in attachment Wiki test')
    }
  }
  const { createWikiServer } = require('./server.cjs')
  const env = { WIKI_COMPILER_INTERNAL_SECRET: 'w'.repeat(64) }
  const server = createWikiServer({ dir, pool, env })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = 'http://127.0.0.1:' + server.address().port
  const headersFor = user => ({
    'X-Wiki-Compiler-Identity': issueIdentity(user, env),
    'Content-Type': 'application/json'
  })
  const post = (pathName, body, user = 'reader') => fetch(base + pathName, {
    method: 'POST', headers: headersFor(user), body: JSON.stringify(body)
  })
  return { roomId, nodeUid, attachmentId, attachmentIds, text, sourceTexts, markdown, state, pool, dir, env, headersFor, post }
}

test('attachment search returns bounded Wiki slices with source provenance', async t => {
  const app = await setup(t)
  const response = await app.post('/api/attachments/search', {
    room_key: app.roomId, node_uid: app.nodeUid, attachment_id: app.attachmentId,
    query: '报销', top_k: 5
  })
  const result = await response.json()
  assert.equal(response.status, 200)
  assert.equal(result.status, 'ok')
  assert.equal(result.complete, false)
  assert.ok(result.items.length <= 5)
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 12 * 1024)
  assert.ok(result.items.every(item => item.text.length <= 800 && item.attachment_id === app.attachmentId))
  assert.equal(result.items[0].source.generation, result.generation)
  assert.equal(result.items[0].source.source_revision, 2)
  assert.equal(result.items[0].source.range.unit, 'utf16')
  const withoutId = await (await app.post('/api/attachments/search', {
    room_key: app.roomId, node_uid: app.nodeUid, query: '报销'
  })).json()
  assert.equal(withoutId.status, 'ok', 'search may cover all currently mounted node attachments without an ID')
})

test('attachment read signs continuation cursors to identity and Wiki generation', async t => {
  const app = await setup(t)
  const request = { room_key: app.roomId, node_uid: app.nodeUid, attachment_id: app.attachmentId, length: 4 }
  const first = await (await app.post('/api/attachments/read', request)).json()
  assert.equal(first.status, 'ok')
  assert.equal(first.text, app.text.slice(0, 4))
  assert.equal(first.complete, false)
  assert.ok(first.next_cursor)
  const second = await (await app.post('/api/attachments/read', { ...request, length: 10000, cursor: first.next_cursor })).json()
  assert.equal(second.status, 'ok')
  assert.equal(second.text, app.text.slice(4))
  assert.equal(second.complete, true)
  assert.equal(second.next_cursor, null)
  const stillWrongIdentity = await (await app.post('/api/attachments/read', { ...request, cursor: first.next_cursor }, 'other-user')).json()
  assert.equal(stillWrongIdentity.status, 'stale')
  assert.equal(stillWrongIdentity.fallback.tool, 'read_attachment')
  const expiredCursor = signCursor({
    sub: 'reader', room_key: app.roomId, node_uid: app.nodeUid, attachment_id: app.attachmentId,
    generation: first.generation, version: first.version, source_revision: first.source_revision,
    content_hash: first.source.content_hash, offset: 0, exp: Date.now() - 1
  }, app.env)
  const expired = await (await app.post('/api/attachments/read', { ...request, cursor: expiredCursor })).json()
  assert.equal(expired.status, 'stale')
  assert.equal(expired.text, '')
  const badSignature = await (await app.post('/api/attachments/read', { ...request, cursor: 'bad.signature' })).json()
  assert.equal(badSignature.status, 'stale')
  assert.equal(badSignature.text, '')
  app.state.revision += 1
  const staleCursor = await (await app.post('/api/attachments/read', { ...request, cursor: first.next_cursor })).json()
  assert.equal(staleCursor.status, 'stale')
  assert.equal(staleCursor.fallback.tool, 'read_attachment')
})

test('non-ready statuses include bounded read fallbacks while detached sources do not', async t => {
  const legacy = await setup(t, { legacy: true })
  const body = { room_key: legacy.roomId, node_uid: legacy.nodeUid, attachment_id: legacy.attachmentId }
  const upgrade = await (await legacy.post('/api/attachments/read', body)).json()
  assert.equal(upgrade.status, 'index_upgrade_required')
  assert.equal(upgrade.fallback.tool, 'read_attachment')

  const missing = await setup(t, { missingSource: true })
  const missingResult = await (await missing.post('/api/attachments/read', {
    room_key: missing.roomId, node_uid: missing.nodeUid, attachment_id: missing.attachmentId
  })).json()
  assert.equal(missingResult.status, 'not_synced')
  assert.equal(missingResult.fallback.tool, 'read_attachment')

  const detached = await setup(t, { mountedId: 'another-file' })
  const notAttached = await (await detached.post('/api/attachments/read', body)).json()
  assert.equal(notAttached.status, 'not_attached')
  assert.equal(notAttached.fallback, undefined)

  const failed = await setup(t, { status: 'failed' })
  const failedBody = { ...body, room_key: failed.roomId, node_uid: failed.nodeUid, attachment_id: failed.attachmentId }
  const failedResult = await (await failed.post('/api/attachments/read', failedBody)).json()
  assert.equal(failedResult.status, 'failed')
  assert.equal(failedResult.fallback.tool, 'read_attachment')
})

test('empty but ready attachment has a valid empty range', async t => {
  const app = await setup(t, { text: '' })
  const body = { room_key: app.roomId, node_uid: app.nodeUid, attachment_id: app.attachmentId }
  const result = await (await app.post('/api/attachments/read', body)).json()
  assert.equal(result.status, 'ok')
  assert.equal(result.text, '')
  assert.equal(result.complete, true)
  assert.equal(result.source.total_chars, 0)
  assert.equal(result.source.range.start, result.source.range.end)
  const noMatch = await (await app.post('/api/attachments/search', { ...body, query: '报销' })).json()
  assert.equal(noMatch.status, 'no_match')
})

test('escaped Chinese, quotes, paths and emoji stay within the serialized response budgets', async t => {
  const text = '甲'.repeat(599) + '🚀' + '乙'.repeat(400) + '合同报价' + ('；长篇中文条款“必须保留合同与报价单”，路径 C:\\\\供应商\\\\审批\\\\记录，示例🙂；字符\u0001。').repeat(240)
  const app = await setup(t, { text })
  const searchResponse = await app.post('/api/attachments/search', {
    room_key: app.roomId, node_uid: app.nodeUid, query: '合同报价'
  })
  const searchRaw = await searchResponse.text()
  const search = JSON.parse(searchRaw)
  assert.equal(search.status, 'ok')
  assert.ok(Buffer.byteLength(searchRaw, 'utf8') <= 12 * 1024)
  assert.ok(search.items.every(item => item.text.length <= 800))
  assert.equal(search.items[0].range.start, 601, 'search windows must not start between an emoji surrogate pair')
  assert.equal(Buffer.from(search.items[0].text, 'utf8').toString('utf8'), search.items[0].text)

  const readResponse = await app.post('/api/attachments/read', {
    room_key: app.roomId, node_uid: app.nodeUid, attachment_id: app.attachmentId, length: 10000
  })
  const readRaw = await readResponse.text()
  const read = JSON.parse(readRaw)
  assert.equal(read.status, 'ok')
  assert.ok(Buffer.byteLength(readRaw, 'utf8') <= 20 * 1024)
  assert.equal(Buffer.from(read.text, 'utf8').toString('utf8'), read.text)
  assert.ok(!read.text.includes('\uFFFD'))
})

test('multi-source failed search remains within JSON budget and carries bounded fallbacks', async t => {
  const attachmentIds = Array.from({ length: 5 }, (_, index) => `file-${index + 1}`)
  const app = await setup(t, { attachmentIds, status: 'failed' })
  const response = await app.post('/api/attachments/search', {
    room_key: app.roomId, node_uid: app.nodeUid, query: '报销'
  })
  const raw = await response.text()
  const result = JSON.parse(raw)
  assert.equal(result.status, 'failed')
  assert.equal(result.sources.length, 5)
  assert.equal(result.fallback.length, 5)
  assert.ok(result.fallback.every(item => item.tool === 'read_attachment'))
  assert.ok(Buffer.byteLength(raw, 'utf8') <= 12 * 1024)
})

test('unauthorized readers cannot use attachment endpoints to discover room sources', async t => {
  const app = await setup(t, { userAllowList: new Set(['reader']) })
  const response = await app.post('/api/attachments/search', {
    room_key: app.roomId, node_uid: app.nodeUid, attachment_id: app.attachmentId, query: '报销'
  }, 'other-user')
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { status: 'not_found' })
})
