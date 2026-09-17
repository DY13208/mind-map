import { getAuthApiUrl } from './auth'
import { getRuntimeConfig } from './runtimeConfig'

export function getWikiAppUrl() {
  const runtime =
    (typeof window !== 'undefined' && window.__MIND_MAP_RUNTIME__) || {}
  const cfg = getRuntimeConfig()
  return String(
    runtime.wikiBase ||
      cfg.wikiBase ||
      'http://localhost:3040'
  ).replace(/\/$/, '')
}

/**
 * 用当前良策登录态换 Docmost 会话，并跳转到 Wiki。
 * @param {{ target?: '_blank'|'_self' }} [options]
 */
export async function openWikiWithSso(options = {}) {
  const target = options.target || '_blank'
  const response = await fetch(getAuthApiUrl('/api/auth/wiki-token'), {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json' }
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data.assertion) {
    throw new Error(data.error || '无法取得 Wiki 登录票据')
  }
  const base = String(data.appUrl || getWikiAppUrl()).replace(/\/$/, '')
  const exchange =
    data.exchangeUrl || `${base}/api/auth/mind-map/exchange`
  const url = new URL(exchange)
  url.searchParams.set('token', data.assertion)
  if (target === '_self') {
    window.location.assign(url.toString())
    return
  }
  const opened = window.open(url.toString(), target, 'noopener,noreferrer')
  if (!opened) {
    window.location.assign(url.toString())
  }
}
