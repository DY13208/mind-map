const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createNodeCountCache } = require('../bin/nodeCountCache')

const value = uid => new Map([[uid, { childCount: 1, descendantCount: 3 }]])

test('R17 real count cache evicts the least recently used entry at 256 retained scopes', () => {
  const cache = createNodeCountCache()
  for (let i = 0; i < 256; i++) cache.set(`scope-${i}`, value(`node-${i}`))
  assert.ok(cache.get('scope-0')) // touching the oldest makes it most recent
  cache.set('scope-256', value('node-256'))
  assert.equal(Boolean(cache.get('scope-1')), false)
  assert.ok(cache.get('scope-0'))
  assert.ok(cache.get('scope-256'))
})

test('R17 real count cache retains at most 4 MiB of encoded keys and values and rejects oversized entries', () => {
  const cache = createNodeCountCache()
  const counts = new Map(Array.from({ length: 12000 }, (_, i) => [
    `node-${i}`.padEnd(256, 'x'), { childCount: 1, descendantCount: 3 }
  ]))
  const bytes = Buffer.byteLength(JSON.stringify(Array.from(counts)))
  assert.ok(bytes < 4 * 1024 * 1024 && bytes * 2 > 4 * 1024 * 1024)
  cache.set('first', counts)
  cache.set('second', counts)
  assert.equal(Boolean(cache.get('first')), false)
  assert.ok(cache.get('second'))
  const oversizedKey = 'k'.repeat(4 * 1024 * 1024)
  cache.set(oversizedKey, value('node'))
  assert.equal(Boolean(cache.get(oversizedKey)), false)
  assert.ok(cache.get('second'), 'an uncacheable scope must not evict useful retained counts')
})

test('R14 UID DTO and count entries share the same encoded 4 MiB budget', () => {
  const cache = createNodeCountCache()
  const dto = { room_key: 'synthetic', version: 7,
    nodes: [{ uid: 'target', data: { note: 'x'.repeat(2.5 * 1024 * 1024) }, children: [] }] }
  cache.set('uid-dto|first', dto)
  cache.set('uid-dto|second', dto)
  assert.equal(Boolean(cache.get('uid-dto|first')), false)
  assert.ok(cache.get('uid-dto|second'))
  cache.set('counts|small', value('node'))
  assert.ok(cache.get('counts|small'))
  assert.ok(cache.get('uid-dto|second'))
})
