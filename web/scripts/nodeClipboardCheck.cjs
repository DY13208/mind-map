const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../..')
const outline = fs.readFileSync(path.join(root, 'simple-mind-map/src/utils/copyOutline.js'), 'utf8').replace(/export /g, '')
const utils = fs.readFileSync(path.join(root, 'simple-mind-map/src/utils/index.js'), 'utf8')
const writer = utils.slice(utils.indexOf('export const setDataToClipboard ='), utils.indexOf('export const getDataFromClipboard =')).replace('export const', 'const')
const checker = utils.slice(utils.indexOf('export const checkSmmFormatData ='), utils.indexOf('// 处理输入框的粘贴事件')).replace('export const', 'const')
const payload = { simpleMindMap: true, sourceRoom: 'A', data: [{ data: { text: '项目负责人', hyperlink: 'https://example.com/a?q="中文"', hyperlinkTitle: '链接', attachmentId: 'file1', attachmentUrl: '/api/files/room/attachments/file1/content', attachmentName: '资料.pdf' }, children: [] }] }
async function main() {
  let written
  const textareas = []
  const listeners = new Set()
  let nativeAllowed = true
  const context = vm.createContext({ Blob, ClipboardItem: class { constructor(items) { this.items = items } }, navigator: { clipboard: { write: async items => { written = items[0].items }, writeText: async text => { written = text } } }, document: {
    createElement: () => ({ style: {}, setAttribute() {}, select() {} }),
    body: { appendChild: el => textareas.push(el), removeChild: el => assert.equal(el, textareas.pop()) },
    addEventListener: (type, listener) => { assert.equal(type, 'copy'); listeners.add(listener) },
    removeEventListener: (type, listener) => { assert.equal(type, 'copy'); listeners.delete(listener) },
    execCommand: command => {
      assert.equal(command, 'copy')
      if (!nativeAllowed) return false
      written = { 'text/plain': new Blob([textareas[0].value]) }
      for (const listener of listeners) listener({ clipboardData: { setData: (type, value) => { written[type] = new Blob([value]) } }, preventDefault() {} })
      return true
    }
  } })
  vm.runInContext(outline + '\n' + writer + '\n' + checker + '\nglobalThis.write = setDataToClipboard', context)
  const readWrittenPayload = async () => {
    context.html = await written['text/html'].text()
    return JSON.parse(JSON.stringify(vm.runInContext('readSmmClipboardHtml(html)', context)))
  }
  context.write(payload)
  await new Promise(resolve => setImmediate(resolve))
  const clipboardText = await written['text/plain'].text()
  assert.equal(clipboardText, '项目负责人', 'external clipboard must contain only node titles')
  const html = await written['text/html'].text()
  context.html = html
  assert.equal(vm.runInContext('typeof readSmmClipboardHtml', context), 'function', 'complete node clipboard HTML reader is missing')
  const decoded = vm.runInContext('readSmmClipboardHtml(html)', context)
  assert.deepEqual(JSON.parse(JSON.stringify(decoded)), payload, 'HTML clipboard must preserve attachments and hyperlinks across pages')
  assert.equal(vm.runInContext('readSmmClipboardHtml("<ul><li>外部文字</li></ul>")', context), null)
  assert.equal(vm.runInContext('readSmmClipboardHtml(\'<div data-simple-mind-map="%bad"></div>\')', context), null)
  for (const trees of [
    [{ data: { text: '一级节点' }, children: payload.data }],
    [payload.data[0], { data: { text: '另一个节点' }, children: [] }]
  ]) {
    const copied = { ...payload, data: trees }
    context.write(copied)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(await written['text/plain'].text(), context.nodesToTabOutline(trees), 'plain text contains only the node outline')
    assert.deepEqual(await readWrittenPayload(), copied, 'parent and multiple-node copies still preserve complete trees in HTML')
  }
  context.navigator.clipboard.write = undefined
  context.write(payload)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(await written['text/plain'].text(), '项目负责人')
  assert.deepEqual(await readWrittenPayload(), payload, 'native copy preserves node data when only writeText is available')
  const example = { ...payload, data: [{ data: { text: '分支主题1', expand: false }, children: [
    { data: { text: '子主题1' }, children: [{ ...payload.data[0], data: { ...payload.data[0].data, text: '子主题1' } }] },
    { data: { text: '子主题2' }, children: [] }
  ] }] }
  context.write(example)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(await written['text/plain'].text(), '分支主题1\n\t子主题1\n\t\t子主题1\n\t子主题2', 'external copy matches the requested Tab outline without attachment or link labels')
  assert.deepEqual(await readWrittenPayload(), example)
  const emptyTitle = { ...payload, data: [{ data: { ...payload.data[0].data, text: '' }, children: [] }] }
  await context.write(emptyTitle)
  assert.ok(written['text/html'], 'nodes without titles still need hidden metadata for internal paste')
  assert.equal(await written['text/plain'].text(), '')
  assert.deepEqual(await readWrittenPayload(), emptyTitle)
  const attachment = {
    ...payload.data[0].data,
    text: '<p><strong>附件节点</strong></p>', richText: true,
    note: '保留备注', fillColor: '#abcdef', __fv: { text: 38, attachment: 38 },
    attachmentStatus: 'ready', attachmentMimeType: 'text/html',
    attachmentExtractedText: '附件摘要'.repeat(600)
  }
  const richPayload = {
    ...payload,
    data: [{
      data: {
        ...attachment, expand: false,
        generalization: [{
          ...attachment, text: '概要',
          children: [{ data: { ...attachment, text: '概要子节点', generalization: { ...attachment, text: '嵌套概要' } }, children: [] }]
        }]
      },
      children: [{ data: { ...attachment, text: '折叠子节点' }, children: [] }]
    }, { data: { ...attachment, text: '另一个选中节点' }, children: [] }]
  }
  const before = JSON.stringify(richPayload)
  const expected = JSON.parse(before)
  for (const data of [
    expected.data[0].data,
    expected.data[0].children[0].data,
    expected.data[0].data.generalization[0],
    expected.data[0].data.generalization[0].children[0].data,
    expected.data[0].data.generalization[0].children[0].data.generalization,
    expected.data[1].data
  ]) delete data.attachmentExtractedText
  const copyRich = async () => {
    context.write(richPayload)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(JSON.stringify(richPayload), before, 'system clipboard compaction must not mutate full in-memory copy')
  }
  context.navigator.clipboard.write = async items => { written = items[0].items }
  await copyRich()
  const compactText = await written['text/plain'].text()
  const compactHtml = await written['text/html'].text()
  assert.equal(compactText, context.nodesToTabOutline(richPayload.data), 'rich-text nodes export readable titles')
  context.html = compactHtml
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('readSmmClipboardHtml(html)', context))), expected, 'hidden HTML preserves compact node data including generalizations')
  for (const unresolvable of [
    { ...payload, sourceRoom: '', data: [{ data: attachment, children: [] }] },
    { ...payload, sourceRoom: undefined, data: [{ data: attachment, children: [] }] },
    { ...payload, data: [{ data: { ...attachment, attachmentId: '' }, children: [] }] }
  ]) {
    context.write(unresolvable)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual((await readWrittenPayload()).data, JSON.parse(JSON.stringify(unresolvable.data)), 'keep summaries without a reliable room and attachment ID')
  }
  context.navigator.clipboard.write = async () => { throw Error('multi-format denied') }
  await copyRich()
  assert.deepEqual(await readWrittenPayload(), expected, 'failed modern API falls back to native multi-format copy')
  context.navigator.clipboard.write = undefined
  await copyRich()
  assert.deepEqual(await readWrittenPayload(), expected, 'writeText-only browser uses native multi-format copy')
  context.navigator.clipboard.write = async () => { throw Error('multi-format denied') }
  context.navigator.clipboard.writeText = async () => { throw Error('text denied') }
  await copyRich()
  assert.deepEqual(await readWrittenPayload(), expected, 'denied clipboard API preserves hidden node metadata through native copy')
  nativeAllowed = false
  context.navigator.clipboard.writeText = async text => { written = text }
  await copyRich()
  assert.equal(written, compactText, 'last-resort writeText exports readable outline')
  nativeAllowed = true
  context.navigator.clipboard = undefined
  await copyRich()
  assert.deepEqual(await readWrittenPayload(), expected, 'missing clipboard API uses native multi-format copy')
  assert.equal(textareas.length, 0, 'native fallback removes temporary textarea')
  assert.equal(listeners.size, 0, 'native fallback removes temporary copy listener')
  const renderer = fs.readFileSync(path.join(root, 'simple-mind-map/src/core/render/Render.js'), 'utf8')
  const method = renderer.slice(renderer.indexOf('  async applyClipboardPaste('), renderer.indexOf('  //  将节点移动到另一个节点的前面'))
  context.commands = []
  vm.runInContext('globalThis.renderer = {' + method + '}; renderer.mindMap = {opt:{}, execCommand:(...args)=>commands.push(args)}', context)
  const target = { getData: () => 'destination' }
  context.renderer.activeNodeList = [target]
  context.renderer.findNodeByUid = () => target
  await context.renderer.applyClipboardPaste({ text: '项目负责人', html })
  assert.equal(context.commands[0][0], 'PASTE_NODE')
  assert.deepEqual(JSON.parse(JSON.stringify(context.commands[0][1])), payload.data)
  context.commands.length = 0
  await context.renderer.applyClipboardPaste({ text: JSON.stringify(payload), html: '' })
  assert.equal(context.commands[0][0], 'PASTE_NODE')
  assert.deepEqual(JSON.parse(JSON.stringify(context.commands[0][1])), payload.data, 'legacy JSON paste retains hyperlink and attachment')
  context.commands.length = 0
  context.renderer.mindMap.opt.customHandleClipboardData = async copied => {
    context.renderer.activeNodeList = [{ getData: () => 'other' }]
    return copied.data
  }
  await context.renderer.applyClipboardPaste({ text: JSON.stringify(payload) })
  assert.equal(context.commands[0][2][0], target, 'async paste preserves original target when selection changes')
  context.commands.length = 0
  context.renderer.mindMap.opt.customHandleClipboardData = undefined
  await context.renderer.applyClipboardPaste({ text: compactText, html: compactHtml })
  assert.deepEqual(JSON.parse(JSON.stringify(context.commands[0][1])), expected.data, 'cross-page paste accepts compact HTML and JSON')
  context.commands.length = 0
  context.renderer.beingCopyData = richPayload.data
  context.renderer.getHistoryCopyForCurrentRoom = () => null
  await context.renderer.applyClipboardPaste({ text: compactText })
  assert.equal(context.commands[0][1], richPayload.data, 'plain-only subtree paste retains complete in-memory data')
  context.commands.length = 0
  context.renderer.beingCopyData = payload.data
  await context.renderer.applyClipboardPaste({ text: clipboardText })
  assert.equal(context.commands[0][1], payload.data, 'single leaf plain-only paste retains attachment and link')
  context.commands.length = 0
  context.renderer.beingCopyData = richPayload.data
  context.isUndef = value => value === undefined || value === null
  context.renderer.mindMap.opt.customHandleClipboardText = async () => ({ simpleMindMap: true, data: [{ data: { text: '外部节点' }, children: [] }] })
  await context.renderer.applyClipboardPaste({ text: '外部节点\n\t不同子节点' })
  assert.equal(context.commands[0][1][0].data.text, '外部节点', 'unrelated external outline must not paste a stale internal copy')

  const copyStart = renderer.indexOf('  async copyNow()')
  const copyNow = renderer.slice(copyStart, renderer.indexOf('  // 剪切节点', copyStart))
  const cutNow = renderer.slice(renderer.indexOf('  async cutNow()'), renderer.indexOf('  isClipboardPasteTargetBlocked('))
  Object.assign(context, {
    historyClipboard: { clearHistoryCopy() {} },
    getTopAncestorsFomNodeList: nodes => nodes,
    sortNodeList: nodes => nodes,
    createSmmFormatData: (data, sourceRoom) => ({ simpleMindMap: true, data, sourceRoom })
  })
  vm.runInContext('Object.assign(renderer, {' + copyNow + ',' + cutNow + '})', context)
  context.renderer.mindMap.cooperate = { httpRoomKey: 'A', copyNodeTrees: async () => richPayload.data }
  await context.renderer.copyNow()
  assert.equal(context.renderer.beingCopyData, richPayload.data, 'copy retains complete in-memory tree')
  assert.equal(await written['text/plain'].text(), compactText, 'copy exports readable text')
  assert.deepEqual(await readWrittenPayload(), expected, 'copy preserves hidden attachment data')
  context.renderer.mindMap.execCommand = (command, callback) => {
    assert.equal(command, 'CUT_NODE')
    callback(richPayload.data)
  }
  await context.renderer.cutNow()
  assert.equal(context.renderer.beingCopyData, richPayload.data, 'cut retains complete in-memory tree')
  assert.equal(await written['text/plain'].text(), compactText, 'cut exports the same readable text')
  assert.deepEqual(await readWrittenPayload(), expected, 'cut preserves hidden attachment data')
  assert.equal(JSON.stringify(richPayload), before, 'copy and cut leave original summaries intact')
  console.log('PASS text-only outline, hidden node data, compaction, single leaf/subtree copy and cut, cross-page paste, legacy JSON, native multi-format fallback, external text')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
