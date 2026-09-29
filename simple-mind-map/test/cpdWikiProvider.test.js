'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const { createWikiProvider } = require('../bin/checkRuns/wikiProvider')

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')
}

const BASE = 'http://wiki.test'
const ROOM = 'room-wiki'

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}

function makeChunk({ topic, section, start = 1, content, version = '2026-09-01', source = [], score = 1, matchedTerms, provenance }) {
  return {
    chunk_id: `${topic}::${section}::${start}`, score, topic, section, content, source, version,
    ...(matchedTerms ? { matched_terms: matchedTerms } : {}),
    ...(provenance ? { provenance } : {})
  }
}

function requestPath(url) {
  return new URL(url).pathname
}

function topicBody({ topic, title, sections, status = 'active', lastCompiled = '2026-09-02', provenance }) {
  return {
    slug: topic,
    title,
    meta: { topic, status, last_compiled: lastCompiled },
    sections,
    ...(provenance ? { provenance } : {})
  }
}

function makeProvider(fetchImpl) {
  return createWikiProvider({ env: { CPD_WIKI_API_URL: BASE }, fetchImpl, timeoutMs: 2000 })
}

test('search merges chunks of one topic and keeps different topics as separate candidates', async () => {
  const calls = []
  const results = [
    makeChunk({ topic: '库存盘点 SOP', section: '检查标准', start: 10, content: 'C：库存准确率至少 98%', source: ['Sources/库存制度.md'], score: 3, matchedTerms: ['库存', '检查标准'] }),
    makeChunk({ topic: '库存盘点 SOP', section: '执行步骤', start: 40, content: 'D：每周导出库存记录', source: ['Sources/库存制度.md'], score: 2, matchedTerms: ['库存', '执行步骤'] }),
    makeChunk({ topic: '销售复盘 SOP', section: '目标', start: 5, content: 'P：月销售复盘', score: 1 })
  ]
  const provider = makeProvider(async (url, options) => {
    calls.push({ url: requestPath(url), body: options && options.body ? JSON.parse(options.body) : null })
    return jsonResponse({ query: '库存', results })
  })

  const found = await provider.searchSources({ roomKey: ROOM, query: '库存 频率 判据 责任人' })
  assert.equal(found.status, 'ok')
  assert.equal(found.candidates.length, 2)
  const stock = found.candidates.find(candidate => candidate.title === '库存盘点 SOP')
  assert.equal(stock.sourceRef.topic, '库存盘点 SOP')
  assert.equal(stock.sourceRef.section, '检查标准')
  assert.equal(stock.sourceRef.matches.length, 2)
  assert.deepEqual(stock.sourceRef.matches.map(item => item.section), ['检查标准', '执行步骤'])
  assert.deepEqual(stock.sourceRef.sourcePaths, ['Sources/库存制度.md'])
  assert.equal(stock.sectionCount, 2)
  assert.equal(stock.path, 'Wiki / 库存盘点 SOP / 检查标准')
  assert.equal(stock.complete, false)
  assert.equal(stock.source, 'wiki')
  assert.equal(stock.provenance.origin, 'unknown')
  assert.equal(stock.sourceId, stock.sourceRef.sourceId)
  assert.match(stock.sourceId, /^source-/)
  assert.match(stock.matchReason, /命中词：库存/)
  assert.deepEqual(stock.requiredFields, ['frequency', 'criterion', 'owner'])
  assert.deepEqual(stock.matchedFields, ['frequency', 'criterion'])
  assert.deepEqual(stock.unmatchedFields, ['owner'])
  assert.match(stock.matchReason, /命中片段未覆盖：责任人/)
  assert.deepEqual(stock.referenceDetails.C.map(item => item.text), ['C：库存准确率至少 98%'])
  assert.deepEqual(stock.referenceDetails.D.map(item => item.text), ['D：每周导出库存记录'])
  assert.deepEqual(stock.referenceDetails.fields.criterion, ['C：库存准确率至少 98%'])
  assert.deepEqual(stock.referenceDetails.fields.frequency, ['D：每周导出库存记录'])
  assert.equal(stock.referenceDetails.complete, false)
  assert.equal(stock.sourceRef.roomId, ROOM)
  assert.equal(calls[0].url, '/api/search')
  assert.deepEqual(calls[0].body, { query: '库存 频率 判据 责任人', top_k: 30, mode: 'business' })
})

test('readSource rechecks every merged chunk against the current search and the full topic', async () => {
  const results = [
    makeChunk({ topic: '库存盘点 SOP', section: '检查标准', start: 10, content: 'C：库存准确率至少 98%', source: ['Sources/a.md'] }),
    makeChunk({ topic: '库存盘点 SOP', section: '执行步骤', start: 40, content: 'D：每周导出库存记录', source: ['Sources/b.md'] })
  ]
  const provider = makeProvider(async (url) => {
    const path = requestPath(url)
    if (path === '/api/search') return jsonResponse({ query: '库存', results })
    if (path.startsWith('/api/topic/')) {
      return jsonResponse(topicBody({
        topic: '库存盘点 SOP',
        title: '库存盘点作业指导',
        sections: [
          { heading: '检查标准 [coverage: 2/2]', content: 'C：库存准确率至少 98%' },
          { heading: '执行步骤', content: 'D：每周导出库存记录' },
          { heading: '附注', content: 'P：每月库存盘点计划。\n本主题含完整正文。' }
        ]
      }))
    }
    throw new Error(`unexpected path ${path}`)
  })

  const found = await provider.searchSources({ roomKey: ROOM, query: '库存' })
  assert.equal(found.status, 'ok')
  const read = await provider.readSource({ roomKey: ROOM, sourceRef: found.candidates[0].sourceRef })
  assert.equal(read.status, 'ok')
  assert.equal(read.complete, true)
  assert.equal(read.truncated, false)
  assert.equal(read.title, '库存盘点作业指导')
  assert.equal(read.path, 'Wiki / 库存盘点 SOP / 检查标准')
  assert.deepEqual(read.sourcePaths, ['Sources/a.md', 'Sources/b.md'])
  assert.match(read.version, /^2026-09-02:/)
  assert.match(read.content, /^# 库存盘点作业指导/)
  assert.match(read.content, /## 检查标准 \[coverage: 2\/2\]/, '完整报告保留 topic 原始 heading')
  assert.match(read.content, /本主题含完整正文/)
  assert.equal(read.sectionCount, 2)
  assert.equal(read.kind, 'flow')
  assert.deepEqual(read.coverage, { kind: 'full_topic', sectionCount: 3, complete: true })
  assert.equal(read.referenceDetails.complete, true)
  assert.equal(read.referenceDetails.C.length, 1)
  assert.equal(read.referenceDetails.D.length, 1)
})

test('readSource rejects a chunk that is no longer a valid current search hit', async () => {
  const provider = makeProvider(async (url) => {
    const path = requestPath(url)
    if (path === '/api/search') {
      return jsonResponse({ query: '库存', results: [makeChunk({ topic: '库存盘点 SOP', section: '检查标准', content: '旧正文' })] })
    }
    throw new Error('topic should not be read when the hit is stale')
  })
  const sourceRef = {
    type: 'wiki_compiler', roomId: ROOM, topic: '库存盘点 SOP', section: '检查标准',
    chunkId: '库存盘点 SOP::检查标准::10', query: '库存', chunkHash: 'deadbeef', version: '2026-09-01',
    matches: [{ section: '检查标准', chunkId: '库存盘点 SOP::检查标准::10', chunkHash: 'deadbeef', version: '2026-09-01' }],
    sourcePaths: []
  }
  const read = await provider.readSource({ roomKey: ROOM, sourceRef })
  assert.equal(read.status, 'no_results')
  assert.equal(read.error, 'wiki_chunk_not_current')
  assert.equal(read.complete, false)
})

test('readSource requires an active topic whose slug matches and whose coverage heading is normalized', async () => {
  const content = 'C：库存准确率至少 98%'
  const chunk = makeChunk({ topic: '库存盘点 SOP', section: '检查标准', content })
  const ref = {
    type: 'wiki_compiler', roomId: ROOM, topic: '库存盘点 SOP', section: '检查标准',
    chunkId: chunk.chunk_id, query: '库存', chunkHash: sha256(content),
    version: '2026-09-01', sourcePaths: []
  }
  const provider = topic => makeProvider(async (url) => {
    const path = requestPath(url)
    if (path === '/api/search') return jsonResponse({ query: '库存', results: [chunk] })
    return jsonResponse(topic)
  })

  const mismatch = await provider(topicBody({
    topic: '其他主题', title: '库存盘点作业指导',
    sections: [{ heading: '检查标准 [coverage: 1]', content }]
  })).readSource({ roomKey: ROOM, sourceRef: ref })
  assert.equal(mismatch.status, 'no_results')
  assert.equal(mismatch.error, 'wiki_topic_changed')

  const archived = await provider(topicBody({
    topic: '库存盘点 SOP', title: '库存盘点作业指导', status: 'archived',
    sections: [{ heading: '检查标准 [coverage: 1]', content }]
  })).readSource({ roomKey: ROOM, sourceRef: ref })
  assert.equal(archived.status, 'parse_failed')
  assert.equal(archived.error, 'wiki_topic_not_complete')
})

test('readSource detects changed section content even when the compile date is unchanged', async () => {
  const content = 'C：库存准确率至少 98%'
  const chunk = makeChunk({ topic: '库存盘点 SOP', section: '检查标准', content })
  const sourceRef = {
    type: 'wiki_compiler', roomId: ROOM, topic: '库存盘点 SOP', section: '检查标准',
    chunkId: chunk.chunk_id, query: '库存', chunkHash: sha256(content),
    version: '2026-09-01', sourcePaths: []
  }
  const provider = makeProvider(async (url) => {
    const path = requestPath(url)
    if (path === '/api/search') return jsonResponse({ query: '库存', results: [chunk] })
    return jsonResponse(topicBody({
      topic: '库存盘点 SOP', title: '库存盘点作业指导',
      sections: [{ heading: '检查标准 [coverage: 1]', content: 'C：库存准确率至少 99%' }]
    }))
  })
  const read = await provider.readSource({ roomKey: ROOM, sourceRef })
  assert.equal(read.status, 'no_results')
  assert.equal(read.error, 'wiki_chunk_changed')
})

test('cross-room refs are refused before any request and missing query stays invalid', async () => {
  let calls = 0
  const provider = makeProvider(async () => { calls += 1; return jsonResponse({}) })
  const foreign = await provider.readSource({
    roomKey: ROOM,
    sourceRef: { type: 'wiki_compiler', roomId: 'other-room', topic: '主题', section: '小节', chunkId: '主题::小节::1', query: 'q' }
  })
  assert.equal(foreign.status, 'forbidden')
  assert.equal(foreign.error, 'cross_room_source_ref')
  const noQuery = await provider.readSource({
    roomKey: ROOM,
    sourceRef: { type: 'wiki_compiler', roomId: ROOM, topic: '主题', section: '小节', chunkId: '主题::小节::1', query: '' }
  })
  assert.equal(noQuery.status, 'error')
  assert.equal(noQuery.error, 'invalid_source_ref')
  assert.equal(calls, 0)
})

test('search failures stay typed: forbidden, unavailable, invalid json, invalid items and oversized bodies', async () => {
  const forbidden = await makeProvider(async () => jsonResponse({}, 403))
    .searchSources({ roomKey: ROOM, query: 'q' })
  assert.equal(forbidden.status, 'forbidden')
  assert.equal(forbidden.error, 'wiki_forbidden')

  const unavailable = await makeProvider(async () => jsonResponse({}, 503))
    .searchSources({ roomKey: ROOM, query: 'q' })
  assert.equal(unavailable.status, 'unavailable')

  const network = await makeProvider(async () => { throw new Error('boom') })
    .searchSources({ roomKey: ROOM, query: 'q' })
  assert.equal(network.status, 'unavailable')
  assert.equal(network.error, 'wiki_unreachable')

  const invalidJson = await makeProvider(async () => new Response('not-json', { status: 200 }))
    .searchSources({ roomKey: ROOM, query: 'q' })
  assert.equal(invalidJson.status, 'parse_failed')
  assert.equal(invalidJson.error, 'wiki_invalid_json')

  const invalidItem = await makeProvider(async () => jsonResponse({
    query: 'q', results: [{ topic: '主题', section: '', chunk_id: 'x', content: '正文' }]
  })).searchSources({ roomKey: ROOM, query: 'q' })
  assert.equal(invalidItem.status, 'parse_failed')
  assert.equal(invalidItem.error, 'wiki_invalid_search_item')

  const oversized = await makeProvider(async () => new Response('[]', {
    status: 200, headers: { 'Content-Type': 'application/json', 'content-length': String(2 * 1024 * 1024) }
  })).searchSources({ roomKey: ROOM, query: 'q' })
  assert.equal(oversized.status, 'parse_failed')
  assert.equal(oversized.error, 'wiki_response_too_large')

  const noResults = await makeProvider(async () => jsonResponse({ query: 'q', results: [] }))
    .searchSources({ roomKey: ROOM, query: 'q' })
  assert.equal(noResults.status, 'no_results')
  assert.deepEqual(noResults.candidates, [])
  assert.equal(noResults.complete, true)
})

test('oversized full topics are truncated and never reported as complete evidence', async () => {
  const section = '检查标准'
  const content = `C：${'库'.repeat(200100)}`
  const chunk = makeChunk({ topic: '大主题', section, content })
  const provider = makeProvider(async (url) => {
    const path = requestPath(url)
    if (path === '/api/search') return jsonResponse({ query: '库存', results: [chunk] })
    return jsonResponse(topicBody({ topic: '大主题', title: '大主题', sections: [{ heading: section, content }] }))
  })
  const found = await provider.searchSources({ roomKey: ROOM, query: '库存' })
  const read = await provider.readSource({ roomKey: ROOM, sourceRef: found.candidates[0].sourceRef })
  assert.equal(read.status, 'ok')
  assert.equal(read.truncated, true)
  assert.equal(read.complete, false)
  assert.equal(read.error, 'wiki_topic_too_large')
  assert.equal(read.content.length, 200000)
})

test('demo sources are filtered in business mode and client provenance cannot bypass the policy', async () => {
  const provenance = { origin: 'demo', sourceTitle: '本地验证资料', sourceId: 'local-verify' }
  const chunk = makeChunk({ topic: '会员运营SOP', section: 'D：会员成交', content: 'D：每周跟进会员成交', provenance })
  let topicReads = 0
  const provider = makeProvider(async url => {
    const path = requestPath(url)
    if (path === '/api/search') return jsonResponse({ query: '会员成交', results: [chunk] })
    if (path.startsWith('/api/topic/')) {
      topicReads += 1
      return jsonResponse(topicBody({ topic: '会员运营SOP', title: '会员运营SOP', sections: [{ heading: 'D：会员成交', content: chunk.content }], provenance }))
    }
    throw new Error(`unexpected path ${path}`)
  })

  const business = await provider.searchSources({ roomKey: ROOM, query: '会员成交' })
  assert.equal(business.status, 'no_results')
  assert.equal(business.candidates.length, 0)

  const demo = await provider.searchSources({ roomKey: ROOM, query: '会员成交', mode: 'demo' })
  assert.equal(demo.status, 'ok')
  assert.deepEqual(demo.candidates[0].provenance, provenance)
  assert.equal(demo.candidates[0].independentEvidence, true)

  const forgedRef = { ...demo.candidates[0].sourceRef, provenance: { origin: 'business', sourceTitle: '伪造', sourceId: 'fake' } }
  const denied = await provider.readSource({ roomKey: ROOM, sourceRef: forgedRef, mode: 'business' })
  assert.equal(denied.status, 'forbidden')
  assert.equal(denied.error, 'wiki_demo_source_not_allowed')
  assert.equal(topicReads, 0, 'business mode refuses the search response before reading a demo topic')
})

test('demo mode revalidates actual topic provenance and returns full provenance from Wiki', async () => {
  const provenance = { origin: 'demo', sourceTitle: '验证集', sourceId: 'local-verify' }
  const content = 'D：每周跟进会员成交'
  const chunk = makeChunk({ topic: '会员运营SOP', section: 'D：会员成交', content, provenance })
  const provider = makeProvider(async url => {
    if (requestPath(url) === '/api/search') return jsonResponse({ query: '会员成交', results: [chunk] })
    return jsonResponse(topicBody({
      topic: '会员运营SOP', title: '会员运营SOP', sections: [{ heading: 'D：会员成交', content }], provenance
    }))
  })
  const found = await provider.searchSources({ roomKey: ROOM, query: '会员成交', mode: 'demo' })
  const read = await provider.readSource({ roomKey: ROOM, sourceRef: found.candidates[0].sourceRef, mode: 'demo' })
  assert.equal(read.status, 'ok')
  assert.deepEqual(read.provenance, provenance)
  assert.equal(read.sourceId, found.candidates[0].sourceId)
  assert.equal(read.complete, true)
})

test('request cache shares successful search and full topic reads but retries failures', async () => {
  const calls = []
  const content = 'C：库存准确率达到 98%'
  const chunk = makeChunk({ topic: '库存盘点 SOP', section: 'C：库存目标', content })
  const provenance = { origin: 'business', sourceTitle: '运营制度库', sourceId: 'wiki-ops' }
  const provider = makeProvider(async url => {
    const path = requestPath(url)
    calls.push(path)
    if (path === '/api/search') return jsonResponse({ query: '库存', results: [{ ...chunk, provenance }] })
    return jsonResponse(topicBody({ topic: '库存盘点 SOP', title: '库存盘点SOP', sections: [{ heading: chunk.section, content }], provenance }))
  })
  const requestCache = new Map()
  const found = await provider.searchSources({ roomKey: ROOM, query: '库存', actor: { id: 'u1' }, requestCache })
  const first = await provider.readSource({ roomKey: ROOM, sourceRef: found.candidates[0].sourceRef, actor: { id: 'u1' }, requestCache })
  const second = await provider.readSource({ roomKey: ROOM, sourceRef: found.candidates[0].sourceRef, actor: { id: 'u1' }, requestCache })
  assert.equal(first.status, 'ok')
  assert.equal(second.status, 'ok')
  assert.deepEqual(calls, ['/api/search', '/api/topic/%E5%BA%93%E5%AD%98%E7%9B%98%E7%82%B9%20SOP'])

  let retryCalls = 0
  const retrying = makeProvider(async () => {
    retryCalls += 1
    return retryCalls === 1 ? jsonResponse({}, 503) : jsonResponse({ query: '库存', results: [{ ...chunk, provenance }] })
  })
  const retryCache = new Map()
  assert.equal((await retrying.searchSources({ roomKey: ROOM, query: '库存', requestCache: retryCache })).status, 'unavailable')
  assert.equal((await retrying.searchSources({ roomKey: ROOM, query: '库存', requestCache: retryCache })).status, 'ok')
  assert.equal(retryCalls, 2)
})

test('source identity is stable across versions and does not expose query-specific ids', () => {
  const first = require('../bin/checkRuns/wikiProvider')._internals.sourceIdFor({ type: 'wiki_compiler', roomId: ROOM, topic: '主题', section: '小节', query: 'a', version: '1' })
  const second = require('../bin/checkRuns/wikiProvider')._internals.sourceIdFor({ type: 'wiki_compiler', roomId: ROOM, topic: '主题', section: '另一个小节', query: 'b', version: '2' })
  assert.equal(first, second)
})

test('request cache is isolated by room and actor', async () => {
  let calls = 0
  const provider = makeProvider(async () => {
    calls += 1
    return jsonResponse({ query: '会员', results: [] })
  })
  const requestCache = new Map()
  await provider.searchSources({ roomKey: ROOM, query: '会员', actor: { id: 'user-a' }, requestCache })
  await provider.searchSources({ roomKey: 'another-room', query: '会员', actor: { id: 'user-a' }, requestCache })
  await provider.searchSources({ roomKey: ROOM, query: '会员', actor: { id: 'user-b' }, requestCache })
  assert.equal(calls, 3)
})

test('Wiki search timeout remains unavailable and is not cached', async () => {
  let calls = 0
  const provider = createWikiProvider({
    env: { CPD_WIKI_API_URL: BASE },
    timeoutMs: 5,
    fetchImpl: async (_url, options) => {
      calls += 1
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('timed out')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    }
  })
  const requestCache = new Map()
  const first = await provider.searchSources({ roomKey: ROOM, query: '库存', requestCache })
  const second = await provider.searchSources({ roomKey: ROOM, query: '库存', requestCache })
  assert.equal(first.status, 'unavailable')
  assert.equal(first.error, 'wiki_timeout')
  assert.equal(second.status, 'unavailable')
  assert.equal(calls, 2)
})
