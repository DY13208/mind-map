const assert = require('assert')
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')
const compiler = require('vue-template-compiler')

const file = path.resolve(__dirname, '../src/pages/Edit/components/ConflictDraftInbox.vue')
const parsed = compiler.parseComponent(fs.readFileSync(file, 'utf8'))
assert.deepStrictEqual(compiler.compile(parsed.template.content).errors, [])
const code = babel.transformSync(parsed.script.content, {
  configFile: false,
  babelrc: false,
  plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
}).code
const records = new Map()
const removed = []
const errors = []
const warnings = []
let serial = 0
let activeSession = null
const mindMapEvents = new Map()
const cooperate = {
  getEditSession: () => activeSession,
  serializeEditSession: () => activeSession,
  getEditSessionSnapshot: uid => ({ uid, data: { text: 'server' } }),
  listEditSessions: () => []
}
const mindMap = {
  cooperate,
  on(name, callback) {
    mindMapEvents.set(name, callback)
  },
  off(name) {
    mindMapEvents.delete(name)
  }
}
const loaded = { exports: {} }
new Function('require', 'module', 'exports', code)(
  id => {
    if (id === '@/utils/roomLocation') {
      return { roomFromLocation: route => route.query.room || '' }
    }
    if (id === '@/utils/conflictEdit') {
      return {
        currentEditPrincipal: () => 'user-1',
        getEditCooperate: map => map && map.cooperate,
        async persistEditSessionEventDraft({ session, error, reason }) {
          const current = cooperate.getEditSession(session.id) || session
          const record = {
            key: `key:${current.id}`,
            sessionId: current.id,
            uid: current.uid,
            group: current.fields.includes('note') ? 'note' : 'text',
            session: { ...current, state: 'conflict' },
            latestSnapshot: { uid: current.uid, data: { text: 'server' } },
            reason,
            error
          }
          records.set(record.key, record)
          return { key: record.key, record, revision: current.draftRevision }
        },
        async persistOutboxConflictDraft() {
          return { stale: true }
        }
      }
    }
    if (id === '@/utils/conflictDraftStore') {
      return {
        async listConflictDrafts() {
          return [...records.values()]
        },
        conflictDraftKey: input => `key:${input.sessionId}`,
        async removeConflictDraft(item) {
          removed.push(item)
          records.delete(item.key)
        }
      }
    }
    if (id === './ConflictDraftPanel.vue') return { default: {} }
    throw new Error(`Unexpected import: ${id}`)
  },
  loaded,
  loaded.exports
)
const component = loaded.exports.default
const vm = {
  ...component.data(),
  mindMap,
  room: 'roomA',
  $route: { query: { room: 'roomA' } },
  $bus: { $on() {}, $off() {}, $emit() {} },
  $message: {
    error: message => errors.push(message),
    warning: message => warnings.push(message)
  },
  $t: key => key,
  $set(target, key, value) { target[key] = value },
  $delete(target, key) { delete target[key] },
  $confirm: async () => true
}
Object.keys(component.methods).forEach(name => {
  vm[name] = component.methods[name].bind(vm)
})

async function main() {
  vm.bindMindMapEvents(mindMap)
  const session = {
    id: 'text-session',
    uid: 'node-1',
    roomKey: 'roomA',
    kind: 'text',
    fields: ['text', 'richText'],
    baseVersions: { text: 3 },
    draft: { text: '未保存文本', richText: '<p>未保存文本</p>' },
    draftRevision: 1,
    state: 'editing',
    conflict: null
  }
  activeSession = session
  mindMapEvents.get('edit_session_save_failed')(session, { code: 'NETWORK_ERROR', message: 'offline' })
  await new Promise(resolve => setImmediate(resolve))
  assert.strictEqual(records.size, 1)
  const initial = [...records.values()][0]
  assert.strictEqual(initial.reason, 'save_failed')
  assert.strictEqual(initial.session.state, 'conflict')
  assert.strictEqual(initial.session.draft.richText, '<p>未保存文本</p>')
  assert(vm.persistentSessionIds.includes(session.id))

  activeSession = {
    ...session,
    draft: { text: '较新的文本', richText: '<p>较新的文本</p>' },
    draftRevision: 2
  }
  mindMapEvents.get('edit_session_draft_change')(activeSession)
  await new Promise(resolve => setImmediate(resolve))
  const updated = [...records.values()][0]
  assert.strictEqual(updated.session.draftRevision, 2)
  assert.strictEqual(updated.session.draft.text, '较新的文本')

  mindMapEvents.get('edit_session_resolved')(activeSession)
  await new Promise(resolve => setImmediate(resolve))
  assert.strictEqual(records.size, 0)
  assert.strictEqual(removed.length, 1)
  assert.strictEqual(vm.persistentSessionIds.includes(session.id), false)

  const conflictSession = {
    ...session,
    id: 'conflicted-note',
    kind: 'note',
    fields: ['note'],
    draft: { note: '冲突备注' },
    draftRevision: 4,
    state: 'conflict'
  }
  activeSession = conflictSession
  mindMapEvents.get('edit_session_conflict')(conflictSession, {
    code: 'PRECONDITION_REQUIRED',
    message: 'stale field version'
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.strictEqual([...records.values()][0].reason, 'conflict')
  mindMapEvents.get('edit_session_discarded')(conflictSession)
  await new Promise(resolve => setImmediate(resolve))
  assert.strictEqual(records.size, 0)
  assert.deepStrictEqual(errors, [])
  mindMapEvents.get('collab_write_conflict')({ message: '节点位置已被更新，请重新操作' })
  assert.deepStrictEqual(warnings, ['节点位置已被更新，请重新操作'])
  vm.unbindMindMapEvents(mindMap)

  console.log('PASS: text/richText save-failure and conflict persistence, latest-session updates, and resolve/discard cleanup.')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
