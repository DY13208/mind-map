'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function loadNodePatchPayload(patchDelta) {
  const file = path.join(__dirname, '../src/plugins/Cooperate.js')
  const source = fs.readFileSync(file, 'utf8')
  const start = source.indexOf('  nodePatchPayload(node, options = {}) {')
  const end = source.indexOf('\n  flushHttpText()', start)
  assert.ok(start >= 0 && end > start, 'Cooperate.nodePatchPayload source found')
  const methodSource = source
    .slice(start, end)
    .trim()
    .replace(/^nodePatchPayload/, 'function nodePatchPayload')
  return vm.runInNewContext('(' + methodSource + ')', {
    NULLABLE_PATCH_KEYS: ['isFloating'],
    collabGeneralization: { snapshotValue: value => value },
    collabNodeFeatures: {
      buildNodeContentFields: data => ({
        text: data.text,
        note: data.note,
        richText: data.richText
      }),
      publishRichTextPersistTrace() {},
      isEmptyFeatureValue: (_key, value) =>
        value === undefined || value === null || value === '',
      applyNullableGroupClears() {}
    },
    collabSpecialObjects: {
      canonicalImageFields: () => ({
        unresolvedKey: false,
        skipTransient: false,
        image: null,
        imageTitle: null,
        imageSize: null,
        storedImageValue: null
      }),
      publishImageTrace() {}
    },
    collectStyleFields: () => ({}),
    mapRefUtil: { normalizeMapRef: value => value },
    patchDelta
  })
}

function makeNode(data) {
  return {
    getData(key) {
      return key ? data[key] : data
    },
    getImageUrl() {
      return ''
    }
  }
}

async function main() {
  const { patchDelta } = await import('../src/utils/fieldMerge.js')
  assert.deepEqual(patchDelta({ isFloating: null }, { isFloating: false }), {})
  assert.deepEqual(patchDelta({}, { isFloating: false }), {})
  assert.deepEqual(patchDelta({ isFloating: false }, {}), {})
  assert.deepEqual(
    patchDelta({ isFloating: true }, { isFloating: false }),
    { isFloating: false }
  )
  assert.deepEqual(
    patchDelta({ isFloating: null }, { isFloating: false, traceId: 'move-1' }),
    { traceId: 'move-1' }
  )
  assert.deepEqual(
    patchDelta(
      { isFloating: false, note: 'existing' },
      { isFloating: null, note: null }
    ),
    { note: null }
  )
  assert.deepEqual(
    patchDelta({ isFloating: 'false' }, { isFloating: false }),
    { isFloating: false }
  )

  const nodePatchPayload = loadNodePatchPayload(patchDelta)
  const nullToFalse = nodePatchPayload.call(
    {
      lastPushed: {
        n2: { full: { text: 'move candidate', note: '', isFloating: null } }
      },
      resolveHttpPatchNode: node => node,
      mindMap: { renderer: { renderTree: { data: { imgMap: {} } } } }
    },
    makeNode({ uid: 'n2', text: 'move candidate', note: '', isFloating: false }),
    { onlyChanged: true }
  )
  assert.equal(nullToFalse, null)

  const explicitFalse = nodePatchPayload.call(
    {
      lastPushed: {
        n2: { full: { text: 'move candidate', note: '', isFloating: true } }
      },
      resolveHttpPatchNode: node => node,
      mindMap: { renderer: { renderTree: { data: { imgMap: {} } } } }
    },
    makeNode({ uid: 'n2', text: 'move candidate', note: '', isFloating: false }),
    { onlyChanged: true }
  )
  assert.deepEqual(explicitFalse, { isFloating: false })
  console.log('fieldMerge floating semantics tests passed')
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
