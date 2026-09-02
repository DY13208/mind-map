const LARGE_NODE_THRESHOLD = 100
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
  const stack = root ? [root] : []
  while (stack.length) {
    const node = stack.pop()
    if (!node) continue
    count += 1
    const children = node.children || []
    for (let i = 0; i < children.length; i++) {
      stack.push(children[i])
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
