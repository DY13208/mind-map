import { FetchTimeoutError, fetchWithTimeout } from './fetchWithTimeout'
import { getRuntimeConfig } from './runtimeConfig'

const AUTH_TIMEOUT_MS = 30000

let currentUser = null

export function getAuthApiUrl(path) {
  return `${getRuntimeConfig().collabApi}${path}`
}

function currentReturnTo() {
  return `${window.location.pathname}${window.location.search}${window.location
    .hash || ''}`
}

export async function probeCollabHealth(timeoutMs = 4000) {
  try {
    const response = await fetchWithTimeout(
      getAuthApiUrl('/api/health'),
      {
        headers: { Accept: 'application/json' }
      },
      timeoutMs
    )
    if (!response.ok) {
      const err = new Error('协作服务未启动或暂时不可用')
      err.code = 'SERVICE_UNAVAILABLE'
      throw err
    }
    return response.json().catch(() => ({ ok: true }))
  } catch (err) {
    if (err && err.code === 'SERVICE_UNAVAILABLE') throw err
    if (err instanceof FetchTimeoutError) {
      const timeout = new Error('协作服务未启动或暂时不可用')
      timeout.code = 'SERVICE_UNAVAILABLE'
      throw timeout
    }
    const down = new Error('无法连接协作服务，请确认服务已启动后重试')
    down.code = 'SERVICE_UNAVAILABLE'
    throw down
  }
}

export async function loadAuthState() {
  await probeCollabHealth(4000)
  let response
  try {
    response = await fetchWithTimeout(
      getAuthApiUrl('/api/auth/me'),
      {
        credentials: 'include',
        headers: { Accept: 'application/json' }
      },
      AUTH_TIMEOUT_MS
    )
  } catch (err) {
    if (err instanceof FetchTimeoutError) {
      const timeout = new Error('AUTH_TIMEOUT')
      timeout.code = 'AUTH_TIMEOUT'
      throw timeout
    }
    if (err instanceof TypeError || String(err.message || '').includes('fetch')) {
      throw new Error('无法连接认证服务，请确认服务已启动后重试')
    }
    throw err
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || '认证服务暂不可用')
  }
  currentUser = data.authenticated && data.user ? data.user : null
  return data
}

export function getCurrentUser() {
  return currentUser
}

export function getLoginUrl() {
  const url = new URL(getAuthApiUrl('/api/auth/login'))
  url.searchParams.set('return_to', currentReturnTo())
  return url.toString()
}

export async function createLoginQr() {
  const url = new URL(getAuthApiUrl('/api/auth/qr'))
  url.searchParams.set('return_to', currentReturnTo())
  let response
  try {
    response = await fetchWithTimeout(
      url.toString(),
      {
        credentials: 'include',
        headers: { Accept: 'application/json' }
      },
      AUTH_TIMEOUT_MS
    )
  } catch (err) {
    if (err instanceof FetchTimeoutError) {
      throw new Error('登录二维码请求超时，请稍后重试')
    }
    throw new Error('无法连接认证服务，请确认服务已启动后重试')
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data.loginUrl) {
    throw new Error(data.error || '登录二维码生成失败')
  }
  return data
}

const LOGOUT_TIMEOUT_MS = 8000

// 顶层跳转退出：不受 CORS / 来源白名单影响，是 POST 失败时的兜底通道。
export function getLogoutNavigationUrl(returnTo) {
  const url = new URL(getAuthApiUrl('/api/auth/logout'))
  url.searchParams.set('return_to', returnTo || '/')
  return url.toString()
}

// 永远不抛异常：返回服务端是否确认退出，让调用方决定是否走兜底跳转。
// 退出按钮卡在「退出中…」出不来，比退出失败更让人困惑。
export async function logout() {
  let confirmed = false
  try {
    const response = await fetchWithTimeout(
      getAuthApiUrl('/api/auth/logout'),
      {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json' }
      },
      LOGOUT_TIMEOUT_MS
    )
    confirmed = response.ok || response.status === 204
  } catch (err) {
    confirmed = false
  }
  currentUser = null
  return confirmed
}

// 无论服务端是否响应，都要把用户送回登录页。
export async function logoutAndRedirect(returnTo = '/') {
  const confirmed = await logout()
  if (confirmed) {
    window.location.assign(returnTo)
    return true
  }
  window.location.assign(getLogoutNavigationUrl(returnTo))
  return false
}

const DEV_AUTH_KEY_STORAGE = 'mind_map_dev_auth_key'

export function getStoredDevAuthKey() {
  try {
    return localStorage.getItem(DEV_AUTH_KEY_STORAGE) || ''
  } catch (err) {
    return ''
  }
}

export function storeDevAuthKey(key) {
  try {
    if (key) localStorage.setItem(DEV_AUTH_KEY_STORAGE, key)
    else localStorage.removeItem(DEV_AUTH_KEY_STORAGE)
  } catch (err) {
    // ignore storage failures
  }
}

export async function devLogin(key) {
  let response
  try {
    response = await fetchWithTimeout(
      getAuthApiUrl('/api/auth/dev-login'),
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ key })
      },
      AUTH_TIMEOUT_MS
    )
  } catch (err) {
    if (err instanceof FetchTimeoutError) {
      throw new Error('开发者登录请求超时，请稍后重试')
    }
    throw new Error('无法连接认证服务，请确认服务已启动后重试')
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data.authenticated) {
    throw new Error(data.error || '开发者登录失败')
  }
  currentUser = data.user || null
  storeDevAuthKey(key)
  return data
}
