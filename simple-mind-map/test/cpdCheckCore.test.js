'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const core = require('../bin/checkRuns')

const ROOM = 'room-check-test'
const ACTOR = { id: 'checker-1' }

function parseJson(value, fallback) {
  if (value == null) return fallback
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return fallback }
}

function makeMemoryDb() {
  const runs = []
  const writes = []
  let createdSequence = 0
  return {
    runs,
    writes,
    async query(sql, params = []) {
      const statement = String(sql)
      if (/create table if not exists check_runs/i.test(statement)) return { rows: [] }
      if (/^\s*select\s+\*\s+from\s+check_runs/i.test(statement)) {
        if (/order\s+by\s+created_at\s+desc/i.test(statement)) {
          const byNode = /node_uid\s*=\s*\$2/i.test(statement)
          const matching = runs
            .filter(item => item.room_key === String(params[0]))
            .filter(item => !byNode || item.node_uid === String(params[1]))
            .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
          const limit = Number(params[params.length - 2]) || matching.length
          const offset = Number(params[params.length - 1]) || 0
          return { rows: matching.slice(offset, offset + limit).map(row => structuredClone(row)) }
        }
        let row
        if (/actor_id\s*=\s*\$2/i.test(statement) && /request_id\s*=\s*\$3/i.test(statement)) {
          row = runs.find(item => item.room_key === String(params[0]) && item.actor_id === String(params[1]) && item.request_id === String(params[2]))
        } else {
          row = runs.find(item => item.room_key === String(params[0]) && item.run_id === String(params[1]))
        }
        return { rows: row ? [structuredClone(row)] : [] }
      }
      if (/^\s*insert\s+into\s+check_runs/i.test(statement)) {
        writes.push(statement)
        const existing = runs.find(item => item.room_key === String(params[1]) && item.actor_id === String(params[3]) && item.request_id === String(params[4]))
        if (existing) return { rows: [] }
        const row = {
          run_id: params[0], room_key: params[1], node_uid: params[2], actor_id: params[3], request_id: params[4],
          map_version: params[5], chain_fingerprint: params[6], rule_version: params[7], status: params[8],
          source_refs: parseJson(params[9], []), selection: parseJson(params[10], {}), report: parseJson(params[11], {}),
          created_at: new Date(Date.now() + createdSequence++).toISOString(),
          updated_at: new Date(Date.now() + createdSequence).toISOString(), confirmed_at: null
        }
        runs.push(row)
        return { rows: [structuredClone(row)] }
      }
      if (/^\s*update\s+check_runs/i.test(statement)) {
        writes.push(statement)
        const row = runs.find(item => item.room_key === String(params[0]) && item.run_id === String(params[1]))
        if (!row) return { rows: [] }
        if (/selection\s*=\s*coalesce\(selection/i.test(statement)) {
          if (row.status !== 'needs_confirmation' || row.selection.confirmationState === 'processing') return { rows: [] }
          Object.assign(row.selection, parseJson(params[2], {}))
        } else {
          const expected = params[9]
          if (expected && row.selection.confirmationState !== expected) return { rows: [] }
          if (params[10] != null && Number(row.report.revision || 1) !== Number(params[10])) return { rows: [] }
          if (params[2] != null) row.status = params[2]
          if (params[3] != null) row.source_refs = parseJson(params[3], row.source_refs)
          if (params[4] != null) row.selection = parseJson(params[4], row.selection)
          if (params[5] != null) row.report = parseJson(params[5], row.report)
          if (params[6] != null) row.chain_fingerprint = params[6]
          if (params[7] != null) row.map_version = params[7]
          if (params[8] != null) row.confirmed_at = params[8]
        }
        row.updated_at = new Date().toISOString()
        return { rows: [structuredClone(row)] }
      }
      throw new Error(`Unexpected SQL in core test: ${statement.slice(0, 100)}`)
    }
  }
}

function makeSnapshot({
  mapVersion = 'map-v1',
  bareRoles = true,
  input = '库存记录',
  materialText = '库存记录：每日库存盘点明细，准确率达到 98%。',
  sourceComplete = true,
  sourceStatus = 'ready',
  includeSource = true,
  missingOwner = false,
  ambiguous = false
} = {}) {
  const nodes = {
    owner: { uid: 'owner', text: '库存盘点流程', children: [] },
    cRoot: { uid: 'cRoot', text: bareRoles ? 'C' : 'C：库存盘点准确率至少达到 98%；未达标时通知仓库主管复核并补录。', children: [] },
    pRoot: { uid: 'pRoot', text: bareRoles ? 'P' : 'P：库存盘点准确率至少达到 98%。', children: [] },
    d1: {
      uid: 'd1', text: 'D：每周核对库存记录', note: `频率：每周\n输入源：${input}\n判据：库存记录准确率至少达到 98%。`,
      data: {
        frequency: '每周', inputs: input, criterion: '库存记录准确率至少达到 98%',
        ...(missingOwner ? {} : { owner: '仓库主管' }), outputs: '生成库存盘点记录',
        attachments: includeSource ? [{ id: 'att-1' }] : []
      }, children: []
    }
  }
  if (bareRoles) {
    nodes.cRoot.children = ['c1']
    nodes.pRoot.children = ['p1', 'd1']
    nodes.c1 = { uid: 'c1', text: 'C：库存盘点准确率至少达到 98%；未达标时通知仓库主管复核并补录。', children: [] }
    nodes.p1 = { uid: 'p1', text: 'P：库存记录准确率至少达到 98%。', children: [] }
  } else {
    nodes.pRoot.children = ['d1']
  }
  if (ambiguous) {
    nodes.owner.children = ['cRoot', 'cRoot2', 'pRoot', 'pRoot2']
    nodes.cRoot2 = { uid: 'cRoot2', text: 'C', children: ['c2'] }
    nodes.c2 = { uid: 'c2', text: 'C：销售准确率至少达到 95%；未达标时通知主管复核。', children: [] }
    nodes.pRoot2 = { uid: 'pRoot2', text: 'P', children: ['p2'] }
    nodes.p2 = { uid: 'p2', text: 'P：销售记录准确率至少达到 95%。', children: [] }
  } else {
    nodes.owner.children = ['cRoot', 'pRoot']
  }

  const sources = includeSource ? [{
    sourceRef: { type: 'attachment', roomId: ROOM, id: 'att-1', nodeUid: 'd1' },
    nodeUid: 'd1', title: '库存记录', source: 'attachment', version: 'att-v1',
    status: sourceStatus, complete: sourceComplete, truncated: !sourceComplete,
    content: materialText
  }] : []
  return { mapVersion, nodes, sources }
}

function makeDeps({ db = makeMemoryDb(), snapshot = makeSnapshot(), judge, search, readSource } = {}) {
  return {
    db,
    loadSnapshot: async () => snapshot,
    ...(judge ? { judgeSemantics: judge } : {}),
    searchSources: search || (async () => ({ status: 'no_results', candidates: [], complete: true })),
    readSource: readSource || (async () => ({ status: 'no_results', complete: false, truncated: false }))
  }
}

async function create(snapshot, deps, requestId = `req-${Math.random()}`, nodeUid = 'd1') {
  return core.createCheck({ roomKey: ROOM, nodeUid, actor: ACTOR, requestId }, deps)
}

test('静态检查保留 C/P/D 原文；文字关系待核对但不调用模型、不触发无关检索', async () => {
  const snapshot = makeSnapshot({ bareRoles: true })
  const original = structuredClone(snapshot)
  const db = makeMemoryDb()
  const calls = { judge: 0, search: 0 }
  const deps = makeDeps({ db, snapshot,
    judge: async () => { calls.judge += 1; throw new Error('must not run') },
    search: async () => { calls.search += 1; return { status: 'no_results', candidates: [] } }
  })
  const run = await create(snapshot, deps, 'static-chain')

  assert.equal(run.status, 'needs_confirmation')
  for (const ruleId of ['CK-10', 'CK-11', 'CK-27', 'CK-28']) {
    const items = run.report.findings.filter(item => item.ruleId === ruleId)
    assert.ok(items.length > 0, `${ruleId} should be present`)
    assert.ok(items.every(item => item.status === 'needs_info'))
    assert.ok(items.every(item => item.validationType === 'manual_text_review'))
  }
  assert.ok(run.report.findings.some(item => item.ruleId === 'CK-29' && item.status === 'needs_info'))
  assert.ok(run.report.findings.some(item => item.ruleId === 'CK-09' && item.status === 'passed'))
  assert.ok(!run.report.findings.some(item => ['CK-27', 'CK-28'].includes(item.ruleId) && item.status === 'passed'))
  assert.ok(run.report.findings.find(item => item.ruleId === 'CK-27').evidence.includes('库存盘点准确率'))
  assert.ok(run.report.findings.find(item => item.ruleId === 'CK-27').evidence.includes('库存记录准确率'))
  assert.equal(Object.hasOwn(run.report, 'semanticService'), false)
  assert.equal(Object.hasOwn(run.report, 'requiredSemanticChecks'), false)
  assert.deepEqual(calls, { judge: 0, search: 0 })
  assert.deepEqual(snapshot, original)
  assert.ok(db.writes.every(sql => /check_runs/i.test(sql)))
  assert.equal(db.runs.length, 1)
})

test('嵌套 C 到 P 到 D 布局可被静态规则读取', async () => {
  const snapshot = makeSnapshot({ bareRoles: false })
  snapshot.nodes.owner.children = ['cRoot']
  snapshot.nodes.cRoot.children = ['pRoot']
  const run = await create(snapshot, makeDeps({ snapshot }), 'nested-cpd')
  assert.notEqual(run.status, 'passed')
  assert.ok(run.report.chain.checkRootUids.includes('cRoot'))
  assert.ok(run.report.chain.planRootUids.includes('pRoot'))
})

test('目标直接写在 C/P role 根节点上时只列原文，不推断两者对应', async () => {
  const snapshot = makeSnapshot({ bareRoles: false })
  const run = await create(snapshot, makeDeps({ snapshot }), 'role-roots')
  assert.ok(run.report.findings.some(item => item.ruleId === 'CK-27' && item.status === 'needs_info' && item.nodeUid === 'cRoot'))
  assert.ok(run.report.findings.some(item => item.ruleId === 'CK-28' && item.status === 'needs_info' && item.nodeUid === 'pRoot'))
})

test('多个可能的 CPD 对应关系仍要求选链，且模型回调完全不执行', async () => {
  const snapshot = makeSnapshot({ ambiguous: true })
  let judgeCalls = 0
  const run = await create(snapshot, makeDeps({ snapshot,
    judge: async () => { judgeCalls += 1; return { status: 'ok', findings: [] } }
  }), 'ambiguous', 'owner')
  assert.equal(run.status, 'needs_confirmation')
  assert.ok(run.report.candidates.length > 1)
  assert.equal(judgeCalls, 0)
})

test('只有文字核对项时不搜索知识库；同一请求复用报告也不调用模型', async () => {
  const snapshot = makeSnapshot()
  const calls = { judge: 0, search: 0 }
  const deps = makeDeps({ snapshot,
    judge: async () => { calls.judge += 1; return { status: 'ok', findings: [] } },
    search: async () => { calls.search += 1; return { status: 'no_results', candidates: [] } }
  })
  const first = await create(snapshot, deps, 'idempotent-request')
  const repeated = await create(snapshot, deps, 'idempotent-request')
  assert.equal(first.runId, repeated.runId)
  assert.deepEqual(calls, { judge: 0, search: 0 })
  await assert.rejects(
    () => create(snapshot, deps, 'idempotent-request', 'owner'),
    error => error && error.code === 'REQUEST_TARGET_MISMATCH'
  )
  assert.deepEqual(calls, { judge: 0, search: 0 })
})

test('不完整附件及知识库无权限不能解释为材料齐备', async () => {
  const snapshot = makeSnapshot({ sourceComplete: false, sourceStatus: 'processing' })
  const scopes = []
  let judgeCalls = 0
  const run = await create(snapshot, makeDeps({ snapshot,
    judge: async () => { judgeCalls += 1; return { status: 'ok', findings: [] } },
    search: async ({ scope }) => {
      scopes.push(scope)
      return scope === 'company_ai'
        ? { status: 'forbidden', candidates: [], complete: false, error: 'acl_denied' }
        : { status: scope === 'wiki' ? 'unavailable' : 'no_results', candidates: [], complete: false }
    }
  }), 'source-acl-incomplete')

  assert.notEqual(run.status, 'passed')
  assert.ok(run.report.findings.some(item => item.ruleId === 'CK-29' && item.status !== 'passed'))
  assert.ok(run.report.sourceStatuses.some(item => item.scope === 'company_ai' && item.status === 'forbidden'))
  assert.deepEqual(scopes, ['map_knowledge', 'company_ai', 'wiki'])
  assert.equal(judgeCalls, 0)
})

test('多项材料只命中其中一项时，未命中的材料仍待补充', async () => {
  const snapshot = makeSnapshot({ input: '库存记录、销售记录', materialText: '库存记录：每日库存盘点明细，准确率达到 98%。' })
  let judgeCalls = 0
  const run = await create(snapshot, makeDeps({ snapshot,
    judge: async () => { judgeCalls += 1; return { status: 'ok', findings: [] } }
  }), 'two-materials-one-reference')
  const materialFindings = run.report.findings.filter(item => item.ruleId === 'CK-29')
  assert.equal(materialFindings.length, 2)
  assert.ok(materialFindings.some(item => item.localEvidenceFound))
  assert.ok(materialFindings.some(item => item.status === 'needs_info' && item.validationType !== 'manual_text_review'))
  assert.notEqual(run.status, 'passed')
  assert.equal(judgeCalls, 0)
})

test('知识库材料候选只作补充依据，不写回脑图或判为通过', async () => {
  const snapshot = makeSnapshot({ includeSource: false, missingOwner: true })
  const candidate = {
    candidateId: 'kb-material-1', kind: 'material', sourceRole: 'canonical',
    sourceRef: { type: 'canonical', roomId: ROOM, path: 'materials/inventory.md' },
    title: '库存记录', path: 'materials/inventory.md', source: 'canonical',
    matchReason: '命中库存记录', summary: '库存记录材料', version: 'kb-v1', complete: true,
    independentEvidence: true
  }
  let sourceReads = 0
  let judgeCalls = 0
  const deps = makeDeps({ snapshot,
    judge: async () => { judgeCalls += 1; return { status: 'ok', findings: [] } },
    search: async ({ scope }) => scope === 'company_ai'
      ? { status: 'ok', candidates: [candidate], complete: true }
      : { status: 'no_results', candidates: [], complete: true },
    readSource: async () => {
      sourceReads += 1
      return {
        status: 'ok', sourceRef: candidate.sourceRef, version: 'kb-v1:hash', sourceHash: 'hash',
        content: '库存记录：完整的每日盘点标准和记录字段。', complete: true, truncated: false,
        independentEvidence: true, kind: 'material', sourceRole: 'canonical'
      }
    }
  })
  const pending = await create(snapshot, deps, 'kb-material-pending')
  assert.equal(pending.status, 'needs_confirmation')
  assert.ok(pending.report.findings.some(item => item.ruleId === 'CK-09' && item.status === 'needs_supplement'))
  assert.equal(pending.report.materialCandidates[0].candidateId, candidate.candidateId)
  assert.ok(pending.report.sources.some(source => source.sourceRef.path === candidate.sourceRef.path))
  assert.equal(pending.selection.sourceRef, undefined)
  assert.equal(sourceReads, 1)
  assert.equal(judgeCalls, 0)
  assert.ok(pending.report.findings.some(item => item.ruleId === 'CK-09' && item.status === 'needs_supplement'))
  assert.ok(pending.report.findings.some(item => item.ruleId === 'CK-29' && item.status !== 'passed'))
  assert.deepEqual(snapshot.sources, [])
  assert.deepEqual(snapshot.nodes.d1.data.attachments, [])
  assert.ok(deps.db.writes.every(sql => /check_runs/i.test(sql)))
})

test('同一检查内重复材料命中只读取一次，跨检查重新核验来源', async () => {
  const snapshot = makeSnapshot({ includeSource: false, missingOwner: true })
  const candidate = { candidateId: 'duplicate-material', kind: 'material', title: '库存记录',
    sourceRef: { type: 'canonical', roomId: ROOM, path: 'materials/inventory.md' },
    independentEvidence: true, version: 'v1' }
  let reads = 0
  const deps = makeDeps({ snapshot,
    search: async ({ scope }) => scope === 'company_ai'
      ? { status: 'ok', candidates: [candidate, { ...candidate, candidateId: 'same-file-hit' }], complete: true }
      : { status: 'no_results', candidates: [], complete: true },
    readSource: async () => {
      reads++
      return { status: 'ok', complete: true, content: '库存记录：每日盘点标准和记录字段。',
        sourceRef: candidate.sourceRef, version: 'v1', independentEvidence: true, kind: 'material' }
    }
  })
  await create(snapshot, deps, 'cached-material-first')
  assert.equal(reads, 1)
  await create(snapshot, deps, 'cached-material-second')
  assert.equal(reads, 2)
})

test('确认流程后只返回原文和显式字段对照，不产出语义结论；来源变化会使报告过期', async () => {
  const snapshot = makeSnapshot({ includeSource: false })
  snapshot.nodes.c1.data = { targetValue: '98%' }
  snapshot.nodes.p1.data = { targetValue: '95%' }
  const flowText = [
    'C：目标值：98%',
    'P：目标值：90%',
    'D：核对库存记录',
    '频率：每周',
    '输入源：库存记录',
    '判据：库存记录准确率至少达到 98%',
    '责任人：仓库主管',
    '产物：生成库存盘点记录'
  ].join('\n')
  let sourceVersion = 'flow-v1'
  let sourceReads = 0
  let judgeCalls = 0
  const candidate = {
    candidateId: 'flow-template-1', kind: 'flow', sourceRole: 'canonical',
    sourceRef: { type: 'map_node', roomId: ROOM, uid: 'flow-template', scope: 'map_knowledge' },
    title: '库存盘点流程模板', path: '知识库 / 库存盘点流程模板', source: 'map_knowledge',
    matchReason: '包含库存盘点目标', summary: '完整 C/P/D 流程', version: sourceVersion,
    complete: true, independentEvidence: true
  }
  const deps = makeDeps({ snapshot,
    judge: async () => { judgeCalls += 1; return { status: 'ok', findings: [] } },
    search: async ({ scope }) => scope === 'map_knowledge'
      ? { status: 'ok', candidates: [candidate], complete: true }
      : { status: 'no_results', candidates: [], complete: true },
    readSource: async ({ sourceRef }) => {
      sourceReads += 1
      assert.equal(sourceRef.uid, 'flow-template')
      return { status: 'ok', sourceRef, version: sourceVersion, sourceHash: `hash-${sourceVersion}`,
        content: flowText, complete: true, truncated: false, kind: 'flow', independentEvidence: true }
    }
  })

  const pending = await create(snapshot, deps, 'flow-confirmation')
  assert.equal(pending.status, 'needs_confirmation')
  assert.equal(pending.report.selectionStage, 'source')
  assert.equal(pending.report.flowCandidates[0].candidateId, candidate.candidateId)
  assert.equal(pending.selection.sourceRef, undefined)
  assert.equal(sourceReads, 0)

  const confirmed = await core.confirmCheck({ roomKey: ROOM, runId: pending.runId,
    candidateId: candidate.candidateId, actor: ACTOR }, deps)
  assert.equal(confirmed.selection.confirmationState, 'complete')
  assert.equal(confirmed.selection.sourceRef.uid, 'flow-template')
  assert.equal(confirmed.selection.sourceVersion, sourceVersion)
  assert.equal(confirmed.report.referenceComparison.mode, 'reference_only')
  assert.match(confirmed.report.referenceComparison.note, /不判断目标含义/)
  assert.equal(confirmed.report.referenceComparison.fields.find(item => item.field === 'targetValue').comparison, 'partial_match')
  for (const field of ['frequency', 'inputs', 'criterion', 'owner', 'outputs']) {
    assert.equal(confirmed.report.referenceComparison.fields.find(item => item.field === field).comparison, 'exact_match')
  }
  assert.equal(confirmed.report.findings.some(item => item.ruleId === 'FLOW-COMPARE'), false)
  assert.equal(sourceReads, 1)
  assert.equal(judgeCalls, 0)

  const reused = await create(snapshot, deps, 'flow-selection-reuse')
  assert.equal(reused.report.selectionReused, true)
  assert.equal(reused.selection.sourceRef.uid, 'flow-template')
  assert.equal(reused.report.referenceComparison.mode, 'reference_only')
  assert.equal(judgeCalls, 0)

  sourceVersion = 'flow-v2'
  const stale = await core.getCheck({ roomKey: ROOM, runId: confirmed.runId, actor: ACTOR }, deps)
  assert.equal(stale.status, 'stale')
  assert.equal(stale.report.status, 'stale')
})

test('GET 报告时发现链路或来源发生变化会标为 stale', async t => {
  for (const changed of ['chain', 'source']) {
    await t.test(changed, async () => {
      const snapshot = makeSnapshot()
      const db = makeMemoryDb()
      const deps = makeDeps({ db, snapshot })
      const run = await create(snapshot, deps, `stale-${changed}`)
      assert.equal(run.status, 'needs_confirmation')
      if (changed === 'chain') snapshot.nodes.d1.data.frequency = '每天'
      else snapshot.sources[0].content += '来源版本发生变化。'

      const current = await core.getCheck({ roomKey: ROOM, runId: run.runId }, deps)
      assert.equal(current.status, 'stale')
      assert.equal(current.report.status, 'stale')
    })
  }
})

test('附件来源保留真实名称与祖先路径，filename 落到元数据', async () => {
  const snapshot = makeSnapshot()
  const run = await create(snapshot, makeDeps({ snapshot }), 'source-path')
  const source = run.report.sources.find(item => item.sourceRef.type === 'attachment')
  assert.ok(source, '附件来源应保留在报告中')
  assert.equal(source.filename, '库存记录')
  assert.equal(source.title, '库存记录')
  assert.match(source.pathText, /库存盘点流程/)
  assert.ok(Array.isArray(source.path))
  assert.equal(Object.hasOwn(source, 'sourcePaths'), true)
})

test('来源按身份与版本去重：不同 query 的同一 Wiki 主题只保留一条并可复核', () => {
  const { sourceMetadata, dedupeSources } = core._internals
  const wikiRef = query => ({
    type: 'wiki_compiler', roomId: ROOM, topic: '库存盘点 SOP', section: '检查标准',
    chunkId: '库存盘点 SOP::检查标准::10', query, chunkHash: 'chunk-hash', version: '2026-09-01',
    sourcePaths: ['Sources/库存制度.md']
  })
  const first = sourceMetadata({
    sourceRef: wikiRef('责任人 库存记录'), title: '库存盘点 SOP', path: 'Wiki / 库存盘点 SOP / 检查标准',
    source: 'wiki', status: 'ok', version: '2026-09-01:body-hash', content: 'C：库存准确率至少 98%'
  })
  const second = sourceMetadata({
    sourceRef: wikiRef('盘点 材料'), title: '库存盘点 SOP', path: 'Wiki / 库存盘点 SOP / 检查标准',
    source: 'wiki', status: 'ok', version: '2026-09-01:body-hash', content: 'C：库存准确率至少 98%'
  })
  const otherTopic = sourceMetadata({
    sourceRef: { ...wikiRef('盘点 材料'), topic: '销售复盘 SOP', chunkId: '销售复盘 SOP::目标::1' },
    title: '销售复盘 SOP', status: 'ok', version: '2026-09-01:body-hash', content: 'P：月销售复盘'
  })
  const merged = dedupeSources([first, second, otherTopic])
  assert.equal(merged.length, 2)
  const stock = merged.find(item => item.sourceRef.topic === '库存盘点 SOP')
  assert.equal(stock.sourceRef.query, '责任人 库存记录', '同一来源保留完整 sourceRef.query 供有效性复核')
  assert.equal(stock.contentHash.length, 64)
})

test('CK-32 按节点聚合缺项，去占位与重复，也不重复统计进 summary', async () => {
  const snapshot = makeSnapshot({ includeSource: false, missingOwner: true })
  const run = await create(snapshot, makeDeps({ snapshot }), 'ck32-aggregate')
  const summaries = run.report.findings.filter(item => item.ruleId === 'CK-32')
  assert.ok(summaries.length > 0)
  assert.equal(new Set(summaries.map(item => item.nodeUid)).size, summaries.length, '同一节点只汇总一条')
  for (const item of summaries) {
    assert.equal(item.title, '缺项汇总')
    assert.ok(Array.isArray(item.details) && item.details.length)
    assert.equal(item.missingCount, item.details.length)
    assert.doesNotMatch(item.message, /补齐对象|责任人待项目补充|D「/)
    assert.match(item.message, /缺少：/)
    assert.ok(item.details.every(detail => detail.ruleId && detail.fieldLabel !== undefined))
  }
  const expected = run.report.findings
    .filter(item => item.ruleId !== 'CK-32' && item.status === 'needs_supplement').length
  assert.equal(run.report.summary.needsSupplement, expected, '缺项汇总不计入待补齐统计')
  assert.equal(run.report.findings.some(item => item.ruleId === 'CK-09' && item.field === 'owner' && item.status === 'needs_supplement'), true)
  assert.equal(run.report.findings.find(item => item.ruleId === 'CK-09' && item.field === 'owner').message.includes('责任人'), true)
})

test('buildQuery 使用中文字段标签并优先业务上下文', () => {
  const { buildQuery } = core._internals
  const snapshot = makeSnapshot({ includeSource: false, missingOwner: true })
  const resolved = core.resolveCheckChain(snapshot, 'd1')
  assert.equal(resolved.status, 'resolved')
  const query = buildQuery(snapshot, resolved.chain, [
    { ruleId: 'CK-09', field: 'owner', nodeUid: 'd1', message: 'D 节点缺少责任人。' },
    { ruleId: 'CK-11', field: 'criterion', nodeUid: 'cRoot', quote: '库存盘点准确率至少达到 98%' }
  ])
  assert.ok(query.startsWith('库存盘点流程'), '链路业务标题应排在最前')
  assert.match(query, /责任人/)
  assert.match(query, /判据/)
  assert.doesNotMatch(query, /owner|criterion/)
  assert.ok(query.length <= 240, '查询词不超过 provider 截断长度')
})

test('普通材料完整读取后记录真实来源；明确标签只作待核对候选，不把缺字段判为通过', async () => {
  const snapshot = makeSnapshot({ includeSource: false, missingOwner: true })
  delete snapshot.nodes.d1.data.outputs
  const candidate = {
    candidateId: 'material-branch-1', kind: 'material', sourceRole: 'canonical',
    sourceRef: { type: 'canonical', roomId: ROOM, path: 'materials/inventory.md' },
    title: '库存规范', path: 'materials/inventory.md', source: 'canonical',
    matchReason: '命中库存', summary: '库存材料', version: 'v1', complete: true, independentEvidence: true
  }
  let reads = 0
  const deps = makeDeps({ snapshot,
    search: async ({ scope }) => scope === 'company_ai'
      ? { status: 'ok', candidates: [candidate], complete: true }
      : { status: 'no_results', candidates: [], complete: true },
    readSource: async ({ sourceRef }) => {
      reads += 1
      return {
        status: 'ok', sourceRef, path: 'materials/inventory.md', version: 'v1:hash', sourceHash: 'hash',
        content: '产物：生成库存盘点报告。\n库存记录：每日盘点明细。', complete: true, truncated: false,
        independentEvidence: true, kind: 'material', sourceRole: 'canonical'
      }
    }
  })
  const run = await create(snapshot, deps, 'material-branch-record')
  assert.equal(reads, 1)
  assert.ok(run.report.sources.some(source => source.sourceRef.path === 'materials/inventory.md'),
    '完整读取的材料来源必须保留供查看')
  assert.ok(run.report.materialCandidates.some(item => item.field === 'outputs'), '明确产物标签作为待核对候选')
  assert.ok(run.report.materialCandidates.some(item => item.field === 'reference'), '材料术语命中仍作为候选')
  assert.equal(run.report.materialCandidates.some(item => item.field === 'owner'), false,
    '通用材料中的责任人不得生成项目值候选')
  const outputsFinding = run.report.findings.find(item => item.ruleId === 'CK-09' && item.field === 'outputs')
  assert.equal(outputsFinding.status, 'needs_supplement', '外部候选不能把图中缺字段标为通过')
  assert.notEqual(run.status, 'passed')
})

test('检索来源解析失败或未接入时 CK-30/33/34 如实提示，不误判通过', async () => {
  const snapshot = makeSnapshot({ includeSource: false, missingOwner: true })
  const run = await create(snapshot, makeDeps({ snapshot,
    search: async ({ scope }) => {
      if (scope === 'map_knowledge') return { status: 'ok', candidates: [], complete: true }
      if (scope === 'company_ai') return { status: 'parse_failed', error: 'invalid_response', candidates: [], complete: false }
      return { status: 'not_connected', error: 'wiki_not_configured', candidates: [], complete: false }
    },
    readSource: async () => ({ status: 'no_results', complete: false })
  }), 'source-failure-types')

  const ck30 = run.report.findings.find(item => item.ruleId === 'CK-30')
  const ck33 = run.report.findings.find(item => item.ruleId === 'CK-33')
  const ck34 = run.report.findings.find(item => item.ruleId === 'CK-34')
  assert.equal(ck30.status, 'needs_info')
  assert.match(ck30.message, /解析失败/)
  assert.equal(ck33.status, 'needs_info')
  assert.doesNotMatch(ck33.message, /暂未接入/)
  assert.equal(ck34.status, 'needs_info')
  assert.equal(run.status, 'needs_confirmation')
})

test('v5 人工核对可保存、幂等、拒绝和撤回，并拒绝并发旧修订', async () => {
  const snapshot = makeSnapshot({ includeSource: false, input: '无需外部材料' })
  const deps = makeDeps({ snapshot })
  let run = await create(snapshot, deps, 'review-v5')
  const finding = run.report.findings.find(item => item.ruleId === 'CK-27')
  assert.equal(finding.reviewable, true)
  const input = { roomKey: ROOM, runId: run.id, actor: ACTOR, findingKey: finding.findingKey,
    decision: 'confirm', requestId: 'review-confirm', expectedRevision: run.report.revision,
    reason: '逐项核对 C/P 原文，目标对应。', evidenceIds: finding.requiredEvidenceIds }
  run = await core.reviewCheck(input, deps)
  assert.equal(run.report.findings.find(item => item.findingKey === finding.findingKey).status, 'passed')
  assert.equal(run.report.reviewDecisions.length, 1)
  assert.equal(run.report.reviewDecisions[0].originalJudgment.status, 'needs_info')
  assert.ok(run.report.reviewDecisions[0].evidence.every(entry => entry.excerpt && entry.contentHash))
  const duplicate = await core.reviewCheck(input, deps)
  assert.equal(duplicate.report.revision, run.report.revision)
  await assert.rejects(core.reviewCheck({ ...input, requestId: 'old-revision' }, deps), error => error.statusCode === 409)
  await assert.rejects(core.reviewCheck({ ...input, reason: '更改内容' }, deps), error => error.statusCode === 409)
  run = await core.reviewCheck({ ...input, decision: 'reject', requestId: 'review-reject', expectedRevision: run.report.revision, reason: '目标范围不一致' }, deps)
  assert.equal(run.report.findings.find(item => item.findingKey === finding.findingKey).status, 'failed')
  run = await core.reviewCheck({ ...input, decision: 'revoke', requestId: 'review-revoke', expectedRevision: run.report.revision, reason: '撤回重新核对' }, deps)
  assert.equal(run.report.findings.find(item => item.findingKey === finding.findingKey).status, 'needs_info')
  assert.equal(run.report.reviewDecisions.length, 3)
  assert.ok(deps.db.writes.every(sql => /check_runs/i.test(sql)))
})

test('v5 人工核对不能绕过缺字段，须覆盖全部原文，链路变化后失效', async () => {
  const snapshot = makeSnapshot({ missingOwner: true, includeSource: false })
  const deps = makeDeps({ snapshot })
  let run = await create(snapshot, deps, 'review-guards')
  const missing = run.report.findings.find(item => item.ruleId === 'CK-09' && item.field === 'owner')
  const args = { roomKey: ROOM, runId: run.id, actor: ACTOR, requestId: 'missing-override', expectedRevision: run.report.revision,
    findingKey: missing.findingKey, decision: 'confirm', reason: '核对', evidenceIds: [] }
  await assert.rejects(core.reviewCheck(args, deps), error => error.code === 'FINDING_NOT_REVIEWABLE')
  const relation = run.report.findings.find(item => item.ruleId === 'CK-27')
  await assert.rejects(core.reviewCheck({ ...args, findingKey: relation.findingKey, requestId: 'partial-evidence', evidenceIds: relation.requiredEvidenceIds.slice(0, 1) }, deps), error => error.code === 'EVIDENCE_REQUIRED')
  run = await core.reviewCheck({ ...args, findingKey: relation.findingKey, requestId: 'valid-evidence', evidenceIds: relation.requiredEvidenceIds }, deps)
  const copied = await create(snapshot, deps, 'reused-evidence')
  assert.equal(copied.report.findings.find(item => item.findingKey === relation.findingKey).status, 'passed')
  snapshot.nodes.p1.text += '目标调整'
  await assert.rejects(core.reviewCheck({ ...args, findingKey: relation.findingKey, requestId: 'changed', expectedRevision: run.report.revision, evidenceIds: relation.requiredEvidenceIds }, deps), error => error.code === 'CHECK_STALE')
  const fresh = await create(snapshot, deps, 'changed-recheck')
  assert.notEqual(fresh.report.findings.find(item => item.ruleId === 'CK-27').status, 'passed')
})

test('v5 演示报告不能正式通过；来源仅可读取已登记身份且执行正文预算', async () => {
  const snapshot = makeSnapshot()
  const deps = makeDeps({ snapshot })
  const demo = await core.createCheck({ roomKey: ROOM, nodeUid: 'd1', actor: ACTOR, requestId: 'demo-v5', mode: 'demo' }, deps)
  assert.notEqual(demo.status, 'passed')
  const item = demo.report.findings.find(value => value.ruleId === 'CK-27')
  await assert.rejects(core.reviewCheck({ roomKey: ROOM, runId: demo.id, actor: ACTOR, requestId: 'demo-review', expectedRevision: 1,
    findingKey: item.findingKey, decision: 'confirm', reason: '演示', evidenceIds: item.requiredEvidenceIds }, deps), error => error.code === 'REVIEW_NOT_READY')
  const run = await create(snapshot, deps, 'source-v5')
  const source = run.report.sources.find(value => value.sourceRef.type === 'attachment')
  const body = await core.getCheckSource({ roomKey: ROOM, runId: run.id, sourceId: source.sourceId, actor: ACTOR }, deps)
  assert.equal(body.content, snapshot.sources[0].content)
  assert.equal(body.complete, true)
  await assert.rejects(core.getCheckSource({ roomKey: ROOM, runId: run.id, sourceId: 'http://unregistered', actor: ACTOR }, deps), error => error.code === 'SOURCE_NOT_REGISTERED')
  deps.db.runs.find(value => value.run_id === run.id).report.sources.push({ sourceId: 'source-budget', sourceRef: { type: 'wiki_compiler', topic: 'budget' }, title: '超限资料' })
  deps.readSource = async () => ({ status: 'ok', content: 'x'.repeat(200001), complete: true, version: 'v1' })
  const oversized = await core.getCheckSource({ roomKey: ROOM, runId: run.id, sourceId: 'source-budget', actor: ACTOR }, deps)
  assert.equal(oversized.content.length, 200000)
  assert.equal(oversized.complete, false)
  snapshot.sources[0].content = '附件已改变'
  assert.equal((await core.getCheckSource({ roomKey: ROOM, runId: run.id, sourceId: source.sourceId, actor: ACTOR }, deps)).changed, true)
})

test('v5 单来源重读更新修订号、幂等且不创建新报告或修改脑图', async () => {
  const snapshot = makeSnapshot()
  const before = structuredClone(snapshot)
  const deps = makeDeps({ snapshot })
  let run = await create(snapshot, deps, 'retry-source-v5')
  const source = run.report.sources.find(item => item.sourceRef.type === 'attachment')
  const input = { roomKey: ROOM, runId: run.id, sourceId: source.sourceId, actor: ACTOR, requestId: 'retry-v5', expectedRevision: run.report.revision }
  run = await core.retryCheckSource(input, deps)
  assert.equal(run.report.revision, 2)
  assert.equal(run.report.sourceRetries.length, 1)
  assert.equal((await core.retryCheckSource(input, deps)).report.revision, 2)
  await assert.rejects(core.retryCheckSource({ ...input, sourceId: 'another-source' }, deps), error => error.statusCode === 409)
  await assert.rejects(core.retryCheckSource({ ...input, requestId: 'older-retry' }, deps), error => error.statusCode === 409)
  assert.equal(deps.db.runs.length, 1)
  assert.deepEqual(snapshot, before)
})

test('v5 同修订的并发核对仅一份提交成功，不丢审计结果', async () => {
  const snapshot = makeSnapshot({ includeSource: false })
  const deps = makeDeps({ snapshot })
  const run = await create(snapshot, deps, 'parallel-review-v5')
  const relation = run.report.findings.find(item => item.ruleId === 'CK-27')
  const base = { roomKey: ROOM, runId: run.id, actor: ACTOR, findingKey: relation.findingKey, decision: 'confirm', reason: '逐项核对', evidenceIds: relation.requiredEvidenceIds, expectedRevision: 1 }
  const results = await Promise.allSettled([
    core.reviewCheck({ ...base, requestId: 'parallel-1' }, deps),
    core.reviewCheck({ ...base, requestId: 'parallel-2' }, deps)
  ])
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(results.find(item => item.status === 'rejected').reason.statusCode, 409)
  assert.equal(deps.db.runs[0].report.reviewDecisions.length, 1)
  assert.equal(deps.db.runs[0].report.revision, 2)
})

test('v5 完整链路逐项人工核对后可收口正式通过，顶部分类与阻断一致', async () => {
  const snapshot = makeSnapshot()
  const deps = makeDeps({ snapshot })
  let run = await create(snapshot, deps, 'complete-review-v5')
  const reviewable = run.report.findings.filter(item => item.reviewable && item.blocking)
  assert.ok(reviewable.length > 0)
  for (const item of reviewable) {
    run = await core.reviewCheck({ roomKey: ROOM, runId: run.id, actor: ACTOR,
      requestId: `complete-${item.findingKey}`, expectedRevision: run.report.revision,
      findingKey: item.findingKey, decision: 'confirm', reason: '已逐项核对完整原文与项目依据，符合。', evidenceIds: item.requiredEvidenceIds }, deps)
  }
  assert.equal(run.status, 'passed', JSON.stringify(run.report.findings.filter(item => item.blocking).map(item => [item.ruleId, item.message])))
  assert.equal(run.report.summary.blockers, 0)
  const counts = run.report.summary.categories
  assert.equal(run.report.summary.actionable, ['structure', 'missing', 'review', 'source_error', 'hint'].reduce((total, key) => total + counts[key], 0))
  assert.equal(run.report.formalPassEligible, true)
})

test('v5 演示模式可选择参考流程阅读对照，始终保留演示性质', async () => {
  const snapshot = makeSnapshot({ missingOwner: true, includeSource: false })
  const candidate = { candidateId: 'demo-flow', kind: 'flow', title: '演示参考', sourceRef: { type: 'wiki_compiler', roomId: ROOM, topic: '演示' }, version: 'demo-v1', complete: false, provenance: { origin: 'demo' } }
  const deps = makeDeps({ snapshot,
    search: async ({ mode }) => ({ status: 'ok', candidates: mode === 'demo' ? [candidate] : [] }),
    readSource: async ({ mode }) => {
      assert.equal(mode, 'demo')
      return { status: 'ok', complete: true, version: 'demo-v1', provenance: { origin: 'demo' }, content: 'C：目标98%\nP：目标98%\nD：演示动作\n频率：每周\n责任人：演示角色' }
    }
  })
  let run = await core.createCheck({ roomKey: ROOM, nodeUid: 'd1', actor: ACTOR, requestId: 'demo-choice', mode: 'demo' }, deps)
  assert.equal(run.report.selectionStage, 'source')
  run = await core.confirmCheck({ roomKey: ROOM, runId: run.id, actor: ACTOR, candidateId: candidate.candidateId }, deps)
  assert.equal(run.report.mode, 'demo')
  assert.equal(run.report.formalPassEligible, false)
  assert.notEqual(run.status, 'passed')
  assert.ok(run.report.referenceComparison)
})

test('v5 单来源重读只读取指定来源，不重复检索或读取其他资料', async () => {
  const snapshot = makeSnapshot({ missingOwner: true })
  const deps = makeDeps({ snapshot })
  const run = await create(snapshot, deps, 'focused-retry-v5')
  const ref = { type: 'canonical', roomId: ROOM, path: 'focused.md' }
  const external = { sourceId: require('../bin/checkRuns/identity').sourceIdFor(ref), sourceRef: ref, title: '项目资料', version: 'old', complete: false, status: 'unavailable' }
  deps.db.runs[0].report.sources.push(external)
  let reads = 0
  deps.searchSources = async () => { throw new Error('single retry must not search') }
  deps.readSource = async ({ sourceRef }) => {
    reads++
    assert.equal(sourceRef.path, 'focused.md')
    return { status: 'ok', complete: true, title: '项目资料', content: '频率：每周', version: 'new' }
  }
  const result = await core.retryCheckSource({ roomKey: ROOM, runId: run.id, sourceId: external.sourceId, actor: ACTOR, requestId: 'focused-read', expectedRevision: 1 }, deps)
  assert.equal(reads, 1)
  assert.equal(result.report.revision, 2)
  assert.ok(result.report.sources.some(item => item.sourceRef.path === 'focused.md' && item.complete))
})

test('v5 Wiki 重读更新同一主题的失效命中，只读取原登记主题', async () => {
  const snapshot = makeSnapshot({ missingOwner: true })
  const deps = makeDeps({ snapshot })
  const run = await create(snapshot, deps, 'wiki-refresh-v5')
  const oldRef = { type: 'wiki_compiler', roomId: ROOM, topic: '会员流程', query: '会员', chunkId: 'old' }
  const sourceId = require('../bin/checkRuns/identity').sourceIdFor(oldRef)
  deps.db.runs[0].report.sources.push({ sourceRef: oldRef, sourceId, title: '会员流程', status: 'ok', complete: true, version: 'old' })
  const reads = []
  deps.readSource = async ({ sourceRef }) => {
    reads.push(sourceRef.topic)
    if (sourceRef.chunkId === 'old') return { status: 'no_results', complete: false, content: '', error: 'wiki_chunk_not_current' }
    return { sourceRef, status: 'ok', complete: true, title: '会员流程', version: 'new', content: '输入源：会员记录' }
  }
  deps.searchSources = async ({ scope, query }) => {
    assert.equal(scope, 'wiki')
    assert.equal(query, '会员')
    return { candidates: [
      { sourceRef: { ...oldRef, topic: '另一个高分主题', chunkId: 'highest' } },
      { sourceRef: { ...oldRef, chunkId: 'new' } }
    ] }
  }
  const result = await core.retryCheckSource({ roomKey: ROOM, runId: run.id, sourceId, actor: ACTOR, requestId: 'wiki-new-match', expectedRevision: 1 }, deps)
  assert.deepEqual(reads, ['会员流程', '会员流程'])
  assert.equal(result.report.sources.find(item => item.sourceId === sourceId).sourceRef.chunkId, 'new')
  assert.equal(result.report.sources.find(item => item.sourceId === sourceId).complete, true)
})
