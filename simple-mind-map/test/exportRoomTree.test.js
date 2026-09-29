const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  INLINE_NODE_LIMIT,
  buildRoomExport,
  deliverRoomExport,
  readExportPage
} = require('../bin/exportRoomTree')

function node(text, children, extra) {
  return {
    isRoot: false,
    data: { text, ...(extra || {}) },
    children: children || []
  }
}

function tree(spec) {
  const graph = {}
  Object.keys(spec).forEach(uid => {
    graph[uid] = spec[uid]
    graph[uid].data = { uid, ...(spec[uid].data || {}) }
  })
  return graph
}

function wide(count) {
  const children = []
  const graph = {
    root: {
      isRoot: true,
      data: { uid: 'root', text: '根', note: '根备注' },
      children
    }
  }
  for (let i = 1; i < count; i++) {
    const uid = 'n' + i
    children.push(uid)
    graph[uid] = {
      data: {
        uid,
        text: '节点' + i,
        note: i % 10 === 0 ? '备注' + i : '',
        type: i % 50 === 0 ? 'task' : undefined
      },
      children: []
    }
  }
  return graph
}

function chain(depth) {
  const graph = {}
  for (let i = 0; i <= depth; i++) {
    const uid = 'd' + i
    graph[uid] = {
      isRoot: i === 0,
      data: { uid, text: 'L' + i, note: i === depth ? '深层备注' : '' },
      children: i === depth ? [] : ['d' + (i + 1)]
    }
  }
  return graph
}

function testSmallRoom() {
  const nodes = tree({
    root: {
      isRoot: true,
      data: { text: '根' },
      children: ['a', 'b']
    },
    a: node('甲', ['a1', 'a2', 'a3']),
    b: node('乙', ['b1']),
    a1: node('甲一', ['a1a']),
    a2: node('甲二'),
    a3: node('甲三'),
    b1: node('乙一', ['b1a', 'b1b']),
    a1a: node('甲一甲'),
    b1a: node('乙一甲'),
    b1b: node('乙一乙')
  })
  assert.strictEqual(Object.keys(nodes).length, 10)
  const doc = buildRoomExport({
    roomKey: 'small',
    title: '小图',
    revision: 3,
    nodes
  })
  assert.strictEqual(doc.summary.complete, true)
  assert.strictEqual(doc.summary.expected_node_count, 10)
  assert.strictEqual(doc.summary.exported_node_count, 10)
  assert.strictEqual(doc.incomplete_reason, undefined)
  assert.strictEqual(doc.traversal.has_more, false)
  assert.strictEqual(doc.traversal.pending_cursor, false)
  assert.strictEqual(new Set(doc.nodes.map(item => item.uid)).size, 10)
  assert.strictEqual(doc.room.revision, 3)
  assert.strictEqual(doc.nodes[0].id, 'root')
  assert.strictEqual(doc.nodes[0].parent_id, null)
  assert.strictEqual(doc.nodes[0].depth, 0)
  const delivered = deliverRoomExport({
    roomKey: 'small',
    title: '小图',
    revision: 3,
    nodes
  })
  assert.strictEqual(delivered.delivery, 'inline')
  assert.ok(Array.isArray(delivered.nodes))
  assert.strictEqual(delivered.export_path, undefined)
}

function testLargeRoom() {
  const count = 2000
  const nodes = wide(count)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-export-'))
  try {
    const doc = buildRoomExport({ roomKey: 'large', title: '大图', revision: 9, nodes })
    assert.strictEqual(doc.summary.complete, true)
    assert.strictEqual(doc.summary.exported_node_count, count)
    assert.strictEqual(doc.summary.expected_node_count, count)
    const ids = doc.nodes.map(item => item.uid)
    assert.strictEqual(ids.length, count)
    assert.strictEqual(new Set(ids).size, count)
    assert.strictEqual(doc.summary.edge_count, count - 1)
    const typed = doc.nodes.filter(item => item.type === 'task')
    assert.ok(typed.length > 0)

    const delivered = deliverRoomExport(
      { roomKey: 'large', title: '大图', revision: 9, nodes },
      { exportDir: dir }
    )
    assert.strictEqual(delivered.delivery, 'file')
    assert.strictEqual(delivered.nodes, undefined)
    assert.strictEqual(delivered.complete, true)
    assert.strictEqual(delivered.exported_node_count, count)
    assert.ok(String(delivered.export_path).includes('large--r9.json'))
    const saved = JSON.parse(fs.readFileSync(delivered.export_absolute_path, 'utf8'))
    assert.strictEqual(saved.summary.complete, true)
    assert.strictEqual(saved.nodes.length, count)
    assert.strictEqual(new Set(saved.nodes.map(item => item.uid)).size, count)

    const seen = new Set()
    let offset = 0
    let pages = 0
    while (true) {
      const page = readExportPage({
        roomKey: 'large',
        revision: 9,
        offset,
        limit: 250,
        exportDir: dir
      })
      pages += 1
      page.nodes.forEach(item => {
        assert.ok(!seen.has(item.uid))
        seen.add(item.uid)
      })
      if (!page.has_more) break
      assert.strictEqual(page.next_offset, offset + page.nodes.length)
      offset = page.next_offset
    }
    assert.strictEqual(seen.size, count)
    assert.ok(pages > 1)

    const border = wide(INLINE_NODE_LIMIT)
    const inline = deliverRoomExport({
      roomKey: 'border',
      revision: 1,
      nodes: border
    })
    assert.strictEqual(inline.delivery, 'inline')
    const over = deliverRoomExport(
      { roomKey: 'over', revision: 2, nodes: wide(INLINE_NODE_LIMIT + 1) },
      { exportDir: dir }
    )
    assert.strictEqual(over.delivery, 'file')
    assert.strictEqual(over.nodes, undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function testDeepRoom() {
  const depth = 12
  const doc = buildRoomExport({
    roomKey: 'deep',
    title: '深图',
    revision: 1,
    nodes: chain(depth)
  })
  assert.ok(doc.summary.max_depth > 10)
  assert.strictEqual(doc.summary.max_depth, depth)
  assert.strictEqual(doc.summary.complete, true)
  assert.strictEqual(doc.summary.exported_node_count, depth + 1)
  const leaf = doc.nodes.find(item => item.uid === 'd' + depth)
  assert.strictEqual(leaf.depth, depth)
  assert.strictEqual(leaf.note, '深层备注')
  assert.strictEqual(leaf.parent_id, 'd' + (depth - 1))
}

function testCycle() {
  const nodes = tree({
    root: { isRoot: true, data: { text: '根' }, children: ['a', 'c'] },
    a: node('A', ['b']),
    b: node('B', ['a', 'b']),
    c: node('C', [])
  })
  const started = Date.now()
  const doc = buildRoomExport({ roomKey: 'cycle', revision: 1, nodes })
  assert.ok(Date.now() - started < 1000)
  const ids = doc.nodes.map(item => item.uid)
  assert.strictEqual(ids.length, new Set(ids).size)
  assert.strictEqual(doc.summary.exported_node_count, 4)
  assert.strictEqual(doc.summary.complete, true)
  assert.strictEqual(doc.traversal.has_more, false)
}

function testCountMismatch() {
  const orphan = tree({
    root: { isRoot: true, data: { text: '根' }, children: ['a'] },
    a: node('A'),
    orphan: node('游离')
  })
  const mismatched = buildRoomExport({ roomKey: 'mismatch', revision: 1, nodes: orphan })
  assert.strictEqual(mismatched.summary.complete, false)
  assert.strictEqual(mismatched.summary.expected_node_count, 3)
  assert.strictEqual(mismatched.summary.exported_node_count, 2)
  assert.strictEqual(mismatched.incomplete_reason, 'count_mismatch')

  const declared = buildRoomExport({
    roomKey: 'declared',
    revision: 4,
    expectedNodeCount: 10,
    nodes: tree({
      root: { isRoot: true, data: { text: '根' }, children: ['a'] },
      a: node('A')
    })
  })
  assert.strictEqual(declared.summary.complete, false)
  assert.strictEqual(declared.summary.expected_node_count, 10)
  assert.strictEqual(declared.summary.exported_node_count, 2)
  assert.strictEqual(declared.incomplete_reason, 'count_mismatch')

  const ghost = buildRoomExport({
    roomKey: 'ghost',
    revision: 1,
    nodes: tree({
      root: { isRoot: true, data: { text: '根' }, children: ['a', 'missing'] },
      a: node('A')
    })
  })
  assert.strictEqual(ghost.summary.complete, false)
  assert.strictEqual(ghost.incomplete_reason, 'unvisited_children')
  assert.ok(ghost.summary.unvisited_children.includes('missing'))
}

function testNotesAndReferences() {
  const nodes = tree({
    root: {
      isRoot: true,
      data: { text: '根', note: '' },
      children: ['linked', 'plain']
    },
    linked: node('有引用', [], {
      note: '<p>这是备注</p>',
      hyperlink: 'https://example.com/spec',
      hyperlinkTitle: '规格',
      mapRef: { mapId: 'other-room', nodeId: 'n9' },
      associativeLineTargets: ['plain'],
      tag: ['重要']
    }),
    plain: node('普通', [], { note: '   ' })
  })
  const doc = buildRoomExport({
    roomKey: 'refs',
    title: '引用',
    revision: 2,
    nodes,
    includeNotes: true,
    includeReferences: true
  })
  assert.strictEqual(doc.summary.complete, true)
  assert.strictEqual(doc.summary.note_count, 1)
  assert.strictEqual(doc.summary.reference_count, 3)
  const linked = doc.nodes.find(item => item.uid === 'linked')
  assert.strictEqual(linked.note, '<p>这是备注</p>')
  assert.strictEqual(linked.hyperlink, 'https://example.com/spec')
  assert.strictEqual(linked.hyperlink_title, '规格')
  assert.deepStrictEqual(linked.metadata.tag, ['重要'])
  assert.strictEqual(linked.metadata.note, undefined)
  const kinds = doc.references.map(item => item.kind).sort()
  assert.deepStrictEqual(kinds, ['associative', 'hyperlink', 'map_ref'])
  const mapRef = doc.references.find(item => item.kind === 'map_ref')
  assert.strictEqual(mapRef.target_room_key, 'other-room')
  assert.strictEqual(mapRef.target_id, 'n9')
  assert.strictEqual(mapRef.source_id, 'linked')

  const hidden = buildRoomExport({
    roomKey: 'refs',
    revision: 2,
    nodes,
    includeNotes: false,
    include_references: false
  })
  assert.strictEqual(hidden.summary.note_count, 0)
  assert.strictEqual(hidden.summary.reference_count, 0)
  assert.strictEqual(hidden.references.length, 0)
  const hiddenNode = hidden.nodes.find(item => item.uid === 'linked')
  assert.strictEqual(hiddenNode.note, null)
  assert.strictEqual(hiddenNode.hyperlink, undefined)
  assert.strictEqual(hiddenNode.metadata.mapRef, undefined)
  assert.strictEqual(hiddenNode.metadata.hyperlink, undefined)
}

function testStableRepeat() {
  const nodes = chain(6)
  nodes.d2.data.hyperlink = 'https://example.com'
  nodes.d2.data.note = '稳定'
  nodes.d3.data.mapRef = { room_key: 'room-b', nodeId: 'x' }
  const input = { roomKey: 'stable', title: '稳定', revision: 8, nodes }
  const first = buildRoomExport(input)
  const second = buildRoomExport(input)
  assert.strictEqual(JSON.stringify(first), JSON.stringify(second))
  assert.strictEqual(first.summary.complete, true)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-export-stable-'))
  try {
    const fileA = deliverRoomExport(wideInput(nodes), { exportDir: dir, forceFile: true })
    const fileB = deliverRoomExport(wideInput(nodes), { exportDir: dir, forceFile: true })
    assert.strictEqual(fileA.export_absolute_path, fileB.export_absolute_path)
    const bytesA = fs.readFileSync(fileA.export_absolute_path)
    const bytesB = fs.readFileSync(fileB.export_absolute_path)
    assert.ok(bytesA.equals(bytesB))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function wideInput(nodes) {
  return { roomKey: 'stable', title: '稳定', revision: 8, nodes }
}

function testCursorFallback() {
  const doc = buildRoomExport(
    { roomKey: 'cursor', title: '游标', revision: 1, nodes: wide(10) },
    { pageSize: 2, failCursorAt: 1 }
  )
  assert.strictEqual(doc.traversal.cursor_fallback, true)
  assert.strictEqual(doc.summary.complete, true)
  assert.strictEqual(doc.summary.exported_node_count, 10)
  assert.strictEqual(doc.summary.expected_node_count, 10)
  assert.strictEqual(doc.traversal.has_more, false)
  assert.strictEqual(doc.traversal.pending_cursor, false)
  assert.strictEqual(new Set(doc.nodes.map(item => item.uid)).size, 10)

  const broken = buildRoomExport(
    { roomKey: 'cursor', revision: 1, nodes: wide(8) },
    {
      pageSize: 3,
      decodeCursor() {
        const err = new Error('bad cursor')
        err.code = 'CURSOR_ERROR'
        throw err
      }
    }
  )
  assert.strictEqual(broken.traversal.cursor_fallback, true)
  assert.strictEqual(broken.summary.complete, true)
  assert.strictEqual(broken.summary.exported_node_count, 8)
}

function testNdjson() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-export-ndjson-'))
  try {
    const delivered = deliverRoomExport(
      {
        roomKey: 'lines',
        revision: 5,
        format: 'ndjson',
        nodes: chain(4)
      },
      { exportDir: dir, forceFile: true }
    )
    assert.ok(String(delivered.export_absolute_path).endsWith('.ndjson'))
    const page = readExportPage({
      roomKey: 'lines',
      revision: 5,
      format: 'ndjson',
      offset: 1,
      limit: 2,
      exportDir: dir
    })
    assert.strictEqual(page.nodes.length, 2)
    assert.strictEqual(page.complete, true)
    assert.strictEqual(page.has_more, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

testSmallRoom()
testLargeRoom()
testDeepRoom()
testCycle()
testCountMismatch()
testNotesAndReferences()
testStableRepeat()
testCursorFallback()
testNdjson()
console.log('exportRoomTree tests passed')
