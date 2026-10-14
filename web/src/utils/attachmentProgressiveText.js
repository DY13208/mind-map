const CHUNK_BYTES = 16 * 1024
export const MAX_TEXT_PREVIEW_BYTES = 8 * 1024 * 1024

function textDecoder(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le')
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be')
  const sample = bytes.subarray(0, Math.min(512, bytes.length))
  let even = 0
  let odd = 0
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) { if (i % 2) odd++; else even++ }
  }
  if (odd > sample.length / 5) return new TextDecoder('utf-16le')
  if (even > sample.length / 5) return new TextDecoder('utf-16be')
  if (sample.includes(0)) throw new Error('文件包含二进制内容，请下载后查看')
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true })
    return new TextDecoder('utf-8')
  } catch (_) {
    return new TextDecoder('gb18030')
  }
}

// Keep the response reader paused until the user reaches the loaded content.
// The original /content endpoint and its authentication remain unchanged.
export async function openProgressiveAttachmentText(url, signal) {
  const res = await fetch(url, { credentials: 'include', cache: 'no-store', signal })
  if (!res.ok) throw new Error(res.status === 403 ? '无权访问此附件' : '附件读取失败，请重试')
  if (!res.body || !res.body.getReader) {
    throw new Error('当前浏览器不支持分段预览，请下载后查看')
  }
  const reader = res.body.getReader()
  let decoder = null
  let pending = new Uint8Array(0)
  let consumed = 0
  let done = false
  let cancelled = false
  let clipped = false
  let busy = false
  let sourceEnded = false
  return {
    async next() {
      if (busy || cancelled || done) return { text: '', done, clipped }
      busy = true
      try {
        let text = ''
        let read = 0
        while (read < CHUNK_BYTES && !done) {
          if (signal && signal.aborted) throw new DOMException('cancelled', 'AbortError')
          if (!pending.length) {
            if (sourceEnded) { done = true; text += decoder ? decoder.decode() : ''; break }
            const packet = await reader.read()
            if (packet.done) {
              done = true
              text += decoder ? decoder.decode() : ''
              break
            }
            pending = packet.value
            if (!decoder) {
              while (pending.length < 4) {
                const extra = await reader.read()
                if (extra.done) { sourceEnded = true; break }
                const joined = new Uint8Array(pending.length + extra.value.length)
                joined.set(pending); joined.set(extra.value, pending.length); pending = joined
              }
              decoder = textDecoder(pending)
            }
          }
          const count = Math.min(pending.length, CHUNK_BYTES - read, MAX_TEXT_PREVIEW_BYTES - consumed)
          text += decoder.decode(pending.subarray(0, count), { stream: true })
          pending = pending.subarray(count)
          consumed += count
          read += count
          if (consumed >= MAX_TEXT_PREVIEW_BYTES) {
            clipped = true
            done = true
            await reader.cancel()
          }
        }
        return { text, done, clipped, consumed }
      } finally { busy = false }
    },
    async cancel() {
      cancelled = true
      pending = new Uint8Array(0)
      await reader.cancel().catch(() => {})
    }
  }
}

export function formatPreviewBytes(size) {
  const bytes = Number(size) || 0
  if (!bytes) return '大小未知'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

export function attachmentUploadNotice(item = {}) {
  const media = /\.(png|jpe?g|webp|gif|pdf)$/i.test(item.fileName || '') ||
    /^(image\/|application\/pdf)/.test(item.mimeType || '')
  if (item.status === 'failed' && media && /OCR.*(未配置|not.configured)|未配置.*OCR/i.test(item.errorMessage || '')) {
    return { type: 'success', message: '已上传，可直接预览' }
  }
  return { type: 'warning', message: item.errorMessage || '处理失败' }
}
