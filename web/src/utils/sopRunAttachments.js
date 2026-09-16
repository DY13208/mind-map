import { uploadNodeAttachment } from './nodeAttachmentApi'

export const SOP_ATTACHMENT_ACCEPT = '.pdf,.docx,.xlsx,.csv,.txt,.md,.markdown,.log,.json,.html,.htm,.png,.jpg,.jpeg,.webp,.gif'
export const SOP_ATTACHMENT_LIMIT = 5
const MAX_BYTES = 5 * 1024 * 1024

export function validateSopAttachment(file) {
  if (!/\.(pdf|docx|xlsx|csv|txt|md|markdown|log|json|html?|png|jpe?g|webp|gif)$/i.test(file.name)) {
    return '请选择 PDF、Word（.docx）、Excel（.xlsx）、HTML、文本或图片文件'
  }
  if (file.size > MAX_BYTES) return '单个附件不能超过 5 MB'
  if (!file.size) return '不能上传空文件'
  return ''
}

export async function uploadSopAttachment(roomKey, file) {
  const response = await uploadNodeAttachment(roomKey, {
    file,
    fileName: file.name,
    mimeType: file.type || 'application/octet-stream',
    sourceKind: 'attachment'
  })
  const attachment = response && response.attachment
  if (!attachment || !attachment.id) throw new Error('附件上传未成功，请重试')
  if (attachment.status !== 'ready' || !String(attachment.extractedText || '').trim()) {
    throw new Error(attachment.errorMessage || '附件已保存，但未能解析内容，请更换文件或粘贴文字')
  }
  return attachment
}

// Keep the existing queue/API contract: attach parsed material to extraNote.
export function formatSopAttachmentNote(note, attachments) {
  const materials = attachments.filter(item => item.status === 'ready').map(item =>
    `【附件：${item.name}】\n附件 ID：${item.attachmentId}\n${item.extractedText}`
  )
  return [note, ...materials].filter(Boolean).join('\n\n')
}
