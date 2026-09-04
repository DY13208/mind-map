/* global module:readonly, require:readonly */

const {
  canonicalImageFields,
  isVirtualGeneralization
} = require('./collabSpecialObjects')

function createUid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
    const n = (Math.random() * 16) | 0
    const v = ch === 'x' ? n : (n & 0x3) | 0x8
    return v.toString(16)
  })
}

const COPY_DATA_KEYS = [
  'text',
  'richText',
  'note',
  'tag',
  'icon',
  'image',
  'imageTitle',
  'imageSize',
  'hyperlink',
  'hyperlinkTitle',
  'formula',
  'generalization',
  'outerFrame',
  'mapRef',
  'associativeLineTargets',
  'associativeLineTargetControlOffsets',
  'associativeLinePoint',
  'associativeLineText',
  'associativeLineStyle',
  'fillColor',
  'color',
  'fontSize',
  'fontFamily',
  'fontWeight',
  'fontStyle',
  'borderColor',
  'borderWidth',
  'borderDasharray',
  'borderRadius',
  'lineColor',
  'lineWidth',
  'lineDasharray',
  'shape',
  'paddingX',
  'paddingY',
  'expand',
  'attachmentUrl',
  'attachmentName'
]

function clonePlain(value) {
  if (value == null) return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch (err) {
    if (Array.isArray(value)) return value.map(item => clonePlain(item))
    if (typeof value === 'object') {
      const next = {}
      Object.keys(value).forEach(key => {
        if (typeof value[key] === 'function') return
        next[key] = clonePlain(value[key])
      })
      return next
    }
    return value
  }
}

function treeUid(node) {
  return (node && node.data && node.data.uid) || ''
}

function walkTrees(trees, visit) {
  const list = Array.isArray(trees) ? trees : trees ? [trees] : []
  const stack = list.slice()
  while (stack.length) {
    const node = stack.pop()
    if (!node) continue
    visit(node)
    const kids = node.children || []
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i])
    const gens = Array.isArray(node.data && node.data.generalization)
      ? node.data.generalization
      : node.data && node.data.generalization
        ? [node.data.generalization]
        : []
    gens.forEach(item => {
      if (item && Array.isArray(item.children)) {
        item.children.forEach(child => stack.push(child))
      }
    })
  }
}

function collectBusinessUids(trees) {
  const uids = []
  walkTrees(trees, node => {
    const uid = treeUid(node)
    if (uid) uids.push(uid)
  })
  return uids
}

function collectObjectRefs(trees) {
  const refs = []
  walkTrees(trees, node => {
    if (node) refs.push(node)
    if (node && node.data) refs.push(node.data)
    if (node && node.children) refs.push(node.children)
  })
  return refs
}

function assertNoSharedPasteRefs(originalTrees, pastedTrees) {
  const left = new Set(collectObjectRefs(originalTrees))
  const hits = collectObjectRefs(pastedTrees).filter(ref => left.has(ref))
  if (hits.length) {
    const err = new Error('PASTE_SHARED_OBJECT_REFERENCE')
    err.code = 'PASTE_SHARED_OBJECT_REFERENCE'
    err.sharedReferences = hits.length
    throw err
  }
  return true
}

function canonicalizeNodeImage(data, imgMap) {
  if (!data || typeof data !== 'object') return data
  const fields = canonicalImageFields(data, imgMap || {})
  if (fields.image && !fields.unresolvedKey && !fields.skipTransient) {
    data.image = fields.image
  }
  return data
}

function remapAssociativeLine(data, uidMap) {
  if (!data || !Array.isArray(data.associativeLineTargets)) return
  const next = []
  const keepIndex = []
  data.associativeLineTargets.forEach((target, index) => {
    if (uidMap[target]) {
      next.push(uidMap[target])
      keepIndex.push(index)
    } else {
      next.push(target)
      keepIndex.push(index)
    }
  })
  data.associativeLineTargets = next
  ;[
    'associativeLineTargetControlOffsets',
    'associativeLinePoint',
    'associativeLineText',
    'associativeLineStyle'
  ].forEach(key => {
    if (!Array.isArray(data[key])) return
    data[key] = keepIndex.map(i => clonePlain(data[key][i]))
  })
}

function assignTreeUids(node, uidMap, imgMap) {
  const next = {
    data: clonePlain((node && node.data) || {}) || {},
    children: []
  }
  canonicalizeNodeImage(next.data, imgMap)
  const oldUid = next.data.uid
  const newUid = createUid()
  if (oldUid) uidMap[oldUid] = newUid
  next.data.uid = newUid
  delete next.data.isActive
  delete next.data.inserting
  const gens = Array.isArray(next.data.generalization)
    ? next.data.generalization
    : next.data.generalization
      ? [next.data.generalization]
      : []
  if (gens.length) {
    next.data.generalization = gens.map(item => {
      const gen = clonePlain(item) || {}
      const oldGenUid = gen.uid
      gen.uid = createUid()
      if (oldGenUid) uidMap[oldGenUid] = gen.uid
      if (Array.isArray(gen.range) && gen.range.length >= 2) {
        gen.range = [Number(gen.range[0]), Number(gen.range[1])]
      }
      if (Array.isArray(gen.children)) {
        gen.children = gen.children.map(child => assignTreeUids(child, uidMap, imgMap))
      }
      return gen
    })
  }
  next.children = ((node && node.children) || []).map(child =>
    assignTreeUids(child, uidMap, imgMap)
  )
  return next
}

function remapRelationsInTrees(trees, uidMap) {
  walkTrees(trees, node => {
    if (node && node.data) remapAssociativeLine(node.data, uidMap)
  })
}

function cloneCopyTrees(trees, imgMap) {
  const list = Array.isArray(trees) ? trees : trees ? [trees] : []
  return list.map(tree => {
    const cloned = clonePlain(tree) || { data: {}, children: [] }
    walkTrees([cloned], node => {
      if (node && node.data) canonicalizeNodeImage(node.data, imgMap)
    })
    return cloned
  })
}

function preparePasteTrees(input, options = {}) {
  const original = Array.isArray(input) ? input : input ? [input] : []
  const cloned = cloneCopyTrees(original, options.imgMap || {})
  const uidMap = {}
  const pasted = cloned.map(tree => assignTreeUids(tree, uidMap, options.imgMap || {}))
  remapRelationsInTrees(pasted, uidMap)
  const originalUids = collectBusinessUids(original)
  const pastedUids = collectBusinessUids(pasted)
  const duplicateUids = originalUids.filter(uid => pastedUids.indexOf(uid) !== -1)
  let sharedReferences = 0
  try {
    assertNoSharedPasteRefs(original, pasted)
  } catch (err) {
    sharedReferences = err.sharedReferences || 1
    if (options.strict !== false) throw err
  }
  if (duplicateUids.length) {
    const err = new Error('PASTE_UID_REUSE_FORBIDDEN')
    err.code = 'PASTE_UID_REUSE_FORBIDDEN'
    err.duplicateUids = duplicateUids
    throw err
  }
  const row = {
    originalRootUid: originalUids[0] || '',
    pastedRootUid: pastedUids[0] || '',
    uidMap,
    duplicateUids,
    sharedReferences,
    operationType: 'node.batch',
    insertedUids: pastedUids
  }
  publishPasteIdentityTrace(row)
  return {
    trees: pasted,
    uidMap,
    originalUids,
    pastedUids,
    trace: row
  }
}

function publishPasteIdentityTrace(row = {}) {
  const next = { timestamp: Date.now(), ...row }
  if (typeof window === 'undefined') return next
  window.__PASTE_IDENTITY_TRACE__ = next
  window.__PASTE_IDENTITY_TRACE_LOG__ = window.__PASTE_IDENTITY_TRACE_LOG__ || []
  window.__PASTE_IDENTITY_TRACE_LOG__.push(next)
  if (window.__PASTE_IDENTITY_TRACE_LOG__.length > 40) {
    window.__PASTE_IDENTITY_TRACE_LOG__.shift()
  }
  return next
}

function identityInvariant(originalUids, pastedUids) {
  const left = new Set(originalUids || [])
  return !(pastedUids || []).some(uid => left.has(uid))
}

function publishImportRuntimeTrace(row = {}) {
  const next = { timestamp: Date.now(), ...row }
  if (typeof window === 'undefined') return next
  window.__IMPORT_RUNTIME_TRACE__ = next
  return next
}

function publishGeneralizationDragTrace(row = {}) {
  const next = { timestamp: Date.now(), ...row }
  if (typeof window === 'undefined') return next
  window.__GENERALIZATION_DRAG_TRACE__ = next
  return next
}

function resolveDropBusinessNode(node) {
  if (!node) return null
  if (isVirtualGeneralization(node)) return null
  return node
}

function generalizationCorridorPx(node) {
  const parent = node && node.parent
  if (!parent) return 0
  const has =
    typeof parent.checkHasGeneralization === 'function'
      ? parent.checkHasGeneralization()
      : !!(parent.getData && parent.getData('generalization'))
  if (!has) return 0
  return Math.max(
    Number(parent._generalizationSubtreeWidth) || 0,
    Number(parent._generalizationNodeWidth) || 0,
    72
  )
}

const api = {
  COPY_DATA_KEYS,
  clonePlain,
  cloneCopyTrees,
  collectBusinessUids,
  preparePasteTrees,
  assertNoSharedPasteRefs,
  identityInvariant,
  canonicalizeNodeImage,
  publishPasteIdentityTrace,
  publishImportRuntimeTrace,
  publishGeneralizationDragTrace,
  resolveDropBusinessNode,
  generalizationCorridorPx
}

module.exports = api
module.exports.default = api
