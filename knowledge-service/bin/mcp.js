const { loadConfig } = require('../src/config')
const { createPool } = require('../src/db')
const { migrate } = require('../src/migrate')
const { createMcpServer } = require('../src/mcp/server')

async function main() {
  const config = loadConfig()
  const pool = createPool(config)
  await migrate(pool)
  const server = createMcpServer({ pool, config })
  server.listen(config.mcpPort, config.bind, () => {
    console.log(`[file-knowledge] MCP http://${config.bind}:${config.mcpPort}/mcp`)
  })
  const shutdown = () => server.close(() => pool.end())
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(err => {
  console.error('[file-knowledge] MCP 退出:', err.message)
  process.exit(1)
})
