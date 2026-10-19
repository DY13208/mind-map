// 轮询：指数退避，页面隐藏时暂停，可见时立即恢复。
export function createPoller(task, { min = 2000, max = 30000, factor = 1.6 } = {}) {
  let timer = null
  let delay = min
  let stopped = true
  let running = false
  const hidden = () => typeof document !== 'undefined' && document.hidden

  async function tick() {
    timer = null
    if (stopped) return
    if (hidden()) return
    running = true
    let result
    try {
      result = await task()
      // task 返回 false 表示无需继续；返回 'changed' 时重置为最短间隔
      if (result === false) { stop(); return }
      delay = result === 'changed' ? min : Math.min(max, Math.round(delay * factor))
    } catch (_) {
      delay = Math.min(max, Math.round(delay * factor * 1.5))
    } finally {
      running = false
    }
    schedule()
  }
  function schedule() {
    if (stopped || timer) return
    timer = setTimeout(tick, delay)
  }
  function onVisibility() {
    if (stopped) return
    if (hidden()) { clearTimeout(timer); timer = null } else if (!running) { delay = min; clearTimeout(timer); timer = null; tick() }
  }
  function start(immediate = false) {
    if (!stopped) return
    stopped = false
    delay = min
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
    if (immediate) tick(); else schedule()
  }
  function stop() {
    stopped = true
    clearTimeout(timer)
    timer = null
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
  }
  return { start, stop, get active() { return !stopped } }
}
