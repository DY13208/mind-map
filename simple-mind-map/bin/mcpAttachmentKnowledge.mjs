const SEARCH_RESPONSE_BYTES = 12 * 1024
const READ_RESPONSE_BYTES = 20 * 1024
const DIRECT_PAGE_CHARS = 4000
const MAX_ATTACHMENT_REFERENCES = 20
const NO_FALLBACK_STATUSES = new Set(['forbidden', 'unauthorized', 'not_attached', 'not_found'])

const jsonBytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8')
const hasValue = value => value !== undefined && value !== null && String(value).trim() !== ''
const sameVersion = (a, b) => hasValue(a) && hasValue(b) && String(a) === String(b)
const codePointLength = value => Array.from(String(value || '')).length

function metaId(meta) {
  return String(meta?.id || meta?.attachment_id || '').trim()
}

function nodeAttachmentIds(data = {}) {
  const values = [data.attachmentId]
  if (Array.isArray(data.attachmentIds)) values.push(...data.attachmentIds)
  if (Array.isArray(data.attachments)) {
    values.push(...data.attachments.map(item => typeof item === 'string' ? item : item?.id || item?.attachmentId))
  }
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))]
}

function normalizedMeta(meta = {}) {
  return {
    id: metaId(meta),
    file_name: String(meta.file_name || meta.fileName || ''),
    status: String(meta.status || 'unknown'),
    content_hash: String(meta.content_hash || meta.contentHash || ''),
    updated_at: String(meta.updated_at || meta.updatedAt || ''),
    error_message: String(meta.error_message || meta.errorMessage || ''),
    extracted_chars: Number(meta.extracted_chars || meta.extractedChars || 0)
  }
}

function fallbackReference(roomKey, nodeUid, attachmentId, fallbackReason = '') {
  return {
    tool: 'read_attachment_knowledge',
    room_key: roomKey,
    node_uid: nodeUid,
    attachment_id: attachmentId,
    source_backend: 'attachment',
    offset: 0,
    ...(fallbackReason ? { fallback_reason: fallbackReason } : {})
  }
}

function isNoFallbackError(error) {
  const status = Number(error?.statusCode || error?.status_code || 0)
  return [401, 403, 404].includes(status) || NO_FALLBACK_STATUSES.has(String(error?.code || '').toLowerCase())
}

function contextFailure(roomKey, nodeUid, status, extra = {}) {
  return {
    status,
    room_key: roomKey,
    node_uid: nodeUid,
    source_backend: null,
    complete: false,
    ...extra
  }
}

// Current node pointers are authoritative. Attachment rows alone can remain
// after a detach or replacement, so every public entry point intersects them.
export async function resolveCurrentNodeAttachments(api, roomKey, nodeUid, options = {}) {
  let nodeItem = options.nodeItem || null
  let revision = options.nodeRevision
  const base = `/api/files/${encodeURIComponent(roomKey)}`

  if (!nodeItem) {
    const page = await api(`${base}/nodes/query`, {
      method: 'POST',
      body: JSON.stringify({
        selector: { type: 'uid', value: nodeUid },
        scope: 'self',
        attachment_content: 'metadata',
        page_size: 1
      }),
      timeoutMs: 25000
    })
    nodeItem = (page.items || []).find(item => String(item.uid) === String(nodeUid)) || null
    revision = page.version
  }

  if (!nodeItem) {
    return { ...contextFailure(roomKey, nodeUid, 'not_found'), revision, attachment_ids: [], attachments: [] }
  }

  const currentIds = nodeAttachmentIds(nodeItem.data || {})
  if (!currentIds.length) {
    return { status: 'not_attached', room_key: roomKey, node_uid: nodeUid, node_item: nodeItem, revision, attachment_ids: [], attachments: [] }
  }

  let listed = options.attachmentList
  if (!listed) {
    const params = new URLSearchParams({ node_uid: nodeUid, ids: currentIds.join(','), limit: '200' })
    listed = await api(`${base}/attachments?${params.toString()}`)
  }
  const allowed = new Set(currentIds)
  const attachments = (listed.attachments || [])
    .filter(item => allowed.has(metaId(item)))
    .map(item => ({ ...item, ...normalizedMeta(item) }))
  return {
    status: attachments.length ? 'ok' : 'not_attached',
    room_key: roomKey,
    node_uid: nodeUid,
    node_item: nodeItem,
    revision,
    attachment_ids: currentIds,
    attachments
  }
}

function contextForAttachment(context, roomKey, nodeUid, attachmentId) {
  if (context.status !== 'ok') return contextFailure(roomKey, nodeUid, context.status, { attachment_id: attachmentId })
  const found = context.attachments.find(item => metaId(item) === String(attachmentId || ''))
  if (!found) return contextFailure(roomKey, nodeUid, 'not_attached', { attachment_id: attachmentId })
  return { ...context, attachment: found }
}

function currentRevision(context) {
  return hasValue(context.revision) ? context.revision : null
}

function wikiVersionWarning(context, result, items = []) {
  const revision = currentRevision(context)
  if (!hasValue(revision)) return '节点响应缺少修订号'
  const versions = [
    result?.version,
    result?.source?.version,
    ...items.flatMap(item => [item?.version, item?.source?.version])
  ].filter(hasValue)
  if (!versions.length) return 'Wiki 响应缺少版本号'
  if (versions.some(version => !sameVersion(version, revision))) return 'Wiki 版本与当前节点修订号不一致'
  return ''
}

function sourceFromMeta(context, attachment) {
  const meta = normalizedMeta(attachment)
  return {
    room_key: context.room_key,
    node_uid: context.node_uid,
    attachment_id: meta.id,
    name: meta.file_name,
    status: meta.status,
    content_hash: meta.content_hash,
    updated_at: meta.updated_at,
    version: currentRevision(context)
  }
}

function staleContinuation(context, attachment, fallbackReason, warning) {
  return {
    status: 'stale',
    room_key: context.room_key,
    node_uid: context.node_uid,
    attachment_id: metaId(attachment),
    source_backend: 'attachment',
    fallback_reason: fallbackReason,
    source: sourceFromMeta(context, attachment),
    text: '',
    offset: null,
    length: 0,
    total_chars: Number(attachment.extractedChars || attachment.extracted_chars || 0),
    has_more: false,
    next_offset: null,
    next_read: null,
    complete: false,
    is_excerpt: true,
    restart_required: true,
    warning
  }
}

function continuationArgs(context, attachment, nextOffset, fallbackReason) {
  const meta = normalizedMeta(attachment)
  const revision = currentRevision(context)
  if (!meta.content_hash || !hasValue(revision)) return null
  return {
    room_key: context.room_key,
    node_uid: context.node_uid,
    attachment_id: meta.id,
    source_backend: 'attachment',
    offset: nextOffset,
    expected_content_hash: meta.content_hash,
    expected_version: Number.isFinite(Number(revision)) ? Number(revision) : revision,
    ...(meta.updated_at ? { expected_attachment_updated_at: meta.updated_at } : {}),
    fallback_reason: fallbackReason
  }
}

function makeDirectPageResult(context, attachment, slice, options) {
  const meta = normalizedMeta(slice.attachment || attachment)
  const offset = Math.max(0, Number(options.offset) || 0)
  const total = Math.max(0, Number(slice.total_chars) || 0)
  const points = Array.from(String(slice.text || ''))
  const status = meta.status === 'ready' ? 'ok' : meta.status || 'unavailable'
  const fallbackReason = options.fallbackReason || 'attachment_selected'
  const base = {
    status,
    room_key: context.room_key,
    node_uid: context.node_uid,
    attachment_id: meta.id || metaId(attachment),
    source_backend: 'attachment',
    fallback_reason: fallbackReason,
    source: sourceFromMeta(context, { ...attachment, ...slice.attachment }),
    attachment_status: meta.status,
    ...(meta.error_message ? { error_message: meta.error_message } : {}),
    complete: false,
    complete_scope: 'parsed_text',
    is_excerpt: true,
    matches_query: options.searchPreview ? false : undefined,
    preview_only: options.searchPreview ? true : undefined,
    ...(options.searchPreview ? { warning: '这是原附件已解析文本的首段预览，不是检索命中；未搜索其他附件。' } : {})
  }
  const canPage = status === 'ok' && meta.content_hash && hasValue(currentRevision(context))
  const make = count => {
    const text = points.slice(0, count).join('')
    const length = codePointLength(text)
    const nextOffset = offset + length
    const hasMore = status === 'ok' && nextOffset < total
    const nextRead = hasMore ? continuationArgs(context, { ...attachment, ...slice.attachment }, nextOffset, fallbackReason) : null
    return {
      ...base,
      text,
      offset,
      length,
      total_chars: total,
      has_more: hasMore,
      next_offset: hasMore ? nextOffset : null,
      next_read: hasMore && canPage ? nextRead : null,
        complete: status === 'ok' && !hasMore && !options.searchPreview,
        parsed_text_end: status === 'ok' && !hasMore,
      ...(hasMore && !canPage ? { warning: '附件缺少续读校验信息，无法安全生成下一页引用。' } : {})
    }
  }

  let low = 0
  let high = points.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (jsonBytes(make(middle)) <= READ_RESPONSE_BYTES) low = middle
    else high = middle - 1
  }
  const result = make(low)
  if (low < points.length) {
    result.truncated = true
    result.warning = result.warning || '正文按响应预算截断；请使用 next_read 继续。'
  }
  return result
}

function attachmentReadUrl(context, attachmentId, offset, length) {
  const params = new URLSearchParams({ offset: String(offset), limit: String(length) })
  return `/api/files/${encodeURIComponent(context.room_key)}/attachments/${encodeURIComponent(attachmentId)}/text?${params.toString()}`
}

async function readOriginalPage(api, context, attachment, options = {}) {
  const meta = normalizedMeta(attachment)
  const offset = Math.max(0, Math.floor(Number(options.offset) || 0))
  const expectedHash = String(options.expectedContentHash || '')
  const expectedRevision = options.expectedVersion
  const expectedUpdatedAt = String(options.expectedAttachmentUpdatedAt || '')
  const revision = currentRevision(context)

  if (offset > 0) {
    if (!expectedHash || !hasValue(expectedRevision) || !sameVersion(expectedRevision, revision)) {
      return staleContinuation(context, attachment, options.fallbackReason, '续读缺少匹配的附件哈希或节点修订号，已停止拼接。')
    }
    if (hasValue(meta.extracted_chars) && offset > meta.extracted_chars) {
      return staleContinuation(context, attachment, options.fallbackReason, '续读偏移超过当前解析文本长度，需从第一页重新读取。')
    }
    if (!meta.content_hash || expectedHash !== meta.content_hash) {
      return staleContinuation(context, attachment, options.fallbackReason, '附件内容哈希已变化，需从第一页重新读取。')
    }
    if (meta.updated_at && (!expectedUpdatedAt || expectedUpdatedAt !== meta.updated_at)) {
      return staleContinuation(context, attachment, options.fallbackReason, '附件更新时间已变化，需从第一页重新读取。')
    }
  }

  const length = Math.max(1, Math.min(DIRECT_PAGE_CHARS, Math.floor(Number(options.length) || DIRECT_PAGE_CHARS)))
  let slice
  try {
    slice = await api(attachmentReadUrl(context, meta.id, offset, length), { timeoutMs: 25000 })
  } catch (error) {
    if (isNoFallbackError(error)) throw error
    return contextFailure(context.room_key, context.node_uid, 'unavailable', {
      attachment_id: meta.id,
      source_backend: 'attachment',
      fallback_reason: options.fallbackReason,
      fallback: fallbackReference(context.room_key, context.node_uid, meta.id, options.fallbackReason),
      error: '附件现有解析文本暂时无法读取'
    })
  }

  if (!slice?.attachment) {
    return contextFailure(context.room_key, context.node_uid, 'not_found', { attachment_id: meta.id, source_backend: 'attachment' })
  }
  const readMeta = normalizedMeta(slice.attachment)
  if ((meta.content_hash && (!readMeta.content_hash || meta.content_hash !== readMeta.content_hash)) ||
      (meta.updated_at && (!readMeta.updated_at || meta.updated_at !== readMeta.updated_at))) {
    return staleContinuation(context, attachment, options.fallbackReason, '附件在元数据核验后发生变化，需从第一页重新读取。')
  }
  if (offset > 0 && (expectedHash !== readMeta.content_hash || !sameVersion(expectedRevision, revision) ||
      (readMeta.updated_at && expectedUpdatedAt !== readMeta.updated_at))) {
    return staleContinuation(context, attachment, options.fallbackReason, '附件续读校验失败，需从第一页重新读取。')
  }
  return makeDirectPageResult(context, attachment, slice, { ...options, offset, length })
}

async function resolveForRead(api, roomKey, nodeUid, attachmentId, options = {}) {
  const context = options.context || await resolveCurrentNodeAttachments(api, roomKey, nodeUid)
  if (context.status !== 'ok') return { error: contextFailure(roomKey, nodeUid, context.status, { attachment_id: attachmentId }) }
  const resolved = contextForAttachment(context, roomKey, nodeUid, attachmentId)
  if (resolved.status !== 'ok') return { error: resolved }
  if (!hasValue(currentRevision(resolved))) {
    return { error: contextFailure(roomKey, nodeUid, 'stale', { attachment_id: attachmentId, warning: '节点响应缺少修订号，未读取附件正文。' }) }
  }
  return { context: resolved, attachment: resolved.attachment }
}

function searchFallbackReferences(context, firstId) {
  return context.attachments
    .filter(item => metaId(item) !== firstId)
    .slice(0, MAX_ATTACHMENT_REFERENCES)
    .map(item => ({ attachment_id: metaId(item), file_name: normalizedMeta(item).file_name, status: normalizedMeta(item).status }))
}

function fitSearchResponse(response) {
  const result = { ...response, items: (response.items || []).map(item => ({ ...item })) }
  const rebaseAttachmentContinuation = () => {
    if (result.source_backend !== 'attachment' || !result.items.length) return
    const item = result.items[0]
    const length = codePointLength(item.text)
    const nextOffset = Number(result.offset || 0) + length
    result.length = length
    result.next_offset = result.status === 'ok' && nextOffset < Number(result.total_chars || 0) ? nextOffset : null
    result.has_more = result.next_offset != null
    if (result.has_more && result.next_read) result.next_read = { ...result.next_read, offset: nextOffset }
    else if (!result.has_more) result.next_read = null
  }

  if (jsonBytes(result) <= SEARCH_RESPONSE_BYTES) return result

  // Preserve each hit's source metadata and trim excerpt text to the actual
  // serialized JSON budget instead of dropping a hit or returning no fallback.
  for (let index = result.items.length - 1; index >= 0 && jsonBytes(result) > SEARCH_RESPONSE_BYTES; index--) {
    const item = result.items[index]
    const points = Array.from(String(item.text || ''))
    let low = 0
    let high = points.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      const prior = item.text
      item.text = points.slice(0, middle).join('')
      const fits = jsonBytes(result) <= SEARCH_RESPONSE_BYTES
      item.text = prior
      if (fits) low = middle
      else high = middle - 1
    }
    item.text = points.slice(0, low).join('')
    item.truncated = low < points.length
    result.truncated = true
    rebaseAttachmentContinuation()
    let clipped = Array.from(String(item.text || ''))
    while (jsonBytes(result) > SEARCH_RESPONSE_BYTES && clipped.length) {
      clipped.pop()
      item.text = clipped.join('')
      rebaseAttachmentContinuation()
    }
  }
  const references = [...(result.remaining_attachments || [])]
  while (references.length && jsonBytes({ ...result, remaining_attachments: references }) > SEARCH_RESPONSE_BYTES) references.pop()
  result.remaining_attachments = references
  if (references.length < Number(result.remaining_attachment_count || 0)) result.remaining_attachments_truncated = true
  if (jsonBytes(result) > SEARCH_RESPONSE_BYTES) {
    for (const key of ['generation', 'source_revision', 'warning']) {
      if (jsonBytes(result) <= SEARCH_RESPONSE_BYTES) break
      delete result[key]
    }
  }
  return result
}

async function fallbackSearch(api, context, attachment, reason, unsearched = []) {
  const id = metaId(attachment)
  const page = await readOriginalPage(api, context, attachment, {
    offset: 0,
    length: DIRECT_PAGE_CHARS,
    fallbackReason: reason,
    searchPreview: true
  })
  const { text, ...pageMetadata } = page
  const response = {
    ...pageMetadata,
    attachment_id: id,
    items: text ? [{
      attachment_id: id,
      file_name: normalizedMeta(attachment).file_name,
      text,
      source: page.source,
      offset: page.offset,
      is_excerpt: true,
      matches_query: false,
      complete: false
    }] : [],
    is_excerpt: true,
    matches_query: false,
    complete: false,
    search_complete: false,
    remaining_attachments: unsearched.slice(0, MAX_ATTACHMENT_REFERENCES),
    remaining_attachment_count: unsearched.length,
    fallback: fallbackReference(context.room_key, context.node_uid, id, reason),
    ...(page.next_read ? { next_read: page.next_read } : {})
  }
  return fitSearchResponse(response)
}

export async function searchAttachmentKnowledge(api, input, options = {}) {
  const { room_key: roomKey, node_uid: nodeUid } = input
  const requestedId = String(input.attachment_id || '').trim()
  const context = options.context || await resolveCurrentNodeAttachments(api, roomKey, nodeUid)
  if (context.status !== 'ok') return contextFailure(roomKey, nodeUid, context.status, { attachment_id: requestedId || null })
  if (!hasValue(currentRevision(context))) {
    return contextFailure(roomKey, nodeUid, 'stale', { attachment_id: requestedId || null, warning: '节点响应缺少修订号，未检索附件内容。' })
  }
  const selected = requestedId ? context.attachments.filter(item => metaId(item) === requestedId) : context.attachments
  if (!selected.length) return contextFailure(roomKey, nodeUid, 'not_attached', { attachment_id: requestedId || null })

  let result
  try {
    result = await api('/api/wiki-compiler/api/attachments/search', {
      method: 'POST',
      body: JSON.stringify({
        room_key: roomKey,
        node_uid: nodeUid,
        ...(requestedId ? { attachment_id: requestedId } : {}),
        query: String(input.query || '').trim(),
        top_k: Math.max(1, Math.min(5, Number(input.top_k) || 3))
      }),
      timeoutMs: 10000
    })
  } catch (error) {
    if (isNoFallbackError(error)) throw error
    const first = selected[0]
    const remaining = requestedId ? [] : searchFallbackReferences(context, metaId(first))
    return fallbackSearch(api, context, first, 'unavailable', remaining)
  }

  const status = String(result?.status || 'unavailable')
  if (NO_FALLBACK_STATUSES.has(status)) return contextFailure(roomKey, nodeUid, status, { attachment_id: requestedId || null })
  const liveIds = new Set(selected.map(metaId))
  const matchingItems = (result.items || []).filter(item => liveIds.has(String(item.attachment_id || '')))
  const versionWarning = status === 'ok' ? wikiVersionWarning(context, result, matchingItems) : ''
  if (status === 'ok' && !versionWarning && matchingItems.length) {
    const response = {
      status: 'ok',
      room_key: roomKey,
      node_uid: nodeUid,
      attachment_id: requestedId || null,
      source_backend: 'wiki',
      generation: result.generation || '',
      version: result.version,
      source_revision: result.source_revision,
      complete: false,
      is_excerpt: true,
      search_complete: false,
      items: matchingItems.map(item => ({ ...item, is_excerpt: true, complete: false, source_backend: 'wiki' }))
    }
    return fitSearchResponse(response)
  }

  const first = selected[0]
  const reason = versionWarning ? 'stale' : status === 'ok' ? 'no_match' : status
  const remaining = requestedId ? [] : searchFallbackReferences(context, metaId(first))
  const response = await fallbackSearch(api, context, first, reason, remaining)
  if (versionWarning) response.warning = versionWarning
  return fitSearchResponse(response)
}

function wikiRestartRequired(result, roomKey, nodeUid, attachmentId, reason, warning = '') {
  return {
    status: 'stale',
    room_key: roomKey,
    node_uid: nodeUid,
    attachment_id: attachmentId,
    source_backend: 'wiki',
    fallback_reason: reason,
    text: '',
    has_more: false,
    next_cursor: null,
    complete: false,
    is_excerpt: true,
    restart_required: true,
    ...(result?.generation ? { generation: result.generation } : {}),
    ...(result?.version !== undefined ? { version: result.version } : {}),
    warning: warning || 'Wiki 续读状态已变化，请重新开始同一来源的读取。'
  }
}

export async function readAttachmentKnowledge(api, input, options = {}) {
  const { room_key: roomKey, node_uid: nodeUid } = input
  const attachmentId = String(input.attachment_id || '').trim()
  const sourceBackend = input.source_backend || 'wiki'
  const cursor = String(input.cursor || '')
  const offset = Math.max(0, Math.floor(Number(input.offset) || 0))
  if (!['wiki', 'attachment'].includes(sourceBackend)) throw Object.assign(new Error('source_backend 无效'), { code: 'INVALID_SOURCE_BACKEND' })
  if ((sourceBackend === 'wiki' && offset > 0) || (sourceBackend === 'attachment' && cursor)) {
    return {
      status: 'stale', room_key: roomKey, node_uid: nodeUid, attachment_id: attachmentId,
      source_backend: sourceBackend, complete: false, is_excerpt: true, restart_required: true,
      text: '', has_more: false, warning: 'Wiki cursor 与原附件 offset 不能混用，请从对应来源重新续读。'
    }
  }

  const resolved = await resolveForRead(api, roomKey, nodeUid, attachmentId, options)
  if (resolved.error) return resolved.error
  const { context, attachment } = resolved
  const fallbackReason = String(input.fallback_reason || 'attachment_selected')

  if (sourceBackend === 'attachment') {
    return readOriginalPage(api, context, attachment, {
      offset,
      length: input.length,
      expectedContentHash: input.expected_content_hash,
      expectedVersion: input.expected_version,
      expectedAttachmentUpdatedAt: input.expected_attachment_updated_at,
      fallbackReason
    })
  }

  let result
  try {
    result = await api('/api/wiki-compiler/api/attachments/read', {
      method: 'POST',
      body: JSON.stringify({
        room_key: roomKey,
        node_uid: nodeUid,
        attachment_id: attachmentId,
        ...(cursor ? { cursor } : {}),
        length: Math.max(1, Math.min(10000, Number(input.length) || 4000))
      }),
      timeoutMs: 10000
    })
  } catch (error) {
    if (isNoFallbackError(error)) throw error
    if (cursor) return wikiRestartRequired(null, roomKey, nodeUid, attachmentId, 'unavailable')
    return readOriginalPage(api, context, attachment, { offset: 0, length: DIRECT_PAGE_CHARS, fallbackReason: 'unavailable' })
  }

  const status = String(result?.status || 'unavailable')
  if (NO_FALLBACK_STATUSES.has(status)) return contextFailure(roomKey, nodeUid, status, { attachment_id: attachmentId })
  const versionWarning = status === 'ok' ? wikiVersionWarning(context, result) : ''
  if (cursor && (status !== 'ok' || versionWarning)) {
    return wikiRestartRequired(result, roomKey, nodeUid, attachmentId, versionWarning ? 'stale' : status, versionWarning)
  }
  if (status === 'ok' && !versionWarning) {
    return {
      ...result,
      room_key: roomKey,
      node_uid: nodeUid,
      attachment_id: attachmentId,
      source_backend: 'wiki',
      is_excerpt: true,
      complete_scope: 'parsed_text',
      complete: !!result.complete
    }
  }

  const reason = versionWarning ? 'stale' : status
  const fallback = await readOriginalPage(api, context, attachment, {
    offset: 0,
    length: DIRECT_PAGE_CHARS,
    fallbackReason: reason
  })
  if (versionWarning) fallback.warning = versionWarning
  return fallback
}

export { fallbackReference }
