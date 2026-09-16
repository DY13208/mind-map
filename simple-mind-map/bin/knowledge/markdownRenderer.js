const TurndownService = require('turndown')
const { hash, branchPath } = require('./utils')
const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
td.remove(['script', 'style', 'iframe', 'object'])
function safeUrl(value) {
  const text = String(value || '').trim()
  return /^(https?:\/\/|mailto:)/i.test(text) && !/[\x00-\x20<>]/.test(text) ? text.replace(/\(/g, '%28').replace(/\)/g, '%29') : ''
}
const escape = value => String(value || '').replace(/[\\`*_{}\[\]<>#!|]/g, '\\$&')
td.addRule('safeLink', { filter: 'a', replacement: (content, node) => {
  const url = safeUrl(node.getAttribute('href'))
  return url ? `[${content || escape(url)}](${url})` : content
} })
td.addRule('safeImage', { filter: 'img', replacement: (_, node) => {
  const url = safeUrl(node.getAttribute('src'))
  return url ? `![${escape(node.getAttribute('alt'))}](${url})` : '[图片未导出]'
} })
function markdown(value) {
  const text = String(value || '').replace(/\r\n?/g, '\n')
  return /<\/?[a-z][^>]*>/i.test(text) ? td.turndown(text).trim() : text.trim()
}
function title(value) {
  return escape(markdown(value).replace(/\n+/g, ' ').replace(/[*`]/g, '').trim() || '未命名')
}
function semantic(row, attachments) {
  const d = row || {}
  return {
    text: markdown(d.text), note: markdown(d.note), hyperlink: safeUrl(d.hyperlink), hyperlinkTitle: title(d.hyperlinkTitle),
    image: safeUrl(d.image), imageTitle: title(d.imageTitle), unresolvedImage: d.image && !safeUrl(d.image) ? String(d.image) : '',
    tag: Array.isArray(d.tag) ? d.tag.map(item => typeof item === 'string' ? item : item?.text || '').filter(Boolean) : [],
    generalization: (Array.isArray(d.generalization) ? d.generalization : []).map(item => ({ uid: item.uid || '', text: markdown(item.text), range: item.range || null })),
    attachmentId: d.attachmentId || '', attachmentUrl: safeUrl(d.attachmentUrl), attachmentName: d.attachmentName || '',
    // The extraction table is authoritative once the attachment is registered.
    attachmentText: attachments.length ? '' : markdown(d.attachmentExtractedText),
    attachments: attachments.map(a => ({ id: a.id, name: a.file_name, status: a.status,
      text: a.status === 'ready' ? markdown(a.extracted_text) : '', contentHash: a.content_hash, kind: a.source_kind }))
  }
}
function nodeBody(uid, content, depth) {
  const out = [`<a id="node-${Buffer.from(uid).toString('hex')}"></a>`]
  const heading = depth <= 6 ? '#'.repeat(depth) : '**'
  out.push(depth <= 6 ? `${heading} ${title(content.text)}` : `**${title(content.text)}**`)
  if (content.note) out.push(content.note)
  if (content.tag.length) out.push('标签：' + content.tag.map(escape).join('、'))
  if (content.hyperlink) out.push(`[${content.hyperlinkTitle || '链接'}](${content.hyperlink})`)
  if (content.image) out.push(`![${content.imageTitle}](${content.image})`)
  else if (content.unresolvedImage) out.push('图片：未导出（内嵌图片或内部图片标识）')
  for (const g of content.generalization) {
    out.push(`概括：${g.text || '未命名'}`)
    if (g.range) out.push('概括范围：' + escape(JSON.stringify(g.range)))
  }
  if (content.attachmentUrl) out.push(`[${escape(content.attachmentName || '附件')}](${content.attachmentUrl})`)
  for (const a of content.attachments) {
    // Relative to the consuming deployment, never an unauthenticated COS URL.
    const url = `/api/files/${encodeURIComponent(content.roomId)}/attachments/${encodeURIComponent(a.id)}/content`
    out.push(`附件：[${escape(a.name || a.id)}](${url})`)
    if (a.text) out.push(a.text)
    else out.push('附件解析状态：' + escape(a.status))
  }
  if (content.attachmentText) out.push(content.attachmentText)
  return out.join('\n\n')
}
function renderDocument(input, rootUid, previous) {
  const { model, data, attachments, roomId } = input
  const nodes = {}, parts = [], hashes = []
  const attached = new Map()
  for (const a of attachments) {
    const list = attached.get(a.node_uid) || []
    list.push(a); attached.set(a.node_uid, list)
  }
  const stack = [[rootUid, 1]]
  while (stack.length) {
    const [uid, depth] = stack.pop()
    const row = model.byUid.get(uid)
    const raw = data.get(uid) || {}
    const list = [...(attached.get(uid) || [])]
    if (raw.attachmentId && !list.some(a => a.id === raw.attachmentId)) {
      const a = attachments.find(a => a.id === raw.attachmentId)
      if (a) list.push(a)
    }
    list.sort((a, b) => a.id.localeCompare(b.id))
    const content = semantic(raw, list)
    const nodeHash = hash({ uid, parentUid: row.parent_uid, content, children: model.children.get(uid) })
    hashes.push([uid, nodeHash])
    nodes[uid] = { hash: nodeHash, path: rootUid === model.rootUid ? 'README.md' : branchPath(rootUid),
      parentUid: row.parent_uid, documentRootUid: rootUid === model.rootUid ? null : rootUid }
    parts.push(nodeBody(uid, { ...content, roomId }, depth), `<!-- mindmap:node=${Buffer.from(uid).toString('hex')} hash=${nodeHash} -->`)
    if (rootUid !== model.rootUid) {
      const kids = model.children.get(uid)
      for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], depth + 1])
    }
  }
  if (rootUid === model.rootUid) {
    const toc = model.branchRoots.map(uid => [uid, title(data.get(uid)?.text)])
    hashes.push(['toc', toc])
    parts.push(...toc.map(([uid, text]) => `- [${text}](${branchPath(uid)})`))
  }
  const sourceHash = hash(hashes)
  // Keep timestamps and source versions stable when semantic output is unchanged.
  if (previous?.sourceHash === sourceHash) return { unchanged: true, sourceHash, nodes }
  const generatedAt = new Date().toISOString()
  const header = ['---', `room_id: ${JSON.stringify(roomId)}`, 'source: mind-map',
    `root_uid: ${JSON.stringify(rootUid)}`, `source_hash: ${sourceHash}`,
    `sync_version: ${input.snapshotVersion}`, `generated_at: ${generatedAt}`, '---']
  return { sourceHash, nodes, text: header.join('\n') + '\n\n' + parts.join('\n\n') + '\n' }
}
module.exports = { renderDocument, semantic, markdown, safeUrl }
