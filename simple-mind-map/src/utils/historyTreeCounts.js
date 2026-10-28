'use strict'

/**
 * Historical snapshots are complete trees. Their lazy-loading counters are
 * presentation metadata, so derive them from the stored child relationships.
 * This module deliberately does not touch the live-map counter helpers.
 */

function historyTreeError(message, code = 'HISTORY_SNAPSHOT_INVALID') {
  const error = new Error(message)
  error.code = code
  return error
}

function isObject(value) {
  return value !== null && typeof value === 'object'
}

function cloneContainer(value) {
  return Array.isArray(value)
    ? []
    : Object.create(
        Object.getPrototypeOf(value) === null ? null : Object.prototype
      )
}

function copyProperty(target, key, value) {
  // Assignment is substantially cheaper for the ordinary JSON keys that make
  // up a snapshot. Keep the one special key explicit so it stays an own data
  // property instead of changing the target object's prototype.
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true
    })
    return
  }
  target[key] = value
}

// Clone JSON-shaped API data iteratively. Besides avoiding call-stack limits,
// preserving cycles here lets the shape validator report them consistently.
function cloneValue(root) {
  if (!isObject(root)) return root
  const copies = new Map()
  const copyRoot = cloneContainer(root)
  copies.set(root, copyRoot)
  const pending = [[root, copyRoot]]

  while (pending.length) {
    const [source, target] = pending.pop()
    Object.keys(source).forEach(key => {
      const value = source[key]
      if (!isObject(value)) {
        copyProperty(target, key, value)
        return
      }
      let childCopy = copies.get(value)
      if (!childCopy) {
        childCopy = cloneContainer(value)
        copies.set(value, childCopy)
        pending.push([value, childCopy])
      }
      copyProperty(target, key, childCopy)
    })
  }
  return copyRoot
}

function requireData(data, uid) {
  if (!isObject(data) || Array.isArray(data)) {
    throw historyTreeError(`历史版本节点 ${uid || ''} 的 data 格式无效`)
  }
  return data
}

function normalizeGraph(graph) {
  if (!isObject(graph) || Array.isArray(graph)) {
    throw historyTreeError('历史版本节点图格式无效')
  }
  const uids = Object.keys(graph)
  if (!uids.length) return cloneValue(graph)

  const roots = uids.filter(uid => graph[uid] && graph[uid].isRoot === true)
  if (roots.length !== 1) {
    throw historyTreeError('历史版本节点图必须恰好包含一个根节点')
  }

  const parentByUid = new Map()
  for (const uid of uids) {
    const node = graph[uid]
    if (!isObject(node) || Array.isArray(node)) {
      throw historyTreeError(`历史版本节点 ${uid} 格式无效`)
    }
    const data = requireData(node.data, uid)
    if (data.uid != null && String(data.uid) !== uid) {
      throw historyTreeError(`历史版本节点 ${uid} 的 UID 不匹配`)
    }
    const children = node.children
    if (!Array.isArray(children)) {
      throw historyTreeError(`历史版本节点 ${uid} 的子节点列表无效`)
    }
    const localChildren = new Set()
    for (const childUid of children) {
      if (
        typeof childUid !== 'string' ||
        !Object.prototype.hasOwnProperty.call(graph, childUid)
      ) {
        throw historyTreeError(`历史版本包含不存在的子节点 ${String(childUid)}`)
      }
      if (localChildren.has(childUid)) {
        throw historyTreeError(`历史版本节点 ${uid} 重复引用子节点 ${childUid}`)
      }
      localChildren.add(childUid)
      if (parentByUid.has(childUid)) {
        throw historyTreeError(`历史版本节点 ${childUid} 被多个父节点引用`)
      }
      parentByUid.set(childUid, uid)
    }
  }

  const rootUid = roots[0]
  if (parentByUid.has(rootUid)) {
    throw historyTreeError('历史版本根节点不能有父节点')
  }

  const state = new Map()
  const postorder = []
  const stack = [{ uid: rootUid, exit: false }]
  while (stack.length) {
    const frame = stack.pop()
    if (frame.exit) {
      state.set(frame.uid, 2)
      postorder.push(frame.uid)
      continue
    }
    const current = state.get(frame.uid) || 0
    if (current === 1)
      throw historyTreeError(`历史版本节点图存在循环：${frame.uid}`)
    if (current === 2)
      throw historyTreeError(`历史版本节点 ${frame.uid} 被重复访问`)
    state.set(frame.uid, 1)
    stack.push({ uid: frame.uid, exit: true })
    const children = graph[frame.uid].children || []
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({ uid: children[index], exit: false })
    }
  }
  if (postorder.length !== uids.length) {
    const unreachable = uids.find(uid => !state.has(uid))
    throw historyTreeError(`历史版本包含不可达节点：${unreachable || ''}`)
  }

  const normalized = cloneValue(graph)
  const descendants = new Map()
  for (const uid of postorder) {
    const source = graph[uid]
    const children = source.children || []
    let total = 0
    for (const childUid of children) total += 1 + descendants.get(childUid)
    const node = normalized[uid]
    node.children = children.slice()
    const data = node.data
    data.uid = uid
    data.childCount = children.length
    data.descendantCount = total
    delete data.hasMore
    node.data = data
    descendants.set(uid, total)
  }

  // Generalization children are stored inside node data instead of the main
  // graph's children links. Walk the original cloned summary forest directly,
  // keeping its counts separate from the owning business node.
  const summaryGroups = []
  for (const uid of uids) {
    const raw = normalized[uid].data.generalization
    const groups = Array.isArray(raw) ? raw : raw ? [raw] : []
    groups.forEach(group => summaryGroups.push(group))
  }
  if (summaryGroups.length) {
    normalizeNestedForest(
      summaryGroups.map(node => ({
        node,
        countSelf: false,
        allowNoChildren: true
      })),
      new Set(uids)
    )
  }
  return normalized
}

function normalizeNestedForest(roots, reservedUids = new Set()) {
  const seenObjects = new Set()
  const incoming = new Map()
  const seenUids = new Set(reservedUids)
  const postorder = []
  const stack = roots.map(root => ({ ...root, exit: false }))

  while (stack.length) {
    const frame = stack.pop()
    const node = frame.node
    if (frame.exit) {
      postorder.push(frame)
      continue
    }
    if (!isObject(node) || Array.isArray(node)) {
      throw historyTreeError('历史版本包含无效节点')
    }
    if (seenObjects.has(node)) {
      throw historyTreeError('历史版本节点存在循环或被多个父节点引用')
    }
    seenObjects.add(node)

    const data = frame.countSelf ? requireData(node.data, '') : node
    if (frame.countSelf) {
      const uid = data.uid == null ? '' : String(data.uid)
      if (!uid) throw historyTreeError('历史版本节点缺少 UID')
      if (seenUids.has(uid)) {
        throw historyTreeError(
          `历史版本包含重复节点 UID：${uid}`,
          'HISTORY_DUPLICATE_NODE_UID'
        )
      }
      seenUids.add(uid)
    }

    const children =
      frame.allowNoChildren &&
      !Object.prototype.hasOwnProperty.call(node, 'children')
        ? []
        : node.children
    if (!Array.isArray(children))
      throw historyTreeError('历史版本节点的子节点列表无效')
    const localChildren = new Set()
    for (const child of children) {
      if (!isObject(child) || Array.isArray(child)) {
        throw historyTreeError('历史版本包含无效子节点')
      }
      if (localChildren.has(child))
        throw historyTreeError('历史版本父节点重复引用子节点')
      localChildren.add(child)
      const count = (incoming.get(child) || 0) + 1
      incoming.set(child, count)
      if (count > 1) throw historyTreeError('历史版本节点被多个父节点引用')
    }

    stack.push({ ...frame, exit: true, children, data })
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({ node: children[index], countSelf: true, exit: false })
    }

    if (frame.countSelf) {
      const raw = data.generalization
      const groups = Array.isArray(raw) ? raw : raw ? [raw] : []
      for (let index = groups.length - 1; index >= 0; index--) {
        const group = groups[index]
        if (!isObject(group) || Array.isArray(group)) {
          throw historyTreeError('历史版本概要节点格式无效')
        }
        stack.push({
          node: group,
          countSelf: false,
          allowNoChildren: true,
          exit: false
        })
      }
    }
  }

  const descendants = new Map()
  for (const frame of postorder) {
    const { node, countSelf, children, data } = frame
    let total = 0
    for (const child of children) {
      total += 1 + descendants.get(child)
    }
    const target = countSelf ? node.data : node
    target.childCount = children.length
    target.descendantCount = total
    delete target.hasMore
    descendants.set(node, total)
  }
}

function normalizeTree(tree) {
  if (!isObject(tree) || Array.isArray(tree)) {
    throw historyTreeError('历史版本树格式无效')
  }

  const normalized = cloneValue(tree)
  normalizeNestedForest([{ node: normalized, countSelf: true }])
  return normalized
}

function normalizeHistoryGraph(graph) {
  return normalizeGraph(graph)
}

function normalizeHistoryTree(tree) {
  return normalizeTree(tree)
}

module.exports = { normalizeHistoryGraph, normalizeHistoryTree }
