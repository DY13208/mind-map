export class PromiseTimeoutError extends Error {
  constructor(message = 'operation timeout') {
    super(message)
    this.name = 'PromiseTimeoutError'
  }
}

export function promiseWithTimeout(promise, timeoutMs, label = 'operation') {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new PromiseTimeoutError(`${label} timed out after ${timeoutMs}ms`)
      )
    }, timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
