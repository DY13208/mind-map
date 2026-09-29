const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const compiler = require('vue-template-compiler')
const esbuild = require('esbuild')

const source = fs.readFileSync(path.join(__dirname, '../src/pages/ProductShell/components/HistoryPanel.vue'), 'utf8')
const script = compiler.parseComponent(source).script.content
const code = esbuild.transformSync(script, { format: 'cjs', loader: 'js' }).code
const componentModule = { exports: {} }
new Function('require', 'module', 'exports', code)(() => ({}), componentModule, componentModule.exports)
const editorText = componentModule.exports.default.methods.editorText

assert.equal(editorText({ type: 'AUTO', createdBy: '查看者', editors: [] }), '编辑者未记录')
assert.equal(editorText({ type: 'auto', createdBy: '查看者' }), '编辑者未记录')
assert.equal(editorText({ type: 'AUTO', createdBy: '查看者', editors: [{ userId: 'alice', name: '实际编辑者' }] }), '实际编辑者')
assert.equal(editorText({ type: 'AUTO', createdBy: '查看者', editors: [{ userId: 'alice', name: '甲' }, { userId: 'bob', name: '乙' }] }), '甲、乙')
assert.equal(editorText({ type: 'MANUAL', createdBy: '标记者', editors: [] }), '标记者')
assert.equal(editorText({ type: 'IMPORT', createdBy: '导入者', editors: [] }), '导入者')
console.log('PASS: automatic history displays actual editors without attributing unknown edits to its viewer')
