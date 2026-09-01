import { FetchTimeoutError, fetchWithTimeout } from './fetchWithTimeout'
import { getRuntimeConfig } from './runtimeConfig'

const AUTH_TIMEOUT_MS = 15000

let currentUser = null

export function getAuthApiUrl(path) {
  return `${getRuntimeConfig().collabApi}${path}`
}

function currentReturnTo() {
  return `${window.location.pathname}${window.location.search}${window.location
    .hash || ''}`
}

export async function loadAuthState() {
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
      throw new Error('认证服务响应超时，请稍后重试')
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
  const response = await fetch(url.toString(), {
    credentials: 'include',
    headers: { Accept: 'application/json' }
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data.loginUrl) {
    throw new Error(data.error || '登录二维码生成失败')
  }
  return data
}

export async function logout() {
  const response = await fetch(getAuthApiUrl('/api/auth/logout'), {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json' }
  })
  if (!response.ok && response.status !== 204) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error || '退出登录失败')
  }
  currentUser = null
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
  const response = await fetch(getAuthApiUrl('/api/auth/dev-login'), {
    method: 'POST',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ key })
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data.authenticated) {
    throw new Error(data.error || '开发者登录失败')
  }
  currentUser = data.user || null
  storeDevAuthKey(key)
  return data
}
