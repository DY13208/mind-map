// Run with: node --test simple-mind-map/scripts/verifyJackyunReview.cjs
const assert = require('node:assert/strict')
const { test } = require('node:test')
process.env.MIND_MAP_SKIP_ROOT_ENV = '1'
const skill = require('../bin/leaveWorkflow/jackyunSkill')
const external = require('../bin/leaveWorkflow/jackyunReview')
const ai = require('../bin/leaveWorkflow/aiReview')
const sop = require('../bin/leaveWorkflow/hrSopCheck')

const credentials = { enabled: true, appKey: 'test-app', appSecret: 'test-secret',
  url: 'https://open.jackyun.com/open/openapi/do', timeoutMs: 100 }
const lookup = { kind: 'sales_order', numberField: 'tradeNo', number: 'YR20261119001' }
const cfg = { base: 'https://model.example', apiKey: 'test-model', model: 'test', timeoutMs: 1000 }
const branch = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const step = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const root = '7df2ad7a-0978-43be-acb7-3d5e4ead6dd7'
const sample = { fields: { 单号: lookup.number, 申请金额: '100' }, attachments: [] }
const rules = [{ uid: branch, text: '销售单审批' },
  { uid: step, parentUid: branch, text: '核对吉客云销售单金额与申请一致' }]
const modelMessage = value => ({ content: JSON.stringify(value) })
const apiResponse = (data, extra = {}) => new Response(JSON.stringify({ code: '10000', result: { data }, ...extra }))

function env(t) {
  for (const [key, value] of Object.entries({
    JACKYUN_APPROVAL_ENABLED: '1', JACKYUN_APP_KEY: credentials.appKey,
    JACKYUN_APP_SECRET: credentials.appSecret, JACKYUN_API_URL: credentials.url,
    WCPD_AI_REVIEW_ENABLED: '1', WCPD_AI_REVIEW_API_KEY: 'model-test',
    WCPD_AI_REVIEW_BASE_URL: cfg.base, WCPD_AI_REVIEW_MIN_CONFIDENCE: '0.75'
  })) {
    const previous = process.env[key]
    process.env[key] = value
    t.after(() => {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    })
  }
}

function collect(overrides = {}) {
  return external.collect({ rules, submission: sample, cfg,
    call: async () => modelMessage({ required: true, queries: [lookup] }), ...overrides })
}

test('signing uses the exact serialized body and the supplied skill algorithm', () => {
  const params = { method: 'oms.trade.fullinfoget', appkey: 'test-app', version: 'v1.0',
    contenttype: 'json', timestamp: '2026-11-19 12:00:00', bizcontent: '{"tradeNo":"YR123"}' }
  assert.equal(skill.sign(params, 'secret'), 'ae77465753fbc032cd20150cd14d90ee')
  assert.equal(skill.sign({ ...params, sign: 'ignored', contextid: 'ignored', token: 'ignored' }, 'secret'),
    'ae77465753fbc032cd20150cd14d90ee')
  assert.equal(skill.signedParams(params.method, { tradeNo: 'YR123' }, credentials,
    new Date('2026-11-19T04:00:00Z')).timestamp, params.timestamp)
  assert.equal(skill.config({}).appSecret, '')
})

test('all embedded document queries send signed, bounded, read-only requests', async t => {
  const cases = [
    ['sales_order', 'tradeNo', 'tradeNo', 'trades', 'oms.trade.fullinfoget'],
    ['sales_order', 'sourceTradeNos', 'onlineTradeNo', 'trades', 'oms.trade.fullinfoget'],
    ['stock_out', 'goodsdocNo', 'goodsdocNo', null, 'erp.storage.goodsdocout.v2'],
    ['stock_in', 'billNo', 'billNo', null, 'erp.storage.goodsdocin.v2'],
    ['transfer', 'allocateNos', 'allocateNo', 'stockAllocate', 'erp.allocate.get'],
    ['stock_in_apply', 'inNo', 'inNo', 'stockInList', 'erp.stockin.get.v2'],
    ['stock_out_apply', 'outNo', 'outNo', 'stockOutList', 'erp.stockout.get.v2']
  ]
  for (const [kind, numberField, responseKey, wrapper, method] of cases) {
    const row = { [responseKey]: lookup.number, amount: 100, mobile: 'private',
      address: 'private', appSecret: 'private', goodsDetail: [{ goodsNo: 'G1', sellCount: 2 }] }
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(String(url), credentials.url)
      assert.equal(options.redirect, 'error')
      const params = Object.fromEntries(new URLSearchParams(options.body))
      assert.equal(params.method, method)
      assert.equal(params.sign, skill.sign(params, credentials.appSecret))
      const body = JSON.parse(params.bizcontent)
      assert.equal(body[numberField], lookup.number)
      assert.equal(body.pageSize, 20)
      assert.equal(body.pageIndex, 0)
      if (['stock_in', 'stock_out'].includes(kind)) assert.ok(body.selelctFields)
      if (['stock_in_apply', 'stock_out_apply'].includes(kind)) assert.ok(body.cols)
      return apiResponse(wrapper ? { [wrapper]: [row] } : [row])
    })
    const result = await skill.query({ kind, numberField, number: lookup.number }, credentials)
    assert.equal(result.status, 'found')
    assert.equal(result.documents[0].amount, 100)
    assert.doesNotMatch(JSON.stringify(result), /private|appSecret|address|mobile/)
    t.mock.restoreAll()
  }
})

test('unknown, broad, insecure and write queries fail before the network', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw Error('must not call') })
  for (const value of [
    { ...lookup, kind: 'oms.trade.audit.pass' }, { ...lookup, kind: '__proto__' },
    { ...lookup, numberField: 'pageSize' }, { ...lookup, number: 'YR001,YR002' },
    { ...lookup, number: '*' }, { ...lookup, number: '' }
  ]) await assert.rejects(skill.query(value, credentials))
  await assert.rejects(skill.query(lookup, { ...credentials, url: 'http://example.com' }))
  await assert.rejects(skill.query(lookup, { ...credentials, appSecret: '' }))
  assert.equal(fetch.mock.callCount(), 0)
})

test('only an explicit empty result means not found; malformed, unrelated and partial results cannot pass', async t => {
  const responses = [
    apiResponse({ trades: [] }), apiResponse({ unexpected: 'shape' }),
    apiResponse({ trades: [{ tradeNo: 'UNRELATED001' }] }),
    apiResponse({ totalCount: 25, trades: [{ tradeNo: lookup.number }] }),
    apiResponse({ trades: Array.from({ length: 20 }, () => ({ tradeNo: lookup.number })) }),
    new Response(JSON.stringify({ code: '10000', result: {} })),
    new Response('{not-json'), new Response('unavailable', { status: 503 }),
    apiResponse({}, { code: '10001', msg: credentials.appSecret + ' SIGNED REQUEST' })
  ]
  t.mock.method(globalThis, 'fetch', async () => responses.shift())
  assert.equal((await skill.query(lookup, credentials)).status, 'not_found')
  for (let index = 0; index < 8; index++) {
    await assert.rejects(skill.query(lookup, credentials), error => {
      assert.doesNotMatch(error.message, /test-secret|SIGNED REQUEST/)
      return true
    })
  }
})

test('timeouts are reported as unverifiable rather than missing documents', async t => {
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  await assert.rejects(skill.query(lookup, { ...credentials, timeoutMs: 5 }), /超时/)
})

test('ordinary approvals do not trigger ERP calls', async () => {
  assert.equal(await collect({ rules: '请假日期核验', submission: { text: '请假一天' },
    call: async () => { throw Error('unnecessary model call') } }), null)
})

test('the query planner cannot skip required lookup, use example IDs, query other IDs or call writes', async t => {
  env(t)
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw Error('must not call') })
  for (const plan of [
    { required: false }, { required: true, queries: [] },
    { required: true, queries: [{ ...lookup, number: 'YR-OTHER001' }] },
    { required: true, queries: [{ ...lookup, number: '20261119001' }] },
    { required: true, queries: [{ ...lookup, kind: 'oms.trade.ordercreate' }] },
    { required: true, queries: Array.from({ length: 7 }, () => lookup) }
  ]) {
    const result = await collect({ call: async () => modelMessage(plan) })
    assert.equal(result.status, 'manual')
    assert.equal(external.guard(result).decision, 'manual')
  }
  assert.equal(fetch.mock.callCount(), 0)
})

test('unbound SOP matching cannot borrow a different branch to bypass required queries', async t => {
  env(t)
  const ordinary = 'ordinary-branch'
  const result = await collect({ rules: [...rules, { uid: ordinary, text: '请假核验' }],
    submission: { text: '请假一天' }, branchUids: [branch, ordinary],
    call: async () => modelMessage({ required: false, branchUid: ordinary, queries: [] }) })
  assert.equal(result.status, 'not_required')
  assert.equal(result.branchUid, ordinary)
  assert.equal(external.guard(result, { pass: true }), null)
  const invalid = await collect({ branchUids: [branch],
    call: async () => modelMessage({ required: true, branchUid: 'invented', queries: [lookup] }) })
  assert.equal(invalid.status, 'manual')
})

test('missing documents deterministically fail and summaries never return ERP record contents', async t => {
  env(t)
  t.mock.method(globalThis, 'fetch', async () => apiResponse({ trades: [] }))
  const missing = await collect()
  assert.equal(missing.status, 'not_found')
  assert.equal(external.guard(missing, { decision: 'approve' }).decision, 'reject')
  assert.match(missing.reason, /未查询到/)
  assert.doesNotMatch(JSON.stringify(external.summary(missing)), /documents/)
})

test('every requested document must be found; a missing document fails even if another query succeeded', async t => {
  env(t)
  const second = { ...lookup, number: 'YR20261119002' }
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const number = JSON.parse(new URLSearchParams(options.body).get('bizcontent')).tradeNo
    return apiResponse({ trades: number === lookup.number ? [{ tradeNo: number }] : [] })
  })
  const result = await collect({ submission: { text: lookup.number + ' ' + second.number },
    call: async () => modelMessage({ required: true, queries: [lookup, second] }) })
  assert.equal(result.status, 'not_found')
  assert.equal(result.queries.length, 2)
  assert.equal(external.guard(result).decision, 'reject')
})

test('truncated or oversized evidence cannot silently drop related documents', async t => {
  env(t)
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw Error('must not call') })
  const call = async () => { throw Error('must not plan incomplete evidence') }
  assert.equal((await collect({ submission: { ...sample, attachments: [{ truncated: true }] }, call })).status, 'manual')
  assert.equal((await collect({ submission: { ...sample, text: 'x'.repeat(60001) }, call })).status, 'manual')
  assert.equal(fetch.mock.callCount(), 0)
})

test('matching evidence is mandatory and clear discrepancies override an optimistic model verdict', () => {
  const evidence = { status: 'ready' }
  assert.equal(external.guard(evidence, { decision: 'approve' }).decision, 'manual')
  assert.equal(external.guard(evidence, { jackyunMatch: 'unknown', jackyunReason: '缺少金额' }).decision, 'manual')
  const mismatch = external.guard(evidence, { decision: 'approve', jackyunMatch: 'mismatch', jackyunReason: '申请100元，单据200元。' })
  assert.equal(mismatch.decision, 'reject')
  assert.match(mismatch.reason, /100元.*200元/)
  assert.equal(external.guard(evidence, { jackyunMatch: 'match' }), null)
})

function mockReview(t, { rows = [{ tradeNo: lookup.number, totalFee: 100 }],
  verdict = { decision: 'approve', pass: true, confidence: 0.98, reason: '材料一致。', jackyunMatch: 'match' },
  plan = { required: true, branchUid: branch, queries: [lookup] }, queryFailure = false } = {}) {
  env(t)
  return t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url) === credentials.url) {
      if (queryFailure) return new Response('failed', { status: 503 })
      return apiResponse({ trades: rows })
    }
    const body = JSON.parse(options.body)
    assert.doesNotMatch(JSON.stringify(body), /test-secret/)
    const isPlan = body.messages[0].content.includes('只规划')
    if (!isPlan && rows.length) {
      assert.match(body.messages[1].content, /totalFee/)
      assert.match(body.messages[0].content + body.messages[1].content, /jackyunMatch/)
    }
    return new Response(JSON.stringify({ choices: [{ message: modelMessage(isPlan ? plan : { branchUid: branch, ...verdict }) }] }))
  })
}

function genericRow() {
  return { current_step: 0, status: 'pending', fields: { no: lookup.number, money: '100' },
    steps: [{ role: '财务', criteria: [{ uid: 'rule', text: '查询吉客云销售单，与申请单号和金额一致' }] }],
    template: { kind: 'generic', title: '销售单核验', fingerprint: 'fp',
      fields: [{ key: 'no', label: '销售单号' }, { key: 'money', label: '申请金额' }] } }
}

test('generic submission persists not-found rejection and never reaches the final model', async t => {
  const fetch = mockReview(t, { rows: [] })
  const row = genericRow()
  const trace = await ai.applyOnSubmit({}, row)
  assert.equal(row.status, 'rejected')
  assert.equal(row.steps[0].decidedBy, 'ai-review')
  assert.match(row.steps[0].reason, /未查询到/)
  assert.equal(trace.aiReview.decisions[0].jackyun.queries[0].count, 0)
  assert.equal(fetch.mock.callCount(), 2)
})

test('generic reviews reject mismatches, escalate missing verification and approve confirmed matches', async t => {
  for (const [jackyunMatch, expected] of [['mismatch', 'reject'], [undefined, 'escalate'], ['match', 'approve']]) {
    await t.test(String(jackyunMatch), async sub => {
      mockReview(sub, { verdict: { decision: 'approve', confidence: 0.98, jackyunMatch,
        jackyunReason: '申请100元，单据200元。', reason: '核验完成' } })
      const result = await ai.review({}, genericRow())
      assert.equal(result.decision, expected)
      assert.equal(result.jackyun.queries[0].count, 1)
      assert.doesNotMatch(JSON.stringify(result.jackyun), /totalFee|documents/)
    })
  }
})

const db = { async query(sql) {
  if (sql.includes('room_tombstones')) return { rows: [] }
  if (sql.includes('from rooms')) return { rows: [{ room_key: 'room-yk3tz4aj' }] }
  if (sql.includes('room_members')) return { rows: [{ user_id: 'viewer', role: 'viewer' }] }
  assert.match(sql, /with recursive branch/)
  return { rows: [
    { uid: root, depth: 0, text: '业务流程' },
    { uid: branch, parent_uid: root, depth: 1, text: '销售单审批' },
    { uid: step, parent_uid: branch, depth: 2, text: '财务审核' },
    { uid: 'rule', parent_uid: step, depth: 3, text: '核对吉客云销售单金额与申请一致' }
  ] }
} }

function check(options = {}) {
  return sop.check(db, { authUser: { id: 'viewer' } }, {
    text: JSON.stringify({ 申请类型: '销售审批', 提交字段: {
      no: { value: lookup.number }, money: { value: '100' }
    } }), resultMode: 'triState', includeReason: true,
    requiredEvidence: [{ type: 'field', key: 'no' }, { type: 'field', key: 'money' }], ...options
  }, branch, step)
}

test('HRMS tri-state reports missing documents, mismatches, service errors and matches distinctly', async t => {
  for (const [name, options, expected, reason] of [
    ['missing', { rows: [] }, false, /未查询到/],
    ['mismatch', { verdict: { decision: 'approve', confidence: 0.98, jackyunMatch: 'mismatch', jackyunReason: '申请100元，单据200元。' } }, false, /不符/],
    ['outage', { queryFailure: true }, null, /HTTP 503/],
    ['unverified', { verdict: { decision: 'approve', confidence: 0.98 } }, null, /尚未完成/],
    ['matched', {}, true, /材料一致/]
  ]) await t.test(name, async sub => {
    mockReview(sub, options)
    const result = await check()
    assert.equal(result.result, expected)
    assert.match(result.reason, reason)
    assert.doesNotMatch(JSON.stringify(result), /test-secret|totalFee|documents/)
  })
})

test('boolean callers stay compatible; optional reasons explain ERP failures', async t => {
  mockReview(t, { rows: [] })
  assert.equal(await check({ resultMode: undefined, includeReason: false }), false)
  const detail = await check({ resultMode: undefined })
  assert.equal(detail.result, false)
  assert.match(detail.reason, /未查询到/)
})

test('MCP preserves boolean callers and exposes optional reasons without shortening the query timeout', async () => {
  const { registerApprovalTools } = await import('../bin/leaveWorkflow/mcp.mjs')
  const { z } = require('zod')
  const handlers = new Map()
  const requests = []
  registerApprovalTools({ tool(name, _description, _schema, handler) { handlers.set(name, handler) } }, {
    z, ok: value => value, fail: error => ({ error: error.message }),
    api: async (_path, options) => {
      requests.push(options)
      return JSON.parse(options.body).includeReason ? { result: false, reason: '吉客云未查询到单据' } : true
    }
  })
  const check = handlers.get('check_hr_sop')
  assert.equal((await check({ text: lookup.number })).content[0].text, 'true')
  const detail = JSON.parse((await check({ text: lookup.number, include_reason: true })).content[0].text)
  assert.equal(detail.result, false)
  assert.match(detail.reason, /未查询到/)
  assert.equal(requests[0].timeoutMs, 120000)
  assert.equal(JSON.parse(requests[1].body).includeReason, true)
})
