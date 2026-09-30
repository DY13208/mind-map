// Read-only composition of the existing node and attachment APIs.
export async function buildSopContext(roomKey, nodeUid, api) {
  const base = `/api/files/${encodeURIComponent(roomKey)}`
  const warnings = []
  const revisions = new Set()
  const readScope = async (uid, scope) => {
    const items = new Map()
    let cursor
    const seen = new Set()
    do {
      const page = await api(`${base}/nodes/query`, {
        method: 'POST',
        body: JSON.stringify({ selector: { type: 'uid', value: uid }, scope, ...(cursor ? { cursor } : {}) }),
        timeoutMs: 25000
      })
      if (page.match_status === 'candidates') throw new Error('节点定位不唯一')
      revisions.add(page.version)
      warnings.push(...(page.warnings || []))
      for (const field of page.omitted_fields || []) {
        if (field !== 'data.imgMap' && !field.endsWith('(fragmented)')) warnings.push(`${scope}: ${field} 未返回`)
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
  const attachments = []
  for (const uid of nodes.keys()) {
    const listed = await api(`${base}/attachments?node_uid=${encodeURIComponent(uid)}&limit=200`)
    const metas = listed.attachments || []
    if (metas.length === 200) warnings.push(`节点 ${uid} 附件达到列表上限，可能未读完`)
    for (const meta of metas) {
      let text = ''
      if (meta.status === 'ready') {
        let offset = 0
        const seenOffsets = new Set()
        while (true) {
          const slice = await api(`${base}/attachments/${encodeURIComponent(meta.id)}/text?offset=${offset}&limit=20000`)
          text += slice.text || ''
          if (!slice.has_more) break
          if (slice.next_offset == null || seenOffsets.has(slice.next_offset)) throw new Error('附件正文分页游标无效或重复')
          offset = slice.next_offset
          seenOffsets.add(offset)
        }
      } else {
        warnings.push(`附件 ${meta.id} 状态为 ${meta.status || 'unknown'}，正文不可读`)
      }
      attachments.push({ node_uid: uid, metadata: meta, text })
    }
  }
  const isSop = item => /^SOP(?:\b|\s|[:：]|$)/i.test(String(item.data?.text || '').replace(/<[^>]*>/g, '').trim())
  const sop = isSop(target) ? target : subtree.find(isSop)
  const sopChildren = sop ? subtree.filter(item => item.parent_uid === sop.uid) : []
  const role = prefix => sopChildren.find(item => new RegExp(`^${prefix}(?:\\b|\\s|[:：])`, 'i').test(String(item.data?.text || '').replace(/<[^>]*>/g, '').trim()))
  const complete = revisions.size === 1 && !warnings.some(w => w.includes('未读完') || w.includes('不可读') || w.includes('未返回'))
  if (revisions.size !== 1) warnings.push('读取期间导图修订号变化，请重新采集')
  const revision = revisions.size === 1 ? [...revisions][0] : null
  return {
    target: { uid: target.uid, text: target.data?.text || '', room_key: roomKey, revision },
    path, children, subtree, siblings,
    notes: [...nodes.values()].filter(item => item.data?.note).map(item => ({ uid: item.uid, note: item.data.note })),
    references, attachments,
    source_uids: [...nodes.keys()],
    existing_sop: { found: !!sop, sop_uid: sop?.uid || null, C: role('C') || null, P: role('P') || null },
    complete, warnings: [...new Set(warnings)], source_revision: revision
  }
}
