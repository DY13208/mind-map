function nodeUid(node) {
  if (!node) return ''
  if (typeof node.getData === 'function') {
    return String(node.getData('uid') || node.uid || '')
  }
  if (node.data && node.data.uid) return String(node.data.uid)
  return String(node.uid || '')
}

function childrenOf(node) {
  if (!node) return []
  if (node.nodeData && Array.isArray(node.nodeData.children)) {
    return node.nodeData.children
  }
  return Array.isArray(node.children) ? node.children : []
}

function childUid(item) {
  if (!item) return ''
  if (item.data && item.data.uid) return String(item.data.uid)
  return nodeUid(item)
}

function indexInParent(node) {
  const parent = node && node.parent
  const uid = nodeUid(node)
  if (!uid) return -1
  return childrenOf(parent).findIndex(item => childUid(item) === uid)
}

function collectMovedNodesFromArgs(args = []) {
  const first = args[0]
  const list = []
  if (Array.isArray(first)) first.forEach(node => list.push(node))
  else if (first) list.push(first)
  return list.filter(node => node && !node.isRoot && !node.isGeneralization)
}

function snapshotMoveOrigins(args = []) {
  return collectMovedNodesFromArgs(args)
    .map(node => {
      const uid = nodeUid(node)
      const parent = nodeUid(node.parent)
      const index = indexInParent(node)
      return {
        uid,
        parent,
        index: index < 0 ? 0 : index,
        node
      }
    })
    .filter(item => item.uid && item.parent)
}

function collectMovesAfterCommand(name, args = []) {
  const nodes = collectMovedNodesFromArgs(args)
  let parentNode = null
  if (name === 'MOVE_NODE_TO') parentNode = args[1]
  else if (name === 'INSERT_AFTER' || name === 'INSERT_BEFORE') {
    parentNode = args[1] && args[1].parent
  } else if (name === 'MOVE_UP_ONE_LEVEL') {
    parentNode = nodes[0] && nodes[0].parent
  }
  return nodes
    .map(node => {
      const parent = parentNode || node.parent
      const uid = nodeUid(node)
      const parentUid = nodeUid(parent)
      const kids = childrenOf(parent)
      const index = kids.findIndex(item => childUid(item) === uid)
      return {
        uid,
        parent: parentUid,
        index: index < 0 ? 0 : index,
        node
      }
    })
    .filter(item => item.uid && item.parent)
}

function containsUid(treeNode, uid) {
  if (!treeNode || !uid) return false
  const kids = treeNode.children || []
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i]
    if (childUid(child) === uid) return true
    if (containsUid(child, uid)) return true
  }
  return false
}

function isCycleMove(node, parentUid) {
  const uid = nodeUid(node)
  const parent = String(parentUid || '')
  if (!uid || !parent) return false
  if (uid === parent) return true
  return containsUid(node.nodeData || node, parent)
}

function remainingSiblings(kids, uid) {
  return (kids || []).filter(item => childUid(item) && childUid(item) !== uid)
}

function connectorSlots(children, expand, childCount) {
  const live = Array.isArray(children) ? children.length : 0
  if (live > 0) return live
  if (expand === false) return Number(childCount) || 0
  return 0
}

function planNativeMove({ uid, parentUid, index, parentKids, oldParentUid }) {
  const remaining = remainingSiblings(parentKids, uid)
  const sameParent = !!(oldParentUid && parentUid && oldParentUid === parentUid)
  const kind = sameParent ? 'reorder' : 'move'
  if (!remaining.length) {
    return {
      kind,
      command: 'MOVE_NODE_TO',
      parentUid,
      index: 0
    }
  }
  const raw = Number(index)
  const slot = Number.isInteger(raw) ? raw : remaining.length
  const clamped = Math.max(0, Math.min(slot, remaining.length))
  if (clamped >= remaining.length) {
    const last = remaining[remaining.length - 1]
    return {
      kind,
      command: 'INSERT_AFTER',
      parentUid,
      anchorUid: childUid(last),
      index: remaining.length
    }
  }
  const anchor = remaining[clamped]
  return {
    kind,
    command: 'INSERT_BEFORE',
    parentUid,
    anchorUid: childUid(anchor),
    index: clamped
  }
}

const api = {
  nodeUid,
  childrenOf,
  childUid,
  indexInParent,
  collectMovedNodesFromArgs,
  snapshotMoveOrigins,
  collectMovesAfterCommand,
  containsUid,
  isCycleMove,
  remainingSiblings,
  connectorSlots,
  planNativeMove
}

module.exports = api
module.exports.default = api
