const { loadConfig } = require('../src/config')
const { createPool } = require('../src/db')
const { migrate } = require('../src/migrate')
const { createLocalStorage } = require('../src/storage/local')
const { runWorker } = require('../src/jobs/worker')

async function main() {
  const config = loadConfig()
  const pool = createPool(config)
  await migrate(pool)
  const storage = createLocalStorage(config)
  await runWorker(pool, storage, config)
  console.log('[file-knowledge] 解析进程已启动，并发', config.parseConcurrency)
}

main().catch(err => {
  console.error('[file-knowledge] 解析进程退出:', err.message)
  process.exit(1)
})
