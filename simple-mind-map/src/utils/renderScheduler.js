// Cooperative work queue. A frame budget limits JS work, not elapsed job time.
export const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now()

export function runSteps(step, { budget = 8, valid = () => true, progress = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    let completed = 0
    const tick = () => {
      if (!valid()) return resolve(false)
      const start = now()
      try {
        do {
          if (!valid()) return resolve(false)
          if (step() === false) return resolve(true)
          completed++
        } while (now() - start < budget)
        progress(completed)
        setTimeout(tick, 0)
      } catch (error) {
        reject(error)
      }
    }
    // Let loading state and cancellation controls paint before expensive work.
    setTimeout(tick, 0)
  })
}

// Keep pre/post order and pruning semantics of utils.walk, without recursion.
export function walkSteps(root, parent, before, after, isRoot, depth = 0, index = 0, ancestors = []) {
  const stack = root ? [{ node: root, parent, isRoot, depth, index, ancestors, entered: false, next: 0 }] : []
  return () => {
    if (!stack.length) return false
    const frame = stack[stack.length - 1]
    const args = [frame.node, frame.parent, frame.isRoot, frame.depth, frame.index, frame.ancestors]
    if (!frame.entered) {
      frame.entered = true
      frame.stop = before && before(...args)
      return true
    }
    const children = frame.node.children || []
    if (!frame.stop && frame.next < children.length) {
      const childIndex = frame.next++
      stack.push({ node: children[childIndex], parent: frame.node, isRoot: false,
        depth: frame.depth + 1, index: childIndex, ancestors: [...frame.ancestors, frame.node], entered: false, next: 0 })
    } else {
      if (after) after(...args)
      stack.pop()
    }
    return true
  }
}
