const assert = require('assert')
const store = require('./docmostMappingStore')

function test(name, fn) {
  try {
    fn()
    console.log('ok -', name)
  } catch (err) {
    console.error('FAIL -', name)
    throw err
  }
}

test('standardTitle appends suffix once', () => {
  assert.strictEqual(store.standardTitle('招聘 SOP'), '招聘 SOP · 标准知识')
  assert.strictEqual(store.standardTitle('招聘 SOP · 标准知识'), '招聘 SOP · 标准知识')
})

test('topicKeyFromCanonicalPath', () => {
  assert.strictEqual(store.topicKeyFromCanonicalPath('README.md'), 'README')
  assert.strictEqual(store.topicKeyFromCanonicalPath('branches/hire.md'), 'branches/hire.md')
})

test('assertReplaceAllowed: only mindmap standard', () => {
  const ok = store.assertReplaceAllowed(
    {
      slot: 'standard',
      owner: 'mindmap',
      topic_key: 'README',
      docmost_page_id: 'p1'
    },
    { topicKey: 'README', expectedPageId: 'p1' }
  )
  assert.deepStrictEqual(ok, { ok: true })

  const human = store.assertReplaceAllowed(
    {
      slot: 'human',
      owner: 'human',
      topic_key: 'README',
      docmost_page_id: 'p1'
    },
    { topicKey: 'README' }
  )
  assert.strictEqual(human.ok, false)
  assert.match(human.reason, /slot_not_standard/)

  const ai = store.assertReplaceAllowed(
    {
      slot: 'ai',
      owner: 'ai',
      topic_key: 'README',
      docmost_page_id: 'p2'
    },
    { topicKey: 'README' }
  )
  assert.strictEqual(ai.ok, false)

  const badOwner = store.assertReplaceAllowed(
    {
      slot: 'standard',
      owner: 'human',
      topic_key: 'README',
      docmost_page_id: 'p1'
    },
    { topicKey: 'README' }
  )
  assert.strictEqual(badOwner.ok, false)
  assert.match(badOwner.reason, /owner_not_mindmap/)

  const missing = store.assertReplaceAllowed(null, { topicKey: 'README' })
  assert.strictEqual(missing.ok, false)
})

test('ownership marker roundtrip', () => {
  const md = store.ownershipMarker({
    roomId: 'r1',
    topicKey: 'README',
    slot: 'standard',
    owner: 'mindmap'
  })
  const parsed = store.parseOwnershipMarker(md + '# Title\n')
  assert.deepStrictEqual(parsed, {
    roomId: 'r1',
    topicKey: 'README',
    slot: 'standard',
    owner: 'mindmap'
  })
})

test('slot/owner contract on upsert rejects mismatch (sync)', () => {
  assert.strictEqual(store.expectedOwner('standard'), 'mindmap')
  assert.strictEqual(store.expectedOwner('human'), 'human')
  assert.strictEqual(store.expectedOwner('ai'), 'ai')
})

console.log('all docmostMappingStore unit tests passed')