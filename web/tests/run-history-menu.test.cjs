const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')
const compiler = require('vue-template-compiler')

const components = path.join(__dirname, '../src/pages/Edit/components')
const toolbar = compiler.parseComponent(
  fs.readFileSync(path.join(components, 'Toolbar.vue'), 'utf8')
)
const navigator = compiler.parseComponent(
  fs.readFileSync(path.join(components, 'NavigatorToolbar.vue'), 'utf8')
)

assert.deepEqual(compiler.compile(toolbar.template.content).errors, [])
assert.deepEqual(compiler.compile(navigator.template.content).errors, [])
assert.equal(toolbar.template.content.includes('data-testid="run-workbuddy-history"'), false)
assert.match(navigator.template.content, /<el-dropdown trigger="click"/)
assert.match(navigator.template.content, /data-testid="run-workbuddy-history"/)
assert.match(navigator.template.content, /command="jobHistory"/)
assert.match(toolbar.script.content, /\$on\('open_workbuddy_job_history', this\.openJobHistory\)/)
assert.match(toolbar.script.content, /\$off\('open_workbuddy_job_history', this\.openJobHistory\)/)

const { code } = babel.transformSync(navigator.script.content, {
  babelrc: false,
  configFile: false,
  plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', code)(name => {
  if (name === 'vuex') return { mapState: () => ({}), mapMutations: () => ({}) }
  if (name === 'simple-mind-map/package.json') return { version: 'test' }
  if (name === '@/config') return { langList: [] }
  return {}
}, mod, mod.exports)

const events = []
mod.exports.default.methods.handleCommand.call(
  { $bus: { $emit: name => events.push(name) } },
  'jobHistory'
)
assert.deepEqual(events, ['open_workbuddy_job_history'])
console.log('运行历史已移至底部更多菜单，点击可通知原历史面板')
