const assert = require('node:assert/strict')

function makeTree(count, { shape = 'balanced', expanded = true } = {}) {
  assert.ok(Number.isInteger(count) && count >= 1)
  const root = { data: { uid: 'root', text: 'Root', expand: true }, children: [] }
  if (shape === 'deep') {
    let parent = root
    for (let i = 1; i < count; i++) {
      const node = { data: { uid: `n${i}`, text: `Node ${i}`, expand: expanded }, children: [] }
      parent.children.push(node)
      parent = node
    }
  } else if (shape === 'wide') {
    for (let i = 1; i < count; i++) root.children.push({ data: { uid: `n${i}`, text: `Node ${i}`, expand: expanded }, children: [] })
  } else {
    const queue = [root]
    for (let i = 1; i < count; i++) {
      const node = { data: { uid: `n${i}`, text: `Node ${i}`, expand: expanded }, children: [] }
      queue[Math.floor((i - 1) / 5)].children.push(node)
      queue.push(node)
    }
  }
  return root
}

function inspectTree(root) {
  const stack = [{ node: root, parent: null }]
  const ids = new Set()
  const parents = new Map()
  let edges = 0
  while (stack.length) {
    const { node, parent } = stack.pop()
    assert.ok(node && node.data && node.data.uid)
    assert.ok(!ids.has(node.data.uid), `duplicate UID: ${node.data.uid}`)
    ids.add(node.data.uid)
    parents.set(node.data.uid, parent)
    for (const child of node.children || []) {
      edges++
      stack.push({ node: child, parent: node.data.uid })
    }
  }
  return { count: ids.size, edges, ids, parents }
}

module.exports = { makeTree, inspectTree }
