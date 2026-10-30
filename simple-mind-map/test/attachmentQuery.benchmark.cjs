// Run only against an explicitly configured, disposable local QA database.
process.env.MIND_MAP_SKIP_ROOT_ENV = '1'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const ATTACHMENT_COUNT = 20
const PREVIEW_CHARS = 2400
const DEFAULT_SAMPLES = 20
const MAX_SAMPLES = 200
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const ROOM_PREFIX = 'attachment-query-benchmark-'

function readConfig() {
  const configPath = String(process.env.ATTACHMENT_QUERY_BENCHMARK_CONFIG || '').trim()
  assert(configPath, 'Set ATTACHMENT_QUERY_BENCHMARK_CONFIG to a disposable test DB JSON file')
  const config = JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf8'))
  assert.equal(config.purpose, 'disposable-test', 'Config must declare purpose="disposable-test"')
  assert(config.pg && typeof config.pg === 'object', 'Config must include pg connection fields')
  assert(!config.pg.url && !config.pg.connectionString, 'Use explicit pg fields, not a connection string')

  const host = String(config.pg.host || '').trim().toLowerCase()
  assert(LOOPBACK_HOSTS.has(host), 'PostgreSQL benchmark host must be loopback')
  const database = String(config.pg.database || '').trim()
  assert(
    /^(?:mind_map|mindmap|attachment_wiki)[a-z0-9_]*(?:test|qa|benchmark)[a-z0-9_]*$/i.test(database),
    'PostgreSQL database name must be a dedicated mind-map test/QA/benchmark database'
  )
  const port = Number(config.pg.port || 5432)
  assert(Number.isInteger(port) && port > 0 && port <= 65535, 'Invalid PostgreSQL port')
  assert(config.pg.user, 'PostgreSQL user is required')
  return { host, port, database, user: String(config.pg.user), password: String(config.pg.password || '') }
}

function configureTestDatabase(pg) {
  process.env.PGHOST = pg.host
  process.env.PGPORT = String(pg.port)
  process.env.PGDATABASE = pg.database
  process.env.PGUSER = pg.user
  process.env.PGPASSWORD = pg.password
  process.env.COLLAB_PG_APP_NAME = 'mind-map-attachment-query-benchmark'
}

function makeCountedPool(pool) {
  let queryCount = 0
  return {
    resetCount() { queryCount = 0 },
    get queryCount() { return queryCount },
    async connect() {
      const client = await pool.connect()
      return {
        query(...args) {
          queryCount += 1
          return client.query(...args)
        },
        release(...args) {
          return client.release(...args)
        }
      }
    }
  }
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return null
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]
}

function valueSummary(values) {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    min: Math.min(...values),
    max: Math.max(...values)
  }
}

function metricSummary(runs, field) {
  return valueSummary(runs.map(run => run[field]))
}

async function seedRoom(pool, roomKey) {
  await pool.query(
    `insert into rooms(room_key, title, cos_key, version)
     values ($1, $2, $3, 1)`,
    [roomKey, '附件查询性能基准', `test/${roomKey}.json`]
  )

  const preview = '附'.repeat(PREVIEW_CHARS)
  const nodes = [
    ['root', null, 'a0', { uid: 'root', text: '基准根节点' }, true],
    ...Array.from({ length: ATTACHMENT_COUNT }, (_, index) => {
      const uid = `attachment-${String(index + 1).padStart(2, '0')}`
      return [uid, 'root', String(index).padStart(8, '0'), {
        uid,
        text: `带附件节点 ${index + 1}`,
        attachmentId: `benchmark-${index + 1}`,
        attachmentName: `基准附件-${index + 1}.txt`,
        attachmentMimeType: 'text/plain',
        attachmentStatus: 'ready',
        attachmentError: '',
        attachmentExtractedText: preview,
        __fv: { text: 1, attachment: 1 }
      }, false]
    })
  ]

  for (const [uid, parentUid, position, data, isRoot] of nodes) {
    await pool.query(
      `insert into room_nodes(room_key, uid, parent_uid, position, data, is_root, node_version)
       values ($1, $2, $3, $4, $5::jsonb, $6, 1)`,
      [roomKey, uid, parentUid, position, JSON.stringify(data), isRoot]
    )
  }
}

async function measureRun(queryPool, roomKey, attachmentContent) {
  let cursor = null
  let pageCount = 0
  let responseBytes = 0
  let itemCount = 0
  let databaseQueries = 0
  const queriesPerPage = []
  const seenCursors = new Set()
  const started = process.hrtime.bigint()

  do {
    queryPool.resetCount()
    const page = await require('../bin/nodeQuery').queryRoomNodes(queryPool, roomKey, {
      selector: { type: 'uid', value: 'root' },
      scope: 'children',
      page_size: ATTACHMENT_COUNT,
      attachment_content: attachmentContent,
      ...(cursor ? { cursor } : {})
    })
    const pageQueries = queryPool.queryCount
    assert(pageQueries > 0, 'Each page should execute database queries')
    pageCount += 1
    responseBytes += Buffer.byteLength(JSON.stringify(page), 'utf8')
    itemCount += page.items.length
    databaseQueries += pageQueries
    queriesPerPage.push(pageQueries)

    if (page.has_more) {
      assert(page.next_cursor, 'has_more page must include next_cursor')
      assert(!seenCursors.has(page.next_cursor), 'Pagination cursor repeated')
      seenCursors.add(page.next_cursor)
      cursor = page.next_cursor
    } else {
      assert.equal(page.next_cursor, null)
      cursor = null
    }
    assert(pageCount <= 100, 'Unexpectedly high page count; refusing unbounded benchmark loop')
  } while (cursor)

  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  assert.equal(itemCount, ATTACHMENT_COUNT, `${attachmentContent} must read all seeded attachment nodes`)
  return { response_bytes: responseBytes, page_count: pageCount, elapsed_ms: elapsedMs, database_queries: databaseQueries, queries_per_page: queriesPerPage }
}

async function main() {
  const pgConfig = readConfig()
  configureTestDatabase(pgConfig)
  const sampleCount = Number(process.env.ATTACHMENT_QUERY_BENCHMARK_SAMPLES || DEFAULT_SAMPLES)
  assert(Number.isInteger(sampleCount) && sampleCount >= DEFAULT_SAMPLES && sampleCount <= MAX_SAMPLES,
    `Sample count must be an integer from ${DEFAULT_SAMPLES} to ${MAX_SAMPLES}`)

  const storage = require('../bin/storage')
  let pool
  let roomKey
  try {
    pool = storage.getPool()
    await storage.initSchema()
    await pool.query("select set_config('application_name', 'mind-map-attachment-query-benchmark', false)")
    roomKey = ROOM_PREFIX + randomUUID()
    await seedRoom(pool, roomKey)

    const countedPool = makeCountedPool(pool)
    const runs = { preview: [], metadata: [] }
    for (let index = 0; index < sampleCount; index += 1) {
      const order = index % 2 === 0 ? ['preview', 'metadata'] : ['metadata', 'preview']
      for (const mode of order) {
        runs[mode].push(await measureRun(countedPool, roomKey, mode))
      }
    }

    for (let index = 0; index < sampleCount; index += 1) {
      assert.equal(runs.metadata[index].queries_per_page[0], runs.preview[index].queries_per_page[0],
        'metadata must not add DB queries to the same first-page read')
      assert(runs.metadata[index].response_bytes < runs.preview[index].response_bytes * 0.5,
        'metadata should reduce per-run response bytes by at least 50%')
    }

    const previewP50Bytes = metricSummary(runs.preview, 'response_bytes').p50
    const metadataP50Bytes = metricSummary(runs.metadata, 'response_bytes').p50
    const result = {
      schema_version: 1,
      benchmark: 'node-query-attachment-content',
      generated_at: new Date().toISOString(),
      database: { host: pgConfig.host, port: pgConfig.port, purpose: 'disposable-test' },
      room_key: roomKey,
      nodes_with_attachments: ATTACHMENT_COUNT,
      attachment_preview_chars_each: PREVIEW_CHARS,
      sample_count: sampleCount,
      modes: Object.fromEntries(Object.entries(runs).map(([mode, modeRuns]) => [mode, {
        response_bytes: metricSummary(modeRuns, 'response_bytes'),
        page_count: metricSummary(modeRuns, 'page_count'),
        elapsed_ms: metricSummary(modeRuns, 'elapsed_ms'),
        database_queries: metricSummary(modeRuns, 'database_queries'),
        queries_per_page: valueSummary(modeRuns.flatMap(run => run.queries_per_page)),
        runs: modeRuns
      }])),
      validation: {
        metadata_first_page_queries_equal_preview: true,
        metadata_reduces_each_sample_response_bytes_by_at_least_50_percent: true,
        seeded_nodes_read_per_run: ATTACHMENT_COUNT,
        median_response_byte_reduction_percent: Number(((1 - metadataP50Bytes / previewP50Bytes) * 100).toFixed(2))
      }
    }
    console.log(JSON.stringify(result, null, 2))
  } finally {
    if (pool && roomKey) {
      await pool.query('delete from room_nodes where room_key = $1', [roomKey]).catch(() => {})
      await pool.query('delete from rooms where room_key = $1', [roomKey]).catch(() => {})
    }
    if (pool) await pool.end()
  }
}

main().catch(error => {
  console.error(JSON.stringify({
    ok: false,
    error: String(error && error.message || error),
    code: error && error.code || null
  }))
  process.exitCode = 1
})
