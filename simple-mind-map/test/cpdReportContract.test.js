'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const chainUtils = require('../bin/checkRuns/chain')
const rules = require('../bin/checkRuns/rules')
const contract = require('../bin/checkRuns/reportContract')
const { applyChainEvidence } = require('../bin/checkRuns/localEvidence')

function makeFixture({ incompleteAttachment = false } = {}) {
  const snapshot = {
    roomKey: 'room-contract-test',
    nodes: {
      c: { uid: 'c', text: 'C：会员成交率达到 95%，未达标时复核。', note: '判据：成交率不低于 95%。', children: [] },
      p: { uid: 'p', text: 'P：每月提升会员成交率。', note: '目标值：95%。', children: [] },
      d: { uid: 'd', text: 'D：每周核对会员成交记录', note: '频率：每周', data: {
        inputs: '会员记录', attachments: [{ id: 'member-source' }, { id: 'sales-source' }]
      }, children: [] }
    },
    sources: [
      { sourceRef: { type: 'attachment', roomId: 'room-contract-test', id: 'member-source', nodeUid: 'd' },
        nodeUid: 'd', title: '会员台账', content: '会员记录来自 CRM 系统，每周更新。', status: 'ready', complete: true, version: '1' },
      { sourceRef: { type: 'attachment', roomId: 'room-contract-test', id: 'sales-source', nodeUid: 'd' },
        nodeUid: 'd', title: '销售日报', content: '销售日报按日生成。', status: incompleteAttachment ? 'truncated' : 'ready',
        complete: !incompleteAttachment, truncated: incompleteAttachment, version: '1' }
    ]
  }
  const chain = {
    chainUid: 'd', nodeUids: ['c', 'p', 'd'], auditNodeUids: ['c', 'p', 'd'],
    checkRootUids: ['c'], planRootUids: ['p'], executionUids: ['d']
  }
  return { snapshot, chain }
}

function finding(overrides = {}) {
  return {
    ruleId: 'CK-09', title: 'D 五要素齐全', status: 'needs_supplement', severity: 'blocker',
    field: 'frequency', nodeUid: 'd', quote: 'D：每周核对会员成交记录',
    evidence: 'D 节点缺少频率。', message: 'D 节点缺少频率。', ...overrides
  }
}

function ck29(sourceRef, requiredQuote, message = `材料“${requiredQuote}”已完整读取，需核验与此 D 输入的对应关系。`) {
  return {
    ruleId: 'CK-29', title: '整链材料齐备', status: 'needs_info', severity: 'blocker', field: 'reference',
    nodeUid: 'd', quote: '会员记录', requiredQuote,
    sourceRef, message, checkKey: `CK-29:d:${requiredQuote}`
  }
}

test('系统说明不再伪装原文；依据引用逐条校验且保留备注全文 hash', () => {
  const { snapshot, chain } = makeFixture()
  const report = { findings: [finding()] }
  const result = contract.decorateReport(report, { snapshot, chain })
  const item = result.findings[0]
  assert.equal(result, report, 'decorateReport 原位更新并返回同一个报告对象')
  assert.equal(item.diagnostic, 'D 节点缺少频率。')
  assert.equal(item.evidence, 'D：每周核对会员成交记录\n频率：每周')
  assert.ok(item.evidenceEntries.every(entry =>
    ['C：会员成交率达到 95%，未达标时复核。', '判据：成交率不低于 95%。', 'D：每周核对会员成交记录', '频率：每周'].some(text => text.includes(entry.quote))))
  const note = item.evidenceEntries.find(entry => entry.kind === 'node_note' && entry.nodeUid === 'd')
  assert.equal(note.contentHash, crypto.createHash('sha256').update('频率：每周').digest('hex'))
  assert.equal(note.contentSummary, '频率：每周')
  assert.equal(note.sourceRef.type, 'chain_node')
  assert.equal(typeof note.position, 'string')
  assert.ok(item.findingKey)
})

test('CK-27/28 的 requiredEvidenceIds 覆盖全部 C/P 正文和备注，不拼接角色标签进原文', () => {
  const { snapshot, chain } = makeFixture()
  const cText = snapshot.nodes.c.text
  const pText = snapshot.nodes.p.text
  const report = { findings: [
    { ruleId: 'CK-27', title: 'C 项对应 P 目标', status: 'needs_info', severity: 'blocker', nodeUid: 'c',
      evidence: `C 原文：${cText}\nP 原文：${pText}`, message: '请核对 C/P 对应关系。' },
    { ruleId: 'CK-28', title: 'P 目标有 C 收口', status: 'needs_info', severity: 'blocker', nodeUid: 'p',
      evidence: `C 原文：${cText}\nP 原文：${pText}`, message: '请核对 P/C 收口关系。' }
  ] }
  contract.decorateReport(report, { snapshot, chain })
  for (const item of report.findings) {
    assert.equal(item.reviewable, true)
    assert.equal(item.validationType, 'manual_text_review')
    const required = item.requiredEvidenceIds.map(id => item.evidenceEntries.find(entry => entry.id === id))
    assert.ok(required.some(entry => entry.nodeUid === 'c' && entry.kind === 'node_text' && entry.quote === cText))
    assert.ok(required.some(entry => entry.nodeUid === 'p' && entry.kind === 'node_text' && entry.quote === pText))
    assert.ok(required.some(entry => entry.nodeUid === 'c' && entry.kind === 'node_note'))
    assert.ok(required.some(entry => entry.nodeUid === 'p' && entry.kind === 'node_note'))
    assert.ok(required.every(entry => entry.complete))
    assert.ok(required.every(entry => !entry.quote.startsWith('C 原文：') && !entry.quote.startsWith('P 原文：')))
  }
})

test('未完整读取的绑定材料把缺项改为尚未核验，不开放人工核对', () => {
  const { snapshot, chain } = makeFixture({ incompleteAttachment: true })
  const report = { findings: [finding()] }
  contract.decorateReport(report, { snapshot, chain })
  const item = report.findings[0]
  assert.equal(item.status, 'needs_info')
  assert.equal(item.category, 'source_error')
  assert.equal(item.coverage.complete, false)
  assert.match(item.message, /尚未核验/)
  assert.equal(item.reviewable, false)
})

test('完整绑定附件可先成为本链字段候选，但缺项仍未通过且不伪造原文', () => {
  const { snapshot, chain } = makeFixture()
  snapshot.nodes.d.data.attachments = [{ id: 'owner-source' }]
  snapshot.sources.push({
    sourceRef: { type: 'attachment', roomId: snapshot.roomKey, id: 'owner-source', nodeUid: 'd' },
    nodeUid: 'd', title: '项目责任清单', content: '责任人：会员运营专员', status: 'ready', complete: true
  })
  const findings = [{ ruleId: 'CK-09', title: 'D 五要素齐全', status: 'needs_supplement', severity: 'blocker',
    field: 'owner', nodeUid: 'd', message: 'D 节点缺少责任人。' }]
  const result = applyChainEvidence(snapshot, chain, findings, { roomKey: snapshot.roomKey })
  assert.equal(result.localMaterialCandidates.length, 1)
  assert.equal(result.localMaterialCandidates[0].quote, '责任人：会员运营专员')
  assert.equal(result.localMaterialCandidates[0].quoteKind, 'attachment')
  assert.equal(result.findings[0].status, 'needs_supplement')
  assert.equal(result.findings[0].localEvidenceFound, true)
  assert.equal(result.unresolvedForSearch.length, 0)
})

test('CK-29 仅允许核对命中 requiredQuote 的精确绑定来源', () => {
  const { snapshot, chain } = makeFixture()
  const matchedRef = snapshot.sources[0].sourceRef
  const unmatchedRef = snapshot.sources[1].sourceRef
  const report = { findings: [
    ck29(matchedRef, '会员记录'),
    ck29(unmatchedRef, '会员记录', '已关联材料但正文未识别到“会员记录”。')
  ] }
  contract.decorateReport(report, { snapshot, chain })
  const [matched, unmatched] = report.findings
  assert.equal(matched.reviewable, true)
  assert.equal(matched.validationType, 'manual_text_review')
  assert.equal(unmatched.reviewable, false)
  assert.ok(matched.requiredEvidenceIds.every(id => {
    const entry = matched.evidenceEntries.find(item => item.id === id)
    return entry.nodeUid === 'd' || entry.sourceId === contractSourceId(matchedRef)
  }))
  assert.equal(matched.evidenceEntries.some(entry => entry.sourceId === contractSourceId(unmatchedRef)), false)
})

function contractSourceId(ref) {
  return require('../bin/checkRuns/identity').sourceIdFor(ref)
}

test('分类、阻断和旧统计同源；CK-32 不计入 actionable，CK-30/34 错误折叠', () => {
  const { snapshot, chain } = makeFixture()
  const report = {
    status: 'needs_confirmation',
    sourceStatuses: [{ scope: 'wiki', status: 'unavailable', error: 'wiki_timeout', candidateId: 'topic-a' }],
    findings: [
      finding(),
      { ruleId: 'CK-32', title: '缺项汇总', status: 'needs_supplement', severity: 'warning', nodeUid: 'd' },
      { ruleId: 'CK-30', title: '三级检索', status: 'passed', severity: 'warning', message: '检索完成。' },
      { ruleId: 'CK-33', title: '知识节点定位', status: 'needs_info', severity: 'warning', message: 'Wiki 读取失败。' },
      { ruleId: 'CK-34', title: '检索纪律', status: 'needs_info', severity: 'warning', message: 'Wiki 读取失败。' },
      { ruleId: 'CK-14', title: '命名与来源规范', status: 'needs_info', severity: 'warning', message: '名称提示。' },
      { ruleId: 'CK-06', title: '节点归属与孤儿节点', status: 'passed', severity: 'info', message: '结构完整。' }
    ]
  }
  contract.decorateReport(report, { snapshot, chain })
  const active = report.findings.filter(item => item.display !== false && item.ruleId !== 'CK-32' && item.category !== 'auxiliary')
  assert.equal(report.summary.actionable, active.filter(item => ['failed', 'blocked', 'needs_info', 'needs_supplement', 'needs_confirmation'].includes(item.status)).length)
  assert.equal(report.summary.blockers, active.filter(item => item.blocking).length)
  assert.equal(report.summary.categories.auxiliary, 3, 'CK-32 与已合并 CK-33/34 只留为辅助记录')
  assert.equal(report.findings.find(item => item.ruleId === 'CK-30').relatedRuleIds.includes('CK-34'), true)
  assert.equal(report.findings.find(item => item.ruleId === 'CK-30').status, 'needs_info', 'sourceStatus failure cannot remain marked passed')
  assert.equal(report.findings.find(item => item.ruleId === 'CK-33').display, false)
  assert.equal(report.findings.find(item => item.ruleId === 'CK-34').display, false)
  assert.equal(report.findings.find(item => item.ruleId === 'CK-14').category, 'hint')
  const before = JSON.stringify(report)
  contract.decorateReport(report, { snapshot, chain })
  assert.equal(JSON.stringify(report), before, '重复装饰不得复制 evidence 或计数')
})

test('房间资料目录权限错误有用户可读来源标签并保留来源异常分类', () => {
  const { snapshot, chain } = makeFixture()
  assert.equal(rules.sourceStatusLabel('unavailable', 'canonical_storage_permission_denied'), '房间资料目录无读取权限')
  const report = {
    sourceStatuses: [{ scope: 'company_ai', status: 'unavailable', error: 'canonical_storage_permission_denied' }],
    findings: [
      { ruleId: 'CK-30', title: '三级检索', status: 'needs_info', severity: 'warning' },
      { ruleId: 'CK-31', title: '正常项', status: 'passed', severity: 'info' },
      { ruleId: 'CK-31', title: '失败项', status: 'failed', severity: 'blocker' }
    ]
  }
  contract.decorateReport(report, { snapshot, chain })
  assert.equal(report.findings.find(item => item.ruleId === 'CK-30').category, 'source_error')
  assert.equal(report.findings.find(item => item.ruleId === 'CK-31' && item.status === 'passed').status, 'passed')
  assert.equal(report.findings.find(item => item.ruleId === 'CK-31' && item.status === 'failed').status, 'failed')
})

test('人工确认通过后重算清除阻断并保留复核资格；演示报告不可正式通过；stale 不覆盖', () => {
  const { snapshot, chain } = makeFixture()
  const report = { status: 'needs_confirmation', findings: [{
    ruleId: 'CK-27', title: 'C 项对应 P 目标', status: 'passed', machineStatus: 'needs_info',
    manualReview: { decision: 'confirm', machineStatus: 'needs_info' }, severity: 'blocker', nodeUid: 'c', message: '已核对。'
  }] }
  contract.decorateReport(report, { snapshot, chain })
  assert.equal(report.findings[0].reviewable, true)
  assert.equal(report.findings[0].category, 'passed')
  assert.equal(report.findings[0].blocking, false)
  assert.equal(report.summary.blockers, 0)
  assert.equal(report.status, 'passed')

  const demo = { status: 'passed', findings: [{ ruleId: 'CK-14', status: 'passed', severity: 'info' }] }
  contract.decorateReport(demo, { snapshot, chain, mode: 'demo' })
  assert.equal(demo.formalPassEligible, false)
  assert.equal(demo.status, 'needs_confirmation')

  const modeAssignedAfterDecoration = { status: 'passed', mode: 'demo', provenanceMode: 'business', findings: [{
    ruleId: 'CK-14', status: 'passed', severity: 'info', formalPassEligible: true
  }] }
  contract.summarizeReport(modeAssignedAfterDecoration)
  assert.equal(modeAssignedAfterDecoration.formalPassEligible, false)
  assert.equal(modeAssignedAfterDecoration.findings[0].formalPassEligible, false)
  assert.equal(modeAssignedAfterDecoration.status, 'needs_confirmation')

  const stale = { status: 'stale', findings: [] }
  contract.summarizeReport(stale)
  assert.equal(stale.status, 'stale')
})

test('待选链路和结构失败报告允许 chain=null，不会误变为通过', () => {
  const { snapshot } = makeFixture()
  const pending = { status: 'needs_confirmation', selectionStage: 'chain', findings: [] }
  contract.decorateReport(pending, { snapshot, chain: null })
  assert.equal(pending.status, 'needs_confirmation')

  const failed = { status: 'blocked', findings: [{
    ruleId: 'CK-12', title: '过程 C 与 D 上溯关系', status: 'failed', severity: 'blocker',
    nodeUid: 'd', quote: 'D：每周核对会员成交记录', message: '无法定位 C。'
  }] }
  contract.decorateReport(failed, { snapshot, chain: null })
  assert.equal(failed.status, 'blocked')
  assert.equal(failed.findings[0].category, 'structure')
  assert.equal(failed.findings[0].evidenceEntries[0].quote, 'D：每周核对会员成交记录')
})

test('规则版本升级到 evidence/review v5', () => {
  assert.equal(rules.RULE_VERSION, 'cpd-check-v5-evidence-review-2026-09-29')
})
