const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const babel = require('@babel/core')
const api = {}
const { code } = babel.transformSync(fs.readFileSync(path.join(__dirname, '../src/utils/knowledgeFiles.js'), 'utf8'), { babelrc: false, configFile: false, plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')] })
const mod = { exports: {} }
new Function('require', 'module', 'exports', code)(() => api, mod, mod.exports)
const { readNodeKnowledgeFullText, appendKnowledgeFullText, collectKnowledgeFileReferences } = mod.exports
const file = { id: 'file-a', name: '完整正文.txt', status: 'done', parseVersion: 3, currentRunId: 'run-3' }
const node = { data: { knowledgeFiles: [{ id: file.id, name: file.name, extractedText: '旧摘要' }] } }
const original = JSON.stringify(node)
async function run() {
  const cursors = []
  api.getFile = async () => ({ ...file })
  api.getBlocks = async (id, { cursor }) => {
    cursors.push(cursor)
    return cursor ? { items: [{ text: '末页唯一内容', page: 9 }], nextCursor: null } : { items: [{ text: '完整正文'.repeat(3000), page: 1 }], nextCursor: 'page-2' }
  }
  const result = await readNodeKnowledgeFullText(node)
  assert.deepEqual(cursors, [null, 'page-2'])
  assert.ok(result.text.includes('末页唯一内容'))
  assert.ok(result.text.includes('完整正文'.repeat(3000)), 'full text must not pass through old 2400/3000/6000 character limits')
  assert.ok(!result.text.includes('旧摘要'))
  assert.equal(JSON.stringify(node), original, 'full text is not persisted into nodes')
  assert.ok((await appendKnowledgeFullText('运行任务', node)).startsWith('运行任务\n\n'))
  await assert.rejects(readNodeKnowledgeFullText(node, { maxChars: 1000 }), error => error.code === 'KNOWLEDGE_CONTEXT_LIMIT')
  api.getBlocks = async () => { throw new Error('权限已撤销') }
  await assert.rejects(appendKnowledgeFullText('不得派发', node), /权限已撤销/)
  let reads = 0
  api.getFile = async () => ({ ...file, parseVersion: ++reads })
  api.getBlocks = async () => ({ items: [{ text: '内容' }], nextCursor: null })
  await assert.rejects(readNodeKnowledgeFullText(node), /重新解析/)
  api.getFile = async () => ({ ...file, status: 'processing' })
  await assert.rejects(readNodeKnowledgeFullText(node), /尚未完成解析/)
  api.getFile = async () => ({ ...file })
  api.getBlocks = async () => ({ items: [], nextCursor: 'repeated' })
  await assert.rejects(readNodeKnowledgeFullText(node), /分页异常/)
  api.getFile = async () => ({ ...file, ext: 'xlsx' })
  api.getBlocks = async () => ({ items: [{ text: '表头' }], nextCursor: null })
  api.listRecords = async ({ cursor }) => cursor ? { items: [{ data: { SKU: '末行SKU' } }], nextCursor: null } : { items: [{ data: { SKU: '首行SKU' } }], nextCursor: 'record-page-2' }
  const sheet = await readNodeKnowledgeFullText(node)
  assert.ok(sheet.text.includes('首行SKU') && sheet.text.includes('末行SKU'))
  const parent = { data: node.data }, child = { data: node.data, parent }
  parent.children = [child]
  assert.equal(collectKnowledgeFileReferences(child, { includeDescendants: true }).length, 1)
  assert.equal(await appendKnowledgeFullText('无附件任务', { data: {} }), '无附件任务')
  // Exercise the real copy-to-AI entry, including hide() clearing its node.
  api.getFile = async () => ({ ...file })
  api.getBlocks = async () => ({ items: [{ text: '复制入口必须带上的完整正文' }], nextCursor: null })
  const compiler = require('vue-template-compiler')
  const source = compiler.parseComponent(fs.readFileSync(path.join(__dirname, '../src/pages/Edit/components/Contextmenu.vue'), 'utf8'))
  const transformed = babel.transformSync(source.script.content, { babelrc: false, configFile: false, plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')] }).code
  const componentModule = { exports: {} }
  new Function('require', 'module', 'exports', transformed)(name => {
    if (name === '@/utils/knowledgeFiles') return mod.exports
    if (name === 'vuex') return { mapState: () => ({}), mapMutations: () => ({}) }
    return {}
  }, componentModule, componentModule.exports)
  let copied = '', readError = ''
  const copyVm = { node, getNodeAiReference: () => '节点引用', hide() { this.node = null }, copyAiInstruction: async text => { copied = text }, $message: { error: message => { readError = message } } }
  await componentModule.exports.default.methods.copyNodeForAi.call(copyVm)
  assert.equal(copied, '节点引用')
  api.getBlocks = async () => { throw new Error('读取失败') }
  copied = ''; copyVm.node = node
  await componentModule.exports.default.methods.copyNodeForAi.call(copyVm)
  assert.equal(copied, '节点引用', 'copying a reference must not depend on reading file content')
  assert.equal(readError, '')
  console.log('Full KB context tests passed: pagination, complete text, records, access failure, limits, parse consistency, deduplication')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
