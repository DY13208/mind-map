// Preserve DFS enter/exit order while giving input and paint a turn between slices.
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
      await new Promise(resolve => setTimeout(resolve, 0))
      started = now()
    }
  }
  return true
}
