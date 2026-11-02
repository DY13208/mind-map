const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const babel = require('@babel/core')
function load(api) {
  const { code } = babel.transformSync(fs.readFileSync(path.join(__dirname, '../src/utils/knowledgeFiles.js'), 'utf8'), { babelrc: false, configFile: false, plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')] })
  const module = {exports: {}}
  new Function('require', 'module', 'exports', code)(() => api, module, module.exports)
  return module.exports
}
test('folder mount stores a reference and resolves current paged contents on every read', async () => {
  let files = [{id: 'a', name: 'a.txt'}]
  const api = {
    getFolder: async id => ({id, name: '资料'}),
    listFolderFiles: async (id, {cursor}) => cursor ? {items: files.slice(1)} : {items: files.slice(0, 1), nextCursor: files.length > 1 ? 'next' : null},
    getFile: async id => ({id, name: id + '.txt', status: 'done', parseVersion: 1}),
    getBlocks: async id => ({items: [{text: '正文-' + id}]})
  }
  const helpers = load(api)
  const ref = await helpers.readKnowledgeFileReference({id: 'folder', kind: 'folder'})
  assert.equal(ref.kind, 'folder')
  assert.equal(ref.extractedText, undefined)
  const node = {data: {knowledgeFiles: [ref, {id: 'a'}]}}
  assert.equal((await helpers.readNodeKnowledgeFullText(node)).files.length, 1)
  files.push({id: 'b', name: 'b.txt'})
  const result = await helpers.readNodeKnowledgeFullText(node)
  assert.equal(result.files.length, 2)
  assert.match(result.text, /正文-b/)
  assert.equal(node.data.knowledgeFiles.length, 2, 'resolved files must not replace the folder reference')
  api.listFolderFiles = async () => { throw new Error('权限已撤销') }
  await assert.rejects(helpers.readNodeKnowledgeFullText(node), /权限已撤销/)
})
test('folder pagination loops fail instead of silently reading incomplete contents', async () => {
  const helpers = load({listFolderFiles: async () => ({items: [], nextCursor: 'same'})})
  await assert.rejects(helpers.readNodeKnowledgeFullText({data: {knowledgeFiles: [{id: 'f', kind: 'folder'}]}}), /分页异常/)
})
