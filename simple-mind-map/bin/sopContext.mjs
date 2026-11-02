// Read-only composition of the existing node, attachment, and Wiki APIs.
import {
  fallbackReference,
  readAttachmentKnowledge,
  resolveCurrentNodeAttachments,
  searchAttachmentKnowledge
} from './mcpAttachmentKnowledge.mjs'

const MAX_RELEVANT_BYTES = 20 * 1024
const DEFAULT_ATTACHMENT_PAGE_CHARS = 4000

const utf8Bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8')

function collectReferences(records) {
  const byId = new Map()
  for (const { uid, meta } of records) {
    const id = String(meta.id || meta.attachment_id || '')
    if (!id) continue
    const prior = byId.get(id)
    if (prior) {
      if (!prior.node_uids.includes(uid)) prior.node_uids.push(uid)
      if (prior.status === 'not_found' && meta.status && meta.status !== 'not_found') {
        prior.file_name = meta.file_name || meta.fileName || prior.file_name
        prior.status = meta.status
        prior.content_hash = meta.content_hash || meta.contentHash || prior.content_hash
        prior.source_kind = meta.source_kind || meta.sourceKind || prior.source_kind
        prior.extracted_chars = Number(meta.extracted_chars || meta.extractedChars || prior.extracted_chars)
        prior.metadata = meta
      }
      continue
    }
    byId.set(id, {
      attachment_id: id,
      node_uids: [uid],
      file_name: meta.file_name || meta.fileName || '',
      status: meta.status || 'unknown',
      content_hash: meta.content_hash || meta.contentHash || '',
      source_kind: meta.source_kind || meta.sourceKind || '',
      extracted_chars: Number(meta.extracted_chars || meta.extractedChars || 0),
      metadata: meta
    })
  }
  return [...byId.values()]
}

function nodeComplete(revisions, nodeWarnings) {
  return revisions.size === 1 && !nodeWarnings.some(w => /未读完|未返回/.test(w))
}

// attachmentMode is metadata by default. Relevant reads only Wiki excerpts;
// full returns a single first page and leaves continuation to the caller.
export async function buildSopContext(roomKey, nodeUid, api, options = {}) {
  const attachmentMode = options.attachment_mode || 'metadata'
  const query = String(options.query || '').trim()
  if (!['metadata', 'relevant', 'full'].includes(attachmentMode)) {
    throw Object.assign(new Error('attachment_mode 无效'), { code: 'INVALID_ATTACHMENT_MODE' })
  }
  if (attachmentMode === 'relevant' && !query) {
    throw Object.assign(new Error('relevant 模式必须提供 query'), { code: 'QUERY_REQUIRED' })
  }

  const base = `/api/files/${encodeURIComponent(roomKey)}`
  const nodeWarnings = []
  const attachmentWarnings = []
  const revisions = new Set()
  const readScope = async (uid, scope) => {
    const items = new Map()
    let cursor
    const seen = new Set()
    do {
      const page = await api(`${base}/nodes/query`, {
        method: 'POST',
        body: JSON.stringify({
          selector: { type: 'uid', value: uid },
          scope,
          attachment_content: 'metadata',
          ...(cursor ? { cursor } : {})
        }),
        timeoutMs: 25000
      })
      if (page.match_status === 'candidates') throw new Error('节点定位不唯一')
      revisions.add(page.version)
      nodeWarnings.push(...(page.warnings || []))
      for (const field of page.omitted_fields || []) {
        if (!['data.imgMap', 'data.attachmentExtractedText'].includes(field) && !field.endsWith('(fragmented)')) nodeWarnings.push(`${scope}: ${field} 未返回`)
      }
      for (const item of page.items || []) {
        const prior = items.get(item.uid) || { ...item, data: { ...item.data } }
        if (item.content_fragment) {
          const { field, offset, value } = item.content_fragment
          const current = prior.data[field] || ''
          if (current.length !== offset) throw new Error(`节点 ${item.uid} 的 ${field} 分片不连续`)
          prior.data[field] = current + value
        } else {
          prior.data = { ...prior.data, ...item.data }
        }
        items.set(item.uid, prior)
      }
      if (!page.has_more) break
      cursor = page.next_cursor
      if (!cursor || seen.has(cursor)) throw new Error('query_nodes 分页游标无效或重复')
      seen.add(cursor)
    } while (true)
    return [...items.values()]
  }

  const path = await readScope(nodeUid, 'path')
  const target = path.find(item => item.uid === nodeUid)
  if (!target) throw new Error('目标节点未在路径中返回')
  const children = await readScope(nodeUid, 'children')
  const subtree = await readScope(nodeUid, 'subtree')
  const siblings = target.parent_uid
    ? (await readScope(target.parent_uid, 'children')).filter(item => item.uid !== nodeUid)
    : []
  const nodes = new Map([...path, ...children, ...subtree, ...siblings].map(item => [item.uid, item]))
  const references = []
  for (const item of nodes.values()) {
    const data = item.data || {}
    if (data.hyperlink) references.push({ source_uid: item.uid, kind: 'hyperlink', value: data.hyperlink })
    if (data.mapRef) references.push({ source_uid: item.uid, kind: 'map_ref', value: data.mapRef })
    for (const uid of data.associativeLineTargets || []) references.push({ source_uid: item.uid, kind: 'associative', target_uid: uid })
  }

  const attachmentRecords = []
  const attachmentContexts = new Map()
  let attachmentListComplete = true
  const revisionAtAttachmentRead = revisions.size === 1 ? [...revisions][0] : null
  for (const uid of nodes.keys()) {
    const context = await resolveCurrentNodeAttachments(api, roomKey, uid, {
      nodeItem: nodes.get(uid),
      nodeRevision: revisionAtAttachmentRead
    })
    attachmentContexts.set(uid, context)
    const metas = context.attachments || []
    if (metas.length === 200) attachmentWarnings.push(`节点 ${uid} 附件达到列表上限，可能未读完`)
    for (const meta of metas) attachmentRecords.push({ uid, meta })
    const found = new Set(metas.map(meta => String(meta.id || meta.attachment_id || '')))
    for (const id of context.attachment_ids || []) {
      if (found.has(id)) continue
      attachmentListComplete = false
      attachmentWarnings.push(`节点 ${uid} 当前附件引用 ${id} 未在附件列表中找到`)
      attachmentRecords.push({ uid, meta: { id, status: 'not_found' } })
    }
  }
  const attachments = collectReferences(attachmentRecords)
  const fallbackFor = attachment => fallbackReference(roomKey, attachment.node_uids[0], attachment.attachment_id)
  const attachmentResults = []
  const freshContentContext = async (uid, attachmentId) => {
    const baseline = attachmentContexts.get(uid)
    const current = await resolveCurrentNodeAttachments(api, roomKey, uid)
    if (current.status !== 'ok') return current
    const baselineRevision = revisions.size === 1 ? [...revisions][0] : null
    if (baselineRevision == null || String(current.revision) !== String(baselineRevision)) {
      return { ...current, status: 'stale', warning: '节点在 SOP 上下文采集后发生变化，未读取附件正文；请重新采集。' }
    }
    const priorMeta = baseline?.attachments?.find(meta => String(meta.id || meta.attachment_id) === attachmentId)
    const currentMeta = current.attachments.find(meta => String(meta.id || meta.attachment_id) === attachmentId)
    if (!priorMeta || !currentMeta) return { ...current, status: 'not_attached' }
    const priorHash = String(priorMeta.content_hash || priorMeta.contentHash || '')
    const currentHash = String(currentMeta.content_hash || currentMeta.contentHash || '')
    const priorUpdatedAt = String(priorMeta.updated_at || priorMeta.updatedAt || '')
    const currentUpdatedAt = String(currentMeta.updated_at || currentMeta.updatedAt || '')
    if ((priorHash && currentHash && priorHash !== currentHash) ||
        (priorUpdatedAt && currentUpdatedAt && priorUpdatedAt !== currentUpdatedAt)) {
      return { ...current, status: 'stale', warning: '附件在 SOP 上下文采集后发生变化，未读取附件正文；请重新采集。' }
    }
    return current
  }

  if (attachmentMode === 'relevant' && attachments.length) {
    let remaining = 5
    let resultBudgetReached = false
    const pushBounded = value => {
      if (utf8Bytes([...attachmentResults, value]) > MAX_RELEVANT_BYTES) {
        resultBudgetReached = true
        return false
      }
      attachmentResults.push(value)
      return true
    }
    for (const attachment of attachments) {
      if (remaining <= 0 || resultBudgetReached) break
      // An attachment may be mounted on more than one node. Search it once
      // against its first live reference; the backend verifies that binding.
      const uid = attachment.node_uids[0]
      const fallback = fallbackFor(attachment)
      const context = await freshContentContext(uid, attachment.attachment_id)
      if (context.status !== 'ok') {
        if (context.warning) attachmentWarnings.push(`${attachment.file_name || attachment.attachment_id}: ${context.warning}`)
        pushBounded({
          attachment_id: attachment.attachment_id,
          node_uid: uid,
          status: context.status,
          fallback: ['not_attached', 'not_found', 'forbidden', 'unauthorized'].includes(context.status) ? undefined : fallback,
          warning: context.warning
        })
        continue
      }
      try {
        const result = await searchAttachmentKnowledge(api, {
          room_key: roomKey,
          node_uid: uid,
          attachment_id: attachment.attachment_id,
          query,
          top_k: remaining
        }, { context })
        const status = result.status || 'unavailable'
        if (status !== 'ok' || !Array.isArray(result.items) || !result.items.length) {
          const fallbackAllowed = !['not_attached', 'not_found', 'forbidden', 'unauthorized'].includes(status)
          pushBounded({ attachment_id: attachment.attachment_id, node_uid: uid, status, fallback: result.fallback || (fallbackAllowed ? fallback : undefined), source_backend: result.source_backend || null, fallback_reason: result.fallback_reason, warning: result.warning })
          continue
        }
        for (const item of result.items) {
          const candidate = {
            ...item,
            node_uid: uid,
            status: result.status,
            source_backend: result.source_backend || 'wiki',
            fallback_reason: result.fallback_reason,
            is_excerpt: true,
            complete: false
          }
          if (result.source_backend === 'attachment') {
            candidate.fallback = result.fallback || fallback
            candidate.next_read = result.next_read || item.next_read || null
          }
          if (result.warning) {
            candidate.warning = result.warning
            attachmentWarnings.push(`${attachment.file_name || attachment.attachment_id}: ${result.warning}`)
          }
          if (!pushBounded(candidate)) break
          remaining -= 1
          if (remaining <= 0) break
        }
      } catch (error) {
        if ([401, 403, 404].includes(Number(error?.statusCode || error?.status_code))) throw error
        pushBounded({ attachment_id: attachment.attachment_id, node_uid: uid, status: 'unavailable', fallback })
      }
    }
    if (resultBudgetReached) {
      const omitted = { status: 'response_budget_reached', omitted_attachments: Math.max(0, attachments.length - new Set(attachmentResults.map(item => item.attachment_id).filter(Boolean)).size) }
      if (utf8Bytes([...attachmentResults, omitted]) <= MAX_RELEVANT_BYTES) attachmentResults.push(omitted)
    }
  }

  if (attachmentMode === 'full' && attachments.length) {
    const first = attachments[0]
    const uid = first.node_uids[0]
    const context = await freshContentContext(uid, first.attachment_id)
    if (context.status !== 'ok') {
      if (context.warning) attachmentWarnings.push(`${first.file_name || first.attachment_id}: ${context.warning}`)
      attachmentResults.push({
        attachment_id: first.attachment_id,
        node_uids: first.node_uids,
        file_name: first.file_name,
        status: context.status,
        complete: false,
        fallback: ['not_attached', 'not_found', 'forbidden', 'unauthorized'].includes(context.status) ? undefined : fallbackFor(first),
        warning: context.warning
      })
    } else {
    try {
      const result = await readAttachmentKnowledge(api, {
        room_key: roomKey,
        node_uid: first.node_uids[0],
        attachment_id: first.attachment_id,
        source_backend: 'wiki',
        length: DEFAULT_ATTACHMENT_PAGE_CHARS
      }, { context })
      attachmentResults.push({
        attachment_id: first.attachment_id,
        node_uids: first.node_uids,
        file_name: first.file_name,
        status: result.status || 'unavailable',
        source_backend: result.source_backend || null,
        fallback_reason: result.fallback_reason,
        text: result.text || '',
        next_cursor: result.next_cursor || null,
        next_read: result.next_read || null,
        has_more: !!result.has_more,
        complete: !!result.complete,
        complete_scope: result.complete_scope || 'parsed_text',
        generation: result.generation || null,
        source: result.source || null,
        fallback: result.fallback || (['not_attached', 'not_found', 'forbidden', 'unauthorized'].includes(result.status) ? undefined : result.status === 'ok' ? undefined : fallbackFor(first)),
        warning: result.warning || undefined
      })
    } catch (error) {
      if ([401, 403, 404].includes(Number(error?.statusCode || error?.status_code))) throw error
      attachmentResults.push({ ...first, status: 'unavailable', fallback: fallbackFor(first) })
    }
    }
  }

  const sopText = item => /^SOP(?:\b|\s|[:：]|$)/i.test(String(item.data?.text || '').replace(/<[^>]*>/g, '').trim())
  const sop = sopText(target) ? target : subtree.find(sopText)
  const sopChildren = sop ? subtree.filter(item => item.parent_uid === sop.uid) : []
  const role = prefix => sopChildren.find(item => new RegExp(`^${prefix}(?:\\b|\\s|[:：])`, 'i').test(String(item.data?.text || '').replace(/<[^>]*>/g, '').trim()))
  const nodesComplete = nodeComplete(revisions, nodeWarnings)
  const completeFullRead = attachmentMode === 'full' && attachments.length === 1 &&
    attachmentResults.length === 1 && attachmentResults[0].status === 'ok' && attachmentResults[0].complete
  const attachmentsComplete = attachmentListComplete && (attachments.length === 0 || completeFullRead)
  if (revisions.size !== 1) nodeWarnings.push('读取期间导图修订号变化，请重新采集')
  const revision = revisions.size === 1 ? [...revisions][0] : null
  return {
    response_version: 2,
    target: { uid: target.uid, text: target.data?.text || '', room_key: roomKey, revision },
    path, children, subtree, siblings,
    notes: [...nodes.values()].filter(item => item.data?.note).map(item => ({ uid: item.uid, note: item.data.note })),
    references,
    attachments: {
      mode: attachmentMode,
      complete: attachmentsComplete,
      references: attachments.map(({ metadata, ...reference }) => reference),
      results: attachmentResults
    },
    source_uids: [...nodes.keys()],
    existing_sop: { found: !!sop, sop_uid: sop?.uid || null, C: role('C') || null, P: role('P') || null },
    nodes_complete: nodesComplete,
    attachments_complete: attachmentsComplete,
    attachment_mode: attachmentMode,
    complete: nodesComplete && attachmentsComplete,
    warnings: [...new Set([...nodeWarnings, ...attachmentWarnings])],
    attachment_warnings: [...new Set(attachmentWarnings)],
    source_revision: revision
  }
}
