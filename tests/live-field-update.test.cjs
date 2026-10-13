const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

async function load() {
  const source = fs.readFileSync(path.join(__dirname, '../simple-mind-map/src/plugins/cooperateRecovery.js'), 'utf8')
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
}

test('large live field updates avoid full-index copies and preserve untouched entries', async () => {
  const { applyCollabEvent } = await load()
  const nodes = {}
  for (let i = 0; i < 20000; i++) nodes['n' + i] = { data: { uid: 'n' + i, text: 'before' }, children: [] }
  let scans = 0
  const index = new Proxy(nodes, { ownKeys(target) { scans++; return Reflect.ownKeys(target) } })
  const old = nodes.n100
  const untouched = nodes.n101
  for (let i = 0; i < 100; i++) {
    assert.equal(applyCollabEvent(index, { type: 'node.updated', payload: { uid: 'n100', patch: { text: 'after-' + i } } }, { liveFieldUpdate: true }), index)
  }
  assert.equal(scans, 0)
  assert.equal(nodes.n100.data.text, 'after-99')
  assert.equal(old.data.text, 'before')
  assert.equal(nodes.n101, untouched)
})

test('live field results match recovery and structural updates retain immutable path', async () => {
  const { applyCollabEvent } = await load()
  const base = { root: { data: { uid: 'root' }, children: ['a', 'b'] }, a: { data: { uid: 'a', text: 'old' }, children: [] }, b: { data: { uid: 'b' }, children: [] } }
  const event = { type: 'node.updated', payload: { uid: 'a', patch: { note: 'new' }, text: 'updated' } }
  const expected = applyCollabEvent(base, event)
  const live = structuredClone(base)
  assert.deepEqual(applyCollabEvent(live, event, { liveFieldUpdate: true }), expected)
  assert.equal(base.a.data.text, 'old')
  const move = { type: 'node.updated', payload: { uid: 'a', parentUid: 'b', patch: { text: 'moved' } } }
  assert.notEqual(applyCollabEvent(base, move, { liveFieldUpdate: true }), base)
  assert.deepEqual(base.root.children, ['a', 'b'])
  assert.throws(() => applyCollabEvent(live, { type: 'node.updated', payload: { uid: 'missing', patch: {} } }, { liveFieldUpdate: true }), /node not found/)
})
