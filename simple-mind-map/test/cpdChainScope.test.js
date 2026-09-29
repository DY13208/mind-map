'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const chain = require('../bin/checkRuns/chain')

function fixture() {
  const nodes = {
    c: { text: 'C：项目利润达到 10%', children: ['brand', 'users'] },
    brand: { text: 'P：品牌目标', children: ['brandD'] },
    brandD: { text: 'D：制定品牌目标', children: [] },
    users: { text: 'P：用户运营', children: ['members', 'support'] },
    members: { text: 'P：会员运营', children: ['membersD'] },
    membersD: { text: 'D：会员活动', children: [] },
    support: { text: 'P：客服运营', children: ['owner'] },
    owner: { text: '负责人分组', children: ['performance', 'daily'] },
    performance: { text: 'D：客服绩效管理', children: ['assessment'] },
    assessment: { text: '客服绩效考核', children: ['step'] },
    step: { text: '人：核对绩效考核表', children: [] },
    daily: { text: 'D：客服日常运维', children: [] }
  }
  return { nodes, sources: [] }
}

test('选中 D 仅检查本 D、最近 P 和相关 C，祖先与其他业务分支不展开', () => {
  const snapshot = fixture()
  const resolved = chain.resolveCheckChain(snapshot, 'performance')
  assert.equal(resolved.status, 'resolved')
  assert.deepEqual(resolved.chain.planRootUids, ['support'])
  assert.deepEqual(resolved.chain.executionUids, ['performance'])
  assert.deepEqual(resolved.chain.checkRootUids, ['c'])
  assert.deepEqual(new Set(resolved.chain.nodeUids), new Set(['c', 'users', 'support', 'owner', 'performance', 'assessment', 'step']))
  const data = chain.collectChainData(snapshot, resolved.chain)
  assert.deepEqual(data.planNodes.filter(n => n.role === 'P').map(n => n.uid), ['support'])
  assert.deepEqual(data.dNodes.map(n => n.uid), ['performance'])
  assert.deepEqual(data.steps.map(n => n.uid), ['step'])
  const before = chain.fingerprintChain(snapshot, resolved.chain)
  snapshot.nodes.daily.note = '其他 D 改动'
  snapshot.nodes.brand.children.push('newD')
  snapshot.nodes.newD = { text: 'D：新增品牌任务', children: [] }
  assert.equal(chain.fingerprintChain(snapshot, chain.resolveCheckChain(snapshot, 'performance').chain), before)
})

test('选中执行步骤沿用所属 D 范围，选 P 只展开该 P 的有界任务', () => {
  const snapshot = fixture()
  assert.deepEqual(chain.resolveCheckChain(snapshot, 'step').chain.executionUids, ['performance'])
  const resolved = chain.resolveCheckChain(snapshot, 'support')
  assert.equal(resolved.status, 'resolved')
  assert.deepEqual(new Set(resolved.chain.executionUids), new Set(['performance', 'daily']))
  assert.ok(!resolved.chain.nodeUids.includes('membersD'))
  assert.ok(!resolved.chain.nodeUids.includes('brandD'))
})

test('选中上层 C 有多个 P 时先确认，选择一条不合并其他 P 子树', () => {
  const snapshot = fixture()
  const resolved = chain.resolveCheckChain(snapshot, 'c')
  assert.equal(resolved.status, 'needs_confirmation')
  assert.equal(resolved.candidates.length, 2)
  const brand = resolved.candidates.find(candidate => candidate.planRootUids.includes('brand'))
  const selected = chain.resolveCheckChain(snapshot, 'c', brand.candidateId)
  assert.equal(selected.status, 'resolved')
  assert.ok(!selected.chain.nodeUids.includes('performance'))
  assert.ok(!selected.chain.nodeUids.includes('membersD'))
})

test('同级 C/P/D 选 D 时保留同级关系，不纳入另一个 D；多 P 需要确认', () => {
  const snapshot = { nodes: {
    owner: { text: '流程', children: ['c', 'p', 'd', 'otherD'] },
    c: { text: 'C：准确率达到 98%', children: [] },
    p: { text: 'P：准确率达到 98%', children: [] },
    d: { text: 'D：核对数据', children: [] },
    otherD: { text: 'D：其他任务', children: [] }
  } }
  const resolved = chain.resolveCheckChain(snapshot, 'd')
  assert.equal(resolved.status, 'resolved')
  assert.ok(!resolved.chain.nodeUids.includes('otherD'))
  snapshot.nodes.p2 = { text: 'P：另一目标', children: [] }
  snapshot.nodes.owner.children.push('p2')
  assert.equal(chain.resolveCheckChain(snapshot, 'd').status, 'needs_confirmation')
})
