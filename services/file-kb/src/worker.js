'use strict'
// File KB worker: claims jobs from kb.jobs, renews leases, runs the pipeline.
const { loadConfig } = require('./config')
const { createPool } = require('./db')
const { createQueue } = require('./queue')
const { createStorage } = require('./storage')
const { createDoclingClient } = require('./docling/client')
const { createBreaker } = require('./docling/breaker')
const { createPipeline } = require('./pipeline')

function createWorker({ pool, config, docling, log = console.log }) {
  const queue = createQueue(pool, { workerId: config.workerId, leaseMs: config.leaseMs, backoffBaseMs: config.backoffBaseMs, maxConcurrent: config.concurrency, lightConcurrency: config.lightConcurrency, heavyConcurrency: config.heavyConcurrency, formatConcurrency:config.formatConcurrency })
  const storage = createStorage(config.storageRoot)
  const pipeline = createPipeline({ pool, queue, storage, docling, nativeLightParse: config.nativeLightParse, nativeLightMaxBytes:config.nativeLightMaxBytes, log })
  let stopping = false
  const running = new Set()

  async function runOne() {
    const job = await queue.claim()
    if (!job) return false
    const ctrl = new AbortController()
    const hb = setInterval(async () => {
      try {
        if (!(await queue.heartbeat(job))) { log(`[file-kb-worker] heartbeat lost lease job=${job.id}`); ctrl.abort(new Error('lease lost')) }
      } catch (err) { log(`[file-kb-worker] heartbeat error ${err.message}`) }
    }, Math.max(1000, Math.floor(config.leaseMs / 3)))
    try {
      return await pipeline.process(job, { signal: ctrl.signal })
    } finally { clearInterval(hb) }
  }

  async function loop() {
    while (!stopping) {
      let did = false
      try { did = await runOne() } catch (err) { log(`[file-kb-worker] loop error: ${err.message}`) }
      if (!did) await new Promise(r => setTimeout(r, config.pollMs))
    }
  }

  return {
    queue, storage,
    async start(n = config.concurrency) {
      await storage.init()
      for (let i = 0; i < n; i++) { const p = loop(); running.add(p); p.finally(() => running.delete(p)) }
    },
    runOne,
    async stop(graceMs = 20000) {
      stopping = true
      await Promise.race([Promise.all([...running]), new Promise(r => setTimeout(r, graceMs))])
    }
  }
}

module.exports = { createWorker }

if (require.main === module) {
  const config = loadConfig()
  if (!config.enabled) {
    console.log('[file-kb-worker] FILE_KB_ENABLED=false; idling')
    setInterval(() => {}, 1 << 30)
  } else {
    const pool = createPool(config.db)
    const docling = createDoclingClient({
      baseUrl: config.doclingUrl, apiKey: config.doclingApiKey, doOcr: config.doclingOcr,
      breaker: createBreaker({ threshold: config.breakerThreshold, openMs: config.breakerOpenMs }),
      totalTimeoutMs: config.doclingTotalTimeoutMs,
      ocrMode: config.doclingOcrMode, ocrEngine: config.doclingOcrEngine, ocrLang: config.doclingOcrLang,
      ocrForce: config.doclingOcrForce, ocrDocumentTimeoutS: config.doclingOcrDocumentTimeoutS,
      ocrTotalTimeoutMs: config.doclingOcrTotalTimeoutMs, ocrMinCharsPerPage: config.doclingOcrMinCharsPerPage,
      ocrTextlessPageRatio: config.doclingOcrTextlessPagePct / 100, ocrMixedMinPages: config.doclingOcrMixedMinPages
    })
    const w = createWorker({ pool, config, docling })
    w.start().then(() => console.log(`[file-kb-worker] ${config.workerId} started concurrency=${config.concurrency} lease=${config.leaseMs}ms ocr=${config.doclingOcrMode}/${config.doclingOcrEngine}`))
    const stop = async () => { await w.stop(); await pool.end().catch(() => {}); process.exit(0) }
    process.on('SIGTERM', stop)
    process.on('SIGINT', stop)
  }
}
