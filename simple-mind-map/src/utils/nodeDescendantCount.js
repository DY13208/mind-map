/* global module:readonly */

function getChildren(node) {
  const renderedChildren = Array.isArray(node && node.children)
    ? node.children
    : []
  const rawChildren = Array.isArray(
    node && node.nodeData && node.nodeData.children
  )
    ? node.nodeData.children
    : []
  // Render instances can contain only mounted children of the raw subtree.
  const children = node && node.nodeData ? rawChildren : renderedChildren
  const data = getNodeData(node)
  return children.concat(Array.isArray(data._overflowChildren)
    ? data._overflowChildren : [])
}

function getNodeData(node) {
  return (
    (node && node.nodeData && node.nodeData.data) ||
    (node && node.data) ||
    node ||
    {}
  )
}

function getKnownChildCount(node) {
  const count = Number(getNodeData(node).childCount)
  return Number.isFinite(count) && count > 0 ? count : 0
}

function descendantStats(node) {
  const data = getNodeData(node)
  const children = getChildren(node)
  const nested = children.map(descendantStats)
  const loadedCount = nested.reduce((sum, item) => sum + 1 + item.count, 0)
  const complete = children.length >= getKnownChildCount(node) &&
    !data.hasMore && nested.every(item => item.complete)
  const authoritative = Number(data.descendantCount)
  const hasAuthority = data.descendantCount != null &&
    Number.isInteger(authoritative) && authoritative >= 0
  return {
    count: complete ? loadedCount : hasAuthority
      ? authoritative : Math.max(loadedCount, getKnownChildCount(node)),
    complete
  }
}

function getDescendantCount(node) {
  return descendantStats(node).count
}

// descendantCount covers unloaded levels; childCount is only a legacy fallback.
function countDescendants(nodes = []) {
  if (!Array.isArray(nodes)) return 0
  return nodes.reduce((total, node) => {
    return total + 1 + getDescendantCount(node)
  }, 0)
}

const api = {
  getChildren,
  getKnownChildCount,
  getDescendantCount,
  countDescendants
}

module.exports = api
module.exports.default = api
