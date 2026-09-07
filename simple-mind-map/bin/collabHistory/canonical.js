const crypto = require('crypto')
const { canonicalizeNodes, canonicalTreeHash, validateNodeGraph } = require('../roomNodes')
const { stripViewState } = require('../mapMetadata')

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value == null ? null : value))
}

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const keys = Object.keys(value).sort()
  return (
    '{' +
    keys
      .map(key => JSON.stringify(key) + ':' + stableStringify(value[key]))
      .join(',') +
    '}'
  )
}

function isVirtualNode(node) {
  if (!node) return true
  if (node.isGeneralization || node.isDragPlaceholder || node.isClone) return true
  const data = node.data || {}
  return !!(data.isGeneralization || data.virtual || data.helper)
}

function toBusinessTree(graph) {
  const src = graph && typeof graph === 'object' ? graph : {}
  const raw = {}
  Object.keys(src).forEach(uid => {
    const node = src[uid]
    if (!node || node.deleted || isVirtualNode(node)) return
    raw[uid] = {
      isRoot: !!node.isRoot,
      data: { ...(node.data || {}), uid },
      children: Array.isArray(node.children) ? node.children.slice() : [],
      position: node.position || ''
    }
  })
  Object.keys(raw).forEach(uid => {
    raw[uid].children = (raw[uid].children || []).filter(id => !!raw[id])
  })
  const canonical = canonicalizeNodes(raw)
  return canonical.ok ? canonical.nodes : raw
}

function canonicalMetadata(meta) {
  return stripViewState(cloneJson(meta || {}))
}

function historyChecksum(tree, metadata) {
  const body = stableStringify({
    tree: toBusinessTree(tree),
    metadata: canonicalMetadata(metadata)
  })
  return crypto.createHash('sha256').update(body).digest('hex')
}

function nodeCount(tree) {
  return Object.keys(tree || {}).length
}

function assertTreeValid(tree) {
  const check = validateNodeGraph(tree)
  if (!check.ok) {
    const err = new Error('历史树校验失败: ' + (check.errors || []).slice(0, 5).join('; '))
    err.code = 'INVALID_HISTORY_TREE'
    err.statusCode = 400
    err.details = check
    throw err
  }
  return check
}

module.exports = {
  cloneJson,
  stableStringify,
  toBusinessTree,
  canonicalMetadata,
  historyChecksum,
  canonicalTreeHash,
  nodeCount,
  assertTreeValid
}
