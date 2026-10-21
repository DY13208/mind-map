'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')

const cooperatePath = path.resolve(
  __dirname,
  '../simple-mind-map/src/plugins/Cooperate.js'
)
const cooperateSource = fs.readFileSync(cooperatePath, 'utf8')

function method(start, end) {
  const from = cooperateSource.indexOf(start)
  assert.notEqual(from, -1, `missing Cooperate method: ${start}`)
  const to = cooperateSource.indexOf(end, from)
  assert.notEqual(to, -1, `missing Cooperate method boundary: ${end}`)
  return cooperateSource.slice(from, to).trim()
}

async function loadRuntime() {
  const [
    { createEditSessionManager, editFieldGroup },
    { applyCollabEvent },
    { default: collabNodeFeatures }
  ] = await Promise.all([
    import(pathToFileURL(path.resolve(
      __dirname,
      '../simple-mind-map/src/utils/collabEditSession.js'
    ))),
    import(pathToFileURL(path.resolve(
      __dirname,
      '../simple-mind-map/src/plugins/cooperateRecovery.js'
    ))),
    import(pathToFileURL(path.resolve(
      __dirname,
      '../simple-mind-map/src/utils/collabNodeFeatures.js'
    )))
  ])

  const methods = [
    method('  getEditSessionSnapshot(uid) {', '\n  beginEditSession('),
    method('  getEditSession(id) {', '\n  listEditSessions('),
    method('  resolveEditSession(id) {', '\n  discardEditSession('),
    method('  validateEditSession(id, fields) {', '\n  retainEditSessionConflict('),
    method('  editSessionOperationFingerprint(uid, patch, expected) {', '\n  updateEditSessionDraft('),
    method('  updateEditSessionDraft(id, patch) {', '\n  setEditSessionComposing('),
    method('  setEditSessionComposing(id, composing) {', '\n  buildEditSessionExpected('),
    method('  retainEditSessionConflict(id, options = {}) {', '\n  rebaseEditSession('),
    method('  isV2RevisionScopeCurrent(scope) {', '\n  clearV2RevisionCompletions('),
    method('  reconcileAckedLocalOperation(result, capturedIntentEpochs, originalScope, type, payload) {', '\n  acknowledgeLocalNodeCreation('),
    method('  acknowledgeLocalNodeCreation(event, revision) {', '\n  submitV2('),
    method('  async commitEditSession(id, patch = {}) {', '\n  expectedFieldVersions('),
    method('  projectCanonicalChildOrder(parentUid) {', '\n  applyV2PayloadInsert('),
    method('  onNodeTreeRenderEnd() {', '\n  onBeforeSetData('),
    method('  async applyV2RemoteOperationNow(op, meta = {}, context) {', '\n  async applyV2RemoteBatchEvents(')
  ]
  const stableFieldValue = vm.runInNewContext(
    `(${method('function stableFieldValue(value) {', '\nfunction generalizationSignature(')})`,
    {}
  )
  const sandbox = {
    FV_KEY: '__fv',
    editFieldGroup,
    stableFieldValue,
    getTextFromHtml(value) {
      return String(value == null ? '' : value).replace(/<[^>]*>/g, '')
    },
    readFieldVersions(data = {}) {
      const source = data.__fv
      if (!source || typeof source !== 'object' || Array.isArray(source)) return {}
      const versions = {}
      Object.keys(source).forEach(group => {
        const version = Number(source[group])
        if (Number.isFinite(version) && version > 0) versions[group] = version
      })
      return versions
    },
    applyCollabEvent,
    collabNodeFeatures,
    v2Trace() {},
    collabTrace() {},
    payloadParentUid(payload = {}) {
      return payload.parentUid || payload.parent_uid || payload.parent || ''
    }
  }
  const extracted = vm.runInNewContext(`({\n${methods.join(',\n')}\n})`, sandbox)
  return {
    ...extracted,
    createEditSessionManager,
    applyCollabEvent,
    collabNodeFeatures
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function node(uid, data, children = [], extra = {}) {
  return {
    uid,
    data: { uid, ...(data || {}) },
    children: children.slice(),
    ...extra
  }
}

function createContext(runtime, { roomKey = 'room-create-a', adapter } = {}) {
  const localAdapter = adapter || {
    getClientId() { return 'client-local' }
  }
  const initial = {
    root: node('root', { text: 'root' }, ['parent'], { isRoot: true, node_version: 1 }),
    parent: node('parent', { text: 'parent text', __fv: { text: 2 } }, ['local-child'], {
      parent_uid: 'root', position: 'a', node_version: 12
    }),
    'local-child': node('local-child', {
      text: 'local initial', richText: true, __fv: {}
    }, [], { parent_uid: 'parent', position: 'b', node_version: 0 })
  }
  const currentData = clone(initial)
  const renderNodes = new Map()
  Object.entries(currentData).forEach(([uid, entry]) => {
    renderNodes.set(uid, {
      data: { ...entry.data },
      getData(key) { return key == null ? this.data : this.data[key] }
    })
  })
  Object.values(currentData).forEach(entry => {
    const rendered = renderNodes.get(entry.uid)
    if (!rendered) return
    rendered.nodeData = {
      data: rendered.data,
      children: (entry.children || []).map(childUid => renderNodes.get(childUid)).filter(Boolean)
    }
  })
  const renderer = {
    renderTree: { data: { uid: 'root' }, children: [] },
    isRendering: false,
    renderTimer: null,
    hasWaitRendering: false,
    findNodeByUid(uid) { return renderNodes.get(String(uid)) || null },
    beginRemoteRenderBatch() {},
    endRemoteRenderBatch() {}
  }
  const emitted = []
  const context = {
    ...runtime,
    httpRoomKey: roomKey,
    collabV2Adapter: localAdapter,
    renderNodes,
    _v2RemoteApplyEpoch: 3,
    _v2RemoteApplyQueue: Promise.resolve(),
    _v2RendererWaiters: new Set(),
    lastAppliedVersion: 1,
    currentData,
    editSessionManager: runtime.createEditSessionManager(),
    _authoritativeRevByUid: new Map(),
    _structuralGuardRevisions: new Map(),
    _dragViewDeferred: false,
    viewDeferred: false,
    renderedVersion: 1,
    _pendingRenderedVersion: 1,
    waitNodeUidMap: {},
    presenceUsers: [],
    dirtyUIDSet: new Set(),
    viewStructureDirtyUIDSet: new Set(),
    _pendingChildOrderParents: new Set(),
    deletedUids: new Set(),
    abandonedInsertUids: new Set(),
    mindMap: {
      _destroyed: false,
      renderer,
      emit(name, ...args) { emitted.push({ name, args }) }
    },
    emitted,
    renderRequests: [],
    completions: [],
    markV2RevisionComplete: async function (revision, scope, completion) {
      this.completions.push({ revision, scope, completion })
      return true
    },
    rebaseV2RemoteApplyContext() { return true },
    isV2RemoteApplyCurrent() { return true },
    waitV2RendererReady: async () => true,
    isTombstonedUid(uid) {
      return this.deletedUids.has(String(uid)) || this.abandonedInsertUids.has(String(uid))
    },
    observeGuardedIntentEvent() {},
    localIntentEpochOf() { return 0 },
    scheduleRemoteRecover() {},
    notifyV2ContentChange() {},
    notifySearchInvalidate() {},
    applyRemoteMapMeta() {},
    requestRemoteApplyRender(uids) { this.renderRequests.push(uids) },
    bumpAuthoritativeUidRev(uid, revision) {
      this._authoritativeRevByUid.set(String(uid), Number(revision) || 0)
    },
    applyV2PayloadInsert(payload = {}) {
      const uid = String(payload.uid || '')
      if (!uid) return false
      if (!renderNodes.has(uid)) {
        renderNodes.set(uid, {
          data: { uid, ...(payload.data || {}) },
          getData(key) { return key == null ? this.data : this.data[key] }
        })
      }
      return true
    },
    applyV2PayloadUpdate(payload = {}) {
      const target = renderNodes.get(String(payload.uid || ''))
      if (!target) return false
      Object.assign(target.data, payload.patch || {})
      return true
    },
    async applyV2PayloadMove() { return true },
    applyV2PayloadDelete(payload = {}) {
      renderNodes.delete(String(payload.uid || ''))
      return true
    },
    applyV2PayloadRestore() { return true },
    findTreeNode() { return null },
    deferUnloadedRemote() { return false },
    syncHttpRemoteOperations() { return false },
    markRemoteDirty() {}
  }
  return context
}

function openSession(context, uid = 'local-child', fields = ['text', 'richText']) {
  const snapshot = context.getEditSessionSnapshot(uid)
  assert.ok(snapshot, `expected an authoritative snapshot for ${uid}`)
  return context.editSessionManager.begin({
    uid,
    roomKey: context.httpRoomKey,
    fields,
    kind: 'rich-text',
    snapshot,
    initialDraft: { text: '<p>my unsaved draft</p>', richText: true }
  })
}

function originalScope(context, overrides = {}) {
  return {
    roomKey: context.httpRoomKey,
    adapter: context.collabV2Adapter,
    remoteApplyEpoch: context._v2RemoteApplyEpoch,
    ...overrides
  }
}

function insertAck(uid, text, revision, extraData = {}) {
  return {
    serverRevision: revision,
    operation: {
      type: 'node.inserted',
      serverRevision: revision,
      payload: {
        uid,
        parentUid: 'parent',
        position: 'c',
        index: 1,
        data: {
          uid,
          text,
          richText: true,
          __fv: { text: revision },
          ...extraData
        }
      }
    }
  }
}

async function testOwnInsertAckInitializesOnlyTheBaseline() {
  const runtime = await loadRuntime()
  const context = createContext(runtime)
  const session = openSession(context)
  context.updateEditSessionDraft(session.id, { text: '<p>typing while add saves</p>' })
  context.setEditSessionComposing(session.id, true)
  const before = context.getEditSession(session.id)
  assert.equal(before.baseVersions.text, 0)

  const result = await context.reconcileAckedLocalOperation(
    insertAck('local-child', 'local initial', 3),
    new Map(),
    originalScope(context),
    'node.insert',
    { uid: 'local-child', parentUid: 'parent', text: 'local initial' }
  )
  const after = context.getEditSession(session.id)
  assert.equal(result.reconciled, true)
  assert.equal(after.state, 'editing')
  assert.equal(after.baseVersions.text, 3, 'own insert ACK initializes the zero field-version baseline')
  assert.equal(after.baseValues.text, 'local initial')
  assert.equal(after.draft.text, before.draft.text, 'the user draft is preserved')
  assert.equal(after.draftRevision, before.draftRevision, 'ACK does not synthesize a draft edit')
  assert.equal(after.composing, true, 'ACK does not interrupt IME composition')
  assert.equal(context.currentData['local-child'].data.__fv.text, 3)

  context.acknowledgeLocalNodeCreation(insertAck('local-child', 'local initial', 4).operation, 4)
  assert.equal(context.getEditSession(session.id).baseVersions.text, 3,
    'a session that already adopted its creation baseline is never rebased again')
}

async function testAckRequiresTheSubmittedUidAndOriginalValue() {
  const runtime = await loadRuntime()

  const wrongUid = createContext(runtime)
  const wrongUidSession = openSession(wrongUid)
  await wrongUid.reconcileAckedLocalOperation(
    insertAck('some-other-child', 'local initial', 3),
    new Map(), originalScope(wrongUid), 'node.insert',
    { uid: 'local-child', parentUid: 'parent', text: 'local initial' }
  )
  assert.equal(wrongUid.getEditSession(wrongUidSession.id).baseVersions.text, 0,
    'an ACK for a UID absent from the submitted insert is ignored')

  const changedInitialValue = createContext(runtime)
  const changedSession = openSession(changedInitialValue)
  changedInitialValue.updateEditSessionDraft(changedSession.id, { text: 'keep typing' })
  await changedInitialValue.reconcileAckedLocalOperation(
    insertAck('local-child', 'different canonical initial', 3),
    new Map(), originalScope(changedInitialValue), 'node.insert',
    { uid: 'local-child', parentUid: 'parent', text: 'local initial' }
  )
  const after = changedInitialValue.getEditSession(changedSession.id)
  assert.equal(after.baseVersions.text, 0,
    'a canonical insert with a different initial value cannot be absorbed as initialization')
  assert.equal(after.draft.text, 'keep typing')
  assert.equal(after.draftRevision, 1)
  assert.equal(after.state, 'editing')
}

async function testOldRoomSessionDoesNotAbsorbCurrentRoomCreationAck() {
  const runtime = await loadRuntime()
  const context = createContext(runtime, { roomKey: 'room-current' })
  const snapshot = context.getEditSessionSnapshot('local-child')
  const oldRoomSession = context.editSessionManager.begin({
    uid: 'local-child', roomKey: 'room-previous', fields: ['text', 'richText'],
    kind: 'rich-text', snapshot,
    initialDraft: { text: '<p>old room draft</p>', richText: true }
  })

  await context.reconcileAckedLocalOperation(
    insertAck('local-child', 'local initial', 3),
    new Map(), originalScope(context), 'node.insert',
    { uid: 'local-child', parentUid: 'parent', text: 'local initial' }
  )

  const after = context.getEditSession(oldRoomSession.id)
  assert.equal(after.baseVersions.text, 0,
    'a same-UID session left in another room cannot absorb the current room creation ACK')
  assert.equal(after.draft.text, '<p>old room draft</p>')
  assert.equal(after.state, 'editing')
}

async function testOldAckCannotReplaceNewerAuthorityOrResurrectDeletion() {
  const runtime = await loadRuntime()

  const newer = createContext(runtime)
  const newerSession = openSession(newer)
  newer.currentData['local-child'].data = {
    ...newer.currentData['local-child'].data,
    text: 'newer authoritative text',
    __fv: { text: 9 }
  }
  newer.acknowledgeLocalNodeCreation(
    insertAck('local-child', 'stale ACK text', 5).operation,
    5
  )
  assert.equal(newer.currentData['local-child'].data.text, 'newer authoritative text')
  assert.equal(newer.currentData['local-child'].data.__fv.text, 9)
  assert.equal(newer.getEditSession(newerSession.id).baseVersions.text, 0)

  const deleted = createContext(runtime)
  const deletedSession = openSession(deleted)
  delete deleted.currentData['local-child']
  deleted.currentData.parent.children = []
  deleted.deletedUids.add('local-child')
  deleted.mindMap.renderer.findNodeByUid = uid => uid === 'local-child' ? null : null
  deleted.acknowledgeLocalNodeCreation(
    insertAck('local-child', 'stale ACK text', 5).operation,
    5
  )
  assert.equal(Object.hasOwn(deleted.currentData, 'local-child'), false,
    'a late creation ACK cannot resurrect an authoritative deletion')
  assert.equal(deleted.getEditSession(deletedSession.id).baseVersions.text, 0)
}

async function testNewerNoteDoesNotBlockTextCreationBaseline() {
  const runtime = await loadRuntime()
  const context = createContext(runtime)
  const session = openSession(context, 'local-child', ['text', 'richText'])
  context.updateEditSessionDraft(session.id, { text: '<p>keep composing after add</p>' })
  context.currentData['local-child'].data = {
    ...context.currentData['local-child'].data,
    note: 'newer authoritative note',
    __fv: { text: 3, note: 5 }
  }
  const ack = insertAck('local-child', 'local initial', 3, {
    note: 'creation note',
    __fv: { text: 3, note: 3 }
  })

  await context.reconcileAckedLocalOperation(
    ack,
    new Map(), originalScope(context), 'node.insert',
    { uid: 'local-child', parentUid: 'parent', text: 'local initial' }
  )

  const after = context.getEditSession(session.id)
  const authoritative = context.currentData['local-child'].data
  assert.equal(after.baseVersions.text, 3,
    'a newer note version does not prevent adopting the unchanged text creation baseline')
  assert.equal(after.baseValues.text, 'local initial')
  assert.equal(after.draft.text, '<p>keep composing after add</p>')
  assert.equal(authoritative.text, 'local initial')
  assert.equal(authoritative.__fv.text, 3)
  assert.equal(authoritative.note, 'newer authoritative note',
    'canonical creation data must not overwrite a newer note')
  assert.equal(authoritative.__fv.note, 5)
}

async function testRichTextInsertNormalizationInitializesOnlyKnownCanonicalText() {
  const runtime = await loadRuntime()
  const makeRichTextSession = () => {
    const context = createContext(runtime)
    context.currentData['local-child'].data = {
      ...context.currentData['local-child'].data,
      text: '<p>分支主题</p>',
      richText: true,
      __fv: {}
    }
    const session = openSession(context, 'local-child', ['text', 'richText'])
    context.updateEditSessionDraft(session.id, {
      text: '<p>我的未保存草稿</p>',
      richText: true
    })
    return { context, session, draft: context.getEditSession(session.id).draft }
  }

  const normalized = makeRichTextSession()
  const initialSnapshot = normalized.context.getEditSession(normalized.session.id)
  assert.equal(initialSnapshot.baseValues.text, '<p>分支主题</p>')
  assert.equal(initialSnapshot.baseValues.richText, true)
  normalized.context.acknowledgeLocalNodeCreation(
    insertAck('local-child', '分支主题', 2, { resetRichText: true }).operation,
    2
  )
  const initialized = normalized.context.getEditSession(normalized.session.id)
  assert.equal(initialized.baseVersions.text, 2)
  assert.equal(initialized.baseValues.text, '分支主题',
    'the initialized baseline adopts the canonical server text')
  assert.equal(initialized.baseValues.richText, true)
  assert.deepEqual(initialized.draft, normalized.draft,
    'the in-progress rich HTML draft remains untouched')

  await normalized.context.applyV2RemoteOperationNow({
    event: {
      type: 'node.updated',
      payload: { uid: 'local-child', patch: { text: '外部后续修改', __fv: { text: 3 } } }
    },
    serverRevision: 3,
    clientId: 'client-peer'
  }, {}, {
    epoch: normalized.context._v2RemoteApplyEpoch,
    room: normalized.context.httpRoomKey,
    adapter: normalized.context.collabV2Adapter,
    revision: normalized.context.lastAppliedVersion
  })
  const afterExternalEdit = normalized.context.getEditSession(normalized.session.id)
  assert.equal(afterExternalEdit.state, 'conflict',
    'a later external edit still conflicts against the canonicalized creation baseline')
  assert.equal(afterExternalEdit.conflict.error.code, 'REPLACE_CONFLICT')
  assert.deepEqual(afterExternalEdit.draft, normalized.draft,
    'the rich draft is retained after the later real conflict')

  for (const { resetRichText, canonicalText, label } of [
    { resetRichText: false, canonicalText: '分支主题', label: 'missing resetRichText marker' },
    { resetRichText: true, canonicalText: '另一个主题', label: 'different canonical text' }
  ]) {
    const unchanged = makeRichTextSession()
    unchanged.context.acknowledgeLocalNodeCreation(
      insertAck('local-child', canonicalText, 2,
        resetRichText ? { resetRichText: true } : {}).operation,
      2
    )
    const after = unchanged.context.getEditSession(unchanged.session.id)
    assert.equal(after.baseVersions.text, 0,
      `${label} cannot be absorbed as a rich-text creation normalization`)
    assert.equal(after.draft.text, unchanged.draft.text)
    assert.equal(after.state, 'editing')
  }
}

async function testCommitWaitsForQueuedCreationBaselineEvenWhenInsertIsAcked() {
  const runtime = await loadRuntime()
  const context = createContext(runtime)
  const session = openSession(context, 'local-child', ['text', 'richText'])
  context.updateEditSessionDraft(session.id, { text: '<p>latest unsaved draft</p>' })
  const draftBeforeCommit = context.getEditSession(session.id).draft.text
  let releaseInsert
  context.httpInsertPromise = new Promise(resolve => { releaseInsert = resolve })
  context.httpCollabMode = true
  context.isPersistAcked = () => true
  context._pendingEditSessionByFingerprint = new Map()
  const submitted = []
  context.submitV2 = async (type, payload) => {
    submitted.push({ type, payload: clone(payload) })
    return { version: 4 }
  }

  const commit = context.commitEditSession(session.id, {
    text: '<p>latest unsaved draft</p>'
  })
  assert.equal(submitted.length, 0,
    'an already-persisted insert with a zero edit baseline must still wait for its pending insert queue')

  context.acknowledgeLocalNodeCreation(
    insertAck('local-child', 'local initial', 3).operation,
    3
  )
  assert.equal(context.getEditSession(session.id).baseVersions.text, 3,
    'the canonical insert ACK establishes the edit baseline while the queue is pending')
  assert.equal(context.getEditSession(session.id).draft.text, draftBeforeCommit,
    'creation baseline initialization preserves the latest unsaved draft')
  assert.equal(submitted.length, 0,
    'the update is not sent until the pending insert promise is released')

  releaseInsert()
  await commit

  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].type, 'node.update')
  assert.equal(submitted[0].payload.patch.text, draftBeforeCommit)
  assert.equal(submitted[0].payload.expected['__fv.text'], 3,
    'the update uses the creation ACK field version, not the pre-insert zero baseline')
  const resolved = context.emitted.find(item => item.name === 'edit_session_resolved')
  assert.ok(resolved, 'successful commit resolves the edit session')
  assert.equal(resolved.args[0].draft.text, draftBeforeCommit,
    'committing after the insert ACK does not lose the draft content')
}

async function testScopeAndBatchMembershipRestrictCreationAck() {
  const runtime = await loadRuntime()
  for (const change of ['room', 'adapter']) {
    const context = createContext(runtime)
    const session = openSession(context)
    const scope = originalScope(context)
    if (change === 'room') context.httpRoomKey = 'room-create-b'
    else context.collabV2Adapter = { getClientId() { return 'client-next' } }
    await context.reconcileAckedLocalOperation(
      insertAck('local-child', 'local initial', 3),
      new Map(), scope, 'node.insert',
      { uid: 'local-child', parentUid: 'parent', text: 'local initial' }
    )
    assert.equal(context.getEditSession(session.id).baseVersions.text, 0,
      `an ACK from the old ${change} scope must not initialize the session`)
    assert.equal(context.completions.length, 0)
  }

  const batched = createContext(runtime)
  batched.currentData['peer-child'] = node('peer-child', {
    text: 'peer initial', richText: true, __fv: {}
  }, [], { parent_uid: 'parent', position: 'd', node_version: 0 })
  batched.currentData.parent.children.push('peer-child')
  const ownSession = openSession(batched, 'local-child')
  const peerSession = batched.editSessionManager.begin({
    uid: 'peer-child', roomKey: batched.httpRoomKey, fields: ['text', 'richText'],
    snapshot: batched.getEditSessionSnapshot('peer-child'),
    initialDraft: { text: 'peer local draft', richText: true }
  })
  const batchAck = {
    serverRevision: 6,
    operation: {
      type: 'batch.applied', serverRevision: 6,
      payload: { events: [
        insertAck('local-child', 'local initial', 6).operation,
        insertAck('peer-child', 'peer initial', 6).operation
      ] }
    }
  }
  await batched.reconcileAckedLocalOperation(
    batchAck, new Map(), originalScope(batched), 'node.batch',
    { ops: [{ type: 'node.insert', payload: { uid: 'local-child', parentUid: 'parent' } }] }
  )
  assert.equal(batched.getEditSession(ownSession.id).baseVersions.text, 6,
    'the ACK for an original insert UID in the submitted batch is absorbed')
  assert.equal(batched.getEditSession(peerSession.id).baseVersions.text, 0,
    'a same-shaped canonical insert outside the submitted batch cannot initialize another UID')
}

async function testPeerInsertUnderSameParentDoesNotConflictButSameFieldUpdateDoes() {
  const runtime = await loadRuntime()
  const context = createContext(runtime)
  const session = openSession(context, 'parent', ['text'])
  const parentBefore = clone(context.currentData.parent)

  assert.equal(await context.applyV2RemoteOperationNow({
    event: {
      type: 'node.inserted',
      payload: {
        uid: 'peer-child', parentUid: 'parent', position: 'c', index: 1,
        data: { uid: 'peer-child', text: 'peer child', __fv: { text: 3 } }
      }
    },
    serverRevision: 3,
    clientId: 'client-peer'
  }, {}, {
    epoch: context._v2RemoteApplyEpoch,
    room: context.httpRoomKey,
    adapter: context.collabV2Adapter,
    revision: context.lastAppliedVersion
  }), true)

  assert.equal(context.getEditSession(session.id).state, 'editing',
    'a sibling insertion does not conflict with an edit session on the parent')
  assert.deepEqual(context.currentData.parent.data.__fv, parentBefore.data.__fv,
    'a sibling insertion does not change the parent field versions')
  assert.equal(context.currentData.parent.node_version, parentBefore.node_version)
  assert.deepEqual(context.currentData.parent.children, ['local-child', 'peer-child'])

  assert.equal(await context.applyV2RemoteOperationNow({
    event: {
      type: 'node.updated',
      payload: {
        uid: 'parent',
        patch: { text: 'external parent edit', __fv: { text: 4 } }
      }
    },
    serverRevision: 4,
    clientId: 'client-peer'
  }, {}, {
    epoch: context._v2RemoteApplyEpoch,
    room: context.httpRoomKey,
    adapter: context.collabV2Adapter,
    revision: context.lastAppliedVersion
  }), true)

  const afterExternalEdit = context.getEditSession(session.id)
  assert.equal(afterExternalEdit.state, 'conflict',
    'a later external edit to the same UID and field still conflicts')
  assert.equal(afterExternalEdit.conflict.error.code, 'REPLACE_CONFLICT')
  assert.equal(afterExternalEdit.draft.text, session.draft.text,
    'the protected draft remains available after the real field conflict')
  assert.equal(context.currentData.parent.data.text, 'external parent edit')
}

function testCanonicalUpdatePreservesOnlyMatchingDataFieldVersions(runtime) {
  const matching = runtime.collabNodeFeatures.normalizeAppliedUpdatePayload({
    event: {
      type: 'node.updated',
      payload: {
        uid: 'node-a',
        patch: { text: '<p>canonical</p>' },
        data: { uid: 'node-a', __fv: { text: 8 }, note: 'not part of update patch' }
      }
    }
  })
  assert.deepEqual(matching, {
    uid: 'node-a',
    patch: { text: '<p>canonical</p>', __fv: { text: 8 } },
    payload: { uid: 'node-a', patch: { text: '<p>canonical</p>', __fv: { text: 8 } } }
  }, 'matching canonical data contributes field versions without business fields')

  const wrongUid = runtime.collabNodeFeatures.normalizeAppliedUpdatePayload({
    event: {
      type: 'node.updated',
      payload: {
        uid: 'node-a', patch: { text: 'canonical' },
        data: { uid: 'node-b', __fv: { text: 9 }, note: 'must not leak' }
      }
    }
  })
  assert.deepEqual(wrongUid.patch, { text: 'canonical' },
    'field versions from a different canonical UID cannot contaminate the update')

  const noVersions = runtime.collabNodeFeatures.normalizeAppliedUpdatePayload({
    event: {
      type: 'node.updated',
      payload: {
        uid: 'node-a', patch: { text: 'canonical' },
        data: { uid: 'node-a', note: 'not a version' }
      }
    }
  })
  assert.deepEqual(noVersions.patch, { text: 'canonical' },
    'canonical data without __fv adds no unrelated fields to the effective patch')
}

async function testOwnUpdateAckSurvivesNewerLocalIntentOnlyForItsSession() {
  const runtime = await loadRuntime()
  const context = createContext(runtime, { roomKey: 'room-current' })
  const session = openSession(context, 'local-child', ['text'])
  context.updateEditSessionDraft(session.id, { text: '<p>newer local draft</p>' })
  const draft = context.getEditSession(session.id).draft.text
  context.localIntentEpochOf = () => 7
  context._authoritativeRevByUid.set('local-child', 1)
  const ack = {
    event: {
      type: 'node.updated',
      payload: {
        uid: 'local-child',
        patch: { text: '<p>saved canonical value</p>' },
        data: {
          uid: 'local-child',
          __fv: { text: 8 },
          note: 'must not be copied into the text mutation'
        }
      }
    },
    serverRevision: 3,
    clientId: 'client-local'
  }
  const meta = {
    fromAck: true,
    applySelf: true,
    ackSessionId: session.id,
    capturedIntentEpochs: new Map([['local-child', 4]]),
    originalScope: originalScope(context)
  }
  const scope = {
    epoch: context._v2RemoteApplyEpoch,
    room: context.httpRoomKey,
    adapter: context.collabV2Adapter,
    revision: context.lastAppliedVersion
  }

  assert.equal(await context.applyV2RemoteOperationNow(ack, meta, scope), true)
  assert.equal(context.currentData['local-child'].data.text, '<p>saved canonical value</p>',
    'the exact session ACK applies its canonical text despite a later display intent')
  assert.equal(context.currentData['local-child'].data.__fv.text, 8,
    'canonical field versions are merged into authoritative data')
  assert.equal(Object.hasOwn(context.currentData['local-child'].data, 'note'), false,
    'unrelated canonical data fields do not enter the authority patch')
  assert.equal(context._authoritativeRevByUid.get('local-child'), 3)
  assert.equal(context.getEditSession(session.id).draft.text, draft,
    'applying the exact ACK does not replace the session draft')
  assert.equal(context.getEditSession(session.id).state, 'editing')

  for (const mode of ['unlinked', 'other-room']) {
    const stale = createContext(runtime, { roomKey: 'room-current' })
    let staleSession = openSession(stale, 'local-child', ['text'])
    if (mode === 'other-room') {
      const snapshot = stale.getEditSessionSnapshot('local-child')
      stale.editSessionManager.resolve(staleSession.id)
      staleSession = stale.editSessionManager.begin({
        uid: 'local-child', roomKey: 'room-previous', fields: ['text'],
        snapshot, initialDraft: { text: 'old room draft' }
      })
    }
    stale.localIntentEpochOf = () => 7
    stale._authoritativeRevByUid.set('local-child', 1)
    const staleMeta = {
      fromAck: true,
      applySelf: true,
      capturedIntentEpochs: new Map([['local-child', 4]]),
      originalScope: originalScope(stale),
      ...(mode === 'other-room' ? { ackSessionId: staleSession.id } : {})
    }
    const before = clone(stale.currentData['local-child'].data)
    assert.equal(await stale.applyV2RemoteOperationNow(ack, staleMeta, {
      epoch: stale._v2RemoteApplyEpoch,
      room: stale.httpRoomKey,
      adapter: stale.collabV2Adapter,
      revision: stale.lastAppliedVersion
    }), true)
    assert.deepEqual(stale.currentData['local-child'].data, before,
      `a ${mode} ACK without matching active session ownership remains blocked by newer local intent`)
  }

  const superseded = createContext(runtime, { roomKey: 'room-current' })
  const supersededSession = openSession(superseded, 'local-child', ['text'])
  superseded.localIntentEpochOf = () => 7
  superseded._authoritativeRevByUid.set('local-child', 4)
  const beforeSuperseded = clone(superseded.currentData['local-child'].data)
  assert.equal(await superseded.applyV2RemoteOperationNow(ack, {
    fromAck: true,
    applySelf: true,
    ackSessionId: supersededSession.id,
    capturedIntentEpochs: new Map([['local-child', 4]]),
    originalScope: originalScope(superseded)
  }, {
    epoch: superseded._v2RemoteApplyEpoch,
    room: superseded.httpRoomKey,
    adapter: superseded.collabV2Adapter,
    revision: superseded.lastAppliedVersion
  }), true)
  assert.deepEqual(superseded.currentData['local-child'].data, beforeSuperseded,
    'a newer authoritative UID revision still blocks an otherwise linked old ACK')
}

async function testOldTextAckCannotCrossDeleteOrSameUidRestore() {
  const runtime = await loadRuntime()
  const failures = []
  const makeScope = context => ({
    epoch: context._v2RemoteApplyEpoch,
    room: context.httpRoomKey,
    adapter: context.collabV2Adapter,
    revision: context.lastAppliedVersion
  })
  const deleteNode = async context => {
    context.applyV2PayloadDelete = payload => {
      const uid = String(payload.uid || '')
      context.deletedUids.add(uid)
      context.abandonedInsertUids.add(uid)
      context.renderNodes.delete(uid)
      return true
    }
    await context.applyV2RemoteOperationNow({
      event: {
        type: 'node.deleted',
        payload: { uid: 'local-child', parentUid: 'parent', removed: ['local-child'] }
      },
      serverRevision: 6,
      clientId: 'client-peer'
    }, {}, makeScope(context))
  }
  const createOldAck = (context, session) => {
    context.localIntentEpochOf = () => 7
    return {
      event: {
        type: 'node.updated',
        payload: {
          uid: 'local-child',
          patch: { text: 'old saved text' },
          data: { uid: 'local-child', __fv: { text: 5 } }
        }
      },
      serverRevision: 5,
      clientId: 'client-local',
      meta: {
        fromAck: true,
        applySelf: true,
        ackSessionId: session.id,
        capturedIntentEpochs: new Map([['local-child', 4]]),
        originalScope: originalScope(context),
        deferFallback: true
      }
    }
  }

  const deleted = createContext(runtime, { roomKey: 'room-delete-race' })
  const deletedSession = openSession(deleted, 'local-child', ['text'])
  deleted._authoritativeRevByUid.set('local-child', 4)
  await deleteNode(deleted)
  assert.equal(deleted.isTombstonedUid('local-child'), true)
  assert.equal(Object.hasOwn(deleted.currentData, 'local-child'), false)
  const deletedAck = createOldAck(deleted, deletedSession)
  await deleted.applyV2RemoteOperationNow(deletedAck, deletedAck.meta, makeScope(deleted))
  if (Object.hasOwn(deleted.currentData, 'local-child')) {
    failures.push('late update ACK recreated a deleted UID in currentData')
  }

  const restored = createContext(runtime, { roomKey: 'room-restore-race' })
  const restoredSession = openSession(restored, 'local-child', ['text'])
  restored._authoritativeRevByUid.set('local-child', 4)
  await deleteNode(restored)
  restored.applyV2PayloadRestore = payload => {
    const rows = Array.isArray(payload.rows) ? payload.rows : []
    rows.forEach(row => {
      const uid = String(row.uid || '')
      restored.deletedUids.delete(uid)
      restored.abandonedInsertUids.delete(uid)
      const data = { uid, ...(row.data || {}) }
      restored.renderNodes.set(uid, {
        data,
        getData(key) { return key == null ? this.data : this.data[key] }
      })
    })
    return true
  }
  await restored.applyV2RemoteOperationNow({
    event: {
      type: 'node.restored',
      payload: {
        uid: 'local-child',
        rows: [{
          uid: 'local-child', parent_uid: 'parent', position: 'b',
          data: { uid: 'local-child', text: 'restored newer text', __fv: { text: 7 } }
        }]
      }
    },
    serverRevision: 7,
    clientId: 'client-peer'
  }, {}, makeScope(restored))
  assert.equal(restored.isTombstonedUid('local-child'), false)
  const restoredBeforeAck = clone(restored.currentData['local-child'].data)
  const restoredAck = createOldAck(restored, restoredSession)
  await restored.applyV2RemoteOperationNow(restoredAck, restoredAck.meta, makeScope(restored))
  if (restored.currentData['local-child'].data.text !== restoredBeforeAck.text ||
    restored.currentData['local-child'].data.__fv.text !== restoredBeforeAck.__fv.text) {
    failures.push('late update ACK overwrote the same UID after a newer restore')
  }

  assert.deepEqual(failures, [], failures.join('; '))
}

function addSiblingProjectionFixture(context) {
  const local = context.renderNodes.get('local-child')
  const peer = {
    data: { uid: 'peer-child', text: 'peer', position: 'a', __fv: { text: 1 } },
    getData(key) { return key == null ? this.data : this.data[key] }
  }
  context.currentData['peer-child'] = {
    uid: 'peer-child', data: { ...peer.data }, children: [],
    parent_uid: 'parent', position: 'a', node_version: 1
  }
  context.currentData['local-child'].position = 'b'
  context.currentData.parent.children = ['peer-child', 'local-child']
  context.currentData.parent.children.forEach((uid, index) => {
    context.currentData[uid].position = index === 0 ? 'a' : 'b'
  })
  context.renderNodes.set('peer-child', peer)
  const parent = context.renderNodes.get('parent')
  parent.nodeData.children = [local, peer]
  return { local, peer, parent, originalLocalData: local.data }
}

async function testCanonicalSiblingProjectionPreservesReferencesAndDraft() {
  const runtime = await loadRuntime()
  const context = createContext(runtime)
  const session = openSession(context, 'local-child', ['text'])
  context.updateEditSessionDraft(session.id, { text: '<p>unsaved sibling draft</p>' })
  const beforeSession = context.getEditSession(session.id)
  const { local, peer, parent, originalLocalData } = addSiblingProjectionFixture(context)

  assert.equal(context.projectCanonicalChildOrder('parent'), true)
  assert.deepEqual(parent.nodeData.children, [peer, local],
    'loaded siblings follow currentData canonical child order')
  assert.equal(context.renderNodes.get('local-child'), local,
    'projection retains the rendered node reference')
  assert.equal(local.data, originalLocalData,
    'projection retains the rendered node data reference')
  assert.equal(local.data.position, 'b')
  assert.equal(peer.data.position, 'a')
  const afterSession = context.getEditSession(session.id)
  assert.equal(afterSession.draft.text, beforeSession.draft.text,
    'reordering preserves the active editor draft')
  assert.equal(afterSession.draftRevision, beforeSession.draftRevision)
}

async function testOlderCreationAckCannotRewindNewerStructure() {
  const runtime = await loadRuntime()
  const context = createContext(runtime)
  const { local, peer, parent } = addSiblingProjectionFixture(context)
  const session = openSession(context, 'local-child', ['text'])
  context.updateEditSessionDraft(session.id, { text: '<p>keep draft while projecting order</p>' })
  const draftBeforeAck = context.getEditSession(session.id).draft.text
  context._structuralGuardRevisions.set('local-child', 6)
  const event = {
    type: 'node.inserted',
    payload: {
      uid: 'local-child', parentUid: 'parent', position: 'a',
      data: { uid: 'local-child', text: 'local initial', richText: true, __fv: { text: 5 } },
      siblingPositions: {
        'local-child': { position: 'a' },
        'peer-child': { position: 'b' }
      }
    }
  }

  context.acknowledgeLocalNodeCreation(event, 5)
  assert.deepEqual(context.currentData.parent.children, ['peer-child', 'local-child'],
    'an old insert ACK cannot replace a newer authority child order')
  assert.equal(context.currentData['peer-child'].position, 'a')
  assert.equal(context.currentData['local-child'].position, 'b')
  assert.deepEqual(parent.nodeData.children, [peer, local],
    'an old insert ACK projects the latest authority order without replaying its stale order')
  assert.equal(context.renderNodes.get('local-child'), local,
    'projecting the latest order preserves the rendered node reference')
  assert.equal(local.data.position, 'b')
  assert.equal(peer.data.position, 'a')
  assert.equal(context.getEditSession(session.id).draft.text, draftBeforeAck,
    'projecting after an old ACK preserves the active draft')
}

async function testCanonicalSiblingProjectionDefersDuringDrag() {
  const runtime = await loadRuntime()
  const context = createContext(runtime)
  const { local, peer, parent } = addSiblingProjectionFixture(context)
  const beforeChildren = parent.nodeData.children.slice()
  context._dragViewDeferred = true

  assert.equal(context.projectCanonicalChildOrder('parent'), false,
    'dragging defers canonical projection')
  assert.deepEqual(parent.nodeData.children, beforeChildren,
    'the renderer child array is not reordered during drag')
  assert.equal(context.viewDeferred, true)
  assert.equal(context.dirtyUIDSet.has('parent'), true)
  assert.equal(context.viewStructureDirtyUIDSet.has('parent'), true)
  assert.equal(parent.nodeData.children[0], local)
  assert.equal(parent.nodeData.children[1], peer)
}

async function testAckReprojectsOrderAfterChildrenMaterialize() {
  const runtime = await loadRuntime()
  const context = createContext(runtime)
  const session = openSession(context, 'local-child', ['text'])
  context.updateEditSessionDraft(session.id, { text: '<p>draft survives delayed materialization</p>' })
  const draftBeforeAck = context.getEditSession(session.id)
  const { local, peer, parent, originalLocalData } = addSiblingProjectionFixture(context)
  parent.nodeData.children = []

  context.acknowledgeLocalNodeCreation({
    type: 'node.inserted',
    payload: {
      uid: 'local-child', parentUid: 'parent', index: 1, position: 'b',
      siblingPositions: { 'peer-child': 'a', 'local-child': 'b' },
      data: { uid: 'local-child', text: 'local initial', richText: true, __fv: { text: 3 } }
    }
  }, 3)
  assert.equal(context._pendingChildOrderParents.has('parent'), true,
    'ACK retains the parent while its canonical children are not materialized')
  assert.equal(context.renderRequests.length, 0,
    'an empty child list does not schedule a futile projection render')
  assert.equal(context.getEditSession(session.id).draft.text, draftBeforeAck.draft.text)
  assert.equal(context.getEditSession(session.id).draftRevision, draftBeforeAck.draftRevision)

  context._pendingRenderedVersion = 4
  context.lastAppliedVersion = 4
  context.onNodeTreeRenderEnd()
  assert.equal(context._pendingChildOrderParents.has('parent'), true,
    'a visible parent remains pending until its children are rendered')
  assert.equal(context.renderedVersion, 1,
    'paint completion does not advance while visible canonical children are pending')

  // The later tree materializes in a stale local order after the ACK has already run.
  parent.nodeData.children = [local, peer]
  context.onNodeTreeRenderEnd()
  assert.deepEqual(parent.nodeData.children, [peer, local],
    'render-end retries projection using the latest authority order')
  assert.equal(context._pendingChildOrderParents.has('parent'), false,
    'the parent leaves the pending set once all canonical children are projected')
  assert.equal(context.renderRequests.length, 1,
    'one reorder requests one follow-up render')
  assert.equal(context.renderedVersion, 1,
    'renderedVersion waits for the follow-up render after reordering')
  assert.equal(context.renderNodes.get('local-child'), local)
  assert.equal(local.data, originalLocalData)
  assert.equal(local.data.position, 'b')
  assert.equal(peer.data.position, 'a')
  const afterProjection = context.getEditSession(session.id)
  assert.equal(afterProjection.draft.text, draftBeforeAck.draft.text)
  assert.equal(afterProjection.draftRevision, draftBeforeAck.draftRevision)

  context.onNodeTreeRenderEnd()
  assert.equal(context.renderRequests.length, 1,
    'the next render-end does not enqueue another render when order is already canonical')
  assert.equal(context.renderedVersion, 4,
    'the completed follow-up render advances the paint watermark')
}

async function main() {
  const runtime = await loadRuntime()
  testCanonicalUpdatePreservesOnlyMatchingDataFieldVersions(runtime)
  await testOwnUpdateAckSurvivesNewerLocalIntentOnlyForItsSession()
  await testOldTextAckCannotCrossDeleteOrSameUidRestore()
  await testCanonicalSiblingProjectionPreservesReferencesAndDraft()
  await testOlderCreationAckCannotRewindNewerStructure()
  await testCanonicalSiblingProjectionDefersDuringDrag()
  await testAckReprojectsOrderAfterChildrenMaterialize()
  await testOwnInsertAckInitializesOnlyTheBaseline()
  await testAckRequiresTheSubmittedUidAndOriginalValue()
  await testOldRoomSessionDoesNotAbsorbCurrentRoomCreationAck()
  await testOldAckCannotReplaceNewerAuthorityOrResurrectDeletion()
  await testNewerNoteDoesNotBlockTextCreationBaseline()
  await testRichTextInsertNormalizationInitializesOnlyKnownCanonicalText()
  await testCommitWaitsForQueuedCreationBaselineEvenWhenInsertIsAcked()
  await testScopeAndBatchMembershipRestrictCreationAck()
  await testPeerInsertUnderSameParentDoesNotConflictButSameFieldUpdateDoes()
  console.log('PASS own creation ACK baseline absorption, same-parent concurrency, and later field conflict')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
