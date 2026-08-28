const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const ENV_FILE = path.join(ROOT, '.env')

function loadRootEnv() {
  if (!fs.existsSync(ENV_FILE)) {
    throw new Error('缺少项目根目录 .env')
  }
  fs.readFileSync(ENV_FILE, 'utf8')
    .split(/\r?\n/)
    .forEach(line => {
      const text = line.trim()
      if (!text || text.startsWith('#')) return
      const index = text.indexOf('=')
      if (index <= 0) return
      const key = text.slice(0, index).trim()
      let value = text.slice(index + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (process.env[key] === undefined) process.env[key] = value
    })
}

function requireFromWeb(name) {
  return require(path.join(ROOT, 'web', 'node_modules', name))
}

function objectKey(location, name) {
  const prefix = String(location || 'mind-map').replace(/^\/+|\/+$/g, '')
  return `${prefix}/${name}`
}

async function testPostgres() {
  const { Client } = requireFromWeb('pg')
  const client = new Client({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD
  })
  await client.connect()
  const res = await client.query('select current_database() as db, now() as ts')
  await client.end()
  return res.rows[0]
}

async function testCos() {
  const COS = requireFromWeb('cos-nodejs-sdk-v5')
  const cos = new COS({
    SecretId: process.env.TENCENT_COS_SECRET_ID,
    SecretKey: process.env.TENCENT_COS_SECRET_KEY
  })
  const Bucket = process.env.TENCENT_COS_BUCKET
  const Region = process.env.TENCENT_COS_REGION
  const location = process.env.TENCENT_COS_LOCATION || 'mind-map'
  const Key = objectKey(location, `_health-${Date.now()}.json`)
  const body = JSON.stringify({
    ok: true,
    from: 'mind-map-health-check',
    at: new Date().toISOString()
  })

  await new Promise((resolve, reject) => {
    cos.putObject(
      {
        Bucket,
        Region,
        Key,
        Body: Buffer.from(body),
        ContentType: 'application/json',
        ACL: process.env.TENCENT_COS_ACL || 'private'
      },
      (err, data) => (err ? reject(err) : resolve(data))
    )
  })

  const listed = await new Promise((resolve, reject) => {
    cos.getBucket(
      {
        Bucket,
        Region,
        Prefix: objectKey(location, '_health-'),
        MaxKeys: 10
      },
      (err, data) => (err ? reject(err) : resolve(data))
    )
  })

  await new Promise((resolve, reject) => {
    cos.deleteObject({ Bucket, Region, Key }, err =>
      err ? reject(err) : resolve()
    )
  })

  return {
    bucket: Bucket,
    region: Region,
    key: Key,
    listed: (listed.Contents || []).map(item => item.Key)
  }
}

async function main() {
  loadRootEnv()
  const result = { pg: null, cos: null }

  try {
    result.pg = await testPostgres()
    console.log('[PG] 连接成功')
    console.log(`     数据库: ${result.pg.db}`)
    console.log(`     时间:   ${result.pg.ts.toISOString()}`)
  } catch (err) {
    console.error('[PG] 连接失败:', err.message)
  }

  try {
    result.cos = await testCos()
    console.log('[COS] 写入/列出/删除成功')
    console.log(`      桶: ${result.cos.bucket}`)
    console.log(`      地域: ${result.cos.region}`)
    console.log(`      测试对象: ${result.cos.key}`)
    console.log(
      `      前缀命中: ${result.cos.listed.length ? result.cos.listed.join(', ') : '(无)'}`
    )
  } catch (err) {
    console.error('[COS] 失败:', err.message || err)
  }

  if (!result.pg || !result.cos) process.exitCode = 1
}

main()
