const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')
const compiler = require('vue-template-compiler')
const viewerInstances = []

function loadComponent(fileName) {
  const source = fs.readFileSync(fileName, 'utf8')
  const script = compiler.parseComponent(source).script.content
  const { code } = babel.transformSync(script, {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  })
  const moduleRef = { exports: {} }
  class Viewer {
    constructor({ el }) {
      this.el = el
      this.destroyed = false
      viewerInstances.push(this)
    }

    setMarkdown(value) {
      this.markdown = value
    }

    destroy() {
      this.destroyed = true
    }
  }
  new Function('require', 'module', 'exports', code)(
    name => {
      if (name.includes('toastui-editor-viewer')) return Viewer
      if (name === '@/utils/roomLocation') return { roomFromLocation: () => 'room-1' }
      if (name === '@/utils/nodeAttachmentApi') return {}
      if (name === '@/utils/nodeAttachmentPreview') {
        return { safeMarkdownSource: value => value }
      }
      return {}
    },
    moduleRef,
    moduleRef.exports
  )
  return moduleRef.exports.default
}

const attachmentSource = fs.readFileSync(
  path.join(__dirname, '../src/pages/Edit/components/NodeAttachment.vue'),
  'utf8'
)
assert.ok(!attachmentSource.includes('node_attachmentClick'))
assert.ok(!attachmentSource.includes('window.open'))

const component = loadComponent(
  path.join(__dirname, '../src/pages/Edit/components/NodeAttachmentPreview.vue')
)
const methods = component.methods
const opened = []
const vm = {
  ...component.data(),
  openStoredAttachment: value => opened.push(['stored', value]),
  openExternalAttachment: value => opened.push(['external', value])
}
vm.cancelActiveRequest = () => methods.cancelActiveRequest.call(vm)
vm.releaseBlobUrl = () => methods.releaseBlobUrl.call(vm)
vm.destroyMarkdownViewer = () => methods.destroyMarkdownViewer.call(vm)

methods.onAttachmentClick.call(vm, { getData: () => ({ attachmentId: 'att-1' }) })
methods.onAttachmentClick.call(vm, { getData: () => ({ attachmentUrl: 'https://example.test/a.pdf' }) })
assert.deepEqual(opened, [
  ['stored', { attachmentId: 'att-1' }],
  ['external', { attachmentUrl: 'https://example.test/a.pdf' }]
])

const previousUrl = global.URL
const revoked = []
global.URL = { revokeObjectURL: value => revoked.push(value) }
try {
  vm.blobUrl = 'blob:old-preview'
  methods.releaseBlobUrl.call(vm)
  assert.deepEqual(revoked, ['blob:old-preview'])
  assert.equal(vm.blobUrl, '')

  let aborted = false
  vm.controller = { abort: () => { aborted = true } }
  methods.cancelActiveRequest.call(vm)
  assert.equal(aborted, true)
  assert.equal(vm.controller, null)

  const previousRequestId = vm.requestId
  methods.resetPreview.call(vm)
  assert.equal(vm.requestId, previousRequestId + 1)
} finally {
  global.URL = previousUrl
}

const markdownVm = {
  ...component.data(),
  kind: 'markdown',
  previewText: '# 第一份文档',
  $refs: { markdownViewer: { id: 'first' } },
  $nextTick: callback => callback()
}
markdownVm.destroyMarkdownViewer = () => methods.destroyMarkdownViewer.call(markdownVm)
methods.renderMarkdown.call(markdownVm)
assert.equal(viewerInstances.length, 1)
assert.equal(viewerInstances[0].markdown, '# 第一份文档')

markdownVm.previewText = '# 第二份文档'
markdownVm.$refs.markdownViewer = { id: 'second' }
methods.renderMarkdown.call(markdownVm)
assert.equal(viewerInstances.length, 2)
assert.equal(viewerInstances[0].destroyed, true)
assert.equal(viewerInstances[1].markdown, '# 第二份文档')

console.log('Node attachment preview component ownership tests passed')
