import { productRequest } from '@/services/productHttp'
import { getRuntimeConfig } from './runtimeConfig'

export async function createShortNodeLink(roomKey, uid) {
  const result = await productRequest('/api/node-links', {
    method: 'POST', body: JSON.stringify({ roomKey, uid })
  })
  if (!result || !/^[A-Za-z0-9_-]{12}$/.test(result.code)) throw new Error('生成节点链接失败')
  return new URL(`/s/${result.code}`, getRuntimeConfig().appUrl).toString()
}

export function resolveShortNodeLink(code) {
  return productRequest(`/api/node-links/${encodeURIComponent(code)}`)
}

export function formatNodeLinkText(text, link, fullText = false) {
  const full = String(text || '').trim() || '未命名节点'
  const summary = Array.from(full.replace(/\s+/g, ' '))
  const label = fullText ? full : summary.slice(0, 80).join('') + (summary.length > 80 ? '…' : '')
  return `${label}\n${link}`
}

export async function copyNodeLinkText(text) {
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard unavailable')
    await navigator.clipboard.writeText(text)
  } catch (_) {
    // The LAN HTTP deployment cannot use the secure-context clipboard API.
    const input = document.createElement('textarea')
    input.value = text
    input.style.position = 'fixed'
    input.style.opacity = '0'
    document.body.appendChild(input)
    try {
      input.select()
      if (!document.execCommand('copy')) throw new Error('复制失败，请重试')
    } finally {
      document.body.removeChild(input)
    }
  }
}
