/**
 * 概要（generalization）双击编辑的同步失败回归测试。
 *
 * 回归的 bug：概要是虚拟节点，数据实际存在 owner 节点的
 * data.generalization 数组里，服务端没有概要 uid 对应的节点行。
 * 双击概要编辑时 TextEdit.beginEditSession 拿概要虚拟节点的 gen uid
 * 建编辑会话，commitEditSession 再以该 gen uid 提交 node.update，
 * 服务端 getLive(genUid) 为 null → NODE_DELETED → 「同步失败」。
 *
 * 修复：beginEditSession 对 isGeneralization 节点不建编辑会话，
 * 让概要文本编辑走 SET_NODE_TEXT 命令兜底，由 Cooperate 的
 * collectGeneralizationOwners → syncHttpGeneralization(owner) 通道落库。
 */
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`)
}

function loadModule(file, requireStub) {
  const { code } = babel.transformSync(fs.readFileSync(file, 'utf8'), {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  })
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', code)(
    requireStub || (() => ({})),
    mod,
    mod.exports
  )
  return mod.exports
}

// ---- mock 依赖：TextEdit 只在构造/bindEvent 时用到少量工具 ----
const utilsStub = {
  getStrWithBrFromHtml: html => String(html || ''),
  checkNodeOuter: () => {},
  focusInput: () => {},
  selectAllInput: () => {},
  htmlEscape: s => String(s || ''),
  handleInputPasteText: () => {},
  checkSmmFormatData: () => false,
  getTextFromHtml: s => String(s || ''),
  isWhite: () => false,
  getVisibleColorFromTheme: () => '#fff',
  trimNodeEditText: s => s
}
const constantStub = {
  ERROR_TYPES: {},
  CONSTANTS: { MOUSE_WHEEL_ACTION: { MOVE: 'move' } },
  noneRichTextNodeLineHeight: 1.4
}
const mapRefStub = { normalizeMapRef: () => null, default: { normalizeMapRef: () => null } }

const requireStub = request => {
  if (/utils\/mapRef$/.test(request)) return mapRefStub
  if (/utils$/.test(request)) return utilsStub
  if (/constants\/constant$/.test(request)) return constantStub
  return {}
}

const textEditFile = path.join(
  __dirname,
  '../../simple-mind-map/src/core/render/TextEdit.js'
)
const TextEdit = loadModule(textEditFile, requireStub).default

// ---- 构造一个最小 mindMap/renderer 环境 ----
function createTextEdit(cooperate) {
  const listeners = {}
  const mindMap = {
    opt: { enableAutoEnterTextEditWhenKeydown: false },
    on: (name, fn) => {
      ;(listeners[name] = listeners[name] || []).push(fn)
    },
    off: () => {},
    emit: () => {},
    addEditNodeClass: () => {},
    keyCommand: { addShortcut: () => {} },
    cooperate,
    richText: null
  }
  const renderer = { mindMap }
  // bindEvent 里可能碰 window/document，Node 环境下补最小全局
  global.window = global.window || { addEventListener: () => {}, removeEventListener: () => {} }
  global.document = global.document || { body: {} }
  return new TextEdit(renderer)
}

function fakeNode({ uid, isGeneralization }) {
  const data = { uid }
  return {
    isGeneralization: !!isGeneralization,
    generalizationBelongNode: isGeneralization ? { getData: () => ({ uid: 'owner-1' }) } : null,
    getData: key => (key === undefined ? data : data[key])
  }
}

// ---- 场景 1：普通节点正常建编辑会话（修复不能误伤） ----
{
  const calls = []
  const cooperate = {
    httpCollabMode: true,
    collabV2Adapter: {},
    beginEditSession: opt => {
      calls.push(opt)
      return { id: 'session-1' }
    },
    getEditSession: () => null,
    updateEditSessionDraft: () => {}
  }
  const editor = createTextEdit(cooperate)
  editor.textEditNode = { innerHTML: '普通节点' }
  editor.getEditText = () => '普通节点'
  editor.beginEditSession(fakeNode({ uid: 'n1' }), false)
  check(
    '普通节点：正常建立编辑会话',
    calls.length === 1 && calls[0].uid === 'n1' && editor.editSessionId === 'session-1',
    `calls=${JSON.stringify(calls.map(c => c.uid))} sessionId=${editor.editSessionId}`
  )
}

// ---- 场景 2：概要虚拟节点不再以 gen uid 建编辑会话（本次修复） ----
{
  const calls = []
  const cooperate = {
    httpCollabMode: true,
    collabV2Adapter: {},
    beginEditSession: opt => {
      calls.push(opt)
      return { id: 'session-gen' }
    },
    getEditSession: () => null,
    updateEditSessionDraft: () => {}
  }
  const editor = createTextEdit(cooperate)
  editor.textEditNode = { innerHTML: '概要文本' }
  editor.getEditText = () => '概要文本'
  editor.beginEditSession(fakeNode({ uid: 'g1', isGeneralization: true }), false)
  check(
    '概要虚拟节点：不建编辑会话（editSessionId 为空）',
    calls.length === 0 && editor.editSessionId === null,
    `calls=${calls.length} sessionId=${editor.editSessionId}`
  )
}

// ---- 场景 3：非协作模式不受影响 ----
{
  const editor = createTextEdit(null)
  editor.textEditNode = { innerHTML: 'x' }
  editor.getEditText = () => 'x'
  editor.beginEditSession(fakeNode({ uid: 'n2', isGeneralization: true }), false)
  check(
    '非协作模式下概要节点也安全返回',
    editor.editSessionId === null || editor.editSessionId === undefined
  )
}

// ---- 场景 4：RichText 插件同样有概要守卫 ----
{
  const richTextFile = path.join(
    __dirname,
    '../../simple-mind-map/src/plugins/RichText.js'
  )
  const src = fs.readFileSync(richTextFile, 'utf8')
  // 第一次出现是调用处（this.beginEditSession(node, isFromScale)），定义在其后
  const first = src.indexOf('beginEditSession(node, isFromScale)')
  const beginIdx = src.indexOf('beginEditSession(node, isFromScale)', first + 1)
  const body = src.slice(beginIdx, beginIdx + 1600)
  check(
    'RichText.beginEditSession 里有概要虚拟子树守卫',
    beginIdx >= 0 && /isVirtualGeneralizationNode\(node, cooperate\)/.test(body),
    beginIdx < 0 ? 'definition not found' : ''
  )
}

// ---- 场景 5：TextEdit.beginEditSession 的守卫带解释注释（防误删） ----
{
  const src = fs.readFileSync(textEditFile, 'utf8')
  const first = src.indexOf('beginEditSession(node, isFromScale)')
  const beginIdx = src.indexOf('beginEditSession(node, isFromScale)', first + 1)
  const body = src.slice(beginIdx, beginIdx + 1600)
  check(
    'TextEdit.beginEditSession 里有概要虚拟子树守卫',
    beginIdx >= 0 && /isVirtualGeneralizationNode\(node, cooperate\)/.test(body),
    beginIdx < 0 ? 'definition not found' : ''
  )
}

const failed = results.filter(r => !r.ok)
console.log(failed.length ? `\n${failed.length} FAILED` : '\nall ok')
process.exit(failed.length ? 1 : 0)
