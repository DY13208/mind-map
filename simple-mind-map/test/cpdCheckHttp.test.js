const test = require('node:test')
const assert = require('node:assert/strict')
const { createCheckHttp, attachmentSource } = require('../bin/cpdCheckHttp')

function harness({ deny = false } = {}) {
  const calls = []
  const dependencies = []
  const run = { id: 'report-1', nodeUid: 'D1', status: 'passed' }
  const handle = createCheckHttp({
    getPool: () => ({ query: async () => ({ rows: [] }) }),
    loadSnapshot: async () => ({ nodes: {}, mapVersion: 1 }),
    readBody: async req => req.body || {},
    sendJson: (res, code, body) => Object.assign(res, { code, body }),
    roomAcl: { assertRoomAccess: async (_, req, room, action) => {
      calls.push({ room, action, actor: req.authUser.id })
      if (deny) throw Object.assign(new Error('无权访问'), { statusCode: 403, code: 'FORBIDDEN' })
    } },
    providers: {},
    service: {
      createCheck: async (args, deps) => { dependencies.push(deps); calls.push(args); return run },
      confirmCheck: async (args, deps) => { dependencies.push(deps); calls.push(args); return run },
      listChecks: async args => { calls.push(args); return [run] },
      getCheck: async args => { calls.push(args); return run },
      reviewCheck: async args => { calls.push(args); return run },
      getCheckSource: async args => { calls.push(args); return { sourceId: args.sourceId } },
      retryCheckSource: async args => { calls.push(args); return run }
    }
  })
  return { calls, dependencies, handle, request: async (method, url, body, headers = {}) => {
    const res = {}
    await handle({ method, url, body, headers, authUser: { id: 'user-1' } }, res)
    return res
  } }
}

test('创建和确认是编辑权限，历史是查看权限，始终携带房间边界', async () => {
  const h = harness()
  assert.equal((await h.request('POST', '/api/files/room%201/cpd-checks', { nodeUid: 'D1', requestId: 'req1' })).code, 200)
  assert.equal(h.calls[0].action, 'edit')
  assert.equal(h.calls[1].roomKey, 'room 1')
  await h.request('GET', '/api/files/room%201/cpd-checks?nodeUid=D1')
  assert.equal(h.calls[2].action, 'view')
  assert.equal(h.calls[3].nodeUid, 'D1')
  await h.request('POST', '/api/files/room%201/cpd-checks/report-1/confirm', { candidateId: 'source-1' })
  assert.equal(h.calls[4].action, 'edit')
  assert.equal(h.calls[5].candidateId, 'source-1')
  assert.equal(h.dependencies.length, 2)
  assert.ok(h.dependencies.every(deps => !Object.hasOwn(deps, 'judgeSemantics')),
    '创建及确认检查均不注入模型判断入口')
})

test('无权限时不调用检查或读取来源', async () => {
  const h = harness({ deny: true })
  const res = await h.request('POST', '/api/files/private/cpd-checks', { nodeUid: 'D1' })
  assert.equal(res.code, 403)
  assert.equal(h.calls.length, 1)
})

test('检查路由不接管已有运行、补齐及任务派发接口', async () => {
  const h = harness()
  for (const url of ['/api/files/r/sop-runs/authorize', '/api/dispatch', '/api/files/r/supplement']) {
    assert.equal(await h.handle({ method: 'POST', url }, {}), false)
  }
  assert.equal(h.calls.length, 0)
})

test('附件未解析和超预算不能当作完整材料，版本包含正文状态', () => {
  const source = attachmentSource({ id: 'a', node_uid: 'D1', status: 'processing', total_chars: 10 }, 'r')
  assert.equal(source.complete, false)
  const large = attachmentSource({ id: 'a', status: 'ready', total_chars: 200001, content: 'x'.repeat(200001) }, 'r')
  assert.equal(large.truncated, true)
  assert.equal(large.complete, false)
  assert.equal(large.content.length, 200000)
  const unicode = attachmentSource({ id: 'unicode', status: 'ready', total_chars: 100001, content: '😀'.repeat(100001) }, 'r')
  assert.equal(unicode.complete, false)
  assert.equal(unicode.truncated, true)
  const budget = attachmentSource({ id: 'budget', status: 'ready', total_chars: 100, read_chars: 0, content: '' }, 'r')
  assert.equal(budget.complete, false)
  assert.equal(budget.truncated, true)
  const shared = attachmentSource({ id: 'shared', node_uid: 'original-node', status: 'ready', content: '完整资料', total_chars: 4 }, 'r', 'selected-D')
  assert.equal(shared.nodeUid, 'selected-D')
  assert.equal(shared.sourceRef.nodeUid, 'selected-D')
  assert.equal(shared.complete, true)
})


test('v5 核对与来源重读要求编辑权限，来源查看沿用查看权限并只接受登记 ID', async () => {
  const h = harness()
  const review = await h.request('POST', '/api/files/r/cpd-checks/report-1/reviews', { requestId: 'rev1', expectedRevision: 1, findingKey: 'f1', decision: 'confirm', reason: '核对', evidenceIds: ['e1'], sourceRef: { url: '不可信地址' } })
  assert.equal(review.code, 200)
  assert.equal(h.calls[0].action, 'edit')
  assert.equal(h.calls[1].findingKey, 'f1')
  assert.equal(Object.hasOwn(h.calls[1], 'sourceRef'), false)
  const source = await h.request('GET', '/api/files/r/cpd-checks/report-1/sources/source-1')
  assert.equal(source.body.source.sourceId, 'source-1')
  assert.equal(h.calls[2].action, 'view')
  await h.request('POST', '/api/files/r/cpd-checks/report-1/sources/source-1/retry', { requestId: 'retry1', expectedRevision: 2 })
  assert.equal(h.calls[4].action, 'edit')
  assert.equal(h.calls[5].expectedRevision, 2)
  const denied = harness({ deny: true })
  assert.equal((await denied.request('POST', '/api/files/r/cpd-checks/report-1/reviews', {})).code, 403)
  assert.equal(denied.calls.length, 1)
})
