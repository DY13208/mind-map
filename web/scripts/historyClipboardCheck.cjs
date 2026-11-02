const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const clipboardPath = path.resolve(
  __dirname,
  '../../simple-mind-map/src/utils/historyClipboard.js'
)
const historyClipboard = require(clipboardPath)
const collabPaste = require(path.resolve(
  __dirname,
  '../../simple-mind-map/src/utils/collabPaste.js'
))
const edgeGeometryModule = require(path.resolve(
  __dirname,
  '../../simple-mind-map/src/utils/edgeGeometry.js'
))
const localFileLink = require(path.resolve(
  __dirname,
  '../../simple-mind-map/src/utils/localFileLink.js'
))
const copyOutline = require(path.resolve(
  __dirname,
  '../../simple-mind-map/src/utils/copyOutline.js'
))
const renderSource = fs.readFileSync(
  path.resolve(__dirname, '../../simple-mind-map/src/core/render/Render.js'),
  'utf8'
)
  .replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*;?\r?\n/gm, '')
  .replace('export default Render', 'module.exports = Render')

const noop = () => {}
const constants = {
  LAYOUT: new Proxy({}, { get: (_, key) => String(key) })
}
const copyData = { data: { uid: 'ordinary-copy' }, children: [] }
const utils = new Proxy(
  {
    checkClipboardReadEnable: () => clipboardReadable,
    getDataFromClipboard: async () => clipboardData,
    getTopAncestorsFomNodeList: nodes => nodes,
    sortNodeList: nodes => nodes,
    copyNodeTree: () => JSON.parse(JSON.stringify(copyData)),
    formatDataToArray: data => data ? Array.isArray(data) ? data : [data] : [],
    simpleDeepClone: data => JSON.parse(JSON.stringify(data)),
    createUidForAppointNodes: () => {},
    checkSmmFormatData: text => ({ isSmm: false, data: text }),
    clipboardTextLooksLikeOutline: text =>
      String(text).split(/\r?\n|\r/).filter(line => line.trim()).length > 1,
    setDataToClipboard: noop
  },
  { get: (target, key) => target[key] || noop }
)
let clipboardReadable = false
let clipboardData = { text: '', html: '', img: null }

const globals = {
  merge: noop,
  LogicalStructure: class {},
  CompactStructure: class {},
  MindMap: class {},
  CatalogOrganization: class {},
  OrganizationStructure: class {},
  Timeline: class {},
  VerticalTimeline: class {},
  Fishbone: class {},
  TextEdit: class {},
  ...utils,
  shapeList: {},
  lineStyleProps: [],
  CONSTANTS: constants,
  ERROR_TYPES: {},
  Polygon: class {},
  mapRefUtil: {},
  undoTrace: noop,
  undoFullTreeForbidden: noop,
  destroyStaleLayoutNodes: noop,
  inspectLayoutRenderer: noop,
  historyClipboard,
  collabPaste,
  edgeGeometryModule,
  readSmmClipboardHtml: copyOutline.readSmmClipboardHtml,
  nodesToTabOutline: copyOutline.nodesToTabOutline,
  isLocalFileReference: localFileLink.isLocalFileReference,
  localFileDisplayName: localFileLink.localFileDisplayName
}

const moduleRef = { exports: {} }
vm.runInNewContext(renderSource, { module: moduleRef, ...globals }, {
  filename: 'simple-mind-map/src/core/render/Render.js'
})
const Render = moduleRef.exports

function makeRenderer(roomKey, options = {}) {
  const commands = []
  const mindMap = {
    opt: {
      historyCopyRoomKey: roomKey,
      historyInteractionPaused: !!options.paused,
      disabledClipboard: options.disabledClipboard !== false,
      readonly: false
    },
    cooperate: null,
    execCommand(type, payload) {
      commands.push({ type, payload })
      if (type === 'CUT_NODE' && typeof payload === 'function') payload(copyData)
    }
  }
  const renderer = Object.create(Render.prototype)
  Object.assign(renderer, {
    mindMap,
    activeNodeList: options.activeNodeList || [{ uid: 'active' }],
    beingCopyData: null,
    _copyPromise: null
  })
  return { renderer, commands, mindMap }
}

async function main() {
  const trees = [{ data: { uid: 'history-root' }, children: [] }]
  const signature = historyClipboard.setHistoryCopy('room-a', trees)
  assert.equal(
    signature,
    JSON.stringify({ simpleMindMap: true, data: trees })
  )
  assert.deepEqual(historyClipboard.getHistoryCopy('room-a'), trees)
  assert.equal(historyClipboard.getHistoryCopy('room-b'), null)
  const returnedCopy = historyClipboard.getHistoryCopy('room-a')
  returnedCopy[0].data.uid = 'mutated-read'
  assert.equal(historyClipboard.getHistoryCopy('room-a')[0].data.uid, 'history-root')
  assert.equal(historyClipboard.getHistoryCopySignature('room-a'), signature)
  assert.equal(historyClipboard.clearHistoryCopy('room-b'), false)
  assert.equal(historyClipboard.clearHistoryCopy('room-a'), true)
  assert.equal(historyClipboard.getHistoryCopy('room-a'), null)

  historyClipboard.setHistoryCopy('room-a', trees)
  const sameRoom = makeRenderer('room-a')
  await sameRoom.renderer.paste()
  assert.equal(sameRoom.commands.length, 1)
  assert.equal(sameRoom.commands[0].type, 'PASTE_NODE')
  assert.deepEqual(sameRoom.commands[0].payload, trees)

  const otherRoom = makeRenderer('room-b')
  await otherRoom.renderer.paste()
  assert.equal(otherRoom.commands.length, 0)

  const external = makeRenderer('room-a', { disabledClipboard: false })
  external.renderer.applyClipboardPaste = async payload => {
    external.applied = payload
  }
  const externalText = 'outside content'
  // Simulate a readable external clipboard; it must win over the app buffer.
  clipboardReadable = true
  clipboardData = { text: externalText, html: '', img: null }
  await external.renderer.paste()
  assert.equal(external.applied.text, externalText)
  assert.equal(external.commands.length, 0)
  clipboardReadable = false
  clipboardData = { text: '', html: '', img: null }

  const preset = makeRenderer('room-a')
  preset.renderer.applyClipboardPaste = async payload => {
    preset.applied = payload
  }
  await preset.renderer.paste({ text: 'native external text' })
  assert.equal(preset.applied.text, 'native external text')
  assert.equal(preset.commands.length, 0)

  const nativePreset = makeRenderer('room-a', { disabledClipboard: false })
  nativePreset.renderer.applyClipboardPaste = async payload => {
    nativePreset.applied = payload
  }
  const nativeEvent = {
    clipboardData: {
      getData: type => type === 'text/plain' ? 'native system content' : '',
      items: []
    },
    preventDefault() {
      nativePreset.prevented = true
    }
  }
  nativePreset.renderer.handlePaste(nativeEvent)
  assert.equal(nativePreset.prevented, true)
  assert.equal(nativePreset.applied.text, 'native system content')
  assert.equal(nativePreset.commands.length, 0)

  const nativeFallback = makeRenderer('room-a', { disabledClipboard: false })
  const emptyEvent = {
    clipboardData: { getData: () => '', items: [] },
    preventDefault() {
      nativeFallback.prevented = true
    }
  }
  nativeFallback.renderer.handlePaste(emptyEvent)
  assert.equal(nativeFallback.prevented, true)
  assert.equal(nativeFallback.commands[0].type, 'PASTE_NODE')

  const imageTrees = [{
    data: { uid: 'history-image-root', image: 'data:image/png;base64,history' },
    children: []
  }]
  historyClipboard.setHistoryCopy('room-a', imageTrees)
  const imagePaste = makeRenderer('room-a')
  imagePaste.renderer.renderTree = {
    data: { imgMap: { 'smm_img_key_collision': 'data:image/png;base64,current' } }
  }
  const preparePasteTrees = collabPaste.preparePasteTrees
  let pasteOptions = 'not-called'
  collabPaste.preparePasteTrees = (input, options) => {
    pasteOptions = options
    return preparePasteTrees(input, options)
  }
  imagePaste.mindMap.execCommand = (type, ...args) => {
    imagePaste.commands.push({ type, args })
  }
  try {
    imagePaste.renderer.pasteNode(imageTrees)
  } finally {
    collabPaste.preparePasteTrees = preparePasteTrees
  }
  assert.equal(pasteOptions, undefined, 'history paste must not resolve images from the current map')
  assert.equal(imagePaste.commands[0].type, 'INSERT_MULTI_CHILD_NODE')
  assert.equal(imagePaste.commands[0].args[1][0].data.image, 'data:image/png;base64,history')

  const staleOrdinaryCopy = [{ data: { uid: 'old-ordinary', text: 'old copied node' }, children: [] }]
  const externalOutline = 'External outline\n\tChild\n\t\tGrandchild'
  historyClipboard.setHistoryCopy('room-a', trees)
  const externalOutlinePaste = makeRenderer('room-a', { disabledClipboard: false })
  externalOutlinePaste.renderer.beingCopyData = staleOrdinaryCopy
  externalOutlinePaste.renderer.hasRichTextPlugin = () => false
  externalOutlinePaste.mindMap.execCommand = (type, ...args) => {
    externalOutlinePaste.commands.push({ type, args })
  }
  await externalOutlinePaste.renderer.applyClipboardPaste({ text: externalOutline })
  assert.equal(
    externalOutlinePaste.commands.some(command => command.type === 'PASTE_NODE'),
    false,
    'a history buffer must prevent stale ordinary copy data from taking over external outline text'
  )
  assert.equal(externalOutlinePaste.commands[0].type, 'INSERT_CHILD_NODE')
  assert.equal(externalOutlinePaste.commands[0].args[2].text, externalOutline)

  const paused = makeRenderer('room-a', { paused: true })
  assert.equal(paused.renderer.pasteInAppCopy(), false)
  await paused.renderer.paste()
  assert.equal(paused.commands.length, 0)
  const pasteEvent = { preventDefault: () => { paused.prevented = true } }
  paused.renderer.handlePaste(pasteEvent)
  assert.equal(paused.prevented, undefined)

  historyClipboard.setHistoryCopy('room-a', trees)
  const ordinaryCopy = makeRenderer('room-a')
  await ordinaryCopy.renderer.copyNow()
  assert.deepEqual(ordinaryCopy.renderer.beingCopyData, [copyData])
  assert.equal(historyClipboard.getHistoryCopy('room-a'), null)
  historyClipboard.setHistoryCopy('room-a', trees)
  const cut = makeRenderer('room-a', { activeNodeList: [] })
  await cut.renderer.cutNow()
  assert.equal(historyClipboard.getHistoryCopy('room-a'), null)

  historyClipboard.clearHistoryCopy()
  console.log('PASS: history clipboard isolation and Render paste/copy/cut fallback behavior')
}

main().catch(error => {
  console.error(error)
  historyClipboard.clearHistoryCopy()
  process.exitCode = 1
})
