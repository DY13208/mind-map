const test = require('node:test')
const assert = require('node:assert/strict')
const { applyChainEvidence } = require('../bin/checkRuns/localEvidence')

test('缺字段先从本链路原文找，记录候选但不改图或标通过', () => {
  const snapshot = { nodes: {
    parent: { data: { text: '项目说明', note: '责任人：项目经理\n频率：每周' }, children: ['d'] },
    d: { data: { text: 'D：执行' }, children: [] },
    other: { data: { text: '无关流程', note: '产物：外部报告' }, children: [] }
  }, sources: [] }
  const before = JSON.stringify(snapshot)
  const findings = ['owner', 'frequency', 'outputs'].map(field => ({ ruleId: 'CK-09',
    field, nodeUid: 'd', severity: 'blocker', status: 'needs_supplement' }))
  const result = applyChainEvidence(snapshot, { nodeUids: ['parent', 'd'] }, findings, { roomKey: 'r' })
  assert.equal(result.localMaterialCandidates.length, 2)
  assert.equal(result.localMaterialCandidates[0].suggestedValue, '项目经理')
  assert.deepEqual(result.unresolvedForSearch.map(item => item.field), ['outputs'])
  assert.equal(result.findings.every(item => item.status === 'needs_supplement'), true)
  assert.equal(JSON.stringify(snapshot), before)
})

test('截断、未解析、占位和保密材料不成为本链缺项依据', () => {
  const snapshot = { nodes: {
    d: { data: { text: 'D：执行' }, children: [] },
    placeholder: { data: { text: '项目', note: '责任人：待确认' }, children: [] },
    secret: { data: { text: '保密项目', note: '责任人：秘密值', confidential: true }, children: [] }
  }, sources: [{ nodeUid: 'd', title: '输入表', content: '输入表', status: 'ok', complete: false, truncated: true }] }
  const findings = [
    { ruleId: 'CK-09', field: 'owner', nodeUid: 'd', severity: 'blocker', status: 'needs_supplement' },
    { ruleId: 'CK-29', field: 'reference', nodeUid: 'd', message: '缺少“输入表”。', severity: 'blocker', status: 'needs_supplement' }
  ]
  const result = applyChainEvidence(snapshot, { nodeUids: ['d', 'placeholder', 'secret'] }, findings)
  assert.equal(result.localMaterialCandidates.length, 0)
  assert.equal(result.unresolvedForSearch.length, 2)
  snapshot.sources[0].complete = true
  snapshot.sources[0].truncated = false
  const complete = applyChainEvidence(snapshot, { nodeUids: ['d', 'placeholder', 'secret'] }, findings)
  assert.equal(complete.localMaterialCandidates.length, 1)
  assert.equal(complete.findings[1].status, 'needs_supplement')
})
