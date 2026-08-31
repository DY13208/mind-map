import { getRuntimeConfig } from './runtimeConfig'

let currentUser = null

export function getAuthApiUrl(path) {
  return `${getRuntimeConfig().collabApi}${path}`
}

function currentReturnTo() {
  return `${window.location.pathname}${window.location.search}${window.location
    .hash || ''}`
}

export async function loadAuthState() {
  const response = await fetch(getAuthApiUrl('/api/auth/me'), {
    credentials: 'include',
    headers: { Accept: 'application/json' }
  })
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
