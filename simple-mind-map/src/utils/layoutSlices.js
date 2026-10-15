// Yield a macrotask so input/paint and timers can run between slices. A fresh
// MessageChannel per yield avoids the nested-setTimeout 4ms clamp; both ports
// are closed as soon as the message is delivered, so no port/listener survives
// an idle slicer (important in Node, where an open MessageChannel keeps the
// event loop alive). Falls back to setTimeout where MessageChannel is missing.
function yieldToEventLoop() {
  if (typeof MessageChannel === 'undefined') {
    return new Promise(resolve => setTimeout(resolve, 0))
  }
  return new Promise(resolve => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.onmessage = null
      channel.port1.close()
      channel.port2.close()
      resolve()
    }
    channel.port2.postMessage(0)
  })
}

// Preserve DFS enter/exit order while giving input and paint a turn between slices.
export async function runWorkInSlices(iterator, options = {}) {
  const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now()
  let started = now()
  let pending = true
  while (pending) {
    if (options.cancelled && options.cancelled()) return false
    pending = !iterator.next().done
    if (pending && now() - started >= (options.budgetMs || 8)) {
      await yieldToEventLoop()
      started = now()
    }
  }
  return true
}

export async function walkLayoutInSlices(args, options = {}) {
  const [root, parent, before, after, isRoot, depth = 0, index = 0, ancestors = []] = args
  const stack = [{ node: root, parent, isRoot, depth, index, ancestors, exit: false }]
  const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now()
  let started = now()
  while (stack.length) {
    if (options.cancelled && options.cancelled()) return false
    const frame = stack.pop()
    const { node, parent, isRoot, depth, index, ancestors } = frame
    if (frame.exit) {
      if (after) after(node, parent, isRoot, depth, index, ancestors)
    } else {
      const stop = before && before(node, parent, isRoot, depth, index, ancestors)
      stack.push({ ...frame, exit: true })
      if (!stop && node.children) {
        for (let i = node.children.length - 1; i >= 0; i--) {
          stack.push({ node: node.children[i], parent: node, isRoot: false, depth: depth + 1, index: i, ancestors: [...ancestors, node], exit: false })
        }
      }
    }
    if (now() - started >= (options.budgetMs || 8)) {
      await yieldToEventLoop()
      started = now()
    }
  }
  return true
}
