import { fetchNodeAttachmentContent } from './nodeAttachmentApi'
import { readBoundedAttachmentResponse } from './boundedAttachmentRead'

// Legacy URL attachments use the same bounded parsers as stored originals.
export async function fetchPreviewAttachmentContent(source, options = {}) {
  if (!source.external) return fetchNodeAttachmentContent(source.roomKey, source.id, options)
  const url = new URL(source.url, window.location.href)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('此附件链接不支持在线解析，请外部打开查看')
  try {
    const response = await fetch(url.href, { signal: options.signal, credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' })
    if (!response.ok) throw new Error('附件读取失败（HTTP ' + response.status + '），请外部打开查看')
    return await readBoundedAttachmentResponse(response, options)
  } catch (error) {
    if (error.name === 'TypeError') throw new Error('外部文件无法读取，可能未允许跨域访问，请点击“外部打开”查看')
    throw error
  }
}
