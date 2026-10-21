const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '..')

function extractMethod(file, startMarker, endMarker, context = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  assert.ok(start >= 0 && end > start, `could not extract ${startMarker}`)
  return vm.runInNewContext(`({${source.slice(start, end)}})`, {
    Promise,
    Object,
    trimNodeEditText: value => value,
    ...context
  })
}

const textEdit = {
  ...extractMethod(
    'src/core/render/TextEdit.js',
    '  hideEditTextBox() {',
    '  // Explicitly discard a conflict draft'
  ),
  ...extractMethod(
    'src/core/render/TextEdit.js',
    '  async show({',
    '  // 当openRealtimeRenderOnNodeTextEdit配置更新后需要更新编辑框样式',
    { mapRefUtil: { normalizeMapRef: () => null } }
  ),
  ...extractMethod(
    'src/core/render/TextEdit.js',
    '  discardEditSession(id) {',
    '  // 获取当前正在编辑中的节点实例'
  )
}

const richText = {
  ...extractMethod(
    'src/plugins/RichText.js',
    '  showEditText({ node, rect, isInserting, isFromKeyDown, isFromScale }) {',
    '  // 当openRealtimeRenderOnNodeTextEdit配置更新后需要更新编辑框样式'
  ),
  ...extractMethod(
    'src/plugins/RichText.js',
    '  hideEditText(nodes) {',
    '  // Explicitly discard a conflict draft'
  ),
  ...extractMethod(
    'src/plugins/RichText.js',
    '  discardEditSession(id) {',
    '  beginEditSession(node, isFromScale) {'
  )
}

function createMindMap(cooperate) {
  const calls = []
  return {
    calls,
    mindMap: {
      richText: null,
      cooperate,
      opt: {},
      keyCommand: { recoveryCheckInSvg() {}, stopCheckInSvg() {} },
      emit(...args) {
        calls.push(['emit', ...args])
      },
      execCommand(...args) {
        calls.push(['execCommand', ...args])
      },
      render() {
        calls.push(['render'])
      }
    }
  }
}

function createTextEditor({ sessionId = 'session-1', cooperate } = {}) {
  const state = createMindMap(cooperate)
  const editor = {
    ...textEdit,
    mindMap: state.mindMap,
    renderer: { activeNodeList: [] },
    currentNode: { uid: 'node-1' },
    editSessionId: sessionId,
    isEditSessionComposing: false,
    showTextEdit: true,
    textEditNode: {
      innerHTML: 'draft',
      style: { display: 'block' }
    },
    getEditText: () => 'draft',
    syncEditSessionDraft() {},
    setIsShowTextEdit(value) {
      this.showTextEdit = value
    }
  }
  return { editor, calls: state.calls }
}

function createRichTextEditor({ sessionId = 'session-1', cooperate } = {}) {
  const state = createMindMap(cooperate)
  const node = { uid: 'node-1' }
  const editor = {
    ...richText,
    mindMap: state.mindMap,
    node,
    editSessionId: sessionId,
    isCompositing: false,
    isInserting: false,
    cacheEditingText: '',
    showTextEdit: true,
    textEditNode: { innerHTML: '<p>draft</p>', style: { display: 'block' } },
    quill: { root: { innerHTML: '<p>draft</p>' } },
    getEditText: () => '<p>draft</p>',
    syncEditSessionDraft() {},
    setIsShowTextEdit(value) {
      this.showTextEdit = value
    }
  }
  return { editor, calls: state.calls, node }
}

async function testMissingSessionDoesNotDowngrade() {
  const cooperate = {
    httpCollabMode: true,
    getEditSession: () => null,
    commitEditSession() {
      throw new Error('must not commit a missing session')
    }
  }
  const plain = createTextEditor({ cooperate })
  assert.equal(await textEdit.hideEditTextBox.call(plain.editor), false)
  assert.equal(plain.editor.showTextEdit, true)
  assert.equal(plain.calls.some(call => call[0] === 'execCommand'), false)
  assert.equal(plain.calls.some(call => call[0] === 'render'), false)

  const rich = createRichTextEditor({ cooperate })
  assert.equal(await richText.hideEditText.call(rich.editor), false)
  assert.equal(rich.editor.showTextEdit, true)
  assert.equal(rich.calls.some(call => call[0] === 'execCommand'), false)
  assert.equal(rich.calls.some(call => call[0] === 'render'), false)
}

async function testMissingBaselineDoesNotDowngrade() {
  const cooperate = {
    httpCollabMode: true,
    getEditSession: () => ({ id: 'session-1', baseVersions: {} }),
    commitEditSession() {
      throw new Error('must not commit without a captured baseline')
    }
  }
  const plain = createTextEditor({ cooperate })
  assert.equal(await textEdit.hideEditTextBox.call(plain.editor), false)
  assert.equal(plain.editor.showTextEdit, true)
  assert.equal(plain.calls.some(call => call[0] === 'execCommand'), false)

  const rich = createRichTextEditor({ cooperate })
  assert.equal(await richText.hideEditText.call(rich.editor), false)
  assert.equal(rich.editor.showTextEdit, true)
  assert.equal(rich.calls.some(call => call[0] === 'execCommand'), false)
}

async function testMultiNodeRichTextCannotDowngrade() {
  let commits = 0
  const cooperate = {
    httpCollabMode: true,
    getEditSession: () => ({
      id: 'session-1',
      fields: ['text', 'richText'],
      baseVersions: { text: 4 }
    }),
    commitEditSession() {
      commits += 1
      return Promise.resolve({})
    }
  }
  const rich = createRichTextEditor({ cooperate })
  const result = await richText.hideEditText.call(rich.editor, [
    rich.node,
    { uid: 'node-2' }
  ])
  assert.equal(result, false)
  assert.equal(rich.editor.showTextEdit, true)
  assert.equal(commits, 0)
  assert.equal(rich.calls.some(call => call[0] === 'execCommand'), false)
  assert.equal(rich.calls.some(call => call[0] === 'render'), false)
}

function testExplicitDiscardDoesNotUpload() {
  const plain = createTextEditor()
  let plainRestored = 0
  plain.editor.currentNode._textData = { node: { show: () => plainRestored++ } }
  plain.editor.cacheEditingText = 'stale draft cache'
  plain.editor.mindMap.opt.openRealtimeRenderOnNodeTextEdit = true
  assert.equal(textEdit.discardEditSession.call(plain.editor, 'other'), false)
  assert.equal(plain.editor.showTextEdit, true)
  assert.equal(textEdit.discardEditSession.call(plain.editor, 'session-1'), true)
  assert.equal(plain.editor.showTextEdit, false)
  assert.equal(plain.editor.editSessionId, null)
  assert.equal(plain.editor.currentNode, null)
  assert.equal(plain.editor.cacheEditingText, '')
  assert.equal(plain.editor.textEditNode.innerHTML, '')
  assert.equal(plainRestored, 1, 'TextEdit discard should reveal the current node text again')
  assert.equal(plain.calls.some(call => ['execCommand', 'render'].includes(call[0])), false)
  const plainHide = plain.calls.find(call => call[0] === 'emit' && call[1] === 'hide_text_edit')
  assert.equal(plainHide[5].editSessionSaved, true)
  assert.equal(plainHide[5].editSessionDiscarded, true)

  const rich = createRichTextEditor()
  let richRestored = 0
  rich.node._textData = { node: { show: () => richRestored++ } }
  rich.editor.mindMap.opt.openRealtimeRenderOnNodeTextEdit = true
  assert.equal(richText.discardEditSession.call(rich.editor, 'other'), false)
  assert.equal(rich.editor.showTextEdit, true)
  assert.equal(richText.discardEditSession.call(rich.editor, 'session-1'), true)
  assert.equal(rich.editor.showTextEdit, false)
  assert.equal(rich.editor.editSessionId, null)
  assert.equal(rich.editor.node, null)
  assert.equal(rich.editor.quill.root.innerHTML, '')
  assert.equal(rich.editor.textEditNode.style.display, 'none')
  assert.equal(richRestored, 1, 'RichText discard should reveal the current node text again')
  assert.equal(rich.calls.some(call => ['execCommand', 'render'].includes(call[0])), false)
  const richHide = rich.calls.find(call => call[0] === 'emit' && call[1] === 'hide_text_edit')
  assert.equal(richHide[5].editSessionSaved, true)
  assert.equal(richHide[5].editSessionDiscarded, true)
}

async function testSoftLockDenialKeepsExistingEditorOpen() {
  let deniedNode = null
  const cooperate = {
    canBeginNodeEdit(node) {
      deniedNode = node
      return false
    },
    getEditSession: () => ({ baseVersions: { text: 2 } })
  }
  const plain = createTextEditor({ cooperate })
  const previousNode = plain.editor.currentNode
  const attemptedNode = {
    isUseCustomNodeContent: () => false,
    getData: () => undefined
  }
  let hideCalls = 0
  plain.editor.getCurrentEditNode = () => previousNode
  plain.editor.hideEditTextBox = async () => {
    hideCalls += 1
    return true
  }
  await textEdit.show.call(plain.editor, { node: attemptedNode })
  assert.equal(deniedNode, attemptedNode)
  assert.equal(hideCalls, 0, 'A denied new target must not hide/save the previous editor')
  assert.equal(plain.editor.showTextEdit, true)
  assert.equal(plain.editor.currentNode, previousNode)
  assert.equal(plain.calls.some(call => ['execCommand', 'render'].includes(call[0])), false)

  const rich = createRichTextEditor({ cooperate })
  rich.editor.showTextEdit = false
  rich.editor.node = null
  rich.editor.textEditNode = null
  deniedNode = null
  const deniedRichNode = { uid: 'locked-rich-node' }
  const result = richText.showEditText.call(rich.editor, { node: deniedRichNode })
  assert.equal(result, undefined)
  assert.equal(deniedNode, deniedRichNode)
  assert.equal(rich.editor.showTextEdit, false)
  assert.equal(rich.editor.node, null)
  assert.equal(rich.editor.textEditNode, null, 'Denied RichText entry must not create a DOM editor')
  assert.equal(rich.calls.some(call => ['execCommand', 'render'].includes(call[0])), false)
}

async function testExistingScaleSessionSkipsEntryLock() {
  let lockChecks = 0
  const cooperate = {
    getEditSession: () => ({ baseVersions: { text: 2 } }),
    canBeginNodeEdit() {
      lockChecks += 1
      return false
    }
  }
  const plain = createTextEditor({ cooperate })
  const currentNode = {
    isUseCustomNodeContent: () => false,
    getData: () => undefined
  }
  plain.editor.currentNode = currentNode
  plain.editor.getCurrentEditNode = () => currentNode
  plain.editor.hideEditTextBox = async () => true
  let beforeEditCalls = 0
  plain.editor.mindMap.opt.beforeTextEdit = async () => {
    beforeEditCalls += 1
    return false
  }
  await textEdit.show.call(plain.editor, { node: currentNode, isFromScale: true })
  assert.equal(lockChecks, 0, 'Existing scale session must bypass the new-entry lock check')
  assert.equal(beforeEditCalls, 1, 'Scale re-entry was blocked before its normal continuation')

  const rich = createRichTextEditor({ cooperate })
  rich.editor.showTextEdit = true
  lockChecks = 0
  richText.showEditText.call(rich.editor, {
    node: rich.node,
    isFromScale: true
  })
  assert.equal(lockChecks, 0, 'Existing RichText scale session must bypass the new-entry lock check')
  assert.equal(rich.editor.showTextEdit, true)
}

async function main() {
  await testMissingSessionDoesNotDowngrade()
  await testMissingBaselineDoesNotDowngrade()
  await testMultiNodeRichTextCannotDowngrade()
  testExplicitDiscardDoesNotUpload()
  await testSoftLockDenialKeepsExistingEditorOpen()
  await testExistingScaleSessionSkipsEntryLock()
  console.log('PASS: missing session/baseline and multi-node rich text never downgrade; explicit discard clears/restores only the matching editor without upload; soft-lock denial keeps prior editors open and existing scale sessions pass.')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
