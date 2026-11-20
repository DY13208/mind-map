const assert = require('node:assert/strict')
const { test } = require('node:test')
const skill = require('../bin/leaveWorkflow/jackyunSkill')
const cfg = { enabled: true, appKey: 'test', appSecret: 'test', url: 'https://open.jackyun.com/open/openapi/do',
  timeoutMs: 100, inventoryBudgetMs: 1000, maxInventoryPages: 4 }
const query = { kind: 'warehouse_stock', numberField: 'warehouseName', number: '测试中文仓库-保税' }
const warehouse = { warehouseName: query.number, warehouseCode: 'WH001' }
const stock = (index, quantity = 0) => ({ quantityId: String(index), warehouseCode: 'WH001',
  goodsNo: 'SKU' + index, currentQuantity: quantity })
function mock(t, inventory, warehouses = [warehouse]) {
  return t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const params = new URLSearchParams(options.body)
    const body = JSON.parse(params.get('bizcontent'))
    const data = params.get('method') === 'erp.warehouse.get'
      ? { warehouseInfo: warehouses } : { goodsStockQuantity: inventory(body) }
    return new Response(JSON.stringify({ code: 200, result: { data } }))
  })
}
test('Chinese warehouse names require neither document IDs nor screenshots', async t => {
  mock(t, () => [stock(1, 12)])
  assert.equal(skill.validQuery(query), true)
  const result = await skill.query(query, cfg)
  assert.equal(result.documents[0].hasStock, true)
  assert.equal(result.documents[0].quantityBasis, 'currentQuantity')
  assert.equal(result.documents[0].proof.currentQuantity, 12)
})
test('a zero first page cannot be mistaken for no stock', async t => {
  const fetch = mock(t, body => body.pageIndex === 0
    ? Array.from({ length: 50 }, (_, i) => stock(i)) : [stock(50, 3)])
  const result = await skill.query(query, cfg)
  assert.equal(result.documents[0].hasStock, true)
  assert.equal(result.documents[0].checkedRows, 51)
  assert.equal(fetch.mock.callCount(), 3)
})
test('no stock requires complete warehouse-scoped pagination', async t => {
  mock(t, body => {
    assert.equal(body.warehouseCode, 'WH001')
    return body.pageIndex === 0 ? Array.from({ length: 50 }, (_, i) => stock(i)) : []
  })
  const result = await skill.query(query, cfg)
  assert.equal(result.status, 'found')
  assert.equal(result.documents[0].hasStock, false)
  assert.equal(result.documents[0].scanComplete, true)
})
test('missing warehouses and stock absence remain distinct', async t => {
  const fetch = mock(t, () => { throw Error('must not query stock') }, [])
  const result = await skill.query(query, cfg)
  assert.equal(result.status, 'not_found')
  assert.match(result.reason, /未找到.*仓库/)
  assert.equal(fetch.mock.callCount(), 1)
})
test('fuzzy or ambiguous warehouse matches cannot select another warehouse', async t => {
  await t.test('fuzzy', async sub => {
    mock(sub, () => [], [{ ...warehouse, warehouseName: query.number + '-其他店' }])
    assert.equal((await skill.query(query, cfg)).status, 'not_found')
  })
  await t.test('ambiguous', async sub => {
    mock(sub, () => [], [warehouse, { ...warehouse, warehouseCode: 'WH002' }])
    await assert.rejects(skill.query(query, cfg), /同名仓库/)
  })
})
test('invalid quantities or records for another warehouse cannot prove zero', async t => {
  for (const value of [null, '', false, 'not-a-number', -1]) await t.test(String(value), async sub => {
    mock(sub, () => [stock(1, value)])
    await assert.rejects(skill.query(query, cfg), /库存/)
  })
  await t.test('wrong warehouse', async sub => {
    mock(sub, () => [{ ...stock(1), warehouseCode: 'WH-OTHER' }])
    await assert.rejects(skill.query(query, cfg), /其他仓库/)
  })
})
test('pagination limits and repeated pages remain unverifiable', async t => {
  const page = Array.from({ length: 50 }, (_, i) => stock(i))
  await t.test('limit', async sub => {
    mock(sub, () => page)
    await assert.rejects(skill.query(query, { ...cfg, maxInventoryPages: 1 }), /尚未完成/)
  })
  await t.test('repeated', async sub => {
    mock(sub, () => page)
    await assert.rejects(skill.query(query, cfg), /重复记录/)
  })
})
test('empty or wildcard warehouse lookups are rejected', () => {
  for (const number of ['', '*', '%', 'a\nwarehouse']) assert.equal(skill.validQuery({ ...query, number }), false)
})
