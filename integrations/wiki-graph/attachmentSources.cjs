'use strict'

const crypto = require('node:crypto')

const INDEX_VERSION = 1
const MAX_SEARCH_RESULTS = 5
const MAX_SEARCH_SLICE_CHARS = 800
const MAX_SEARCH_RESPONSE_BYTES = 12 * 1024
const DEFAULT_READ_CHARS = 4000
const MAX_READ_CHARS = 10000
const MAX_READ_RESPONSE_BYTES = 20 * 1024
const SOURCE_STATUSES = new Set(['ready', 'pending', 'processing', 'failed'])

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}
function sourceStatus(value) {
  const status = String(value || 'unavailable')
  return SOURCE_STATUSES.has(status) ? status : 'unavailable'
}

function clipUtf8(text, offset, maxChars, maxBytes) {
  const source = String(text || '').slice(offset)
  let value = ''
  let chars = 0
  let bytes = 0
  for (const point of source) {
    const pointChars = point.length
    const pointBytes = Buffer.byteLength(point, 'utf8')
    if (chars + pointChars > maxChars || bytes + pointBytes > maxBytes) break
    value += point
    chars += pointChars
    bytes += pointBytes
  }
  return { text: value, chars, bytes }
}

function publicSource(source, bundle) {
  return {
    room_key: String(source.room_key || bundle.roomId),
    node_uid: String(source.node_uid || ''),
    node_ids: [String(source.node_uid || '')],
    attachment_id: String(source.attachment_id || ''),
    name: String(source.name || source.attachment_id || ''),
    content_hash: String(source.content_hash || ''),
    status: sourceStatus(source.status),
    version: Number(bundle.version) || 0,
    source_revision: Number(bundle.revision) || 0,
    generation: String(source.generation || bundle.generation || ''),
    range: source.start == null || source.end == null
      ? null
      : { start: Number(source.start), end: Number(source.end), unit: source.range_unit || 'utf16' },
    total_chars: Math.max(0, Number(source.total_chars) || 0),
    index_version: Number(source.index_version) || 0
  }
}

function findSource(bundle, nodeUid, attachmentId) {
  for (const topic of bundle.topics || []) {
    const sources = topic && topic.attachmentSources
    if (!Array.isArray(sources)) continue
    const source = sources.find(item => item && String(item.node_uid) === nodeUid && String(item.attachment_id) === attachmentId)
    if (source) return { source, topic }
  }
  return null
}

function makeResult(status, bundle, extra = {}) {
  return {
    status,
    room_key: bundle && bundle.roomId || extra.room_key || '',
    node_uid: extra.node_uid || '',
    generation: bundle && bundle.generation || '',
    version: bundle && Number(bundle.version) || 0,
    source_revision: bundle && Number(bundle.revision) || 0,
    ...extra
  }
}

function searchWindows(text, terms) {
  const candidates = []
  const stride = 600
  for (let start = 0; start < text.length; start += stride) {
    if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]) && /[\uD800-\uDBFF]/.test(text[start - 1])) start += 1
    const chunk = clipUtf8(text, start, MAX_SEARCH_SLICE_CHARS, 4096)
    if (!chunk.chars) break
    const lower = chunk.text.toLowerCase()
    const matched = terms.filter(term => lower.includes(term))
    if (matched.length) candidates.push({ start, end: start + chunk.chars, text: chunk.text, score: matched.length })
  }
  candidates.sort((a, b) => b.score - a.score || a.start - b.start)
  const selected = []
  for (const candidate of candidates) {
    if (selected.some(item => candidate.start < item.end && candidate.end > item.start)) continue
    selected.push(candidate)
    if (selected.length === 3) break
  }
  return selected.sort((a, b) => a.start - b.start)
}

function attachmentSearch({ bundle, sources, nodeUid, terms, topK = 3 }) {
  terms = Array.isArray(terms) ? terms : []
  if (!terms.length) return makeResult('no_match', bundle, { node_uid: nodeUid, items: [], complete: false })
  const availableSources = []
  const candidates = []
  const unavailableStatuses = []
  for (const entry of sources || []) {
    const source = entry.source
    const status = sourceStatus(source.status)
    const publicMeta = publicSource(source, bundle)
    availableSources.push(publicMeta)
    if (status !== 'ready') {
      unavailableStatuses.push(status)
      continue
    }
    if (source.start == null || source.end == null || source.end - source.start !== source.total_chars || source.index_version !== INDEX_VERSION) {
      return makeResult('index_upgrade_required', bundle, { node_uid: nodeUid, items: [], complete: false })
    }
    const text = String(entry.topic.markdown || '').slice(source.start, source.end)
    if (text.length !== source.total_chars) return makeResult('index_upgrade_required', bundle, { node_uid: nodeUid, items: [], complete: false })
    for (const window of searchWindows(text, terms)) {
      candidates.push({
        attachment_id: publicMeta.attachment_id,
        chunk_id: `${bundle.generation || ''}:${publicMeta.attachment_id}:${window.start}:${window.end}`,
        source: publicMeta,
        range: { start: window.start, end: window.end, unit: 'utf16' },
        text: window.text,
        score: window.score
      })
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.attachment_id.localeCompare(b.attachment_id) || a.range.start - b.range.start)
  const selected = candidates.slice(0, Math.min(MAX_SEARCH_RESULTS, topK)).map((item, index) => ({ ...item, index: index + 1 }))
  const resultStatus = selected.length ? 'ok'
    : unavailableStatuses.includes('failed') ? 'failed'
      : unavailableStatuses.includes('processing') ? 'processing'
        : unavailableStatuses.includes('pending') ? 'pending'
          : unavailableStatuses.includes('unavailable') ? 'unavailable' : 'no_match'
  const reportedSources = selected.length
    ? [...new Map(selected.map(item => [item.source.attachment_id, item.source])).values()]
    : availableSources.slice(0, MAX_SEARCH_RESULTS)
  const result = makeResult(resultStatus, bundle, {
    node_uid: nodeUid,
    ...(reportedSources.length === 1 ? { source: reportedSources[0] } : { sources: reportedSources }),
    items: selected,
    complete: false
  })
  while (jsonBytes(result) > MAX_SEARCH_RESPONSE_BYTES && result.items.length) {
    const item = result.items[result.items.length - 1]
    if (item.text.length <= 1) result.items.pop()
    else {
      const clipped = clipUtf8(item.text, 0, Math.floor(item.text.length * 0.75), 2048)
      item.text = clipped.text
      item.range.end = item.range.start + clipped.chars
      item.chunk_id = `${bundle.generation || ''}:${item.attachment_id}:${item.range.start}:${item.range.end}`
      if (!clipped.chars) result.items.pop()
    }
  }
  if (!result.items.length && result.status === 'ok') result.status = unavailableStatuses.length ? resultStatus : 'no_match'
  return result
}

function cursorSecret(env = process.env) {
  const value = String(env.WIKI_COMPILER_INTERNAL_SECRET || '')
  if (value.length < 32) throw Object.assign(new Error('wiki_compiler_unconfigured'), { code: 'unavailable' })
  return value
}

function signCursor(payload, env = process.env) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = crypto.createHmac('sha256', cursorSecret(env)).update(body).digest('base64url')
  return `${body}.${signature}`
}

function verifyCursor(token, env = process.env) {
  const parts = String(token || '').split('.')
  if (parts.length !== 2 || parts[0].length > 4096) return null
  let expected
  try { expected = crypto.createHmac('sha256', cursorSecret(env)).update(parts[0]).digest() }
  catch (_) { return null }
  const actual = Buffer.from(parts[1], 'base64url')
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    if (!payload || !Number.isSafeInteger(payload.offset) || payload.offset < 0 || payload.exp <= Date.now()) return null
    return payload
  } catch (_) { return null }
}

function attachmentRead({ bundle, source, topic, nodeUid, attachmentId, identity, cursor, length = DEFAULT_READ_CHARS, env = process.env }) {
  let offset = 0
  if (cursor) {
    const payload = verifyCursor(cursor, env)
    if (!payload || payload.sub !== identity || payload.room_key !== bundle.roomId || payload.node_uid !== nodeUid ||
        payload.attachment_id !== attachmentId || payload.generation !== bundle.generation ||
        payload.version !== bundle.version || payload.source_revision !== bundle.revision ||
        payload.content_hash !== source.content_hash) {
      return makeResult('stale', bundle, { node_uid: nodeUid, source: publicSource(source, bundle), text: '', has_more: false, next_cursor: null, complete: false })
    }
    offset = payload.offset
  }
  const meta = publicSource(source, bundle)
  const status = sourceStatus(source.status)
  if (status !== 'ready') return makeResult(status, bundle, {
    node_uid: nodeUid, source: meta, text: '', has_more: false, next_cursor: null, complete: false
  })
  if (source.start == null || source.end == null || source.end - source.start !== source.total_chars || source.index_version !== INDEX_VERSION) {
    return makeResult('index_upgrade_required', bundle, { node_uid: nodeUid, source: meta, text: '', has_more: false, next_cursor: null, complete: false })
  }
  const text = String(topic.markdown || '').slice(source.start, source.end)
  if (text.length !== source.total_chars || offset > text.length) return makeResult('index_upgrade_required', bundle, {
    node_uid: nodeUid, source: meta, text: '', has_more: false, next_cursor: null, complete: false
  })
  const page = clipUtf8(text, offset, Math.min(MAX_READ_CHARS, Math.max(1, Number(length) || DEFAULT_READ_CHARS)), MAX_READ_RESPONSE_BYTES - 6 * 1024)
  let nextOffset = offset + page.chars
  const hasMore = nextOffset < text.length
  const makeCursor = value => signCursor({
    sub: identity, room_key: bundle.roomId, node_uid: nodeUid, attachment_id: attachmentId,
    content_hash: source.content_hash, generation: bundle.generation,
    version: bundle.version, source_revision: bundle.revision, offset: value,
    exp: Date.now() + 15 * 60 * 1000
  }, env)
  const result = makeResult('ok', bundle, {
    node_uid: nodeUid, source: meta, text: page.text, offset,
    has_more: hasMore,
    next_cursor: hasMore ? makeCursor(nextOffset) : null,
    complete: !hasMore
  })
  while (jsonBytes(result) > MAX_READ_RESPONSE_BYTES && result.text.length > 1) {
    const clipped = clipUtf8(result.text, 0, Math.floor(result.text.length * 0.75), MAX_READ_RESPONSE_BYTES - 10 * 1024)
    if (!clipped.chars) break
    result.text = clipped.text
    nextOffset = offset + clipped.chars
    result.has_more = nextOffset < text.length
    result.next_cursor = result.has_more ? makeCursor(nextOffset) : null
    result.complete = !result.has_more
  }
  return result
}

module.exports = {
  INDEX_VERSION,
  MAX_SEARCH_RESULTS,
  MAX_SEARCH_SLICE_CHARS,
  MAX_SEARCH_RESPONSE_BYTES,
  DEFAULT_READ_CHARS,
  MAX_READ_CHARS,
  MAX_READ_RESPONSE_BYTES,
  publicSource,
  findSource,
  attachmentSearch,
  attachmentRead,
  signCursor,
  verifyCursor,
  clipUtf8,
  searchWindows
}
