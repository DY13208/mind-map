const assert = require('assert')
const {
  DEFAULT_BYTE_LIMIT,
  decodeCursor,
  encodeCursor,
  normalizeName,
  normalizeRequest,
  queryLegacyNodes
} = require('../bin/nodeQuery')

function expectCode(fn, code) {
  assert.throws(fn, err => err && err.code === code)
}

function testNormalizeName() {
  assert.strictEqual(normalizeName('<p>  Alpha&nbsp; Beta </p>'), 'alpha beta')
  assert.strictEqual(normalizeName('<span>项目</span> 计划'), '项目 计划')
}

function testRequestRules() {
  const absolute = normalizeRequest({ scope: 'level', level: 2 })
  assert.strictEqual(absolute.level_mode, 'absolute')
  assert.strictEqual(absolute.page_size, 800)
  assert.strictEqual(absolute.byte_limit, DEFAULT_BYTE_LIMIT)

  const relative = normalizeRequest({
    scope: 'level',
    level: 1,
    level_mode: 'relative',
    selector: { type: 'path', segments: ['根', '计划'] }
  })
  assert.deepStrictEqual(relative.selector.segments, ['根', '计划'])
  expectCode(
    () => normalizeRequest({ scope: 'level', level: 1, selector: { type: 'uid', value: 'n1' } }),
    'INVALID_QUERY'
  )
  expectCode(
    () => normalizeRequest({ scope: 'subtree' }),
    'MISSING_SELECTOR'
  )
  expectCode(
    () => normalizeRequest({ scope: 'self', selector: { type: 'path', segments: ['根'], match: 'fuzzy' } }),
    'INVALID_SELECTOR'
  )
  expectCode(
    () => normalizeRequest({ scope: 'self', selector: { type: 'uid', value: 'n1' }, include_write_hints: 'true' }),
    'INVALID_QUERY'
  )
}

function testCursorRoundtrip() {
  const encoded = encodeCursor({ v: 1, q: 'fingerprint', version: 7, offset: 3 })
  assert.deepStrictEqual(decodeCursor(encoded), {
    v: 1,
    q: 'fingerprint',
    version: 7,
    offset: 3
  })
  expectCode(() => decodeCursor('not-a-cursor'), 'INVALID_CURSOR')
}

function testLegacyFallbackScopes() {
  const obj = {
    root: { isRoot: true, position: 'a0', data: { uid: 'root', text: '根' }, children: ['other', 'target'] },
    other: { position: 'a0', data: { uid: 'other', text: '无关' }, children: ['other-leaf'] },
    'other-leaf': { position: 'a0', data: { uid: 'other-leaf', text: '无关叶子' }, children: [] },
    target: { position: 'a1', data: { uid: 'target', text: '目标' }, children: ['detail'] },
    detail: { position: 'a0', data: { uid: 'detail', text: '详情' }, children: [] }
  }
  const subtree = queryLegacyNodes(obj, 'legacy', 3, {
    selector: { type: 'path', segments: ['根', '目标'] }, scope: 'subtree'
  })
  assert.deepStrictEqual(subtree.items.map(item => item.uid), ['target', 'detail'])
  assert.ok(subtree.warnings.includes('legacy_snapshot_fallback：该导图尚未建立 room_nodes，已使用兼容快照读取'))
  const level = queryLegacyNodes(obj, 'legacy', 3, {
    scope: 'level', level: 1, level_mode: 'absolute'
  })
  assert.deepStrictEqual(level.items.map(item => item.uid), ['other', 'target'])
}

function testLegacyWriteHints() {
  const obj = {
    root: { isRoot: true, data: { uid: 'root', text: '根' }, children: ['target'] },
    target: {
      position: 'a0',
      data: {
        uid: 'target',
        text: '目标',
        note: '备注',
        hyperlink: 'https://example.test',
        hyperlinkTitle: '链接',
        __fv: { text: '12', note: 4, hyperlink: 2 }
      },
      children: []
    }
  }
  const query = { selector: { type: 'uid', value: 'target' }, scope: 'self' }
  const original = queryLegacyNodes(obj, 'legacy', 3, query)
  const disabled = queryLegacyNodes(obj, 'legacy', 3, { ...query, include_write_hints: false })
  assert.deepStrictEqual(disabled, original, 'disabled hints must keep the legacy response unchanged')
  assert.ok(!Object.prototype.hasOwnProperty.call(original.items[0], 'write_hints'))

  const hinted = queryLegacyNodes(obj, 'legacy', 3, { ...query, include_write_hints: true })
  assert.deepStrictEqual(hinted.items[0].write_hints, {
    update: {
      text: { uid: 'target', '__fv.text': 12 },
      note: { uid: 'target', '__fv.note': 4 },
      hyperlink: { uid: 'target', '__fv.hyperlink': 2 }
    }
  })
  assert.ok(hinted.items[0].data.hyperlinkTitle === '链接')

  const invalid = queryLegacyNodes({
    root: { isRoot: true, data: { uid: 'root', text: '根' }, children: ['bad'] },
    bad: { data: { uid: 'bad', text: '异常', __fv: { text: 'not-a-version' } }, children: [] }
  }, 'legacy', 3, { selector: { type: 'uid', value: 'bad' }, scope: 'self', include_write_hints: true })
  assert.deepStrictEqual(invalid.items[0].write_hints, {
    update: {
      note: { uid: 'bad', '__fv.note': 0 },
      hyperlink: { uid: 'bad', '__fv.hyperlink': 0 }
    }
  })
  assert.ok(invalid.warnings.some(warning => warning.includes('text 字段版本异常')))

  const hintedPage = queryLegacyNodes({
    root: { isRoot: true, data: { uid: 'root', text: '根' }, children: ['first', 'second'] },
    first: { position: 'a0', data: { uid: 'first', text: '一', __fv: { text: 1 } }, children: [] },
    second: { position: 'a1', data: { uid: 'second', text: '二', __fv: { text: 2 } }, children: [] }
  }, 'legacy', 3, { selector: { type: 'uid', value: 'root' }, scope: 'children', page_size: 1, include_write_hints: true })
  assert.ok(hintedPage.has_more)
  expectCode(() => queryLegacyNodes({
    root: { isRoot: true, data: { uid: 'root', text: '根' }, children: ['first', 'second'] },
    first: { position: 'a0', data: { uid: 'first', text: '一', __fv: { text: 1 } }, children: [] },
    second: { position: 'a1', data: { uid: 'second', text: '二', __fv: { text: 2 } }, children: [] }
  }, 'legacy', 3, { selector: { type: 'uid', value: 'root' }, scope: 'children', page_size: 1, cursor: hintedPage.next_cursor }), 'INVALID_CURSOR')

  const oldPage = queryLegacyNodes({
    root: { isRoot: true, data: { uid: 'root', text: '根' }, children: ['first', 'second'] },
    first: { position: 'a0', data: { uid: 'first', text: '一' }, children: [] },
    second: { position: 'a1', data: { uid: 'second', text: '二' }, children: [] }
  }, 'legacy', 3, { selector: { type: 'uid', value: 'root' }, scope: 'children', page_size: 1 })
  const explicitDisabledPage = queryLegacyNodes({
    root: { isRoot: true, data: { uid: 'root', text: '根' }, children: ['first', 'second'] },
    first: { position: 'a0', data: { uid: 'first', text: '一' }, children: [] },
    second: { position: 'a1', data: { uid: 'second', text: '二' }, children: [] }
  }, 'legacy', 3, { selector: { type: 'uid', value: 'root' }, scope: 'children', page_size: 1, include_write_hints: false })
  assert.strictEqual(explicitDisabledPage.next_cursor, oldPage.next_cursor, 'false must not change existing cursor fingerprints')

  const large = {
    root: { isRoot: true, data: { uid: 'root', text: '根' }, children: ['large'] },
    large: { data: { uid: 'large', text: '文字'.repeat(6000), __fv: { text: 'bad', note: 'bad', hyperlink: 'bad' } }, children: [] }
  }
  const fragmented = queryLegacyNodes(large, 'legacy', 3, {
    selector: { type: 'uid', value: 'large' }, scope: 'self', byte_limit: 4096, include_write_hints: true
  })
  assert.ok(fragmented.items[0].content_fragment, 'large text should use the existing fragment response')
  assert.ok(!fragmented.items[0].write_hints, 'no condition should be emitted for invalid field versions')
  assert.strictEqual(fragmented.warnings.filter(warning => warning.includes('字段版本异常')).length, 3)
  assert.ok(Buffer.byteLength(JSON.stringify(fragmented), 'utf8') <= fragmented.byte_limit,
    'legacy and field-version warnings must remain inside the response byte budget')
}

function createFakeQueryDb(nodeData) {
  const rows = [
    { uid: 'root', parent_uid: null, position: '', data: { uid: 'root', text: '根' }, is_root: true, node_version: 0 },
    { uid: 'target', parent_uid: 'root', position: 'a0', data: { uid: 'target', ...nodeData }, is_root: false, node_version: 1 }
  ]
  const calls = []
  return {
    calls,
    async query(sql, params = []) {
      const statement = String(sql).toLowerCase()
      calls.push({ sql: statement, params })
      if (statement.includes('select version from rooms')) return { rows: [{ version: 9 }] }
      if (statement.includes('with recursive ancestors as')) {
        return { rows: params[1].map(uid => ({
          target_uid: uid,
          path_parts: uid === 'root' ? ['根'] : ['根', '目标'],
          absolute_depth: uid === 'root' ? 0 : 1,
          has_cycle: false
        })) }
      }
      if (statement.includes('select uid, parent_uid, position, data, is_root, node_version')) {
        return { rows: rows.filter(row => params[1].includes(row.uid)) }
      }
      throw new Error(`Unexpected fake query: ${statement}`)
    }
  }
}

async function testDatabaseWriteHintsAndFragments() {
  const { queryRoomNodes } = require('../bin/nodeQuery')
  const input = { selector: { type: 'uid', value: 'target' }, scope: 'self' }
  const data = { text: '目标', note: '备注', hyperlink: 'https://example.test', hyperlinkTitle: '标题', __fv: { text: 5, note: 6, hyperlink: 7 } }
  const withoutHintsDb = createFakeQueryDb(data)
  const withoutHints = await queryRoomNodes(withoutHintsDb, 'fake-db-room', input)
  const explicitFalse = await queryRoomNodes(createFakeQueryDb(data), 'fake-db-room', { ...input, include_write_hints: false })
  assert.deepStrictEqual(explicitFalse, withoutHints, 'default database response must remain unchanged')

  const withHintsDb = createFakeQueryDb(data)
  const withHints = await queryRoomNodes(withHintsDb, 'fake-db-room', { ...input, include_write_hints: true })
  assert.deepStrictEqual(withHints.items[0].write_hints.update, {
    text: { uid: 'target', '__fv.text': 5 },
    note: { uid: 'target', '__fv.note': 6 },
    hyperlink: { uid: 'target', '__fv.hyperlink': 7 }
  })
  assert.strictEqual(withHintsDb.calls.length, withoutHintsDb.calls.length,
    'write hints must not add database queries')

  const longData = { text: '文字'.repeat(6000), __fv: { text: 8 } }
  const longDb = createFakeQueryDb(longData)
  const longInput = { selector: input.selector, scope: 'self', byte_limit: 4096, include_write_hints: true }
  const first = await queryRoomNodes(longDb, 'fake-db-room', longInput)
  assert.ok(first.items[0].content_fragment)
  assert.deepStrictEqual(first.items[0].write_hints.update.text, { uid: 'target', '__fv.text': 8 })
  assert.ok(Buffer.byteLength(JSON.stringify(first), 'utf8') <= first.byte_limit)
  const callsBeforeNextFragment = longDb.calls.length
  const next = await queryRoomNodes(longDb, 'fake-db-room', { ...longInput, cursor: first.next_cursor })
  assert.ok(next.items[0].content_fragment)
  assert.deepStrictEqual(next.items[0].write_hints.update.text, { uid: 'target', '__fv.text': 8 })
  assert.ok(Buffer.byteLength(JSON.stringify(next), 'utf8') <= next.byte_limit)
  assert.strictEqual(longDb.calls.length - callsBeforeNextFragment, callsBeforeNextFragment,
    'fragment continuation must not issue extra queries for write hints')
}

async function testAttachmentContentModes() {
  const { queryRoomNodes } = require('../bin/nodeQuery')
  const input = { selector: { type: 'uid', value: 'target' }, scope: 'self' }
  assert.strictEqual(normalizeRequest(input).attachment_content, 'preview')
  assert.strictEqual(normalizeRequest({ ...input, attachment_content: 'metadata' }).attachment_content, 'metadata')
  expectCode(() => normalizeRequest({ ...input, attachment_content: 'full' }), 'INVALID_QUERY')

  const extractedText = '附件正文'.repeat(10000)
  const metadataData = {
    text: '目标', note: '备注', attachmentId: 'attachment-1',
    attachmentName: '需求说明.pdf', attachmentMimeType: 'application/pdf',
    attachmentStatus: 'ready', attachmentError: '', attachmentExtractedText: extractedText,
    __fv: { text: 5, note: 6, attachment: 7 }
  }
  const metadata = await queryRoomNodes(
    createFakeQueryDb(metadataData), 'fake-db-room',
    { ...input, attachment_content: 'metadata', include_write_hints: true }
  )
  const item = metadata.items[0]
  assert.strictEqual(Object.hasOwn(item.data, 'attachmentExtractedText'), false)
  assert.strictEqual(item.data.attachmentId, 'attachment-1')
  assert.strictEqual(item.data.attachmentName, '需求说明.pdf')
  assert.strictEqual(item.data.attachmentStatus, 'ready')
  assert.strictEqual(item.data.note, '备注')
  assert.deepStrictEqual(item.data.__fv, metadataData.__fv)
  assert.deepStrictEqual(item.write_hints.update.text, { uid: 'target', '__fv.text': 5 })
  assert.deepStrictEqual(item.write_hints.update.note, { uid: 'target', '__fv.note': 6 })
  assert.deepStrictEqual(item.write_hints.update.hyperlink, { uid: 'target', '__fv.hyperlink': 0 })
  assert.ok(metadata.omitted_fields.includes('data.attachmentExtractedText'))
  assert.ok(Buffer.byteLength(JSON.stringify(metadata), 'utf8') <= metadata.byte_limit)

  const defaultPreview = await queryRoomNodes(
    createFakeQueryDb({ ...metadataData, attachmentExtractedText: '旧预览' }),
    'fake-db-room', input
  )
  assert.strictEqual(defaultPreview.items[0].data.attachmentExtractedText, '旧预览',
    'omitting the HTTP option must retain the legacy preview response')

  const longInput = { ...input, byte_limit: 4096 }
  const longDb = createFakeQueryDb({
    text: '文字'.repeat(6000),
    attachmentExtractedText: '附件预览'
  })
  const first = await queryRoomNodes(longDb, 'fake-db-room', longInput)
  assert.ok(first.items[0].content_fragment, 'node long-text fragment should remain supported')
  await assert.rejects(
    queryRoomNodes(longDb, 'fake-db-room', {
      ...longInput,
      attachment_content: 'metadata',
      cursor: first.next_cursor
    }),
    error => error && error.code === 'INVALID_CURSOR'
  )
  const next = await queryRoomNodes(longDb, 'fake-db-room', {
    ...longInput,
    cursor: first.next_cursor
  })
  assert.ok(next.items[0].content_fragment)
  assert.strictEqual(next.items[0].data.attachmentExtractedText, '附件预览')
}

testNormalizeName()
testRequestRules()
testCursorRoundtrip()
testLegacyFallbackScopes()
testLegacyWriteHints()
testDatabaseWriteHintsAndFragments()
  .then(testAttachmentContentModes)
  .then(() => console.log('nodeQuery tests passed'))
