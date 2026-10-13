import collabPaste from 'simple-mind-map/src/utils/collabPaste'

const MORE_UID = '__history_preview_more__'
const RUNTIME_NODE_KEYS = new Set([
  'group',
  'parent',
  'renderer',
  'isRoot',
  'isGeneralization',
  'isActive',
  'inserting',
  'isSelected',
  'selected',
  'loading',
  'isLoading',
  'placeholder',
  'isPlaceholder'
])
const RUNTIME_DATA_KEYS = new Set([
  'isActive',
  'inserting',
  'isSelected',
  'selected'
])

function historyError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function cloneJson(value, code = 'HISTORY_SNAPSHOT_INVALID') {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch (cause) {
    const error = historyError(code, '历史版本数据无法安全复制')
    error.cause = cause
    throw error
  }
}

function isNestedTree(value) {
  return !!(
    value &&
    typeof value === 'object' &&
    value.data &&
    typeof value.data === 'object' &&
    Array.isArray(value.children)
  )
}

function normalizeFlatGraph(graph) {
  const entries = Object.entries(graph || {}).filter(
    ([, node]) => node && typeof node === 'object'
  )
  if (!entries.length) {
    throw historyError('HISTORY_SNAPSHOT_INVALID', '历史版本中没有可读取的节点')
  }
  const nodes = new Map(entries)
  const rootEntry =
    entries.find(([, node]) => node.isRoot || (node.data && node.data.isRoot)) ||
    entries[0]
  const visiting = new Set()
  const visited = new Set()

  const build = key => {
    if (!nodes.has(key)) {
      throw historyError('HISTORY_SNAPSHOT_INVALID', '历史版本包含缺失的节点引用')
    }
    if (visiting.has(key)) {
      throw historyError('HISTORY_SNAPSHOT_INVALID', '历史版本节点关系存在循环')
    }
    if (visited.has(key)) {
      throw historyError('HISTORY_SNAPSHOT_INVALID', '历史版本节点被多个父节点引用')
    }
    visiting.add(key)
    const source = nodes.get(key)
    const data = cloneJson(source.data || {})
    if (data.uid != null && data.uid !== '' && String(data.uid) !== String(key)) {
      throw historyError('HISTORY_NODE_UID_MISMATCH', '历史版本节点索引与 UID 不一致')
    }
    data.uid = key
    if (data.expand == null) data.expand = true
    const children = (source.children || []).map(child =>
      typeof child === 'string'
        ? build(child)
        : cleanNestedNode(child, {})
    )
    visiting.delete(key)
    visited.add(key)
    return { data, children }
  }

  const tree = build(rootEntry[0])
  if (visited.size !== nodes.size) {
    throw historyError('HISTORY_SNAPSHOT_INVALID', '历史版本存在无法到达的节点')
  }
  return tree
}

function cleanGeneralizations(data, imgMap) {
  if (!data || data.generalization == null) return
  const list = Array.isArray(data.generalization)
    ? data.generalization
    : [data.generalization]
  const cleaned = list.map(item => {
    if (!item || typeof item !== 'object') return item
    const copy = cloneJson(item)
    delete copy.isActive
    delete copy.inserting
    if (Array.isArray(copy.children)) {
      copy.children = copy.children
        .map(child => cleanNestedNode(child, imgMap))
        .filter(Boolean)
    }
    return copy
  })
  data.generalization = Array.isArray(data.generalization) ? cleaned : cleaned[0]
}

function canonicalizeImage(data, imgMap) {
  if (!data || typeof data.image !== 'string') return
  const image = data.image
  if (/^smm_img_key_/.test(image) && imgMap && typeof imgMap[image] === 'string') {
    data.image = imgMap[image]
  }
}

function cleanNestedNode(source, imgMap) {
  if (!isNestedTree(source)) return null
  const sourceUid = source.data.uid == null ? source.uid : source.data.uid
  if (String(sourceUid || '') === MORE_UID) return null

  const data = cloneJson(source.data)
  if ((data.uid == null || data.uid === '') && source.uid != null) {
    data.uid = source.uid
  }
  RUNTIME_DATA_KEYS.forEach(key => delete data[key])
  if (data.expand == null) data.expand = true
  canonicalizeImage(data, imgMap)
  cleanGeneralizations(data, imgMap)

  const node = { data, children: [] }
  Object.keys(source).forEach(key => {
    if (key === 'data' || key === 'children' || key.startsWith('_')) return
    if (RUNTIME_NODE_KEYS.has(key)) return
    node[key] = cloneJson(source[key])
  })
  node.children = source.children.map(child => cleanNestedNode(child, imgMap)).filter(Boolean)
  return node
}

function resolveImageMap(tree, metadata) {
  const rootDataMap = tree && tree.data && tree.data.imgMap
  const rootMap = tree && tree.imgMap
  const metadataMap =
    (metadata && metadata.imgMap) ||
    (metadata && metadata.data && metadata.data.imgMap) ||
    (metadata && metadata.map && metadata.map.imgMap)
  return Object.assign({}, metadataMap || {}, rootMap || {}, rootDataMap || {})
}

function walkNodes(tree, visit) {
  const stack = [{ node: tree, parent: null }]
  while (stack.length) {
    const { node, parent } = stack.pop()
    if (!node) continue
    visit(node, parent)
    const children = Array.isArray(node.children) ? node.children : []
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i], parent: node })
    }
    const generalization = node.data && node.data.generalization
    const list = Array.isArray(generalization)
      ? generalization
      : generalization
        ? [generalization]
        : []
    for (let i = list.length - 1; i >= 0; i--) {
      const genChildren = Array.isArray(list[i] && list[i].children)
        ? list[i].children
        : []
      for (let j = genChildren.length - 1; j >= 0; j--) {
        stack.push({ node: genChildren[j], parent: node })
      }
    }
  }
}

function buildSnapshotIndex(tree, imgMap) {
  const index = Object.create(null)
  const records = new Map()
  const recordsByNode = new Map()
  const virtualUids = new Set()
  const orderedRecords = []
  walkNodes(tree, (node, parentNode) => {
    const uidValue = node.data && node.data.uid
    const uid = uidValue == null ? '' : String(uidValue)
    const record = {
      uid,
      node,
      parentNode,
      order: orderedRecords.length,
      nodeCount: 1
    }
    orderedRecords.push(record)
    recordsByNode.set(node, record)
    if (uid) {
      if (records.has(uid)) {
        throw historyError('HISTORY_DUPLICATE_NODE_UID', '历史版本包含重复节点 UID')
      }
      records.set(uid, record)
      index[uid] = node
    }
    const generalization = node.data && node.data.generalization
    const list = Array.isArray(generalization)
      ? generalization
      : generalization
        ? [generalization]
        : []
    list.forEach(item => {
      if (item && item.uid != null && String(item.uid)) {
        virtualUids.add(String(item.uid))
      }
    })
  })

  for (let i = orderedRecords.length - 1; i >= 0; i--) {
    const record = orderedRecords[i]
    if (record.parentNode) {
      const parent = recordsByNode.get(record.parentNode)
      if (parent) parent.nodeCount += record.nodeCount
    }
  }

  Object.defineProperty(index, '__historyInternals', {
    enumerable: false,
    value: { records, recordsByNode, orderedRecords, imgMap, virtualUids }
  })
  return index
}

function selectionRoots(snapshot, uids) {
  const index = snapshot && snapshot.index
  const internals = index && index.__historyInternals
  if (!snapshot || !snapshot.tree || !internals) {
    throw historyError('HISTORY_SNAPSHOT_INVALID', '历史版本索引不可用，请重新加载版本')
  }
  const input = Array.isArray(uids) ? uids : uids == null ? [] : [uids]
  const unique = []
  const seen = new Set()
  input.forEach(value => {
    const uid = String(value == null ? '' : value)
    if (!uid || seen.has(uid)) return
    seen.add(uid)
    unique.push(uid)
  })
  const selected = unique.map(uid => {
    const record = internals.records.get(uid)
    if (!record) {
      if (internals.virtualUids.has(uid)) {
        const error = historyError(
          'HISTORY_GENERALIZATION_SELECTION_UNSUPPORTED',
          '概要节点不能单独复制，请选择概要下的具体节点'
        )
        error.uid = uid
        throw error
      }
      const error = historyError('HISTORY_SELECTION_UID_NOT_FOUND', `所选历史节点已不可用：${uid}`)
      error.uid = uid
      throw error
    }
    return record
  })
  const selectedRecords = new Set(selected)
  const roots = selected.filter(record => {
    let parentRecord = internals.recordsByNode.get(record.parentNode)
    while (parentRecord) {
      if (selectedRecords.has(parentRecord)) return false
      parentRecord = internals.recordsByNode.get(parentRecord.parentNode)
    }
    return true
  })
  roots.sort((a, b) => a.order - b.order)
  return { internals, roots }
}

/** Create an isolated, full-tree snapshot and UID index from a history graph. */
export function prepareHistorySnapshot(graph, metadata = {}) {
  const source = graph && graph.tree ? graph.tree : graph
  if (!source || typeof source !== 'object') {
    throw historyError('HISTORY_SNAPSHOT_INVALID', '历史版本树不可用')
  }
  if (source.data && typeof source.data === 'object' && !Array.isArray(source.children)) {
    throw historyError('HISTORY_SNAPSHOT_INVALID', '历史版本树缺少子节点列表')
  }
  const rawTree = isNestedTree(source) ? source : normalizeFlatGraph(source)
  const imgMap = resolveImageMap(rawTree, metadata)
  const copied = collabPaste.cloneCopyTrees([rawTree], imgMap)[0]
  let tree = cleanNestedNode(copied, imgMap)
  if (!tree || !tree.data || typeof tree.data !== 'object') {
    throw historyError('HISTORY_SNAPSHOT_INVALID', '历史版本树格式无效')
  }

  const resolvedImgMap = Object.assign({}, imgMap, resolveImageMap(tree, metadata))
  if (Object.keys(resolvedImgMap).length) {
    tree.data.imgMap = Object.assign({}, resolvedImgMap)
    // Resolve private image keys using this version's own map before copying.
    walkNodes(tree, node => canonicalizeImage(node.data, resolvedImgMap))
  }
  const index = buildSnapshotIndex(tree, resolvedImgMap)
  return { tree, index }
}

/** Summarize a selection without cloning any node data. */
export function summarizeHistoryBranches(snapshot, uids) {
  const { roots } = selectionRoots(snapshot, uids)
  return {
    branchCount: roots.length,
    nodeCount: roots.reduce((sum, record) => sum + record.nodeCount, 0),
    uids: roots.map(record => record.uid)
  }
}

function filterAssociativeLines(trees, included) {
  trees.forEach(tree => walkNodes(tree, current => {
    const data = current.data || {}
    if (!Array.isArray(data.associativeLineTargets)) return
    const keepIndexes = []
    data.associativeLineTargets.forEach((target, index) => {
      if (included.has(String(target))) keepIndexes.push(index)
    })
    data.associativeLineTargets = keepIndexes.map(index => data.associativeLineTargets[index])
    ;[
      'associativeLineTargetControlOffsets',
      'associativeLinePoint',
      'associativeLineText',
      'associativeLineStyle'
    ].forEach(key => {
      if (Array.isArray(data[key])) data[key] = keepIndexes.map(index => data[key][index])
    })
  }))
}

function assertHistoryImagesAvailable(trees) {
  let unavailable = null
  trees.forEach(tree =>
    walkNodes(tree, node => {
      if (unavailable) return
      const data = node && node.data
      const image = data && data.image
      if (typeof image !== 'string' || !/^smm_img_key_/.test(image)) return
      unavailable = {
        uid: data.uid == null ? '' : String(data.uid),
        imageKey: image
      }
    })
  )
  if (!unavailable) return
  const error = historyError(
    'HISTORY_IMAGE_UNAVAILABLE',
    '所选历史分支引用的图片在该历史版本中不可用，请选择其他分支后重试'
  )
  error.uid = unavailable.uid
  error.imageKey = unavailable.imageKey
  throw error
}

/** Return independent selected branch copies with full descendants and history images. */
export function extractHistoryBranches(snapshot, uids) {
  const { internals, roots } = selectionRoots(snapshot, uids)
  const trees = roots
    .map(record => cleanNestedNode(record.node, internals.imgMap))
    .filter(Boolean)
  // Keep structural snapshots faithful even when a historical image resource is
  // missing, but never let paste resolve that private key from the current map.
  // Validate only the selected subtrees so unrelated unavailable images do not
  // prevent copying a different, image-free branch.
  assertHistoryImagesAvailable(trees)
  const included = new Set()
  trees.forEach(tree => {
    walkNodes(tree, node => {
      const uid = node.data && node.data.uid
      if (uid != null && String(uid)) included.add(String(uid))
    })
  })
  filterAssociativeLines(trees, included)
  return {
    trees,
    branchCount: roots.length,
    nodeCount: roots.reduce((sum, record) => sum + record.nodeCount, 0)
  }
}
