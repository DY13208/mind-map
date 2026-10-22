const assert = require('assert')
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')

const sourcePath = path.resolve(__dirname, '../src/utils/conflictDraftStore.js')
const source = fs.readFileSync(sourcePath, 'utf8')
const transformed = babel.transformSync(source, {
  configFile: false,
  babelrc: false,
  plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
}).code
const values = new Map()
const gates = new Map()
const storage = {
  async writeLocalDraftValue(value, key) {
    const gate = gates.get(key)
    if (gate && value.session.draftRevision === gate.revision) {
      gate.started()
      await new Promise(resolve => {
        gate.release = resolve
      })
    }
    values.set(key, value)
  },
  async deleteLocalDraftValue(key) {
    values.delete(key)
  },
  async listLocalDraftEntries(prefix) {
    return [...values.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value }))
  }
}
const loadedModule = { exports: {} }
new Function('require', 'module', 'exports', transformed)(
  id => {
    if (id === '@/api') return storage
    throw new Error(`Unexpected import: ${id}`)
  },
  loadedModule,
  loadedModule.exports
)
const store = loadedModule.exports
global.localStorage = { getItem: () => 'user A' }
const editSource = fs.readFileSync(
  path.resolve(__dirname, '../src/utils/conflictEdit.js'),
  'utf8'
)
const editCode = babel.transformSync(editSource, {
  configFile: false,
  babelrc: false,
  plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
}).code
const editModule = { exports: {} }
new Function('require', 'module', 'exports', editCode)(
  id => {
    if (id === '@/utils/roomLocation') {
      return { roomFromLocation: route => (route && route.query && route.query.room) || '' }
    }
    if (id === '@/utils/conflictDraftStore') return store
    throw new Error(`Unexpected import: ${id}`)
  },
  editModule,
  editModule.exports
)
const edit = editModule.exports

function input({ principal = 'user A', room = 'room/1', uid = 'node:1', id = 's1', revision, text }) {
  return {
    principal,
    room,
    session: {
      id,
      uid,
      fields: ['text'],
      draft: { text },
      draftRevision: revision,
      state: 'conflict'
    }
  }
}

async function nextTurn() {
  await new Promise(resolve => setImmediate(resolve))
}

async function main() {
  const first = input({ revision: 1, text: '旧草稿' })
  const key = store.conflictDraftKey({
    principal: first.principal,
    room: first.room,
    uid: first.session.uid,
    group: 'text',
    sessionId: first.session.id
  })
  assert(key.includes(encodeURIComponent(first.principal)))
  assert(key.includes(encodeURIComponent(first.room)))
  assert(key.includes(encodeURIComponent(first.session.uid)))

  let startedResolve
  const started = new Promise(resolve => {
    startedResolve = resolve
  })
  gates.set(key, { revision: 1, started: startedResolve, release: null })
  const olderWrite = store.persistConflictDraft(first)
  await started
  const newerWrite = store.persistConflictDraft(
    input({ revision: 2, text: '较新的草稿' })
  )
  gates.get(key).release()
  await Promise.all([olderWrite, newerWrite])
  assert.strictEqual(values.get(key).session.draft.text, '较新的草稿')
  assert.strictEqual(values.get(key).session.draftRevision, 2)

  const otherScope = input({ principal: 'user B', revision: 1, text: '其他用户' })
  await store.persistConflictDraft(otherScope)
  assert.strictEqual((await store.listConflictDrafts('user A', 'room/1')).length, 1)
  assert.strictEqual((await store.listConflictDrafts('user B', 'room/1')).length, 1)
  assert.strictEqual((await store.listConflictDrafts('user A', 'other-room')).length, 0)

  const removal = store.removeConflictDraft({ key, sessionId: 's1' })
  await assert.rejects(
    store.persistConflictDraft(input({ revision: 3, text: '清理后迟到的写入' })),
    /会话已关闭/
  )
  await removal
  assert.strictEqual(values.has(key), false, 'A late write must not recreate a cleared session')

  const pending = input({ id: 's2', revision: 1, text: '等待写入' })
  const pendingKey = store.conflictDraftKey({
    principal: pending.principal,
    room: pending.room,
    uid: pending.session.uid,
    group: 'text',
    sessionId: pending.session.id
  })
  let pendingStartedResolve
  const pendingStarted = new Promise(resolve => {
    pendingStartedResolve = resolve
  })
  gates.set(pendingKey, { revision: 1, started: pendingStartedResolve, release: null })
  const inFlight = store.persistConflictDraft(pending)
  await pendingStarted
  const clearPending = store.removeConflictDraft({ key: pendingKey, sessionId: 's2' })
  gates.get(pendingKey).release()
  await Promise.all([inFlight, clearPending])
  await nextTurn()
  assert.strictEqual(values.has(pendingKey), false)

  let commits = 0
  const latestSnapshot = {
    uid: 'legacy-node',
    data: { text: '服务器文本', note: '服务器备注' },
    fieldVersions: { text: 9, note: 6 },
    serverRevision: 44,
    source: 'currentData'
  }
  const recovered = await edit.persistOutboxConflictDraft({
    route: { query: { room: 'room/1' } },
    mindMap: {
      cooperate: {
        getEditSessionSnapshot: () => latestSnapshot,
        commitEditSession: () => {
          commits += 1
        }
      }
    },
    payload: {
      uid: 'legacy-node',
      opId: 'old-op-1',
      roomKey: 'room/1',
      patch: {
        text: '旧 outbox 文本',
        note: '旧 outbox 备注',
        attachment: { id: 'must-not-be-copied' }
      },
      expected: { uid: 'legacy-node', '__fv.text': 8, '__fv.note': 5 },
      error: { code: 'TARGET_DELETED', message: 'node deleted' }
    }
  })
  const recoveredDrafts = await store.listConflictDrafts('user A', 'room/1')
  assert.strictEqual(recoveredDrafts.length, 2, 'Each field group gets an independent draft')
  assert.deepStrictEqual(
    recoveredDrafts.map(item => item.group).sort(),
    ['note', 'text']
  )
  assert(recoveredDrafts.every(item => item.session.state === 'conflict'))
  assert.strictEqual(recoveredDrafts.find(item => item.group === 'text').session.draft.text, '旧 outbox 文本')
  assert.strictEqual(recoveredDrafts.find(item => item.group === 'note').session.baseVersions.note, 5)
  assert.strictEqual(recoveredDrafts.some(item => item.session.draft.attachment), false)
  assert.strictEqual(recoveredDrafts[0].latestSnapshot.serverRevision, 44)
  assert.strictEqual(recovered.stale, false)
  assert.strictEqual(commits, 0, 'Outbox conflict recovery is view-only and must never auto-submit')

  const structural = { id: 'outbox-structure:op', uid: 'move-node', roomKey: 'room/1',
    kind: 'outbox-structure', fields: ['operation'], state: 'conflict', draftRevision: 1,
    draft: { operation: { type: 'node.move', payload: { uid: 'move-node', parentUid: 'target' } } } }
  const kept = await edit.persistOutboxConflictDraft({ route: { query: { room: 'room/1' } },
    payload: { session: structural, roomKey: 'room/1', error: { code: 'PRECONDITION_REQUIRED' } } })
  assert.strictEqual(kept.record.reason, 'operation_failed')
  assert.strictEqual(kept.record.session.draft.operation.payload.parentUid, 'target')
  const reloaded = await store.listConflictDrafts('user A', 'room/1')
  assert(reloaded.some(row => row.sessionId === structural.id), 'structural intent survives a storage reload')
  assert.strictEqual(commits, 0, 'structural intent recovery must never submit')
  console.log('PASS: scoped keys, principal/room isolation, ordered writes, clear-vs-late-write protection, and view-only legacy outbox recovery.')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
