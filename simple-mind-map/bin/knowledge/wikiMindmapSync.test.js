const assert = require('node:assert/strict')
const test = require('node:test')
const {
  parseMarkdownToTree,
  encodeNodeId,
  decodeNodeId,
  mindmapSubtreeToTree,
  subtreeHash,
  contentHash,
  rootUidFromTopicKey,
  rewriteMarkdownWithMarkers,
  formatMarker
} = require('./wikiMindmapMarkdown')
const { diffTrees } = require('./wikiMindmapDiff')
const { toDocmostMarkdown } = require('./adapters/docmostAdapter')
const { createWikiMindmapSyncService } = require('./wikiMindmapSyncService')

test('encode/decode node id hex roundtrip', () => {
  const uid = 'root_abc'
  assert.equal(decodeNodeId(encodeNodeId(uid)), uid)
})

test('toDocmostMarkdown strips markers by default (standard)', () => {
  const md =
    '# Title\n\n' +
    formatMarker('n1', 'abcd') +
    '\n\n## Child\n\nbody\n'
  const out = toDocmostMarkdown(md)
  assert.ok(!out.includes('mindmap:node='))
  assert.ok(out.includes('## Child'))
})

test('toDocmostMarkdown preserveMindmapMarkers keeps human markers', () => {
  const md =
    '# Title\n\n' +
    formatMarker('n1', 'abcd') +
    '\n\n## Child\n\nbody\n'
  const out = toDocmostMarkdown(md, { preserveMindmapMarkers: true })
  assert.ok(out.includes('mindmap:node=' + encodeNodeId('n1')))
  assert.ok(out.includes('## Child'))
})

test('parseMarkdownToTree: headings become nodes; lists stay in content', () => {
  const md = `# 入职流程

入职流程说明。

## 入职资料

需要：

- 身份证
- 银行卡

## 入职审批

审批流程如下。
`
  const { root, errors } = parseMarkdownToTree(md)
  assert.equal(errors.length, 0)
  assert.equal(root.text, '入职流程')
  assert.match(root.content, /入职流程说明/)
  assert.equal(root.children.length, 2)
  assert.equal(root.children[0].text, '入职资料')
  assert.match(root.children[0].content, /- 身份证/)
  assert.equal(root.children[0].children.length, 0)
  assert.equal(root.children[1].text, '入职审批')
})

test('parseMarkdownToTree: markers bind before or after heading', () => {
  const before = `# Root

${formatMarker('nodeA', 'ff')}

## Child A

note
`
  const { root: r1 } = parseMarkdownToTree(before)
  assert.equal(r1.children[0].nodeId, 'nodeA')

  const after = `# Root

## Child A

note

${formatMarker('nodeA', 'ff')}
`
  const { root: r2 } = parseMarkdownToTree(after)
  assert.equal(r2.children[0].nodeId, 'nodeA')
})

test('parseMarkdownToTree: duplicate markers → DUPLICATE_NODE_ID', () => {
  const md = `# Root

${formatMarker('dup', 'aa')}

## A

${formatMarker('dup', 'bb')}

## B
`
  const { errors } = parseMarkdownToTree(md)
  assert.ok(errors.some(e => e.code === 'DUPLICATE_NODE_ID'))
})

test('diff: content change → UPDATE not delete+create', () => {
  const current = {
    uid: 'root',
    text: 'Root',
    note: 'old',
    children: [
      { uid: 'A', text: 'A', note: 'a1', children: [] },
      { uid: 'B', text: 'B', note: '', children: [] }
    ]
  }
  const desired = {
    text: 'Root',
    nodeId: 'root',
    content: 'old',
    children: [
      {
        text: 'A-renamed',
        nodeId: 'A',
        content: 'a2',
        children: []
      },
      { text: 'B', nodeId: 'B', content: '', children: [] }
    ]
  }
  const diff = diffTrees(desired, current, { branchRootUid: 'root' })
  assert.equal(diff.ok, true)
  assert.equal(diff.ops.create.length, 0)
  assert.equal(diff.ops.delete.length, 0)
  assert.equal(diff.ops.update.length, 1)
  assert.equal(diff.ops.update[0].nodeId, 'A')
  assert.equal(diff.ops.update[0].patch.text, 'A-renamed')
  assert.equal(diff.ops.update[0].patch.note, 'a2')
})

test('diff: new unmarked heading → CREATE when coverage complete', () => {
  const current = {
    uid: 'root',
    text: 'Root',
    note: '',
    children: [{ uid: 'A', text: 'A', note: '', children: [] }]
  }
  const desired = {
    text: 'Root',
    nodeId: 'root',
    content: '',
    children: [
      { text: 'A', nodeId: 'A', content: '', children: [] },
      { text: 'D', nodeId: null, content: 'new', children: [] }
    ]
  }
  const diff = diffTrees(desired, current, { branchRootUid: 'root' })
  assert.equal(diff.ok, true)
  assert.equal(diff.ops.create.length, 1)
  assert.equal(diff.ops.create[0].text, 'D')
  assert.equal(diff.ops.delete.length, 0)
})

test('diff: delete marked node when wiki drops it', () => {
  const current = {
    uid: 'root',
    text: 'Root',
    note: '',
    children: [
      { uid: 'A', text: 'A', note: '', children: [] },
      { uid: 'C', text: 'C', note: '', children: [] }
    ]
  }
  const desired = {
    text: 'Root',
    nodeId: 'root',
    content: '',
    children: [{ text: 'A', nodeId: 'A', content: '', children: [] }]
  }
  const diff = diffTrees(desired, current, { branchRootUid: 'root' })
  assert.equal(diff.ok, true)
  assert.equal(diff.ops.delete.length, 1)
  assert.equal(diff.ops.delete[0].nodeId, 'C')
})

test('diff: missing marker + missing mindmap node → UNMAPPED_NODE', () => {
  const current = {
    uid: 'root',
    text: 'Root',
    note: '',
    children: [
      { uid: 'A', text: 'A', note: '', children: [] },
      { uid: 'B', text: 'B', note: '', children: [] }
    ]
  }
  // Wiki dropped markers and only has titles — ambiguous
  const desired = {
    text: 'Root',
    nodeId: 'root',
    content: '',
    children: [
      { text: 'A', nodeId: null, content: '', children: [] },
      { text: 'B', nodeId: null, content: '', children: [] }
    ]
  }
  const diff = diffTrees(desired, current, { branchRootUid: 'root' })
  assert.equal(diff.ok, false)
  assert.equal(diff.error, 'UNMAPPED_NODE')
  assert.ok(diff.unmapped >= 1)
})

test('diff: duplicate handled upstream; unknown marker → VALIDATION_FAILED', () => {
  const current = {
    uid: 'root',
    text: 'Root',
    note: '',
    children: [{ uid: 'A', text: 'A', note: '', children: [] }]
  }
  const desired = {
    text: 'Root',
    nodeId: 'root',
    content: '',
    children: [
      { text: 'A', nodeId: 'A', content: '', children: [] },
      { text: 'Ghost', nodeId: 'ghost', content: '', children: [] }
    ]
  }
  const diff = diffTrees(desired, current, { branchRootUid: 'root' })
  assert.equal(diff.ok, false)
  assert.equal(diff.error, 'VALIDATION_FAILED')
})

test('rootUidFromTopicKey resolves branches path', () => {
  const obj = { root_abc: { isRoot: false, data: {}, children: [] } }
  assert.equal(
    rootUidFromTopicKey('branches/root_abc.md', obj),
    'root_abc'
  )
})

test('rewriteMarkdownWithMarkers writes stable ids', () => {
  const md = `# Root

## New

body
`
  const tree = {
    text: 'Root',
    nodeId: 'root',
    children: [{ text: 'New', nodeId: 'n1', content: 'body', children: [] }]
  }
  const out = rewriteMarkdownWithMarkers(md, tree)
  assert.ok(out.includes(formatMarker('root', '')))
  assert.ok(out.includes(formatMarker('n1', '')))
})

test('service rejects standard slot', async () => {
  const mappings = new Map([
    [
      'page_std',
      {
        room_id: 'room1',
        topic_key: 'branches/root_abc.md',
        slot: 'standard',
        owner: 'mindmap',
        docmost_page_id: 'page_std',
        content_hash: '',
        mindmap_hash: ''
      }
    ]
  ])
  const service = createWikiMindmapSyncService({
    pool: {
      query: async () => ({ rows: [] })
    },
    loadRoomNodes: async () => ({ nodes: {} }),
    executeCommand: async () => ({}),
    writeBackMarkers: false
  })
  // monkeypatch mapping lookup via ensureSchema/getMappingByPageId — replace store methods
  const store = require('./docmostMappingStore')
  const origEnsure = store.ensureSchema
  const origGet = store.getMappingByPageId
  store.ensureSchema = async () => {}
  store.getMappingByPageId = async (_db, id) => mappings.get(id) || null
  try {
    const result = await service.syncPageToMindmap({ pageId: 'page_std' })
    assert.equal(result.success, false)
    assert.equal(result.error, 'STANDARD_SLOT_READ_ONLY_FOR_WIKI_TO_MINDMAP')
  } finally {
    store.ensureSchema = origEnsure
    store.getMappingByPageId = origGet
  }
})

test('service: human update + create + idempotent second sync', async () => {
  const rootUid = 'root_abc'
  const nodes = {
    map_root: {
      isRoot: true,
      data: { uid: 'map_root', text: 'Map' },
      children: [rootUid]
    },
    [rootUid]: {
      isRoot: false,
      data: { uid: rootUid, text: '入职流程', note: '说明' },
      children: ['A']
    },
    A: {
      isRoot: false,
      data: { uid: 'A', text: '入职资料', note: '旧正文' },
      children: []
    }
  }
  const mapping = {
    room_id: 'room1',
    topic_key: 'branches/root_abc.md',
    slot: 'human',
    owner: 'human',
    docmost_page_id: 'page_h',
    content_hash: '',
    mindmap_hash: '',
    title: '入职'
  }
  let wikiMd =
    `# 入职流程\n\n说明\n\n` +
    `${formatMarker('A', 'x')}\n\n## 入职资料\n\n新正文\n\n## 入职审批\n\n审批\n`
  const commands = []
  let uidSeq = 0

  const store = require('./docmostMappingStore')
  const origEnsure = store.ensureSchema
  const origGet = store.getMappingByPageId
  const origRecord = store.recordWikiMindmapSyncState
  store.ensureSchema = async () => {}
  store.getMappingByPageId = async () => mapping
  store.recordWikiMindmapSyncState = async (_db, row) => {
    mapping.content_hash = row.wikiContentHash
    mapping.mindmap_hash = row.mindmapHash
    mapping.last_sync_source = row.lastSyncSource
    return mapping
  }

  const client = require('./adapters/docmostClient')
  const origAuth = client.ensureSyncAuth
  const origReq = client.request
  client.ensureSyncAuth = async () => ({ cookie: 'c', workspaceId: 'w' })
  client.request = async (path, { body }) => {
    if (path === '/api/pages/info') {
      return { id: body.pageId, title: '入职', content: wikiMd }
    }
    if (path === '/api/pages/update') {
      wikiMd = body.content
      return {}
    }
    throw new Error('unexpected ' + path)
  }

  const service = createWikiMindmapSyncService({
    pool: { query: async () => ({ rows: [] }) },
    writeBackMarkers: true,
    loadRoomNodes: async () => ({ nodes }),
    executeCommand: async (_room, command) => {
      commands.push(command)
      if (command.type === 'node.insert') {
        uidSeq += 1
        const uid = 'new_' + uidSeq
        const parent = command.payload.parentUid
        nodes[uid] = {
          isRoot: false,
          data: {
            uid,
            text: command.payload.text,
            note: command.payload.note || ''
          },
          children: []
        }
        nodes[parent].children.push(uid)
        return { result: { uid }, event: { payload: { uid } } }
      }
      if (command.type === 'node.update') {
        const uid = command.payload.uid
        const patch = command.payload.patch || {}
        if (patch.text !== undefined) nodes[uid].data.text = patch.text
        if (patch.note !== undefined) nodes[uid].data.note = patch.note
        return { result: { uid } }
      }
      if (command.type === 'node.delete') {
        const uid = command.payload.uid
        delete nodes[uid]
        Object.values(nodes).forEach(n => {
          n.children = (n.children || []).filter(c => c !== uid)
        })
        return { result: { uid } }
      }
      return {}
    }
  })

  try {
    const r1 = await service.syncPageToMindmap({ pageId: 'page_h' })
    assert.equal(r1.success, true)
    assert.equal(r1.slot, 'human')
    assert.equal(r1.updated, 1)
    assert.equal(r1.created, 1)
    assert.equal(nodes.A.data.note, '新正文')
    assert.ok(commands.some(c => c.type === 'node.insert'))
    assert.ok(commands.some(c => c.type === 'node.update'))
    assert.ok(wikiMd.includes('mindmap:node='))

    commands.length = 0
    const r2 = await service.syncPageToMindmap({ pageId: 'page_h' })
    assert.equal(r2.success, true)
    assert.equal(r2.created, 0)
    assert.equal(r2.updated, 0)
    assert.equal(r2.deleted, 0)
    assert.equal(r2.skipped, 1)
    assert.equal(commands.length, 0)
  } finally {
    store.ensureSchema = origEnsure
    store.getMappingByPageId = origGet
    store.recordWikiMindmapSyncState = origRecord
    client.ensureSyncAuth = origAuth
    client.request = origReq
  }
})

test('service: SYNC_CONFLICT when both sides changed', async () => {
  const rootUid = 'root_abc'
  const nodes = {
    [rootUid]: {
      isRoot: false,
      data: { uid: rootUid, text: 'Root', note: 'mind-new' },
      children: []
    }
  }
  const mapping = {
    room_id: 'room1',
    topic_key: 'branches/root_abc.md',
    slot: 'human',
    owner: 'human',
    docmost_page_id: 'page_h',
    content_hash: contentHash('# Root\n\nold wiki\n'),
    mindmap_hash: contentHash('previous-mind'),
    title: 't'
  }
  // wiki changed vs last; mindmap hash also differs from last
  const wikiMd = '# Root\n\nwiki-new\n'

  const store = require('./docmostMappingStore')
  const origEnsure = store.ensureSchema
  const origGet = store.getMappingByPageId
  store.ensureSchema = async () => {}
  store.getMappingByPageId = async () => mapping

  const client = require('./adapters/docmostClient')
  const origAuth = client.ensureSyncAuth
  const origReq = client.request
  client.ensureSyncAuth = async () => ({ cookie: 'c' })
  client.request = async () => ({ id: 'page_h', title: 't', content: wikiMd })

  const service = createWikiMindmapSyncService({
    pool: { query: async () => ({ rows: [] }) },
    loadRoomNodes: async () => ({ nodes }),
    executeCommand: async () => {
      throw new Error('should not execute')
    },
    writeBackMarkers: false
  })

  try {
    const r = await service.syncPageToMindmap({ pageId: 'page_h' })
    assert.equal(r.success, false)
    assert.equal(r.error, 'SYNC_CONFLICT')
    assert.ok(Array.isArray(r.conflicts))
  } finally {
    store.ensureSchema = origEnsure
    store.getMappingByPageId = origGet
    client.ensureSyncAuth = origAuth
    client.request = origReq
  }
})

test('anti-loop: human last_sync_source=wiki does not imply replace_tree', () => {
  // Documented contract: reverse sync uses Diff ops only; standard assertReplaceAllowed intact
  const store = require('./docmostMappingStore')
  const human = {
    slot: 'human',
    owner: 'human',
    topic_key: 'branches/x.md',
    docmost_page_id: 'p1'
  }
  assert.equal(
    store.assertReplaceAllowed(human, { topicKey: 'branches/x.md' }).ok,
    false
  )
  const std = {
    slot: 'standard',
    owner: 'mindmap',
    topic_key: 'branches/x.md',
    docmost_page_id: 'p2'
  }
  assert.equal(
    store.assertReplaceAllowed(std, {
      topicKey: 'branches/x.md',
      expectedPageId: 'p2'
    }).ok,
    true
  )
})
