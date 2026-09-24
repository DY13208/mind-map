const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const esbuild = require('../node_modules/esbuild')

const source = fs.readFileSync(path.join(__dirname, '../src/utils/historyTree.js'), 'utf8')
const code = esbuild.transformSync(source, { format: 'cjs', loader: 'js' }).code
const moduleRef = { exports: {} }
vm.runInNewContext(code, { module: moduleRef, exports: moduleRef.exports, require })
const { historyGraphToMindMap, withExpandMode } = moduleRef.exports

const countVisible = root => {
  let count = 0
  const stack = [root]
  while (stack.length) {
    const node = stack.pop()
    count++
    if (node.data.expand !== false) stack.push(...(node.children || []))
  }
  return count
}

const graph = { data: { uid: 'root', text: 'root' }, children: [] }
for (let i = 0; i < 20; i++) {
  const branch = { data: { uid: `branch-${i}`, text: `branch ${i}` }, children: [] }
  for (let j = 0; j < 500; j++) {
    branch.children.push({ data: { uid: `leaf-${i}-${j}`, text: 'leaf' }, children: [] })
  }
  graph.children.push(branch)
}
const full = historyGraphToMindMap(graph)
const overview = withExpandMode(full, 'overview')
assert.equal(countVisible(overview), 21)
assert.equal(overview.children[0].children.length, 500)
assert.equal(full.children[0].data.expand, true)
assert.equal(countVisible(withExpandMode(full, 'expanded')), 10021)
console.log('PASS: history overview shows only root branches and retains all 10,021 nodes')
