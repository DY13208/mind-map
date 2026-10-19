'use strict'
// Live acceptance against the pinned Docling container. Uses kb_scratch only.
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { createPool } = require('../../src/db')
const { createDoclingClient } = require('../../src/docling/client')
const { createStorage } = require('../../src/storage')
const { createQueue } = require('../../src/queue')
const { createPipeline } = require('../../src/pipeline')
const { migrate } = require('../../src/migrate')

function loadEnv() {
  const env = {}
  for (const line of fs.readFileSync('d:/mind-map/.env', 'utf8').split(/\n/)) {
    const m = line.match(/^(PGHOST|PGPORT|PGUSER|PGPASSWORD)=(.*)$/)
    if (m) env[m[1]] = m[2].trim().replace(/^"|"$/g, '')
  }
  return env
}

async function ingest(pool, storage, pipe, queue, fixture, ext) {
  const bytes = fs.readFileSync(fixture)
  const sha = crypto.createHash('sha256').update(bytes).digest('hex')
  const tmp = storage.tmpPath()
  fs.writeFileSync(tmp, bytes)
  const key = await storage.commitTemp(tmp, sha)
  const owner = 'kbdocling-live'
  const file = (await pool.query(
    `insert into kb.files (owner_id, name, ext, mime, size, sha256, storage_key, created_by)
     values ($1,$2,$3,'',$4,$5,$6,$1) returning id`,
    [owner, path.basename(fixture), ext, bytes.length, sha, key])).rows[0]
  const runId = (await pool.query('insert into kb.parse_runs (file_id) values ($1) returning id', [file.id])).rows[0].id
  await queue.enqueue(pool, { fileId: file.id, runId, kind: 'parse' })
  const steps = []
  for (let i = 0; i < 8; i++) {
    const job = await queue.claim()
    if (!job) break
    steps.push(`${job.kind}:${await pipe.process(job)}`)
  }
  const summary = await pool.query(
    `select f.status, f.parse_version, f.error,
            (select count(*)::int from kb.blocks where run_id = $2) blocks,
            (select count(*)::int from kb.records where run_id = $2) records,
            (select count(*)::int from kb.fields where run_id = $2) fields,
            (select docling_status from kb.parse_runs where id = $2) docling_status
       from kb.files f where f.id = $1`, [file.id, runId])
  const sample = await pool.query(
    `select type, page, bbox, left(text, 80) as text from kb.blocks where run_id = $1 order by seq limit 3`, [runId])
  const row = await pool.query(
    `select sheet, row_index, sku, price::float8 as price, stock, record_date
       from kb.records where run_id = $1 order by sheet, row_index limit 3`, [runId])
  return { ext, steps, fileId: file.id, runId, ...summary.rows[0], blocksSample: sample.rows, recordsSample: row.rows }
}

async function main() {
  const env = loadEnv()
  const pool = createPool({
    host: env.PGHOST, port: Number(env.PGPORT), user: env.PGUSER, password: env.PGPASSWORD,
    database: 'kb_scratch', max: 4, statementTimeoutMs: 15000
  })
  await migrate(pool, { log: () => {} })
  await pool.query(`delete from kb.files where owner_id = 'kbdocling-live'`)
  const storage = createStorage(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-live-')))
  await storage.init()
  const docling = createDoclingClient({ baseUrl: 'http://127.0.0.1:5001', totalTimeoutMs: 180000, doOcr: false })
  const health = await docling.health(5000)
  const queue = createQueue(pool)
  const pipe = createPipeline({ pool, queue, storage, docling, log: () => {} })
  const dir = path.join(__dirname, '../fixtures')
  const out = { health, files: [] }
  for (const [name, ext] of [['sample.pdf', 'pdf'], ['sample.docx', 'docx'], ['sample.xlsx', 'xlsx']]) {
    out.files.push(await ingest(pool, storage, pipe, queue, path.join(dir, name), ext))
  }
  console.log(JSON.stringify(out, null, 2))
  await pool.end()
}

main().catch(err => { console.error(err.stack || err.message); process.exit(1) })
