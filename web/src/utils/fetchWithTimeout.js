export class FetchTimeoutError extends Error {
  constructor(message = 'request timeout') {
    super(message)
    this.name = 'FetchTimeoutError'
  }
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const external = options.signal
  const onAbort = () => controller.abort()
  if (external) {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', onAbort)
  }
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    })
  } catch (err) {
    if (err && err.name === 'AbortError') {
      if (external && external.aborted) throw err
      throw new FetchTimeoutError()
    }
    throw err
  } finally {
    clearTimeout(timer)
    if (external) external.removeEventListener('abort', onAbort)
  }
}
