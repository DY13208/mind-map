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
      if (name === '@/utils/nodeAttachmentApi') {
        return {
          nodeAttachmentContentUrl: (room, id) =>
            `http://example.test/files/${room}/${id}/content`
        }
      }
      if (name === '@/utils/nodeAttachmentPreview') {
        return {
          safeMarkdownSource: value => value,
          attachmentPreviewKind: (fileName, mimeType) => {
            if (
              /\.html?$/i.test(String(fileName || '')) ||
              /html/.test(String(mimeType || ''))
            ) {
              return 'html'
            }
            return 'file'
          },
          isHtmlAttachment: (fileName, mimeType, url) =>
            /\.html?$/i.test(String(fileName || '')) ||
            /html/.test(String(mimeType || '')) ||
            /\.html?([?#]|$)/i.test(String(url || '')),
          isAttachmentBusy: data =>
            /uploading|pending|processing/i.test(
              String((data && (data.attachmentStatus || data.status)) || '')
            ),
          attachmentBusyMessage: () => '正在处理，请稍候'
        }
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
const tabs = []
const messages = []
const previousOpen = global.window && global.window.open
global.window = global.window || global
global.window.open = (url, target, features) => {
  tabs.push({ url, target, features })
  return { closed: false }
}
const vm = {
  ...component.data(),
  $route: {},
  $message: { warning() {}, info(text) { messages.push(text) } },
  openStoredAttachment: value => opened.push(['stored', value]),
  openExternalAttachment: value => opened.push(['external', value]),
  openHtmlInNewPage: data => methods.openHtmlInNewPage.call(vm, data),
  openUrlInNewPage: url => methods.openUrlInNewPage.call(vm, url)
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
methods.onAttachmentClick.call(vm, {
  getData: () => ({ attachmentId: 'att-html', attachmentName: '说明.html' })
})
assert.deepEqual(opened, [
  ['stored', { attachmentId: 'att-1' }],
  ['external', { attachmentUrl: 'https://example.test/a.pdf' }]
])
assert.deepEqual(tabs, [
  {
    url: 'http://example.test/files/room-1/att-html/content',
    target: '_blank',
    features: 'noopener'
  }
])
methods.onAttachmentClick.call(vm, {
  getData: () => ({
    attachmentId: 'att-busy',
    attachmentName: '表.xlsx',
    attachmentStatus: 'processing'
  })
})
assert.equal(opened.length, 2)
assert.equal(tabs.length, 1)
assert.equal(messages[0], '正在处理，请稍候')
assert.ok(!attachmentSource.includes('$loading'))
assert.ok(attachmentSource.includes("attachmentStatus: 'uploading'"))
assert.ok(attachmentSource.includes('waitForAttachmentReady'))

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

assert.ok(attachmentSource.includes('.html,.htm'))
assert.ok(attachmentSource.includes('text/html'))

const previewSource = fs.readFileSync(
  path.join(__dirname, '../src/pages/Edit/components/NodeAttachmentPreview.vue'),
  'utf8'
)
assert.match(previewSource, /openHtmlInNewPage/)
assert.ok(!previewSource.includes('htmlPreviewWrap'))
assert.ok(!previewSource.includes('服务端已提取的可读文本'))
assert.ok(previewSource.includes('无法预览该表格，请下载后查看'))
assert.ok(previewSource.includes('loadWorkbookCanvas'))
assert.ok(!previewSource.includes('shouldLoadWorkbookCanvas'))

if (previousOpen) global.window.open = previousOpen
else delete global.window.open

console.log('Node attachment preview component ownership tests passed')
