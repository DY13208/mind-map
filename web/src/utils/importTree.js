const LARGE_NODE_THRESHOLD = 100
const KEEP_EXPAND_DEPTH = 2
const MAX_IMPORT_FANOUT = 48
const MAX_DISPLAY_NODES = 280
const OVERFLOW_KEY = '_overflowChildren'

export function yieldToUi() {
  return new Promise(resolve => {
    requestAnimationFrame(() => {
      requestAnimationFrame(resolve)
    })
  })
}

export function countNodes(root) {
  let count = 0
  const stack = root ? [root] : []
  while (stack.length) {
    const node = stack.pop()
    if (!node) continue
    count += 1
    const children = node.children || []
    for (let i = 0; i < children.length; i++) {
      stack.push(children[i])
    }
    const extra =
      node.data && Array.isArray(node.data[OVERFLOW_KEY])
        ? node.data[OVERFLOW_KEY]
        : []
    for (let i = 0; i < extra.length; i++) {
      stack.push(extra[i])
    }
  }
  return count
}

export function collapseDeepNodes(root, keepDepth = KEEP_EXPAND_DEPTH) {
  const stack = root ? [{ node: root, depth: 0 }] : []
  while (stack.length) {
    const { node, depth } = stack.pop()
    if (!node || !node.data) continue
    const children = node.children || []
    if (depth >= keepDepth && children.length > 0) {
      node.data.expand = false
    }
    for (let i = 0; i < children.length; i++) {
      stack.push({ node: children[i], depth: depth + 1 })
    }
  }
}

export function reattachOverflow(root) {
  const stack = root ? [root] : []
  while (stack.length) {
    const node = stack.pop()
    if (!node) continue
    const extra =
      node.data && Array.isArray(node.data[OVERFLOW_KEY])
        ? node.data[OVERFLOW_KEY]
        : null
    if (extra && extra.length) {
      node.children = (node.children || []).concat(extra)
      delete node.data[OVERFLOW_KEY]
    }
    const children = node.children || []
    for (let i = 0; i < children.length; i++) {
      stack.push(children[i])
    }
  }
  return root
}

export function stashOverflowChildren(root, maxChildren = MAX_IMPORT_FANOUT) {
  const stack = root ? [root] : []
  while (stack.length) {
    const node = stack.pop()
    if (!node) continue
    const children = node.children || []
    if (children.length > maxChildren) {
      node.data = node.data || {}
      node.data.childCount = children.length
      node.data.hasMore = true
      node.data[OVERFLOW_KEY] = children.slice(maxChildren)
      node.children = children.slice(0, maxChildren)
    }
    const visible = node.children || []
    for (let i = 0; i < visible.length; i++) {
      stack.push(visible[i])
    }
  }
  return root
}

export function pruneImportedTreeForDisplay(root, nodeCount) {
  if (!root) return root
  const keepDepth = nodeCount >= 500 ? 1 : KEEP_EXPAND_DEPTH
  collapseDeepNodes(root, keepDepth)
  stashOverflowChildren(root, MAX_IMPORT_FANOUT)
  return root
}

export function stubImportedTree(root, options = {}) {
  if (!root) return root
  const keepDepth =
    Number(options.keepDepth) > 0 ? Number(options.keepDepth) : 1
  const maxChildren =
    Number(options.maxChildren) > 0
      ? Number(options.maxChildren)
      : MAX_IMPORT_FANOUT
  const maxNodes =
    Number(options.maxNodes) > 0 ? Number(options.maxNodes) : MAX_DISPLAY_NODES
  let produced = 0
  const walk = (node, depth) => {
    if (!node) return null
    produced += 1
    node.data = node.data || {}
    const children = node.children || []
    const overflow = Array.isArray(node.data[OVERFLOW_KEY])
      ? node.data[OVERFLOW_KEY]
      : []
    const total = children.length + overflow.length
    if (total) node.data.childCount = total
    delete node.data[OVERFLOW_KEY]
    if (produced >= maxNodes || depth >= keepDepth) {
      if (total > 0) {
        node.data.expand = false
        node.data.hasMore = true
      }
      node.children = []
      return node
    }
    const remain = Math.max(0, maxNodes - produced)
    const shown = children.slice(0, Math.min(maxChildren, remain))
    if (children.length > shown.length || overflow.length) {
      node.data.hasMore = true
    }
    node.children = shown.map(child => walk(child, depth + 1)).filter(Boolean)
    return node
  }
  return walk(root, 0)
}

function runJsonWorker(action, payload) {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined') {
    return Promise.resolve(
      action === 'parse' ? JSON.parse(payload) : JSON.stringify(payload)
    )
  }
  return new Promise((resolve, reject) => {
    const source = `
      self.onmessage = function (event) {
        try {
          var action = event.data.action
          var value = event.data.payload
          var result = action === 'parse' ? JSON.parse(value) : JSON.stringify(value)
          self.postMessage({ ok: true, result: result })
        } catch (error) {
          self.postMessage({ ok: false, error: error && error.message ? error.message : String(error) })
        }
      }
    `
    const url = URL.createObjectURL(
      new Blob([source], { type: 'application/javascript' })
    )
    const worker = new Worker(url)
    const cleanup = () => {
      worker.terminate()
      URL.revokeObjectURL(url)
    }
    worker.onmessage = event => {
      cleanup()
      if (event.data.ok) resolve(event.data.result)
      else reject(new Error(event.data.error || 'JSON worker failed'))
    }
    worker.onerror = event => {
      cleanup()
      reject(new Error(event.message || 'JSON worker failed'))
    }
    worker.postMessage({ action, payload })
  })
}

export function parseJsonOffMainThread(text) {
  return runJsonWorker('parse', text)
}

export function stringifyJsonOffMainThread(data) {
  return runJsonWorker('stringify', data)
}

export function prepareImportedTree(data, options = {}) {
  const root = data && data.root ? data.root : data
  if (!root) {
    return { data, nodeCount: 0, collapsed: false }
  }
  reattachOverflow(root)
  const nodeCount = countNodes(root)
  const collapsed = nodeCount >= LARGE_NODE_THRESHOLD
  if (collapsed && options.prune !== false) {
    pruneImportedTreeForDisplay(root, nodeCount)
  }
  return { data, nodeCount, collapsed }
}

export {
  LARGE_NODE_THRESHOLD,
  KEEP_EXPAND_DEPTH,
  MAX_IMPORT_FANOUT,
  MAX_DISPLAY_NODES,
  OVERFLOW_KEY
}
