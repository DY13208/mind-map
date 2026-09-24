const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')

const source = fs.readFileSync(
  path.join(__dirname, '../src/plugins/Cooperate.js'),
  'utf8'
)

function methodSource(start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  assert.notEqual(from, -1, `method start missing: ${start}`)
  assert.notEqual(to, -1, `method end missing: ${end}`)
  return source.slice(from, to)
}

const recoveryPlanOverride = { type: 'resnapshot' }
const methods = vm.runInNewContext(
  `${methodSource('function indexTreeNodesByUid(', 'function isPermanentNodeError')}
  ({
    indexTreeNodesByUid,
    removeTreeNodesFromUidIndex,
    hasVersionRestoreOperation,
    ${[
      methodSource('  collectVisibleUids() {', '  async fetchHttpNodes(uids) {'),
      methodSource('  async fetchHttpNodes(uids) {', '  acknowledgeLocalVersion(version, extra = {}) {'),
      methodSource('  scheduleRemoteRecover(version, options = {}) {', '  scheduleHttpRecoverRetry(version, options = {}) {'),
      methodSource('  scheduleHttpRecoverRetry(version, options = {}) {', '  scheduleHttpStructureSync'),
      methodSource('  async syncHttpDirtySubtrees(treeNodeIndex) {', '  async syncHttpRemoteOperations(operations) {'),
      methodSource('  async recoverHttpCollab(targetVersion, options = {}) {', '  async refreshVisibleFromHttp(updatedAt, options = {}) {'),
      methodSource('  async refreshVisibleFromHttp(updatedAt, options = {}) {', '  flushPendingHttpRefresh() {'),
      methodSource('  async persistHttpReplace(fullData, extra = {}) {', '  async restoreHttpTree(options = {}) {'),
      methodSource('  async restoreHttpTree(options = {}) {', '  mergeHttpChildren(data, incoming) {')
    ].join(',\n')}
  })`,
  {
    planCollabRecovery: (lastApplied, target) =>
      recoveryPlanOverride.type === 'ignore'
        ? { type: 'ignore', lastAppliedVersion: Number(lastApplied) || 0 }
        : recoveryPlanOverride.type === 'fetch_operations'
        ? {
            type: 'fetch_operations',
            afterVersion: Number(lastApplied) || 0,
            version: Number(target) || Number(lastApplied) || 0
          }
        : {
            type: 'resnapshot',
            version: Number(target) || Number(lastApplied) || 0
          },
    planAfterOperations: (lastApplied, payload) => {
      const operations = Array.isArray(payload && payload.operations)
        ? payload.operations
        : []
      const requiresResnapshot = operations.some(operation => {
        const event = (operation && operation.event) || operation || {}
        const data = event.payload || (operation && operation.payload) || {}
        return event.type === 'map.replaced' || data.resnapshot
      })
      return requiresResnapshot
        ? {
            type: 'resnapshot',
            version: Number(payload.currentVersion) || lastApplied + 1
          }
        : { type: 'ignore' }
    },
    markDirtySubtrees: () => ({}),
    affectedUidsFromOperation: () => [],
    applyCollabEvent: value => value,
    RECENT_PUSH_GRACE_MS: 2500,
    sameHttpStamp: (a, b) => String(a || '') === String(b || ''),
    pruneRecentMap() {},
    applyRemoteNodeData: (local, remote) => ({
      data: { ...local, ...remote },
      appliedKeys: []
    }),
    publicNodeData: data => data,
    collabNodeFeatures: {
      buildNodeContentFields: data => ({
        text: String(data.text || ''),
        note: String(data.note || '')
      })
    },
    readFieldVersions: () => ({}),
    keepHttpChild: (uid, serverKids) => serverKids.has(uid),
    HTTP_RECOVER_RETRY_BASE_MS: 500,
    HTTP_RECOVER_RETRY_MAX_MS: 30000,
    HTTP_RECOVER_RESTORE_WAIT_MS: 60000,
    collabFullTree: {
      resolveFullTreeReason: extra => extra.reason || '',
      currentFullTreeReason: () => '',
      isFullTreeMutationAllowed: () => true,
      publishImportTrace() {},
      withAllowedFullTreeMutation: (_reason, fn) => fn()
    },
    setTimeout,
    clearTimeout,
    Date,
    console
  }
)

function makeTree(uids, rootUid = 'root') {
  const root = {
    data: { uid: rootUid, text: 'local root', childCount: Math.max(0, uids.length) },
    children: []
  }
  const liveNodes = new Map()
  const makeLiveNode = treeNode => {
    const liveNode = {
      nodeData: treeNode,
      children: [],
      getData(key) {
        return key ? this.nodeData.data[key] : this.nodeData.data
      }
    }
    if (treeNode.data.uid) liveNodes.set(treeNode.data.uid, liveNode)
    liveNode.children = (treeNode.children || []).map(makeLiveNode)
    return liveNode
  }
  root.children = uids.map(uid => {
    const child = { data: { uid, text: `local ${uid}`, childCount: 0 }, children: [] }
    return child
  })
  const liveRoot = makeLiveNode(root)
  return { root, liveRoot, liveNodes }
}

function makeServerNodes(rootChildren, extraUids = []) {
  const uids = ['root', ...rootChildren, ...extraUids]
  const nodes = new Map()
  uids.forEach(uid => {
    nodes.set(uid, {
      uid,
      isRoot: uid === 'root',
      data: {
        uid,
        text: `server ${uid}`,
        childCount: 0
      },
      children: []
    })
  })
  nodes.get('root').children = rootChildren
  nodes.get('root').data.childCount = rootChildren.length
  return nodes
}

function makePlugin({ root, liveNodes, liveRoot = liveNodes.get(root.data.uid), fetchNodes }) {
  const appliedUids = []
  const plugin = {
    ...methods,
    mindMap: {
      renderer: {
        root: liveRoot,
        renderTree: root,
        findNodeByUid(uid) {
          plugin.rendererLookupCount += 1
          return liveNodes.get(uid) || null
        }
      },
      command: { pause() {}, recovery() {} },
      render() {},
      setFullData(data) {
        plugin.mindMap.renderer.renderTree = data.root
      }
    },
    httpCollabMode: true,
    httpFetchNodes: fetchNodes,
    httpFetchExportTree: null,
    httpFetchSubtree: null,
    httpFetchOperations: null,
    httpUpdatedAt: '',
    suppressLocalUntil: 0,
    safeLoadMode: false,
    httpRecovering: false,
    httpRecoverQueued: false,
    httpPendingRecoverVersion: 0,
    httpPendingRecoverOptions: null,
    httpRecoverRetryTimer: null,
    httpRecoverRetryDelay: 500,
    httpRemoteRecoverTimer: null,
    httpPendingRemoteVersion: 0,
    httpPendingRefreshAt: '',
    httpPendingRefreshForce: false,
    httpRefreshing: false,
    httpHydrating: false,
    httpSettlingAfterReplace: false,
    isApplyingRemote: false,
    lastAppliedVersion: 0,
    lastPushed: {},
    dirtySubtrees: new Map(),
    recentPushed: new Map(),
    recentHttpDeleted: new Map(),
    deletedUids: new Set(),
    abandonedInsertUids: new Set(),
    hydratedUids: new Set(),
    collabStore: {
      setStatus() {},
      setLastAppliedVersion() {}
    },
    nodePlain: node => node.getData('text'),
    hasUnsyncedLocalText: () => false,
    generalizationRemoteChanged: () => false,
    applyHttpRemoteNodeFields(node, data) {
      const changed = Object.keys(data).some(
        key => node.nodeData.data[key] !== data[key]
      )
      Object.assign(node.nodeData.data, data)
      if (changed) appliedUids.push(data.uid)
      return changed
    },
    findTreeNode(tree, uid) {
      plugin.treeLookupCount += 1
      const stack = [tree]
      while (stack.length) {
        const current = stack.pop()
        if (current && current.data && current.data.uid === uid) return current
        stack.push(...((current && current.children) || []))
      }
      return null
    },
    syncGeneralizationChildStubs: () => false,
    isRecentlyHttpDeleted(uid) {
      return this.recentHttpDeleted.has(uid)
    },
    dropHttpTree() {},
    syncHttpDirtySubtrees: async () => false,
    isTombstonedUid(uid) {
      return (
        this.deletedUids.has(uid) ||
        this.abandonedInsertUids.has(uid) ||
        this.recentHttpDeleted.has(uid)
      )
    },
    reviveDeletedUid(uid) {
      this.deletedUids.delete(uid)
      this.abandonedInsertUids.delete(uid)
      this.recentHttpDeleted.delete(uid)
    },
    ensureHttpNodePath: async () => false,
    mergeHttpChildren(parent, children) {
      const have = new Set((parent.children || []).map(child => child.data.uid))
      parent.children = parent.children || []
      children.forEach(child => {
        if (!have.has(child.data.uid) && !plugin.isTombstonedUid(child.data.uid)) {
          parent.children.push(child)
        }
      })
    },
    expandTreeNode: () => true,
    markCollapsedLoadedDirty() {},
    stampLoadedSubtreeVersions() {},
    afterHttpReplace() {},
    appliedUids
  }
  plugin.rendererLookupCount = 0
  plugin.treeLookupCount = 0
  plugin.mindMap.render = callback => {
    plugin.renderCount = (plugin.renderCount || 0) + 1
    if (callback) callback()
  }
  return plugin
}

function nodeFetcher(serverNodes, calls, beforeFetch) {
  return async uids => {
    calls.push(uids.slice())
    if (beforeFetch) await beforeFetch(uids, calls.length)
    return { nodes: uids.map(uid => serverNodes.get(uid)).filter(Boolean) }
  }
}

test('history resnapshot fetches every rendered node in bounded requests', async () => {
  const childUids = Array.from({ length: 450 }, (_, i) => `n${i}`)
  const { root, liveNodes } = makeTree(childUids)
  const serverNodes = makeServerNodes(childUids)
  const calls = []
  const plugin = makePlugin({
    root,
    liveNodes,
    fetchNodes: nodeFetcher(serverNodes, calls)
  })

  assert.equal(plugin.collectVisibleUids().length, 451)
  await plugin.recoverHttpCollab(12)

  assert.deepEqual(calls.map(batch => batch.length), [200, 200, 51])
  assert.equal(plugin.appliedUids.length, 451)
  assert.equal(plugin.lastAppliedVersion, 12)
  assert.equal(plugin.rendererLookupCount, 0)
  assert.equal(plugin.treeLookupCount, 0)
})

test('HTTP import replacement sends the applied post-restore revision as baseVersion', async () => {
  const calls = []
  const plugin = {
    httpReplaceInFlight: false,
    lastAppliedVersion: 11,
    httpReplaceTree: async (tree, extra) => {
      calls.push({ tree, extra })
      return { version: 12 }
    },
    afterHttpReplace() {},
    persistHttpReplace: methods.persistHttpReplace
  }

  const tree = { data: { uid: 'root', text: 'imported' }, children: [] }
  const result = await plugin.persistHttpReplace(
    { root: tree },
    { source: 'import', reason: 'IMPORT' }
  )

  assert.equal(calls.length, 1)
  assert.equal(calls[0].tree, tree)
  assert.equal(calls[0].extra.baseVersion, 11)
  assert.equal(result.version, 12)
  assert.equal(plugin.httpReplaceInFlight, false)

  await plugin.persistHttpReplace(
    { root: tree },
    { source: 'import', reason: 'IMPORT', baseVersion: 4 }
  )
  assert.equal(calls[1].extra.baseVersion, 4, 'an explicit stale base must not be upgraded')
})

test('server restore epoch accepts current baseVersion and rejects a stale or missing one', () => {
  const storageSource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../bin/storage.js'),
    'utf8'
  )
  const start = storageSource.indexOf('function rejectIfStaleAfterRestore(')
  const end = storageSource.indexOf(
    '\nasync function commitDirectRoomOperationOnce',
    start
  )
  assert.notEqual(start, -1, 'restore epoch guard must exist in storage')
  assert.notEqual(end, -1, 'restore epoch guard boundary must exist in storage')
  const rejectIfStaleAfterRestore = vm.runInNewContext(
    `(() => { ${storageSource.slice(start, end)}; return rejectIfStaleAfterRestore })()`
  )
  const room = { restore_epoch_revision: 11, version: 12 }

  assert.doesNotThrow(() =>
    rejectIfStaleAfterRestore(room, {
      type: 'map.replace',
      baseVersion: 11,
      payload: { reason: 'IMPORT' }
    })
  )
  assert.throws(
    () =>
      rejectIfStaleAfterRestore(room, {
        type: 'map.replace',
        baseVersion: 10,
        payload: { reason: 'IMPORT' }
      }),
    error => error && error.code === 'STALE_AFTER_VERSION_RESTORE'
  )
  assert.throws(
    () =>
      rejectIfStaleAfterRestore(room, {
        type: 'map.replace',
        payload: { reason: 'IMPORT' }
      }),
    error => error && error.code === 'STALE_AFTER_VERSION_RESTORE'
  )
})

test('VERSION_RESTORE still refreshes when its realtime operation advanced the revision first', async () => {
  const { root, liveNodes } = makeTree(['tiny'])
  const serverNodes = makeServerNodes(['tiny', 'restored'])
  const calls = []
  const plugin = makePlugin({
    root,
    liveNodes,
    fetchNodes: nodeFetcher(serverNodes, calls)
  })
  // The realtime map.replaced op can reach the editor before HistoryPanel emits
  // its local restore result, making the requested revision equal to this one.
  plugin.lastAppliedVersion = 42
  recoveryPlanOverride.type = 'ignore'

  try {
    await plugin.recoverHttpCollab(42, { reason: 'VERSION_RESTORE' })
  } finally {
    recoveryPlanOverride.type = 'resnapshot'
  }

  assert.ok(root.children.some(child => child.data.uid === 'restored'))
  assert.ok(calls.length > 0, 'restore must fetch the authoritative tree')
  assert.equal(plugin.lastAppliedVersion, 42)
})

test('VERSION_RESTORE bypasses safe-load resnapshot gate for a large revision gap', async () => {
  const { root, liveNodes } = makeTree(['tiny'])
  const serverNodes = makeServerNodes(['tiny', 'restored'])
  const calls = []
  const plugin = makePlugin({
    root,
    liveNodes,
    fetchNodes: nodeFetcher(serverNodes, calls)
  })
  plugin.safeLoadMode = true

  await plugin.recoverHttpCollab(501, { reason: 'VERSION_RESTORE' })

  assert.ok(root.children.some(child => child.data.uid === 'restored'))
  assert.ok(calls.length > 0, 'large-map restore must not be silently rejected')
  assert.equal(plugin.lastAppliedVersion, 501)
})

test('queued VERSION_RESTORE resolves only after its forced refresh completes', async () => {
  const { root, liveNodes } = makeTree(['tiny'])
  const serverNodes = makeServerNodes(['tiny', 'restored'])
  const calls = []
  let startFetch
  let releaseFetch
  const started = new Promise(resolve => { startFetch = resolve })
  const gate = new Promise(resolve => { releaseFetch = resolve })
  const plugin = makePlugin({
    root,
    liveNodes,
    fetchNodes: nodeFetcher(serverNodes, calls, async (_uids, count) => {
      if (count === 1) {
        startFetch()
        await gate
      }
    })
  })

  const initialRecovery = plugin.recoverHttpCollab(42)
  await started
  let restoreSettled = false
  const restore = plugin.recoverHttpCollab(42, { reason: 'VERSION_RESTORE' })
  restore.then(() => { restoreSettled = true })
  await Promise.resolve()

  assert.equal(restoreSettled, false, 'queued restore must wait for its own refresh')
  releaseFetch()
  await initialRecovery
  const result = await restore

  assert.equal(result.applied, true)
  assert.ok(calls.length >= 2, 'queued restore should perform a second authoritative fetch')
  assert.ok(root.children.some(child => child.data.uid === 'restored'))
})

test('queued VERSION_RESTORE waits when its requested revision exceeds the active refresh', async () => {
  const { root, liveNodes } = makeTree(['tiny'])
  const serverNodes = makeServerNodes(['tiny'])
  const calls = []
  let startFirstFetch
  let releaseFirstFetch
  let startSecondFetch
  let releaseSecondFetch
  const firstStarted = new Promise(resolve => { startFirstFetch = resolve })
  const firstGate = new Promise(resolve => { releaseFirstFetch = resolve })
  const secondStarted = new Promise(resolve => { startSecondFetch = resolve })
  const secondGate = new Promise(resolve => { releaseSecondFetch = resolve })
  const plugin = makePlugin({
    root,
    liveNodes,
    fetchNodes: nodeFetcher(serverNodes, calls, async (_uids, count) => {
      if (count === 1) {
        startFirstFetch()
        await firstGate
      } else if (count === 2) {
        startSecondFetch()
        await secondGate
      }
    })
  })

  const first = plugin.recoverHttpCollab(42, { reason: 'VERSION_RESTORE' })
  await firstStarted
  let secondSettled = false
  const second = plugin.recoverHttpCollab(43, { reason: 'VERSION_RESTORE' })
  second.then(() => { secondSettled = true })
  releaseFirstFetch()
  await secondStarted

  const firstResult = await first
  assert.equal(firstResult.applied, true)
  assert.equal(firstResult.version, 42)
  assert.equal(secondSettled, false, 'revision 43 must wait for its own refresh')

  releaseSecondFetch()
  const secondResult = await second
  assert.equal(secondResult.applied, true)
  assert.equal(secondResult.version, 43)
  assert.equal(plugin.lastAppliedVersion, 43)
})

test('deferred VERSION_RESTORE retries even when its revision is already applied', async () => {
  const { root, liveNodes } = makeTree(['tiny'])
  const serverNodes = makeServerNodes(['tiny', 'restored'])
  const calls = []
  const plugin = makePlugin({
    root,
    liveNodes,
    fetchNodes: nodeFetcher(serverNodes, calls)
  })
  plugin.lastAppliedVersion = 42
  plugin.suppressLocalUntil = Date.now() + 25

  const result = await plugin.recoverHttpCollab(42, { reason: 'VERSION_RESTORE' })

  assert.ok(calls.length > 0, 'deferred same-revision restore must retry')
  assert.ok(root.children.some(child => child.data.uid === 'restored'))
  assert.equal(result.applied, true, 'restore promise resolves only after retry applies')
  assert.equal(plugin.httpPendingRecoverVersion, 0)
})

test('history resnapshot fetches missing children in batches and restores their order', async () => {
  const newChildUids = Array.from({ length: 251 }, (_, i) => `new${i}`)
  const { root, liveNodes } = makeTree(['new250', 'new0'])
  const serverNodes = makeServerNodes(newChildUids)
  const calls = []
  const plugin = makePlugin({
    root,
    liveNodes,
    fetchNodes: nodeFetcher(serverNodes, calls)
  })

  await plugin.recoverHttpCollab(3)

  assert.deepEqual(calls.map(batch => batch.length), [3, 200, 49])
  assert.equal(root.children.length, 251)
  assert.deepEqual(
    root.children.map(child => child.data.uid),
    newChildUids
  )
  assert.equal(plugin.lastAppliedVersion, 3)
})

test('VERSION_RESTORE revives and hydrates expanded missing subtrees while preserving collapsed branches', async () => {
  const { root, liveNodes } = makeTree(['tiny'])
  const serverNodes = makeServerNodes(['tiny', 'branch'], [
    'expandedChild',
    'collapsedChild',
    'expandedLeaf',
    'collapsedLeaf'
  ])
  serverNodes.get('root').data.expand = true
  serverNodes.get('root').children = ['tiny', 'branch']
  serverNodes.get('branch').data.expand = true
  serverNodes.get('branch').children = ['expandedChild', 'collapsedChild']
  serverNodes.get('expandedChild').data.expand = true
  serverNodes.get('expandedChild').children = ['expandedLeaf']
  serverNodes.get('collapsedChild').data.expand = false
  serverNodes.get('collapsedChild').children = ['collapsedLeaf']

  const calls = []
  const plugin = makePlugin({
    root,
    liveNodes,
    fetchNodes: nodeFetcher(serverNodes, calls)
  })
  plugin.deletedUids.add('branch')
  plugin.abandonedInsertUids.add('branch')
  plugin.recentHttpDeleted.set('branch', Date.now())

  await plugin.recoverHttpCollab(4, { reason: 'VERSION_RESTORE' })

  const branch = root.children.find(child => child.data.uid === 'branch')
  assert.ok(branch, 'restored server child should clear its local tombstone')
  assert.equal(plugin.isTombstonedUid('branch'), false)
  assert.equal(root.data.expand, true, 'restore should keep the server expanded state')
  assert.equal(branch.data.expand, true, 'new stubs should keep the server expanded state')
  assert.deepEqual(
    Array.from(branch.children, child => child.data.uid),
    ['expandedChild', 'collapsedChild']
  )
  assert.deepEqual(
    Array.from(branch.children[0].children, child => child.data.uid),
    ['expandedLeaf']
  )
  assert.equal(branch.children[1].data.expand, false)
  assert.deepEqual(Array.from(branch.children[1].children), [], 'collapsed branches stay lazy')
  assert.equal(branch.children[1].data.childCount, 1)
  assert.equal(
    calls.some(batch => batch.includes('collapsedLeaf')),
    false,
    'children below a collapsed branch should not be fetched'
  )
  assert.equal(plugin.lastAppliedVersion, 4)
})

test('VERSION_RESTORE reloads the full tree when the authoritative root UID changed', async () => {
  const { root, liveNodes } = makeTree([], 'old-root-uid')
  const restoredTree = {
    data: { uid: 'new-root-uid', text: 'restored root', expand: true },
    children: [
      { data: { uid: 'restored-child', text: 'restored child' }, children: [] }
    ]
  }
  const nodeCalls = []
  const plugin = makePlugin({
    root,
    liveNodes,
    fetchNodes: async uids => {
      nodeCalls.push(uids.slice())
      return { nodes: [] }
    }
  })
  let exportCalls = 0
  plugin.httpFetchExportTree = async () => {
    exportCalls += 1
    return { version: 8, node_count: 2, tree: restoredTree }
  }
  const result = await plugin.recoverHttpCollab(8, { reason: 'VERSION_RESTORE' })

  assert.equal(nodeCalls.length, 1, JSON.stringify(result))
  assert.equal(nodeCalls[0][0], 'old-root-uid')
  assert.equal(exportCalls, 1)
  assert.equal(result.applied, true)
  assert.equal(result.version, 8)
  assert.equal(plugin.mindMap.renderer.renderTree.data.uid, 'new-root-uid')
})

test('VERSION_RESTORE detects a changed root even when some old child UIDs still overlap', async () => {
  const { root, liveNodes } = makeTree(['shared-child'], 'old-root-uid')
  const restoredTree = {
    data: { uid: 'new-root-uid', text: 'restored root', expand: true },
    children: [
      { data: { uid: 'shared-child', text: 'server child' }, children: [] }
    ]
  }
  let exportCalls = 0
  const plugin = makePlugin({
    root,
    liveNodes,
    fetchNodes: async uids => ({
      nodes: uids.includes('shared-child')
        ? [{
            uid: 'shared-child',
            isRoot: false,
            data: { uid: 'shared-child', text: 'server child' },
            children: []
          }]
        : []
    })
  })
  plugin.httpFetchExportTree = async () => {
    exportCalls += 1
    return { version: 9, node_count: 2, tree: restoredTree }
  }

  const result = await plugin.refreshVisibleFromHttp('', {
    force: true,
    allowReviveDeleted: true,
    targetVersion: 8
  })

  assert.equal(exportCalls, 1, 'partial UID overlap must not hide a root replacement')
  assert.equal(result.applied, true)
  assert.equal(result.version, 9, 'recovery must retain the authoritative snapshot revision')
  assert.equal(plugin.mindMap.renderer.renderTree.data.uid, 'new-root-uid')
})

test('full-tree restore does not resolve until the actual render callback runs', async () => {
  const { root, liveNodes } = makeTree([], 'old-root-uid')
  const plugin = makePlugin({ root, liveNodes, fetchNodes: async () => ({ nodes: [] }) })
  plugin.httpFetchExportTree = async () => ({
    version: 8,
    node_count: 1,
    tree: { data: { uid: 'new-root-uid' }, children: [] }
  })
  let finishRender
  let renderStarted
  const started = new Promise(resolve => { renderStarted = resolve })
  plugin.mindMap.render = callback => {
    finishRender = callback
    renderStarted()
  }

  let settled = false
  const restore = plugin.restoreHttpTree({ targetVersion: 8 }).then(result => {
    settled = true
    return result
  })
  await started

  assert.equal(settled, false)
  finishRender()
  const result = await restore
  assert.equal(result.applied, true)
})

test('full-tree restore rejects truncated, incomplete, or stale exports', async () => {
  const { root, liveNodes } = makeTree([], 'old-root-uid')
  const plugin = makePlugin({
    root,
    liveNodes,
    fetchNodes: async () => ({ nodes: [] })
  })
  const validTree = { data: { uid: 'root' }, children: [] }

  plugin.httpFetchExportTree = async () => ({ version: 8, node_count: 1 })
  await assert.rejects(
    plugin.restoreHttpTree({ targetVersion: 8 }),
    error => error.code === 'HTTP_HISTORY_EXPORT_INCOMPLETE'
  )

  plugin.httpFetchExportTree = async () => ({
    version: 8,
    node_count: 2,
    truncated: true,
    tree: validTree
  })
  await assert.rejects(
    plugin.restoreHttpTree({ targetVersion: 8 }),
    error => error.code === 'HTTP_HISTORY_EXPORT_INCOMPLETE'
  )

  plugin.httpFetchExportTree = async () => ({
    version: 8,
    node_count: 2,
    tree: validTree
  })
  await assert.rejects(
    plugin.restoreHttpTree({ targetVersion: 8 }),
    error => error.code === 'HTTP_HISTORY_EXPORT_INCOMPLETE'
  )

  plugin.httpFetchExportTree = async () => ({
    version: 7,
    node_count: 1,
    tree: validTree
  })
  await assert.rejects(
    plugin.restoreHttpTree({ targetVersion: 8 }),
    error => error.code === 'HTTP_HISTORY_STALE_SNAPSHOT'
  )
})

test('operations polling carries VERSION_RESTORE through a resnapshot', async () => {
  const { root, liveNodes } = makeTree(['tiny'])
  const serverNodes = makeServerNodes(['tiny', 'branch'])
  serverNodes.get('root').children = ['tiny', 'branch']
  serverNodes.get('branch').data.expand = false
  const plugin = makePlugin({
    root,
    liveNodes,
    fetchNodes: nodeFetcher(serverNodes, [])
  })
  plugin.deletedUids.add('branch')
  plugin.abandonedInsertUids.add('branch')
  plugin.recentHttpDeleted.set('branch', Date.now())
  plugin.httpFetchOperations = async () => ({
    currentVersion: 8,
    operations: [
      {
        version: 8,
        event: {
          type: 'map.replaced',
          payload: { resnapshot: true, fullTreeReason: 'VERSION_RESTORE' }
        }
      }
    ]
  })

  recoveryPlanOverride.type = 'fetch_operations'
  try {
    await plugin.recoverHttpCollab(8)
  } finally {
    recoveryPlanOverride.type = 'resnapshot'
  }

  assert.ok(root.children.some(child => child.data.uid === 'branch'))
  assert.equal(plugin.isTombstonedUid('branch'), false)
  assert.equal(plugin.lastAppliedVersion, 8)
})

test('history resnapshot does not expand an existing parent that is collapsed in the restored version', async () => {
  const { root, liveNodes } = makeTree(['tiny'])
  const serverNodes = makeServerNodes(['tiny', 'branch'], ['nested'])
  serverNodes.get('root').data.expand = false
  serverNodes.get('root').children = ['tiny', 'branch']
  serverNodes.get('branch').data.expand = true
  serverNodes.get('branch').children = ['nested']
  const calls = []
  const plugin = makePlugin({
    root,
    liveNodes,
    fetchNodes: nodeFetcher(serverNodes, calls)
  })

  await plugin.recoverHttpCollab(5)

  const branch = root.children.find(child => child.data.uid === 'branch')
  assert.ok(branch)
  assert.equal(root.data.expand, false)
  assert.equal(branch.data.childCount, 1)
  assert.deepEqual(Array.from(branch.children), [], 'collapsed parent keeps descendant data lazy')
  assert.equal(calls.some(batch => batch.includes('nested')), false)
})

test('recovery deferred by local suppression retries before acknowledging the version', async () => {
  const { root, liveNodes } = makeTree([])
  const serverNodes = makeServerNodes([])
  const calls = []
  const plugin = makePlugin({
    root,
    liveNodes,
    fetchNodes: nodeFetcher(serverNodes, calls)
  })
  plugin.suppressLocalUntil = Date.now() + 30

  const result = await plugin.recoverHttpCollab(6, { reason: 'VERSION_RESTORE' })

  assert.ok(calls.length > 0)
  assert.equal(result.applied, true)
  assert.equal(plugin.lastAppliedVersion, 6)
  assert.equal(plugin.httpPendingRecoverVersion, 0)
})

test('recovery keeps its version pending when a listed restored node is missing from both node and subtree fetches', async () => {
  const { root, liveNodes } = makeTree([])
  const serverNodes = makeServerNodes(['missing'])
  serverNodes.delete('missing')
  const plugin = makePlugin({
    root,
    liveNodes,
    fetchNodes: async uids => ({
      nodes: uids.map(uid => serverNodes.get(uid)).filter(Boolean)
    })
  })
  plugin.httpFetchSubtree = async () => ({ children: [] })

  await assert.rejects(
    plugin.recoverHttpCollab(7, { reason: 'VERSION_RESTORE' }),
    err => err.code === 'HTTP_HISTORY_NODE_MISSING'
  )

  assert.equal(plugin.lastAppliedVersion, 0)
  assert.equal(plugin.httpPendingRecoverVersion, 7)
  clearTimeout(plugin.httpRecoverRetryTimer)
  plugin.httpRecoverRetryTimer = null
})

test('failed resnapshot batch retries automatically with bounded delay', async () => {
  const childUids = Array.from({ length: 450 }, (_, i) => `n${i}`)
  const { root, liveNodes } = makeTree(childUids)
  const serverNodes = makeServerNodes(childUids)
  const calls = []
  let failOnce = true
  const plugin = makePlugin({
    root,
    liveNodes,
    fetchNodes: async uids => {
      calls.push(uids.slice())
      if (failOnce && calls.length === 2) {
        failOnce = false
        throw new Error('temporary second batch failure')
      }
      return { nodes: uids.map(uid => serverNodes.get(uid)).filter(Boolean) }
    }
  })

  await assert.rejects(plugin.recoverHttpCollab(8), /temporary second batch failure/)
  assert.equal(plugin.lastAppliedVersion, 0)
  assert.equal(plugin.httpPendingRecoverVersion, 8)
  assert.equal(plugin.httpUpdatedAt, '')

  const deadline = Date.now() + 3000
  while (plugin.lastAppliedVersion !== 8 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }

  assert.equal(plugin.lastAppliedVersion, 8)
  assert.equal(plugin.httpPendingRecoverVersion, 0)
  assert.deepEqual(calls.map(batch => batch.length), [200, 200, 200, 200, 51])
})

test('recovery coalesces a newer version received while a batch is in flight', async () => {
  const { root, liveNodes } = makeTree([])
  const serverNodes = makeServerNodes([])
  const calls = []
  let startFetch
  let releaseFetch
  const started = new Promise(resolve => { startFetch = resolve })
  const gate = new Promise(resolve => { releaseFetch = resolve })
  const plugin = makePlugin({
    root,
    liveNodes,
    fetchNodes: nodeFetcher(serverNodes, calls, async (_uids, count) => {
      if (count === 1) {
        startFetch()
        await gate
      }
    })
  })
  const scheduled = []
  plugin.scheduleRemoteRecover = version => scheduled.push(version)

  const first = plugin.recoverHttpCollab(20)
  await started
  await plugin.recoverHttpCollab(21)
  releaseFetch()
  await first

  assert.equal(plugin.lastAppliedVersion, 20)
  assert.deepEqual(scheduled, [21])
})

test('history resnapshot reorders existing siblings and renders the change', async () => {
  const { root, liveNodes } = makeTree(['a', 'b', 'c'])
  const serverNodes = makeServerNodes(['c', 'a', 'b'])
  serverNodes.forEach((item, uid) => {
    item.data.text = uid === 'root' ? 'local root' : `local ${uid}`
  })
  const calls = []
  const plugin = makePlugin({
    root,
    liveNodes,
    fetchNodes: nodeFetcher(serverNodes, calls)
  })

  await plugin.recoverHttpCollab(14)

  assert.deepEqual(root.children.map(child => child.data.uid), ['c', 'a', 'b'])
  assert.equal(plugin.renderCount, 1)
  assert.equal(plugin.lastAppliedVersion, 14)
})

test('history resnapshot restores 10k missing siblings in bounded batches', async () => {
  const childUids = Array.from({ length: 10000 }, (_, i) => `restored${i}`)
  const { root, liveNodes } = makeTree([])
  const serverNodes = makeServerNodes(childUids)
  const calls = []
  const plugin = makePlugin({
    root,
    liveNodes,
    fetchNodes: nodeFetcher(serverNodes, calls)
  })

  await plugin.recoverHttpCollab(29)

  assert.equal(root.children.length, 10000)
  assert.equal(calls.length, 51)
  assert.deepEqual(calls.map(batch => batch.length), [1, ...new Array(50).fill(200)])
  assert.equal(root.children[9999].data.uid, 'restored9999')
  assert.equal(plugin.lastAppliedVersion, 29)
})

test('10k-node resnapshot uses one-time UID indexes instead of per-node tree walks', async () => {
  const childUids = Array.from({ length: 10000 }, (_, i) => `large${i}`)
  const { root, liveNodes } = makeTree(childUids)
  const serverNodes = makeServerNodes(childUids)
  const calls = []
  const plugin = makePlugin({
    root,
    liveNodes,
    fetchNodes: nodeFetcher(serverNodes, calls)
  })

  await plugin.recoverHttpCollab(30)

  assert.equal(calls.length, 51)
  assert.equal(plugin.appliedUids.length, 10001)
  assert.equal(plugin.rendererLookupCount, 0)
  assert.equal(plugin.treeLookupCount, 0)
  assert.equal(plugin.lastAppliedVersion, 30)
})

test('resnapshot UID index includes rendered generalization nodes', async () => {
  const { root, liveRoot, liveNodes } = makeTree(['a'])
  const generalization = {
    nodeData: { data: { uid: 'gen', text: 'local gen', childCount: 0 }, children: [] },
    children: [],
    getData(key) {
      return key ? this.nodeData.data[key] : this.nodeData.data
    }
  }
  liveRoot._generalizationList = [{ generalizationNode: generalization }]
  liveNodes.set('gen', generalization)
  const serverNodes = makeServerNodes(['a'], ['gen'])
  const calls = []
  const plugin = makePlugin({
    root,
    liveRoot,
    liveNodes,
    fetchNodes: nodeFetcher(serverNodes, calls)
  })
  plugin.dirtySubtrees.set('gen', 4)

  await plugin.recoverHttpCollab(4)

  assert.equal(generalization.nodeData.data.text, 'server gen')
  assert.ok(plugin.appliedUids.includes('gen'))
  assert.equal(plugin.rendererLookupCount, 0)
  assert.equal(plugin.lastAppliedVersion, 4)
})

test('dirty subtree hydration removes stale UIDs and indexes replacement children', async () => {
  const { root, liveNodes } = makeTree(['old'])
  const plugin = makePlugin({
    root,
    liveNodes,
    fetchNodes: async () => ({ nodes: [] })
  })
  const replacement = {
    data: { uid: 'new', text: 'new child' },
    children: [{ data: { uid: 'nested', text: 'nested child' }, children: [] }]
  }
  plugin.httpFetchSubtree = async () => ({})
  plugin.dirtySubtrees.set('root', 1)
  plugin.hydrateNodeData = async treeNode => {
    treeNode.children = [replacement]
  }
  plugin.syncHttpDirtySubtrees = methods.syncHttpDirtySubtrees
  const treeNodeIndex = methods.indexTreeNodesByUid(root)

  await plugin.syncHttpDirtySubtrees(treeNodeIndex)

  assert.equal(treeNodeIndex.has('old'), false)
  assert.equal(treeNodeIndex.get('new'), replacement)
  assert.equal(treeNodeIndex.get('nested'), replacement.children[0])
  assert.equal(plugin.treeLookupCount, 0)
})

test('history recovery waits for the render callback before acknowledging version', async () => {
  const { root, liveNodes } = makeTree(['a'])
  const serverNodes = makeServerNodes(['a'])
  const plugin = makePlugin({
    root,
    liveNodes,
    fetchNodes: nodeFetcher(serverNodes, [])
  })
  let finishRender
  let renderStarted
  const started = new Promise(resolve => { renderStarted = resolve })
  plugin.mindMap.render = callback => {
    plugin.renderCount = (plugin.renderCount || 0) + 1
    finishRender = callback
    renderStarted()
  }

  const recovery = plugin.recoverHttpCollab(18)
  await started
  assert.equal(plugin.lastAppliedVersion, 0)

  finishRender()
  await recovery
  assert.equal(plugin.lastAppliedVersion, 18)
})
