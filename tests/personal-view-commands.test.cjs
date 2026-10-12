const test = require('node:test')
const assert = require('node:assert/strict')
const { isPersonalViewCommand } = require('../simple-mind-map/src/utils/personalViewCommands')
test('expand commands bypass snapshots without excluding content or structural edits', () => {
  for (const name of ['SET_NODE_EXPAND', 'EXPAND_ALL', 'UNEXPAND_ALL', 'UNEXPAND_TO_LEVEL']) assert.equal(isPersonalViewCommand(name), true)
  assert.equal(isPersonalViewCommand('SET_NODE_DATA', [{}, { expand: false }]), true)
  assert.equal(isPersonalViewCommand('SET_NODE_DATA', [{}, { expand: false, text: 'changed' }]), false)
  for (const name of ['MOVE_NODE', 'REMOVE_NODE', 'SET_NODE_TEXT']) assert.equal(isPersonalViewCommand(name), false)
})
