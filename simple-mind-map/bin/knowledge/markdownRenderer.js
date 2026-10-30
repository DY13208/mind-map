const TurndownService = require('turndown')
const { hash, branchPath } = require('./utils')
const {factKey}=require('../../src/utils/fillFacts')
const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
const ATTACHMENT_SOURCE_INDEX_VERSION = 1
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
    autoFill: d.autoFill?.version===2 && (!d.autoFill.key || d.autoFill.key===factKey(d.text,d.autoFill.field,d.autoFill.owner||'')) ? 2 : 0,
    text: markdown(d.text), note: markdown(d.note), hyperlink: safeUrl(d.hyperlink), hyperlinkTitle: title(d.hyperlinkTitle),
    image: safeUrl(d.image), imageTitle: title(d.imageTitle), unresolvedImage: d.image && !safeUrl(d.image) ? String(d.image) : '',
    tag: Array.isArray(d.tag) ? d.tag.map(item => typeof item === 'string' ? item : item?.text || '').filter(Boolean) : [],
    generalization: (Array.isArray(d.generalization) ? d.generalization : []).map(item => ({ uid: item.uid || '', text: markdown(item.text), range: item.range || null })),
    attachmentId: d.attachmentId || '', attachmentUrl: safeUrl(d.attachmentUrl), attachmentName: d.attachmentName || '',
    // The extraction table is authoritative once the attachment is registered.
    attachmentText: attachments.length ? '' : markdown(d.attachmentExtractedText),
    attachments: attachments.map(a => ({ id: a.id, name: a.file_name, status: a.status,
      text: a.status === 'ready' ? markdown(a.extracted_text) : '',
      extractedChars: Number(a.extracted_chars) || 0, contentHash: a.content_hash, kind: a.source_kind }))
  }
}
function nodeBody(uid, content, depth) {
  const out = []
  const attachmentSources = []
  let length = 0
  const add = value => {
    const text = String(value || '')
    if (out.length) length += 2
    const start = length
    out.push(text)
    length += text.length
    return { start, end: length }
  }
  add(`<a id="node-${Buffer.from(uid).toString('hex')}"></a>`)
  const heading = depth <= 6 ? '#'.repeat(depth) : '**'
  add(depth <= 6 ? `${heading} ${title(content.text)}` : `**${title(content.text)}**`)
  if (content.note) add(content.note)
  if (content.tag.length) add('标签：' + content.tag.map(escape).join('、'))
  if (content.hyperlink) add(`[${content.hyperlinkTitle || '链接'}](${content.hyperlink})`)
  if (content.image) add(`![${content.imageTitle}](${content.image})`)
  else if (content.unresolvedImage) add('图片：未导出（内嵌图片或内部图片标识）')
  for (const g of content.generalization) {
    add(`概括：${g.text || '未命名'}`)
    if (g.range) add('概括范围：' + escape(JSON.stringify(g.range)))
  }
  if (content.attachmentUrl) add(`[${escape(content.attachmentName || '附件')}](${content.attachmentUrl})`)
  for (const a of content.attachments) {
    // Relative to the consuming deployment, never an unauthenticated COS URL.
    const url = `/api/files/${encodeURIComponent(content.roomId)}/attachments/${encodeURIComponent(a.id)}/content`
    add(`附件：[${escape(a.name || a.id)}](${url})`)
    let range = null
    if (a.status === 'ready') {
      range = add(a.text)
    } else add('附件解析状态：' + escape(a.status))
    attachmentSources.push({
      room_key: content.roomId,
      node_uid: String(uid),
      attachment_id: String(a.id),
      name: String(a.name || a.id),
      content_hash: String(a.contentHash || ''),
      status: String(a.status || 'unavailable'),
      start: range ? range.start : null,
      end: range ? range.end : null,
      total_chars: range ? a.text.length : Number(a.extractedChars) || 0,
      range_unit: 'utf16',
      index_version: ATTACHMENT_SOURCE_INDEX_VERSION
    })
  }
  if (content.attachmentText) add(content.attachmentText)
  return { text: out.join('\n\n'), attachmentSources }
}
function renderDocument(input, rootUid, previous) {
  const { model, data, attachments, roomId } = input
  const nodes = {}, parts = [], hashes = [], attachmentSources = []
  let bodyLength = 0
  const appendPart = text => {
    if (parts.length) bodyLength += 2
    const start = bodyLength
    parts.push(text)
    bodyLength += text.length
    return start
  }
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
    const renderedNode = nodeBody(uid, { ...content, roomId }, depth)
    const bodyStart = appendPart(renderedNode.text)
    for (const source of renderedNode.attachmentSources) {
      attachmentSources.push({
        ...source,
        start: source.start == null ? null : bodyStart + source.start,
        end: source.end == null ? null : bodyStart + source.end,
        version: Number(input.snapshotVersion) || 0,
        source_revision: Number(input.sourceRevision) || 0
      })
    }
    appendPart(`<!-- mindmap:node=${Buffer.from(uid).toString('hex')} hash=${nodeHash} depth=${depth}${content.autoFill?' auto_fill=2':''} -->`)
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
  const sourceHash = hash({ attachmentSourceIndexVersion: ATTACHMENT_SOURCE_INDEX_VERSION, nodes: hashes })
  const body = parts.join('\n\n')
  // Keep timestamps and source versions stable when semantic output is unchanged.
  if (previous?.sourceHash === sourceHash) return {
    unchanged: true, sourceHash, nodes, attachmentSources,
    attachmentSourceIndexVersion: ATTACHMENT_SOURCE_INDEX_VERSION
  }
  const generatedAt = new Date().toISOString()
  const header = ['---', `room_id: ${JSON.stringify(roomId)}`, 'source: mind-map',
    `root_uid: ${JSON.stringify(rootUid)}`, `source_hash: ${sourceHash}`,
    `sync_version: ${input.snapshotVersion}`, `generated_at: ${generatedAt}`, '---']
  return { sourceHash, nodes, text: header.join('\n') + '\n\n' + body + '\n', attachmentSources,
    attachmentSourceIndexVersion: ATTACHMENT_SOURCE_INDEX_VERSION }
}
module.exports = { renderDocument, semantic, markdown, safeUrl, ATTACHMENT_SOURCE_INDEX_VERSION }
