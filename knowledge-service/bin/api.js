const { loadConfig } = require('../src/config')
const { createPool } = require('../src/db')
const { migrate } = require('../src/migrate')
const { createLocalStorage } = require('../src/storage/local')
const { createApiServer } = require('../src/api/server')

async function main() {
  const config = loadConfig()
  const pool = createPool(config)
  await migrate(pool)
  const storage = createLocalStorage(config)
  const server = createApiServer({ pool, storage, config })
  server.listen(config.apiPort, config.bind, () => {
    console.log(`[file-knowledge] API http://${config.bind}:${config.apiPort}`)
  })
  const shutdown = () => {
    server.close(() => pool.end())
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(err => {
  console.error('[file-knowledge] API 退出:', err.message)
  process.exit(1)
})
