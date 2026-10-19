const fs = require('fs')
const path = require('path')
const { loadConfig } = require('../src/config')
const { createPool } = require('../src/db')
const { rollback } = require('../src/migrate')

async function main() {
  const config = loadConfig()
  const pool = createPool(config)
  await rollback(pool)
  await pool.end()
  fs.rmSync(path.join(config.dataDir, 'objects'), { recursive: true, force: true })
  console.log('[file-knowledge] 已删除 schema knowledge 和本地对象目录。脑图表未改动。')
}

main().catch(err => {
  console.error('[file-knowledge] 回滚失败:', err.message)
  process.exit(1)
})
