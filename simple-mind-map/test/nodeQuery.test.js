const assert = require('assert')
const {
  DEFAULT_BYTE_LIMIT,
  decodeCursor,
  encodeCursor,
  normalizeName,
  normalizeRequest,
  queryLegacyNodes
} = require('../bin/nodeQuery')

function expectCode(fn, code) {
  assert.throws(fn, err => err && err.code === code)
}

function testNormalizeName() {
  assert.strictEqual(normalizeName('<p>  Alpha&nbsp; Beta </p>'), 'alpha beta')
  assert.strictEqual(normalizeName('<span>项目</span> 计划'), '项目 计划')
}

function testRequestRules() {
  const absolute = normalizeRequest({ scope: 'level', level: 2 })
  assert.strictEqual(absolute.level_mode, 'absolute')
  assert.strictEqual(absolute.page_size, 800)
  assert.strictEqual(absolute.byte_limit, DEFAULT_BYTE_LIMIT)

  const relative = normalizeRequest({
    scope: 'level',
    level: 1,
    level_mode: 'relative',
    selector: { type: 'path', segments: ['根', '计划'] }
  })
  assert.deepStrictEqual(relative.selector.segments, ['根', '计划'])
  expectCode(
    () => normalizeRequest({ scope: 'level', level: 1, selector: { type: 'uid', value: 'n1' } }),
    'INVALID_QUERY'
  )
  expectCode(
    () => normalizeRequest({ scope: 'subtree' }),
    'MISSING_SELECTOR'
  )
  expectCode(
    () => normalizeRequest({ scope: 'self', selector: { type: 'path', segments: ['根'], match: 'fuzzy' } }),
    'INVALID_SELECTOR'
  )
}

function testCursorRoundtrip() {
  const encoded = encodeCursor({ v: 1, q: 'fingerprint', version: 7, offset: 3 })
  assert.deepStrictEqual(decodeCursor(encoded), {
    v: 1,
    q: 'fingerprint',
    version: 7,
    offset: 3
  })
  expectCode(() => decodeCursor('not-a-cursor'), 'INVALID_CURSOR')
}

function testLegacyFallbackScopes() {
  const obj = {
    root: { isRoot: true, position: 'a0', data: { uid: 'root', text: '根' }, children: ['other', 'target'] },
    other: { position: 'a0', data: { uid: 'other', text: '无关' }, children: ['other-leaf'] },
    'other-leaf': { position: 'a0', data: { uid: 'other-leaf', text: '无关叶子' }, children: [] },
    target: { position: 'a1', data: { uid: 'target', text: '目标' }, children: ['detail'] },
    detail: { position: 'a0', data: { uid: 'detail', text: '详情' }, children: [] }
  }
  const subtree = queryLegacyNodes(obj, 'legacy', 3, {
    selector: { type: 'path', segments: ['根', '目标'] }, scope: 'subtree'
  })
  assert.deepStrictEqual(subtree.items.map(item => item.uid), ['target', 'detail'])
  assert.ok(subtree.warnings.includes('legacy_snapshot_fallback：该导图尚未建立 room_nodes，已使用兼容快照读取'))
  const level = queryLegacyNodes(obj, 'legacy', 3, {
    scope: 'level', level: 1, level_mode: 'absolute'
  })
  assert.deepStrictEqual(level.items.map(item => item.uid), ['other', 'target'])
}

testNormalizeName()
testRequestRules()
testCursorRoundtrip()
testLegacyFallbackScopes()
console.log('nodeQuery tests passed')
