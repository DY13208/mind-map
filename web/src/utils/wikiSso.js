import { getAuthApiUrl } from './auth'
import { getRuntimeConfig } from './runtimeConfig'

function isPrivateOrLocalHost(hostname) {
  const host = String(hostname || '').toLowerCase()
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    return true
  }
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true
  return false
}

function defaultWikiBaseFromPage() {
  if (typeof window === 'undefined' || !window.location) {
    return 'http://127.0.0.1:3040'
  }
  const { protocol, hostname } = window.location
  return `${protocol}//${hostname}:3040`
}

/** 页面用域名访问时，避免被服务端下发的局域网 IP 盖掉 */
function resolveWikiBase(serverAppUrl) {
  const fallback = getWikiAppUrl()
  const server = String(serverAppUrl || '').replace(/\/$/, '')
  if (!server) return fallback
  try {
    const url = new URL(server)
    if (
      typeof window !== 'undefined' &&
      window.location &&
      !isPrivateOrLocalHost(window.location.hostname) &&
      isPrivateOrLocalHost(url.hostname)
    ) {
      const port = url.port || '3040'
      return `${window.location.protocol}//${window.location.hostname}:${port}`
    }
  } catch (_) {
    return fallback
  }
  return server
}

export function getWikiAppUrl() {
  const runtime =
    (typeof window !== 'undefined' && window.__MIND_MAP_RUNTIME__) || {}
  const cfg = getRuntimeConfig()
  return String(
    runtime.wikiBase ||
      cfg.wikiBase ||
      defaultWikiBaseFromPage()
  ).replace(/\/$/, '')
}

/**
 * 用当前良策登录态换 Docmost 会话，并仅在新窗口打开 Wiki（原页面不变）。
 * 必须在用户点击的同步栈里先 open about:blank，再 await 换票，否则会被浏览器拦截。
 * @param {{ target?: '_blank'|'_self' }} [options]
 */
export async function openWikiWithSso(options = {}) {
  const target = options.target || '_blank'
  let win = null
  if (target !== '_self') {
    win = window.open('about:blank', '_blank')
    if (!win) {
      throw new Error('浏览器拦截了新窗口，请允许本站弹窗后重试')
    }
    try {
      win.opener = null
    } catch (_) {
      /* ignore */
    }
    try {
      win.document.title = '正在打开 Wiki…'
    } catch (_) {
      /* ignore cross-origin about:blank quirks */
    }
  }

  try {
    const response = await fetch(getAuthApiUrl('/api/auth/wiki-token'), {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json' }
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || !data.assertion) {
      throw new Error(data.error || '无法取得 Wiki 登录票据')
    }
    const base = resolveWikiBase(data.appUrl)
    const exchange =
      data.exchangeUrl || `${base}/api/auth/mind-map/exchange`
    const url = new URL(exchange)
    url.searchParams.set('token', data.assertion)
    const href = url.toString()
    if (target === '_self') {
      window.location.assign(href)
      return
    }
    win.location.replace(href)
  } catch (error) {
    if (win && !win.closed) {
      try {
        win.close()
      } catch (_) {
        /* ignore */
      }
    }
    throw error
  }
}
