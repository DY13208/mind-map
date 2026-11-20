const assert = require('node:assert/strict')
const { test } = require('node:test')
process.env.MIND_MAP_SKIP_ROOT_ENV = '1'
const evidence = require('../bin/leaveWorkflow/approvalEvidence')
const { extractBuffer } = require('../bin/nodeKnowledge/extract')
const { MAX_EXTRACT_CHARS } = require('../bin/nodeKnowledge/limits')
const sop = require('../bin/leaveWorkflow/hrSopCheck')
const cfg = { timeoutMs: 1000 }
const root = '7df2ad7a-0978-43be-acb7-3d5e4ead6dd7'
const branch = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const step = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const rules = [{ uid: step, text: '财务审核' },
  { uid: 'rule', parentUid: step, text: '订单明细含税金额与申请一致' }]
const attachments = [
  { name: '订单明细.txt', fieldKey: 'orders', text: '含税金额100' },
  { name: '利润测算表.txt', fieldKey: 'profit', text: '毛利及成本' },
  { name: '开票规范.txt', fieldKey: 'guide', text: '填写规范' }
]
function plan(overrides = {}) {
  return { confidence: 0.99, selected: [0], omitted: [
    { index: 1, reason: '本步骤不核验利润或成本，仅核对订单明细金额。' },
    { index: 2, reason: '本步骤不核验开票填写规范，仅核对订单明细金额。' }
  ], coverage: [{ ruleUid: 'rule', attachments: [0] }], ...overrides }
}
function select(value = plan(), overrides = {}) {
  return evidence.select({ rules, stepUid: step, fields: {}, attachments,
    requirements: [], cfg, call: async () => ({ content: JSON.stringify(value) }), ...overrides })
}
function setEnv(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const before = process.env[key]
    process.env[key] = value
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before })
  }
}
test('approval extraction budgets are independent of knowledge-base and parallel requests', async () => {
  const body = Buffer.from('x'.repeat(30000))
  const [ordinary, approval, smaller] = await Promise.all([
    extractBuffer(body, { fileName: 'ordinary.txt' }),
    extractBuffer(body, { fileName: 'approval.txt', maxExtractChars: 100000 }),
    extractBuffer(body, { fileName: 'small.txt', maxExtractChars: 5000 })
  ])
  assert.equal(ordinary.extractedText.length, Math.min(MAX_EXTRACT_CHARS, 30000))
  assert.equal(approval.extractedText.length, 30000)
  assert.equal(approval.truncated, false)
  assert.equal(smaller.extractedText.length, 5000)
  assert.equal(smaller.truncated, true)
  const exact = await extractBuffer(Buffer.from('x'.repeat(1000)), { fileName: 'exact.txt', maxExtractChars: 1000 })
  assert.equal(exact.truncated, false)
})
test('larger XLSX reads expose actual truncation and never silently skip extra worksheets', async () => {
  const XLSX = require('xlsx')
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['x'.repeat(30000)]]), 'Data')
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
  const result = await extractBuffer(buffer, { fileName: 'long.xlsx', maxExtractChars: 100000 })
  assert.ok(result.extractedText.length > 20000)
  assert.equal(result.truncated, false)
  for (let index = 1; index <= 10; index++) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['needed source']]), 'Sheet' + index)
  }
  const many = await extractBuffer(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }),
    { fileName: 'many.xlsx', maxExtractChars: 100000 })
  assert.equal(many.truncated, true)
})
test('omission is scoped to every current-step condition with an explicit reason', async () => {
  const result = await select()
  assert.deepEqual(result.selected, [0])
  assert.equal(result.omitted.length, 2)
})
test('uncertain or malformed selection preserves all evidence', async () => {
  for (const value of [
    plan({ confidence: 0.8 }), plan({ selected: [0, 0] }),
    plan({ omitted: [{ index: 1, reason: '无关' }, { index: 2, reason: '无关' }] }),
    plan({ coverage: [] }), plan({ coverage: [{ ruleUid: 'invented', attachments: [0] }] }),
    plan({ coverage: [{ ruleUid: 'rule', attachments: [] }] }),
    plan({ coverage: [{ ruleUid: 'rule', attachments: [1] }] })
  ]) {
    const result = await select(value)
    assert.deepEqual(result.selected, [0, 1, 2])
    assert.deepEqual(result.omitted, [])
  }
  const failed = await select(undefined, { call: async () => { throw Error('timeout') } })
  assert.equal(failed.omitted.length, 0)
})
test('explicit mandatory files and every file from a selected field are retained', async () => {
  const locked = await select(plan(), { requirements: [{ type: 'attachment', key: 'profit', requiredForStep: true }] })
  assert.deepEqual(locked.selected, [0, 1, 2])
  const grouped = await select(plan(), { attachments: attachments.map((file, index) =>
    index === 1 ? { ...file, fieldKey: 'orders', text: '与另一订单文件冲突的数据' } : file) })
  assert.deepEqual(grouped.selected, [0, 1])
  assert.deepEqual(grouped.omitted.map(item => item.index), [2])
})
const db = { async query(sql) {
  if (sql.includes('room_tombstones')) return { rows: [] }
  if (sql.includes('from rooms')) return { rows: [{ room_key: 'room-yk3tz4aj' }] }
  if (sql.includes('room_members')) return { rows: [{ user_id: 'viewer', role: 'viewer' }] }
  assert.match(sql, /with recursive branch/)
  return { rows: [{ uid: root, depth: 0, text: '业务流程' },
    { uid: branch, parent_uid: root, depth: 1, text: '开票申请' },
    { uid: step, parent_uid: branch, depth: 2, text: '财务审核' },
    { uid: 'rule', parent_uid: step, depth: 3, text: rules[1].text }] }
} }
function setup(t, options = {}) {
  setEnv(t, { WCPD_AI_REVIEW_ENABLED: '1', WCPD_AI_REVIEW_API_KEY: 'test',
    WCPD_AI_REVIEW_MIN_CONFIDENCE: '0.75', WCPD_APPROVAL_SELECT_STEP_ATTACHMENTS: '1',
    WCPD_APPROVAL_MAX_ATTACHMENT_CHARS: '100000', WCPD_APPROVAL_MAX_PROMPT_CHARS: '120000',
    ...options.env })
  return t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body)
    const selection = body.messages[0].content.includes('材料读取助手')
    if (!selection) options.inspect?.(JSON.parse(body.messages[1].content))
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(selection
      ? options.selection || plan() : { decision: 'approve', confidence: 0.99, reason: '订单金额一致。' }) } }] }))
  })
}
function request(options = {}) {
  return sop.check(db, { authUser: { id: 'viewer' } }, {
    text: JSON.stringify({ 申请类型: '开票申请', 提交字段: { amount: { label: '开票金额', value: '100' } } }),
    files: attachments.map((file, index) => ({ name: file.name, fieldKey: file.fieldKey,
      base64: Buffer.from(index === 1 ? '毛利' + 'x'.repeat(30000) : file.text).toString('base64') })),
    resultMode: 'triState', includeReason: true, selectedEvidenceOnly: true,
    requiredEvidence: [{ type: 'field', key: 'amount' }, ...attachments.map(file => ({ type: 'attachment', key: file.fieldKey }))],
    ...options
  }, branch, step)
}
test('a legacy full-material request sends only relevant attachment bodies to the final model', async t => {
  setup(t, { inspect: body => {
    assert.deepEqual(body.submission.attachments.map(file => file.fieldKey), ['orders'])
    assert.equal(body.omittedAttachments.length, 2)
    assert.doesNotMatch(JSON.stringify(body), /x{100}/)
  } })
  const result = await request()
  assert.equal(result.result, true)
  assert.equal(result.evidenceSelection.omitted.length, 2)
})
test('mandatory material presence is checked before any omission decision', async t => {
  const fetch = setup(t)
  const result = await request({ files: [] })
  assert.equal(result.result, null)
  assert.match(result.reason, /orders|profit|guide/)
  assert.equal(fetch.mock.callCount(), 0)
})
test('raising the attachment budget permits a relevant 30k document without truncation', async t => {
  setup(t, { env: { WCPD_APPROVAL_SELECT_STEP_ATTACHMENTS: '0' }, inspect: body => {
    assert.equal(body.submission.attachments.length, 3)
    assert.ok(body.submission.attachments[1].text.length > 20000)
  } })
  const result = await request()
  assert.equal(result.result, true)
  assert.equal(result.evidenceSelection, undefined)
})
test('a selected oversized attachment still requires manual verification', async t => {
  const fetch = setup(t, { env: { WCPD_APPROVAL_MAX_ATTACHMENT_CHARS: '20000', WCPD_APPROVAL_SELECT_STEP_ATTACHMENTS: '0' } })
  const result = await request()
  assert.equal(result.result, null)
  assert.match(result.reason, /利润测算表.*20000字/)
  assert.equal(fetch.mock.callCount(), 0)
})
test('irrelevant oversized attachments may be omitted but cannot be claimed as reviewed', async t => {
  setup(t, { env: { WCPD_APPROVAL_MAX_ATTACHMENT_CHARS: '20000' }, inspect: body => {
    assert.deepEqual(body.submission.attachments.map(file => file.fieldKey), ['orders'])
  } })
  const result = await request()
  assert.equal(result.result, true)
  assert.match(result.evidenceSelection.omitted[0].reason, /不核验利润/)
})
test('a configured total prompt budget is still enforced for required material', async t => {
  const fetch = setup(t, { env: { WCPD_APPROVAL_MAX_PROMPT_CHARS: '10000', WCPD_APPROVAL_SELECT_STEP_ATTACHMENTS: '0' } })
  const result = await request()
  assert.equal(result.result, null)
  assert.match(result.reason, /合计超过.*10000字/)
  assert.equal(fetch.mock.callCount(), 0)
})
