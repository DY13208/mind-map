export class FetchTimeoutError extends Error {
  constructor(message = 'request timeout') {
    super(message)
    this.name = 'FetchTimeoutError'
  }
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    })
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new FetchTimeoutError()
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}
