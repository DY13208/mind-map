// Personal view flags never belong in the shared node table.
export function stripPersonalNodeView(table) {
  const result = {}
  for (const [uid, row] of Object.entries(table || {})) {
    const data = { ...(row.data || {}) }
    delete data.expand
    delete data.isActive
    if (data.generalization) {
      data.generalization = JSON.parse(JSON.stringify(data.generalization))
      const stack = Array.isArray(data.generalization) ? [...data.generalization] : [data.generalization]
      while (stack.length) {
        const node = stack.pop()
        if (!node) continue
        const fields = node.data || node
        delete fields.expand
        delete fields.isActive
        for (const child of node.children || []) stack.push(child)
        const summaries = fields.generalization
        if (summaries) for (const child of Array.isArray(summaries) ? summaries : [summaries]) stack.push(child)
      }
    }
    result[uid] = { ...row, data }
  }
  return result
}

export function preservePersonalNodeView(tree, currentTree) {
  const flags = new Map()
  const walk = (root, visit) => {
    const stack = root ? [root] : []
    while (stack.length) {
      const node = stack.pop()
      if (!node) continue
      visit(node)
      for (const child of node.children || []) stack.push(child)
      const data = node.data || node
      if (data.generalization) {
        for (const child of Array.isArray(data.generalization) ? data.generalization : [data.generalization]) stack.push(child)
      }
    }
  }
  walk(currentTree, node => {
    const data = node.data || node
    if (data.uid) flags.set(data.uid, data.expand !== false)
  })
  walk(tree, node => {
    const data = node.data || node
    if (flags.has(data.uid)) data.expand = flags.get(data.uid)
    else delete data.expand
  })
  return tree
}

export function isPersonalViewCommand(name, args = []) {
  if (['SET_NODE_EXPAND', 'EXPAND_ALL', 'UNEXPAND_ALL', 'UNEXPAND_TO_LEVEL'].includes(name)) return true
  const patch = name === 'SET_NODE_DATA' && args[1]
  return !!(patch && Object.keys(patch).length && Object.keys(patch).every(key => key === 'expand' || key === 'isActive'))
}
