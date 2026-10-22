const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')
const compiler = require('vue-template-compiler')
const source = fs.readFileSync(path.join(__dirname, '../src/pages/Edit/components/Contextmenu.vue'), 'utf8')
const parsed = compiler.parseComponent(source)
assert.deepEqual(compiler.compile(parsed.template.content).errors, [])
const { code } = babel.transformSync(parsed.script.content, {
  babelrc: false, configFile: false,
  plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', code)(name => {
  if (name === 'vuex') return { mapState: () => ({}), mapMutations: () => ({}) }
  return {}
}, mod, mod.exports)
const component = mod.exports.default

async function main() {
  for (const editable of [true, false]) {
    const nodeTemplate = parsed.template.content.split(`<template v-if="type === 'node' && ${editable ? 'editable' : '!editable'}">`)[1].split('</template>')[0]
    const expandAll = nodeTemplate.indexOf("exec('EXPAND_ALL')")
    const localLevels = nodeTemplate.indexOf('data-testid="expand-node-to-level"')
    assert.ok(expandAll >= 0 && localLevels > expandAll)
    assert.ok(!nodeTemplate.slice(expandAll, localLevels).includes('splitLine'), 'local level entry directly follows expand all')
    for (let depth = 1; depth <= 6; depth++) {
      const calls = []
      const instance = {
        ...component.methods, editable, type: 'node', node: { uid: 'selected-branch' },
        resolveLiveSelectedNodes: () => [], hide() {},
        commandExecutor: (...args) => calls.push(args)
      }
      await instance.exec('UNEXPAND_TO_LEVEL', false, depth)
      assert.deepEqual(calls, [['UNEXPAND_TO_LEVEL', depth, 'selected-branch']])
    }
  }
  const calls = []
  const canvas = {
    ...component.methods, editable: false, type: 'svg', node: '',
    resolveLiveSelectedNodes: () => [], hide() {},
    commandExecutor: (...args) => calls.push(args)
  }
  await canvas.exec('UNEXPAND_TO_LEVEL', false, 3)
  assert.deepEqual(calls, [['UNEXPAND_TO_LEVEL', 3, '']], 'canvas expansion keeps global scope')
  assert.equal(component.computed.expandList.call({ $t: key => key }).length, 6)
  console.log('PASS: local level menu placement, six levels, editable/readonly routing, global scope, Vue compilation')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
