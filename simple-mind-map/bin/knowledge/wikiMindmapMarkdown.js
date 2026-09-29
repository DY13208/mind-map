/**
 * Wiki Markdown ↔ Mindmap tree helpers for human-slot reverse sync.
 * Node identity uses <!-- mindmap:node=HEX_UID hash=... --> (same encoding as markdownRenderer).
 */
const crypto = require('crypto')

const MARKER_RE_COMMENT =
  /<!--\s*mindmap:node=([0-9a-fA-F]+)\s*(?:hash=([^\s>]+))?\s*-->/i
// Docmost strips HTML comments on markdown round-trip; inline-code survives.
const MARKER_RE_CODE =
  /^`mindmap:node=([0-9a-fA-F]+)(?:\s+hash=([^\s`]+))?`\s*$/i
const MARKER_RE_PLAIN =
  /^mindmap-node:([0-9a-fA-F]+)(?:\s+hash=([^\s]+))?\s*$/i
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/

function encodeNodeId(uid) {
  return Buffer.from(String(uid || ''), 'utf8').toString('hex')
}

function decodeNodeId(hex) {
  const h = String(hex || '').trim()
  if (!h || h.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(h)) return null
  try {
    return Buffer.from(h, 'hex').toString('utf8')
  } catch (_) {
    return null
  }
}

function parseMarker(line) {
  const text = String(line || '').trim()
  const m =
    text.match(MARKER_RE_COMMENT) ||
    text.match(MARKER_RE_CODE) ||
    text.match(MARKER_RE_PLAIN)
  if (!m) return null
  const nodeId = decodeNodeId(m[1])
  if (!nodeId) return null
  return {
    nodeId,
    hash: m[2] ? String(m[2]) : '',
    rawHex: m[1].toLowerCase()
  }
}

function contentHash(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex')
}

function nodeSemanticHash({ uid, text, note, children }) {
  return contentHash(
    JSON.stringify({
      uid: String(uid || ''),
      text: String(text || ''),
      note: String(note || ''),
      children: (children || []).map(c => c.uid || c.nodeId || '')
    })
  )
}

/**
 * Parse ATX headings into a tree. Lists stay in content; only headings create nodes.
 *
 * Marker placement (both supported):
 * - After node body (markdownRenderer):   ## Title \\n body \\n <!-- mindmap:node=... -->
 * - Before heading (writeback):           <!-- mindmap:node=... --> \\n ## Title
 */
function parseMarkdownToTree(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n')
  const errors = []
  const seenIds = new Map()
  let pendingMarker = null

  const root = {
    depth: 0,
    text: '',
    content: '',
    nodeId: null,
    hash: '',
    children: [],
    _contentLines: []
  }
  const stack = [root]

  function flushContent(node) {
    if (!node) return
    const cleaned = []
    for (const line of node._contentLines || []) {
      if (parseMarker(line)) continue
      cleaned.push(line)
    }
    node.content = cleaned.join('\n').replace(/^\n+|\n+$/g, '')
    delete node._contentLines
  }

  function applyMarkerToNode(node, marker, lineNo) {
    if (!node || node === root) {
      errors.push({
        code: 'ORPHAN_MARKER',
        nodeId: marker.nodeId,
        line: lineNo
      })
      return
    }
    if (node.nodeId && node.nodeId !== marker.nodeId) {
      errors.push({
        code: 'DUPLICATE_NODE_ID',
        nodeId: marker.nodeId,
        line: lineNo
      })
      return
    }
    if (seenIds.has(marker.nodeId) && seenIds.get(marker.nodeId) !== node) {
      errors.push({
        code: 'DUPLICATE_NODE_ID',
        nodeId: marker.nodeId,
        line: lineNo
      })
      return
    }
    seenIds.set(marker.nodeId, node)
    node.nodeId = marker.nodeId
    node.hash = marker.hash || ''
  }

  function nextSignificantLine(from) {
    for (let j = from; j < lines.length; j++) {
      const t = lines[j].trim()
      if (!t) continue
      if (/^<a\s+id="node-/i.test(t)) continue
      if (/^<!--\s*mind-map:ownership\b/i.test(t)) continue
      return { index: j, line: lines[j] }
    }
    return null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const marker = parseMarker(line)
    if (marker) {
      const next = nextSignificantLine(i + 1)
      if (next && HEADING_RE.test(next.line)) {
        // Marker immediately before a heading → bind to that upcoming heading
        pendingMarker = marker
      } else {
        // Marker after body (or at EOF) → bind to current heading
        const cur = stack[stack.length - 1]
        applyMarkerToNode(cur, marker, i + 1)
        pendingMarker = null
      }
      continue
    }

    if (/^\s*<a\s+id="node-[^"]*"\s*><\/a>\s*$/i.test(line)) continue
    if (/^\s*<!--\s*mind-map:ownership\b/i.test(line)) continue

    const hm = line.match(HEADING_RE)
    if (hm) {
      const depth = hm[1].length
      const text = hm[2].replace(/\s+#*\s*$/, '').trim()
      const node = {
        depth,
        text,
        content: '',
        nodeId: null,
        hash: '',
        children: [],
        _contentLines: []
      }
      if (pendingMarker) {
        applyMarkerToNode(node, pendingMarker, i + 1)
        pendingMarker = null
      }

      while (stack.length > 1 && stack[stack.length - 1].depth >= depth) {
        flushContent(stack.pop())
      }
      const parent = stack[stack.length - 1]
      parent.children.push(node)
      stack.push(node)
      continue
    }

    // Blank lines between marker and heading are ignored
    if (!String(line).trim()) {
      const cur = stack[stack.length - 1]
      if (cur && !pendingMarker) cur._contentLines.push(line)
      continue
    }

    if (pendingMarker) {
      errors.push({
        code: 'ORPHAN_MARKER',
        nodeId: pendingMarker.nodeId,
        line: i + 1
      })
      pendingMarker = null
    }

    const cur = stack[stack.length - 1]
    if (cur) cur._contentLines.push(line)
  }

  if (pendingMarker) {
    errors.push({
      code: 'ORPHAN_MARKER',
      nodeId: pendingMarker.nodeId,
      line: lines.length
    })
  }
  while (stack.length) flushContent(stack.pop())

  let treeRoot = root
  if (root.children.length === 1 && root.children[0].depth === 1) {
    treeRoot = root.children[0]
  } else if (root.children.length) {
    treeRoot = {
      depth: 1,
      text: root.children[0].text || '',
      content: root.content || '',
      nodeId: null,
      hash: '',
      children: root.children
    }
  }

  return {
    root: treeRoot,
    errors,
    duplicateIds: errors
      .filter(e => e.code === 'DUPLICATE_NODE_ID')
      .map(e => e.nodeId)
  }
}

/**
 * Build a comparable tree from mindmap object for a branch root uid.
 */
function mindmapSubtreeToTree(obj, rootUid) {
  const nodes = obj || {}
  if (!rootUid || !nodes[rootUid]) return null

  function walk(uid) {
    const row = nodes[uid]
    if (!row) return null
    const data = row.data || {}
    const childUids = Array.isArray(row.children) ? row.children.slice() : []
    const children = childUids.map(walk).filter(Boolean)
    return {
      uid,
      nodeId: uid,
      text: String(data.text != null ? data.text : ''),
      note: String(data.note != null ? data.note : ''),
      content: String(data.note != null ? data.note : ''),
      children
    }
  }

  return walk(rootUid)
}

function subtreeHash(tree) {
  if (!tree) return ''
  function walk(n) {
    return {
      uid: n.uid || n.nodeId || '',
      text: String(n.text || ''),
      note: String(n.note != null ? n.note : n.content || ''),
      children: (n.children || []).map(walk)
    }
  }
  return contentHash(JSON.stringify(walk(tree)))
}

/**
 * Resolve topic_key → branch root uid.
 * branches/{uidFile}.md | README | README.md
 */
function rootUidFromTopicKey(topicKey, obj) {
  const key = String(topicKey || '').replace(/^\/+/, '')
  if (!key || key === 'README' || key === 'README.md') {
    const root = Object.keys(obj || {}).find(uid => obj[uid] && obj[uid].isRoot)
    return root || null
  }
  const m = key.match(/^branches\/(.+)\.md$/i)
  if (!m) return null
  const file = m[1]
  if (file.startsWith('uid-')) {
    return decodeNodeId(file.slice(4))
  }
  if (obj && obj[file]) return file
  // uidFile may equal raw uid
  return file
}

/**
 * Stable node marker for Wiki Markdown.
 * Prefer inline-code form: Docmost drops HTML comments on round-trip.
 * HTML comment form still parsed for canonical / compiler output.
 */
function formatMarker(uid, hash) {
  const hex = encodeNodeId(uid)
  const h = hash ? ` hash=${hash}` : ''
  return '`mindmap:node=' + hex + h + '`'
}

/**
 * Rewrite wiki markdown so every heading has a mindmap:node marker
 * using the desired tree's nodeIds (after CREATE fill-in).
 */
function rewriteMarkdownWithMarkers(markdown, desiredRoot) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  const queue = []

  function walk(n) {
    queue.push(n)
    ;(n.children || []).forEach(walk)
  }
  walk(desiredRoot)

  let qi = 0
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (parseMarker(line)) {
      // skip old markers; rewrite from queue
      i++
      continue
    }
    if (/^\s*<a\s+id="node-[^"]*"\s*><\/a>\s*$/i.test(line)) {
      i++
      continue
    }
    const hm = line.match(HEADING_RE)
    if (hm && qi < queue.length) {
      const node = queue[qi++]
      if (node && node.nodeId) {
        out.push(formatMarker(node.nodeId, node.hash || ''))
      }
      out.push(line)
      i++
      continue
    }
    out.push(line)
    i++
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

module.exports = {
  encodeNodeId,
  decodeNodeId,
  parseMarker,
  parseMarkdownToTree,
  mindmapSubtreeToTree,
  subtreeHash,
  contentHash,
  nodeSemanticHash,
  rootUidFromTopicKey,
  formatMarker,
  rewriteMarkdownWithMarkers
}
