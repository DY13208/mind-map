// Optional diagnostic sink. No protocol fields, persistence or logging by default.
function enabled() {
  return typeof globalThis !== 'undefined' &&
    typeof globalThis.__COLLAB_PERF_OBSERVER__ === 'function'
}
function record(kind, details = {}) {
  if (!enabled()) return
  try {
    globalThis.__COLLAB_PERF_OBSERVER__({ kind, atMs: Date.now(), ...details })
  } catch (_) {
    // Diagnostics must never reject or interrupt collaboration.
  }
}
function treeShape(root) {
  let visibleNodes = 0, maxDepth = 0, branches = 0, maxChildren = 0
  const stack = root ? [[root, 0]] : []
  while (stack.length) {
    const [node, depth] = stack.pop()
    visibleNodes++
    maxDepth = Math.max(maxDepth, depth)
    if (node.data && node.data.expand === false) continue
    const children = node.children || []
    if (children.length) branches++
    maxChildren = Math.max(maxChildren, children.length)
    for (const child of children) stack.push([child, depth + 1])
  }
  return { visibleNodes, maxDepth, branches, maxChildren }
}
module.exports = { enabled, record, treeShape }
