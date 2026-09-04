/* global module:readonly */

const SPECIAL_OBJECT_MATRIX = [
  {
    type: 'BusinessNode',
    realBusinessNode: true,
    roomNodesRow: true,
    ownerUid: 'self',
    sourceUid: null,
    targetUid: null,
    storageFields: 'room_nodes.data',
    command: 'INSERT_*/SET_NODE_*/REMOVE_NODE',
    operation: 'node.insert|update|move|delete|restore',
    allowInsert: true,
    allowDelete: true,
    undoRedo: 'node.restore / inverse patch'
  },
  {
    type: 'GeneralizationVirtualNode',
    realBusinessNode: false,
    roomNodesRow: false,
    ownerUid: 'generalizationBelongNode.uid',
    sourceUid: null,
    targetUid: null,
    storageFields: 'owner.data.generalization[]',
    command: 'ADD_GENERALIZATION / SET_NODE_DATA(generalization)',
    operation: 'node.update(ownerUid, { generalization })',
    allowInsert: false,
    allowDelete: false,
    undoRedo: 'owner generalization inverse'
  },
  {
    type: 'GeneralizationRange',
    realBusinessNode: false,
    roomNodesRow: false,
    ownerUid: 'owner.uid',
    sourceUid: null,
    targetUid: null,
    storageFields: 'owner.data.generalization[].range',
    command: 'ADD_GENERALIZATION',
    operation: 'node.update(ownerUid)',
    allowInsert: false,
    allowDelete: false,
    undoRedo: 'owner generalization inverse'
  },
  {
    type: 'AssociativeLine',
    realBusinessNode: false,
    roomNodesRow: false,
    ownerUid: 'source business uid',
    sourceUid: 'source.data.uid',
    targetUid: 'source.data.associativeLineTargets[]',
    storageFields:
      'source.data.associativeLineTargets/Point/TargetControlOffsets/Text/Style',
    command: 'ADD_ASSOCIATIVE_LINE / SET_NODE_DATA',
    operation: 'node.update(sourceUid, relation fields)',
    allowInsert: false,
    allowDelete: false,
    undoRedo: 'restore source relation fields; Strategy A keep dangling'
  },
  {
    type: 'OuterFrame',
    realBusinessNode: false,
    roomNodesRow: false,
    ownerUid: 'first node in range',
    sourceUid: null,
    targetUid: null,
    storageFields: 'owner.data.outerFrame',
    command: 'ADD_OUTER_FRAME / SET_NODE_DATA(outerFrame)',
    operation: 'node.update(ownerUid, { outerFrame })',
    allowInsert: false,
    allowDelete: false,
    undoRedo: 'owner outerFrame inverse'
  },
  {
    type: 'DragPlaceholderClone',
    realBusinessNode: false,
    roomNodesRow: false,
    ownerUid: null,
    sourceUid: null,
    targetUid: null,
    storageFields: 'renderer temporary only',
    command: 'none',
    operation: 'none',
    allowInsert: false,
    allowDelete: false,
    undoRedo: 'not collaborative'
  },
  {
    type: 'ExpandBtn',
    realBusinessNode: false,
    roomNodesRow: false,
    ownerUid: 'owner business uid',
    sourceUid: null,
    targetUid: null,
    storageFields: 'owner.data.expand',
    command: 'SET_NODE_EXPAND',
    operation: 'none (renderer helper)',
    allowInsert: false,
    allowDelete: false,
    undoRedo: 'not a collaboration object'
  },
  {
    type: 'QuickCreateChildBtn',
    realBusinessNode: false,
    roomNodesRow: false,
    ownerUid: 'owner business uid',
    sourceUid: null,
    targetUid: null,
    storageFields: 'none',
    command: 'none',
    operation: 'none',
    allowInsert: false,
    allowDelete: false,
    undoRedo: 'not collaborative'
  },
  {
    type: 'AssociativeLineControlPoint',
    realBusinessNode: false,
    roomNodesRow: false,
    ownerUid: 'source business uid',
    sourceUid: 'source.data.uid',
    targetUid: 'source.data.associativeLineTargets[]',
    storageFields: 'source.data.associativeLinePoint / TargetControlOffsets',
    command: 'SET_NODE_DATA',
    operation: 'node.update(sourceUid)',
    allowInsert: false,
    allowDelete: false,
    undoRedo: 'source relation inverse'
  },
  {
    type: 'TextEditOverlay',
    realBusinessNode: false,
    roomNodesRow: false,
    ownerUid: 'editing business uid',
    sourceUid: null,
    targetUid: null,
    storageFields: 'none',
    command: 'none',
    operation: 'none',
    allowInsert: false,
    allowDelete: false,
    undoRedo: 'not collaborative'
  }
]

const SPECIAL_OBJECT_LIFECYCLE_MATRIX = [
  'Generalization owner create',
  'Generalization edit',
  'Generalization delete',
  'node inside Generalization range update',
  'node inside Generalization range delete',
  'node inside Generalization range delete → undo',
  'AssociativeLine normal endpoints',
  'AssociativeLine endpoint inside Generalization range',
  'Delete association endpoint',
  'Undo association endpoint',
  'OuterFrame owner delete',
  'Undo OuterFrame owner',
  'subtree containing Generalization',
  'subtree restore containing Generalization'
]

const IMPORT_RUNTIME_KEYS = [
  'onUploadProgress',
  'onProgress',
  'onDownloadProgress',
  'callback',
  'signal',
  'abortController',
  'parser',
  'file',
  'raw',
  'vue',
  'component',
  'mindMap',
  'event',
  'evt'
]

const MAP_REPLACE_PAYLOAD_KEYS = [
  'tree',
  'nodes',
  'metadata',
  'reason',
  'source',
  'fullTreeReason',
  'traceId',
  'clientSeq',
  'baseRevision',
  'baseVersion'
]

function nodeUid(node) {
  if (!node) return ''
  if (typeof node.getData === 'function') return node.getData('uid') || ''
  return (node.data && node.data.uid) || node.uid || ''
}

function isVirtualGeneralization(node) {
  return !!(node && node.isGeneralization)
}

function isBusinessNode(node) {
  return !!(node && !node.isGeneralization && !node.isDragPlaceholder)
}

function resolveCollaborationTarget(node, command) {
  const cmd = String(command || '')
  if (!node) return { kind: 'none' }
  if (node.isDragPlaceholder || node.isClone) {
    return { kind: 'temporary', reason: 'drag-placeholder' }
  }
  if (isVirtualGeneralization(node)) {
    const owner = node.generalizationBelongNode || null
    const ownerUid = nodeUid(owner)
    if (
      cmd === 'ADD_ASSOCIATIVE_LINE' ||
      cmd === 'SET_NODE_ACTIVE' ||
      cmd.indexOf('ASSOCIATIVE') !== -1
    ) {
      return {
        kind: 'virtual-skipped',
        reason: 'generalization-not-endpoint',
        virtualUid: nodeUid(node),
        ownerUid
      }
    }
    if (cmd === 'REMOVE_NODE' || cmd === 'REMOVE_CURRENT_NODE' || cmd === 'CUT_NODE') {
      return { kind: 'generalization', ownerUid, virtualUid: nodeUid(node), owner }
    }
    return { kind: 'generalization', ownerUid, virtualUid: nodeUid(node), owner }
  }
  return { kind: 'business-node', uid: nodeUid(node), node }
}

function businessEndpoint(node) {
  if (!node) return null
  const resolved = resolveCollaborationTarget(node, 'ADD_ASSOCIATIVE_LINE')
  if (resolved.kind === 'business-node') return resolved.node
  return null
}

function isTransientMedia(value) {
  if (!value || typeof value !== 'object') return ''
  if (typeof File !== 'undefined' && value instanceof File) return 'File'
  if (typeof Blob !== 'undefined' && value instanceof Blob && !(typeof File !== 'undefined' && value instanceof File)) {
    return 'Blob'
  }
  return ''
}

function canonicalImageFields(data = {}, imgMap = {}, getter) {
  let stored = data && data.image
  let resolved = stored
  if (typeof getter === 'function') {
    try {
      const got = getter()
      if (typeof got === 'string' && got) resolved = got
    } catch (e) {
      // ignore
    }
  }
  if (typeof resolved !== 'string') resolved = typeof stored === 'string' ? stored : null
  if (resolved && /^smm_img_key_/.test(resolved) && imgMap && imgMap[resolved]) {
    resolved = imgMap[resolved]
  }
  const media = isTransientMedia(stored) || isTransientMedia(resolved)
  return {
    storedImageValue: typeof stored === 'string' ? stored : media || null,
    image: media ? null : resolved || null,
    imageTitle: data && data.imageTitle != null ? data.imageTitle : null,
    imageSize: data && data.imageSize ? data.imageSize : null,
    unresolvedKey: !!(resolved && /^smm_img_key_/.test(resolved)),
    skipTransient: !!media
  }
}

function publishImageTrace(row = {}) {
  const next = { timestamp: Date.now(), ...row }
  if (typeof window === 'undefined') return next
  window.__IMAGE_TRACE__ = next
  window.__IMAGE_TRACE_LOG__ = window.__IMAGE_TRACE_LOG__ || []
  window.__IMAGE_TRACE_LOG__.push(next)
  if (window.__IMAGE_TRACE_LOG__.length > 50) window.__IMAGE_TRACE_LOG__.shift()
  return next
}

function pathOf(prefix, key) {
  return prefix ? prefix + '.' + key : key
}

function findNonCloneable(value, prefix, out) {
  if (value == null) return out
  const t = typeof value
  if (t === 'function') {
    out.push({ path: prefix || '(root)', type: 'function' })
    return out
  }
  if (t === 'symbol') {
    out.push({ path: prefix || '(root)', type: 'symbol' })
    return out
  }
  if (t !== 'object') return out
  const media = isTransientMedia(value)
  if (media) {
    out.push({ path: prefix || '(root)', type: media })
    return out
  }
  if (value._isVue || value.__vue__ || (value.$options && value.$el)) {
    out.push({ path: prefix || '(root)', type: 'Vue' })
    return out
  }
  if (value instanceof WeakMap || value instanceof WeakSet) {
    out.push({ path: prefix || '(root)', type: value.constructor.name })
    return out
  }
  if (typeof Event !== 'undefined' && value instanceof Event) {
    out.push({ path: prefix || '(root)', type: 'Event' })
    return out
  }
  if (typeof Node !== 'undefined' && value instanceof Node) {
    out.push({ path: prefix || '(root)', type: 'DOMNode' })
    return out
  }
  if (typeof AbortController !== 'undefined' && value instanceof AbortController) {
    out.push({ path: prefix || '(root)', type: 'AbortController' })
    return out
  }
  if (typeof AbortSignal !== 'undefined' && value instanceof AbortSignal) {
    out.push({ path: prefix || '(root)', type: 'AbortSignal' })
    return out
  }
  if (value.isGeneralization != null && value.nodeData) {
    out.push({ path: prefix || '(root)', type: 'MindMapNode' })
    return out
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => findNonCloneable(item, pathOf(prefix, i), out))
    return out
  }
  Object.keys(value).forEach(key => {
    try {
      findNonCloneable(value[key], pathOf(prefix, key), out)
    } catch (err) {
      out.push({ path: pathOf(prefix, key), type: 'unreadable' })
    }
  })
  return out
}

function assertStructuredCloneSafeOperation(op) {
  const hits = findNonCloneable(op, '', [])
  if (hits.length) {
    const err = new Error('OUTBOX_NON_CLONEABLE_PAYLOAD: ' + hits.map(h => h.path).join(', '))
    err.code = 'OUTBOX_NON_CLONEABLE_PAYLOAD'
    err.stage = 'IMPORT_OUTBOX_SERIALIZE_FAILED'
    err.paths = hits
    if (typeof console !== 'undefined' && console.error) {
      console.error('OUTBOX_NON_CLONEABLE_PAYLOAD', hits)
    }
    throw err
  }
  if (typeof structuredClone === 'function') {
    try {
      structuredClone(op)
    } catch (err) {
      const wrap = new Error('OUTBOX_NON_CLONEABLE_PAYLOAD')
      wrap.code = 'OUTBOX_NON_CLONEABLE_PAYLOAD'
      wrap.stage = 'IMPORT_OUTBOX_SERIALIZE_FAILED'
      wrap.cause = err
      throw wrap
    }
  }
  return true
}

function stripImportRuntimeContext(input = {}) {
  if (!input || typeof input !== 'object') return {}
  const next = {}
  Object.keys(input).forEach(key => {
    if (IMPORT_RUNTIME_KEYS.indexOf(key) !== -1) return
    if (typeof input[key] === 'function') return
    next[key] = input[key]
  })
  return next
}

function buildMapReplacePayload(tree, extra = {}) {
  const cleaned = stripImportRuntimeContext(extra)
  const payload = { tree }
  MAP_REPLACE_PAYLOAD_KEYS.forEach(key => {
    if (key === 'tree') return
    if (cleaned[key] !== undefined) payload[key] = cleaned[key]
  })
  return payload
}

function relationshipEndpointsAreBusiness(sourceUid, targetUid, virtualUids = []) {
  const banned = virtualUids || []
  if (!sourceUid || !targetUid) return false
  if (banned.indexOf(sourceUid) !== -1 || banned.indexOf(targetUid) !== -1) {
    return false
  }
  return true
}

function assertNoVirtualUidPersisted(uids = [], virtualUids = []) {
  const bad = (uids || []).filter(uid => (virtualUids || []).indexOf(uid) !== -1)
  if (bad.length) {
    const err = new Error('SPECIAL_OBJECT_PERSISTED_AS_NODE')
    err.code = 'SPECIAL_OBJECT_PERSISTED_AS_NODE'
    err.uids = bad
    throw err
  }
  return true
}

const api = {
  SPECIAL_OBJECT_MATRIX,
  SPECIAL_OBJECT_LIFECYCLE_MATRIX,
  IMPORT_RUNTIME_KEYS,
  resolveCollaborationTarget,
  businessEndpoint,
  isVirtualGeneralization,
  isBusinessNode,
  nodeUid,
  canonicalImageFields,
  publishImageTrace,
  findNonCloneable,
  assertStructuredCloneSafeOperation,
  stripImportRuntimeContext,
  buildMapReplacePayload,
  relationshipEndpointsAreBusiness,
  assertNoVirtualUidPersisted
}

module.exports = api
module.exports.default = api
