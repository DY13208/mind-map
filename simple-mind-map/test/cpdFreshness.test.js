const test = require('node:test')
const assert = require('node:assert/strict')
const { checkRunFreshness, hash } = require('../bin/checkRuns/freshness')
const chain = require('../bin/checkRuns/chain')
const { RULE_VERSION } = require('../bin/checkRuns/rules')

function fixture() {
  const snapshot = { nodes: {
    root: { data: { text: '业务' }, children: ['c', 'other'] },
    c: { data: { text: 'C：产物通过10项' }, children: ['p'] },
    p: { data: { text: 'P：每周完成10项' }, children: ['d'] },
    d: { data: { text: 'D：生成清单' }, children: [] },
    other: { data: { text: '无关业务' }, children: [] }
  }, mapVersion: 1, sources: [] }
  const resolved = chain.resolveCheckChain(snapshot, 'd')
  assert.equal(resolved.status, 'resolved')
  const run = { roomKey: 'r', nodeUid: 'd', status: 'needs_supplement',
    ruleVersion: RULE_VERSION, report: { ruleVersion: RULE_VERSION, chain: resolved.chain },
    chainFingerprint: chain.fingerprintChain(snapshot, resolved.chain), sourceRefs: [], selection: {} }
  return { snapshot, run }
}

test('未通过报告也核验新鲜度，无关图修改不使本链报告过期', async () => {
  const { snapshot, run } = fixture()
  snapshot.mapVersion++
  snapshot.nodes.other.data.text = '其他业务修改'
  const deps = { loadSnapshot: async () => snapshot }
  assert.equal((await checkRunFreshness(run, deps)).fresh, true)
  snapshot.nodes.d.data.note = '本链补齐'
  assert.equal((await checkRunFreshness(run, deps)).fresh, false)
})

test('外部来源版本、正文、权限及规则变化均使报告过期，携带当前用户身份', async () => {
  const { snapshot, run } = fixture()
  run.sourceRefs = [{ sourceRef: { type: 'canonical', roomKey: 'r', id: 'doc' },
    version: 'v1', contentHash: hash('完整材料'), complete: true, status: 'ok' }]
  const actor = { id: 'viewer' }
  let read = { status: 'ok', version: 'v1', content: '完整材料', complete: true }
  const deps = { loadSnapshot: async () => snapshot, readSource: async args => {
    assert.equal(args.roomKey, 'r')
    assert.equal(args.actor, actor)
    return read
  } }
  assert.equal((await checkRunFreshness(run, deps, { actor })).fresh, true)
  read = { ...read, content: '内容改变' }
  assert.equal((await checkRunFreshness(run, deps, { actor })).fresh, false)
  read = { ...read, content: '完整材料', version: 'v2' }
  assert.equal((await checkRunFreshness(run, deps, { actor })).fresh, false)
  read = { status: 'forbidden', complete: false }
  assert.equal((await checkRunFreshness(run, deps, { actor })).fresh, false)
  run.ruleVersion = 'old'
  assert.equal((await checkRunFreshness(run, deps, { actor })).fresh, false)
})

test('资料链接与祖先内容变化被链路指纹捕获', async () => {
  const { snapshot, run } = fixture()
  snapshot.nodes.d.data.hyperlink = 'https://example.com/project-material'
  assert.equal((await checkRunFreshness(run, { loadSnapshot: async () => snapshot })).fresh, false)
  delete snapshot.nodes.d.data.hyperlink
  snapshot.nodes.root.data.note = '项目阈值更新'
  assert.equal((await checkRunFreshness(run, { loadSnapshot: async () => snapshot })).fresh, false)
})

test('确认对应链前校验整个候选版本，不将新链替换进旧报告', async () => {
  const snapshot = { nodes: {
    root: { data: { text: '业务' }, children: ['c1', 'c2', 'p'] },
    c1: { data: { text: 'C：数量达到10件' }, children: [] },
    c2: { data: { text: 'C：质量合格率100%' }, children: [] },
    p: { data: { text: 'P：生成10件' }, children: ['d'] },
    d: { data: { text: 'D：制作产物' }, children: [] }
  }, sources: [] }
  const resolved = chain.resolveCheckChain(snapshot, 'd')
  assert.equal(resolved.status, 'needs_confirmation')
  const run = { roomKey: 'r', nodeUid: 'd', ruleVersion: RULE_VERSION,
    report: { ruleVersion: RULE_VERSION, chain: null }, selection: {}, sourceRefs: [],
    chainFingerprint: hash(resolved.candidates.map(candidate => chain.fingerprintChain(snapshot, candidate)).sort().join('|')) }
  const chosenId = resolved.candidates[0].candidateId
  const result = await checkRunFreshness(run, { loadSnapshot: async () => snapshot }, { candidateId: chosenId })
  assert.equal(result.fresh, true)
  assert.equal(result.chain.candidateId, chosenId)
  snapshot.nodes.c2.data.note = '验收标准改变'
  assert.equal((await checkRunFreshness(run, { loadSnapshot: async () => snapshot }, { candidateId: chosenId })).fresh, false)
})
