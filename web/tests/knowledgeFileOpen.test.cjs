const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), babel = require('@babel/core')
function load(relative, imports = {}) {
  let source = fs.readFileSync(path.join(__dirname, '../src', relative), 'utf8')
  if (relative.endsWith('.vue')) source = require('vue-template-compiler').parseComponent(source).script.content
  const {code} = babel.transformSync(source, {babelrc:false, configFile:false, plugins:[require.resolve('@babel/plugin-transform-modules-commonjs')]})
  const module = {exports:{}}
  new Function('require','module','exports', code)(name => imports[name] || {}, module, module.exports)
  return module.exports
}
test('mounted file links open source view and ignore stale persisted URLs', () => {
  const utils = load('utils/knowledgeFiles.js')
  assert.equal(utils.knowledgeFileUrl({id:'file/a', url:'https://untrusted.invalid'}), '/kb/parse?shell=full&view=source&file=file%2Fa')
})
test('HTML files use rendered HTML preview rather than plain source text', () => {
  const format = load('features/knowledge-base/utils/format.js')
  assert.equal(format.fileKind({name:'公司经营看板.html', mime:'text/html'}), 'html')
  assert.equal(format.fileKind({name:'notes.txt', mime:'text/plain'}), 'text')
})
test('HTML preview fetches original bytes and templates compile with an isolated frame', async () => {
  const original = '<html><body><h1>经营看板</h1><script>document.title="看板"</script></body></html>'
  const component = load('features/knowledge-base/components/KbSourcePreview.vue', {
    '@/features/knowledge-base/services/kbApi': {},
    '../services/kbApi': {getRaw: async () => new TextEncoder().encode(original).buffer},
    '@/utils/nodeAttachmentPreview': {decodeAttachmentText: value => new TextDecoder().decode(value)}
  }).default
  const vm = {...component.data(), file:{id:'html'}, kind:'html'}
  await component.methods.loadMarkdown.call(vm)
  assert.equal(vm.plainText, original)
  assert.equal(vm.textError, '')
  assert.equal(vm.textLoading, false)
  const compiler = require('vue-template-compiler')
  for (const relative of ['features/knowledge-base/components/KbSourcePreview.vue', 'features/knowledge-base/pages/KbParseDetailTab.vue', 'pages/Edit/components/KnowledgeFilePicker.vue']) {
    const source = compiler.parseComponent(fs.readFileSync(path.join(__dirname, '../src', relative), 'utf8'))
    assert.deepEqual(compiler.compile(source.template.content).errors, [], relative)
    if (relative.includes('KbSourcePreview')) {
      assert.match(source.template.content, /sandbox="allow-scripts"/)
      assert.doesNotMatch(source.template.content, /allow-same-origin/)
    }
  }
})
test('a single mounted file opens directly; folders and multiple files retain the picker', () => {
  const utils = load('utils/knowledgeFiles.js')
  const component = load('pages/Edit/components/NodeAttachment.vue', {'@/utils/knowledgeFiles':utils}).default
  const opened = [], picked = []
  const previous = global.window
  global.window = {open: (...args) => opened.push(args)}
  try {
    const vm = {openKnowledgePicker: (...args) => picked.push(args)}
    const node = entries => ({getData: () => entries})
    component.methods.onViewKnowledgeFiles.call(vm, node([{id:'f'}]))
    assert.equal(opened[0][0], '/kb/parse?shell=full&view=source&file=f')
    component.methods.onViewKnowledgeFiles.call(vm, node([{id:'folder', kind:'folder'}]))
    component.methods.onViewKnowledgeFiles.call(vm, node([{id:'a'},{id:'b'}]))
    assert.equal(picked.length, 2)
  } finally {global.window = previous}
})
