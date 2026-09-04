const assert = require('assert')
  const { applyDirect } = require('../bin/collabV2/directApplier')
const { createMemoryStore } = require('../bin/collabV2/directStore')
const { mergeNodeDataLww, patchDelta } = require('../bin/fieldMerge')
const { fromCommitted } = require('../bin/collabV2/protocol')
const roomAcl = require('../bin/roomAcl')
const {
  NODE_FEATURE_MATRIX,
  NODE_FEATURE_STRUCTURAL_KEYS,
  buildNodeContentFields,
  resolveCollabImage,
  collabImagePayloadRisk,
  extractFormulaLatexFromHtml,
  painterStyleOnly,
  guardFeatureStructuralMutation,
  payloadFeaturePatch,
  isCollabImageKey,
  shouldPreserveRichHtml,
  normalizeAppliedUpdatePayload,
  recreateTypesFromPatch
} = require('../src/utils/collabNodeFeatures')

async function seed(store) {
  await store.insert({
    uid: 'root',
    parent_uid: null,
    position: '',
    is_root: true,
    data: { uid: 'root', text: 'Root' }
  })
  await store.insert({
    uid: 'n1',
    parent_uid: 'root',
    position: 'a0',
    data: {
      uid: 'n1',
      text: 'ABC',
      fillColor: '#fff',
      fontSize: 16,
      fontFamily: 'serif',
      color: '#111'
    }
  })
  await store.insert({
    uid: 'n2',
    parent_uid: 'root',
    position: 'a1',
    data: { uid: 'n2', text: 'B' }
  })
}

async function update(store, payload, version) {
  return applyDirect(
    store,
    { type: 'node.update', payload },
    { version }
  )
}

;(async () => {
  assert.ok(NODE_FEATURE_MATRIX.length >= 12)
  const names = NODE_FEATURE_MATRIX.map(item => item.feature)
  ;[
    'RichText',
    'Note',
    'Tag',
    'Hyperlink',
    'Icon',
    'Image',
    'Image Resize',
    'Formula',
    'Painter',
    'Shape',
    'mapRef',
    'Attachment'
  ].forEach(name => assert.ok(names.includes(name), name))
  const attachment = NODE_FEATURE_MATRIX.find(item => item.feature === 'Attachment')
  assert.strictEqual(attachment.status, 'not enabled')
  NODE_FEATURE_MATRIX.filter(item => item.feature !== 'Attachment').forEach(item => {
    assert.strictEqual(item.operation.includes('map.replace'), false, item.feature)
    assert.strictEqual(item.pgField.includes('rooms.nodes'), false, item.feature)
  })

  const store = createMemoryStore()
  await seed(store)
  let ver = 2
  const nextVer = () => ++ver

  const before = await store.getLive('n1')
  const beforeParent = before.parent_uid
  const beforePos = before.position

  const richHtml = '<p><strong style="color:#f00">ABC</strong></p>'
  const richOp = await update(
    store,
    { uid: 'n1', text: richHtml, richText: true },
    nextVer()
  )
  let n1 = await store.getLive('n1')
  assert.strictEqual(richOp.event.type, 'node.updated')
  assert.strictEqual(n1.data.text, richHtml)
  assert.strictEqual(n1.data.richText, true)
  assert.strictEqual(n1.data.fontSize, 16)
  assert.strictEqual(n1.parent_uid, beforeParent)
  assert.strictEqual(n1.position, beforePos)

  const content = buildNodeContentFields(
    { text: richHtml, richText: true, note: '' },
    { text: 'ABC' }
  )
  assert.strictEqual(content.text, richHtml)
  assert.strictEqual(content.richText, true)
  const cleared = buildNodeContentFields(
    { text: 'ABC' },
    { text: richHtml, richText: true }
  )
  assert.strictEqual(cleared.richText, null)

  await update(store, { uid: 'n1', note: 'memo' }, nextVer())
  n1 = await store.getLive('n1')
  assert.strictEqual(n1.data.note, 'memo')
  assert.strictEqual(n1.data.text, richHtml)
  await update(store, { uid: 'n1', note: 'memo-2' }, nextVer())
  n1 = await store.getLive('n1')
  assert.strictEqual(n1.data.note, 'memo-2')
  await update(store, { uid: 'n1', note: null }, nextVer())
  n1 = await store.getLive('n1')
  assert.strictEqual(n1.data.note, undefined)
  assert.strictEqual(n1.data.text, richHtml)

  await update(store, { uid: 'n1', tag: ['alpha'] }, nextVer())
  await update(store, { uid: 'n1', tag: ['alpha', 'beta'] }, nextVer())
  n1 = await store.getLive('n1')
  assert.deepStrictEqual(n1.data.tag, ['alpha', 'beta'])
  await update(store, { uid: 'n1', tag: null }, nextVer())
  n1 = await store.getLive('n1')
  assert.strictEqual(n1.data.tag, undefined)

  await update(
    store,
    { uid: 'n1', hyperlink: 'https://a.example', hyperlinkTitle: 'A' },
    nextVer()
  )
  await update(
    store,
    { uid: 'n1', hyperlink: 'https://b.example', hyperlinkTitle: 'B' },
    nextVer()
  )
  n1 = await store.getLive('n1')
  assert.strictEqual(n1.data.hyperlink, 'https://b.example')
  await update(
    store,
    { uid: 'n1', hyperlink: null, hyperlinkTitle: null },
    nextVer()
  )
  n1 = await store.getLive('n1')
  assert.strictEqual(n1.data.hyperlink, undefined)

  await update(store, { uid: 'n1', icon: ['priority_1'] }, nextVer())
  await update(store, { uid: 'n1', icon: null }, nextVer())
  n1 = await store.getLive('n1')
  assert.strictEqual(n1.data.icon, undefined)
  await update(store, { uid: 'n1', icon: ['priority_2'] }, nextVer())
  n1 = await store.getLive('n1')
  assert.deepStrictEqual(n1.data.icon, ['priority_2'])

  await update(
    store,
    {
      uid: 'n1',
      image: 'https://cdn.example/a.png',
      imageTitle: 'pic',
      imageSize: { width: 120, height: 80, custom: false }
    },
    nextVer()
  )
  n1 = await store.getLive('n1')
  assert.strictEqual(n1.data.image, 'https://cdn.example/a.png')
  await update(
    store,
    { uid: 'n1', imageSize: { width: 60, height: 40, custom: true } },
    nextVer()
  )
  n1 = await store.getLive('n1')
  assert.strictEqual(n1.data.image, 'https://cdn.example/a.png')
  assert.deepStrictEqual(n1.data.imageSize, {
    width: 60,
    height: 40,
    custom: true
  })

  const imgMap = { smm_img_key_1: 'data:image/png;base64,AAA' }
  assert.strictEqual(
    resolveCollabImage('smm_img_key_1', imgMap),
    'data:image/png;base64,AAA'
  )
  assert.strictEqual(isCollabImageKey('smm_img_key_1'), true)
  assert.strictEqual(collabImagePayloadRisk('data:image/png;base64,AAA'), 'base64')
  assert.strictEqual(collabImagePayloadRisk('https://cdn.example/a.png'), 'url')
  assert.strictEqual(collabImagePayloadRisk('smm_img_key_missing'), 'key-unresolved')

  const formulaHtml =
    '<p>E=<span class="ql-formula" data-value="E=mc^2">rendered</span></p>'
  await update(
    store,
    { uid: 'n1', text: formulaHtml, richText: true },
    nextVer()
  )
  n1 = await store.getLive('n1')
  assert.strictEqual(n1.data.text, formulaHtml)
  assert.deepStrictEqual(extractFormulaLatexFromHtml(formulaHtml), ['E=mc^2'])
  await update(store, { uid: 'n1', text: '<p>plain</p>', richText: true }, nextVer())
  n1 = await store.getLive('n1')
  assert.deepStrictEqual(extractFormulaLatexFromHtml(n1.data.text), [])

  const painter = painterStyleOnly({
    uid: 'stolen',
    parent: 'root',
    position: 'a9',
    generalization: [{ text: 'g' }],
    mapRef: { mapId: 'x' },
    fillColor: '#abc',
    fontSize: 18,
    shape: 'roundedRectangle'
  })
  assert.strictEqual(painter.uid, undefined)
  assert.strictEqual(painter.parent, undefined)
  assert.strictEqual(painter.position, undefined)
  assert.strictEqual(painter.generalization, undefined)
  assert.strictEqual(painter.mapRef, undefined)
  assert.strictEqual(painter.fillColor, '#abc')

  await update(
    store,
    { uid: 'n2', fillColor: '#abc', fontSize: 18, shape: 'roundedRectangle' },
    nextVer()
  )
  const n2 = await store.getLive('n2')
  assert.strictEqual(n2.data.fillColor, '#abc')
  assert.strictEqual(n2.data.shape, 'roundedRectangle')
  assert.strictEqual(n2.parent_uid, 'root')

  await update(
    store,
    { uid: 'n1', mapRef: { mapId: 'other', nodeId: 'x', type: 'node' } },
    nextVer()
  )
  n1 = await store.getLive('n1')
  assert.strictEqual(n1.data.mapRef.mapId, 'other')
  await update(store, { uid: 'n1', mapRef: { mapId: 'other2', type: 'map' } }, nextVer())
  n1 = await store.getLive('n1')
  assert.strictEqual(n1.data.mapRef.mapId, 'other2')
  await update(store, { uid: 'n1', mapRef: null }, nextVer())
  n1 = await store.getLive('n1')
  assert.strictEqual(n1.data.mapRef, undefined)

  const refHit = roomAcl.inferRoomAcl('/api/files/secret-room/ref-resolve', 'GET')
  assert.strictEqual(refHit.action, 'view')
  assert.strictEqual(roomAcl.roleAllows('viewer', 'view'), true)
  assert.strictEqual(roomAcl.roleAllows(null, 'view'), false)

  await applyDirect(
    store,
    {
      type: 'node.batch',
      payload: {
        ops: [
          { type: 'node.update', payload: { uid: 'n1', fontWeight: 'bold' } },
          { type: 'node.update', payload: { uid: 'n2', fontWeight: 'bold' } }
        ]
      }
    },
    { version: nextVer() }
  )
  n1 = await store.getLive('n1')
  assert.strictEqual(n1.data.fontWeight, 'bold')
  assert.strictEqual((await store.getLive('n2')).data.fontWeight, 'bold')

  const noteThenTag = mergeNodeDataLww(
    mergeNodeDataLww(
      { text: 'ABC', fillColor: '#fff', fontSize: 16 },
      { note: 'from-A' },
      10
    ).data,
    { tag: ['from-B'] },
    11
  )
  assert.strictEqual(noteThenTag.data.note, 'from-A')
  assert.deepStrictEqual(noteThenTag.data.tag, ['from-B'])
  assert.strictEqual(noteThenTag.data.fillColor, '#fff')
  assert.strictEqual(noteThenTag.data.text, 'ABC')

  const styleMerge = mergeNodeDataLww(
    { fillColor: '#fff', fontSize: 16, fontFamily: 'serif', color: '#111' },
    { fillColor: '#f00' },
    12
  )
  assert.strictEqual(styleMerge.data.fillColor, '#f00')
  assert.strictEqual(styleMerge.data.fontSize, 16)
  assert.strictEqual(styleMerge.data.fontFamily, 'serif')
  assert.strictEqual(styleMerge.data.color, '#111')

  const guarded = guardFeatureStructuralMutation({
    uid: 'n1',
    note: 'keep',
    parentUid: 'n2',
    parent: 'n2',
    index: 0,
    position: 'zz',
    order: 3
  })
  assert.strictEqual(guarded.label, 'NODE_FEATURE_STRUCTURAL_MUTATION')
  assert.ok(guarded.hit.length >= 4)
  assert.strictEqual(guarded.payload.note, 'keep')
  NODE_FEATURE_STRUCTURAL_KEYS.forEach(key => {
    assert.strictEqual(guarded.payload[key], undefined)
  })

  const structOp = await update(
    store,
    {
      uid: 'n1',
      note: 'after-guard',
      parentUid: 'n2',
      parent: 'n2',
      index: 0,
      position: 'hijack'
    },
    nextVer()
  )
  n1 = await store.getLive('n1')
  assert.strictEqual(n1.parent_uid, 'root')
  assert.strictEqual(n1.position, beforePos)
  assert.strictEqual(n1.data.note, 'after-guard')
  assert.strictEqual(structOp.event.type, 'node.updated')

  const patchOnly = payloadFeaturePatch({
    uid: 'n1',
    patch: { note: 'remote-note' },
    data: {
      uid: 'n1',
      text: 'should-not-apply',
      note: 'remote-note',
      tag: ['stale']
    }
  })
  assert.deepStrictEqual(patchOnly, { note: 'remote-note' })

  const undoOp = await update(store, { uid: 'n1', note: 'undo-me' }, nextVer())
  assert.strictEqual(undoOp.inversePayload.type, 'node.update')
  await applyDirect(
    store,
    {
      type: 'node.update',
      payload: { uid: 'n1', patch: undoOp.inversePayload.payload.patch }
    },
    { version: nextVer() }
  )
  n1 = await store.getLive('n1')
  assert.strictEqual(n1.data.note, 'after-guard')
  assert.strictEqual(n1.parent_uid, 'root')
  assert.strictEqual(n1.position, beforePos)

  const redoOp = await update(store, { uid: 'n1', note: 'undo-me' }, nextVer())
  n1 = await store.getLive('n1')
  assert.strictEqual(n1.data.note, 'undo-me')
  assert.strictEqual(redoOp.event.type, 'node.updated')

  const delta = patchDelta(
    { text: 'ABC', note: '', fillColor: '#fff' },
    { text: richHtml, richText: true, note: '', fillColor: '#fff' }
  )
  assert.strictEqual(delta.text, richHtml)
  assert.strictEqual(delta.richText, true)
  assert.strictEqual(delta.fillColor, undefined)

  assert.strictEqual(
    shouldPreserveRichHtml({
      richText: true,
      text: '<p><strong style="color:#f00">ABC</strong></p>'
    }),
    true
  )
  assert.strictEqual(shouldPreserveRichHtml({ text: 'ABC' }), false)

  await update(store, { uid: 'n1', tag: ['A', 'B'] }, nextVer())
  const tagDelete = await update(store, { uid: 'n1', tag: null }, nextVer())
  n1 = await store.getLive('n1')
  assert.strictEqual(n1.data.tag, undefined)
  const tagInverse = tagDelete.inversePayload
  assert.deepStrictEqual(tagInverse.payload.patch.tag, ['A', 'B'])
  await applyDirect(
    store,
    {
      type: 'node.update',
      payload: { uid: 'n1', patch: tagInverse.payload.patch }
    },
    { version: nextVer() }
  )
  n1 = await store.getLive('n1')
  assert.deepStrictEqual(n1.data.tag, ['A', 'B'])

  const committed = fromCommitted({
    operation_id: 'op-undo',
    operation_type: 'operation.undo',
    payload: { targetOperationId: 'op-tag' },
    event: {
      type: 'node.updated',
      payload: {
        uid: 'n1',
        patch: { tag: ['A', 'B'] },
        data: { uid: 'n1', tag: ['A', 'B'] }
      }
    },
    version: 99
  })
  assert.strictEqual(committed.type, 'node.updated')
  assert.strictEqual(committed.payload.uid, 'n1')
  assert.deepStrictEqual(committed.payload.patch.tag, ['A', 'B'])
  const applied = normalizeAppliedUpdatePayload(committed)
  assert.strictEqual(applied.uid, 'n1')
  assert.deepStrictEqual(applied.patch.tag, ['A', 'B'])
  assert.deepStrictEqual(recreateTypesFromPatch(applied.patch), ['tag'])

  ;['hyperlink', 'image', 'mapRef', 'shape'].forEach(key => {
    const restored = mergeNodeDataLww({ text: 'x' }, { [key]: key === 'shape' ? 'diamond' : { v: 1 } }, 40)
    assert.ok(restored.data[key])
  })

  console.log('collabNodeFeatures tests ok', {
    features: NODE_FEATURE_MATRIX.length,
    imageRisk: collabImagePayloadRisk('data:image/png;base64,AAA')
  })
})().catch(err => {
  console.error(err)
  process.exit(1)
})
