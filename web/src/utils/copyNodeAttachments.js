import {
  getNodeAttachment,
  fetchNodeAttachmentContent,
  uploadNodeAttachment,
  waitForAttachmentReady
} from './nodeAttachmentApi'

// Stored attachment IDs belong to a room. Cross-room pastes need their own files.
export async function copyNodeAttachments(payload, destinationRoom, onTransferStart) {
  const trees = JSON.parse(JSON.stringify(Array.isArray(payload.data) ? payload.data : [payload.data]))
  const sourceRoom = payload.sourceRoom
  if (!sourceRoom || !destinationRoom || sourceRoom === destinationRoom) return trees
  const copies = new Map()
  let started = false
  async function visit(node) {
    const data = node.data || {}
    if (data.attachmentId) {
      let attachment = copies.get(data.attachmentId)
      if (!attachment) {
        if (!started && onTransferStart) onTransferStart()
        started = true
        const result = await getNodeAttachment(sourceRoom, data.attachmentId)
        const original = result.attachment || {}
        const content = await fetchNodeAttachmentContent(sourceRoom, data.attachmentId)
        const name = original.fileName || data.attachmentName || 'attachment'
        const mimeType = original.mimeType || data.attachmentMimeType || content.contentType || 'application/octet-stream'
        const file = new File([content.buffer], name, { type: mimeType })
        const uploaded = await uploadNodeAttachment(destinationRoom, {
          file, fileName: name, mimeType, sourceKind: 'attachment'
        })
        attachment = uploaded.attachment || (uploaded.data && uploaded.data.attachment)
        if (!attachment || !attachment.id) throw new Error('复制附件失败：服务端未返回附件 ID')
        if (!['ready', 'failed'].includes(attachment.status)) {
          attachment = await waitForAttachmentReady(destinationRoom, attachment.id)
          if (!attachment || !['ready', 'failed'].includes(attachment.status)) {
            throw new Error('附件仍在处理中，请稍后重新粘贴')
          }
        }
        if (attachment.status === 'failed') {
          throw new Error(attachment.errorMessage || '复制附件处理失败')
        }
        copies.set(data.attachmentId, attachment)
      }
      Object.assign(data, {
        attachmentId: attachment.id,
        attachmentUrl: '',
        attachmentName: attachment.fileName || data.attachmentName,
        attachmentMimeType: attachment.mimeType || data.attachmentMimeType,
        attachmentStatus: attachment.status || 'queued',
        attachmentError: attachment.errorMessage || '',
        attachmentExtractedText: String(attachment.extractedText || '').slice(0, 2400)
      })
      delete data.attachmentProgress
      delete data.attachmentErrorIgnored
    }
    for (const child of node.children || []) await visit(child)
    const summaries = Array.isArray(data.generalization) ? data.generalization : data.generalization ? [data.generalization] : []
    for (const summary of summaries) await visit({ data: summary, children: summary.children || [] })
  }
  for (const tree of trees) await visit(tree)
  return trees
}
