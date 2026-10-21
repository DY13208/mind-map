const assert = require('assert')
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')
const compiler = require('vue-template-compiler')

global.window = { location: { href: 'https://map.example.com/?room=roomA' } }
global.localStorage = { getItem: () => 'test-user' }

const state = {
  mode: 'conflict',
  failStorage: true,
  sequence: 0,
  sessions: new Map(),
  attempts: [],
  events: []
}
const nodes = new Map()
function makeNode(uid, data) {
  const value = { uid, ...data }
  const node = {
    getData(key) {
      return key ? value[key] : { ...value }
    },
    setNote(note) {
      value.note = note
    },
    setHyperlink(hyperlink, hyperlinkTitle) {
      value.hyperlink = hyperlink
      value.hyperlinkTitle = hyperlinkTitle
    }
  }
  nodes.set(uid, node)
  return node
}

const cooperate = {
  getEditSessionSnapshot(uid) {
    const node = nodes.get(String(uid))
    if (!node) return null
    const data = node.getData()
    return {
      uid: String(uid),
      data,
      fieldVersions: { note: 3, hyperlink: 4, text: 2 },
      serverRevision: 12,
      source: 'currentData'
    }
  },
  beginEditSession({ uid, fields, kind, initialDraft }) {
    const snapshot = this.getEditSessionSnapshot(uid)
    const id = `session-${++state.sequence}`
    const groups = fields.map(field =>
      field === 'note' ? 'note' : field === 'text' || field === 'richText' ? 'text' : 'hyperlink'
    )
    const session = {
      id,
      uid,
      kind,
      fields,
      baseValues: Object.fromEntries(fields.map(field => [field, snapshot.data[field]])),
      baseVersions: Object.fromEntries(groups.map(group => [group, snapshot.fieldVersions[group]])),
      draft: { ...initialDraft },
      draftRevision: 0,
      composing: false,
      state: 'editing',
      roomKey: 'roomA',
      conflict: null
    }
    state.sessions.set(id, session)
    return session
  },
  getEditSession(id) {
    return state.sessions.get(id) || null
  },
  updateEditSessionDraft(id, patch) {
    const session = state.sessions.get(id)
    session.draft = { ...session.draft, ...patch }
    session.draftRevision += 1
    return session
  },
  setEditSessionComposing(id, composing) {
    const session = state.sessions.get(id)
    if (session) session.composing = composing
  },
  retainEditSessionConflict(id, { latestSnapshot, error }) {
    const session = state.sessions.get(id)
    session.state = 'conflict'
    session.conflict = { latestSnapshot, error }
    return session
  },
  serializeEditSession(id) {
    return state.sessions.get(id) || null
  },
  async commitEditSession(id, patch) {
    const session = state.sessions.get(id)
    const group = session.fields[0] === 'note' ? 'note' : 'hyperlink'
    const expected = { uid: session.uid, [`__fv.${group}`]: session.baseVersions[group] }
    state.attempts.push({ uid: session.uid, patch: { ...patch }, expected })
    if (session.composing) {
      const error = new Error('composing')
      error.code = 'IME_COMPOSITION_ACTIVE'
      throw error
    }
    if (state.mode === 'conflict') {
      const error = new Error('conflict')
      error.code = 'REPLACE_CONFLICT'
      error.status = 409
      throw error
    }
    if (state.mode === 'failure') {
      const error = new Error('network failure')
      error.code = 'NETWORK_ERROR'
      throw error
    }
    const node = nodes.get(session.uid)
    Object.assign(node.getData(), patch)
    return { saved: true }
  },
  resolveEditSession(id) {
    state.sessions.delete(id)
  },
  discardEditSession(id) {
    state.sessions.delete(id)
  },
  restoreEditSession(snapshot) {
    state.sessions.set(snapshot.id, snapshot)
    return snapshot
  }
}
const mindMap = {
  renderer: { findNodeByUid: uid => nodes.get(String(uid)) || null },
  cooperate
}

const editorInstances = []
function FakeEditor() {
  this.markdown = ''
  this.handlers = {}
  this.on = (event, fn) => (this.handlers[event] = fn)
  this.off = () => {}
  this.setMarkdown = value => {
    this.markdown = value
  }
  this.getMarkdown = () => this.markdown
  editorInstances.push(this)
}

const mockModules = {
  '@toast-ui/editor': FakeEditor,
  'vuex': { mapState: () => ({}) },
  'simple-mind-map/src/utils/index': { isMobile: () => false },
  './ConflictDraftPanel.vue': { default: {} },
  '@/utils/roomLocation': { roomFromLocation: route => route.query.room || '' },
  '@/utils/conflictDraftStore': {
    conflictDraftKey: input => `draft:${input.sessionId}`,
    removeConflictDraft: async () => true
  },
  '@/utils/conflictEdit': {
    currentEditPrincipal: () => 'test-user',
    discardEditSession: (service, id) => service && service.discardEditSession(id),
    getEditCooperate: map => map && map.cooperate,
    getLiveNode: (map, uid) => map.renderer.findNodeByUid(uid),
    isCollaborativeRoom: route => !!route.query.room,
    isEditConflictError: error => ['REPLACE_CONFLICT', 'PRECONDITION_REQUIRED'].includes(error && error.code),
    async persistConflictSessionDraft({ sessionId }) {
      state.events.push(`update-persist:${sessionId}`)
      if (state.failStorage) throw new Error('storage failed')
      const session = cooperate.getEditSession(sessionId)
      return { saved: true, revision: session.draftRevision, session }
    },
    async persistEditConflict({ sessionId, error }) {
      state.events.push(`conflict-persist-start:${sessionId}`)
      const latestSnapshot = cooperate.getEditSessionSnapshot(state.sessions.get(sessionId).uid)
      const session = cooperate.retainEditSessionConflict(sessionId, {
        latestSnapshot,
        error: { code: error.code, message: error.message }
      })
      if (state.failStorage) throw new Error('storage failed')
      await Promise.resolve()
      state.events.push(`conflict-persist-done:${sessionId}`)
      return {
        session,
        latestSnapshot,
        key: `draft:${sessionId}`,
        saved: true,
        revision: session.draftRevision
      }
    }
  }
}

function loadComponent(file) {
  const parsed = compiler.parseComponent(fs.readFileSync(file, 'utf8'))
  assert.deepStrictEqual(compiler.compile(parsed.template.content).errors, [])
  const transformed = babel.transformSync(parsed.script.content, {
    configFile: false,
    babelrc: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  }).code
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', transformed)(
    id => {
      if (id.endsWith('.css')) return {}
      if (Object.prototype.hasOwnProperty.call(mockModules, id)) return mockModules[id]
      throw new Error(`Unexpected import in ${file}: ${id}`)
    },
    loaded,
    loaded.exports
  )
  return loaded.exports.default
}

const noteComponent = loadComponent(path.resolve(__dirname, '../src/pages/Edit/components/NodeNote.vue'))
const linkComponent = loadComponent(path.resolve(__dirname, '../src/pages/Edit/components/NodeHyperlink.vue'))

function makeVm(component, noteEditor = false) {
  const editorRoot = {
    addEventListener() {},
    removeEventListener() {},
    classList: { toggle() {} }
  }
  const vm = {
    ...component.data(),
    ...component.methods,
    mindMap,
    $route: { query: { room: 'roomA' } },
    $refs: { noteEditor: editorRoot, linkInput: { focus() {} } },
    $bus: { $emit() {}, $on() {}, $off() {} },
    $t: key => key,
    $message: { warning() {}, error() {} },
    $confirm: async () => true,
    $nextTick: callback => callback()
  }
  if (noteEditor) vm.$refs.noteEditor = editorRoot
  return vm
}

async function main() {
  const noteNode = makeNode('note-uid', { note: '服务器备注' })
  state.mode = 'conflict'
  state.failStorage = true
  const note = makeVm(noteComponent, true)
  note.handleShowNodeNote(noteNode)
  const editor = editorInstances[editorInstances.length - 1]
  editor.setMarkdown('我正在写的备注')
  note.onEditorChange()
  note.onCompositionStart()
  editor.setMarkdown('输入法组合中的内容')
  note.onEditorChange()
  const countBeforeComposition = state.attempts.length
  await note.confirm()
  assert.strictEqual(state.attempts.length, countBeforeComposition, 'IME composition must not submit')
  note.onCompositionEnd()

  await note.confirm()
  assert.strictEqual(state.attempts.at(-1).expected['__fv.note'], 3)
  assert.deepStrictEqual(state.attempts.at(-1).patch, { note: '输入法组合中的内容' })
  assert.strictEqual(note.dialogVisible, true, 'A storage failure must leave the editor open')
  assert.strictEqual(note.conflictEntries.length, 1)
  assert.strictEqual(note.conflictEntries[0].persisted, false)
  assert(note.note.includes('输入法组合中的内容'))

  state.failStorage = false
  editor.setMarkdown('冲突后的新备注')
  note.onEditorChange()
  await new Promise(resolve => setImmediate(resolve))
  assert.strictEqual(note.conflictEntries[0].persisted, true)
  await note.discardConflicts()
  assert.strictEqual(note.dialogVisible, false)

  const linkNode = makeNode('link-uid', { hyperlink: 'https://old.example.com', hyperlinkTitle: '旧标题' })
  state.mode = 'conflict'
  state.failStorage = false
  const link = makeVm(linkComponent)
  link.handleShowNodeLink(linkNode)
  link.link = 'https://new.example.com'
  link.linkTitle = '新标题'
  await link.confirm()
  const linkAttempt = state.attempts.at(-1)
  assert.strictEqual(linkAttempt.expected['__fv.hyperlink'], 4)
  assert.deepStrictEqual(linkAttempt.patch, {
    hyperlink: 'https://new.example.com',
    hyperlinkTitle: '新标题'
  })
  assert.strictEqual(link.dialogVisible, true)
  assert.strictEqual(link.conflictEntries[0].persisted, true)
  const persistStart = state.events.indexOf(`conflict-persist-start:${link.conflictEntries[0].id}`)
  const persistDone = state.events.indexOf(`conflict-persist-done:${link.conflictEntries[0].id}`)
  assert(persistDone > persistStart, 'Conflict UI is only exposed after persistence completes')

  state.mode = 'success'
  state.failStorage = false
  const success = makeVm(linkComponent)
  success.handleShowNodeLink(linkNode)
  success.link = 'https://saved.example.com'
  await success.confirm()
  assert.strictEqual(success.dialogVisible, false)

  console.log('PASS: note/link CAS bases, IME guard, conflict persistence ordering, storage-failure retention, and successful close.')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
