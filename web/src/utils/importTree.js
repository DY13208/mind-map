const LARGE_NODE_THRESHOLD = 400
const KEEP_EXPAND_DEPTH = 2

export function yieldToUi() {
  return new Promise(resolve => {
    requestAnimationFrame(() => {
      requestAnimationFrame(resolve)
    })
  })
}

export function countNodes(root) {
  let count = 0
  const walk = node => {
    if (!node) return
    count += 1
    const children = node.children || []
    for (let i = 0; i < children.length; i++) {
      walk(children[i])
    }
  }
  walk(root)
  return count
}

export function collapseDeepNodes(root, keepDepth = KEEP_EXPAND_DEPTH) {
  const walk = (node, depth) => {
    if (!node || !node.data) return
    const children = node.children || []
    if (depth >= keepDepth && children.length > 0) {
      node.data.expand = false
    }
    for (let i = 0; i < children.length; i++) {
      walk(children[i], depth + 1)
    }
  }
  walk(root, 0)
}

export function prepareImportedTree(data) {
  const root = data && data.root ? data.root : data
  if (!root) {
    return { data, nodeCount: 0, collapsed: false }
  }
  const nodeCount = countNodes(root)
  const collapsed = nodeCount >= LARGE_NODE_THRESHOLD
  if (collapsed) {
    collapseDeepNodes(root, KEEP_EXPAND_DEPTH)
  }
  return { data, nodeCount, collapsed }
}
