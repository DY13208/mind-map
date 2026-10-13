export async function readBoundedAttachmentResponse(res, options = {}) {
  const maxBytes = Number(options.maxBytes)
  const bounded = Number.isFinite(maxBytes) && maxBytes > 0
  const total = Number(res.headers.get('content-length')) || 0
  const tooLarge = () => Object.assign(new Error('附件过大，请下载后查看'), { code: 'PREVIEW_TOO_LARGE' })
  if (bounded && !options.prefix && total > maxBytes) {
    if (res.body) await res.body.cancel()
    throw tooLarge()
  }
  if (!res.body || !res.body.getReader) {
    // Do not risk an unbounded allocation in browsers without streaming reads.
    if (bounded && (!total || total > maxBytes)) throw tooLarge()
    const buffer = await res.arrayBuffer()
    if (bounded && buffer.byteLength > maxBytes) throw tooLarge()
    return { buffer, truncated: false }
  }
  const reader = res.body.getReader()
  const chunks = []
  let size = 0
  let truncated = false
  try {
    for (let result = await reader.read(); !result.done; result = await reader.read()) {
      const value = result.value
      if (bounded && size + value.length > maxBytes && !options.prefix) throw tooLarge()
      const kept = bounded ? value.subarray(0, Math.max(0, maxBytes - size)) : value
      chunks.push(kept)
      size += kept.length
      if (bounded && options.prefix && size >= maxBytes) {
        truncated = !total || total > size || kept.length < value.length
        await reader.cancel()
        break
      }
    }
  } catch (err) {
    await reader.cancel().catch(() => {})
    throw err
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return { buffer: bytes.buffer, truncated }
}
