import { FetchTimeoutError, fetchWithTimeout } from '../utils/fetchWithTimeout'
import { getRuntimeConfig } from '../utils/runtimeConfig'
import { wrapHttpError } from './apiError'

let injected = null

export function setProductHttp(fn) {
  injected = typeof fn === 'function' ? fn : null
}

export async function productRequest(path, options = {}) {
  if (injected) return injected(path, options)
  const timeoutMs = options.timeoutMs || 20000
  const res = await fetchWithTimeout(
    `${getRuntimeConfig().collabApi}${path}`,
    {
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      method: options.method || 'GET',
      body: options.body
    },
    timeoutMs
  ).catch(err => {
    if (err instanceof FetchTimeoutError) {
      const timeout = new Error('协作服务响应超时，请稍后重试')
      timeout.code = 'TIMEOUT'
      throw timeout
    }
    throw err
  })
  const raw = await res.text()
  let data = {}
  if (raw) {
    try {
      data = JSON.parse(raw)
    } catch (err) {
      const invalid = new Error('协作服务返回了无效响应')
      invalid.code = 'INVALID_RESPONSE'
      invalid.statusCode = res.status
      throw invalid
    }
  }
  if (!res.ok) throw wrapHttpError(data, res.status)
  return data
}
