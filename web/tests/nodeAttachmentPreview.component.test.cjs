const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')
const compiler = require('vue-template-compiler')
const viewerInstances = []
const workbookJobs = new Map()

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
      // Match the installed Toast UI Viewer: constructor empties the host and
      // appends one contents element; destroy() itself leaves it in place.
      this.el.textContent = ''
      if (typeof this.el.appendChild === 'function') {
        this.el.appendChild({ className: 'toastui-editor-contents', parentNode: null })
      }
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
      if (name === '@/utils/roomLocation') {
        return {
          roomFromLocation: route =>
            (route && route.query && route.query.room) || 'room-1'
        }
      }
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
          attachmentBusyMessage: () => '正在处理，请稍候',
          slimSpreadsheetZip: buffer => {
            const job = workbookJobs.get(buffer.name)
            if (!job) return Promise.resolve(buffer)
            job.started = true
            return job.promise
          },
          workbookSheetsFromXlsx: (_xlsx, workbook) => workbook.sheets
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
const managedNodes = []
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
  $bus: { $emit: (event, node) => managedNodes.push({ event, node }) },
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
const busyNode = {
  getData: () => ({
    attachmentId: 'att-busy',
    attachmentName: '表.xlsx',
    attachmentStatus: 'processing'
  })
}
methods.onAttachmentClick.call(vm, busyNode)
assert.equal(opened.length, 2)
assert.equal(tabs.length, 1)
assert.deepEqual(managedNodes, [{ event: 'manageNodeAttachment', node: busyNode }])
assert.ok(!attachmentSource.includes('$loading'))
assert.ok(attachmentSource.includes('附件上传中；原附件会保留到新文件上传成功后再切换'))
assert.ok(!attachmentSource.includes("attachmentStatus: 'uploading'"))
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

function testElement() {
  return {
    children: [],
    get firstChild() {
      return this.children[0] || null
    },
    appendChild(child) {
      if (child.parentNode) {
        const oldIndex = child.parentNode.children.indexOf(child)
        if (oldIndex >= 0) child.parentNode.children.splice(oldIndex, 1)
      }
      child.parentNode = this
      this.children.push(child)
      return child
    },
    set textContent(value) {
      if (value === '') {
        this.children.forEach(child => { child.parentNode = null })
        this.children = []
      }
    }
  }
}

function verifyMarkdownViewerOwnership() {
  const startCount = viewerInstances.length
  const container = testElement()
  const pendingTicks = []
  const markdownVm = {
    ...component.data(),
    requestId: 20,
    kind: 'markdown',
    previewText: '# 旧房间附件',
    visible: true,
    $refs: { markdownViewer: container },
    $nextTick: callback => pendingTicks.push(callback),
    $route: { query: { room: 'room-1' } }
  }
  markdownVm.cancelActiveRequest = () => methods.cancelActiveRequest.call(markdownVm)
  markdownVm.releaseBlobUrl = () => methods.releaseBlobUrl.call(markdownVm)
  markdownVm.destroyMarkdownViewer = () => methods.destroyMarkdownViewer.call(markdownVm)
  markdownVm.resetPreview = () => methods.resetPreview.call(markdownVm)

  methods.renderMarkdown.call(markdownVm)
  const staleTick = pendingTicks.shift()
  component.watch.$route.call(
    markdownVm,
    { query: { room: 'room-2' } },
    { query: { room: 'room-1' } }
  )
  assert.equal(container.children.length, 0)

  // A late nextTick from the old room must not create a viewer in the new one.
  markdownVm.kind = 'markdown'
  markdownVm.previewText = '# 新房间附件'
  markdownVm.visible = true
  methods.renderMarkdown.call(markdownVm)
  const currentTick = pendingTicks.shift()
  staleTick()
  assert.equal(viewerInstances.length, startCount)
  currentTick()
  assert.equal(viewerInstances.length, startCount + 1)
  assert.equal(container.children.length, 1)
  assert.equal(container.children[0].className, 'toastui-editor-contents')
  assert.equal(viewerInstances[startCount].markdown, '# 新房间附件')

  // The installed Viewer.destroy() keeps its content node; component cleanup
  // must remove that exact instance before the same host is reused.
  methods.resetPreview.call(markdownVm)
  assert.equal(viewerInstances[startCount].destroyed, true)
  assert.equal(container.children.length, 0)
  markdownVm.kind = 'markdown'
  markdownVm.previewText = '# 再次打开'
  methods.renderMarkdown.call(markdownVm)
  pendingTicks.shift()()
  assert.equal(viewerInstances.length, startCount + 2)
  assert.equal(container.children.length, 1)
  assert.equal(viewerInstances[startCount + 1].markdown, '# 再次打开')
}

async function verifyDocxRenderIsolation() {
  const previousDocument = global.document
  global.document = { createElement: () => testElement() }
  try {
    const container = testElement()
    const docxVm = {
      requestId: 1,
      $refs: { docxViewer: container },
      $nextTick: () => Promise.resolve(),
      error: ''
    }
    docxVm.cancelActiveRequest = () => methods.cancelActiveRequest.call(docxVm)
    docxVm.releaseBlobUrl = () => methods.releaseBlobUrl.call(docxVm)
    docxVm.destroyMarkdownViewer = () => methods.destroyMarkdownViewer.call(docxVm)
    docxVm.resetPreview = () => methods.resetPreview.call(docxVm)
    const renders = []
    const renderAsync = (blob, staging) => {
      let resolve
      const promise = new Promise(yes => { resolve = yes })
      renders.push({
        finish() {
          staging.appendChild({ name: blob.name, parentNode: null })
          resolve()
        }
      })
      return promise
    }

    const oldPreview = methods.renderDocxPreview.call(
      docxVm, { name: 'old.docx' }, 1, renderAsync
    )
    await Promise.resolve()
    methods.onClosed.call(docxVm)
    docxVm.visible = true
    const newPreview = methods.renderDocxPreview.call(
      docxVm, { name: 'new.docx' }, docxVm.requestId, renderAsync
    )
    await Promise.resolve()
    assert.equal(renders.length, 2)

    renders[1].finish()
    await newPreview
    assert.deepEqual(container.children.map(child => child.name), ['new.docx'])

    // A slower previous render can finish after the replacement; its private
    // staging DOM must never be committed beside the current document.
    renders[0].finish()
    await oldPreview
    assert.deepEqual(container.children.map(child => child.name), ['new.docx'])

    const routeVm = {
      ...component.data(),
      visible: true,
      $refs: { docxViewer: container },
      $route: { query: { room: 'room-1' } }
    }
    routeVm.cancelActiveRequest = () => methods.cancelActiveRequest.call(routeVm)
    routeVm.releaseBlobUrl = () => methods.releaseBlobUrl.call(routeVm)
    routeVm.destroyMarkdownViewer = () => methods.destroyMarkdownViewer.call(routeVm)
    routeVm.resetPreview = () => methods.resetPreview.call(routeVm)
    routeVm.controller = null
    routeVm.requestId = 7
    routeVm.$nextTick = () => Promise.resolve()
    const routePreview = methods.renderDocxPreview.call(
      routeVm, { name: 'old-room.docx' }, 7, renderAsync
    )
    await Promise.resolve()
    component.watch.$route.call(
      routeVm,
      { query: { room: 'room-2' } },
      { query: { room: 'room-1' } }
    )
    assert.equal(routeVm.visible, false)
    renders[2].finish()
    await routePreview
    assert.deepEqual(container.children, [])
    assert.equal(routeVm.attachmentId, '')

    const workbookVm = {
      requestId: 10,
      workbookSheets: [],
      activeSheetName: '',
      error: ''
    }
    const makeWorkbookJob = () => {
      let resolve
      const job = {
        started: false,
        promise: new Promise(yes => { resolve = yes }),
        finish(buffer) { resolve(buffer) }
      }
      return job
    }
    const oldWorkbookJob = makeWorkbookJob()
    const newWorkbookJob = makeWorkbookJob()
    workbookJobs.set('old.xlsx', oldWorkbookJob)
    workbookJobs.set('new.xlsx', newWorkbookJob)
    const loadModules = async () => [
      {
        default: {
          read: buffer => ({
            sheets: [{ name: buffer.name, rows: [], columnCount: 1, truncated: false }]
          })
        }
      },
      { default: {} }
    ]
    const oldWorkbook = methods.loadWorkbookCanvas.call(
      workbookVm, { name: 'old.xlsx' }, 10, loadModules
    )
    await Promise.resolve()
    assert.equal(oldWorkbookJob.started, true)
    workbookVm.requestId = 11
    const newWorkbook = methods.loadWorkbookCanvas.call(
      workbookVm, { name: 'new.xlsx' }, 11, loadModules
    )
    await Promise.resolve()
    assert.equal(newWorkbookJob.started, true)
    newWorkbookJob.finish({ name: 'new.xlsx' })
    await newWorkbook
    assert.deepEqual(workbookVm.workbookSheets.map(sheet => sheet.name), ['new.xlsx'])
    oldWorkbookJob.finish({ name: 'old.xlsx' })
    await oldWorkbook
    assert.deepEqual(workbookVm.workbookSheets.map(sheet => sheet.name), ['new.xlsx'])
  } finally {
    if (previousDocument === undefined) delete global.document
    else global.document = previousDocument
  }
}

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

verifyMarkdownViewerOwnership()
verifyDocxRenderIsolation()
  .then(() => console.log('Node attachment preview component ownership tests passed'))
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
