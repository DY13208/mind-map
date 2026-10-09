const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

test('publishes complete room generations, preserves stable IDs and skips unchanged input', async t => {
  const { publishRoom } = require('./compiler')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-independent-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const input = { roomId: 'room-a', title: '个人脑图', version: 2, revision: 0,
    topics: [{ nodeUid: 'root', title: '概览', markdown: '根备注', parentUid: null },
      { nodeUid: 'branch', title: '预算', markdown: '## 成本\n\n预算 100', parentUid: 'root' }] }
  const first = await publishRoom(dir, input)
  const pointerFile = path.join(dir, 'rooms', 'room-a', 'current.json')
  const pointer = await fs.readFile(pointerFile, 'utf8')
  assert.equal(first.changed, true)
  const state = JSON.parse(pointer)
  const generation = JSON.parse(await fs.readFile(path.join(dir, 'rooms', 'room-a', 'generations', state.generation, 'bundle.json'), 'utf8'))
  assert.equal(generation.topics.length, 2)
  assert.match(generation.topics[1].markdown, /预算 100/)
  assert.equal(generation.topics[1].roomId, 'room-a')
  assert.equal((await publishRoom(dir, input)).changed, false)
  assert.equal(await fs.readFile(pointerFile, 'utf8'), pointer)
  const updated = await publishRoom(dir, { ...input, version: 3, topics: input.topics.map(x => ({ ...x, title: x.title + '改名' })) })
  assert.equal(updated.changed, true)
  const latest = JSON.parse(await fs.readFile(pointerFile, 'utf8'))
  const next = JSON.parse(await fs.readFile(path.join(dir, 'rooms', 'room-a', 'generations', latest.generation, 'bundle.json'), 'utf8'))
  assert.equal(next.topics[1].slug, generation.topics[1].slug)
  assert.notEqual(next.topics[1].slug, (await publishRoom(dir, { ...input, roomId: 'room-b' })).slugs[1])
})

test('contract tree parser uses templates, preserves model records, and supplements JSON without Wiki', () => {
  const { parseContractTree } = require('./contracts')
  const nodes = [
    ['r', null, '公司模型'], ['c', 'r', '合同'], ['k', 'c', '采购'],
    ['tpl', 'k', '模板'], ['f', 'tpl', '金额'], ['one', 'k', '甲合同'],
    ['v', 'one', '金额'], ['value', 'v', '100']
  ].map(([uid, parent_uid, text], i) => ({ uid, parent_uid, position: String(i).padStart(3, '0'), data: { text } }))
  const result = parseContractTree(nodes)
  assert.equal(result.anchorUid, 'c')
  assert.deepEqual(result.categories[0].要素, ['金额'])
  assert.deepEqual(result.categories[0].合同记录[0].fields, { 金额: ['100'] })
  assert.equal(result.categories[0].nodeUid, 'k')
})
