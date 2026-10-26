'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

async function run(file, signature) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  const from = source.indexOf(signature), to = source.indexOf('\n  // Explicitly discard', from)
  const hide = vm.runInNewContext('({' + source.slice(from, to).trim() + '})', {
    trimNodeEditText: text => text
  })[signature.includes('hideEditTextBox') ? 'hideEditTextBox' : 'hideEditText']
  let commits = 0, complete
  const node = {}, session = { baseVersions: { text: 1 } }
  const editor = {
    showTextEdit: true, node, currentNode: node, editSessionId: 'session',
    renderer: { activeNodeList: [node] }, textEditNode: { style: {}, innerHTML: 'draft' },
    mindMap: { opt: {}, emit() {},
      execCommand() { throw new Error('protected edit must not fall back to SET_NODE_TEXT') },
      cooperate: {
        getEditSession: () => session,
        commitEditSession: () => { commits++; return new Promise((resolve, reject) => { complete = {resolve, reject} }) }
      }
    },
    getEditText: () => 'draft', syncEditSessionDraft() {},
    setIsShowTextEdit(value) { this.showTextEdit = value }
  }
  const first = hide.call(editor), repeated = hide.call(editor)
  assert.equal(first, repeated, 'overlapping exit events share one pending commit')
  assert.equal(commits, 1)
  complete.reject(new Error('temporary transport failure'))
  assert.equal(await first, false)
  assert.equal(editor.showTextEdit, true, 'a failed commit retains the editor')
  assert.equal(editor.editSessionId, 'session', 'a failed commit retains the draft session')
  const retry = hide.call(editor)
  assert.equal(commits, 2, 'a failed save can be retried')
  assert.equal(retry, hide.call(editor))
  complete.resolve({draftSaved:true})
  assert.equal(await retry, true)
  assert.equal(editor.showTextEdit, false)
  assert.equal(editor.editSessionId, null)
}
Promise.all([
  run('simple-mind-map/src/core/render/TextEdit.js', '  hideEditTextBox() {'),
  run('simple-mind-map/src/plugins/RichText.js', '  hideEditText(nodes) {')
]).then(() => console.log('PASS plain/rich editor single commit, failure draft retention and retry'))
  .catch(error => { console.error(error); process.exitCode = 1 })
