'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '../simple-mind-map/src/plugins/Cooperate.js'), 'utf8')
const start = source.indexOf('  nodePatchPayload(node, options = {}) {')
const end = source.indexOf('\n  flushHttpText()', start)
assert.ok(start > 0 && end > start)
const Runtime = vm.runInNewContext(`(class { ${source.slice(start, end)} })`, {
  collabNodeFeatures: {
    buildNodeContentFields: data => ({ text: data.text, richText: data.richText, note: data.note }),
    publishRichTextPersistTrace() {}, applyNullableGroupClears() {}
  },
  collabSpecialObjects: { canonicalImageFields: () => ({}), publishImageTrace() {} },
  collectStyleFields: data => ({ color: data.color }),
  NULLABLE_PATCH_KEYS: [],
  patchDelta: (old, next) => Object.fromEntries(Object.entries(next).filter(([key, value]) => JSON.stringify(old[key]) !== JSON.stringify(value)))
})
const c = new Runtime()
const data = { uid: 'child-a', text: '<p>preview</p>', richText: true, note: 'new note', color: 'blue' }
const baseline = { text: 'initial', richText: false, note: 'old note', color: 'red' }
const node = { getData: key => key ? data[key] : data }
c.resolveHttpPatchNode = value => value
c.lastPushed = { 'child-a': { full: baseline } }
c.httpRoomKey = 'room-a'
let sessions = [{ uid: 'child-a', roomKey: 'room-a', state: 'editing', fields: ['text', 'richText'] }]
c.editSessionManager = { list: () => sessions }
let delta = c.nodePatchPayload(node, { onlyChanged: true })
assert.equal(delta.text, undefined, 'Active editor text must not use background writes')
assert.equal(delta.richText, undefined)
assert.equal(delta.note, 'new note', 'Unrelated fields remain writable')
assert.equal(delta.color, 'blue')
assert.equal(c.nodePatchPayload(node).text, baseline.text, 'Acknowledging another field must not acknowledge a text preview')
sessions[0].state = 'conflict'
assert.equal(c.nodePatchPayload(node, { onlyChanged: true }).text, undefined, 'Conflict drafts stay isolated')
sessions[0].fields = ['note']; sessions[0].state = 'editing'
delta = c.nodePatchPayload(node, { onlyChanged: true })
assert.equal(delta.note, undefined, 'Note drafts also own only their field')
assert.equal(delta.text, data.text, 'Another field on the same UID remains writable')
sessions[0].fields = ['text', 'richText']
c.currentData = { 'child-a': { data: { text: 'committed ACK', richText: true } } }
assert.equal(c.nodePatchPayload(node).text, 'committed ACK', 'Own ACK must advance the acknowledged snapshot while a newer draft remains separate')
delete c.currentData
sessions[0].uid = 'child-b'
assert.equal(c.nodePatchPayload(node, { onlyChanged: true }).text, data.text, 'A different child does not block this UID')
sessions[0].uid = 'child-a'; sessions[0].roomKey = 'other-room'
assert.equal(c.nodePatchPayload(node, { onlyChanged: true }).text, data.text, 'Another room must not block this UID')
sessions = []
assert.equal(c.nodePatchPayload(node, { onlyChanged: true }).text, data.text)
data.text = baseline.text; data.resetRichText = true
baseline.richText = undefined
assert.equal(c.nodePatchPayload(node, { onlyChanged: true }).richText, undefined, 'Display-only rich text flags must not become parent edits')
data.text = '<p>preview</p>'
assert.equal(data.text, '<p>preview</p>', 'Draft projection must remain intact')
assert.equal(baseline.text, 'initial', 'Background calculation must not mutate the acknowledged baseline')
console.log('PASS background patches respect editor field ownership, UID and room scope')

const renderSource = fs.readFileSync(path.join(__dirname, '../simple-mind-map/src/core/render/node/nodeCreateContents.js'), 'utf8')
const renderStart = renderSource.indexOf('function createRichTextNode(specifyText) {')
const renderEnd = renderSource.indexOf('\nfunction ', renderStart + 1)
assert.ok(renderStart > 0 && renderEnd > renderStart)
const stopAfterNormalization = new Error('stop after render normalization')
const render = vm.runInNewContext(`(${renderSource.slice(renderStart, renderEnd)})`, {
  G: class {}, isUndef: value => value == null,
  getNodeRichTextStyles: () => { throw stopAfterNormalization }
})
for (const collaborative of [true, false]) {
  const original = { text: 'plain child', richText: true, resetRichText: true }
  const instance = { nodeData: { data: original }, hasCustomWidth: () => false,
    getData: field => original[field],
    mindMap: { opt: {}, cooperate: collaborative ? { collabV2Adapter: {} } : null } }
  assert.throws(() => render.call(instance), error => error === stopAfterNormalization)
  assert.equal(original.text, collaborative ? 'plain child' : '<p>plain child</p>')
  assert.equal(original.resetRichText, collaborative ? true : undefined)
}
console.log('PASS collaborative rendering preserves authority; standalone normalization remains compatible')
