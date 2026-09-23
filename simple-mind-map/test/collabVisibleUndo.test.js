const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const constants = fs.readFileSync(
  path.join(__dirname, '../src/constants/constant.js'),
  'utf8'
)
const metadata = fs.readFileSync(
  path.join(__dirname, '../src/utils/collabMapMeta.js'),
  'utf8'
)

const listSource = constants.match(
  /export const nodeDataNoStylePropList = (\[[\s\S]*?\n\])/
)
assert.ok(listSource, 'node non-style field list is available')
const nonStyleFields = vm.runInNewContext(listSource[1])

const start = metadata.indexOf('export function collectStyleFields(')
const end = metadata.indexOf('\nexport function canonicalStructureFromTree(', start)
assert.ok(start >= 0 && end > start, 'collaboration style picker is available')
const collectStyleFields = vm.runInNewContext(
  `(${metadata.slice(start, end).trim().replace(/^export /, '')})`,
  {
    checkIsNodeStyleDataKey: key =>
      !/^_/.test(key) && !nonStyleFields.includes(key)
  }
)

// Inserting a child changes the parent's local childCount. That value is
// derived from structure and must not create a separate node.update history
// entry before the node.insert (which made every second Undo appear inert).
const parentPatch = collectStyleFields({
  childCount: 2,
  descendantCount: 4,
  subtreeVersion: 5,
  hasMore: false,
  traceId: 'transport-id'
})
assert.deepEqual(Object.keys(parentPatch), [])

const mixedPatch = collectStyleFields({
  childCount: 2,
  descendantCount: 4,
  subtreeVersion: 5,
  hasMore: false,
  traceId: 'transport-id',
  color: '#123456'
})
assert.deepEqual(Object.keys(mixedPatch), ['color'])
assert.equal(mixedPatch.color, '#123456')

console.log('collab visible undo tests passed')
