const { parseWithDocling } = require('../parser/docling')
const { processNextJob } = require('../service')

async function runWorker(pool, storage, config, parser = parseWithDocling) {
  let stopped = false
  async function tick() {
    if (stopped) return
    let processed = 0
    try {
      while (!stopped && processed < config.parseConcurrency) {
        const result = await processNextJob(pool, storage, parser, config)
        if (!result) break
        processed += 1
        console.log('[file-knowledge] 解析任务', result.status, result.id, result.error || '')
      }
    } catch (err) {
      console.error('[file-knowledge] 解析循环错误（服务继续运行）:', err.message)
    }
  }
  const timer = setInterval(tick, 1000)
  if (typeof timer.unref === 'function') timer.unref()
  tick()
  return {
    stop() {
      stopped = true
      clearInterval(timer)
    }
  }
}

module.exports = { runWorker }
