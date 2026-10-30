import test from 'node:test'
import assert from 'node:assert/strict'
import { readAttachmentKnowledge, searchAttachmentKnowledge } from '../bin/mcpAttachmentKnowledge.mjs'

const UPDATED_AT = '2026-10-30T04:00:00.000Z'
const isTextCall = call => new URL(call.url, 'http://local').pathname.endsWith('/text')

function makeFixture(options = {}) {
  const calls = []
  const ids = options.currentIds || ['a1']
  const node = { uid: 'node-1', data: ids.length === 1 ? { attachmentId: ids[0] } : { attachmentIds: ids } }
  const attachments = options.listedAttachments || ids.map((id, index) => ({
    id,
    fileName: `file-${id}.txt`,
    status: options.attachmentStatus || 'ready',
    contentHash: `hash-${id}`,
    updatedAt: options.updatedAt || UPDATED_AT,
    extractedChars: Array.from(options.text || '').length
  }))
  const textById = options.textById || Object.fromEntries(ids.map(id => [id, options.text ?? '已解析附件内容']))
  const api = async (url, request = {}) => {
    const body = request.body ? JSON.parse(request.body) : null
    calls.push({ url, method: request.method || 'GET', body })
    if (url.endsWith('/nodes/query')) return { version: options.nodeVersion ?? 7, items: [node] }
    if (url.includes('/attachments?')) return { attachments }
    if (url.endsWith('/api/wiki-compiler/api/attachments/search')) {
      if (options.wikiSearchError) throw options.wikiSearchError
      return options.wikiSearchResult || { status: options.wikiSearchStatus || 'not_synced' }
    }
    if (url.endsWith('/api/wiki-compiler/api/attachments/read')) {
      if (options.wikiReadError) throw options.wikiReadError
      return options.wikiReadResult || { status: options.wikiReadStatus || 'not_synced' }
    }
    const parsed = new URL(url, 'http://local')
    if (parsed.pathname.endsWith('/text')) {
      if (options.textError) throw options.textError
      const id = parsed.pathname.split('/').at(-2)
      const meta = attachments.find(item => item.id === id) || {
        id, fileName: `file-${id}.txt`, status: options.attachmentStatus || 'ready',
        contentHash: `hash-${id}`, updatedAt: options.updatedAt || UPDATED_AT
      }
      const source = Array.from(String(textById[id] || ''))
      const offset = Number(parsed.searchParams.get('offset') || 0)
      const limit = Number(parsed.searchParams.get('limit') || 4000)
      const text = meta.status === 'ready' ? source.slice(offset, offset + limit).join('') : ''
      const length = Array.from(text).length
      const nextOffset = offset + length
      return {
        ok: true,
        room_key: 'room-1',
        attachment: meta,
        text,
        offset,
        length,
        total_chars: source.length,
        has_more: nextOffset < source.length,
        next_offset: nextOffset < source.length ? nextOffset : null
      }
    }
    throw new Error(`Unexpected API call: ${request.method || 'GET'} ${url}`)
  }
  return { api, calls, node, attachments }
}

const input = (overrides = {}) => ({ room_key: 'room-1', node_uid: 'node-1', query: '审批规则', ...overrides })

test('Wiki search fallback reads one current attachment page and marks it as a preview', async () => {
  const { api, calls } = makeFixture({
    currentIds: ['a1', 'a2'],
    text: '合规制度'.repeat(1250),
    wikiSearchStatus: 'no_match'
  })
  const result = await searchAttachmentKnowledge(api, input())
  const wikiCall = calls.find(call => call.url.endsWith('/api/wiki-compiler/api/attachments/search'))
  const textCall = calls.find(isTextCall)
  assert.equal(wikiCall.body.attachment_id, undefined)
  assert.equal(textCall.url.includes('limit=4000'), true)
  assert.equal(textCall.url.includes('/a1/text'), true)
  assert.equal(calls.some(call => new URL(call.url, 'http://local').pathname.endsWith('/a2/text')), false)
  assert.equal(result.source_backend, 'attachment')
  assert.equal(result.fallback_reason, 'no_match')
  assert.equal(result.matches_query, false)
  assert.equal(result.is_excerpt, true)
  assert.equal(result.complete, false)
  assert.equal(result.search_complete, false)
  assert.equal(result.remaining_attachment_count, 1)
  assert.equal(result.remaining_attachments[0].attachment_id, 'a2')
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].matches_query, false)
  assert.equal(Object.hasOwn(result, 'text'), false, 'do not duplicate the preview at the top level')
  assert(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 12 * 1024)
  assert.equal(result.next_read.offset, Array.from(result.items[0].text).length)
  assert(result.items[0].text.length < 4000, 'JSON budget should clip long Chinese text while preserving a continuation')
})

test('Wiki unavailable states use one bounded original-text page', async () => {
  for (const wikiSearchStatus of ['not_synced', 'stale', 'unavailable', 'index_upgrade_required']) {
    const { api, calls } = makeFixture({ wikiSearchStatus, text: '现有解析内容' })
    const result = await searchAttachmentKnowledge(api, input({ attachment_id: 'a1' }))
    assert.equal(result.source_backend, 'attachment', wikiSearchStatus)
    assert.equal(result.fallback_reason, wikiSearchStatus)
    assert.equal(result.items[0].matches_query, false)
    assert.equal(calls.filter(isTextCall).length, 1)
  }
})

test('historic attachment rows are rejected when the current node pointer differs', async () => {
  const { api, calls } = makeFixture({
    currentIds: ['current'],
    listedAttachments: [{ id: 'historical', fileName: 'old.txt', status: 'ready', contentHash: 'old-hash', updatedAt: UPDATED_AT }]
  })
  const result = await searchAttachmentKnowledge(api, input({ attachment_id: 'historical' }))
  assert.equal(result.status, 'not_attached')
  assert.equal(calls.some(call => call.url.includes('/api/wiki-compiler/')), false)
  assert.equal(calls.some(isTextCall), false)
})

test('permission and not-found errors never fall back to original text', async () => {
  for (const statusCode of [403, 404]) {
    const error = Object.assign(new Error(`HTTP ${statusCode}`), { statusCode })
    const { api, calls } = makeFixture({ wikiSearchError: error })
    await assert.rejects(searchAttachmentKnowledge(api, input({ attachment_id: 'a1' })), { statusCode })
    assert.equal(calls.some(isTextCall), false)
  }
})

test('original-text continuation is source-bound, version-bound, and counts emoji by code point', async () => {
  const { api, calls } = makeFixture({ text: '😀'.repeat(4001), wikiReadStatus: 'not_synced' })
  const first = await readAttachmentKnowledge(api, input({ attachment_id: 'a1' }))
  assert.equal(first.source_backend, 'attachment')
  assert.equal(first.fallback_reason, 'not_synced')
  assert.equal(first.is_excerpt, true)
  assert.equal(first.complete, false)
  assert.equal(Array.from(first.text).length, 4000)
  assert.equal(first.next_offset, 4000)
  assert.equal(first.next_read.offset, 4000)
  assert.equal(first.next_read.expected_version, 7)
  assert.equal(first.next_read.expected_content_hash, 'hash-a1')
  assert.equal(first.next_read.expected_attachment_updated_at, UPDATED_AT)
  assert(Buffer.byteLength(JSON.stringify(first), 'utf8') <= 20 * 1024)

  calls.length = 0
  const second = await readAttachmentKnowledge(api, { ...first.next_read, length: 4000 })
  assert.equal(second.source_backend, 'attachment')
  assert.equal(second.text, '😀')
  assert.equal(second.offset, 4000)
  assert.equal(second.has_more, false)
  assert.equal(second.complete, true)
  assert.equal(second.complete_scope, 'parsed_text')
  assert.equal(second.parsed_text_end, true)
  assert.equal(calls.some(call => call.url.endsWith('/api/wiki-compiler/api/attachments/read')), false)
  assert.equal(new URL(calls.find(isTextCall).url, 'http://local').searchParams.get('offset'), '4000')
})

test('a short original fallback page may complete the parsed text without claiming the original file', async () => {
  const { api } = makeFixture({ text: '短解析文本', wikiReadStatus: 'unavailable' })
  const result = await readAttachmentKnowledge(api, input({ attachment_id: 'a1' }))
  assert.equal(result.source_backend, 'attachment')
  assert.equal(result.text, '短解析文本')
  assert.equal(result.has_more, false)
  assert.equal(result.complete, true)
  assert.equal(result.complete_scope, 'parsed_text')
  assert.equal(result.parsed_text_end, true)
})

test('attachment continuation stops when re-extraction updates metadata without changing the hash', async () => {
  const firstFixture = makeFixture({ text: '甲乙丙丁戊'.repeat(1200), wikiReadStatus: 'unavailable' })
  const first = await readAttachmentKnowledge(firstFixture.api, input({ attachment_id: 'a1' }))
  assert.equal(first.next_read.expected_content_hash, 'hash-a1')
  const changed = makeFixture({
    text: '甲乙丙丁戊'.repeat(1200),
    updatedAt: '2026-10-30T04:01:00.000Z',
    wikiReadStatus: 'unavailable'
  })
  const result = await readAttachmentKnowledge(changed.api, { ...first.next_read })
  assert.equal(result.status, 'stale')
  assert.equal(result.restart_required, true)
  assert.equal(result.text, '')
  assert.equal(changed.calls.some(isTextCall), false)
  assert.equal(changed.calls.some(call => call.url.endsWith('/api/wiki-compiler/api/attachments/read')), false)
})

test('pending processing and failed states are preserved without re-parsing', async () => {
  for (const status of ['pending', 'processing', 'failed']) {
    const { api, calls } = makeFixture({ attachmentStatus: status, wikiReadStatus: status, text: '' })
    const result = await readAttachmentKnowledge(api, input({ attachment_id: 'a1' }))
    assert.equal(result.status, status)
    assert.equal(result.text, '')
    assert.equal(result.complete, false)
    assert.equal(calls.filter(isTextCall).length, 1)
    assert.equal(calls.some(call => call.url.endsWith('/knowledge/ensure')), false)
  }
})

test('a stale Wiki cursor requests restart without switching to original text', async () => {
  const { api, calls } = makeFixture({ wikiReadResult: { status: 'stale', version: 8 } })
  const result = await readAttachmentKnowledge(api, input({ attachment_id: 'a1', cursor: 'wiki-cursor' }))
  assert.equal(result.status, 'stale')
  assert.equal(result.source_backend, 'wiki')
  assert.equal(result.restart_required, true)
  assert.equal(calls.some(isTextCall), false)
})
