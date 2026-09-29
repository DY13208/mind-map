const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { findRootUid, stripHtml } = require('./mindDoc')
const { normalizeMapRef } = require('../src/utils/mapRef')

// Whole-room export reads the authoritative snapshot once (room_nodes, or
// rooms.nodes when the node table is not initialized). It does not call
// query_nodes. Pagination cursors are consumed inside this process; a bad
// cursor restarts from the parent/children adjacency instead of asking the
// MCP client to continue.

const INLINE_NODE_LIMIT = 500
const PAGE_SIZE = 500
const REFERENCE_KEYS = [
  'hyperlink',
  'hyperlinkTitle',
  'mapRef',
  'associativeLineTargets',
  'associativeLineTargetControlOffsets',
  'associativeLinePoint',
  'associativeLineText',
  'associativeLineStyle'
]

function exportError(message, code) {
  const err = new Error(message)
  err.code = code
  return err
}

function defaultExportDir() {
  if (process.env.MINDMAP_EXPORT_DIR) {
    return path.resolve(process.env.MINDMAP_EXPORT_DIR)
  }
  return path.resolve(__dirname, '..', '..', '.tmp', 'mindmap-exports')
}

function encodeCursor(state) {
  return Buffer.from(
    JSON.stringify({ v: 1, n: state.visitedCount, queue: state.queue }),
    'utf8'
  ).toString('base64url')
}

function decodeCursor(value) {
  try {
    const parsed = JSON.parse(
      Buffer.from(String(value), 'base64url').toString('utf8')
    )
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.queue)) {
      throw new Error('invalid')
    }
    if (!Number.isInteger(parsed.n) || parsed.n < 0) throw new Error('invalid')
    return parsed
  } catch (err) {
    throw exportError('分页游标无效', 'CURSOR_ERROR')
  }
}

function childIdsOf(node) {
  if (!node || !Array.isArray(node.children)) return []
  return node.children.map(id => String(id))
}

function findExportRoot(graph) {
  const marked = findRootUid(graph)
  if (marked && graph[marked] && graph[marked].isRoot) return marked
  const uids = Object.keys(graph)
  if (!uids.length) return null
  const seenAsChild = new Set()
  uids.forEach(uid => {
    childIdsOf(graph[uid]).forEach(id => seenAsChild.add(id))
  })
  return uids.find(uid => !seenAsChild.has(uid)) || marked || null
}

function pushEdge(edges, seen, parentId, childId) {
  const key = parentId + '\0' + childId
  if (seen.has(key)) return
  seen.add(key)
  edges.push({ parent_id: parentId, child_id: childId })
}

function enqueueChild(queue, scheduled, visited, cycles, childId, depth, parentId) {
  if (scheduled.has(childId)) {
    if (visited.has(childId)) cycles.push(childId)
    return
  }
  scheduled.add(childId)
  queue.push({ uid: childId, depth, parentId })
}

function walkFromAdjacency(graph, childrenOf) {
  const rootUid = findExportRoot(graph)
  const visited = new Set()
  const missingChildren = []
  const cycles = []
  const order = []
  const edges = []
  const edgeSeen = new Set()
  const scheduled = new Set()
  const queue = []
  if (rootUid) {
    scheduled.add(String(rootUid))
    queue.push({ uid: String(rootUid), depth: 0, parentId: null })
  }
  const hardCap = Object.keys(graph).length * 2 + 8
  let steps = 0
  while (queue.length) {
    steps += 1
    if (steps > hardCap) {
      return {
        order,
        edges,
        visited,
        missingChildren,
        cycles,
        hasMore: true,
        pendingCursor: true
      }
    }
    const item = queue.shift()
    const uid = String(item.uid)
    if (visited.has(uid)) {
      cycles.push(uid)
      continue
    }
    if (!graph[uid]) {
      missingChildren.push(uid)
      continue
    }
    visited.add(uid)
    order.push({ uid, depth: item.depth, parentId: item.parentId })
    const kids = childrenOf.get(uid) || childIdsOf(graph[uid])
    kids.forEach(childId => {
      pushEdge(edges, edgeSeen, uid, childId)
      enqueueChild(queue, scheduled, visited, cycles, childId, item.depth + 1, uid)
    })
  }
  return {
    order,
    edges,
    visited,
    missingChildren,
    cycles,
    hasMore: false,
    pendingCursor: false
  }
}

function walkPaged(graph, options) {
  const rootUid = findExportRoot(graph)
  const visited = new Set()
  const missingChildren = []
  const cycles = []
  const order = []
  const edges = []
  const edgeSeen = new Set()
  const scheduled = new Set()
  let queue = []
  if (rootUid) {
    scheduled.add(String(rootUid))
    queue.push({ uid: String(rootUid), depth: 0, parentId: null })
  }
  const pageSize = Math.max(1, Number(options.pageSize) || PAGE_SIZE)
  const nodeCount = Object.keys(graph).length
  const maxPages = nodeCount + 3
  let pages = 0
  const decode = options.decodeCursor || decodeCursor

  while (queue.length) {
    pages += 1
    if (pages > maxPages) {
      return {
        order,
        edges,
        visited,
        missingChildren,
        cycles,
        hasMore: true,
        pendingCursor: true,
        pages
      }
    }
    let filled = 0
    while (filled < pageSize && queue.length) {
      const item = queue.shift()
      const uid = String(item.uid)
      if (visited.has(uid)) {
        cycles.push(uid)
        continue
      }
      if (!graph[uid]) {
        missingChildren.push(uid)
        continue
      }
      visited.add(uid)
      order.push({ uid, depth: item.depth, parentId: item.parentId })
      filled += 1
      childIdsOf(graph[uid]).forEach(childId => {
        pushEdge(edges, edgeSeen, uid, childId)
        enqueueChild(
          queue,
          scheduled,
          visited,
          cycles,
          childId,
          item.depth + 1,
          uid
        )
      })
    }
    if (!queue.length) break
    if (
      options.failCursorAt != null &&
      pages === Number(options.failCursorAt)
    ) {
      throw exportError('分页游标失败', 'CURSOR_ERROR')
    }
    const encoded = encodeCursor({ v: 1, visitedCount: visited.size, queue })
    const decoded = decode(encoded)
    if (
      !decoded ||
      decoded.v !== 1 ||
      !Array.isArray(decoded.queue) ||
      decoded.n !== visited.size
    ) {
      throw exportError('分页游标无效', 'CURSOR_ERROR')
    }
    decoded.queue.forEach(item => {
      if (item && item.uid) scheduled.add(String(item.uid))
    })
    queue = decoded.queue
  }

  return {
    order,
    edges,
    visited,
    missingChildren,
    cycles,
    hasMore: false,
    pendingCursor: false,
    pages
  }
}

function parentChildrenAdjacency(graph) {
  const childrenOf = new Map()
  Object.keys(graph).forEach(uid => childrenOf.set(uid, []))
  Object.keys(graph).forEach(uid => {
    const node = graph[uid] || {}
    childIdsOf(node).forEach(childId => {
      if (!childrenOf.has(uid)) childrenOf.set(uid, [])
      if (!childrenOf.has(childId)) childrenOf.set(childId, [])
      childrenOf.get(uid).push(childId)
    })
    const data = node.data && typeof node.data === 'object' ? node.data : {}
    const parent = node.parent_uid || node.parent_id || data.parent_uid || data.parent_id
    if (!parent) return
    const parentId = String(parent)
    if (!childrenOf.has(parentId)) childrenOf.set(parentId, [])
    const list = childrenOf.get(parentId)
    if (!list.includes(uid)) list.push(uid)
  })
  return childrenOf
}

function walkParentChildren(graph) {
  return walkFromAdjacency(graph, parentChildrenAdjacency(graph))
}

function unvisitedKnownChildren(graph, visited) {
  const missing = []
  const seen = new Set()
  Object.keys(graph).forEach(uid => {
    if (!visited.has(uid)) return
    childIdsOf(graph[uid]).forEach(childId => {
      if (visited.has(childId) || seen.has(childId)) return
      seen.add(childId)
      missing.push(childId)
    })
  })
  return missing
}

function traversalOf(graph, options) {
  try {
    const walked = walkPaged(graph, options)
    walked.cursorFallback = false
    return walked
  } catch (err) {
    if (!err || err.code !== 'CURSOR_ERROR') throw err
    const walked = walkParentChildren(graph)
    walked.cursorFallback = true
    walked.cursorRecovered = !walked.hasMore && !walked.pendingCursor
    return walked
  }
}

function metadataFrom(data, options) {
  const skip = new Set(['uid', 'text', 'imgMap'])
  skip.add('note')
  if (options.includeReferences) {
    skip.add('hyperlink')
    skip.add('hyperlinkTitle')
  } else {
    REFERENCE_KEYS.forEach(key => skip.add(key))
  }
  const meta = {}
  Object.keys(data)
    .filter(key => !skip.has(key) && !String(key).startsWith('__'))
    .sort()
    .forEach(key => {
      meta[key] = data[key]
    })
  return meta
}

function referencesFrom(uid, data) {
  const refs = []
  if (data.hyperlink) {
    refs.push({
      kind: 'hyperlink',
      source_id: uid,
      target_id: null,
      target_room_key: null,
      url: String(data.hyperlink),
      title: data.hyperlinkTitle ? String(data.hyperlinkTitle) : ''
    })
  }
  const mapRef = normalizeMapRef(data.mapRef)
  if (mapRef) {
    refs.push({
      kind: 'map_ref',
      source_id: uid,
      target_id: mapRef.nodeId,
      target_room_key: mapRef.mapId,
      url: null,
      title: ''
    })
  }
  if (Array.isArray(data.associativeLineTargets)) {
    data.associativeLineTargets.forEach(target => {
      const targetId =
        typeof target === 'string'
          ? target
          : target && (target.uid || target.nodeId || target.id)
      if (!targetId) return
      refs.push({
        kind: 'associative',
        source_id: uid,
        target_id: String(targetId),
        target_room_key: null,
        url: null,
        title: ''
      })
    })
  }
  return refs
}

function projectNode(graph, item, roomKey, options) {
  const raw = graph[item.uid] || {}
  const data = raw.data && typeof raw.data === 'object' ? raw.data : {}
  const text = stripHtml(data.text)
  const node = {
    id: item.uid,
    uid: item.uid,
    text,
    title: text,
    parent_id: item.parentId,
    depth: item.depth,
    note: options.includeNotes ? (data.note == null ? '' : String(data.note)) : null,
    metadata: metadataFrom(data, options),
    room_key: roomKey
  }
  const type = data.type || data.nodeType
  if (type) node.type = String(type)
  if (options.includeReferences && data.hyperlink) {
    node.hyperlink = String(data.hyperlink)
    if (data.hyperlinkTitle) node.hyperlink_title = String(data.hyperlinkTitle)
  }
  return node
}

function roomTitle(input, graph) {
  if (input.title) {
    const plain = stripHtml(input.title)
    return plain || String(input.title)
  }
  const rootUid = findExportRoot(graph)
  const data =
    rootUid && graph[rootUid] && graph[rootUid].data ? graph[rootUid].data : {}
  return stripHtml(data.text) || '未命名'
}

function revisionOf(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 0) return null
  return n
}

function expectedCountOf(input, graphCount) {
  if (input.expectedNodeCount == null) return graphCount
  const n = Number(input.expectedNodeCount)
  if (!Number.isSafeInteger(n) || n < 0) return null
  return n
}

function buildRoomExport(input = {}, options = {}) {
  const graph =
    input.nodes && typeof input.nodes === 'object' && !Array.isArray(input.nodes)
      ? input.nodes
      : {}
  const roomKey = String(input.roomKey || input.room_key || '')
  const includeNotes = input.includeNotes !== false && input.include_notes !== false
  const includeReferences =
    input.includeReferences !== false && input.include_references !== false
  const flags = { includeNotes, includeReferences }
  const graphCount = Object.keys(graph).length
  const expected = expectedCountOf(input, graphCount)
  let walked
  try {
    walked = traversalOf(graph, options)
  } catch (err) {
    return incompleteDocument(input, graph, {
      reason: err && err.code === 'CURSOR_ERROR' ? 'cursor_error' : 'backend_error',
      expected,
      error: err && err.message
    })
  }

  const nodes = walked.order.map(item => projectNode(graph, item, roomKey, flags))
  const references = []
  if (includeReferences) {
    walked.order.forEach(item => {
      const data =
        graph[item.uid] && graph[item.uid].data ? graph[item.uid].data : {}
      references.push(...referencesFrom(item.uid, data))
    })
  }
  const knownMissing = unvisitedKnownChildren(graph, walked.visited)
  const missing = Array.from(new Set([...(walked.missingChildren || []), ...knownMissing]))
  const exported = nodes.length
  const maxDepth = nodes.reduce((max, node) => Math.max(max, node.depth), 0)
  const noteCount = includeNotes
    ? nodes.filter(node => String(node.note || '').trim()).length
    : 0

  let reason = null
  if (walked.hasMore || walked.pendingCursor || walked.cursorRecovered === false) {
    reason = 'cursor_error'
  } else if (missing.length) {
    reason = 'unvisited_children'
  } else if (expected == null) {
    reason = 'backend_error'
  } else if (expected !== exported) {
    reason = 'count_mismatch'
  }
  const complete = reason == null

  const doc = {
    room: {
      room_key: roomKey,
      title: roomTitle(input, graph),
      revision: revisionOf(input.revision != null ? input.revision : input.version)
    },
    summary: {
      expected_node_count: expected,
      exported_node_count: exported,
      edge_count: walked.edges.length,
      note_count: noteCount,
      reference_count: references.length,
      max_depth: maxDepth,
      complete
    },
    nodes,
    edges: walked.edges,
    references,
    read_path: 'snapshot',
    tree_source: input.treeSource || input.tree_source || 'snapshot',
    traversal: {
      cursor_fallback: !!walked.cursorFallback,
      has_more: !!walked.hasMore,
      pending_cursor: !!walked.pendingCursor
    }
  }
  if (!complete) {
    doc.incomplete_reason = reason
    doc.summary.incomplete_reason = reason
    if (missing.length) doc.summary.unvisited_children = missing.slice(0, 20)
  }
  return doc
}

function incompleteDocument(input, graph, detail) {
  return {
    room: {
      room_key: String(input.roomKey || input.room_key || ''),
      title: roomTitle(input, graph || {}),
      revision: revisionOf(input.revision)
    },
    summary: {
      expected_node_count: detail.expected == null ? null : detail.expected,
      exported_node_count: 0,
      edge_count: 0,
      note_count: 0,
      reference_count: 0,
      max_depth: 0,
      complete: false,
      incomplete_reason: detail.reason
    },
    nodes: [],
    edges: [],
    references: [],
    incomplete_reason: detail.reason,
    read_path: 'snapshot',
    tree_source: input.treeSource || 'snapshot',
    traversal: {
      cursor_fallback: false,
      has_more: detail.reason === 'cursor_error',
      pending_cursor: detail.reason === 'cursor_error'
    }
  }
}

function safeFilePart(roomKey) {
  const raw = String(roomKey || 'room')
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 80)
  if (cleaned === raw && cleaned) return cleaned
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8)
  return `${cleaned || 'room'}-${hash}`
}

function exportFileName(roomKey, revision, format) {
  const rev = revision == null ? 'norev' : String(revision)
  const ext = format === 'ndjson' ? 'ndjson' : 'json'
  return `${safeFilePart(roomKey)}--r${rev}.${ext}`
}

function serializeExport(doc, format) {
  if (format !== 'ndjson') return JSON.stringify(doc)
  const lines = [
    JSON.stringify({
      type: 'meta',
      room: doc.room,
      summary: doc.summary,
      read_path: doc.read_path,
      tree_source: doc.tree_source,
      incomplete_reason: doc.incomplete_reason || null
    })
  ]
  doc.nodes.forEach(node => lines.push(JSON.stringify({ type: 'node', ...node })))
  doc.edges.forEach(edge => lines.push(JSON.stringify({ type: 'edge', ...edge })))
  doc.references.forEach(ref =>
    lines.push(JSON.stringify({ type: 'reference', ...ref }))
  )
  return lines.join('\n') + '\n'
}

function writeExportFile(doc, format, exportDir) {
  const dir = exportDir || defaultExportDir()
  fs.mkdirSync(dir, { recursive: true })
  const filename = exportFileName(doc.room.room_key, doc.room.revision, format)
  const absolute = path.join(dir, filename)
  const temporary = absolute + '.partial'
  fs.writeFileSync(temporary, serializeExport(doc, format))
  fs.renameSync(temporary, absolute)
  const defaultDir = path.resolve(defaultExportDir())
  const relative = `.tmp/mindmap-exports/${filename}`
  return {
    filename,
    absolute,
    export_path:
      path.resolve(dir) === defaultDir ? relative : absolute
  }
}

function deliverRoomExport(input = {}, options = {}) {
  const format = input.format === 'ndjson' || options.format === 'ndjson' ? 'ndjson' : 'json'
  const doc = buildRoomExport(input, options)
  const count = doc.summary.exported_node_count
  const forceFile = options.forceFile === true || input.forceFile === true
  if (!forceFile && count <= INLINE_NODE_LIMIT) {
    return { delivery: 'inline', format, ...doc }
  }
  try {
    const written = writeExportFile(doc, format, options.exportDir || input.exportDir)
    const payload = {
      delivery: 'file',
      room_key: doc.room.room_key,
      revision: doc.room.revision,
      export_path: written.export_path,
      export_absolute_path: written.absolute,
      format,
      exported_node_count: count,
      expected_node_count: doc.summary.expected_node_count,
      complete: doc.summary.complete,
      read_path: doc.read_path,
      tree_source: doc.tree_source,
      summary: doc.summary
    }
    if (!doc.summary.complete) payload.incomplete_reason = doc.incomplete_reason
    return payload
  } catch (err) {
    return {
      delivery: 'file',
      room_key: doc.room.room_key,
      revision: doc.room.revision,
      exported_node_count: 0,
      expected_node_count: doc.summary.expected_node_count,
      complete: false,
      incomplete_reason: 'backend_error',
      read_path: doc.read_path,
      tree_source: doc.tree_source,
      summary: {
        ...doc.summary,
        complete: false,
        incomplete_reason: 'backend_error'
      },
      error: err.message || String(err)
    }
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function resolveExportFile(roomKey, revision, format, exportDir) {
  const dir = exportDir || defaultExportDir()
  if (!fs.existsSync(dir)) return null
  const prefix = safeFilePart(roomKey) + '--r'
  if (revision != null && revision !== '') {
    const ext = format === 'ndjson' ? 'ndjson' : 'json'
    const exact = path.join(dir, `${prefix}${revision}.${ext}`)
    if (fs.existsSync(exact)) return exact
    if (!format) {
      const other = path.join(
        dir,
        `${prefix}${revision}.${ext === 'json' ? 'ndjson' : 'json'}`
      )
      if (fs.existsSync(other)) return other
    }
    return null
  }
  const matcher = new RegExp(
    '^' + escapeRegExp(prefix) + '(\\d+|norev)\\.(json|ndjson)$'
  )
  const matches = fs
    .readdirSync(dir)
    .filter(name => matcher.test(name))
    .map(name => {
      const found = name.match(matcher)
      const rev = found[1] === 'norev' ? -1 : Number(found[1])
      return { name, rev, ext: found[2] }
    })
    .filter(item => !format || item.ext === format)
    .sort((a, b) => b.rev - a.rev || (a.ext === 'json' ? -1 : 1))
  if (!matches.length) return null
  return path.join(dir, matches[0].name)
}

function parseExportFile(file) {
  const raw = fs.readFileSync(file, 'utf8')
  if (file.endsWith('.ndjson')) {
    const lines = raw.split('\n').filter(line => line.trim())
    const meta = lines.length ? JSON.parse(lines[0]) : {}
    const nodes = []
    const edges = []
    const references = []
    lines.forEach(line => {
      const row = JSON.parse(line)
      if (row.type === 'node') {
        const { type, ...node } = row
        nodes.push(node)
      } else if (row.type === 'edge') {
        edges.push({ parent_id: row.parent_id, child_id: row.child_id })
      } else if (row.type === 'reference') {
        const { type, ...ref } = row
        references.push(ref)
      }
    })
    return {
      room: meta.room || {},
      summary: meta.summary || {},
      nodes,
      edges,
      references,
      incomplete_reason: meta.incomplete_reason || null,
      read_path: meta.read_path || 'snapshot',
      tree_source: meta.tree_source || 'snapshot'
    }
  }
  return JSON.parse(raw)
}

function readExportPage(input = {}) {
  const roomKey = String(input.roomKey || input.room_key || '')
  const revision =
    input.revision == null || input.revision === '' ? null : String(input.revision)
  const offset = Math.max(0, Number(input.offset) || 0)
  const limit = Math.min(1000, Math.max(1, Number(input.limit) || 200))
  const file = resolveExportFile(roomKey, revision, input.format, input.exportDir)
  if (!file) {
    throw exportError('尚未导出该房间，请先调用 export_room_tree', 'EXPORT_NOT_FOUND')
  }
  const doc = parseExportFile(file)
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : []
  const slice = nodes.slice(offset, offset + limit)
  const next = offset + slice.length
  const filename = path.basename(file)
  const exportPath =
    path.resolve(path.dirname(file)) === path.resolve(defaultExportDir())
      ? `.tmp/mindmap-exports/${filename}`
      : file
  return {
    room_key: roomKey,
    revision: doc.room ? doc.room.revision : null,
    export_path: exportPath,
    export_absolute_path: file,
    complete: !!(doc.summary && doc.summary.complete),
    incomplete_reason:
      doc.incomplete_reason ||
      (doc.summary && doc.summary.incomplete_reason) ||
      null,
    exported_node_count: nodes.length,
    expected_node_count:
      doc.summary && doc.summary.expected_node_count != null
        ? doc.summary.expected_node_count
        : null,
    offset,
    limit,
    nodes: slice,
    has_more: next < nodes.length,
    next_offset: next < nodes.length ? next : null,
    read_path: 'export_file'
  }
}

function snapshotExpectedCount(snapshot, graph) {
  const graphCount = graph ? Object.keys(graph).length : 0
  if (!snapshot) return graphCount
  if (snapshot.treeSource === 'room_nodes' && snapshot.roomNodesCount != null) {
    const n = Number(snapshot.roomNodesCount)
    if (Number.isSafeInteger(n) && n >= 0) return n
  }
  if (snapshot.treeSource === 'rooms.nodes' && snapshot.roomsJsonCount != null) {
    const n = Number(snapshot.roomsJsonCount)
    if (Number.isSafeInteger(n) && n >= 0) return n
  }
  return graphCount
}

module.exports = {
  INLINE_NODE_LIMIT,
  PAGE_SIZE,
  buildRoomExport,
  deliverRoomExport,
  readExportPage,
  snapshotExpectedCount,
  defaultExportDir,
  exportFileName,
  safeFilePart
}
