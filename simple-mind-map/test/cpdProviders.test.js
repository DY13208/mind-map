'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const checkProviders = require('../bin/checkRuns/providers')
const { createCheckProviders } = checkProviders

function rpcToolResponse(value, { isError = false } = {}) {
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      ...(isError ? { isError: true } : {})
    }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

test('Wiki scope reports wiki_not_configured without making a network request', async () => {
  let calls = 0
  const providers = createCheckProviders({
    env: { CPD_WIKI_API_URL: '' },
    tokenIssuer: () => 'test-token',
    fetchImpl: async () => { calls += 1; throw new Error('must not call Wiki') }
  })

  const result = await providers.searchSources({
    roomKey: 'room-a',
    query: '缺少验收标准',
    scope: 'wiki',
    actor: { id: 'user-a' }
  })

  assert.equal(result.status, 'unavailable')
  assert.equal(result.error, 'wiki_not_configured')
  assert.equal(result.complete, false)
  assert.equal(calls, 0)
})

test('Wiki scope forwards business/demo mode and preserves provenance, stable identity and field coverage', async () => {
  const requests = []
  const providers = createCheckProviders({
    env: { CPD_WIKI_API_URL: 'http://wiki.test' },
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) })
      return new Response(JSON.stringify({ query: '会员成交 频率', results: [{
        chunk_id: '会员流程::D：成交::1', score: 10, topic: '会员流程', section: 'D：成交',
        content: 'D：每周复核会员成交记录', matched_terms: ['会员', '成交', '频率'],
        provenance: { origin: 'business', sourceTitle: '正式运营资料', sourceId: 'wiki-operations' },
        source: ['Sources/会员制度.md'], version: '2026-09-28'
      }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
  })
  const found = await providers.searchSources({
    roomKey: 'room-a',
    query: '库存 频率',
    businessContext: { texts: ['C：会员成交率95%'] },
    scope: 'wiki',
    mode: 'business',
    actor: { id: 'user-a' }
  })
  assert.equal(found.status, 'ok')
  assert.equal(found.candidates[0].provenance.origin, 'business')
  assert.equal(found.candidates[0].provenance.sourceTitle, '正式运营资料')
  assert.equal(found.candidates[0].sourceId, found.candidates[0].sourceRef.sourceId)
  assert.deepEqual(found.candidates[0].requiredFields, ['frequency'])
  assert.deepEqual(found.candidates[0].matchedFields, ['frequency'])
  assert.deepEqual(requests[0].body, { query: '会员成交率', top_k: 30, mode: 'business' })
})

test('company knowledge uses the current user JWT and restricts every search/read to the current room', async () => {
  const calls = []
  const providers = createCheckProviders({
    env: { KNOWLEDGE_MCP_URL: 'http://knowledge.test/mcp' },
    tokenIssuer: userId => `signed-for-${userId}`,
    fetchImpl: async (url, options) => {
      const request = JSON.parse(options.body)
      calls.push({ url, headers: options.headers, ...request })
      const tool = request.params.name
      if (tool === 'canonical_list') {
        return rpcToolResponse([{
          roomId: 'room-a',
          title: '招聘流程',
          uri: 'canonical://room/room-a/branches/recruit.md',
          version: 'stale-list-v2'
        }])
      }
      if (tool === 'canonical_read') {
        return rpcToolResponse({
          roomId: 'room-a',
          title: '招聘流程',
          uri: 'canonical://room/room-a/branches/recruit.md',
          body: '每周核对招聘目标，面试评价标准由项目负责人确认。',
          version: 'kb-v3'
        })
      }
      if (tool === 'docmost_search' || tool === 'openwiki_search') return rpcToolResponse([])
      throw new Error(`Unexpected tool ${tool}`)
    }
  })

  const found = await providers.searchSources({
    roomKey: 'room-a',
    query: '招聘目标',
    scope: 'company_ai',
    actor: { id: 'user-a' }
  })
  assert.equal(found.status, 'ok')
  assert.equal(found.candidates.length, 1)
  assert.equal(found.candidates[0].source, 'canonical')
  assert.equal(found.candidates[0].independentEvidence, true)
  assert.equal(found.candidates[0].sourceRole, 'canonical')
  assert.equal(found.candidates[0].complete, true)
  assert.equal(found.candidates[0].sourceRef.roomId, 'room-a')

  const read = await providers.readSource({
    roomKey: 'room-a',
    sourceRef: found.candidates[0].sourceRef,
    actor: { id: 'user-a' }
  })
  assert.equal(read.status, 'ok')
  assert.equal(read.content, '每周核对招聘目标，面试评价标准由项目负责人确认。')
  assert.equal(read.complete, true)
  assert.match(read.version, /^kb-v3:/)
  assert.equal(found.candidates[0].version, read.version)
  assert.equal(read.independentEvidence, true)
  assert.equal(read.sourceHash.length, 64)
  assert.match(read.version, new RegExp(read.sourceHash))

  assert.ok(calls.length >= 5)
  assert.ok(calls.every(call => call.headers.Authorization === 'Bearer signed-for-user-a'))
  assert.ok(calls.every(call => call.params.arguments.roomId === 'room-a'))
  assert.ok(calls.every(call => [
    'canonical_list', 'canonical_read', 'docmost_search', 'openwiki_search'
  ].includes(call.params.name)))
})

test('canonical UUID filenames resolve to the actual room node title instead of showing an identifier', async () => {
  const uid = '11111111-1111-4111-8111-111111111111'
  const dbCalls = []
  const providers = createCheckProviders({
    db: { async query(sql, params) {
      dbCalls.push({ sql, params })
      if (/select data from room_nodes/i.test(sql)) return { rows: [{ data: { text: '会员成交流程' } }] }
      throw new Error(`Unexpected SQL: ${sql}`)
    } },
    env: { KNOWLEDGE_MCP_URL: 'http://knowledge.test/mcp' },
    tokenIssuer: () => 'signed-token',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body)
      const tool = request.params.name
      if (tool === 'canonical_list') return rpcToolResponse([{
        roomId: 'room-a', title: uid,
        uri: `canonical://room/room-a/branches/${uid}.md`
      }])
      if (tool === 'canonical_read') return rpcToolResponse({
        roomId: 'room-a', title: uid, body: '每周复核成交记录。', version: 'v1'
      })
      if (tool === 'docmost_search' || tool === 'openwiki_search') return rpcToolResponse([])
      throw new Error(`Unexpected tool ${tool}`)
    }
  })

  const found = await providers.searchSources({
    roomKey: 'room-a', query: '会员成交', scope: 'company_ai', actor: { id: 'user-a' }
  })
  assert.equal(found.status, 'ok')
  assert.equal(found.candidates[0].title, '会员成交流程')
  assert.deepEqual(dbCalls[0].params, ['room-a', uid])
  assert.match(found.candidates[0].path, new RegExp(uid))
})

test('chain_node reads return the exact full text and version used by local evidence', async () => {
  const data = { text: 'D：会员成交', note: '输入源：会员 CRM\n每周复盘' }
  const providers = createCheckProviders({
    db: { async query(sql, params) {
      assert.match(sql, /select uid, data, node_version from room_nodes/i)
      assert.deepEqual(params, ['room-a', 'node-a'])
      return { rows: [{ uid: 'node-a', data, node_version: 12 }] }
    } },
    env: {},
    fetchImpl: async () => { throw new Error('chain reads must remain local') }
  })
  const read = await providers.readSource({
    roomKey: 'room-a', sourceRef: { type: 'chain_node', roomKey: 'room-a', nodeUid: 'node-a' }, actor: { id: 'user-a' }
  })
  const expected = `D：会员成交\n输入源：会员 CRM\n每周复盘\n${JSON.stringify(data)}`
  const expectedHash = require('node:crypto').createHash('sha256').update(expected).digest('hex')
  assert.equal(read.status, 'ok')
  assert.equal(read.content, expected)
  assert.equal(read.version, expectedHash)
  assert.equal(read.sourceHash, expectedHash)
  assert.equal(read.complete, true)
  assert.equal(read.provenance.origin, 'business')
})

test('MCP ACL denial stays forbidden instead of becoming a no-results answer', async () => {
  const providers = createCheckProviders({
    env: { KNOWLEDGE_MCP_URL: 'http://knowledge.test/mcp' },
    tokenIssuer: () => 'signed-token',
    fetchImpl: async () => rpcToolResponse({ error: 'forbidden', message: 'denied' }, { isError: true })
  })

  const result = await providers.searchSources({
    roomKey: 'room-a',
    query: '目标',
    scope: 'company_ai',
    actor: { id: 'user-a' }
  })
  assert.equal(result.status, 'forbidden')
  assert.equal(result.complete, false)
  assert.deepEqual(result.candidates, [])
})

test('canonical room-storage permission errors use a stable non-ACL code and survive partial results', async () => {
  const rawError = 'EACCES: permission denied, scandir /data/rooms/room-a'
  const makeProviders = ({ canonicalFailure = true, includeOpenwiki = false } = {}) => createCheckProviders({
    env: { KNOWLEDGE_MCP_URL: 'http://knowledge.test/mcp' },
    tokenIssuer: () => 'signed-token',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body)
      const tool = request.params.name
      if (tool === 'canonical_list') return canonicalFailure
        ? rpcToolResponse({ error: rawError }, { isError: true })
        : rpcToolResponse([])
      if (tool === 'docmost_search' || tool === 'docmost_get') return rpcToolResponse([])
      if (tool === 'openwiki_search') return rpcToolResponse(includeOpenwiki ? [{ title: '库存记录指南',
        uri: 'openwiki://room/room-a/guides/stock.md', snippet: '库存记录每日更新。' }] : [])
      throw new Error(`Unexpected tool ${tool}`)
    }
  })

  const providers = makeProviders()
  const unavailable = await providers.searchSources({
    roomKey: 'room-a', query: '库存记录', scope: 'company_ai', actor: { id: 'user-a' }
  })
  assert.equal(unavailable.status, 'unavailable', 'storage permission is not the user ACL forbidden state')
  assert.equal(unavailable.error, 'canonical_storage_permission_denied')
  assert.deepEqual(unavailable.candidates, [])
  assert.deepEqual(unavailable.errors, [rawError])

  const partial = await makeProviders({ includeOpenwiki: true }).searchSources({
    roomKey: 'room-a', query: '库存记录', scope: 'company_ai', actor: { id: 'user-a' }
  })
  assert.equal(partial.status, 'ok', 'available independent search results remain usable')
  assert.equal(partial.complete, false, 'a failed canonical branch prevents claiming complete search')
  assert.equal(partial.error, 'canonical_storage_permission_denied')
  assert.deepEqual(partial.errors, [rawError])
  assert.equal(partial.candidates.length, 1)

  const noResults = await makeProviders({ canonicalFailure: false }).searchSources({
    roomKey: 'room-a', query: '库存记录', scope: 'company_ai', actor: { id: 'user-a' }
  })
  assert.equal(noResults.status, 'no_results')
  assert.equal(noResults.complete, true)
  assert.deepEqual(noResults.errors, [])
})

test('a source reference from another room cannot be read', async () => {
  let calls = 0
  const providers = createCheckProviders({
    env: { KNOWLEDGE_MCP_URL: 'http://knowledge.test/mcp' },
    tokenIssuer: () => 'signed-token',
    fetchImpl: async () => { calls += 1; return rpcToolResponse({}) }
  })
  const result = await providers.readSource({
    roomKey: 'room-a',
    sourceRef: { type: 'canonical', roomId: 'room-b', path: 'README.md' },
    actor: { id: 'user-a' }
  })
  assert.equal(result.status, 'forbidden')
  assert.equal(result.error, 'cross_room_source_ref')
  assert.equal(calls, 0)
})

test('map search and source reads use the provided room DB without calling external services', async () => {
  const dbCalls = []
  const db = {
    async query(sql, params) {
      dbCalls.push({ sql, params })
      if (/select uid, parent_uid, position, data, node_version\s+from room_nodes where room_key=\$1 and uid=\$2/i.test(sql)) {
        return { rows: [{ uid: 'n1', parent_uid: null, position: '00000001', data: { text: '库存周转目标' }, node_version: 4 }] }
      }
      if (/parent_uid = any/i.test(sql)) return { rows: [] }
      if (/from matched join node_attachments/i.test(sql)) return { rows: [] }
      throw new Error('Unexpected SQL')
    }
  }
  const providers = createCheckProviders({
    db,
    searchRoomNodes: async (actualDb, roomKey, query, options) => {
      assert.equal(actualDb, db)
      assert.equal(roomKey, 'room-a')
      assert.equal(options.limit, 100)
      return { matches: [{ uid: 'n1', text: '库存周转目标', note: '每周更新', parent_uid: 'p1', path: ['p1', 'n1'] }] }
    },
    env: {},
    fetchImpl: async () => { throw new Error('map search should stay local') }
  })
  const found = await providers.searchSources({
    roomKey: 'room-a', query: '库存周转', scope: 'map_knowledge', actor: { id: 'user-a' }
  })
  assert.equal(found.status, 'ok')
  assert.equal(found.candidates[0].sourceRef.uid, 'n1')

  const read = await providers.readSource({
    roomKey: 'room-a', sourceRef: found.candidates[0].sourceRef, actor: { id: 'user-a' }
  })
  assert.equal(read.status, 'ok')
  assert.match(read.content, /库存周转目标/)
  assert.equal(read.complete, true)
  assert.match(read.version, /^4:/)
  assert.equal(read.sourceHash.length, 64)
  assert.equal(dbCalls.every(call => call.params[0] === 'room-a'), true)
})

test('chain-local search uses only compact CPD records and map search excludes those chain UIDs', async () => {
  const providers = createCheckProviders({
    db: { query: async () => ({ rows: [] }) },
    env: {},
    searchRoomNodes: async () => ({ matches: [
      { uid: 'c1', text: 'C：库存周转率保持在 10%' },
      { uid: 'other', text: '库存周转异常处理资料' }
    ] }),
    fetchImpl: async () => { throw new Error('local scopes must not call external services') }
  })
  const chain = {
    chainUid: 'owner',
    nodeUids: ['owner', 'c1', 'p1', 'd1'],
    path: [{ uid: 'owner', text: '库存周转流程' }],
    check: [{ uid: 'c1', text: 'C：库存周转率保持在 10%', note: '每周核验' }],
    plan: [{ uid: 'p1', text: 'P：每周盘点' }],
    execution: [{ uid: 'd1', text: 'D：导出系统数据' }]
  }
  const local = await providers.searchSources({
    roomKey: 'room-a', query: '库存周转', scope: 'chain', chain, actor: { id: 'user-a' }
  })
  assert.equal(local.status, 'ok')
  assert.equal(local.candidates.length, 1)
  assert.equal(local.candidates[0].sourceRef.uid, 'c1')
  assert.equal(local.candidates[0].kind, 'unknown')

  const map = await providers.searchSources({
    roomKey: 'room-a', query: '库存周转', scope: 'map_knowledge',
    chain: { nodeUids: ['c1'], excludeUids: ['c1'] }, actor: { id: 'user-a' }
  })
  assert.deepEqual(map.candidates.map(candidate => candidate.sourceRef.uid), ['other'])
})

test('map subtree reads preserve note line breaks, classify rendered CPD headings, and require full attachment text', async () => {
  const body = '附件原文第一行\n附件原文第二行'
  const makeDb = (attachment, bareRoles = false) => ({
    async query(sql, params) {
      if (/select uid, parent_uid, position, data, node_version\s+from room_nodes where room_key=\$1 and uid=\$2/i.test(sql)) {
        return { rows: [{ uid: 'root', parent_uid: null, position: '0001', data: { text: '库存流程' }, node_version: 5 }] }
      }
      if (/parent_uid = any/i.test(sql)) {
        const parents = params[1]
        const nodes = [
          { uid: 'c1', parent_uid: 'root', position: '0001', data: { text: bareRoles ? '## **C**' : 'C：库存周转率达到 10%', note: '第一行说明\n第二行说明', attachments: [{ id: 'a1' }] }, node_version: 1 },
          { uid: 'p1', parent_uid: 'root', position: '0002', data: { text: bareRoles ? '**P**' : 'P：每周盘点' }, node_version: 1 },
          { uid: 'd1', parent_uid: 'root', position: '0003', data: { text: bareRoles ? '# D' : 'D：导出库存报表' }, node_version: 1 }
        ]
        return { rows: nodes.filter(node => parents.includes(node.parent_uid)) }
      }
      if (/from matched join node_attachments/i.test(sql)) return { rows: attachment ? [attachment] : [] }
      throw new Error('Unexpected SQL')
    }
  })
  const readyAttachment = {
    id: 'a1', node_uid: 'shared-owner', file_name: '库存记录.txt', content_hash: 'content-hash',
    status: 'ready', updated_at: '2026-09-28T00:00:00Z', total_chars: body.length, content: body
  }
  const providers = createCheckProviders({ db: makeDb(readyAttachment), env: {}, fetchImpl: async () => { throw new Error('no external call') } })
  const read = await providers.readSource({
    roomKey: 'room-a', sourceRef: { type: 'map_node', roomId: 'room-a', uid: 'root' }, actor: { id: 'user-a' }
  })
  assert.equal(read.status, 'ok')
  assert.equal(read.complete, true)
  assert.equal(read.kind, 'flow')
  assert.match(read.content, /第一行说明\n第二行说明/)
  assert.match(read.content, new RegExp(body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  const bareRoleProviders = createCheckProviders({ db: makeDb(readyAttachment, true), env: {}, fetchImpl: async () => { throw new Error('no external call') } })
  const bareRoleRead = await bareRoleProviders.readSource({
    roomKey: 'room-a', sourceRef: { type: 'map_node', roomId: 'room-a', uid: 'root' }, actor: { id: 'user-a' }
  })
  assert.equal(bareRoleRead.kind, 'flow')

  const incompleteProviders = createCheckProviders({
    db: makeDb({ ...readyAttachment, status: 'ready', total_chars: 0, content: '' }),
    env: {}, fetchImpl: async () => { throw new Error('no external call') }
  })
  const incomplete = await incompleteProviders.readSource({
    roomKey: 'room-a', sourceRef: { type: 'map_node', roomId: 'room-a', uid: 'root' }, actor: { id: 'user-a' }
  })
  assert.equal(incomplete.complete, false)
  assert.equal(incomplete.error, 'attachment_text_missing')
})

test('check providers expose only source search/read and do not inspect model configuration', () => {
  let modelConfigReads = 0
  let modelEnvironmentReads = 0
  let networkCalls = 0
  const env = new Proxy({}, {
    get(_target, key) {
      if (/^(OPENCLAW|DEEPSEEK|CPD_CHECK_MODEL)/.test(String(key))) {
        modelEnvironmentReads += 1
        throw new Error(`check provider must not read ${String(key)}`)
      }
      return undefined
    }
  })
  const options = {
    env,
    fetchImpl: async () => { networkCalls += 1; throw new Error('must not call a model provider') }
  }
  for (const key of ['fsImpl', 'resolveModelConfig', 'modelTimeoutMs']) {
    Object.defineProperty(options, key, {
      get() {
        modelConfigReads += 1
        throw new Error(`check provider must not inspect ${key}`)
      }
    })
  }

  const providers = createCheckProviders(options)
  assert.deepEqual(Object.keys(providers).sort(), ['readSource', 'searchSources'])
  assert.equal('judgeSemantics' in providers, false)
  assert.equal('modelConfigFromOpenClaw' in checkProviders, false)
  assert.equal('modelCompletionUrl' in checkProviders, false)
  assert.equal('SEMANTIC_SYSTEM_PROMPT' in checkProviders, false)
  assert.equal(modelConfigReads, 0)
  assert.equal(modelEnvironmentReads, 0)
  assert.equal(networkCalls, 0)
})
