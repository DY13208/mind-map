import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSopContext } from '../bin/sopContext.mjs'

const rows = [
  { uid: 'root', parent_uid: null, data: { text: 'Root' } },
  { uid: 'target', parent_uid: 'root', data: { text: 'Same', note: 'Evidence', hyperlink: 'https://example.com', mapRef: { mapId: 'other' }, associativeLineTargets: ['sibling'], attachmentExtractedText: 'large preview' } },
  { uid: 'sibling', parent_uid: 'root', data: { text: 'Same' } },
  { uid: 'sop', parent_uid: 'target', data: { text: 'SOP' } },
  { uid: 'c', parent_uid: 'sop', data: { text: 'C：验收' } },
  { uid: 'p', parent_uid: 'sop', data: { text: 'P：执行' } }
]
const byUid = new Map(rows.map(row => [row.uid, row]))

function createApi({ attachments = [], wikiStatus = 'ok', noMatch = false, wikiVersion = 8, missingWikiVersion = false, readComplete = false, freshNodeVersion } = {}) {
  const calls = []
  const versionField = missingWikiVersion ? {} : { version: wikiVersion }
  const api = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null })
    if (url.endsWith('/nodes/query')) {
      const body = JSON.parse(options.body)
      const uid = body.selector.value
      let found = body.scope === 'path' ? [byUid.get('root'), byUid.get(uid)]
        : body.scope === 'children' ? rows.filter(row => row.parent_uid === uid)
          : body.scope === 'subtree' ? rows.filter(row => row.uid === uid || (uid === 'target' && ['sop', 'c', 'p'].includes(row.uid)))
            : body.scope === 'self' ? [byUid.get(uid)] : []
      found = [...new Map(found.filter(Boolean).map(row => [row.uid, row])).values()]
      const offset = Number(body.cursor || 0)
      const omitted = new Set()
      const items = found.slice(offset, offset + 1).map(row => {
        const data = { ...row.data }
        const liveIds = attachments.filter(item => item.node_uid === row.uid).map(item => item.meta.id || item.meta.attachment_id).filter(Boolean)
        if (liveIds.length === 1) data.attachmentId = liveIds[0]
        else if (liveIds.length > 1) data.attachmentIds = liveIds
        if (body.attachment_content === 'metadata' && Object.hasOwn(data, 'attachmentExtractedText')) {
          delete data.attachmentExtractedText
          omitted.add('data.attachmentExtractedText')
        }
        return { ...row, data }
      })
      const version = body.scope === 'self' && freshNodeVersion !== undefined ? freshNodeVersion : 8
      return { version, items, has_more: offset + 1 < found.length, next_cursor: offset + 1 < found.length ? String(offset + 1) : null, omitted_fields: [...omitted], warnings: [] }
    }
    if (url.includes('/attachments?')) {
      const uid = new URL(url, 'http://local').searchParams.get('node_uid')
      return { attachments: attachments.filter(item => item.node_uid === uid).map(item => item.meta) }
    }
    if (url.endsWith('/attachments/search')) {
      if (wikiStatus !== 'ok') return { status: wikiStatus }
      if (noMatch) return { status: 'ok', ...versionField, items: [] }
      return { status: 'ok', ...versionField, items: [{ attachment_id: JSON.parse(options.body).attachment_id, chunk_id: 'c1', offset: 0, text: 'matching excerpt', score: 1, source: { file_name: 'a.txt', ...versionField } }] }
    }
    if (url.endsWith('/attachments/read')) {
      const readBody = JSON.parse(options.body)
      return { status: wikiStatus, room_key: 'room', node_uid: 'target', source: { attachment_id: readBody.attachment_id, ...versionField }, generation: 'g1', text: 'first page', has_more: !readComplete, next_cursor: readComplete ? null : 'cursor-g1', complete: readComplete }
    }
    const parsed = new URL(url, 'http://local')
    if (parsed.pathname.includes('/attachments/') && parsed.pathname.endsWith('/text')) {
      const id = parsed.pathname.split('/').at(-2)
      const meta = attachments.find(item => String(item.meta.id || item.meta.attachment_id) === id)?.meta || {}
      const text = 'first raw page'
      return {
        ok: true,
        room_key: 'room',
        attachment: { id, fileName: meta.file_name || meta.fileName || 'a.txt', status: meta.status || 'ready', contentHash: meta.content_hash || meta.contentHash || 'hash-a1', updatedAt: meta.updatedAt || 'updated-a1' },
        text,
        offset: Number(parsed.searchParams.get('offset') || 0),
        length: Array.from(text).length,
        total_chars: 30,
        has_more: true,
        next_offset: 15
      }
    }
    if (url.includes('/attachments/') && url.includes('/text')) throw new Error('default path must not read the whole attachment')
    throw new Error(url)
  }
  return { api, calls }
}

const attachment = (id = 'a1', node_uid = 'target') => ({ node_uid, meta: { id, node_uid, status: 'ready', file_name: 'a.txt', content_hash: 'hash-a1' } })

test('metadata defaults to references, preserves node context, and does not read attachment text', async () => {
  const { api, calls } = createApi({ attachments: [attachment()] })
  const result = await buildSopContext('room', 'target', api)
  assert.equal(result.response_version, 2)
  assert.equal(result.target.uid, 'target')
  assert.equal(result.target.revision, 8)
  assert.deepEqual(result.path.map(node => node.uid), ['root', 'target'])
  assert.deepEqual(result.children.map(node => node.uid), ['sop'])
  assert.deepEqual(result.subtree.map(node => node.uid), ['target', 'sop', 'c', 'p'])
  assert.deepEqual(result.siblings.map(node => node.uid), ['sibling'])
  assert.deepEqual(result.notes, [{ uid: 'target', note: 'Evidence' }])
  assert.deepEqual(result.references.map(ref => ref.kind), ['hyperlink', 'map_ref', 'associative'])
  assert.equal(result.attachments.references[0].attachment_id, 'a1')
  assert.equal(result.attachments.mode, 'metadata')
  assert.equal(result.attachments_complete, false)
  assert.equal(result.nodes_complete, true)
  assert.equal(result.complete, false)
  assert.equal(calls.every(call => call.method === 'GET' || call.url.endsWith('/nodes/query')), true)
  assert(calls.filter(call => call.url.endsWith('/nodes/query')).every(call => call.body.attachment_content === 'metadata'))
  assert.equal(calls.some(call => call.url.includes('/attachments/') && call.url.includes('/text')), false)
  const leaf = await buildSopContext('room', 'sibling', api)
  assert.equal(leaf.existing_sop.found, false)
  assert.deepEqual(leaf.children, [])
  assert.deepEqual(leaf.siblings.map(node => node.uid), ['target'])
  assert.equal(leaf.attachments_complete, false)
  assert.equal(leaf.complete, false)
})

test('relevant mode searches only exact attachment and returns excerpts without claiming completeness', async () => {
  const { api, calls } = createApi({ attachments: [attachment()] })
  const result = await buildSopContext('room', 'target', api, { attachment_mode: 'relevant', query: 'retention policy' })
  const search = calls.find(call => call.url.endsWith('/attachments/search'))
  assert.deepEqual(search.body, { room_key: 'room', node_uid: 'target', attachment_id: 'a1', query: 'retention policy', top_k: 5 })
  assert.equal(result.attachments.results[0].text, 'matching excerpt')
  assert.equal(result.attachments.results[0].is_excerpt, true)
  assert.equal(result.attachments_complete, false)
  assert.equal(result.complete, false)
})

test('no-match preserves status and direct-read fallback without trying another node', async () => {
  const { api, calls } = createApi({ attachments: [attachment()], noMatch: true })
  const result = await buildSopContext('room', 'target', api, { attachment_mode: 'relevant', query: 'rule' })
  assert.equal(result.attachments.results[0].source_backend, 'attachment')
  assert.equal(result.attachments.results[0].fallback_reason, 'no_match')
  assert.equal(result.attachments.results[0].matches_query, false)
  assert.equal(result.attachments.results[0].fallback.attachment_id, 'a1')
  assert.equal(calls.filter(call => new URL(call.url, 'http://local').pathname.endsWith('/text')).length, 1)
  assert.equal(calls.filter(call => call.url.endsWith('/attachments/search')).length, 1)
})

test('same attachment is deduplicated across node references and searched once', async () => {
  const { api, calls } = createApi({ attachments: [attachment('shared', 'target'), attachment('shared', 'sop')] })
  const result = await buildSopContext('room', 'target', api, { attachment_mode: 'relevant', query: 'topic' })
  assert.equal(result.attachments.references.length, 1)
  assert.deepEqual(result.attachments.references[0].node_uids, ['target', 'sop'])
  assert.equal(calls.filter(call => call.url.endsWith('/attachments/search')).length, 1)
})

test('re-resolves the current node before content reads and discards content when it changed', async () => {
  for (const attachmentMode of ['relevant', 'full']) {
    const { api, calls } = createApi({ attachments: [attachment()], freshNodeVersion: 9 })
    const result = await buildSopContext('room', 'target', api, {
      attachment_mode: attachmentMode,
      ...(attachmentMode === 'relevant' ? { query: 'rule' } : {})
    })
    assert.equal(result.attachments.results[0].status, 'stale')
    assert.equal(result.attachments.results[0].text, undefined)
    assert.equal(result.attachments.results[0].fallback?.attachment_id, 'a1')
    assert.equal(result.attachments_complete, false)
    assert.equal(result.complete, false)
    assert.equal(calls.some(call => call.url.endsWith('/attachments/search')), false)
    assert.equal(calls.some(call => call.url.endsWith('/attachments/read')), false)
    assert.equal(calls.some(call => new URL(call.url, 'http://local').pathname.endsWith('/text')), false)
  }
})

test('full mode returns only first attachment page and a continuation cursor', async () => {
  const { api, calls } = createApi({ attachments: [attachment(), attachment('a2')] })
  const result = await buildSopContext('room', 'target', api, { attachment_mode: 'full' })
  const reads = calls.filter(call => call.url.endsWith('/attachments/read'))
  assert.equal(reads.length, 1)
  assert.equal(reads[0].body.attachment_id, 'a1')
  assert.equal(reads[0].body.length, 4000)
  assert.equal(result.attachments.results[0].text, 'first page')
  assert.equal(result.attachments.results[0].next_cursor, 'cursor-g1')
  assert.equal(result.attachments_complete, false)
  assert.equal(result.complete, false)
})

test('relevant mode rejects excerpts from a Wiki version newer than the node snapshot', async () => {
  const { api } = createApi({ attachments: [attachment()], wikiVersion: 9 })
  const result = await buildSopContext('room', 'target', api, { attachment_mode: 'relevant', query: 'rule' })
  assert.equal(result.attachments.results[0].status, 'ok')
  assert.equal(result.attachments.results[0].source_backend, 'attachment')
  assert.equal(result.attachments.results[0].fallback_reason, 'stale')
  assert.equal(result.attachments.results[0].matches_query, false)
  assert.equal(result.attachments.results[0].fallback.attachment_id, 'a1')
  assert.match(result.attachments.results[0].warning, /版本/)
  assert.equal(result.attachments_complete, false)
  assert.equal(result.warnings.some(warning => /版本/.test(warning)), true)
})

test('full mode requires a matching explicit Wiki version before returning complete text', async () => {
  for (const options of [{ wikiVersion: 9 }, { missingWikiVersion: true }]) {
    const { api } = createApi({ attachments: [attachment()], readComplete: true, ...options })
    const result = await buildSopContext('room', 'target', api, { attachment_mode: 'full' })
    assert.equal(result.attachments.results[0].status, 'ok')
    assert.equal(result.attachments.results[0].source_backend, 'attachment')
    assert.equal(result.attachments.results[0].fallback_reason, 'stale')
    assert.equal(result.attachments.results[0].text, 'first raw page')
    assert.equal(result.attachments.results[0].complete, false)
    assert.equal(result.attachments_complete, false)
    assert.equal(result.complete, false)
    assert.equal(result.attachments.results[0].warning && /版本号|版本与/.test(result.attachments.results[0].warning), true)
  }
})

test('full mode may mark an attachment complete when source.version matches node revision', async () => {
  const { api } = createApi({ attachments: [attachment()], readComplete: true })
  const result = await buildSopContext('room', 'target', api, { attachment_mode: 'full' })
  assert.equal(result.attachments.results[0].status, 'ok')
  assert.equal(result.attachments.results[0].source.version, 8)
  assert.equal(result.attachments.results[0].complete, true)
  assert.equal(result.attachments_complete, true)
  assert.equal(result.complete, true)
})

test('relevant mode requires query and Wiki errors preserve state plus fallback', async () => {
  const { api } = createApi({ attachments: [attachment()], wikiStatus: 'stale' })
  await assert.rejects(buildSopContext('room', 'target', api, { attachment_mode: 'relevant' }), { code: 'QUERY_REQUIRED' })
  const result = await buildSopContext('room', 'target', api, { attachment_mode: 'relevant', query: 'rule' })
  assert.equal(result.attachments.results[0].source_backend, 'attachment')
  assert.equal(result.attachments.results[0].fallback_reason, 'stale')
  assert.equal(result.attachments.results[0].fallback.tool, 'read_attachment_knowledge')
  await assert.rejects(buildSopContext('room', 'target', api, { attachment_mode: 'everything' }), { code: 'INVALID_ATTACHMENT_MODE' })
})

console.log('sopContext tests passed')
