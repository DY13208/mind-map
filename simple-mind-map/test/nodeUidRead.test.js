const assert = require('node:assert/strict')
const { test } = require('node:test')
const { nodesByUids } = require('../bin/mindDoc')

function fixture() {
  return {
    root: { isRoot: true, data: { uid: 'root', text: 'root' }, children: ['p', 'other'] },
    p: { data: { uid: 'p', text: '<p>rich</p>', richText: true, note: 'note',
      tags: ['tag'], attachmentId: 'synthetic', image: 'https://example.invalid/image.png',
      imageSize: { width: 20, height: 10 }, imgMap: { original: 'heavy' } }, children: ['b', 'a'] },
    b: { data: { uid: 'b', text: 'b' }, children: ['leaf'] },
    a: { data: { uid: 'a', text: 'a' }, children: [] },
    leaf: { data: { uid: 'leaf', text: 'leaf' }, children: [] },
    other: { data: { uid: 'other', text: 'other' }, children: [] }
  }
}

test('R13 production UID DTO preserves caller order, complete child IDs, data and exact totals', () => {
  const graph = fixture()
  const result = nodesByUids(graph, ['leaf', 'missing', 'p', 'b', 'p'])
  assert.deepEqual(result.map(item => item.uid), ['leaf', 'p', 'b', 'p'])
  const parent = result[1]
  assert.deepEqual(parent.children, ['b', 'a'])
  assert.equal(parent.data.childCount, 2)
  assert.equal(parent.data.descendantCount, 3)
  assert.equal(parent.data.note, 'note')
  assert.equal(parent.data.richText, true)
  assert.deepEqual(parent.data.tags, ['tag'])
  assert.equal(parent.data.attachmentId, 'synthetic')
  assert.deepEqual(parent.data.imageSize, { width: 20, height: 10 })
  assert.equal(Object.hasOwn(parent.data, 'imgMap'), false)
  assert.equal(Object.hasOwn(graph.p.data, 'imgMap'), true, 'read must not mutate source')
})

test('R13 UID DTO applies the 200-input cap before missing UID filtering', () => {
  const graph = fixture()
  const input = Array.from({ length: 201 }, (_, i) => i === 200 ? 'p' : 'missing-' + i)
  assert.deepEqual(nodesByUids(graph, input), [])
  assert.equal(nodesByUids(graph, Array(205).fill('p')).length, 200)
  assert.deepEqual(nodesByUids(graph, []), [])
})
