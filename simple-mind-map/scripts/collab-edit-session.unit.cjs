const assert = require('node:assert/strict')

async function main() {
  const { createEditSessionManager } = await import(
    '../src/utils/collabEditSession.js'
  )
  const manager = createEditSessionManager()
  const baseSnapshot = {
    uid: 'node-1',
    data: { uid: 'node-1', text: 'before', richText: false },
    fieldVersions: { text: 4 }
  }
  const session = manager.begin({
    uid: 'node-1',
    roomKey: 'room-a',
    fields: ['text', 'richText'],
    kind: 'rich-text',
    initialDraft: { text: '<p>draft</p>', richText: true },
    snapshot: baseSnapshot
  })

  assert.deepEqual(manager.buildExpected(session.id, ['text', 'richText']), {
    uid: 'node-1',
    '__fv.text': 4
  })
  assert.equal(
    manager.validate(session.id, baseSnapshot, ['text']).ok,
    true,
    'an unchanged authoritative field version and value should validate'
  )

  const stale = manager.validate(
    session.id,
    {
      uid: 'node-1',
      data: { uid: 'node-1', text: 'remote', richText: false },
      fieldVersions: { text: 5 }
    },
    ['text']
  )
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'REPLACE_CONFLICT')
  assert.equal(stale.status, 409)
  assert.equal(stale.conflicts[0].actualVersion, 5)

  const missing = manager.validate(session.id, null, ['text'])
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'PRECONDITION_REQUIRED')
  assert.equal(missing.status, 428)

  const updated = manager.updateDraft(session.id, { text: '<p>newer draft</p>' })
  assert.equal(updated.draftRevision, session.draftRevision + 1)
  manager.setComposing(session.id, true)
  assert.equal(manager.get(session.id).composing, true)

  const secondManagerSession = createEditSessionManager().begin({
    uid: 'node-1',
    snapshot: baseSnapshot
  })
  assert.notEqual(
    secondManagerSession.id,
    session.id,
    'session ids from separate tabs/managers must not collide'
  )

  const restoredManager = createEditSessionManager()
  const restored = restoredManager.restore(manager.serialize(session.id))
  assert.equal(restored.state, 'conflict')
  assert.equal(restored.draft.text, '<p>newer draft</p>')
  assert.equal(restored.roomKey, 'room-a')
  assert.equal(restored.composing, false)

  assert.equal(manager.resolve(session.id).id, session.id)
  assert.equal(manager.get(session.id), null)

  const creation = manager.begin({
    uid: 'local-child', roomKey: 'room-a', fields: ['text', 'richText'],
    snapshot: { uid: 'local-child', data: { text: '<p>new</p>', richText: true } },
    initialDraft: { text: '<p>my unfinished draft</p>', richText: true }
  })
  manager.updateDraft(creation.id, { text: '<p>still typing</p>' })
  manager.setComposing(creation.id, true)
  const created = { uid: 'local-child', data: { text: '<p>new</p>', richText: true, __fv: { text: 7 } } }
  const initialized = manager.acknowledgeCreation(creation.id, created, 7)
  assert.equal(initialized.baseVersions.text, 7)
  assert.equal(initialized.draft.text, '<p>still typing</p>')
  assert.equal(initialized.draftRevision, 1)
  assert.equal(initialized.composing, true)
  assert.equal(manager.validate(creation.id, created).ok, true)
  assert.equal(manager.acknowledgeCreation(creation.id, created, 7), null,
    'creation ACK must not rebase an established session again')
  assert.equal(manager.validate(creation.id, {
    uid: 'local-child', data: { text: '<p>someone else</p>', richText: true, __fv: { text: 8 } }
  }).ok, false, 'a subsequent same-field edit still conflicts')
  const otherCreation = manager.begin({ uid: 'another-child', fields: ['text'],
    snapshot: { uid: 'another-child', data: { text: 'initial' } } })
  assert.equal(manager.acknowledgeCreation(otherCreation.id,
    { uid: 'another-child', data: { text: 'changed', __fv: { text: 7 } } }, 7), null,
    'matching a creation ACK must not accept different field values')
  console.log('collab-edit-session.unit: ok')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
