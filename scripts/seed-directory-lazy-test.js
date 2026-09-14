/*
 * 为“目录懒加载”生成本地压测数据。
 *
 * 用法：node scripts/seed-directory-lazy-test.js [--count 1200]
 *
 * 数据只会写入 .env 指定的回环地址 PostgreSQL，所有记录均位于带
 * PERF_DIRECTORY_LAZY_ 前缀的新文件夹中，便于在界面中识别和清理。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const ENV_FILE = path.join(ROOT, '.env')
const PREFIX = 'PERF_DIRECTORY_LAZY_'

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) throw new Error('缺少项目根目录 .env')
  fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).forEach(line => {
    const text = line.trim()
    if (!text || text.startsWith('#')) return
    const index = text.indexOf('=')
    if (index < 1) return
    const key = text.slice(0, index).trim()
    let value = text.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  })
}

function parseCount() {
  const pos = process.argv.indexOf('--count')
  const value = pos >= 0 ? Number(process.argv[pos + 1]) : 1200
  if (!Number.isInteger(value) || value < 1 || value > 20000) {
    throw new Error('--count 必须是 1 到 20000 之间的整数')
  }
  return value
}

async function main() {
  loadEnv()
  const host = String(process.env.PGHOST || '').toLowerCase()
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`为避免误写远程数据库，仅允许回环 PGHOST；当前为 ${host || '(空)'}`)
  }
  const count = parseCount()
  const { Pool } = require(path.join(ROOT, 'web', 'node_modules', 'pg'))
  const { createPgFileStore } = require(path.join(ROOT, 'simple-mind-map/bin/fileSystem/pgStore'))
  const { createFileSystem } = require(path.join(ROOT, 'simple-mind-map/bin/fileSystem/engine'))
  const pool = new Pool({
    host,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    max: 8,
    application_name: 'mind-map-directory-lazy-seed'
  })
  const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const userId = String(process.env.AUTH_DEV_BYPASS_USER_ID || 'dev-local')
  const fileSystem = createFileSystem({ store: createPgFileStore(pool) })
  try {
    await pool.query('select 1')
    const folder = await fileSystem.createFolder({ name: `${PREFIX}${runId}`, userId })
    const levelOne = await fileSystem.createFolder({
      name: '资料中心',
      parentId: folder.id,
      userId
    })
    const levelTwo = await fileSystem.createFolder({
      name: '历史归档',
      parentId: levelOne.id,
      userId
    })
    // createRoom 的事务会读取文件夹成员；保留连接池余量，避免所有
    // worker 同时占满连接后互相等待。
    const workers = Math.min(4, count)
    let next = 0
    async function worker() {
      while (true) {
        const index = next++
        if (index >= count) return
        const number = String(index + 1).padStart(5, '0')
        // 三层目录分别落入不同脑图，既覆盖子目录按需展开，也覆盖
        // 每层独立分页；默认数据下一级、二级目录均超过 100 条。
        const folderId =
          index % 5 === 0 ? folder.id : index % 5 <= 2 ? levelOne.id : levelTwo.id
        await fileSystem.createRoom({
          roomKey: `perf-directory-lazy-${runId}-${number}`,
          title: `目录懒加载压测脑图 ${number}`,
          folderId,
          userId
        })
        if ((index + 1) % 100 === 0) console.log(`已创建 ${index + 1}/${count}`)
      }
    }
    await Promise.all(Array.from({ length: workers }, worker))
    console.log(JSON.stringify({
      ok: true,
      count,
      folders: [
        { id: folder.id, name: folder.name },
        { id: levelOne.id, name: levelOne.name },
        { id: levelTwo.id, name: levelTwo.name }
      ]
    }, null, 2))
  } finally {
    await pool.end()
  }
}

main().catch(error => {
  console.error('[目录懒加载造数失败]', error.message)
  process.exitCode = 1
})
