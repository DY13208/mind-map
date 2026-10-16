#!/usr/bin/env node
'use strict'

// Reproducible MCP + multi-browser collaboration acceptance harness.
// Default mode is read-only preflight. Any service/database/browser mutation
// requires the explicit --run flag. The harness uses only dedicated PostgreSQL
// databases and empty, per-run Redis logical databases on the isolated test
// services; it never restarts or edits an existing application container.

const fs = require('fs')
const path = require('path')
const http = require('http')
const net = require('net')
const os = require('os')
const vm = require('vm')
const { Worker } = require('worker_threads')
const { execFileSync, execFile, spawn } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)
const { randomUUID, createHash } = require('crypto')
const { performance } = require('perf_hooks')
const { compareClientRenderText } = require('./mcp-client-tree-text.cjs')
const { createRuntimeMonitor } = require('./mcp-collab-runtime-monitor.cjs')
const { safeResponseMetadata } = require('./mcp-collab-load-worker.cjs')

const ROOT = path.resolve(__dirname, '..')
const APP = path.join(ROOT, 'simple-mind-map')
const DRIVER_INPUTS = [
  __filename,
  path.join(__dirname, 'mcp-collab-load-worker.cjs'),
  path.join(__dirname, 'mcp-collab-runtime-monitor.cjs'),
  path.join(APP, 'bin', 'mindDoc.js'),
  path.join(__dirname, 'mcp-client-tree-text.cjs'),
  path.join(APP, 'src', 'plugins', 'RichText.js'),
  path.join(APP, 'src', 'utils', 'index.js'),
  path.join(APP, 'src', 'core', 'render', 'node', 'nodeCreateContents.js')
]
  .map(absolutePath => ({ absolutePath, path: path.relative(ROOT, absolutePath).replace(/\\/g, '/'), sha256: fileHash(absolutePath) }))
function verifyDriverInputs() {
  for (const row of DRIVER_INPUTS) assert(fileHash(row.absolutePath) === row.sha256, `验收驱动启动后发生修改，拒绝混用版本：${row.path}`)
  return { hashes: DRIVER_INPUTS.map(({ path, sha256 }) => ({ path, sha256 })),
    nodeVersion: process.version, browserInputMethod: 'real first-character keypress, remaining unchanged payload via insertText, product Tab submission' }
}
const OUTPUT_ROOT = path.join(ROOT, 'output', 'playwright', 'mcp-collab-20261014')
const PLAYWRIGHT_MODULE_DIR = process.env.MCP_COLLAB_DEPENDENCIES
  ? path.resolve(process.env.MCP_COLLAB_DEPENDENCIES)
  : fs.existsSync(path.join(APP, 'node_modules', 'playwright', 'package.json'))
    ? path.join(APP, 'node_modules')
    : path.join(ROOT, 'output', 'performance-repair-20261013', 'dependencies', 'node_modules')
const TASK_DEPENDENCIES = PLAYWRIGHT_MODULE_DIR
const BASELINE_PERF_IMAGE = String(process.env.MCP_COLLAB_BASELINE_IMAGE || '')
const DOCKER_NETWORK = 'mcp-incremental-test_default'
const DOCKER_POSTGRES = 'mcp-incremental-test-postgres-1'
const DOCKER_REDIS = 'mcp-incremental-test-redis-1'
const PG = Object.freeze({ host: '127.0.0.1', port: 25492, database: 'mcp_incremental_test', user: 'mcp_test', password: 'mcp-incremental-test-db-password' })
const REDIS_HOST = '127.0.0.1'
const REDIS_PORT = 16389
const REDIS_DB = 13
const API_PORT = 19413
const MCP_PORT = 19414
const API_PORT_B = 19415
const SAMPLE_WINDOW_MS = 120000
const WARMUP_MS = 30000
const ROUND_COUNT = 3
const SUSTAINED_MS = 10 * 60 * 1000
const BROWSER_CLIENTS = 10
const MCP_SINGLE_WRITES_PER_SECOND = 5
const BROWSER_EDIT_INTERVAL_MS = 2000
const FIXTURE_NODE_COUNT = 10000
const VISIBLE_NODE_COUNT = 1000
const PAGE_SIZE = 50
const MCP_TIMEOUT_MS = 60000
const RESOURCE_SAMPLE_INTERVAL_MS = 10000
const RESOURCE_PROBE_TIMEOUT_MS = Object.freeze({ containers: 8000, postgresConnect: 3000, postgresQuery: 4000, redis: 3000 })
const SAFE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
// The product defaults to rich-text editing. RichText owns the outer wrapper;
// Quill's inner .ql-editor is the actual contenteditable element.
const NODE_TEXT_EDITOR_SELECTOR = '.smm-node-edit-wrap[contenteditable="true"], .smm-richtext-node-edit-wrap .ql-editor[contenteditable="true"]'
const NODE_TEXT_EDITOR_VISIBLE_SELECTOR = '.smm-node-edit-wrap[contenteditable="true"]:visible, .smm-richtext-node-edit-wrap .ql-editor[contenteditable="true"]:visible'

const args = parseArgs(process.argv.slice(2))
const BASELINE_COMMIT = execFileSync('git', ['rev-parse', args['baseline-ref'] || process.env.MCP_COLLAB_BASELINE_REF || 'origin/main'], { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim()
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
const runToken = randomUUID().replace(/-/g, '').slice(0, 12)
const DIAGNOSTICS_ADMIN_ID = `mcp-cp-admin-${runToken}`
const variant = String(args.variant || 'A').toUpperCase()
const PERF_IMAGE = variant === 'C'
  ? String(args['candidate-image'] || process.env.MCP_COLLAB_CANDIDATE_IMAGE || '')
  : String(args['baseline-image'] || BASELINE_PERF_IMAGE)
const renderMode = String(args['render-mode'] || 'natural').toLowerCase()
// Natural mode preserves the original 1000-node renderer tree (root included).
// Full mode adds one visible leaf so exactly 1000 non-root nodes are drawn.
const FIXTURE_VISIBLE_LEAF_COUNT = renderMode === 'full' ? VISIBLE_NODE_COUNT - 10 : VISIBLE_NODE_COUNT - 11
const EXPECTED_RENDERER_TREE_NODE_COUNT = renderMode === 'full' ? VISIBLE_NODE_COUNT + 1 : VISIBLE_NODE_COUNT
const FULL_DRAW_TOTAL_DOM_NODE_COUNT = VISIBLE_NODE_COUNT + 1
const runDir = path.join(OUTPUT_ROOT, `${variant.toLowerCase()}-${renderMode}-${runId}`)
const eventsPath = path.join(runDir, 'events.jsonl')
const samplesPath = path.join(runDir, 'samples.jsonl')
const summaryPath = path.join(runDir, 'summary.json')
const browserTracePath = path.join(runDir, 'browser-trace.json')
const dockerOwned = new Map()
const logStates = new Map()
const mcpRequestRegistry = new Map()
const mcpWriterSeenEvents = new Set()
let mcpWriterCursor = 0
let mcpWriterProcessId = null
let resourceSampleCounter = 0
let resourceSamplerRunning = false
let previousHostCpuTimes = null
const activeRuntimeMonitors = new Set()

function startManagedRuntimeMonitor(source, phase) {
  const monitor = createRuntimeMonitor(source)
  const entry = { monitor, phase: String(phase || 'unspecified'), stopped: false, result: null }
  activeRuntimeMonitors.add(entry)
  return {
    stop() {
      if (!entry.stopped) {
        entry.result = monitor.stop()
        entry.stopped = true
        activeRuntimeMonitors.delete(entry)
      }
      return entry.result
    }
  }
}

function safePersistedError(value) {
  if (value == null) return null
  const safeLabels = new Set([
    'error_details_redacted', 'scheduled_request_not_dispatched', 'worker_request_failed',
    'response_body_read_failed', 'fetch_failed', 'mcp_response_missing_or_rejected',
    'browser_queue_stopped', 'RENDER_NODE_MISSING'
  ])
  if (typeof value === 'string') return safeLabels.has(value) ? value : 'error_details_redacted'
  if (value && typeof value === 'object') {
    const type = typeof value.name === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,40}$/.test(value.name) ? value.name : null
    const code = typeof value.code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value.code) ? value.code : null
    if (type || code) return [type, code].filter(Boolean).join(':')
  }
  return 'error_details_redacted'
}

function sanitizePersistedValue(value, parent = null) {
  if (Array.isArray(value)) return value.map(item => sanitizePersistedValue(item, parent))
  if (!value || typeof value !== 'object') return value
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === 'stack') continue
    if (key === 'error' || key === 'failure') result[key] = safePersistedError(item)
    else if (key === 'message') result.message = safePersistedError(item)
    else result[key] = sanitizePersistedValue(item, value)
  }
  return result
}

function projectRenderNodeProbe(value) {
  if (!value || value.category !== 'browser-render-node-probe') return null
  const safeText = (input, maxLength, pattern) => typeof input === 'string' && input.length <= maxLength && pattern.test(input) ? input : null
  const safeNumber = input => typeof input === 'number' && Number.isFinite(input) ? input : null
  const safeBoolean = input => typeof input === 'boolean' ? input : null
  const snapshot = value.snapshot && typeof value.snapshot === 'object' && !Array.isArray(value.snapshot) ? value.snapshot : {}
  const booleanKeys = [
    'renderTreeUidPresent', 'renderTreeScanTruncated', 'rootModelUidPresent', 'rootModelScanTruncated',
    'nodeIndexHasUid', 'rootNodeDataMatchesRenderTree', 'rendererIsRendering', 'hasRenderTimer', 'hasWaitRendering'
  ]
  const numberKeys = ['nodeIndexSize', 'rendererLayoutEpoch', 'v2RemoteApplyEpoch', 'adapterLastServerRevision', 'adapterServerRevision']
  const projectedSnapshot = {}
  for (const key of booleanKeys) projectedSnapshot[key] = safeBoolean(snapshot[key])
  for (const key of numberKeys) projectedSnapshot[key] = safeNumber(snapshot[key])
  projectedSnapshot.safeRootUid = safeText(snapshot.safeRootUid, 96, /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/)
  return {
    at: new Date().toISOString(),
    category: 'browser-render-node-probe',
    phase: safeText(value.phase, 100, /^[A-Za-z0-9_.:/-]+$/),
    token: safeText(value.token, 160, /^[A-Za-z0-9_.:/-]+$/),
    uid: safeText(value.uid, 160, /^[A-Za-z0-9_.:/-]+$/),
    userId: safeText(value.userId, 160, /^[A-Za-z0-9_.:@/-]+$/),
    snapshot: projectedSnapshot
  }
}

function parseArgs(argv) {
  const out = { flags: new Set(), values: {} }
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (value === '--run' || value === '--dry-run' || value === '--smoke' || value === '--mechanics-one-client' || value === '--force-render-probe' || value === '--warmup-precheck' || value === '--trace-hook-self-test' || value === '--browser-observation-self-test' || value === '--correctness-self-test') out.flags.add(value.slice(2))
    else if (value.startsWith('--')) out.values[value.slice(2)] = argv[++i]
    else throw new Error(`无法识别参数：${value}`)
  }
    return { ...out.values, ...Object.fromEntries([...out.flags].map(flag => [flag, true])) }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function append(file, value) {
  let state = logStates.get(file)
  if (!state) {
    state = { queue: [], writing: null, error: null }
    logStates.set(file, state)
  }
  const probe = value && value.category === 'browser-render-node-probe' ? projectRenderNodeProbe(value) : null
  state.queue.push(JSON.stringify(probe || sanitizePersistedValue({ at: new Date().toISOString(), ...value })) + '\n')
  if (state.queue.length >= 256) flushLogFile(file).catch(() => {})
}

async function flushLogFile(file) {
  const state = logStates.get(file)
  if (!state) return
  if (state.error) throw state.error
  if (state.writing) {
    await state.writing
    if (state.queue.length) return flushLogFile(file)
    return
  }
  if (!state.queue.length) return
  const chunk = state.queue.splice(0).join('')
  state.writing = fs.promises.appendFile(file, chunk).catch(error => {
    state.error = error
    throw error
  }).finally(() => { state.writing = null })
  await state.writing
  if (state.queue.length) return flushLogFile(file)
}

async function flushLogs() {
  await Promise.all([...logStates.keys()].map(file => flushLogFile(file)))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function fileHash(file) {
  return sha256(fs.readFileSync(file))
}

const FIXTURE_MIGRATION_PATHS = [
  'simple-mind-map/migrations/009_mcp_archive_operation_id_index.up.sql',
  'simple-mind-map/migrations/012_mcp_terminal_receipts.up.sql',
  'simple-mind-map/migrations/011_access_request_roles.up.sql',
  'simple-mind-map/migrations/010_node_count_cache_generation.up.sql'
]

function fixtureSchemaSource() {
  if (variant === 'C') {
    return {
      image: args['schema-image'] || PERF_IMAGE,
      manifest: args['schema-source-manifest'] || sourceForVariant().manifest
    }
  }
  return {
    image: args['schema-image'] || process.env.MCP_COLLAB_CANDIDATE_IMAGE || '',
    manifest: args['schema-source-manifest'] || process.env.MCP_COLLAB_CANDIDATE_SOURCE_MANIFEST || ''
  }
}

function imageManifestEvidence(image, manifestFile, { requiredMigrations = [] } = {}) {
  assert(image, `variant ${variant} requires an explicit immutable image tag via --${variant === 'C' ? 'candidate' : 'baseline'}-image`)
  assert(manifestFile, `variant ${variant} requires an explicit source manifest via --${variant === 'C' ? 'candidate' : 'baseline'}-source-manifest`)
  assert(fs.existsSync(manifestFile), `image source manifest is missing: ${manifestFile}`)
  const parsed = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  const files = parsed && Array.isArray(parsed.files) ? parsed.files : null
  const runtimeAssets = parsed && Array.isArray(parsed.runtimeAssets) ? parsed.runtimeAssets : null
  assert(files && runtimeAssets, `Image manifest must contain files and runtimeAssets arrays: ${manifestFile}`)
  const sourceEntries = files.filter(item => item && item.imagePath)
  assert(sourceEntries.length > 0, `Image source manifest has no directly verifiable imagePath entries: ${manifestFile}`)
  assert(sourceEntries.some(item => /^simple-mind-map\/bin\//.test(String(item.path || ''))), 'Image manifest has no copied simple-mind-map/bin source entries')
  assert(sourceEntries.some(item => /^simple-mind-map\/src\//.test(String(item.path || ''))), 'Image manifest has no copied simple-mind-map/src source entries')
  for (const migrationPath of requiredMigrations) {
    assert(sourceEntries.some(item => item.path === migrationPath), `Image manifest omits directly copied migration ${migrationPath}`)
  }
  assert(sourceEntries.every(item => item.path && (item.hash || item.sha256)), 'Direct image source entries must include path and hash/sha256')
  assert(runtimeAssets.length > 0 && runtimeAssets.every(item => item && item.imagePath && (item.hash || item.sha256)), 'Runtime asset entries must include imagePath and hash/sha256')
  const expected = sourceEntries.map(item => ({ path: item.path, imagePath: item.imagePath, hash: String(item.hash || item.sha256).toUpperCase() }))
  const expectedAssets = runtimeAssets.map(item => ({ imagePath: item.imagePath, hash: String(item.hash || item.sha256).toUpperCase() }))
  const script = [
    "const fs=require('fs'),crypto=require('crypto');",
    "const input=JSON.parse(fs.readFileSync(0,'utf8'));",
    "const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();",
    "const sources=input.sources.map(item=>{const file=item.imagePath;if(!fs.existsSync(file))return {path:item.path,imagePath:file,exists:false,sha256:null};return {path:item.path,imagePath:file,exists:true,sha256:digest(file)}});",
    "const assets=input.assets.map(item=>{const file=item.imagePath;if(!fs.existsSync(file))return {imagePath:file,exists:false,sha256:null};return {imagePath:file,exists:true,sha256:digest(file)}});",
    "process.stdout.write(JSON.stringify({sources,assets}));"
  ].join('')
  const actual = JSON.parse(docker(['run', '--rm', '-i', '--entrypoint', 'node', image, '-e', script], { input: JSON.stringify({ sources: expected, assets: expectedAssets }) }))
  const sourceMismatches = actual.sources.filter((item, index) => !item.exists || item.sha256 !== expected[index].hash)
  const assetMismatches = actual.assets.filter((item, index) => !item.exists || item.sha256 !== expectedAssets[index].hash)
  assert(sourceMismatches.length === 0, `Image source hash mismatch (${sourceMismatches.length}/${actual.sources.length}): ${JSON.stringify(sourceMismatches.slice(0, 10))}`)
  assert(assetMismatches.length === 0, `Image runtime asset hash mismatch (${assetMismatches.length}/${actual.assets.length}): ${JSON.stringify(assetMismatches.slice(0, 10))}`)
  return {
    kind: 'immutable-image-manifest-verified', image, manifest: path.resolve(manifestFile), manifestSha256: fileHash(manifestFile),
    matchedSourceFileCount: actual.sources.length, sourceFilesSha256: sha256(actual.sources.map(row => `${row.path}\0${row.sha256}`).join('\0')),
    actualSourceFiles: actual.sources, runtimeAssetCount: actual.assets.length,
    runtimeAssetsSha256: sha256(actual.assets.map(row => `${row.imagePath}\0${row.sha256}`).join('\0')),
    actualRuntimeAssets: actual.assets
  }
}

function imageReadText(image, absolutePath) {
  const script = "const fs=require('fs');process.stdout.write(fs.readFileSync(process.argv[1],'utf8'))"
  return docker(['run', '--rm', '--entrypoint', 'node', image, '-e', script, absolutePath])
}

async function applyFixtureSchemaMigrations(dbName, image, sourceEvidence) {
  const migrations = new Map()
  for (const migrationPath of FIXTURE_MIGRATION_PATHS) {
    const manifestEntry = sourceEvidence.actualSourceFiles.find(row => row.path === migrationPath)
    assert(manifestEntry && manifestEntry.imagePath, `Fixture schema source lacks directly copied migration ${migrationPath}`)
    const sql = imageReadText(image, manifestEntry.imagePath)
    const migrationSha256 = sha256(sql)
    assert(migrationSha256.toUpperCase() === manifestEntry.sha256.toUpperCase(), `Migration text differs from the image manifest: ${migrationPath}`)
    migrations.set(migrationPath, { sql, sha256: migrationSha256 })
  }
  const { Pool } = pgModule()
  const pool = new Pool({ ...PG, database: dbName, max: 1, connectionTimeoutMillis: 5000 })
  try {
    const identity = await pool.query('select current_database() as database,current_user as username')
    assert(identity.rows[0].database === dbName && identity.rows[0].username === PG.user, 'fixture migration target identity mismatch')

    const indexName = 'room_operations_archive_operation_id_idx'
    const indexBefore = await pool.query(`
      select idx.relname as index_name, i.indisvalid as is_valid, i.indisready as is_ready
      from pg_class idx join pg_index i on i.indexrelid = idx.oid
      where idx.oid = to_regclass('public.${indexName}')
    `)
    let archiveIndexAction = 'already-valid'
    if (!indexBefore.rowCount || !indexBefore.rows[0].is_valid || !indexBefore.rows[0].is_ready) {
      if (indexBefore.rowCount) {
        await pool.query(`drop index concurrently if exists public.${indexName}`)
        archiveIndexAction = 'invalid-index-dropped-and-recreated'
      } else archiveIndexAction = 'created'
      const createStatement = migrations.get(FIXTURE_MIGRATION_PATHS[0]).sql.match(/create\s+index\s+concurrently\s+if\s+not\s+exists[\s\S]*?;/i)
      assert(createStatement, '009 migration has no CREATE INDEX CONCURRENTLY statement')
      await pool.query("set lock_timeout = '2s'")
      try { await pool.query(createStatement[0]) }
      finally { await pool.query('reset lock_timeout') }
    }
    const indexAfter = await pool.query(`
      select idx.relname as index_name, i.indisvalid as is_valid, i.indisready as is_ready,
             pg_get_indexdef(idx.oid) as definition
      from pg_class idx join pg_index i on i.indexrelid = idx.oid
      where idx.oid = to_regclass('public.${indexName}')
    `)
    assert(indexAfter.rowCount === 1 && indexAfter.rows[0].is_valid && indexAfter.rows[0].is_ready,
      '009 archive operation id index is missing or invalid after fixture migration')
    assert(String(indexAfter.rows[0].definition).toLowerCase().includes('(room_key, operation_id)'),
      '009 archive operation id index does not cover (room_key, operation_id)')

    await pool.query(migrations.get(FIXTURE_MIGRATION_PATHS[1]).sql)
    const terminalReceipt = await pool.query("select to_regclass('public.mcp_terminal_receipts') as table_name")
    assert(terminalReceipt.rows[0].table_name === 'mcp_terminal_receipts', '010 migration did not create mcp_terminal_receipts')

    await pool.query(migrations.get(FIXTURE_MIGRATION_PATHS[2]).sql)
    await pool.query('BEGIN')
    try {
      await pool.query(migrations.get(FIXTURE_MIGRATION_PATHS[3]).sql)
      await pool.query('COMMIT')
    } catch (error) {
      await pool.query('ROLLBACK')
      throw error
    }
    const generation = await pool.query(`select
      exists(select 1 from information_schema.columns where table_schema='public' and table_name='rooms' and column_name='node_counts_generation') as has_column,
      (select count(*)::int from pg_trigger where tgrelid='room_nodes'::regclass and not tgisinternal and tgname in ('room_node_counts_generation_insert','room_node_counts_generation_update','room_node_counts_generation_delete') and tgenabled='O') as triggers,
      exists(select 1 from pg_index where indexrelid=to_regclass('public.room_nodes_parent_position_uid_idx') and indisvalid and indisready) as has_index`)
    assert(generation.rows[0].has_column && generation.rows[0].triggers === 3 && generation.rows[0].has_index,
      '010 generation column, enabled triggers, and bounded-preview index must be ready before fixture writes')
    const accessFields = await pool.query(`
      select column_name, data_type, is_nullable, column_default
      from information_schema.columns
      where table_schema='public' and table_name='room_access_requests'
        and column_name = any($1::text[])
      order by column_name
    `, [['granted_role', 'request_reason', 'decision_reason', 'requester_seen_at']])
    const fieldsByName = new Map(accessFields.rows.map(row => [row.column_name, row]))
    assert(fieldsByName.size === 4, `011 migration must expose all four access-request fields; found ${fieldsByName.size}`)
    assert(fieldsByName.get('granted_role').data_type === 'text' && fieldsByName.get('granted_role').is_nullable === 'YES',
      '011 granted_role must be nullable text')
    for (const column of ['request_reason', 'decision_reason']) {
      const field = fieldsByName.get(column)
      assert(field.data_type === 'text' && field.is_nullable === 'NO' && field.column_default,
        `011 ${column} must be non-null text with a default`)
    }
    assert(fieldsByName.get('requester_seen_at').data_type === 'timestamp with time zone' && fieldsByName.get('requester_seen_at').is_nullable === 'YES',
      '011 requester_seen_at must be nullable timestamptz')
    const constraints = await pool.query(`
      select conname, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid in ('public.room_access_requests'::regclass, 'public.room_members'::regclass)
        and conname in ('room_access_requests_granted_role_chk', 'room_members_role_chk')
      order by conname
    `)
    const constraintByName = new Map(constraints.rows.map(row => [row.conname, row.definition]))
    assert(constraintByName.size === 2 && /manager/.test(constraintByName.get('room_access_requests_granted_role_chk') || '') &&
      /manager/.test(constraintByName.get('room_members_role_chk') || ''), '011 manager-role constraints are missing or invalid')
    const accessIndex = await pool.query(`
      select idx.relname as index_name, i.indisvalid as is_valid, i.indisready as is_ready,
             pg_get_indexdef(idx.oid) as definition
      from pg_class idx join pg_index i on i.indexrelid = idx.oid
      where idx.oid = to_regclass('public.room_access_requests_requester_result_idx')
    `)
    assert(accessIndex.rowCount === 1 && accessIndex.rows[0].is_valid && accessIndex.rows[0].is_ready,
      '011 requester-result index is missing or invalid')
    const accessIndexDefinition = String(accessIndex.rows[0].definition).toLowerCase()
    assert(accessIndexDefinition.includes('(requester_id, decided_at desc)') && accessIndexDefinition.includes('where') && accessIndexDefinition.includes('status'),
      '011 requester-result index definition does not match the requested columns and pending-row predicate')
    return {
      sourceImage: image, sourceManifest: sourceEvidence.manifest,
      appliedBeforeWrites: true, database: dbName,
      migrations: FIXTURE_MIGRATION_PATHS.map((file, index) => ({
        file, sha256: migrations.get(file).sha256,
        action: index === 0 ? archiveIndexAction : 'applied',
        satisfied: true
      })),
      schemaChecks: {
        countGeneration: generation.rows[0],
        archiveOperationIdIndex: { valid: indexAfter.rows[0].is_valid, ready: indexAfter.rows[0].is_ready, definition: indexAfter.rows[0].definition },
        terminalReceiptTable: { exists: true },
        accessRequestFields: accessFields.rows,
        managerRoleConstraints: [...constraintByName.entries()].map(([name, definition]) => ({ name, definition })),
        accessRequestIndex: { valid: accessIndex.rows[0].is_valid, ready: accessIndex.rows[0].is_ready, definition: accessIndex.rows[0].definition }
      },
      comparisonSchemaPolicy: 'A/B/C share the same 009/010-generation/011/012 fixture schema; application code and frontend remain variant-specific immutable images.'
    }
  } finally { await pool.end() }
}

function directoryHash(directory) {
  const hash = createHash('sha256')
  const files = []
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push(full)
    }
  }
  walk(directory)
  let bytes = 0
  for (const file of files) {
    const relative = path.relative(directory, file).replace(/\\/g, '/')
    const contents = fs.readFileSync(file)
    bytes += contents.length
    hash.update(relative); hash.update('\0'); hash.update(contents); hash.update('\0')
  }
  return { sha256: hash.digest('hex'), files: files.length, bytes }
}

function exec(command, commandArgs, options = {}) {
  try {
    return execFileSync(command, commandArgs, {
      cwd: options.cwd || ROOT,
      encoding: options.encoding === undefined ? 'utf8' : options.encoding,
      input: options.input,
      maxBuffer: options.maxBuffer || 256 * 1024 * 1024,
      stdio: options.stdio || ['pipe', 'pipe', 'pipe']
    })
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : ''
    throw new Error(`${command} ${commandArgs.join(' ')} 失败${stderr ? `：${stderr.slice(-1800)}` : `：${error.message}`}`)
  }
}

async function execAsync(command, commandArgs, options = {}) {
  try {
    const result = await execFileAsync(command, commandArgs, {
      cwd: options.cwd || ROOT,
      encoding: options.encoding === undefined ? 'utf8' : options.encoding,
      maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
      timeout: options.timeout || 15000,
      windowsHide: true
    })
    return result.stdout
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : ''
    throw new Error(`${command} ${commandArgs.join(' ')} 失败${stderr ? `：${stderr.slice(-1800)}` : `：${error.message}`}`)
  }
}

function docker(args, options = {}) {
  return exec('docker', args, options)
}

async function dockerAsync(args, options = {}) {
  return execAsync('docker', args, options)
}

async function hostResourceSnapshot(includeExtendedResources = false) {
  const cpu = os.cpus()
  const cpuTimes = cpu.reduce((sum, item) => {
    const total = Object.values(item.times).reduce((value, current) => value + current, 0)
    return { total: sum.total + total, idle: sum.idle + Number(item.times.idle || 0) }
  }, { total: 0, idle: 0 })
  let cpuUsagePct = null
  if (previousHostCpuTimes) {
    const totalDelta = cpuTimes.total - previousHostCpuTimes.total
    const idleDelta = cpuTimes.idle - previousHostCpuTimes.idle
    if (totalDelta > 0) cpuUsagePct = Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100))
  }
  previousHostCpuTimes = cpuTimes
  const snapshot = {
    capturedAt: new Date().toISOString(),
    logicalCpuCount: cpu.length,
    cpuUsagePct,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    processRssBytes: process.memoryUsage().rss
  }
  if (includeExtendedResources) {
    const rows = (await dockerAsync(['stats', '--all', '--no-stream', '--format', '{{json .}}'])).split(/\r?\n/).filter(Boolean)
    snapshot.dockerContainers = rows.map(row => {
      try { return JSON.parse(row) } catch (_) { return { raw: row } }
    })
    const script = "$p=Get-Process chrome,msedge -ErrorAction SilentlyContinue; $m=$p | Measure-Object WorkingSet64 -Sum; [pscustomobject]@{processCount=@($p).Count;rssBytes=$m.Sum} | ConvertTo-Json -Compress"
    try {
      const raw = await execAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { timeout: 10000 })
      snapshot.browserProcesses = JSON.parse(raw)
    } catch (error) {
      snapshot.browserProcesses = { available: false, error: safeError(error.message) }
    }
  }
  return snapshot
}

function available(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', error => reject(new Error(`端口 ${port} 已占用：${error.code || error.message}`)))
    server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve()))
  })
}

function sourceForVariant() {
  const key = variant === 'C' ? 'candidate' : 'baseline'
  const envKey = variant === 'C' ? 'MCP_COLLAB_CANDIDATE_SOURCE_MANIFEST' : 'MCP_COLLAB_BASELINE_SOURCE_MANIFEST'
  const manifestArgument = args[`${key}-source-manifest`] || process.env[envKey] || ''
  const manifest = manifestArgument ? path.resolve(manifestArgument) : null
  return { kind: 'immutable-image-internal', image: PERF_IMAGE || null, manifest,
    commit: variant === 'C' ? null : BASELINE_COMMIT }
}

function buildForVariant() {
  const buildArgument = variant === 'C'
    ? (args['fixed-build'] || process.env.MCP_COLLAB_FIXED_BUILD_DIR || '')
    : (args['baseline-build-dir'] || args['baseline-build'] || process.env.MCP_COLLAB_BASELINE_BUILD_DIR || '')
  return buildArgument ? path.resolve(buildArgument) : null
}

function dockerMount(filePath) {
  return path.resolve(filePath).replace(/\\/g, '/')
}

function getRunSettings() {
  const bridgeAndDirect = variant !== 'A'
  return {
    COLLAB_V2: '1',
    COLLAB_V2_EVENT_BRIDGE: bridgeAndDirect ? '1' : '0',
    COLLAB_MCP_DIRECT: bridgeAndDirect ? '1' : '0'
  }
}

function assertBaselineManifestVersion() {
  if (variant === 'C') return
  const manifest = JSON.parse(fs.readFileSync(sourceForVariant().manifest, 'utf8'))
  assert(manifest.baseCommit === BASELINE_COMMIT,
    'Baseline image manifest commit does not match --baseline-ref; rebuild or select the correct frozen image')
}

function preflight() {
  const source = sourceForVariant()
  const buildDir = buildForVariant()
  assert(PERF_IMAGE, `${variant} variant requires explicit ${variant === 'C' ? '--candidate-image' : '--baseline-image'} (old defaults are disabled)`)
  assert(source.manifest, `${variant} variant requires explicit --${variant === 'C' ? 'candidate' : 'baseline'}-source-manifest`)
  assert(buildDir, `${variant} variant requires explicit ${variant === 'C' ? '--fixed-build' : '--baseline-build-dir'} extracted from the same immutable image`)
  const imageId = docker(['image', 'inspect', '--format', '{{.Id}}', PERF_IMAGE]).trim()
  const imageNode = docker(['run', '--rm', '--network', DOCKER_NETWORK, '--entrypoint', 'node', PERF_IMAGE, '--version']).trim()
  const pgState = docker(['inspect', '--format', '{{.State.Running}}', DOCKER_POSTGRES]).trim()
  const redisState = docker(['inspect', '--format', '{{.State.Running}}', DOCKER_REDIS]).trim()
  const networkRows = JSON.parse(docker(['network', 'inspect', DOCKER_NETWORK]))
  const redisDbCount = Number(docker(['exec', DOCKER_REDIS, 'redis-cli', '-p', '6379', 'CONFIG', 'GET', 'databases']).split(/\s+/).filter(Boolean).pop())
  const redisSize = Number(docker(['exec', DOCKER_REDIS, 'redis-cli', '-n', String(REDIS_DB), 'DBSIZE']).trim())
  assertBaselineManifestVersion()
  const sourceEvidence = imageManifestEvidence(PERF_IMAGE, source.manifest, { requiredMigrations: variant === 'C' ? FIXTURE_MIGRATION_PATHS : [] })
  const schemaSource = fixtureSchemaSource()
  assert(schemaSource.image && schemaSource.manifest,
    'Fixture schema requires --schema-image and --schema-source-manifest from the immutable candidate image for shared 009/010-generation/011/012 migrations')
  const schemaSourceEvidence = imageManifestEvidence(schemaSource.image, schemaSource.manifest, { requiredMigrations: FIXTURE_MIGRATION_PATHS })
  const schemaImageId = docker(['image', 'inspect', '--format', '{{.Id}}', schemaSource.image]).trim()
  const sourceExists = !!sourceEvidence
  const buildExists = !!buildDir && fs.existsSync(path.join(buildDir, 'index.html'))
  assert(buildExists, `Extracted frontend build is missing index.html: ${buildDir || '(not provided)'}`)
  if (buildExists) verifyRuntimeAssetsInBuildDir(buildDir, sourceEvidence)
  const playwrightPackage = path.join(PLAYWRIGHT_MODULE_DIR, 'playwright', 'package.json')
  return {
    mode: args.run ? 'run' : 'dry-run', runId, variant,
    scope: { source, sourceEvidence, schemaMigrationSource: { ...schemaSource, imageId: schemaImageId, evidence: schemaSourceEvidence }, buildDir: buildDir || null, settings: getRunSettings() },
    runtime: {
      hostNode: process.version, hostPlatform: process.platform,
      hostLogicalCpuCount: os.cpus().length, hostTotalMemoryBytes: os.totalmem(),
      playwrightModule: fs.existsSync(playwrightPackage) ? JSON.parse(fs.readFileSync(playwrightPackage, 'utf8')).version : null,
      dockerImage: PERF_IMAGE, dockerImageId: imageId, containerNode: imageNode
    },
    isolatedServices: {
      postgres: { container: DOCKER_POSTGRES, running: pgState === 'true', host: `${PG.host}:${PG.port}`, templateDatabase: PG.database },
      redis: { container: DOCKER_REDIS, running: redisState === 'true', host: `${REDIS_HOST}:${REDIS_PORT}`, plannedLogicalDb: REDIS_DB, databaseCount: redisDbCount, plannedDbSize: redisSize },
      network: DOCKER_NETWORK, members: Object.values(networkRows[0].Containers || {}).map(item => item.Name)
    },
    plannedLoad: {
      nodes: FIXTURE_NODE_COUNT, visibleNodes: VISIBLE_NODE_COUNT, realBrowserContexts: BROWSER_CLIENTS,
      browserEditEveryMs: BROWSER_EDIT_INTERVAL_MS, mcpSingleWritesPerSecond: MCP_SINGLE_WRITES_PER_SECOND,
      warmupMs: WARMUP_MS, sampleMs: SAMPLE_WINDOW_MS, rounds: ROUND_COUNT,
      sustainedMs: variant === 'C' ? SUSTAINED_MS : 0, batchItems: 100, burstItems: 100
    },
    boundaries: {
      existingAppContainersRestarted: false, distBuildTargetTouched: false,
      remoteDeployment: false, businessRoomTargeted: false,
      runNeedsExplicitFlag: !args.run, sourceAvailable: sourceExists,
      buildAvailable: buildExists, playwrightDependencyAvailable: fs.existsSync(playwrightPackage),
      redisNamespaceEmpty: redisSize === 0, dbCreatedDuringPreflight: false
    }
  }
}

async function loadPlaywright() {
  const modulePath = path.join(PLAYWRIGHT_MODULE_DIR, 'playwright')
  const { chromium } = require(modulePath)
  return { chromium }
}

function pgModule() {
  return require(path.join(APP, 'node_modules', 'pg'))
}

function redisModule() {
  return require(path.join(APP, 'node_modules', 'redis'))
}

async function connectRedis(dbIndex) {
  const { createClient } = redisModule()
  const client = createClient({ url: `redis://${REDIS_HOST}:${REDIS_PORT}/${dbIndex}`, socket: { connectTimeout: 5000 } })
  client.on('error', error => append(eventsPath, { type: 'redis-client-error', message: error.message }))
  await client.connect()
  return client
}

async function createDatabase(dbName, marker) {
  assert(/^mcp_cp_20261014_[a-c]_[a-f0-9]{12}$/.test(dbName), `拒绝非 run-owned DB 名称：${dbName}`)
  const { Pool } = pgModule()
  const pool = new Pool({ ...PG, max: 1, connectionTimeoutMillis: 5000 })
  try {
    const identity = await pool.query('select current_database() as database, current_user as username, version() as version')
    assert(identity.rows[0].database === PG.database && identity.rows[0].username === PG.user, 'PG schema source identity mismatch')
    const dump = docker(['exec', DOCKER_POSTGRES, 'pg_dump', '-U', PG.user, '--schema-only', '--no-owner', '--no-acl', PG.database])
    await pool.query(`CREATE DATABASE ${dbName} OWNER ${PG.user}`)
    docker(['exec', '-i', DOCKER_POSTGRES, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', PG.user, '-d', dbName], { input: dump })
    await pool.query(`COMMENT ON DATABASE ${dbName} IS '${marker}'`)
    const check = await pool.query(`select datname, shobj_description(oid, 'pg_database') as comment from pg_database where datname = $1`, [dbName])
    assert(check.rows.length === 1 && check.rows[0].comment === marker, '新建 DB 的 run ownership marker 不匹配')
    const schemaPool = new Pool({ ...PG, database: dbName, max: 1, connectionTimeoutMillis: 5000 })
    try {
      const tables = await schemaPool.query(`select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by table_name`)
      const indexes = await schemaPool.query(`select tablename, indexname, indexdef from pg_indexes where schemaname='public' and tablename in ('room_operations','room_operations_archive','room_restore_idempotency','room_nodes') order by tablename,indexname`)
      const relevant = indexes.rows
      const required = [
        ['room_operations', 'room_operations_op_id_global_uidx'],
        ['room_nodes', 'room_nodes_one_root_idx']
      ]
      for (const [table, index] of required) assert(relevant.some(row => row.tablename === table && row.indexname === index), `隔离 schema 缺少待验证索引 ${index}`)
      return {
        sourceIdentity: { database: identity.rows[0].database, username: identity.rows[0].username },
        sourceSchemaDumpSha256: sha256(dump), database: dbName,
        tableCount: tables.rowCount, tables: tables.rows.map(row => row.table_name),
        relevantIndexes: relevant.map(row => ({ table: row.tablename, name: row.indexname, definition: row.indexdef })),
        schemaOnly: true, dataCopied: false, ownershipMarker: marker
      }
    } finally { await schemaPool.end() }
  } catch (error) {
    await pool.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => {})
    throw error
  } finally { await pool.end() }
}

async function verifyPgTarget(dbName) {
  const { Pool } = pgModule()
  const pool = new Pool({ ...PG, database: dbName, max: 1, connectionTimeoutMillis: 5000 })
  try {
    const result = await pool.query('select current_database() as database, current_user as username')
    assert(result.rows[0].database === dbName && result.rows[0].username === PG.user, 'run DB target mismatch')
    return pool
  } catch (error) { await pool.end(); throw error }
}

async function verifyServices() {
  const pool = new (pgModule().Pool)({ ...PG, max: 1, connectionTimeoutMillis: 4000 })
  const redis = await connectRedis(REDIS_DB)
  try {
    const identity = await pool.query('select current_database() as database,current_user as username')
    assert(identity.rows[0].database === PG.database && identity.rows[0].username === PG.user, 'isolation PG preflight identity mismatch')
    assert(await redis.ping() === 'PONG', 'isolated Redis PING failed')
    const dbSize = await redis.dbSize()
    assert(dbSize === 0, `Redis DB ${REDIS_DB} 非空 (${dbSize} keys)，拒绝使用和清理`)
    return { postgres: { database: identity.rows[0].database, username: identity.rows[0].username }, redis: { host: REDIS_HOST, port: REDIS_PORT, db: REDIS_DB, size: dbSize } }
  } finally { await redis.quit().catch(() => {}); await pool.end().catch(() => {}) }
}

function createBaselineArchive() {
  const archiveFile = path.join(runDir, 'baseline-source.tar')
  const archive = exec('git', ['archive', '--format=tar', BASELINE_COMMIT, 'simple-mind-map/bin', 'simple-mind-map/src', 'simple-mind-map/migrations'], { encoding: 'buffer' })
  fs.writeFileSync(archiveFile, archive)
  assert(archive.length > 0, '097fa95e archive is empty')
  return { kind: 'clean-git-archive-provenance-only', commit: BASELINE_COMMIT, archive: path.basename(archiveFile), archiveSha256: fileHash(archiveFile), archiveBytes: archive.length, runtimeCodeSource: 'immutable Docker image; no source archive is mounted' }
}

function collectBuildEvidence(buildDir) {
  assert(fs.existsSync(path.join(buildDir, 'index.html')), `静态前端构建缺失：${buildDir}`)
  const tree = directoryHash(buildDir)
  return {
    path: buildDir, tree, manifest: fs.existsSync(path.join(buildDir, 'manifest.json')) ? 'manifest.json present' : 'no manifest.json',
    provenance: { manifest: sourceForVariant().manifest, note: '运行时前端静态资源逐项与对应不可变镜像的 runtimeAssets 哈希核对；目录只读采样。' }
  }
}

function verifyRuntimeAssetsInBuildDir(buildDir, sourceEvidence) {
  const entries = sourceEvidence && sourceEvidence.actualRuntimeAssets
  assert(Array.isArray(entries) && entries.length > 0, 'Image manifest has no verified runtimeAssets')
  const root = path.resolve(buildDir)
  const mismatches = []
  for (const item of entries) {
    const prefix = '/usr/share/nginx/html/'
    assert(String(item.imagePath).startsWith(prefix), `Unsupported runtime asset imagePath (expected ${prefix}): ${item.imagePath}`)
    const relative = item.imagePath.slice(prefix.length).replace(/\//g, path.sep)
    const target = path.resolve(root, relative)
    assert(target.startsWith(root + path.sep), `Runtime asset escaped extracted build directory: ${item.imagePath}`)
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      mismatches.push({ imagePath: item.imagePath, extractedPath: target, exists: false })
      continue
    }
    const actualHash = fileHash(target).toUpperCase()
    if (actualHash !== String(item.sha256).toUpperCase()) mismatches.push({ imagePath: item.imagePath, expected: item.sha256, actual: actualHash })
  }
  assert(mismatches.length === 0, `Extracted frontend assets do not match the immutable image (${mismatches.length}/${entries.length}): ${JSON.stringify(mismatches.slice(0, 10))}`)
  return { matchedRuntimeAssetCount: entries.length, runtimeAssetsSha256: sourceEvidence.runtimeAssetsSha256 }
}

function serviceEnv(dbName, redisDb, mcpToken, appOrigin, appOrigins, settings, role) {
  const isApi = role === 'api-a' || role === 'api-b'
  const env = {
    MIND_MAP_SKIP_ROOT_ENV: '1', HOST: '0.0.0.0', PORT: isApi ? '1234' : '3847',
    PGHOST: DOCKER_POSTGRES, PGPORT: '5432', PGDATABASE: dbName, PGUSER: PG.user, PGPASSWORD: PG.password,
    REDIS_URL: `redis://${DOCKER_REDIS}:6379/${redisDb}`, COLLAB_EVENT_BUS: 'redis',
    COLLAB_E2E: '1', COLLAB_OUTBOX_PUBLISHER: '0', COLLAB_TRACE: '0', COLLAB_V2_TRACE: '0',
    WECOM_AUTH_ENABLED: '1', WECOM_CORP_ID: 'ww1234567890abcdef', WECOM_AGENT_ID: '1000001', WECOM_SECRET: 'mcp-collab-test-only-secret',
    AUTH_SESSION_SECRET: `mcp-collab-isolated-${runToken}-secret-32-chars`,
    AUTH_APP_ORIGIN: appOrigin, AUTH_ALLOWED_ORIGINS: appOrigins.join(','), AUTH_COOKIE_SECURE: 'false',
    WECOM_REDIRECT_URI: `${appOrigin}/api/auth/wecom/callback`, MCP_TOKEN: mcpToken,
    MCP_HOST: '0.0.0.0', MCP_PORT: '3847',
    PERFORMANCE_DIAGNOSTICS: '1', MIND_MAP_SUPER_ADMIN_IDS: DIAGNOSTICS_ADMIN_ID,
    KNOWLEDGE_COMPILER_ENABLED: 'false', DOCMOST_SYNC_ENABLED: 'false', WIKI_COMPILER_SYNC_ENABLED: 'false',
    COLLAB_RATE_LIMIT_PER_ROOM: '8000', COLLAB_RATE_LIMIT_GLOBAL: '80000',
    NODE_PATH: variant === 'C' ? '/app/node_modules:/app/simple-mind-map/node_modules' : '/perf-deps:/app/node_modules:/app/simple-mind-map/node_modules',
    ...settings
  }
  if (role === 'mcp') env.MIND_MAP_API = `http://mcp-cp-${runToken}-${variant.toLowerCase()}-api-a:1234`
  return env
}

function startContainer(role, dbName, redisDb, settings, appOrigin, appOrigins, mcpToken) {
  const suffix = role === 'mcp' ? 'mcp' : role
  const name = `mcp-cp-${runToken}-${variant.toLowerCase()}-${suffix}`
  const existing = docker(['ps', '-a', '--format', '{{.Names}}']).split(/\r?\n/).filter(Boolean)
  assert(!existing.includes(name), `容器名称已存在，拒绝替换：${name}`)
  const port = role === 'api-b' ? API_PORT_B : role === 'api-a' ? API_PORT : MCP_PORT
  const env = serviceEnv(dbName, redisDb, mcpToken, appOrigin, appOrigins, settings, role)
  const isApi = role === 'api-a' || role === 'api-b'
  const serverPath = isApi ? '/app/simple-mind-map/bin/collabServer.js' : '/app/simple-mind-map/bin/mcpServer.mjs'
  const args = [
    'run', '--detach', '--name', name,
    '--label', `codex.mcp-collab-run=${runId}`,
    '--label', `codex.mcp-collab-variant=${variant}`,
    '--label', `codex.mcp-collab-role=${role}`,
    '--network', DOCKER_NETWORK, '--cpus', '4', '--memory', '4g',
    '--publish', `127.0.0.1:${port}:${isApi ? '1234' : '3847'}`,
    '--workdir', '/app/simple-mind-map'
  ]
  if (variant !== 'C') args.push('--mount', `type=bind,source=${dockerMount(TASK_DEPENDENCIES)},target=/perf-deps,readonly`)
  for (const [key, value] of Object.entries(env)) args.push('--env', `${key}=${value}`)
  args.push('--entrypoint', 'node', PERF_IMAGE, serverPath)
  if (role === 'mcp') args.push('--http')
  docker(args)
  dockerOwned.set(name, { runId, role })
  const nodeVersion = docker(['exec', name, 'node', '--version']).trim()
  assert(/^v20\./.test(nodeVersion), `${role} runtime must be Node20; found ${nodeVersion}`)
  append(eventsPath, { type: 'owned-container-started', name, role, image: PERF_IMAGE, nodeVersion, hostPort: port, cpus: 4, memoryLimit: '4g' })
  return { name, role, port, origin: `http://127.0.0.1:${port}`, nodeVersion }
}

async function waitForHttp(url, label, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (response.ok) return response
      last = `HTTP ${response.status}`
    } catch (error) { last = error.message }
    await sleep(300)
  }
  throw new Error(`${label} readiness timeout: ${last}`)
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function proxyHttp(req, res, port) {
  const upstream = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, response => {
    res.writeHead(response.statusCode || 502, response.headers)
    response.pipe(res)
  })
  upstream.on('error', error => {
    if (!res.headersSent) { res.writeHead(502); res.end(error.message) }
    else res.destroy(error)
  })
  req.pipe(upstream)
}

async function startGateway(buildDir, apiPort = API_PORT) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
    if (url.pathname === '/runtime-config.js' || url.pathname === '/dist/runtime-config.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end('window.__MIND_MAP_RUNTIME__={gateway:true,publicPath:"/"};')
      return
    }
    if (url.pathname === '/mcp') return proxyHttp(req, res, MCP_PORT)
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/collab-v2') || url.pathname === '/collab') return proxyHttp(req, res, apiPort)
    const assetPath = url.pathname.startsWith('/dist/') ? url.pathname.slice('/dist'.length) : url.pathname
    const relative = assetPath === '/' ? '/index.html' : decodeURIComponent(assetPath)
    const target = path.resolve(buildDir, `.${relative}`)
    if (!target.startsWith(buildDir + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      res.writeHead(404); res.end('not found'); return
    }
    const mime = {
      '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json; charset=utf-8'
    }[path.extname(target).toLowerCase()] || 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' })
    fs.createReadStream(target).pipe(res)
  })
  server.on('upgrade', (req, socket, head) => {
    const backend = net.connect(apiPort, '127.0.0.1', () => {
      backend.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` + Object.entries(req.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n') + '\r\n\r\n')
      if (head && head.length) backend.write(head)
      socket.pipe(backend); backend.pipe(socket)
    })
    backend.on('error', () => socket.destroy())
    socket.on('error', () => backend.destroy())
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(120000) })
  const text = await response.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch (_) {}
  return { response, text, data }
}

function authHeaders(cookie, origin) {
  return { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }
}

async function createIdentity(origin, userId) {
  const result = await requestJson(`${origin}/api/auth/e2e-identity`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId })
  })
  assert(result.response.ok && result.data && result.data.token, `创建隔离 E2E 身份失败 user=${userId} HTTP ${result.response.status}: ${result.text.slice(0, 300)}`)
  return { userId, token: result.data.token, cookie: `mind_map_session=${result.data.token}` }
}

function makeFixture(runToken) {
  let leaf = 0
  const node = (uid, text, children, expand) => ({ data: { uid, text, expand: expand !== false }, children: children || [] })
  const branches = []
  const visibleLeaves = []
  const hiddenLeaves = FIXTURE_NODE_COUNT - 11 - FIXTURE_VISIBLE_LEAF_COUNT
  for (let branch = 0; branch < 10; branch += 1) {
    const count = branch === 0 ? FIXTURE_VISIBLE_LEAF_COUNT : Math.floor(hiddenLeaves / 9) + (branch <= hiddenLeaves % 9 ? 1 : 0)
    const children = []
    for (let i = 0; i < count; i += 1) {
      leaf += 1
      const uid = `cp-${runToken}-leaf-${String(leaf).padStart(5, '0')}`
      const item = node(uid, `Fixture leaf ${leaf}`, [], false)
      children.push(item)
      if (branch === 0) visibleLeaves.push(uid)
    }
    branches.push(node(`cp-${runToken}-branch-${branch}`, `Branch ${branch}`, children, branch === 0))
  }
  assert(leaf === FIXTURE_NODE_COUNT - 11, `fixture leaves mismatch ${leaf}`)
  assert(1 + branches.length + leaf === FIXTURE_NODE_COUNT, 'fixture total node count mismatch')
  assert(visibleLeaves.length === FIXTURE_VISIBLE_LEAF_COUNT, 'fixture visible target count mismatch')
  return { tree: node('root', 'MCP collaboration 10k fixture', branches, true), visibleLeaves, visibleBranchUid: `cp-${runToken}-branch-0` }
}

async function createRoom(origin, ownerCookie, roomKey, tree) {
  let response = await requestJson(`${origin}/api/files`, {
    method: 'POST', headers: authHeaders(ownerCookie, origin),
    body: JSON.stringify({ room_key: roomKey, title: `mcp-collab-perf-${variant}` })
  })
  assert(response.response.ok, `测试房间创建失败 HTTP ${response.response.status}: ${response.text.slice(0, 500)}`)
  response = await requestJson(`${origin}/api/files/${encodeURIComponent(roomKey)}/replace`, {
    method: 'POST', headers: authHeaders(ownerCookie, origin),
    body: JSON.stringify({ tree, client_id: `mcp-collab-seed-${runToken}`, operation_id: randomUUID(), allowFullTree: true })
  })
  assert(response.response.ok, `万节点 fixture 初始化失败 HTTP ${response.response.status}: ${response.text.slice(0, 1000)}`)
  return { response: response.data, requestBytes: Buffer.byteLength(JSON.stringify({ tree })) }
}

async function addRunMembers(dbName, roomKey, owner, members) {
  const { Pool } = pgModule()
  const pool = new Pool({ ...PG, database: dbName, max: 1, connectionTimeoutMillis: 5000 })
  try {
    const identity = await pool.query('select current_database() as database,current_user as username')
    assert(identity.rows[0].database === dbName && identity.rows[0].username === PG.user, 'ACL fixture DB identity mismatch')
    const inserted = []
    for (const member of members) {
      if (member.userId === owner.userId) continue
      const result = await pool.query(
        `insert into room_members(room_key,user_id,role,direct_role,source,created_at,updated_at)
         values($1,$2,'editor','editor','direct_share',now(),now())
         on conflict(room_key,user_id) do nothing`, [roomKey, member.userId]
      )
      inserted.push({ userId: member.userId, inserted: result.rowCount === 1 })
    }
    const rows = await pool.query('select user_id,role,source from room_members where room_key=$1 order by user_id', [roomKey])
    assert(rows.rowCount === BROWSER_CLIENTS, `room_members 应有 ${BROWSER_CLIENTS} 个独立用户，实际 ${rows.rowCount}`)
    assert(rows.rows.every(row => row.role === 'owner' || row.role === 'editor'), '测试房间存在非编辑角色')
    return { ownerUserId: owner.userId, users: rows.rows.map(row => ({ userId: row.user_id, role: row.role, source: row.source })), inserted }
  } finally { await pool.end() }
}

function getMindMapSource() {
  return `(() => { const root=document.querySelector('#app');const seen=new Set();const visit=vm=>{if(!vm||seen.has(vm))return null;seen.add(vm);if(vm.mindMap&&vm.mindMap.renderer)return vm.mindMap;for(const child of vm.$children||[]){const found=visit(child);if(found)return found}return null};return visit(root&&root.__vue__) })()`
}

function instrumentationInitScript(runToken) {
  return `(() => {
    const originalInfo=console.info.bind(console);
    console.info=(...args)=>{if(String(args[0]||'').includes('[v2-trace]'))return;originalInfo(...args)};
    window.__COLLAB_V2_TRACE__ = true;
    if (!Array.isArray(window.__V2_TRACE_LOG__)) window.__V2_TRACE_LOG__ = [];
    const trace = window.__cpTrace = { rendered: [], input: [], submit: [], ack: [], superseded: [], nodeEditEvents: [],
      editorEvents: [], inputEvents: [], firstKeyEvents: [], longTasks: [], longTaskCount: 0, longTaskTotalMs: 0, longTaskMaxMs: 0,
      longTaskObserverSupported: false, longTaskObserverError: null, observerErrors: 0, renderCompleteEvents: 0 };
    const traceCapture = window.__cpTraceCapture = {
      sequence: 0, wrappedLog: null, wrapCount: 0, logReplacements: 0,
      ringCapacity: 400, ringEvictions: 0, observedRows: 0, matchedSubmitRows: 0,
      matchedOutboxRows: 0, matchedAckRows: 0, mismatchedAcks: 0, hookErrors: 0
    };
    const pushBounded = (rows, row, capacity = 1000) => {
      rows.push(row);
      if (rows.length > capacity) rows.splice(0, rows.length - capacity);
    };
    const pageNow = () => performance.now();
    const pageEpoch = at => Number(performance.timeOrigin || (Date.now() - pageNow())) + Number(at);
    const visibleElement = element => {
      if (!element || !element.isConnected) return false;
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0;
    };
    const readEditorText = element => String(element && (element.innerText || element.textContent) || '').trim();
    const editorSelector = '.smm-richtext-node-edit-wrap .ql-editor,.smm-node-edit-wrap[contenteditable],.smm-richtext-node-edit-wrap[contenteditable]';
    const activeEditBinding = () => {
      const mm = window.__perfRepairMindMap;
      const rich = mm && mm.richText;
      if (rich && rich.showTextEdit && rich.node) return { node: rich.node, kind: 'richText' };
      const textEdit = mm && mm.renderer && mm.renderer.textEdit;
      const node = textEdit && (typeof textEdit.getCurrentEditNode === 'function' ? textEdit.getCurrentEditNode() : textEdit.currentNode);
      return node ? { node, kind: 'plainText' } : { node: null, kind: null };
    };
    const inspectEditorSession = () => {
      const binding = activeEditBinding();
      const boundUid = binding.node && binding.node.getData ? String(binding.node.getData('uid') || '') : null;
      const editors = Array.from(document.querySelectorAll(editorSelector)).map(element => ({
        className: String(element.className || ''), visible: visibleElement(element),
        focused: document.activeElement === element || !!(element.contains && element.contains(document.activeElement)),
        width: Math.round(element.getBoundingClientRect().width), height: Math.round(element.getBoundingClientRect().height),
        text: readEditorText(element).slice(0, 120)
      }));
      const visible = editors.some(item => item.visible);
    const latestShow = (trace.nodeEditEvents || []).slice().reverse().find(item => item.kind === 'before_show_text_edit');
      const latestHide = (trace.nodeEditEvents || []).slice().reverse().find(item => item.kind === 'hide_text_edit');
      return { visible, boundUid, bindingKind: binding.kind, bindingVerified: !!(visible && boundUid &&
        (latestShow && latestShow.uid === boundUid || binding.kind === 'richText' || binding.kind === 'plainText')),
        lastShownUid: latestShow && latestShow.uid || null, lastShownToken: latestShow && latestShow.token || null,
        lastHideUid: latestHide && latestHide.uid || null, lastHideToken: latestHide && latestHide.token || null, editors };
    };
    window.__cpInspectEditorSession = inspectEditorSession;
    window.__cpEditorObservations = window.__cpEditorObservations || {};
    window.__cpFirstKeyObservations = window.__cpFirstKeyObservations || {};
    trace.queueSamples = [];
    try {
      if (typeof PerformanceObserver === 'function') {
        const longTaskObserver = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            const start = Number(entry.startTime || 0);
            const duration = Number(entry.duration || 0);
            trace.longTaskCount += 1;
            trace.longTaskTotalMs += duration;
            trace.longTaskMaxMs = Math.max(trace.longTaskMaxMs, duration);
            pushBounded(trace.longTasks, { startTimeMs: start, endTimeMs: start + duration, durationMs: duration,
              startEpochMs: pageEpoch(start), name: String(entry.name || 'longtask') }, 500);
          }
        });
        longTaskObserver.observe({ entryTypes: ['longtask'] });
        window.__cpLongTaskObserver = longTaskObserver;
        trace.longTaskObserverSupported = true;
      }
    } catch (error) {
      trace.longTaskObserverError = String(error && error.message || error);
    }
    const captureTraceRow = row => {
      try {
        if (!row || typeof row !== 'object') return;
        const stage=String(row.stage||'');
        const traceId=String(row.traceId||'');
        const eventAt=Number(row.t||Date.now());
        const pending=window.__cpPendingWriters||[];
        if(stage==='2.adapter.submit'&&traceId&&Array.isArray(row.uids)){
          const uids=row.uids.map(String);
          let item=null;
          for(const candidate of pending){
            const issuedAt=Number(candidate&&candidate.issuedAt||0);
            if(candidate&&!candidate.traceId&&uids.includes(String(candidate.uid))&&eventAt>=issuedAt-5&&eventAt-issuedAt<=60000&&
              (!item||issuedAt>Number(item.issuedAt||0)))item=candidate;
          }
          if(item){
            item.traceId=traceId;item.submittedAt=eventAt;item.traceSequence=traceCapture.sequence;
            trace.submit.push({token:item.token,uid:item.uid,traceId:item.traceId,operationId:null,submitObserved:true,submittedAt:item.submittedAt,outboxAt:null,phase:item.phase});
            traceCapture.matchedSubmitRows+=1;
          }
          return;
        }
        if(stage==='3.outbox.put'&&traceId&&row.opId){
          const item=pending.find(candidate=>candidate&&candidate.traceId===traceId&&!candidate.submitOpId);
          if(item){
            item.submitOpId=String(row.opId);item.outboxAt=eventAt;
            const submitRecord=trace.submit.find(candidate=>candidate.token===item.token&&candidate.uid===item.uid&&candidate.traceId===item.traceId);
            if(submitRecord){submitRecord.operationId=item.submitOpId;submitRecord.outboxAt=item.outboxAt;submitRecord.outboxObserved=true;}
            traceCapture.matchedOutboxRows+=1;
          }
          return;
        }
        if((stage==='8.ack'||stage==='8.ack.fail')&&traceId){
          const item=pending.find(candidate=>candidate&&candidate.traceId===traceId&&candidate.submitOpId&&!candidate.ack);
          if(!item)return;
          if(stage==='8.ack'&&String(row.opId||'')!==String(item.submitOpId)){
            item.ackMismatch={traceId,operationId:row.opId==null?null:String(row.opId)};
            traceCapture.mismatchedAcks+=1;
            return;
          }
          item.ack=true;
          trace.ack.push({token:item.token,uid:item.uid,issuedAt:item.issuedAt,phase:item.phase,submittedAt:item.submittedAt,
            ackMs:Math.max(0,eventAt-Number(item.submittedAt||item.issuedAt)),ackFromInputMs:Math.max(0,eventAt-item.issuedAt),ackEpochMs:eventAt,
            traceId:item.traceId,operationId:item.submitOpId,ackOperationId:row.opId==null?null:String(row.opId),
            correlationKind:stage==='8.ack'?'trace_id_and_operation_id':'trace_id_with_outbox_operation_id',
            revision:row.revision||null,traceStage:stage,status:stage==='8.ack'?'acked':'rejected',code:row.code||null,message:row.message||null});
          traceCapture.matchedAckRows+=1;
        }
      } catch (_) { traceCapture.hookErrors+=1; }
    };
    window.__cpInstallV2TraceCapture = () => {
      const log=window.__V2_TRACE_LOG__;
      if(!Array.isArray(log))return false;
      if(log.__cpPerfWrapped)return true;
      if(traceCapture.wrappedLog&&traceCapture.wrappedLog!==log){
        traceCapture.logReplacements+=1;
        for(const item of window.__cpPendingWriters||[])if(item&&!item.ack)item.traceLostReason='v2_trace_log_replaced';
      }
      traceCapture.wrappedLog=log;traceCapture.wrapCount+=1;
      const arrayPush=Array.prototype.push;
      log.push=function(...rows){
        const before=this.length;
        const result=arrayPush.apply(this,rows);
        traceCapture.sequence+=rows.length;traceCapture.observedRows+=rows.length;
        traceCapture.ringEvictions+=Math.max(0,before+rows.length-traceCapture.ringCapacity);
        for(const row of rows)captureTraceRow(row);
        return result;
      };
      Object.defineProperty(log,'__cpPerfWrapped',{value:true,enumerable:false,configurable:false});
      return true;
    };
    window.__cpInstallV2TraceCapture();
    window.__cpReadNodePlainText = node => {
      if (!node || typeof node.getData !== 'function') return '';
      const value=String(node.getData('text')||'');
      if(!node.getData('richText'))return value.trim();
      const wrapper=document.createElement('div');wrapper.innerHTML=value;
      return String(wrapper.innerText||wrapper.textContent||'').trim();
    };
    window.__cpExpectedByUid = {};
    window.__cpRoundExpected = {};
    window.__cpRoundWatchUids = [];
    window.__cpInstallRenderCompleteHook = () => {
      const mm=window.__perfRepairMindMap;
      if(!mm||!mm.renderer||typeof mm.on!=='function'||window.__cpRenderHookInstalled)return false;
      window.__cpRenderHookInstalled=true;
      mm.on('render_complete', event => {
        trace.renderCompleteEvents+=1;
        const renderer=mm.renderer;
        requestAnimationFrame(()=>requestAnimationFrame(()=>{
          try {
            const adapter=mm.cooperate&&mm.cooperate.collabV2Adapter;
            const status=adapter&&adapter.getStatus&&adapter.getStatus();
            const version=Number.isFinite(Number(status&&status.lastServerRevision))?Number(status.lastServerRevision):null;
            for(const uid of window.__cpRoundWatchUids){
              const node=renderer.findNodeByUid(uid);
              const text=window.__cpReadNodePlainText(node);
              const item=window.__cpRoundExpected[text];
              if(!item||item.completed||item.uid!==uid)continue;
              const domNode=document.querySelector('.smm-node[data-node-uid="'+uid+'"]');
              if(domNode&&(domNode.innerText||domNode.textContent||'').includes(text)&&renderer.isRendering===false){
                item.completed=true;
                trace.rendered.push({token:item.token,uid,source:item.source,writer:item.writer,issuedAt:item.issuedAt,phase:item.phase,version,eventVersion:event&&event.version||null,epochMs:performance.timeOrigin+performance.now(),relativeMs:performance.now(),renderComplete:true,stable:true});
              }
            }
            for(const item of Object.values(window.__cpExpectedByUid)){
              if(item.completed||Date.now()-Number(item.issuedAt||0)>15000){delete window.__cpExpectedByUid[item.uid];continue;}
              if(!item.versionFloor||version===null||version<item.versionFloor)continue;
              const node=renderer.findNodeByUid(item.uid);
              const dataText=window.__cpReadNodePlainText(node);
         const domNode=Array.from(document.querySelectorAll('.smm-node[data-node-uid]')).find(el=>el.getAttribute('data-node-uid')===item.uid);
         const domHasText=!!domNode&&(domNode.innerText||domNode.textContent||'').includes(item.text);
              if(dataText===item.text&&domHasText&&renderer.isRendering===false){
                item.completed=true;
                trace.rendered.push({token:item.token,uid:item.uid,source:item.source,writer:item.writer,issuedAt:item.issuedAt,phase:item.phase,version,eventVersion:event&&event.version||null,epochMs:performance.timeOrigin+performance.now(),relativeMs:performance.now(),renderComplete:true,stable:true});
                delete window.__cpExpectedByUid[item.uid];
              }
            }
          }catch(_){trace.observerErrors+=1}
        }));
      });
      return true;
    };
    window.__cpRegisterExpected = item => {
      const old=window.__cpExpectedByUid[item.uid];
      if(old&&!old.completed)trace.superseded.push({token:old.token,by:item.token,uid:item.uid,at:Date.now()});
      window.__cpExpectedByUid[item.uid]=item;
      window.__cpInstallRenderCompleteHook();
    };
    window.__cpInstallWriterWatch = (uid,text,token,issuedAt,phase) => {
      const pendingRows=window.__cpPendingWriters=window.__cpPendingWriters||[];
      const existing=pendingRows.find(item=>item&&item.token===token);
      if(existing)return existing;
      const mm=window.__perfRepairMindMap;
      window.__cpInstallRenderCompleteHook();
      const adapter=mm.cooperate&&mm.cooperate.collabV2Adapter;const status=adapter&&adapter.getStatus&&adapter.getStatus();
      const revisionBefore=Number(status&&status.lastServerRevision||0);const start=performance.now();
      const pending={uid:String(uid),text,token,issuedAt,phase,start,watchInstalledAtEpochMs:pageEpoch(start),revisionBefore,
        rendererAssociation:'pending_by_uid',firstInputAtPerfMs:null,local:false,ack:false,traceId:null,submitOpId:null,submittedAt:null,ackMismatch:null};
      pendingRows.push(pending);
      return pending;
    };
    window.__cpBeginEditorObservation = (token,uid) => {
      const at=pageNow();
      const observation={token:String(token),uid:String(uid),startedAtPerfMs:at,startedAtEpochMs:pageEpoch(at),
        dblclickAtPerfMs:null,beforeShowAtPerfMs:null,editorVisibleAtPerfMs:null,editorVisibleFrameAtPerfMs:null,
        visibilityDeadlinePerfMs:at+5000,complete:false};
      window.__cpEditorObservations[token]=observation;
      window.__cpActiveEditorObservation=observation;
      return observation;
    };
    window.__cpReadEditorObservation = token => {
      const item=window.__cpEditorObservations[String(token)];
      if(!item)return null;
      const delta=(end,start)=>Number.isFinite(end)&&Number.isFinite(start)?Math.max(0,end-start):null;
      return {...item,
        doubleClickToBeforeShowMs:delta(item.beforeShowAtPerfMs,item.dblclickAtPerfMs),
        beforeShowToEditorVisibleMs:delta(item.editorVisibleAtPerfMs,item.beforeShowAtPerfMs),
        doubleClickToEditorVisibleMs:delta(item.editorVisibleAtPerfMs,item.dblclickAtPerfMs),
        doubleClickToVisibleFrameMs:delta(item.editorVisibleFrameAtPerfMs,item.dblclickAtPerfMs)};
    };
    window.__cpFirstKeyHandles = window.__cpFirstKeyHandles || {};
    const clearFirstKeyHandles = token => {
      const handles=window.__cpFirstKeyHandles[String(token)];
      if(!handles)return;
      if(handles.observer)handles.observer.disconnect();
      if(handles.quill&&handles.quillListener&&typeof handles.quill.off==='function')handles.quill.off('text-change',handles.quillListener);
      if(handles.timer)clearTimeout(handles.timer);
      delete window.__cpFirstKeyHandles[String(token)];
    };
    const startFirstKeyRafEcho = (item,target) => {
      if(item.rafPairScheduled||item.complete)return;
      item.rafPairScheduled=true;
      requestAnimationFrame(()=>{
        const raf1At=pageNow();const raf1Text=readEditorText(target);const raf1Match=raf1Text===item.expectedText;
        pushBounded(trace.firstKeyEvents,{kind:'raf1',token:item.token,uid:item.uid,text:raf1Text,
          echoMatches:raf1Match,atPerfMs:raf1At,atEpochMs:pageEpoch(raf1At)},2000);
        requestAnimationFrame(()=>{
          const raf2At=pageNow();const raf2Text=readEditorText(target);const raf2Match=raf2Text===item.expectedText;
          pushBounded(trace.firstKeyEvents,{kind:'raf2',token:item.token,uid:item.uid,text:raf2Text,
            echoMatches:raf2Match,atPerfMs:raf2At,atEpochMs:pageEpoch(raf2At)},2000);
          if(raf1Match&&raf2Match){
            item.raf1AtPerfMs=raf1At;item.raf1AtEpochMs=pageEpoch(raf1At);item.raf1Text=raf1Text;item.raf1EchoMatches=true;
            item.raf2AtPerfMs=raf2At;item.raf2AtEpochMs=pageEpoch(raf2At);item.raf2Text=raf2Text;item.raf2EchoMatches=true;
            item.complete=true;item.rafPairScheduled=false;clearFirstKeyHandles(item.token);return;
          }
          item.rafPairScheduled=false;
          if(raf2At-item.armedAtPerfMs<5000)startFirstKeyRafEcho(item,target);
          else {item.echoTimedOut=true;clearFirstKeyHandles(item.token)}
        });
      });
    };
    const recordFirstKeyFeedback = (item,source,target,at=pageNow()) => {
      const actualText=readEditorText(target);
      if(actualText!==item.expectedText)return false;
      if(!item.feedbackSources.includes(source))item.feedbackSources.push(source);
      if(item.feedbackAtPerfMs===null){
        item.feedbackSource=source;item.feedbackAtPerfMs=at;item.feedbackAtEpochMs=pageEpoch(at);item.feedbackText=actualText;
      }
      if(source==='native_input'&&item.nativeInputFeedbackAtPerfMs===null){
        item.nativeInputFeedbackAtPerfMs=at;item.nativeInputFeedbackAtEpochMs=pageEpoch(at);
      }
      if(!item.rafPairScheduled&&!item.complete)startFirstKeyRafEcho(item,target);
      return true;
    };
    window.__cpArmFirstKeyObservation = (token,uid,expectedText) => {
      const previous=window.__cpActiveFirstKeyObservation;
      if(previous&&!previous.complete)clearFirstKeyHandles(previous.token);
      const at=pageNow();
      const observation={token:String(token),uid:String(uid),expectedText:String(expectedText||''),armedAtPerfMs:at,
        armedAtEpochMs:pageEpoch(at),keydownAtPerfMs:null,beforeInputAtPerfMs:null,inputAtPerfMs:null,
        nativeInputFeedbackAtPerfMs:null,quillTextChangeAtPerfMs:null,domMutationAtPerfMs:null,
        feedbackAtPerfMs:null,feedbackSource:null,feedbackSources:[],feedbackText:null,
        raf1AtPerfMs:null,raf2AtPerfMs:null,raf1EchoMatches:false,raf2EchoMatches:false,complete:false};
      window.__cpFirstKeyObservations[token]=observation;
      window.__cpActiveFirstKeyObservation=observation;
      const pending=(window.__cpPendingWriters||[]).find(item=>item&&item.token===token);
      if(pending)pending.firstKeyArmedAtPerfMs=at;
      const mm=window.__perfRepairMindMap;const rich=mm&&mm.richText;const richNode=rich&&rich.node;
      const richUid=richNode&&richNode.getData?String(richNode.getData('uid')||''):'';
      const quill=richUid===String(uid)&&rich&&rich.quill&&typeof rich.quill.on==='function'?rich.quill:null;
      const target=quill&&quill.root||Array.from(document.querySelectorAll(editorSelector)).find(visibleElement)||null;
      const handles={quill,quillListener:null,observer:null,timer:null};
      if(quill){
        handles.quillListener=()=>{
          const changeAt=pageNow();const quillText=readEditorText(quill.root);
          if(quillText===observation.expectedText&&observation.quillTextChangeAtPerfMs===null){
            observation.quillTextChangeAtPerfMs=changeAt;observation.quillTextChangeAtEpochMs=pageEpoch(changeAt);
            pushBounded(trace.firstKeyEvents,{kind:'quill_text_change',token:observation.token,uid:observation.uid,
              text:quillText,atPerfMs:changeAt,atEpochMs:pageEpoch(changeAt)},2000);
          }
          recordFirstKeyFeedback(observation,'quill_text_change',quill.root,changeAt);
        };
        quill.on('text-change',handles.quillListener);
      }
      try{
        if(typeof MutationObserver==='function'&&target){
          handles.observer=new MutationObserver(()=>{
            const mutationAt=pageNow();const mutationText=readEditorText(target);
            if(mutationText===observation.expectedText&&observation.domMutationAtPerfMs===null){
              observation.domMutationAtPerfMs=mutationAt;observation.domMutationAtEpochMs=pageEpoch(mutationAt);
              pushBounded(trace.firstKeyEvents,{kind:'dom_mutation',token:observation.token,uid:observation.uid,
                text:mutationText,atPerfMs:mutationAt,atEpochMs:pageEpoch(mutationAt)},2000);
            }
            recordFirstKeyFeedback(observation,'dom_mutation',target,mutationAt);
          });
          handles.observer.observe(target,{subtree:true,childList:true,characterData:true});
        }
      }catch(error){observation.domMutationObserverError=String(error&&error.message||error)}
      window.__cpFirstKeyHandles[String(token)]=handles;
      handles.timer=setTimeout(()=>clearFirstKeyHandles(token),6000);
      return observation;
    };
    window.__cpClearFirstKeyObservation = token => {
      clearFirstKeyHandles(token);
      const active=window.__cpActiveFirstKeyObservation;
      if(active&&active.token===String(token))window.__cpActiveFirstKeyObservation=null;
    };
    window.__cpReadFirstKeyObservation = token => {
      const item=window.__cpFirstKeyObservations[String(token)];
      if(!item)return null;
      const delta=(end,start)=>Number.isFinite(end)&&Number.isFinite(start)?Math.max(0,end-start):null;
      return {...item,
        keydownToInputMs:delta(item.inputAtPerfMs,item.keydownAtPerfMs),
        inputToRaf1Ms:delta(item.raf1AtPerfMs,item.inputAtPerfMs),
        inputToRaf2Ms:delta(item.raf2AtPerfMs,item.inputAtPerfMs),
        keydownToRaf2Ms:delta(item.raf2AtPerfMs,item.keydownAtPerfMs),
        feedbackToRaf1Ms:delta(item.raf1AtPerfMs,item.feedbackAtPerfMs),
        feedbackToRaf2Ms:delta(item.raf2AtPerfMs,item.feedbackAtPerfMs)};
    };
    const editorTarget = target => target && target.closest && target.closest(editorSelector);
    document.addEventListener('dblclick',event=>{
      const target=event.target&&event.target.closest&&event.target.closest('.smm-node[data-node-uid]');
      const observation=window.__cpActiveEditorObservation;
      if(!target||!observation||String(target.getAttribute('data-node-uid')||'')!==observation.uid)return;
      const at=pageNow();observation.dblclickAtPerfMs=at;observation.dblclickAtEpochMs=pageEpoch(at);
      pushBounded(trace.editorEvents,{kind:'dblclick',uid:observation.uid,token:observation.token,
        atPerfMs:at,atEpochMs:pageEpoch(at),targetClass:String(event.target.className||'')},2000);
    },true);
    document.addEventListener('focusin',event=>{
      if(!editorTarget(event.target))return;
      const at=pageNow();const active=window.__cpActiveEditorObservation;
      pushBounded(trace.editorEvents,{kind:'focusin',uid:active&&active.uid||null,token:active&&active.token||null,
        atPerfMs:at,atEpochMs:pageEpoch(at),targetClass:String(event.target.className||'')},2000);
    },true);
    document.addEventListener('focusout',event=>{
      if(!editorTarget(event.target))return;
      const at=pageNow();const active=window.__cpActiveEditorObservation;
      pushBounded(trace.editorEvents,{kind:'focusout',uid:active&&active.uid||null,token:active&&active.token||null,
        atPerfMs:at,atEpochMs:pageEpoch(at),targetClass:String(event.target.className||'')},2000);
    },true);
    document.addEventListener('keydown',event=>{
      const item=window.__cpActiveFirstKeyObservation;
      if(!item||item.complete||item.keydownAtPerfMs!==null||!editorTarget(event.target))return;
      if(['Shift','Control','Alt','Meta'].includes(String(event.key||'')))return;
      item.keydownAtPerfMs=pageNow();item.keydownAtEpochMs=pageEpoch(item.keydownAtPerfMs);item.key=String(event.key||'');
      pushBounded(trace.firstKeyEvents,{kind:'keydown',token:item.token,uid:item.uid,key:item.key,
        atPerfMs:item.keydownAtPerfMs,atEpochMs:item.keydownAtEpochMs},2000);
    },true);
    document.addEventListener('beforeinput',event=>{
      const item=window.__cpActiveFirstKeyObservation;
      if(!item||item.complete||item.beforeInputAtPerfMs!==null||!editorTarget(event.target))return;
      item.beforeInputAtPerfMs=pageNow();item.beforeInputAtEpochMs=pageEpoch(item.beforeInputAtPerfMs);
      item.inputType=String(event.inputType||'');item.beforeInputData=event.data==null?null:String(event.data);
      pushBounded(trace.firstKeyEvents,{kind:'beforeinput',token:item.token,uid:item.uid,inputType:item.inputType,
        data:item.beforeInputData,atPerfMs:item.beforeInputAtPerfMs,atEpochMs:item.beforeInputAtEpochMs},2000);
    },true);
    document.addEventListener('input',event=>{
      if(!editorTarget(event.target))return;
      const at=pageNow();const active=window.__cpActiveFirstKeyObservation;
      const pending=active&&(window.__cpPendingWriters||[]).find(item=>item&&item.token===active.token);
      pushBounded(trace.inputEvents,{token:active&&active.token||null,uid:active&&active.uid||null,
        inputType:String(event.inputType||''),data:event.data==null?null:String(event.data),atPerfMs:at,atEpochMs:pageEpoch(at),
        text:readEditorText(event.target).slice(0,120)},2000);
      if(!active||active.complete)return;
      if(active.inputAtPerfMs===null){
        active.inputAtPerfMs=at;active.inputAtEpochMs=pageEpoch(at);
        active.inputType=String(event.inputType||active.inputType||'');
        active.inputData=event.data==null?null:String(event.data);
        active.inputText=readEditorText(event.target);
        if(pending)pending.firstInputAtPerfMs=at;
      }
      recordFirstKeyFeedback(active,'native_input',event.target,at);
    },true);
    window.__cpInstallNodeEditProbe = (uid,token) => {
      const mm=window.__perfRepairMindMap;
      if(!mm||typeof mm.on!=='function')return false;
      window.__cpNodeEditProbeUid=String(uid);
      window.__cpNodeEditProbeToken=String(token||'');
      if(window.__cpNodeEditProbeInstalled)return true;
      window.__cpNodeEditProbeInstalled=true;
      const record=(kind,node,extra={})=>{
        const nodeUid=node&&node.getData&&node.getData('uid');
        if(String(nodeUid||'')!==String(window.__cpNodeEditProbeUid||''))return;
        const at=pageNow();const active=window.__cpActiveEditorObservation;
        const editorNodes=Array.from(document.querySelectorAll('.smm-node-edit-wrap[contenteditable],.smm-richtext-node-edit-wrap,.smm-richtext-node-edit-wrap .ql-editor'));
        const row={kind,uid:String(nodeUid),token:active&&active.uid===String(nodeUid)?active.token:window.__cpNodeEditProbeToken||null,
          at:Date.now(),atPerfMs:at,atEpochMs:pageEpoch(at),readonly:!!mm.opt.readonly,
          richText:!!mm.richText,customContent:!!(node.isUseCustomNodeContent&&node.isUseCustomNodeContent()),
          mapRef:!!(node.getData&&node.getData('mapRef')),editorNodes:editorNodes.map(el=>({
            className:String(el.className||''),contenteditable:el.getAttribute('contenteditable'),
            display:getComputedStyle(el).display,visibility:getComputedStyle(el).visibility,
            width:Math.round(el.getBoundingClientRect().width),height:Math.round(el.getBoundingClientRect().height)
          })),...extra};
        pushBounded(trace.nodeEditEvents,row,2000);
        if(kind==='before_show_text_edit'){
          const observation=window.__cpActiveEditorObservation;
          if(observation&&observation.uid===String(nodeUid)){
            observation.beforeShowAtPerfMs=at;observation.beforeShowAtEpochMs=pageEpoch(at);
            const deadline=observation.visibilityDeadlinePerfMs;
            const pollVisible=()=>{
              if(observation.complete||observation.editorVisibleFrameAtPerfMs!==null)return;
              const now=pageNow();const session=inspectEditorSession();
              if(session.visible&&session.boundUid===observation.uid){
                if(observation.editorVisibleAtPerfMs===null){observation.editorVisibleAtPerfMs=now;observation.editorVisibleAtEpochMs=pageEpoch(now)}
                requestAnimationFrame(()=>{
                  const frameAt=pageNow();const frameSession=inspectEditorSession();
                  if(frameSession.visible&&frameSession.boundUid===observation.uid){
                    observation.editorVisibleFrameAtPerfMs=frameAt;observation.editorVisibleFrameAtEpochMs=pageEpoch(frameAt);observation.complete=true;
                  }else if(frameAt<deadline)requestAnimationFrame(pollVisible);
                });
                return;
              }
              if(now<deadline)requestAnimationFrame(pollVisible);
              else observation.visibilityTimedOut=true;
            };
            queueMicrotask(pollVisible);
          }
        }
      };
      mm.on('node_dblclick',(node,event)=>record('node_dblclick',node,{ctrlKey:!!(event&&event.ctrlKey),metaKey:!!(event&&event.metaKey)}));
      mm.on('before_show_text_edit',node=>record('before_show_text_edit',node));
      mm.on('hide_text_edit',(_editor,_nodes,node)=>record('hide_text_edit',node));
      mm.on('map_ref_click',(node)=>record('map_ref_click',node));
      mm.on('collab_lock_denied',(peer)=>trace.nodeEditEvents.push({kind:'collab_lock_denied',uid:String(window.__cpNodeEditProbeUid||''),at:Date.now(),peerClientId:peer&&peer.clientId||null,peerEditingUid:peer&&peer.editingUid||null}));
      return true;
    };
    window.__cpWriterTick = () => {
      const pending=window.__cpPendingWriters||[];const now=performance.now();const mm=window.__perfRepairMindMap;
      window.__cpInstallV2TraceCapture&&window.__cpInstallV2TraceCapture();
      for(const [uid,item] of Object.entries(window.__cpExpectedByUid||{}))if(item.completed||Date.now()-Number(item.issuedAt||0)>15000)delete window.__cpExpectedByUid[uid];
      const renderer=mm&&mm.renderer;const adapter=mm&&mm.cooperate&&mm.cooperate.collabV2Adapter;const status=adapter&&adapter.getStatus&&adapter.getStatus();
      const workload=window.__cpWorkloadWindow;const queueEpoch=pageEpoch(now);
      if(workload&&status&&queueEpoch>=workload.startedAt&&queueEpoch<workload.endedAt&&queueEpoch-Number(window.__cpLastQueueSampleAt||0)>=5000){
        window.__cpLastQueueSampleAt=queueEpoch;
        pushBounded(trace.queueSamples,{at:queueEpoch,phase:queueEpoch<workload.sampleAt?workload.phase+'-warmup':workload.phase,
          currentDepth:Number(status.outboxPending||0),sending:Number(status.outboxSending||0),revision:Number(status.lastServerRevision||0)},1000);
      }
      for(let i=pending.length-1;i>=0;i--){const item=pending[i];const node=renderer&&renderer.isRendering===false?renderer.findNodeByUid(item.uid):null;const text=window.__cpReadNodePlainText(node);
        if(!item.local && node && text===item.text){item.local=true;item.localObservedAtPerfMs=now;trace.input.push({token:item.token,issuedAt:item.issuedAt,phase:item.phase,
          localMs:now-Number(item.firstInputAtPerfMs||item.start),localFromFirstInput:item.firstInputAtPerfMs!==null,
          localEpochMs:performance.timeOrigin+now,status:'rendered',rendererAssociation:item.rendererAssociation})}
        if(now-item.start>60000){if(!item.local)trace.input.push({token:item.token,issuedAt:item.issuedAt,phase:item.phase,localMs:Math.min(60000,now-item.start),localEpochMs:performance.timeOrigin+now,status:'timeout'});if(!item.ack){const timeoutAt=performance.timeOrigin+now;trace.ack.push({token:item.token,uid:item.uid,issuedAt:item.issuedAt,phase:item.phase,submittedAt:item.submittedAt,ackMs:item.submittedAt?Math.max(0,timeoutAt-item.submittedAt):60000,ackFromInputMs:Math.min(60000,now-item.start),ackEpochMs:timeoutAt,traceId:item.traceId,operationId:item.submitOpId,ackOperationId:item.ackMismatch&&item.ackMismatch.operationId||null,traceStage:item.traceLostReason|| (item.ackMismatch?'ack_op_id_mismatch':item.traceId&&item.submitOpId?'missing_ack_trace':'missing_submit_trace'),status:'timeout'})}pending.splice(i,1)}
        else if(item.local&&item.ack)pending.splice(i,1)
      }
    };
    setInterval(()=>window.__cpWriterTick&&window.__cpWriterTick(),25);
    window.__cpFinalizePending = () => {
      const pending=window.__cpPendingWriters||[];const now=performance.now();
      for(const item of pending){
        if(!item.local)trace.input.push({token:item.token,issuedAt:item.issuedAt,phase:item.phase,localMs:Math.min(60000,now-item.start),localEpochMs:performance.timeOrigin+now,status:'unfinished_deadline'});
        if(!item.ack){const deadlineAt=performance.timeOrigin+now;trace.ack.push({token:item.token,uid:item.uid,issuedAt:item.issuedAt,phase:item.phase,submittedAt:item.submittedAt,ackMs:item.submittedAt?Math.max(0,deadlineAt-item.submittedAt):Math.min(60000,now-item.start),ackFromInputMs:Math.min(60000,now-item.start),ackEpochMs:deadlineAt,traceId:item.traceId,operationId:item.submitOpId,ackOperationId:item.ackMismatch&&item.ackMismatch.operationId||null,traceStage:item.traceLostReason|| (item.ackMismatch?'ack_op_id_mismatch':item.traceId&&item.submitOpId?'missing_ack_trace':'missing_submit_trace'),status:'unfinished_deadline'})}
      }
      pending.length=0;
      const rowCounts={};for(const key of ['rendered','input','submit','ack','superseded','nodeEditEvents','editorEvents','inputEvents','firstKeyEvents','longTasks'])rowCounts[key]=Array.isArray(trace[key])?trace[key].length:0;
      trace.captureTelemetry={...traceCapture,ringRowsAtCollection:(window.__V2_TRACE_LOG__||[]).length,traceArrayRowCounts:rowCounts,
        longTaskCount:trace.longTaskCount,longTaskTotalMs:trace.longTaskTotalMs,longTaskMaxMs:trace.longTaskMaxMs,
        longTaskObserverSupported:trace.longTaskObserverSupported,longTaskObserverError:trace.longTaskObserverError,
        estimatedSerializedBytes:JSON.stringify(trace).length,measurementNote:'Page-local performance.now/timeOrigin captures UI input, editor visibility, long tasks, and bounded V2 operation correlation; transient renderer roots are associated by UID and read only when renderer.isRendering=false.'};
    };
  })();`
}

function runTraceHookSelfTest() {
  const createWindow = () => {
    const window = { __V2_TRACE_LOG__: [] }
    vm.runInNewContext(instrumentationInitScript('trace-hook-self-test'), {
      window,
      document: { addEventListener() {}, querySelectorAll() { return [] } },
      setInterval: () => ({ unref() {} }),
      performance
    }, { timeout: 1000 })
    return window
  }
  const pushRingRow = (window, row) => {
    window.__V2_TRACE_LOG__.push(row)
    if (window.__V2_TRACE_LOG__.length > 400) window.__V2_TRACE_LOG__.shift()
  }
  const pending = (uid, token, issuedAt) => ({ uid, token, issuedAt, phase: 'synthetic', start: 0, ack: false })
  const operation = (window, item, { ackStage = '8.ack', ackOperationId, omitSubmit = false } = {}) => {
    window.__cpPendingWriters = [item]
    const traceId = `trace-${item.token}`
    if (!omitSubmit) {
      pushRingRow(window, { stage: '2.adapter.submit', traceId, uids: [item.uid], t: item.issuedAt + 1 })
      pushRingRow(window, { stage: '3.outbox.put', traceId, opId: `op-${item.token}`, t: item.issuedAt + 2 })
    }
    if (ackStage) pushRingRow(window, { stage: ackStage, traceId, opId: ackOperationId || `op-${item.token}`, code: 'SYNTHETIC_REJECT', t: item.issuedAt + 3 })
    window.__cpFinalizePending()
    return { trace: window.__cpTrace, capture: window.__cpTraceCapture }
  }

  const ringWindow = createWindow()
  for (let index = 0; index < 450; index += 1) pushRingRow(ringWindow, { stage: 'noise', t: 10000 + index })
  const ringResult = operation(ringWindow, pending('uid-ring', 'ring', 20000))
  assert(ringResult.trace.ack.length === 1 && ringResult.trace.ack[0].status === 'acked' &&
    ringResult.trace.ack[0].traceId === 'trace-ring' && ringResult.trace.ack[0].operationId === 'op-ring',
  'trace hook failed to correlate submit→outbox→ACK after the 400-row V2 ring wrapped')
  assert(ringResult.capture.ringEvictions >= 50, 'synthetic ring did not record the expected retention evictions')

  const rejected = operation(createWindow(), pending('uid-rejected', 'rejected', 30000), { ackStage: '8.ack.fail' })
  assert(rejected.trace.ack.length === 1 && rejected.trace.ack[0].status === 'rejected' &&
    rejected.trace.ack[0].traceStage === '8.ack.fail' && rejected.trace.ack[0].operationId === 'op-rejected',
  'trace hook did not correlate an ACK.fail rejection with its outbox operation')

  const mismatchWindow = createWindow()
  const mismatch = pending('uid-mismatch', 'mismatch', 40000)
  mismatchWindow.__cpPendingWriters = [mismatch]
  pushRingRow(mismatchWindow, { stage: '2.adapter.submit', traceId: 'trace-mismatch', uids: [mismatch.uid], t: mismatch.issuedAt + 1 })
  pushRingRow(mismatchWindow, { stage: '3.outbox.put', traceId: 'trace-mismatch', opId: 'op-mismatch', t: mismatch.issuedAt + 2 })
  pushRingRow(mismatchWindow, { stage: '8.ack', traceId: 'trace-mismatch', opId: 'wrong-op-id', t: mismatch.issuedAt + 3 })
  mismatchWindow.__cpFinalizePending()
  assert(mismatchWindow.__cpTrace.ack.length === 1 && mismatchWindow.__cpTrace.ack[0].status === 'unfinished_deadline' &&
    mismatchWindow.__cpTrace.ack[0].traceStage === 'ack_op_id_mismatch' && mismatchWindow.__cpTraceCapture.mismatchedAcks === 1,
  'trace hook accepted or hid an ACK with the wrong operation id')

  const missing = operation(createWindow(), pending('uid-missing', 'missing', 50000), { ackStage: null, omitSubmit: true })
  assert(missing.trace.ack.length === 1 && missing.trace.ack[0].status === 'unfinished_deadline' &&
    missing.trace.ack[0].traceStage === 'missing_submit_trace',
  'trace hook did not explicitly preserve a write with an unobserved submit trace')

  const replacedWindow = createWindow()
  replacedWindow.__cpPendingWriters = [pending('uid-replaced', 'replaced', 60000)]
  replacedWindow.__V2_TRACE_LOG__ = []
  replacedWindow.__cpInstallV2TraceCapture()
  replacedWindow.__cpFinalizePending()
  assert(replacedWindow.__cpTrace.ack[0].traceStage === 'v2_trace_log_replaced' &&
    replacedWindow.__cpTraceCapture.logReplacements === 1,
  'trace hook did not expose a replaced V2 trace buffer as a missing-observation reason')

  return {
    status: 'pass',
    checks: [
      { name: 'correlate after 400-row ring wraps', status: 'pass', ringRows: ringResult.trace.captureTelemetry.ringRowsAtCollection, ringEvictions: ringResult.capture.ringEvictions },
      { name: 'correlate ACK.fail rejection', status: 'pass', statusValue: rejected.trace.ack[0].status },
      { name: 'wrong operation id remains missing', status: 'pass', traceStage: mismatchWindow.__cpTrace.ack[0].traceStage },
      { name: 'missing submit remains missing', status: 'pass', traceStage: missing.trace.ack[0].traceStage },
      { name: 'replaced trace buffer is explicit', status: 'pass', traceStage: replacedWindow.__cpTrace.ack[0].traceStage }
    ],
    retainedTraceRows: ringResult.capture.ringRowsAtCollection,
    note: 'synthetic test retains only pending-write associations; it does not copy the V2 trace history'
  }
}

function runBrowserObservationSelfTest() {
  let now = 10
  let editorVisible = false
  let observedLongTask = null
  const listeners = new Map()
  const mindMapEvents = new Map()
  const mutationObservers = []
  const quillListeners = new Set()
  const nodeData = { uid: 'uid-observation-test', text: '', richText: false }
  const node = { getData(key) { return nodeData[key] }, isUseCustomNodeContent() { return false } }
  const editor = {
    isConnected: true, className: 'ql-editor', innerText: '', textContent: '',
    contains(target) { return target === this },
    closest(selector) { return selector.includes('.smm-richtext-node-edit-wrap') || selector.includes('.smm-node-edit-wrap') ? this : null },
    getAttribute(name) { return name === 'contenteditable' ? 'true' : null },
    getBoundingClientRect() { return { x: 0, y: 0, width: 240, height: 24 } }
  }
  const quill = {
    root: editor,
    on(name, callback) { if (name === 'text-change') quillListeners.add(callback) },
    off(name, callback) { if (name === 'text-change') quillListeners.delete(callback) },
    emitTextChange() { for (const callback of [...quillListeners]) callback() }
  }
  const document = {
    activeElement: editor,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(callback)
    },
    querySelectorAll() { return [editor] },
    createElement() { return { innerHTML: '', innerText: '', textContent: '' } }
  }
  const renderer = {
    isRendering: true,
    findCalls: 0,
    findNodeByUid(uid) {
      this.findCalls += 1
      return this.isRendering === false && String(uid) === nodeData.uid ? node : null
    }
  }
  const window = {
    __V2_TRACE_LOG__: [],
    __perfRepairMindMap: {
      renderer, opt: { readonly: false }, richText: { showTextEdit: false, node: null },
      cooperate: { collabV2Adapter: { getStatus() { return { lastServerRevision: 7 } } } },
      on(name, callback) { mindMapEvents.set(name, callback) }
    }
  }
  class FakePerformanceObserver {
    constructor(callback) { observedLongTask = callback }
    observe() {}
  }
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; mutationObservers.push(this) }
    observe(target) { this.target = target }
    disconnect() { this.disconnected = true }
    trigger() { if (!this.disconnected) this.callback([{ type: 'characterData' }]) }
  }
  const fire = (type, event) => {
    for (const callback of listeners.get(type) || []) callback(event)
  }
  const context = {
    window, document,
    setInterval: () => ({ unref() {} }),
    performance: { timeOrigin: 50000, now: () => now },
    PerformanceObserver: FakePerformanceObserver,
    MutationObserver: FakeMutationObserver,
    getComputedStyle: () => ({ display: editorVisible ? 'block' : 'none', visibility: 'visible' }),
    requestAnimationFrame(callback) { now += 16; callback(now); return now },
    queueMicrotask(callback) { callback() },
    setTimeout() { return 1 },
    clearTimeout() {}
  }
  vm.runInNewContext(instrumentationInitScript('browser-observation-self-test'), context, { timeout: 1000 })

  const pending = window.__cpInstallWriterWatch(nodeData.uid, 'stable text', 'writer-token', Date.now(), 'self-test')
  pending.firstInputAtPerfMs = now - 3
  window.__cpWriterTick()
  assert(pending.rendererAssociation === 'pending_by_uid' && renderer.findCalls === 0 && !pending.local,
    'writer watch must remain UID-associated while the renderer is transient')
  now += 12
  renderer.isRendering = false
  nodeData.text = 'stable text'
  window.__cpWriterTick()
  assert(pending.local && window.__cpTrace.input.some(row => row.token === 'writer-token' && row.status === 'rendered'),
    'writer watch must resolve against the UID after the renderer becomes stable')

  window.__cpInstallNodeEditProbe(nodeData.uid, 'editor-token')
  window.__cpBeginEditorObservation('editor-token', nodeData.uid)
  now += 2
  const nodeElement = {
    getAttribute(name) { return name === 'data-node-uid' ? nodeData.uid : null },
    closest(selector) { return selector.includes('.smm-node[data-node-uid]') ? this : null }
  }
  fire('dblclick', { target: nodeElement })
  editorVisible = true
  window.__perfRepairMindMap.richText = { showTextEdit: true, node, quill }
  now += 2
  mindMapEvents.get('before_show_text_edit')(node)
  const editorObservation = window.__cpReadEditorObservation('editor-token')
  assert(editorObservation.complete && editorObservation.doubleClickToBeforeShowMs === 2 &&
    editorObservation.doubleClickToVisibleFrameMs >= 2,
  `editor observation did not retain page-local event timings: ${JSON.stringify(editorObservation)}`)
  assert(window.__cpInspectEditorSession().bindingVerified && window.__cpInspectEditorSession().boundUid === nodeData.uid,
    'active rich-text node binding must verify editor ownership for same-UID reuse')

  window.__cpArmFirstKeyObservation('quill-token', nodeData.uid, 'c')
  fire('keydown', { target: editor, key: 'c' })
  fire('beforeinput', { target: editor, inputType: 'insertText', data: 'c' })
  editor.innerText = 'c'
  quill.emitTextChange()
  const quillFeedback = window.__cpReadFirstKeyObservation('quill-token')
  assert(quillFeedback.complete && quillFeedback.raf1EchoMatches && quillFeedback.raf2EchoMatches &&
    quillFeedback.inputAtPerfMs === null && quillFeedback.keydownToInputMs === null &&
    quillFeedback.feedbackSource === 'quill_text_change' && Number.isFinite(quillFeedback.quillTextChangeAtPerfMs) &&
    quillFeedback.domMutationAtPerfMs === null && !window.__cpTrace.inputEvents.some(row => row.token === 'quill-token'),
  `Quill text-change must complete two-frame echo with native input time left null: ${JSON.stringify(quillFeedback)}`)

  editor.innerText = ''
  window.__cpArmFirstKeyObservation('mutation-token', nodeData.uid, 'x')
  fire('keydown', { target: editor, key: 'x' })
  fire('beforeinput', { target: editor, inputType: 'insertText', data: 'x' })
  editor.innerText = 'wrong'
  quill.emitTextChange()
  const wrongEcho = window.__cpReadFirstKeyObservation('mutation-token')
  assert(!wrongEcho.complete && wrongEcho.feedbackSource === null && wrongEcho.inputAtPerfMs === null,
    `beforeinput or a non-matching Quill change must not count as visible feedback: ${JSON.stringify(wrongEcho)}`)
  editor.innerText = 'x'
  mutationObservers[mutationObservers.length - 1].trigger()
  const mutationFeedback = window.__cpReadFirstKeyObservation('mutation-token')
  assert(mutationFeedback.complete && mutationFeedback.raf1EchoMatches && mutationFeedback.raf2EchoMatches &&
    mutationFeedback.feedbackSource === 'dom_mutation' && mutationFeedback.inputAtPerfMs === null &&
    Number.isFinite(mutationFeedback.domMutationAtPerfMs) && mutationFeedback.quillTextChangeAtPerfMs === null,
  `MutationObserver fallback must require exact visible text and two RAFs: ${JSON.stringify(mutationFeedback)}`)

  editor.innerText = ''
  window.__cpArmFirstKeyObservation('native-token', nodeData.uid, 'A')
  fire('keydown', { target: editor, key: 'A' })
  fire('beforeinput', { target: editor, inputType: 'insertText', data: 'A' })
  editor.innerText = 'A'
  fire('input', { target: editor, inputType: 'insertText', data: 'A' })
  const nativeFeedback = window.__cpReadFirstKeyObservation('native-token')
  assert(nativeFeedback.complete && nativeFeedback.raf1EchoMatches && nativeFeedback.raf2EchoMatches &&
    Number.isFinite(nativeFeedback.inputAtPerfMs) && nativeFeedback.feedbackSource === 'native_input',
  `native input path must continue to report its actual timestamp: ${JSON.stringify(nativeFeedback)}`)

  observedLongTask({ getEntries() { return [{ startTime: 4, duration: 60, name: 'self-test-longtask' }] } })
  assert(window.__cpTrace.longTaskCount === 1 && window.__cpTrace.longTaskMaxMs === 60 &&
    window.__cpTrace.longTasks[0].name === 'self-test-longtask', 'long-task observer did not record a page task')
  return {
    status: 'pass',
    checks: [
      { name: 'UID writer watch survives transient renderer root', status: 'pass' },
      { name: 'stable renderer associates local model by UID', status: 'pass' },
      { name: 'page-local double-click and editor-visible clocks', status: 'pass', editorObservation },
      { name: 'verified active editor binding', status: 'pass', boundUid: nodeData.uid },
      { name: 'Quill text-change feedback without native input', status: 'pass', feedbackSource: quillFeedback.feedbackSource,
        nativeInputAtPerfMs: quillFeedback.inputAtPerfMs, keydownToRaf2Ms: quillFeedback.keydownToRaf2Ms },
      { name: 'non-matching text is not feedback; DOM mutation fallback', status: 'pass',
        feedbackSource: mutationFeedback.feedbackSource, keydownToRaf2Ms: mutationFeedback.keydownToRaf2Ms },
      { name: 'native input timestamp remains supported', status: 'pass', inputAtPerfMs: nativeFeedback.inputAtPerfMs },
      { name: 'PerformanceObserver long task capture', status: 'pass', longTaskCount: window.__cpTrace.longTaskCount }
    ],
    note: 'VM-only instrumentation test; it does not launch a browser, modify product state, or start load.'
  }
}

async function prepareBrowserPage(page, origin, roomKey, identity, label) {
  await page.context().addCookies([{ name: 'mind_map_session', value: identity.token, url: origin }])
  const sockets = []
  const socketFrames = []
  const subtreeRequests = []
  const httpSamples = []
  const browserDiagnostics = { console: [], failedRequests: [], failedResponses: [], pageErrors: [] }
  const requestStarts = new WeakMap()
  const normalizeRoute = target => new URL(target).pathname
    .replace(new RegExp(encodeURIComponent(roomKey), 'g'), ':room')
    .replace(new RegExp(roomKey, 'g'), ':room')
  page.on('request', request => {
    if (!request.url().startsWith(`${origin}/api/`)) return
    const parsedUrl = new URL(request.url())
    requestStarts.set(request, { at: Date.now(), method: request.method(), route: normalizeRoute(request.url()), uid: parsedUrl.searchParams.get('uid') || null })
  })
  page.on('response', response => {
    const started = requestStarts.get(response.request())
    if (!started) return
    const sample = { category: 'browser-http', phase: page.__cpCurrentPhase || 'setup', method: started.method, route: started.route, status: response.status(), latencyMs: Date.now() - started.at, outcome: response.status() < 500 ? 'response' : 'http_error' }
    httpSamples.push(sample)
    append(samplesPath, sample)
    if (started.route.endsWith('/subtree')) {
      const subtree = { at: Date.now(), uid: started.uid, status: response.status(), latencyMs: sample.latencyMs }
      subtreeRequests.push(subtree)
      append(eventsPath, { type: 'browser-subtree-response', label, ...subtree })
    }
  })
  page.on('requestfailed', request => {
    const started = requestStarts.get(request)
    if (!started) return
    const sample = { category: 'browser-http', phase: page.__cpCurrentPhase || 'setup', method: started.method, route: started.route, status: null, latencyMs: Date.now() - started.at, outcome: 'request_failed', error: safeError(request.failure() && request.failure().errorText || 'unknown') }
    httpSamples.push(sample)
    append(samplesPath, sample)
    if (started.route.endsWith('/subtree')) {
      const subtree = { at: Date.now(), uid: started.uid, status: null, latencyMs: sample.latencyMs, outcome: 'request_failed', error: sample.error }
      subtreeRequests.push(subtree)
      append(eventsPath, { type: 'browser-subtree-response', label, ...subtree })
    }
  })
  page.on('websocket', socket => {
    const item = { label, url: socket.url(), openedAt: Date.now(), closedAt: null }
    sockets.push(item); append(eventsPath, { type: 'browser-websocket-open', ...item })
    const recordFrame = (direction, frame) => {
      const raw = typeof frame === 'string' ? frame : frame && frame.payload != null
        ? (typeof frame.payload === 'string' ? frame.payload : Buffer.from(frame.payload).toString('utf8'))
        : Buffer.isBuffer(frame) ? frame.toString('utf8') : String(frame == null ? '' : frame)
      if (Buffer.byteLength(raw) > 65536) {
        append(eventsPath, { type: 'browser-websocket-large-frame', label, direction, at: Date.now(), payloadBytes: Buffer.byteLength(raw), diagnosticParseSkipped: true })
        return
      }
      let parsed = null
      const jsonStart = [raw.indexOf('['), raw.indexOf('{')].filter(index => index >= 0).sort((a, b) => a - b)[0]
      if (jsonStart != null) { try { parsed = JSON.parse(raw.slice(jsonStart)) } catch (_) {} }
      let operationId = null
      const visit = (value, seen = new Set()) => {
        if (!value || typeof value !== 'object' || seen.has(value) || operationId) return
        seen.add(value)
        operationId = value.opId || value.op_id || value.operationId || value.operation_id || null
        if (operationId) return
        for (const child of Object.values(value)) visit(child, seen)
      }
      visit(parsed)
      const eventName = Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : parsed && (parsed.type || parsed.event) || null
      if (!operationId && !/ack|operation/i.test(String(eventName || ''))) return
      const row = { label, direction, at: Date.now(), socketUrl: socket.url(), packetPrefix: raw.slice(0, 3), payloadBytes: Buffer.byteLength(raw), eventName: eventName ? String(eventName).slice(0, 100) : null, operationId: operationId ? String(operationId) : null }
      socketFrames.push(row)
      append(eventsPath, { type: 'browser-websocket-frame', ...row })
    }
    socket.on('framesent', frame => recordFrame('sent', frame))
    socket.on('framereceived', frame => recordFrame('received', frame))
    socket.on('close', () => { item.closedAt = Date.now(); append(eventsPath, { type: 'browser-websocket-close', label, url: item.url, closedAt: item.closedAt }) })
    socket.on('socketerror', error => append(eventsPath, { type: 'browser-websocket-error', label, url: item.url, message: String(error) }))
  })
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') {
      const entry = { type: message.type(), text: message.text().slice(0, 1200) }
      browserDiagnostics.console.push(entry)
      append(eventsPath, { type: 'browser-console', label, ...entry })
    }
  })
  page.on('requestfailed', request => {
    const entry = { url: request.url(), error: request.failure() && request.failure().errorText }
    browserDiagnostics.failedRequests.push(entry)
    append(eventsPath, { type: 'browser-request-failed', label, ...entry })
  })
  page.on('response', response => {
    if (response.status() >= 400) {
      const entry = { url: response.url(), status: response.status() }
      browserDiagnostics.failedResponses.push(entry)
      append(eventsPath, { type: 'browser-response-error', label, ...entry })
    }
  })
  page.on('pageerror', error => {
    browserDiagnostics.pageErrors.push(error.message)
    append(eventsPath, { type: 'browser-page-error', label, message: error.message })
  })
  await page.addInitScript(instrumentationInitScript(runToken))
  await page.goto(`${origin}/?room=${encodeURIComponent(roomKey)}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  try {
    await page.waitForSelector('.smm-node', { timeout: args.smoke ? 20000 : 90000 })
  } catch (error) {
    const diagnostics = await page.evaluate(async ({ roomKey, mindMapExpression }) => {
      const get = async url => {
        try {
          const response = await fetch(url, { credentials: 'include' })
          const text = await response.text()
          let body = null
          try { body = text ? JSON.parse(text) : null } catch (_) { body = text.slice(0, 1200) }
          return { status: response.status, ok: response.ok, body }
        } catch (cause) { return { error: String(cause) } }
      }
      let mindMap = null
      try { mindMap = eval(mindMapExpression) } catch (_) {}
      return {
        href: location.href, title: document.title, readyState: document.readyState,
        bodyText: (document.body && document.body.innerText || '').slice(0, 4000),
        bodyHtmlHead: (document.body && document.body.innerHTML || '').slice(0, 4000),
        appRoot: !!document.querySelector('#app'), appVue: !!(document.querySelector('#app') && document.querySelector('#app').__vue__),
        runtime: window.__MIND_MAP_RUNTIME__ || null, collabState: window.__COLLAB_V2_STATE__ || null,
        auth: await get('/api/auth/me'), roomPreview: await get(`/api/files/${encodeURIComponent(roomKey)}/preview`),
        mindMap: mindMap ? { renderer: !!mindMap.renderer, isRendering: mindMap.renderer && mindMap.renderer.isRendering, dataRoot: !!(mindMap.renderer && mindMap.renderer.root), collaborate: !!mindMap.cooperate, adapter: !!(mindMap.cooperate && mindMap.cooperate.collabV2Adapter) } : null
      }
    }, { roomKey, mindMapExpression: getMindMapSource() }).catch(cause => ({ evaluateError: cause.message }))
    const shot = path.join(runDir, `${label}-browser-startup-failure.png`)
    await page.screenshot({ path: shot, fullPage: false, timeout: 10000 }).catch(() => {})
    fs.writeFileSync(path.join(runDir, `${label}-browser-startup-diagnostics.json`), JSON.stringify({ label, userId: identity.userId, diagnostics, browserDiagnostics }, null, 2) + '\n')
    throw new Error(`browser ${label} did not render .smm-node; diagnostics=${JSON.stringify({ ...diagnostics, screenshot: path.basename(shot), errors: browserDiagnostics }).slice(0, 6000)}; original=${error.message}`)
  }
  await page.waitForFunction(() => { const state=window.__COLLAB_V2_STATE__; return state && (state.status==='live'||state.phase==='LIVE') }, null, { timeout: 90000 })
  await page.waitForFunction(`(() => { const mm=${getMindMapSource()}; return !!(mm&&mm.renderer&&mm.renderer.isRendering===false) })()`, null, { timeout: 90000 })
  await page.evaluate(`window.__perfRepairMindMap=${getMindMapSource()}`)
  await page.evaluate(({ mode, pageLabel }) => { window.__perfRepairRenderMode = mode; window.__perfRepairPageLabel = pageLabel }, { mode: renderMode, pageLabel: label })
  await page.evaluate(() => window.__cpInstallRenderCompleteHook && window.__cpInstallRenderCompleteHook())
  const stats = await page.evaluate(() => ({
    visibleDomNodes: document.querySelectorAll('.smm-node').length,
    state: window.__COLLAB_V2_STATE__ || null,
    rendererReady: !!(window.__perfRepairMindMap&&window.__perfRepairMindMap.renderer),
    user: window.__AUTH_USER__ || null
  }))
  append(eventsPath, { type: 'browser-ready', label, userId: identity.userId, stats, socketCount: sockets.length })
  return { page, label, identity, sockets, socketFrames, httpSamples, subtreeRequests, currentPhase: 'setup', readyStats: stats }
}

async function ensureVisibleBranch(entry, branchUid) {
  const rootBefore = await entry.page.evaluate(async () => {
    const mm = window.__perfRepairMindMap
    const root = mm && mm.renderer && mm.renderer.findNodeByUid('root')
    if (!root) throw new Error('visible fixture root is missing')
    const before = root.nodeData.children.length
    const expected = Number(root.getData('childCount')) || 0
    if (before < expected && mm.cooperate && typeof mm.cooperate.hydrateLazyChildren === 'function') {
      await mm.cooperate.hydrateLazyChildren(root)
    }
    return { before, expected }
  })
  const beforeRequests = entry.subtreeRequests.length
  await entry.page.evaluate(uid => {
    const mm = window.__perfRepairMindMap
    const branch = mm && mm.renderer && mm.renderer.findNodeByUid(uid)
    if (!branch) throw new Error(`visible fixture branch missing: ${uid}`)
    mm.execCommand('SET_NODE_EXPAND', branch, true)
  }, branchUid)
  await entry.page.waitForFunction(({ uid, expectedCount }) => {
    const mm = window.__perfRepairMindMap
    const branch = mm && mm.renderer && mm.renderer.findNodeByUid(uid)
    if (!branch || branch.getData('expand') !== true ||
        Number(branch.getData('childCount')) !== expectedCount ||
        Number(branch.nodeData.children && branch.nodeData.children.length) !== expectedCount ||
        branch.getData('hasMore') !== false || mm.renderer.isRendering !== false) {
      window.__cpStableVisibleBranch = null
      return false
    }
    const signature = [branch.getData('expand'), branch.nodeData.children.length, branch.getData('childCount'), branch.getData('hasMore')].join('|')
    const previous = window.__cpStableVisibleBranch
    if (!previous || previous.signature !== signature) {
      window.__cpStableVisibleBranch = { signature, since: performance.now() }
      return false
    }
    return performance.now() - previous.since >= 250
  }, { uid: branchUid, expectedCount: FIXTURE_VISIBLE_LEAF_COUNT }, { timeout: 90000 })
  const viewportAnchorUid = await entry.page.evaluate(branchUid => {
    const mm = window.__perfRepairMindMap
    const branch = mm && mm.renderer && mm.renderer.findNodeByUid(branchUid)
    const children = branch && branch.nodeData && branch.nodeData.children || []
    const anchorData = children[Math.floor(children.length / 2)]
    const anchorUid = anchorData && String(anchorData.data && anchorData.data.uid || anchorData.uid || '')
    const anchor = anchorUid && mm.renderer.findNodeByUid(anchorUid)
    if (!anchor || typeof anchor.getData !== 'function') throw new Error(`visible branch middle leaf is not a renderer node: ${branchUid}/${anchorUid}`)
    // Keep a usable editing scale and center the expanded viewport around a real
    // leaf. Fitting the entire 1000-node branch shrinks the canvas to a few pixels.
    mm.view.setScale(1)
    mm.renderer.moveNodeToCenter(anchor, false)
    return String(anchor.getData('uid'))
  }, branchUid)
  await entry.page.waitForFunction(() => {
    const mm = window.__perfRepairMindMap
    return !!(mm && mm.renderer && mm.renderer.isRendering === false)
  }, null, { timeout: 30000 })
  const naturalStats = await entry.page.evaluate(({ branchUid, viewportAnchorUid }) => {
    const mm = window.__perfRepairMindMap
    const root = mm.renderer.findNodeByUid('root')
    const branch = mm.renderer.findNodeByUid(branchUid)
    const countRenderer = tree => {
      let count = 0
      const stack = tree ? [tree] : []
      while (stack.length) { const node = stack.pop(); count += 1; (node.children || []).forEach(child => stack.push(child)) }
      return count
    }
    return {
      rootChildCount: Number(root.getData('childCount')),
      rootChildrenLoaded: root.nodeData.children.length,
      branchExpand: branch && branch.getData('expand'),
      branchChildCount: branch && Number(branch.getData('childCount')),
      branchChildrenLoaded: branch && branch.nodeData.children.length,
      branchHasMore: branch && branch.getData('hasMore'),
      rendererTreeNodes: countRenderer(mm.renderer.renderTree),
      visibleDomNodes: document.querySelectorAll('.smm-node').length,
      viewportVisibleUids: Array.from(document.querySelectorAll('.smm-node[data-node-uid]')).filter(el => {
        const bounds = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        const viewport = mm.el.getBoundingClientRect()
        const centerX = bounds.left + bounds.width / 2
        const centerY = bounds.top + bounds.height / 2
        const hit = document.elementFromPoint(centerX, centerY)
        const hitNode = hit && hit.closest && hit.closest('.smm-node[data-node-uid]')
        return el.isConnected && style.display !== 'none' && style.visibility !== 'hidden' &&
          style.pointerEvents !== 'none' && bounds.width > 2 && bounds.height > 2 &&
          centerX >= Math.max(viewport.left, 0) && centerX <= Math.min(viewport.right, window.innerWidth) &&
          centerY >= Math.max(viewport.top, 0) && centerY <= Math.min(viewport.bottom, window.innerHeight) &&
          hitNode === el
      }).map(el => el.getAttribute('data-node-uid')).filter(Boolean),
      rendererIdle: mm.renderer.isRendering === false,
      openPerformance: mm.opt.openPerformance,
      performanceConfig: mm.opt.performanceConfig || null,
      viewScale: mm.view && mm.view.scale,
      viewport: { width: mm.width, height: mm.height },
      viewportAnchorUid
    }
  }, { branchUid, viewportAnchorUid })
  const screenshot = path.join(runDir, `${entry.label}-visible-branch.png`)
  await entry.page.screenshot({ path: screenshot, fullPage: false, timeout: 10000 }).catch(() => {})
  let fullDrawStats = null
  if (renderMode === 'full') {
    await entry.page.evaluate(() => {
      const mm = window.__perfRepairMindMap
      if (!mm || !mm.renderer || typeof mm.updateConfig !== 'function') {
        window.__cpFullDrawSwitch = { finished: true, error: 'MindMap.updateConfig unavailable' }
        return
      }
      const switchState = window.__cpFullDrawSwitch = {
        startedAt: Date.now(), finished: false,
        openPerformanceBefore: mm.opt.openPerformance
      }
      const finish = () => {
        mm.off('node_tree_render_end', finish)
        switchState.finished = true
        switchState.finishedAt = Date.now()
      }
      mm.on('node_tree_render_end', finish)
      if (mm.opt.openPerformance === false) mm.renderer.forceLoadNode()
      else mm.updateConfig({ openPerformance: false })
    })
    try {
      await entry.page.waitForFunction(() => window.__cpFullDrawSwitch && window.__cpFullDrawSwitch.finished, null, { timeout: 90000 })
      await entry.page.waitForFunction(() => {
        const mm = window.__perfRepairMindMap
        return !!(mm && mm.renderer && mm.renderer.isRendering === false && document.querySelectorAll('.smm-node').length >= FULL_DRAW_TOTAL_DOM_NODE_COUNT)
      }, null, { timeout: 30000 })
    } catch (error) {
      const diagnostic = await entry.page.evaluate(() => {
        const mm = window.__perfRepairMindMap
        const tree = mm && mm.renderer && mm.renderer.renderTree
        let modelNodes = 0
        const stack = tree ? [tree] : []
        while (stack.length) { const node = stack.pop(); modelNodes += 1; (node.children || []).forEach(child => stack.push(child)) }
        return {
          switch: window.__cpFullDrawSwitch || null,
          openPerformance: mm && mm.opt && mm.opt.openPerformance,
          rendererIdle: mm && mm.renderer && mm.renderer.isRendering === false,
          modelNodes, domNodes: document.querySelectorAll('.smm-node').length,
          nodeCacheCount: mm && mm.renderer && Object.keys(mm.renderer.nodeCache || {}).length,
          errors: window.__cpTrace && window.__cpTrace.errors || []
        }
      }).catch(cause => ({ evaluateError: cause.message }))
      const diagnosticPath = path.join(runDir, `${entry.label}-full-render-timeout.json`)
      fs.writeFileSync(diagnosticPath, JSON.stringify({ label: entry.label, error: error.message, diagnostic }, null, 2) + '\n')
      throw new Error(`${entry.label} full-render timeout; diagnostic=${path.basename(diagnosticPath)} ${JSON.stringify(diagnostic).slice(0, 2200)}`)
    }
    fullDrawStats = await entry.page.evaluate(() => ({
      switch: window.__cpFullDrawSwitch || null,
      openPerformance: window.__perfRepairMindMap.opt.openPerformance,
      domNodeCount: document.querySelectorAll('.smm-node').length,
      domUids: Array.from(document.querySelectorAll('.smm-node[data-node-uid]'))
        .map(el => el.getAttribute('data-node-uid')).filter(Boolean),
      rootDomNodeCount: Array.from(document.querySelectorAll('.smm-node[data-node-uid]'))
        .filter(el => el.getAttribute('data-node-uid') === 'root').length,
      nonRootDomNodeCount: Array.from(document.querySelectorAll('.smm-node[data-node-uid]'))
        .filter(el => el.getAttribute('data-node-uid') !== 'root').length,
      uniqueNonRootDomUidCount: new Set(Array.from(document.querySelectorAll('.smm-node[data-node-uid]'))
        .map(el => el.getAttribute('data-node-uid')).filter(uid => uid && uid !== 'root')).size,
      unidentifiedDomNodeCount: document.querySelectorAll('.smm-node').length - document.querySelectorAll('.smm-node[data-node-uid]').length,
      visibleDomNodeCount: Array.from(document.querySelectorAll('.smm-node')).filter(el => {
        const style = getComputedStyle(el)
        return el.isConnected && style.display !== 'none' && style.visibility !== 'hidden'
      }).length,
      rendererIdle: window.__perfRepairMindMap.renderer.isRendering === false
    }))
    const fullScreenshot = path.join(runDir, `${entry.label}-full-draw-1000.png`)
    await entry.page.screenshot({ path: fullScreenshot, fullPage: false, timeout: 15000 }).catch(() => {})
    fullDrawStats.screenshot = path.basename(fullScreenshot)
    assert(fullDrawStats.openPerformance === false, `${entry.label} full-draw configuration did not disable openPerformance: ${JSON.stringify(fullDrawStats)}`)
    assert(fullDrawStats.domNodeCount === FULL_DRAW_TOTAL_DOM_NODE_COUNT &&
      fullDrawStats.rootDomNodeCount === 1 &&
      fullDrawStats.nonRootDomNodeCount === VISIBLE_NODE_COUNT &&
      fullDrawStats.uniqueNonRootDomUidCount === VISIBLE_NODE_COUNT &&
      fullDrawStats.unidentifiedDomNodeCount === 0,
    `${entry.label} full-draw must contain exactly ${VISIBLE_NODE_COUNT} non-root nodes plus one root: ${JSON.stringify(fullDrawStats)}`)
  }
  let forcedRenderProbe = null
  if (renderMode === 'natural' && args.smoke && args['force-render-probe'] && entry.label === 'browser-01') {
    await entry.page.evaluate(() => {
      const mm = window.__perfRepairMindMap
      if (!mm || !mm.renderer || typeof mm.renderer.forceLoadNode !== 'function') {
        window.__cpForceRenderProbe = { finished: true, error: 'forceLoadNode unavailable' }
        return
      }
      const probe = window.__cpForceRenderProbe = { startedAt: Date.now(), finished: false }
      const finish = () => {
        mm.off('node_tree_render_end', finish)
        probe.finished = true
        probe.finishedAt = Date.now()
      }
      mm.on('node_tree_render_end', finish)
      mm.renderer.forceLoadNode()
    })
    await entry.page.waitForFunction(() => window.__cpForceRenderProbe && window.__cpForceRenderProbe.finished, null, { timeout: 60000 })
    await entry.page.waitForFunction(() => {
      const mm = window.__perfRepairMindMap
      return !!(mm && mm.renderer && mm.renderer.isRendering === false)
    }, null, { timeout: 30000 })
    forcedRenderProbe = await entry.page.evaluate(() => ({
      ...window.__cpForceRenderProbe,
      domNodeCount: document.querySelectorAll('.smm-node').length,
      rendererTreeNodes: (() => {
        const mm = window.__perfRepairMindMap
        let count = 0
        const stack = mm && mm.renderer && mm.renderer.renderTree ? [mm.renderer.renderTree] : []
        while (stack.length) { const node = stack.pop(); count += 1; (node.children || []).forEach(child => stack.push(child)) }
        return count
      })()
    }))
    const forcedScreenshot = path.join(runDir, `${entry.label}-forced-1000-render.png`)
    await entry.page.screenshot({ path: forcedScreenshot, fullPage: false, timeout: 15000 }).catch(() => {})
    forcedRenderProbe.screenshot = path.basename(forcedScreenshot)
  }
  const successfulSubtreeReads = entry.subtreeRequests.slice(beforeRequests).filter(row => row.uid === branchUid && row.status === 200).length
  const stats = {
    ...naturalStats,
    expandedModelNodes: Math.max(0, naturalStats.rendererTreeNodes - 1),
    expandedModelNodesIncludingRoot: naturalStats.rendererTreeNodes,
    viewportDomNodes: naturalStats.visibleDomNodes,
    fullDrawStats,
    forcedRenderProbe
  }
  append(eventsPath, { type: 'browser-visible-branch-ready', label: entry.label, userId: entry.identity.userId, branchUid, rootBefore, successfulSubtreeReads, stats, screenshot: path.basename(screenshot) })
  assert(successfulSubtreeReads > 0, `${entry.label} 展开 ${branchUid} 没有成功的 subtree HTTP 请求`)
  assert(stats.rootChildrenLoaded === stats.rootChildCount, `${entry.label} 根分页未加载完整：${JSON.stringify(stats)}`)
  assert(stats.branchChildrenLoaded === FIXTURE_VISIBLE_LEAF_COUNT, `${entry.label} 可见分支加载节点数不符：${JSON.stringify(stats)}`)
  assert(stats.rendererTreeNodes === EXPECTED_RENDERER_TREE_NODE_COUNT, `${entry.label} 已展开模型树节点数 ${stats.rendererTreeNodes} 不等于含root目标 ${EXPECTED_RENDERER_TREE_NODE_COUNT}：${JSON.stringify(stats)}`)
  assert(stats.expandedModelNodes === (renderMode === 'full' ? VISIBLE_NODE_COUNT : VISIBLE_NODE_COUNT - 1), `${entry.label} 展开非root节点数语义不符：${JSON.stringify(stats)}`)
  entry.readyStats.visibleBranch = stats
  entry.readyStats.visibleDomNodes = stats.viewportDomNodes
  entry.readyStats.expandedModelNodes = stats.expandedModelNodes
  return stats
}

async function runBrowserWrite(writer, uid, text, token, phase) {
  const issuedAt = Date.now()
  const node = writer.page.locator(`.smm-node[data-node-uid="${uid}"]`)
  let session = null
  let editor = null
  let targetGeometry = null
  let editEnvironment = null
  let editorObservation = null
  let editorOpenWallMs = null
  let editorTiming = null
  let editorReused = false
  let writerWatch = null
  let firstKeyObservation = null
  let commitAttemptStartedAt = null
  let keyboardSubmittedAt = null
  let succeeded = false
  try {
    assert(typeof text === 'string' && text.length > 0, `browser write ${token} requires non-empty text`)
    session = await writer.page.evaluate(() => window.__cpInspectEditorSession && window.__cpInspectEditorSession())
    if (session && session.visible) {
      assert(session.bindingVerified && String(session.boundUid) === String(uid),
        `visible editor is not verifiably bound to scheduled UID ${uid}: ${JSON.stringify(session)}`)
      editorReused = true
      targetGeometry = { reusedVisibleEditor: true }
      editor = writer.page.locator(NODE_TEXT_EDITOR_VISIBLE_SELECTOR).first()
      assert(await editor.count() === 1, `reused editor count is not one for UID ${uid}`)
    } else {
      await writer.page.waitForFunction(({ uid }) => {
        const mm = window.__perfRepairMindMap
        return !!(mm && mm.renderer && mm.renderer.isRendering === false && mm.renderer.findNodeByUid(uid))
      }, { uid }, { timeout: 10000, polling: 'raf' })
      targetGeometry = await writer.page.evaluate(uid => {
        const element = Array.from(document.querySelectorAll('.smm-node[data-node-uid]'))
          .find(candidate => candidate.getAttribute('data-node-uid') === uid)
        if (!element) return { found: false }
        const bounds = element.getBoundingClientRect()
        const centerX = bounds.left + bounds.width / 2
        const centerY = bounds.top + bounds.height / 2
        const hit = document.elementFromPoint(centerX, centerY)
        const hitNode = hit && hit.closest && hit.closest('.smm-node[data-node-uid]')
        return {
          found: true,
          bounds: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height },
          centerInWindow: centerX >= 0 && centerX <= innerWidth && centerY >= 0 && centerY <= innerHeight,
          centerHitUid: hitNode && hitNode.getAttribute('data-node-uid') || null
        }
      }, uid)
      assert(targetGeometry.found && targetGeometry.centerInWindow && targetGeometry.centerHitUid === uid,
        `browser target ${uid} is not actually clickable in the viewport: ${JSON.stringify(targetGeometry)}`)
      editEnvironment = await writer.page.evaluate(({ uid, token }) => {
        const mm = window.__perfRepairMindMap
        const node = mm && mm.renderer && mm.renderer.findNodeByUid(uid)
        window.__cpInstallNodeEditProbe && window.__cpInstallNodeEditProbe(uid, token)
        window.__cpBeginEditorObservation && window.__cpBeginEditorObservation(token, uid)
        const status = mm && mm.cooperate && mm.cooperate.collabV2Adapter && mm.cooperate.collabV2Adapter.getStatus()
        return {
          rendererStable: !!(mm && mm.renderer && mm.renderer.isRendering === false),
          readonly: !!(mm && mm.opt && mm.opt.readonly), richTextActive: !!(mm && mm.richText),
          richTextEnabled: !!(window.__appStore && window.__appStore.state && window.__appStore.state.localConfig && window.__appStore.state.localConfig.openNodeRichText),
          nodeFound: !!node, customContent: !!(node && node.isUseCustomNodeContent && node.isUseCustomNodeContent()),
          mapRef: !!(node && node.getData && node.getData('mapRef')),
          activeNodeCount: mm && mm.renderer && mm.renderer.activeNodeList ? mm.renderer.activeNodeList.length : null,
          ownEditingPeer: !!(status && (status.peers || []).some(peer => peer && peer.clientId === (mm.cooperate.collabV2Adapter.getClientId && mm.cooperate.collabV2Adapter.getClientId()) && String(peer.editingUid || '') === String(uid))),
          otherEditingPeers: status && (status.peers || []).filter(peer => peer && String(peer.editingUid || '') === String(uid)).map(peer => ({ clientId: peer.clientId, editingUid: peer.editingUid })) || []
        }
      }, { uid, token })
      append(eventsPath, { type: 'browser-edit-open-attempt', phase, token, uid, userId: writer.identity.userId, targetGeometry, editEnvironment })
      const openWallStarted = performance.now()
      await node.dblclick({ timeout: 15000, delay: 60 })
      editor = writer.page.locator(NODE_TEXT_EDITOR_VISIBLE_SELECTOR).first()
  try {
    await editor.waitFor({ state: 'visible', timeout: 15000 })
  } catch (error) {
    const editFailure = await writer.page.evaluate(({ uid, selector }) => {
      const mm = window.__perfRepairMindMap
      const visible = element => {
        const style = getComputedStyle(element)
        const bounds = element.getBoundingClientRect()
        return element.isConnected && style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0
      }
      const editors = Array.from(document.querySelectorAll(selector)).map(el => ({
        className: String(el.className || ''), contenteditable: el.getAttribute('contenteditable'),
        visible: visible(el), display: getComputedStyle(el).display, visibility: getComputedStyle(el).visibility,
        text: String(el.innerText || el.textContent || '').slice(0, 100),
        bounds: (() => { const rect = el.getBoundingClientRect(); return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } })()
      }))
      const node = mm && mm.renderer && mm.renderer.findNodeByUid(uid)
      const trace = window.__cpTrace || {}
      return {
        readonly: !!(mm && mm.opt && mm.opt.readonly), richTextActive: !!(mm && mm.richText),
        nodeFound: !!node, customContent: !!(node && node.isUseCustomNodeContent && node.isUseCustomNodeContent()),
        mapRef: !!(node && node.getData && node.getData('mapRef')),
        nodeEditEvents: (trace.nodeEditEvents || []).slice(-8), editors,
        recentTrace: (window.__V2_TRACE_LOG__ || []).slice(-12).map(row => ({ stage: row.stage, traceId: row.traceId, opId: row.opId, t: row.t }))
      }
    }, { uid, selector: NODE_TEXT_EDITOR_SELECTOR }).catch(cause => ({ evaluateError: cause.message }))
    append(eventsPath, { type: 'browser-edit-open-failed', phase, token, uid, userId: writer.identity.userId, targetGeometry, editEnvironment, editFailure })
    throw new Error(`真实双击未打开可见文本编辑器：${JSON.stringify({ uid, editEnvironment, editFailure, cause: safeError(error.message) }).slice(0, 3500)}`)
  }
      const sessionReady = await writer.page.waitForFunction(({ uid }) => {
        const session = window.__cpInspectEditorSession && window.__cpInspectEditorSession()
        return !!(session && session.visible && session.bindingVerified && String(session.boundUid) === String(uid))
      }, { uid }, { timeout: 5000, polling: 'raf' })
      assert(sessionReady, `visible editor is not bound to target UID ${uid}`)
      assert(await editor.count() === 1, `目标文本编辑器可见数量不为1：${await editor.count()}`)
      await writer.page.waitForFunction(({ token }) => {
        const observation = window.__cpReadEditorObservation && window.__cpReadEditorObservation(token)
        return !!(observation && observation.complete && observation.dblclickAtPerfMs !== null && observation.beforeShowAtPerfMs !== null)
      }, { token }, { timeout: 7000, polling: 'raf' })
      editorOpenWallMs = performance.now() - openWallStarted
      editorObservation = await writer.page.evaluate(token => window.__cpReadEditorObservation(token), token)
    }

    session = await writer.page.evaluate(() => window.__cpInspectEditorSession && window.__cpInspectEditorSession())
    assert(session && session.visible && session.bindingVerified && String(session.boundUid) === String(uid),
      `editor session changed before input for UID ${uid}: ${JSON.stringify(session)}`)
    editor = writer.page.locator(NODE_TEXT_EDITOR_VISIBLE_SELECTOR).first()
    await editor.focus({ timeout: 3000 })
    const inputStartAt = Date.now()
    await writer.page.evaluate(({ uid, text, token, inputStartAt, phase }) => {
      window.__cpInstallWriterWatch(uid, text, token, inputStartAt, phase)
    }, { uid, text, token, inputStartAt, phase })
    writerWatch = await writer.page.evaluate(token => (window.__cpPendingWriters || []).find(item => item && item.token === token) || null, token)
    assert(writerWatch, `writer watch was not registered for UID ${uid}`)

    const typingWallStarted = performance.now()
    await editor.press('Control+A')
    await writer.page.evaluate(({ token, uid, expectedText }) => {
      window.__cpArmFirstKeyObservation(token, uid, expectedText)
    }, { token, uid, expectedText: text.slice(0, 1) })
    const firstKeyDispatchAt = Date.now()
    const firstKeyWallStarted = performance.now()
    await editor.pressSequentially(text.slice(0, 1))
    await writer.page.waitForFunction(token => {
      const observation = window.__cpReadFirstKeyObservation && window.__cpReadFirstKeyObservation(token)
      return !!(observation && observation.complete && observation.raf1EchoMatches && observation.raf2EchoMatches)
    }, token, { timeout: 10000, polling: 'raf' })
    const firstKeyWallMs = performance.now() - firstKeyWallStarted
    firstKeyObservation = await writer.page.evaluate(token => window.__cpReadFirstKeyObservation(token), token)
    assert(firstKeyObservation && firstKeyObservation.complete && firstKeyObservation.raf1EchoMatches && firstKeyObservation.raf2EchoMatches,
      `page-local first-key echo did not match the intended character: ${JSON.stringify(firstKeyObservation)}`)
    const firstKeyEchoMs = firstKeyObservation.keydownToRaf2Ms
    const firstKeyAt = firstKeyObservation.keydownAtEpochMs
    assert(Number.isFinite(firstKeyAt), 'actual page keydown timestamp is required for input cadence')
    assert(Number.isFinite(firstKeyEchoMs), `page-local first-key event clocks are incomplete: ${JSON.stringify(firstKeyObservation)}`)
    await writer.page.evaluate(token => {
      if (window.__cpActiveFirstKeyObservation && window.__cpActiveFirstKeyObservation.token === String(token)) {
        window.__cpActiveFirstKeyObservation = null
      }
    }, token)
    if (text.length > 1) await writer.page.keyboard.insertText(text.slice(1))
    await writer.page.waitForFunction(({ text, selector }) => {
      const active = Array.from(document.querySelectorAll(selector)).find(el => {
        const style = getComputedStyle(el); const bounds = el.getBoundingClientRect()
        return el.isConnected && style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0
      })
      return !!active && active.innerText.trim() === text
    }, { text, selector: NODE_TEXT_EDITOR_SELECTOR }, { timeout: 15000, polling: 'raf' })
    const fullTypingMs = performance.now() - typingWallStarted
    const editorText = await editor.innerText()
    const commitActionStartedAt = Date.now()
    commitAttemptStartedAt = performance.now()
    await editor.press('Tab')
    keyboardSubmittedAt = Date.now()
    await editor.waitFor({ state: 'hidden', timeout: 10000 })
    let result
    try {
      const resultHandle = await writer.page.waitForFunction(({ uid, text }) => {
        const mm = window.__perfRepairMindMap
        const renderer = mm && mm.renderer
        if (!renderer || renderer.isRendering !== false) return false
        const node = renderer.findNodeByUid(uid)
        if (!node) return false
        const textAfterInput = window.__cpReadNodePlainText(node)
        if (textAfterInput !== text) return false
        const adapter = mm.cooperate && mm.cooperate.collabV2Adapter
        const status = adapter && adapter.getStatus && adapter.getStatus()
        return {
          textAfterInput,
          rawTextAfterInput: String(node.getData('text') || ''),
          revision: status && status.lastServerRevision
        }
      }, { uid, text }, { timeout: 15000, polling: 'raf' })
      try {
        result = await resultHandle.jsonValue()
      } finally {
        await resultHandle.dispose()
      }
    } catch (readbackError) {
      try {
        const diagnostic = await writer.page.evaluate(({ uid }) => {
          const mm = window.__perfRepairMindMap
          const renderer = mm && mm.renderer
          const node = renderer && renderer.findNodeByUid(uid)
          if (!node) {
            const scanLimit = 20000
            const scanRawTree = root => {
              if (!root || typeof root !== 'object') return { present: null, truncated: false }
              const pending = root ? [root] : []
              const seen = new Set()
              let visited = 0
              while (pending.length && visited < scanLimit) {
                const current = pending.pop()
                if (!current || typeof current !== 'object' || seen.has(current)) continue
                seen.add(current)
                visited += 1
                const currentUid = current.uid != null
                  ? current.uid
                  : current.data && current.data.uid
                if (currentUid != null && String(currentUid) === String(uid)) {
                  return { present: true, truncated: false }
                }
                if (Array.isArray(current.children)) {
                  for (let i = 0; i < current.children.length; i += 1) pending.push(current.children[i])
                }
              }
              return { present: pending.length ? null : false, truncated: pending.length > 0 }
            }
            const scanRootModel = root => {
              if (!root || typeof root !== 'object') return { present: null, truncated: false }
              const pending = root ? [root] : []
              const seen = new Set()
              let visited = 0
              while (pending.length && visited < scanLimit) {
                const current = pending.pop()
                if (!current || typeof current !== 'object' || seen.has(current)) continue
                seen.add(current)
                visited += 1
                let currentUid = null
                try {
                  currentUid = typeof current.getData === 'function'
                    ? current.getData('uid')
                    : current.nodeData && current.nodeData.data && current.nodeData.data.uid
                } catch (_) {}
                if (currentUid != null && String(currentUid) === String(uid)) {
                  return { present: true, truncated: false }
                }
                if (Array.isArray(current.children)) {
                  for (let i = 0; i < current.children.length; i += 1) pending.push(current.children[i])
                }
                if (Array.isArray(current._generalizationList)) {
                  for (let i = 0; i < current._generalizationList.length; i += 1) {
                    pending.push(current._generalizationList[i] && current._generalizationList[i].generalizationNode)
                  }
                }
              }
              return { present: pending.length ? null : false, truncated: pending.length > 0 }
            }
            const treeScan = scanRawTree(renderer && renderer.renderTree)
            const rootScan = scanRootModel(renderer && renderer.root)
            const nodeIndex = renderer && renderer.nodeIndex
            let nodeIndexHasUid = null
            if (nodeIndex && typeof nodeIndex.has === 'function') {
              nodeIndexHasUid = nodeIndex.has(uid) || nodeIndex.has(String(uid))
            }
            let rootUid = null
            try {
              rootUid = renderer && renderer.root && typeof renderer.root.getData === 'function'
                ? renderer.root.getData('uid')
                : null
            } catch (_) {}
            const snapshot = {
              renderTreeUidPresent: treeScan.present,
              renderTreeScanTruncated: treeScan.truncated,
              rootModelUidPresent: rootScan.present,
              rootModelScanTruncated: rootScan.truncated,
              nodeIndexHasUid,
              nodeIndexSize: nodeIndex && Number.isFinite(nodeIndex.size) ? nodeIndex.size : null,
              rootNodeDataMatchesRenderTree: renderer && renderer.root
                ? renderer.root.nodeData === renderer.renderTree
                : null,
              rendererIsRendering: renderer ? !!renderer.isRendering : null,
              hasRenderTimer: renderer ? !!renderer.renderTimer : null,
              hasWaitRendering: renderer ? !!renderer.hasWaitRendering : null,
              rendererLayoutEpoch: renderer && Number.isFinite(renderer._layoutEpoch) ? renderer._layoutEpoch : null,
              v2RemoteApplyEpoch: mm && mm.cooperate && Number.isFinite(mm.cooperate._v2RemoteApplyEpoch)
                ? mm.cooperate._v2RemoteApplyEpoch
                : null,
              adapterLastServerRevision: null,
              adapterServerRevision: null,
              safeRootUid: typeof rootUid === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(rootUid)
                ? rootUid
                : null
            }
            const missingAdapter = mm && mm.cooperate && mm.cooperate.collabV2Adapter
            let missingStatus = null
            try {
              missingStatus = missingAdapter && missingAdapter.getStatus && missingAdapter.getStatus()
            } catch (_) {}
            snapshot.adapterLastServerRevision = missingStatus && Number.isFinite(missingStatus.lastServerRevision)
              ? missingStatus.lastServerRevision
              : null
            snapshot.adapterServerRevision = missingStatus && Number.isFinite(missingStatus.serverRevision)
              ? missingStatus.serverRevision
              : null
            return { code: 'RENDER_NODE_MISSING', snapshot }
          }
          const adapter = mm.cooperate && mm.cooperate.collabV2Adapter
          const status = adapter && adapter.getStatus && adapter.getStatus()
          return { textAfterInput: window.__cpReadNodePlainText(node), rawTextAfterInput: String(node.getData('text') || ''), revision: status && status.lastServerRevision }
        }, { uid })
        if (diagnostic && diagnostic.code === 'RENDER_NODE_MISSING') {
          append(samplesPath, {
            category: 'browser-render-node-probe', phase, token, uid, userId: writer.identity.userId,
            snapshot: diagnostic.snapshot
          })
          const missingError = new Error('RENDER_NODE_MISSING')
          missingError.code = 'RENDER_NODE_MISSING'
          missingError.snapshot = diagnostic.snapshot
          throw missingError
        }

      } catch (diagnosticError) {
        if (diagnosticError && diagnosticError.code === 'RENDER_NODE_MISSING') throw diagnosticError
      }
      throw readbackError
    }
    const modelTextMatches = result.textAfterInput === text
    const editorOpenMs = editorObservation && editorObservation.doubleClickToVisibleFrameMs
    editorTiming = editorObservation ? {
      doubleClickToBeforeShowMs: editorObservation.doubleClickToBeforeShowMs,
      beforeShowToVisibleMs: editorObservation.beforeShowToEditorVisibleMs,
      doubleClickToVisibleFrameMs: editorObservation.doubleClickToVisibleFrameMs
    } : null
    append(samplesPath, { category: 'browser-input-ui', phase, token, uid, userId: writer.identity.userId,
      firstKeyAt, commitActionStartedAt, keyboardSubmittedAt, editorOpenMs, editorOpenPageMs: editorOpenMs,
      editorOpenWallMs, editorTiming, editorReused, firstKeyEchoMs, firstKeyPageMetrics: firstKeyObservation,
      firstKeyWallMs, fullTypingMs, submittedTextMatches: editorText.trim() === text, modelTextMatches,
      revision: result.revision, commitAction: 'Tab product end-edit shortcut',
      inputMethod: 'Actual Control+A and first-character keypress; page-local keydown plus exact text feedback from native input, Quill text-change, or DOM mutation, then two matching RAFs; native input time stays null when absent; remaining payload via insertText',
      measurementDefinitions: { editorOpenMs: 'page-local DOM dblclick to editor-visible frame', editorOpenWallMs: 'Playwright call wall time including CDP and waits',
        firstKeyEchoMs: 'page-local keydown to second RAF with exact character echo', firstKeyWallMs: 'Playwright press and wait wall time including CDP' } })
    result.dispatchMs = firstKeyEchoMs
    result.firstKeyEchoMs = firstKeyEchoMs
    result.firstKeyDispatchAt = firstKeyDispatchAt
    result.firstKeyWallMs = firstKeyWallMs
    result.fullTypingMs = fullTypingMs
    result.modelTextMatches = modelTextMatches
    result.targetGeometry = targetGeometry
    result.editorOpenMs = editorOpenMs
    result.editorOpenWallMs = editorOpenWallMs
    result.editorTiming = editorTiming
    result.editorReused = editorReused
    result.textAfterDispatch = result.textAfterInput
    succeeded = true
    return { issuedAt, firstKeyAt, keyboardSubmittedAt, ...result }
  } catch (error) {
    const readPageWithDeadline = async (read, timeoutMs = 1200) => {
      let timer = null
      try {
        return await Promise.race([
          read().catch(cause => ({ inspectionError: safeError(cause.message) })),
          new Promise(resolve => { timer = setTimeout(() => resolve({ inspectionTimeout: true }), timeoutMs) })
        ])
      } finally { if (timer) clearTimeout(timer) }
    }
    const inspectCleanupSession = () => readPageWithDeadline(() =>
      writer.page.evaluate(() => window.__cpInspectEditorSession && window.__cpInspectEditorSession()))
    const beforeCleanup = await inspectCleanupSession()
    let escapeSent = false
    let escapeError = null
    let hiddenWaitError = null
    if (beforeCleanup && beforeCleanup.visible && beforeCleanup.bindingVerified && String(beforeCleanup.boundUid) === String(uid)) {
      try {
        const activeEditor = writer.page.locator(NODE_TEXT_EDITOR_VISIBLE_SELECTOR).first()
        await activeEditor.press('Escape', { timeout: 1200 })
        escapeSent = true
      } catch (cause) { escapeError = safeError(cause.message) }
      try {
        await writer.page.waitForFunction(() => {
          const session = window.__cpInspectEditorSession && window.__cpInspectEditorSession()
          return !session || !session.visible
        }, undefined, { timeout: 1200, polling: 'raf' })
      } catch (cause) { hiddenWaitError = safeError(cause.message) }
    }
    const afterCleanup = await inspectCleanupSession()
    const partialObservations = await readPageWithDeadline(() => writer.page.evaluate(token => ({
      editor: window.__cpReadEditorObservation && window.__cpReadEditorObservation(token),
      firstKey: window.__cpReadFirstKeyObservation && window.__cpReadFirstKeyObservation(token)
    }), token))
    const cleanup = {
      uid, token, phase, attempted: !!(beforeCleanup && beforeCleanup.visible && beforeCleanup.bindingVerified && String(beforeCleanup.boundUid) === String(uid)),
      escapeSent, escapeError, hiddenWaitError, before: beforeCleanup, after: afterCleanup,
      verifiedHidden: !!(afterCleanup && afterCleanup.visible === false),
      retainedForSameUidReuse: !!(afterCleanup && afterCleanup.visible && afterCleanup.bindingVerified && String(afterCleanup.boundUid) === String(uid)),
      commitOutcome: commitAttemptStartedAt === null ? 'not_attempted' : keyboardSubmittedAt === null ? 'unknown' : 'keyboard_event_sent',
      partialObservations,
      action: 'bounded real Escape only; no Tab, background click, hide API, DOM removal, or model write'
    }
    append(eventsPath, { type: 'browser-edit-cleanup', phase, token, uid, userId: writer.identity.userId, ...cleanup })
    if (error && typeof error === 'object') error.browserEditCleanup = cleanup
    throw error
  } finally {
    if (succeeded) {
      append(eventsPath, { type: 'browser-edit-complete', phase, token, uid, userId: writer.identity.userId,
        editorReused, editorOpenWallMs, editorTiming, writerWatch: writerWatch && { rendererAssociation: writerWatch.rendererAssociation, revisionBefore: writerWatch.revisionBefore },
        firstKeyPageMetrics: firstKeyObservation })
    }
  }
}

function mcpRequestId(request, preferredId) {
  if (typeof preferredId === 'string' && SAFE_UUID_RE.test(preferredId)) return preferredId
  const args = request && request.params && request.params.arguments
  for (const value of [args && args.operation_id, args && args.operationId, request && request.id]) {
    if (typeof value === 'string' && SAFE_UUID_RE.test(value)) return value
  }
  return randomUUID()
}

async function mcpRpc(url, token, request, session, allowEmpty = false, timeoutMs = MCP_TIMEOUT_MS, preferredRequestId = null) {
  const started = performance.now()
  const requestId = mcpRequestId(request, preferredRequestId)
  const response = await fetch(url, {
    method: 'POST', signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
      'x-mcp-request-id': requestId,
      ...(session.id ? { 'mcp-session-id': session.id } : {})
    }, body: JSON.stringify(request)
  })
  session.id = response.headers.get('mcp-session-id') || session.id
  const text = await response.text()
  const elapsedMs = performance.now() - started
  let body = null
  try { body = text ? JSON.parse(text) : null } catch (_) {
    const frames = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim())
    for (const frame of frames) { try { body = JSON.parse(frame); break } catch (_) {} }
  }
  if (response.status === 202 && allowEmpty && !text) return { body: null, responseStatus: response.status, elapsedMs, text: '', requestId }
  return { body, responseStatus: response.status, elapsedMs, text, requestId }
}

async function initializeMcp(origin, mcpToken) {
  const session = { id: null, nextId: 1 }
  let rpc = await mcpRpc(`http://127.0.0.1:${MCP_PORT}/mcp`, mcpToken, {
    jsonrpc: '2.0', id: session.nextId++, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-collab-performance-20261014', version: '1' } }
  }, session)
  assert(rpc.responseStatus >= 200 && rpc.responseStatus < 300 && rpc.body && !rpc.body.error, `MCP initialize failed HTTP ${rpc.responseStatus}: ${rpc.text.slice(0,500)}`)
  await mcpRpc(`http://127.0.0.1:${MCP_PORT}/mcp`, mcpToken, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, session, true)
  rpc = await mcpRpc(`http://127.0.0.1:${MCP_PORT}/mcp`, mcpToken, { jsonrpc: '2.0', id: session.nextId++, method: 'tools/list', params: {} }, session)
  assert(rpc.body && rpc.body.result && Array.isArray(rpc.body.result.tools), `MCP tools/list failed: ${rpc.text.slice(0,500)}`)
  const tools = new Map(rpc.body.result.tools.map(tool => [tool.name, tool]))
  return { session, tools, listResult: rpc.body.result }
}

function toolArgs(tool, roomKey, uid, text, operationId, operations) {
  const properties = (tool && tool.inputSchema && tool.inputSchema.properties) || {}
  const args = {}
  const roomKeyName = properties.room_key ? 'room_key' : properties.roomKey ? 'roomKey' : 'room_key'
  args[roomKeyName] = roomKey
  if (operations) {
    const operationsName = properties.operations ? 'operations' : properties.items ? 'items' : 'operations'
    args[operationsName] = operations
  } else {
    const nodeName = properties.uid ? 'uid' : properties.node_uid ? 'node_uid' : 'node'
    args[nodeName] = uid
    args.text = text
  }
  if (properties.operation_id || (!properties.operationId && !properties.operation_id)) args.operation_id = operationId
  else args.operationId = operationId
  return args
}

async function callMcpTool(mcp, mcpToken, name, toolArgsValue, operationId, metadata = {}) {
  const startedAt = Date.now()
  const started = performance.now()
  const request = { jsonrpc: '2.0', id: mcp.session.nextId++, method: 'tools/call', params: { name, arguments: toolArgsValue } }
  let rpc
  let outcome = 'success'
  let error = null
  let result = null
  try {
    rpc = await mcpRpc(`http://127.0.0.1:${MCP_PORT}/mcp`, mcpToken, request, mcp.session, false, MCP_TIMEOUT_MS, operationId)
    if (rpc.responseStatus < 200 || rpc.responseStatus >= 300 || !rpc.body || rpc.body.error || rpc.body.result && rpc.body.result.isError) {
      outcome = 'error'; error = rpc.body && rpc.body.error || { name: rpc.responseStatus >= 500 ? 'HttpServerError' : 'McpToolError', code: rpc.responseStatus }
    } else result = rpc.body.result
  } catch (cause) { outcome = cause.name === 'TimeoutError' || /timeout/i.test(cause.message) ? 'timeout' : 'transport_error'; error = cause.message }
  const latencyMs = performance.now() - started
  const normalized = normalizeToolResult(result)
  const pathValue = readPath(normalized)
  const sample = {
    category: metadata.category || 'mcp-write', phase: metadata.phase || 'sample', source: 'mcp', tool: name,
    operationId, uid: metadata.uid || null, token: metadata.token || null,
    plannedAt: metadata.plannedAt || startedAt, startedAt, requestStartedAt: startedAt, completedAt: Date.now(), latencyMs,
    queueDelayMs: Math.max(0, startedAt - Number(metadata.plannedAt || startedAt)), outcome,
    status: rpc ? rpc.responseStatus : null, path: pathValue.path, submissionPath: pathValue.submissionPath,
    fallbackReason: pathValue.fallbackReason, error: error ? safePersistedError(error) : null,
    clientRequestId: rpc && rpc.requestId || null,
    result: normalized
  }
  const { token: _rawToken, result: _rawResult, ...persistedSample } = sample
  append(samplesPath, { ...persistedSample, result: metadata.category === 'diagnostic' ? null : {
    isError: normalized && normalized.isError === true,
    structuredContent: safeResponseMetadata(normalized || {})
  } })
  if (metadata.expectToken) sample.expectedRenderToken = metadata.expectToken
  return sample
}

function normalizeToolResult(result) {
  if (!result) return null
  const content = Array.isArray(result.content) ? result.content.filter(item => item.type === 'text').map(item => item.text) : []
  const parsed = []
  for (const value of content) { try { parsed.push(JSON.parse(value)) } catch (_) { parsed.push(value) } }
  return { structuredContent: result.structuredContent || null, content: parsed, isError: result.isError === true }
}

function findRecursive(root, predicate, seen = new Set()) {
  if (!root || typeof root !== 'object' || seen.has(root)) return null
  seen.add(root)
  if (predicate(root)) return root
  for (const value of Object.values(root)) {
    const match = findRecursive(value, predicate, seen)
    if (match) return match
  }
  return null
}

function readPath(result) {
  const match = findRecursive(result, item => item && (item.path === 'direct' || item.path === 'full' || item.submissionPath === 'direct' || item.submissionPath === 'legacy'))
  return {
    path: match && match.path || null,
    submissionPath: match && match.submissionPath || null,
    fallbackReason: match && (match.fallbackReason || match.degradationReason) || null
  }
}

function safeError(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.replace(/(token|secret|password)\s*[:=]\s*[^,\s]+/ig, '$1=[redacted]').slice(0, 1200)
}

let uniqueTokenSequence = 0
function makeToken(source, sequence) {
  return `cp-${runToken}-${source}-${String(++uniqueTokenSequence).padStart(6, '0')}`
}

function latestExpectedByUid(expected, uid, text) {
  expected.set(uid, text)
}

async function registerRenderExpectation(pages, uid, text, token, source, writer, issuedAt, phase) {
  await Promise.all(pages.map(entry => entry.page.evaluate(({ uid, text, token, source, writer, issuedAt, phase }) => {
      const adapter=window.__perfRepairMindMap&&window.__perfRepairMindMap.cooperate&&window.__perfRepairMindMap.cooperate.collabV2Adapter
      const status=adapter&&adapter.getStatus&&adapter.getStatus()
      const revision=Number(status&&status.lastServerRevision)
      window.__cpRegisterExpected({uid,text,token,source,writer,issuedAt,phase,completed:false,versionFloor:Number.isFinite(revision)?revision+1:1})
    }, { uid, text, token, source, writer, issuedAt, phase })))
}

function instrumentationWatcherScript() {
  return `(() => {
    window.__cpExpectedByUid=window.__cpExpectedByUid||{};
    setInterval(()=>{try{const mm=window.__perfRepairMindMap;const renderer=mm&&mm.renderer;if(!renderer)return;
      for(const item of Object.values(window.__cpExpectedByUid)){if(item.completed)continue;const node=renderer.findNodeByUid(item.uid);if(!node||window.__cpReadNodePlainText(node)!==item.text||renderer.isRendering!==false)continue;
        const matching=Array.from(document.querySelectorAll('.smm-node')).find(el=>(el.innerText||el.textContent||'').includes(item.text));if(!matching)continue;
        requestAnimationFrame(()=>requestAnimationFrame(()=>{try{const current=renderer.findNodeByUid(item.uid);const currentText=window.__cpReadNodePlainText(current);const dom=Array.from(document.querySelectorAll('.smm-node[data-node-uid]')).find(el=>el.getAttribute('data-node-uid')===item.uid);const rendered=!!dom&&(dom.innerText||dom.textContent||'').includes(item.text);if(current&&currentText===item.text&&rendered&&renderer.isRendering===false){item.completed=true;window.__cpTrace.rendered.push({token:item.token,uid:item.uid,source:item.source,writer:item.writer,issuedAt:item.issuedAt,epochMs:performance.timeOrigin+performance.now(),relativeMs:performance.now(),stable:true})}}catch(_){window.__cpTrace.observerErrors+=1}}))
      }
    }catch(_){window.__cpTrace.observerErrors+=1}},50)
  })();`
}

async function installHttpRefreshAttribution(pages) {
  const methodNames = ['refreshVisibleFromHttp', 'recoverHttpCollab', 'scheduleRemoteRecover']
  const rowsLimit = 400
  const installedPages = await Promise.all((pages || []).map(async entry => {
    const label = String(entry.label || 'browser')
    try {
      return await entry.page.evaluate(({ label, methodNames, rowsLimit }) => {
        const root = window.__perfRepairMindMap
        const cooperate = root && root.cooperate
        const state = window.__cpHttpRefreshAttribution || {
          rows: [], overwritten: 0, total: 0, byMethod: {}, byOutcome: {},
          installedMethods: [], missingMethods: [], installErrors: 0, rowsLimit
        }
        state.rowsLimit = rowsLimit
        state.rows = Array.isArray(state.rows) ? state.rows : []
        state.byMethod = state.byMethod || {}
        state.byOutcome = state.byOutcome || {}
        state.installedMethods = Array.isArray(state.installedMethods) ? state.installedMethods : []
        state.missingMethods = []
        window.__cpHttpRefreshAttribution = state

        const finiteVersion = value => {
          if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return value
          if (typeof value === 'string' && /^\d{1,10}$/.test(value)) return Number(value)
          return null
        }
        const versionFromArgs = (method, callArgs) => {
          if (method === 'scheduleRemoteRecover' || method === 'recoverHttpCollab') {
            const first = finiteVersion(callArgs[0])
            if (first !== null) return first
          }
          for (const value of callArgs) {
            if (!value || typeof value !== 'object') continue
            for (const key of ['targetVersion', 'version', 'revision', 'serverRevision']) {
              try {
                const version = finiteVersion(value[key])
                if (version !== null) return version
              } catch (_) {}
            }
          }
          return null
        }
        const forceFromArgs = callArgs => {
          for (const value of callArgs) {
            if (!value || typeof value !== 'object') continue
            try { if (value.force === true) return true } catch (_) {}
            try { if (value.force === false) return false } catch (_) {}
          }
          return null
        }
        const callerFunctions = () => {
          const lines = String(new Error().stack || '').split('\n').slice(2)
          const names = []
          for (const line of lines) {
            let name = ''
            const v8 = line.match(/^\s*at\s+(?:async\s+)?([^\s(]+)/)
            if (v8) name = v8[1]
            else {
              const gecko = line.match(/^\s*([^@\s]+)@/)
              if (gecko) name = gecko[1]
            }
            if (!name || /[\\/:?#]/.test(name) || /^(?:wrapped|callerFunctions|new Error)$/i.test(name) || /\.wrapped$/i.test(name)) continue
            names.push(name.slice(0, 100))
            if (names.length >= 5) break
          }
          return names
        }
        const watermarks = () => {
          let lastAppliedVersion = null
          let adapterLastServerRevision = null
          try {
            const value = Number(cooperate && cooperate.lastAppliedVersion)
            if (Number.isFinite(value)) lastAppliedVersion = value
          } catch (_) {}
          try {
            const adapter = cooperate && cooperate.collabV2Adapter
            const status = adapter && typeof adapter.getStatus === 'function' ? adapter.getStatus() : null
            const value = Number(status && status.lastServerRevision != null
              ? status.lastServerRevision : adapter && adapter.lastServerRevision)
            if (Number.isFinite(value)) adapterLastServerRevision = value
          } catch (_) {}
          return { lastAppliedVersion, adapterLastServerRevision }
        }

        if (!cooperate) {
          state.missingMethods = methodNames.slice()
          return { label, available: false, installedMethods: [], missingMethods: state.missingMethods.slice(), installErrors: state.installErrors }
        }
        for (const method of methodNames) {
          const original = cooperate[method]
          if (typeof original !== 'function') {
            state.missingMethods.push(method)
            continue
          }
          if (original.__cpHttpRefreshAttributed === true) {
            if (!state.installedMethods.includes(method)) state.installedMethods.push(method)
            continue
          }
          const wrapped = function (...callArgs) {
            const startedAt = Date.now()
            const marks = watermarks()
            const row = {
              method,
              callerFunctions: callerFunctions(),
              targetVersion: versionFromArgs(method, callArgs),
              force: forceFromArgs(callArgs),
              lastAppliedVersion: marks.lastAppliedVersion,
              adapterLastServerRevision: marks.adapterLastServerRevision,
              startedAt,
              endedAt: null,
              durationMs: null,
              outcome: 'pending'
            }
            state.total += 1
            state.byMethod[method] = (state.byMethod[method] || 0) + 1
            if (state.rows.length >= rowsLimit) {
              state.rows.shift()
              state.overwritten += 1
            }
            state.rows.push(row)
            let finished = false
            const finish = outcome => {
              if (finished) return
              finished = true
              row.endedAt = Date.now()
              row.durationMs = Math.max(0, row.endedAt - row.startedAt)
              row.outcome = outcome
              state.byOutcome[outcome] = (state.byOutcome[outcome] || 0) + 1
            }
            let result
            try {
              result = original.apply(this, callArgs)
            } catch (error) {
              finish('threw')
              throw error
            }
            try {
              const then = result && result.then
              if (typeof then === 'function') {
                try {
                  then.call(result, () => finish('fulfilled'), () => finish('rejected'))
                } catch (_) {
                  finish('thenable_unobserved')
                }
                return result
              }
            } catch (_) {
              finish('thenable_unobserved')
              return result
            }
            finish('returned')
            return result
          }
          try {
            Object.defineProperty(wrapped, '__cpHttpRefreshAttributed', { value: true })
            cooperate[method] = wrapped
            if (cooperate[method] === wrapped) {
              if (!state.installedMethods.includes(method)) state.installedMethods.push(method)
            } else {
              state.installErrors += 1
            }
          } catch (_) {
            state.installErrors += 1
          }
        }
        return {
          label, available: true, installedMethods: state.installedMethods.filter(name => methodNames.includes(name)),
          missingMethods: state.missingMethods.slice(), installErrors: state.installErrors
        }
      }, { label, methodNames, rowsLimit })
    } catch (error) {
      return { label, available: false, reason: 'page_evaluate_failed', errorName: String(error && error.name || 'Error') }
    }
  }))
  const coveredPages = installedPages.filter(page => page.available && page.installedMethods.length > 0).length
  return {
    rowsLimit,
    pageCount: installedPages.length,
    coveredPages,
    status: coveredPages === installedPages.length ? 'installed' : coveredPages > 0 ? 'partial' : 'unavailable',
    pages: installedPages
  }
}

async function collectHttpRefreshAttribution(pages) {
  const rowsLimit = 400
  const pageSnapshots = await Promise.all((pages || []).map(async entry => {
    const label = String(entry.label || 'browser')
    try {
      return await entry.page.evaluate(({ label, rowsLimit }) => {
        const state = window.__cpHttpRefreshAttribution
        if (!state) return { label, available: false, reason: 'not_installed', total: 0, overwritten: 0, rows: [] }
        const rows = Array.isArray(state.rows) ? state.rows.slice(-rowsLimit) : []
        const byMethod = state.byMethod && typeof state.byMethod === 'object' ? { ...state.byMethod } : {}
        const byOutcome = state.byOutcome && typeof state.byOutcome === 'object' ? { ...state.byOutcome } : {}
        return {
          label, available: true,
          installedMethods: Array.isArray(state.installedMethods) ? state.installedMethods.slice() : [],
          missingMethods: Array.isArray(state.missingMethods) ? state.missingMethods.slice() : [],
          installErrors: Number(state.installErrors) || 0,
          total: Number(state.total) || 0,
          overwritten: Number(state.overwritten) || 0,
          byMethod, byOutcome, rows
        }
      }, { label, rowsLimit })
    } catch (error) {
      return { label, available: false, reason: 'page_evaluate_failed', errorName: String(error && error.name || 'Error'), total: 0, overwritten: 0, rows: [] }
    }
  }))
  const allRows = pageSnapshots.flatMap(page => Array.isArray(page.rows) ? page.rows : [])
    .sort((left, right) => Number(left.startedAt || 0) - Number(right.startedAt || 0))
  const globalRetentionDroppedRows = Math.max(0, allRows.length - rowsLimit)
  const rows = allRows.slice(-rowsLimit)
  const byMethod = {}
  const byOutcome = {}
  for (const page of pageSnapshots) {
    for (const [name, count] of Object.entries(page.byMethod || {})) byMethod[name] = (byMethod[name] || 0) + (Number(count) || 0)
    for (const [name, count] of Object.entries(page.byOutcome || {})) byOutcome[name] = (byOutcome[name] || 0) + (Number(count) || 0)
  }
  const total = pageSnapshots.reduce((sum, page) => sum + (Number(page.total) || 0), 0)
  const ringOverwritten = pageSnapshots.reduce((sum, page) => sum + (Number(page.overwritten) || 0), 0)
  const completed = Object.values(byOutcome).reduce((sum, count) => sum + (Number(count) || 0), 0)
  const availablePages = pageSnapshots.filter(page => page.available).length
  const installedPages = pageSnapshots.filter(page => page.available && page.installedMethods && page.installedMethods.length > 0).length
  return {
    capturedAt: new Date().toISOString(),
    rowsLimit,
    pageCount: pageSnapshots.length,
    availablePages,
    installedPages,
    coverage: pageSnapshots.map(page => ({ label: page.label, available: page.available,
      installedMethods: page.installedMethods || [], missingMethods: page.missingMethods || [],
      installErrors: Number(page.installErrors) || 0, total: Number(page.total) || 0,
      capturedRows: Array.isArray(page.rows) ? page.rows.length : 0, overwritten: Number(page.overwritten) || 0,
      reason: page.reason || null })),
    totals: { calls: total, completed, pending: Math.max(0, total - completed), byMethod, byOutcome },
    capturedRows: rows.length,
    ringOverwritten,
    globalRetentionDroppedRows,
    overwritten: ringOverwritten + globalRetentionDroppedRows,
    rows
  }
}

async function setupBrowserContexts(chromium, gateways, roomKey, identities, visibleUids) {
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
  const contexts = []
  const pages = []
  try {
    for (let index = 0; index < (args['mechanics-one-client'] ? 1 : BROWSER_CLIENTS); index += 1) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
      contexts.push(context)
      const page = await context.newPage()
      const gateway = gateways[Math.floor(index / Math.ceil(BROWSER_CLIENTS / gateways.length))]
      const item = await prepareBrowserPage(page, gateway.origin, roomKey, identities[index], `browser-${String(index + 1).padStart(2, '0')}`)
      pages.push(item)
      assert(item.readyStats.state && (item.readyStats.state.status === 'live' || item.readyStats.state.phase === 'LIVE'), `${item.label} 未进入协作 live`)
      await ensureVisibleBranch(item, `cp-${runToken}-branch-0`)
    }
    const visibleSets = pages.map(item => new Set(item.readyStats.visibleBranch.viewportVisibleUids || []))
    const sharedVisibleUids = visibleUids.filter(uid => visibleSets.every(set => set.has(uid)))
    assert(sharedVisibleUids.length >= BROWSER_CLIENTS + 1,
      `${renderMode} 模式下所有客户端自然视口 DOM 可见 UID 交集仅 ${sharedVisibleUids.length}，不足10个浏览器与MCP目标`)
    append(eventsPath, { type: 'browser-visible-uid-intersection', renderMode, clients: pages.length,
      count: sharedVisibleUids.length, selected: sharedVisibleUids.slice(0, BROWSER_CLIENTS) })
    return { browser, contexts, pages, visibleUids: sharedVisibleUids }
  } catch (error) {
    await browser.close().catch(() => {})
    throw error
  }
}

async function captureBrowserVisibility(pages, phase) {
  const clients = await Promise.all(pages.map(async entry => {
    const result = await entry.page.evaluate(async () => {
      const capturedAt = new Date().toISOString()
      const started = performance.now()
      let timer = null
      const frames = new Promise(resolve => {
        requestAnimationFrame(first => {
          requestAnimationFrame(second => resolve({ intervalMs: second - first, totalMs: second - started }))
        })
      })
      const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), 3000) })
      const twoFrameProbe = await Promise.race([frames, timeout])
      if (timer) clearTimeout(timer)
      return { capturedAt, visibilityState: document.visibilityState, twoFrameProbe, timedOut: !twoFrameProbe }
    }).catch(error => ({ visibilityState: 'probe_error', error: safeError(error.message), twoFrameProbe: null, timedOut: true }))
    return { label: entry.label, ...result }
  }))
  const probe = { phase, capturedAt: new Date().toISOString(), clients,
    hiddenClients: clients.filter(row => row.visibilityState !== 'visible').map(row => row.label),
    timedOutClients: clients.filter(row => row.timedOut).map(row => row.label),
    twoFrameInterval: metric(clients.map(row => row.twoFrameProbe && row.twoFrameProbe.intervalMs).filter(Number.isFinite)),
    note: 'All pages are measured with identical Chromium flags. Visibility and two-RAF timing are evidence; background throttling is not reported as product render latency.' }
  append(eventsPath, { type: 'browser-visibility-raf-probe', ...probe })
  return probe
}

async function dispatchBrowserEdit(writer, pages, uid, text, token, phase, expected, preRegistered = false) {
  const issuedAt = Date.now()
  latestExpectedByUid(expected, uid, text)
  if (!preRegistered) await registerRenderExpectation(pages, uid, text, token, 'browser', writer.label, issuedAt, phase)
  const result = await runBrowserWrite(writer, uid, text, token, phase)
  return { issuedAt, ...result }
}

async function verifyMcpSingleTool(mcp) {
  const tool = mcp.tools.get('update_node')
  assert(tool, `MCP tools/list 未声明 update_node；可用写入工具=${[...mcp.tools.keys()].filter(name => /node|apply/i.test(name)).join(',')}`)
  return tool
}

function buildIsolatedMcpDiagnosticArgs(tool, writerAfter) {
  const args = {}
  const props = tool && tool.inputSchema && tool.inputSchema.properties || {}
  if (props.writer_after && Number.isSafeInteger(Number(writerAfter)) && Number(writerAfter) >= 0) args.writer_after = Number(writerAfter)
  if (props.path) args.path = 'full'
  if (props.windowMinutes) args.windowMinutes = 15
  if (props.minutes) args.minutes = 15
  return args
}

function roomScopedApiDiagnosticsUrl(apiPort, roomKey, since) {
  const url = new URL(`http://127.0.0.1:${apiPort}/api/diagnostics/performance`)
  url.searchParams.set('room', String(roomKey))
  url.searchParams.set('since', String(since))
  return url.toString()
}

function projectMcpHttpEvents(sample, processId, registry) {
  const events = sample && Array.isArray(sample.events) ? sample.events : []
  const allowedStages = new Set(['request-received', 'body-complete', 'body-parsed', 'transport-dispatched',
    'request-aborted', 'response-finish', 'response-close'])
  return events.flatMap(row => {
    if (!row || row.kind !== 'mcp-http' || typeof row.clientRequestId !== 'string' || !SAFE_UUID_RE.test(row.clientRequestId)) return []
    const request = registry.get(row.clientRequestId)
    if (!request) return []
    const projected = {
      type: 'mcp-http-lifecycle', scope: 'isolated-mcp-process', processId: Number.isFinite(Number(processId)) ? Number(processId) : null,
      phase: request.phase, diagnosticPhase: request.diagnosticPhase || null,
      seq: Number.isSafeInteger(row.seq) ? row.seq : null,
      requestId: typeof row.requestId === 'string' && SAFE_UUID_RE.test(row.requestId) ? row.requestId : null,
      clientRequestId: row.clientRequestId,
      operationId: typeof row.operationId === 'string' && SAFE_UUID_RE.test(row.operationId) ? row.operationId : request.operationId,
      stage: allowedStages.has(row.stage) ? row.stage : 'other',
      method: ['GET', 'POST', 'DELETE', 'OPTIONS', 'other'].includes(row.method) ? row.method : 'other',
      durationMs: Number.isFinite(row.durationMs) ? Math.max(0, row.durationMs) : null,
      status: Number.isFinite(row.status) ? row.status : null,
      bodyComplete: typeof row.bodyComplete === 'boolean' ? row.bodyComplete : null,
      bodyParsed: typeof row.bodyParsed === 'boolean' ? row.bodyParsed : null,
      headersSent: typeof row.headersSent === 'boolean' ? row.headersSent : null,
      responseFinished: typeof row.responseFinished === 'boolean' ? row.responseFinished : null,
      sessionPresent: typeof row.sessionPresent === 'boolean' ? row.sessionPresent : null,
    }
    return [projected]
  })
}

function consumeMcpWriterSnapshot(payload, phase) {
  const writer = payload && payload.mcpWriter
  const sample = writer && writer.samples
  if (!writer || !sample) return { available: false, reason: 'mcp_writer_snapshot_unavailable', scope: 'isolated-mcp-process' }
  const processId = Number.isFinite(Number(writer.processId)) ? Number(writer.processId) : null
  let processChanged = false
  if (mcpWriterProcessId != null && processId != null && processId !== mcpWriterProcessId) {
    mcpWriterCursor = 0
    processChanged = true
  }
  if (processId != null) mcpWriterProcessId = processId
  const requestAfter = mcpWriterCursor
  const correlated = projectMcpHttpEvents(sample, processId, new Map([...mcpRequestRegistry].map(([id, item]) => [id, { ...item, diagnosticPhase: phase }])))
  let persistedCount = 0
  for (const row of correlated) {
    const key = `${row.processId || 'unknown'}:${row.seq == null ? `${row.clientRequestId}:${row.stage}:${row.durationMs}` : row.seq}`
    if (mcpWriterSeenEvents.has(key)) continue
    mcpWriterSeenEvents.add(key)
    append(eventsPath, row)
    persistedCount += 1
  }
  if (sample.cursorResetRequired === true) mcpWriterCursor = 0
  else if (Number.isSafeInteger(sample.cursor) && sample.cursor >= 0) mcpWriterCursor = sample.cursor
  return {
    available: true, scope: 'isolated-mcp-process', processId,
    requestAfter, cursor: Number.isSafeInteger(sample.cursor) ? sample.cursor : null,
    oldestRetainedCursor: Number.isSafeInteger(sample.oldestRetainedCursor) ? sample.oldestRetainedCursor : null,
    cursorResetRequired: sample.cursorResetRequired === true, retentionGap: sample.retentionGap === true,
    processChanged, capacity: Number.isFinite(sample.capacity) ? sample.capacity : null,
    overwritten: Number.isFinite(sample.overwritten) ? sample.overwritten : null,
    matchedLifecycleEventCount: correlated.length,
    correlatedEventsPersistedCount: persistedCount,
    queue: writer.queue && typeof writer.queue === 'object' ? {
      queuedGlobal: Number.isFinite(writer.queue.queuedGlobal) ? writer.queue.queuedGlobal : null,
      activeGlobal: Number.isFinite(writer.queue.activeGlobal) ? writer.queue.activeGlobal : null,
      queuedBytes: Number.isFinite(writer.queue.queuedBytes) ? writer.queue.queuedBytes : null,
    } : null,
  }
}

async function mcpDiagnostics(mcp, diagnosticsToken, phase, roomKey) {
  const tool = mcp.tools.get('get_performance_diagnostics')
  if (!tool) return { available: false, reason: 'tool_missing' }
  const toolArguments = buildIsolatedMcpDiagnosticArgs(tool, mcpWriterCursor)
  const sample = await callMcpTool(mcp, diagnosticsToken, 'get_performance_diagnostics', toolArguments, randomUUID(), { category: 'diagnostic', phase })
  const payload = diagnosticPayload(sample.result)
  const writer = consumeMcpWriterSnapshot(payload, phase)
  const file = path.join(runDir, `diagnostics-${variant}-${renderMode}-${phase}.json`)
  fs.writeFileSync(file, JSON.stringify({ available: true, scope: 'isolated-mcp-process', phase,
    writer, outcome: sample.outcome, error: sample.error ? safePersistedError(sample.error) : null }, null, 2) + '\n')
  return { available: sample.outcome === 'success', outcome: sample.outcome, path: path.basename(file), error: sample.error,
    snapshotCounters: null, writer }
}

function diagnosticPayload(result) {
  const content = result && Array.isArray(result.content) ? result.content : []
  for (const item of content) {
    if (item && typeof item === 'object') return item
    if (typeof item === 'string') { try { return JSON.parse(item) } catch (_) {} }
  }
  return result && result.structuredContent || null
}

function extractSnapshotCounters(payload) {
  const rows = payload && Array.isArray(payload.summary) ? payload.summary : []
  return rows.filter(row => row.kind === 'http' && /\/(?:snapshot|export)(?:\/|$)/i.test(String(row.route || '')))
    .map(row => ({ key: `${row.source || 'unknown'}|${row.route}`, source: row.source || 'unknown', route: row.route,
      count: Number(row.count) || 0, lastCount: row.lastCount == null ? null : Number(row.lastCount) }))
}

async function diagnosticsEndpointProbe(diagnosticsToken, roomKey = '', apiPort = API_PORT, after = 0) {
  const url = new URL(`http://127.0.0.1:${apiPort}/api/diagnostics/performance`)
  if (roomKey) url.searchParams.set('room', roomKey)
  url.searchParams.set('after', String(Math.max(0, Number(after) || 0)))
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${diagnosticsToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000)
  })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch (_) { body = { text: text.slice(0, 1000) } }
  return { available: response.status === 200, status: response.status, body }
}

function createApiCommitMarkerCollector(diagnosticsToken, roomKey) {
  const state = {
    startedAt: null, endedAt: null, cursor: 0, polls: 0, skippedBusyPolls: 0,
    failedPolls: 0, retentionGaps: [], cursorResets: [], commitMarkers: [],
    duplicateEvents: 0, droppedCommitMarkers: 0, maxCommitMarkers: 10000,
    clockSamples: [], lastError: null
  }
  let timer = null
  let inFlight = null
  const seenSeq = new Set()

  const poll = reason => {
    if (inFlight) {
      state.skippedBusyPolls += reason === 'interval' ? 1 : 0
      return inFlight
    }
    const startedAt = Date.now()
    inFlight = (async () => {
      const result = await diagnosticsEndpointProbe(diagnosticsToken, roomKey, API_PORT, state.cursor)
      const endedAt = Date.now()
      state.polls += 1
      if (!result.available || !result.body) {
        state.failedPolls += 1
        state.lastError = `HTTP ${result.status}`
        return
      }
      const body = result.body
      const serverTime = Number(body.serverTime)
      if (Number.isFinite(serverTime)) {
        const midpoint = (startedAt + endedAt) / 2
        state.clockSamples.push({ localStartedAt: startedAt, localEndedAt: endedAt, serverTime,
          estimatedOffsetMs: serverTime - midpoint, requestRttMs: endedAt - startedAt,
          uncertaintyMs: (endedAt - startedAt) / 2 + 1 })
      }
      if (body.retentionGap) state.retentionGaps.push({ at: endedAt, after: state.cursor, oldestRetainedCursor: body.oldestRetainedCursor, cursor: body.cursor })
      if (body.cursorResetRequired) state.cursorResets.push({ at: endedAt, after: state.cursor, cursor: body.cursor })
      const events = Array.isArray(body.events) ? body.events : []
      for (const row of events) {
        if (!row || row.kind !== 'mcp-write' || row.stage !== 'commit' || !row.operationId) continue
        const key = Number.isFinite(Number(row.seq)) ? `seq:${row.seq}` : `${row.operationId}|${row.at}|${row.stage}`
        if (seenSeq.has(key)) { state.duplicateEvents += 1; continue }
        seenSeq.add(key)
        if (state.commitMarkers.length >= state.maxCommitMarkers) {
          state.commitMarkers.shift()
          state.droppedCommitMarkers += 1
        }
        const eventAtMs = Number.isFinite(Number(row.at)) ? Number(row.at) : Date.parse(row.at)
        state.commitMarkers.push({ seq: row.seq == null ? null : Number(row.seq), operationId: String(row.operationId),
          at: row.at, atMs: Number.isFinite(eventAtMs) ? eventAtMs : null, path: row.path || null, outcome: row.outcome || null,
          ok: row.ok === true, type: row.type || null, source: row.source || null, processId: body.processId || null })
      }
      if (Number.isFinite(Number(body.cursor))) state.cursor = Math.max(state.cursor, Number(body.cursor))
      state.lastError = null
    })().catch(error => {
      state.failedPolls += 1
      state.lastError = safeError(error.message)
    }).finally(() => { inFlight = null })
    return inFlight
  }

  return {
    async start() {
      state.startedAt = Date.now()
      await poll('start')
      timer = setInterval(() => { poll('interval').catch(() => {}) }, 1000)
      return state
    },
    async stop() {
      if (timer) clearInterval(timer)
      timer = null
      if (inFlight) await inFlight
      await poll('stop')
      state.endedAt = Date.now()
      const offsets = state.clockSamples.map(row => row.estimatedOffsetMs)
      const uncertainties = state.clockSamples.map(row => row.uncertaintyMs)
      const rtts = state.clockSamples.map(row => row.requestRttMs)
      return {
        startedAt: state.startedAt, endedAt: state.endedAt, endpoint: `API A /api/diagnostics/performance?room=${roomKey}&after=<cursor>`,
        cursor: state.cursor, polls: state.polls, skippedBusyPolls: state.skippedBusyPolls,
        failedPolls: state.failedPolls, lastError: state.lastError, retentionGaps: state.retentionGaps,
        cursorResets: state.cursorResets, duplicateEvents: state.duplicateEvents,
        droppedCommitMarkers: state.droppedCommitMarkers, commitMarkerCount: state.commitMarkers.length,
        commitMarkers: state.commitMarkers,
        clockAlignment: {
          source: 'API Date.now() serverTime bracketed by harness Date.now() on the same local Docker host',
          estimatedOffsetRangeMs: offsets.length ? { min: Math.min(...offsets), max: Math.max(...offsets) } : null,
          maximumObservedRequestRttMs: rtts.length ? Math.max(...rtts) : null,
          maximumEstimatedOffsetUncertaintyMs: uncertainties.length ? Math.max(...uncertainties) : null,
          timestampGranularityMs: 1,
          samples: state.clockSamples
        },
        status: state.failedPolls === 0 && state.retentionGaps.length === 0 && state.cursorResets.length === 0 && state.droppedCommitMarkers === 0 ? 'complete' : 'incomplete'
      }
    }
  }
}

async function captureDatabaseClockAlignment(dbName) {
  const { Pool } = pgModule()
  const pool = new Pool({ ...PG, database: dbName, max: 1, connectionTimeoutMillis: 5000 })
  try {
    const localStartedAt = Date.now()
    const result = await pool.query('select clock_timestamp() as database_time')
    const localEndedAt = Date.now()
    const databaseTimeMs = new Date(result.rows[0].database_time).getTime()
    return {
      localStartedAt, localEndedAt, databaseTimeMs,
      estimatedOffsetMs: databaseTimeMs - (localStartedAt + localEndedAt) / 2,
      offsetIntervalMs: [databaseTimeMs - localEndedAt, databaseTimeMs - localStartedAt],
      requestRttMs: localEndedAt - localStartedAt,
      uncertaintyMs: (localEndedAt - localStartedAt) / 2 + 1,
      timestampGranularityMs: 1,
      note: 'PostgreSQL clock_timestamp is bracketed by the harness wall clock; room_operations.created_at remains a transaction-start upper-bound anchor, not the commit instant.'
    }
  } finally { await pool.end() }
}

async function captureApiInstanceDiagnostics(diagnosticsToken, roomKey, phase) {
  const instances = await Promise.all([
    diagnosticsEndpointProbe(diagnosticsToken, roomKey, API_PORT),
    diagnosticsEndpointProbe(diagnosticsToken, roomKey, API_PORT_B)
  ])
  const result = { phase, capturedAt: new Date().toISOString(), apiA: instances[0], apiB: instances[1] }
  const file = path.join(runDir, `diagnostics-api-${renderMode}-${phase}.json`)
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n')
  return { path: path.basename(file),
    apiA: { available: instances[0].available, status: instances[0].status, snapshotCounters: extractSnapshotCounters(instances[0].body) },
    apiB: { available: instances[1].available, status: instances[1].status, snapshotCounters: extractSnapshotCounters(instances[1].body) } }
}

function snapshotCounterDelta(before, after) {
  const previous = new Map((before || []).map(row => [row.key, Number(row.count) || 0]))
  const current = new Map((after || []).map(row => [row.key, Number(row.count) || 0]))
  const keys = new Set([...previous.keys(), ...current.keys()])
  return [...keys].map(key => ({ key, delta: Math.max(0, (current.get(key) || 0) - (previous.get(key) || 0)) }))
    .filter(row => row.delta > 0)
}

function collectOrdinarySnapshotEvidence(diagnostics) {
  const baselineApi = diagnostics.apiPreload
  if (!baselineApi || !baselineApi.apiA || !baselineApi.apiB) {
    return { available: false, reason: 'ordinary-load baseline diagnostics are incomplete', phases: [], noUnexpectedSnapshots: false }
  }
  const rowsForSource = (rows, source) => (rows || []).filter(row => source === 'mcp' ? row.source === 'mcp' : row.source !== 'mcp')
  const baselineMcp = rowsForSource(baselineApi.apiA.snapshotCounters, 'mcp')
  const baselineApiA = rowsForSource(baselineApi.apiA.snapshotCounters, 'api')
  const baselineApiB = rowsForSource(baselineApi.apiB.snapshotCounters, 'api')
  const checks = []
  const addPhase = (phase, mcp, api) => {
    if (!mcp || !api || !api.apiA || !api.apiB) { checks.push({ phase, available: false, mcp: [], apiA: [], apiB: [] }); return }
    checks.push({ phase, available: mcp.available === true && api.apiA.available === true && api.apiB.available === true,
      mcp: snapshotCounterDelta(baselineMcp, rowsForSource(api.apiA.snapshotCounters, 'mcp')),
      apiA: snapshotCounterDelta(baselineApiA, rowsForSource(api.apiA.snapshotCounters, 'api')),
      apiB: snapshotCounterDelta(baselineApiB, rowsForSource(api.apiB.snapshotCounters, 'api')) })
  }
  if (diagnostics.mcpWarmupPrecheck) {
    addPhase('load-precheck-30s', diagnostics.mcpWarmupPrecheck, diagnostics.apiWarmupPrecheck)
  } else {
    for (const round of ['round-1','round-2','round-3']) addPhase(round, diagnostics[`mcp-${round}`], diagnostics[`api-${round}`])
    addPhase('batch100+event-burst-100', diagnostics.mcpAfterBatch, diagnostics.apiAfterBatch)
    if (diagnostics.mcpSustained) addPhase('sustained-10m', diagnostics.mcpSustained, diagnostics.apiSustained)
  }
  const requiredPhaseCount = diagnostics.mcpWarmupPrecheck ? 1 : (diagnostics.mcpSustained ? 5 : 4)
  const available = checks.length === requiredPhaseCount && checks.every(row => row.available)
  const noUnexpectedSnapshots = available && checks.every(row => row.mcp.length === 0 && row.apiA.length === 0 && row.apiB.length === 0)
  return { available, baselinePhase: 'preload-after-interactive-keyboard-check', phases: checks, noUnexpectedSnapshots }
}

const activePgWaitSamplers = new Set()
const activeQueueSamplers = new Set()
const activeControlReadSamplers = new Set()
function createControlReadSampler({ pages, roomKey, phase, sampleAt }) {
  const pending = new Set()
  const origin = new URL(pages[0].page.url()).origin
  const routes = [
    { route: '/api/files/:room/meta', url: `http://127.0.0.1:${API_PORT}/api/files/${encodeURIComponent(roomKey)}?format=meta` },
    { route: '/api/maps/:room/version', url: `http://127.0.0.1:${API_PORT_B}/api/maps/${encodeURIComponent(roomKey)}/version` }
  ]
  const poll = () => {
    for (const route of routes) {
      const startedAt = Date.now()
      const task = requestJson(route.url, { headers: authHeaders(pages[0].identity.cookie, origin), signal: AbortSignal.timeout(5000) })
        .then(result => append(samplesPath, { category: 'control-read', phase: startedAt < sampleAt ? `${phase}-warmup` : phase,
          source: 'control', method: 'GET', route: route.route, startedAt, completedAt: Date.now(),
          latencyMs: Date.now() - startedAt, status: result.response.status, outcome: result.response.ok ? 'response' : 'http_error' }))
        .catch(error => append(samplesPath, { category: 'control-read', phase: startedAt < sampleAt ? `${phase}-warmup` : phase,
          source: 'control', method: 'GET', route: route.route, startedAt, completedAt: Date.now(), latencyMs: Date.now() - startedAt,
          status: null, outcome: 'request_failed', error: safeError(error.message) }))
        .finally(() => pending.delete(task))
      pending.add(task)
    }
  }
  const timer = setInterval(poll, 2000)
  poll()
  const sampler = { async stop() {
    clearInterval(timer)
    await Promise.allSettled([...pending])
    activeControlReadSamplers.delete(sampler)
  } }
  activeControlReadSamplers.add(sampler)
  return sampler
}
function createQueueDepthSampler({ diagnosticsSession, diagnosticsToken, roomKey, phase, startedAt, sampleAt }) {
  let pending = null
  let stopped = false
  const poll = () => {
    if (stopped || pending) return
    const sentAt = Date.now()
    const args = buildIsolatedMcpDiagnosticArgs(diagnosticsSession.tools.get('get_performance_diagnostics'), mcpWriterCursor)
    const clientRequestId = randomUUID()
    pending = Promise.all([
      mcpRpc(`http://127.0.0.1:${MCP_PORT}/mcp`, diagnosticsToken, { jsonrpc: '2.0', id: diagnosticsSession.session.nextId++,
        method: 'tools/call', params: { name: 'get_performance_diagnostics', arguments: args } }, diagnosticsSession.session, false, 5000, clientRequestId),
      requestJson(roomScopedApiDiagnosticsUrl(API_PORT_B, roomKey, sentAt),
        { headers: { Authorization: `Bearer ${diagnosticsToken}` }, signal: AbortSignal.timeout(5000) })
    ]).then(([rpc, apiB]) => {
      const payload = diagnosticPayload(normalizeToolResult(rpc.body && rpc.body.result))
      const writer = consumeMcpWriterSnapshot(payload, sentAt < sampleAt ? `${phase}-warmup` : phase)
      const queue = writer && writer.queue
      const bridge = value => value && value.collaboration && value.collaboration.eventBridge
      const bridgeB = bridge(apiB.body || apiB.data || apiB)
      append(eventsPath, { type: 'queue-depth-sample', phase: sentAt < sampleAt ? `${phase}-warmup` : phase,
        at: Date.now(), requestedAt: sentAt, latencyMs: Date.now() - sentAt, available: !!queue,
        diagnosticClientRequestId: clientRequestId, mcpWriterScope: 'isolated-mcp-process', mcpWriter: writer,
        mcp: queue ? { currentDepth: queue.queuedGlobal, active: queue.activeGlobal, queuedBytes: queue.queuedBytes } : null,
        apiA: null, apiAUnavailableReason: 'room-scoped API A poll not added; do not use the global backend payload embedded in MCP diagnostics',
        apiB: bridgeB ? { currentDepth: bridgeB.queueLength, pendingDrains: bridgeB.pendingDrains, dbPoolWaiting: apiB.data?.runtime?.pool?.waiting } : null,
        reason: queue ? null : 'current_queue_snapshot_unavailable' })
    }).catch(error => append(eventsPath, { type: 'queue-depth-sample', phase, at: Date.now(), available: false, error: safePersistedError(error) }))
      .finally(() => { pending = null })
  }
  const timer = setInterval(poll, 5000)
  const sampler = { async stop() {
    stopped = true; clearInterval(timer)
    if (pending) await pending
    activeQueueSamplers.delete(sampler)
  } }
  activeQueueSamplers.add(sampler)
  return sampler
}
async function waitForBrowserWriteSettlement(pages, timeoutMs) {
  const startedAt = Date.now()
  let clients = []
  let idleSince = null
  do {
    clients = await Promise.all(pages.map(async entry => {
      try {
        return await entry.page.evaluate(label => {
          const mm = window.__perfRepairMindMap
          const adapter = mm && mm.cooperate && mm.cooperate.collabV2Adapter
          const state = adapter && adapter.getStatus && adapter.getStatus()
          return { label, available: !!state, pending: Number(state && state.outboxPending || 0),
            sending: Number(state && state.outboxSending || 0), sendingOpId: state && state.sendingOpId || null,
            revision: Number(state && state.lastServerRevision || 0), rendererIdle: !!(mm && mm.renderer && !mm.renderer.isRendering) }
        }, entry.label)
      } catch (error) { return { label: entry.label, available: false, error: safeError(error.message) } }
    }))
    const idle = clients.every(row => row.available && row.pending === 0 && row.sending === 0 && !row.sendingOpId && row.rendererIdle)
    if (!idle) idleSince = null
    else if (idleSince == null) idleSince = Date.now()
    if (idleSince != null && Date.now() - idleSince >= 500) return { settled: true, waitMs: Date.now() - startedAt, clients }
    await sleep(100)
  } while (Date.now() - startedAt < timeoutMs)
  return { settled: false, waitMs: Date.now() - startedAt, clients }
}

async function createPgWaitSampler(databaseName, phase) {
  assert(/^mcp_cp_20261014_[a-c]_[a-f0-9]{12}$/.test(databaseName), 'lock observer requires the exact isolated run database')
  const pool = new (pgModule().Pool)({ ...PG, database: databaseName, max: 1, application_name: 'mcp-acceptance-lock-observer', connectionTimeoutMillis: 5000 })
  let pending = null
  let stopped = false
  const sample = () => {
    if (stopped || pending) return
    const startedAt = Date.now()
    pending = pool.query(`select pid,state,wait_event_type,wait_event,xact_start,query_start,query,
      pg_blocking_pids(pid) as blocking_pids from pg_stat_activity
      where datname=$1 and pid<>pg_backend_pid() and state<>'idle'`, [databaseName])
      .then(result => append(eventsPath, { type: 'postgres-lock-observation', phase, at: Date.now(), latencyMs: Date.now() - startedAt,
        sessions: result.rows.map(row => ({ pid: row.pid, state: row.state, waitEventType: row.wait_event_type,
          waitEvent: row.wait_event, transactionStartedAt: row.xact_start, queryStartedAt: row.query_start,
          blockingPids: row.blocking_pids,
          queryKind: /from\s+rooms\b[\s\S]*for\s+update/i.test(row.query) ? 'room-write-lock'
            : /room_nodes/i.test(row.query) ? 'node-query' : /room_operations/i.test(row.query) ? 'operation-query'
              : /^\s*(begin|commit|rollback)/i.test(row.query) ? 'transaction-control'
                : /^\s*update\s+rooms/i.test(row.query) ? 'room-update' : 'other'
        })) }))
      .catch(error => append(eventsPath, { type: 'postgres-lock-observer-error', phase, at: Date.now(), error: safeError(error.message) }))
      .finally(() => { pending = null })
  }
  const timer = setInterval(sample, 2000)
  const sampler = { async stop() {
    if (stopped) return
    stopped = true; clearInterval(timer)
    if (pending) await pending
    await pool.end()
    activePgWaitSamplers.delete(sampler)
  } }
  activePgWaitSamplers.add(sampler)
  return sampler
}

async function runRound(options) {
  verifyDriverInputs()
  const { name, durationMs, sampleMs, pages, mcp, mcpToken, updateTool, roomKey, visibleUids, expectationMap, resourceSampler, databaseName, diagnosticsSession, diagnosticsToken } = options
  let startedAt
  let sampleAt
  const phase = name
  const promises = new Set()
  const schedulerErrors = []
  const browserTicks = new Array(BROWSER_CLIENTS).fill(0)
  const browserEditsCompleted = new Array(BROWSER_CLIENTS).fill(0)
  const browserKeyboardSubmissions = new Array(BROWSER_CLIENTS).fill(null).map(() => [])
  const mcpDispatches = []
  const mcpDispatchMisses = []
  let workerRuntimeMetrics = null
  let workerWriteSyncMetrics = null
  let workerDispatchSchedule = null
  let driverRuntimeMetrics = null
  let driverRuntimeMonitor = null
  const browserQueues = new Array(BROWSER_CLIENTS).fill(null).map(() => Promise.resolve())
  const expectedBrowserEditsPerClient = Math.floor(durationMs / BROWSER_EDIT_INTERVAL_MS)
  const expectedScheduledMcpCalls = Math.floor(durationMs * MCP_SINGLE_WRITES_PER_SECOND / 1000)
  const browserJobs = pages.map((page, index) => Array.from({ length: expectedBrowserEditsPerClient }, (_, i) => ({
    uid: visibleUids[index], token: makeToken(`browser${index + 1}`, i + 1), source: 'browser', writer: page.label,
    offsetMs: i * BROWSER_EDIT_INTERVAL_MS
  })))
  const mcpJobs = Array.from({ length: expectedScheduledMcpCalls }, (_, i) => ({
    uid: visibleUids[BROWSER_CLIENTS + ((i + 1) % Math.max(1, Math.min(300, visibleUids.length - BROWSER_CLIENTS)))],
    token: makeToken('mcp', i + 1), source: 'mcp', writer: 'mcp-writer', operationId: randomUUID(),
    offsetMs: i * (1000 / MCP_SINGLE_WRITES_PER_SECOND)
  }))
  const plannedExpectations = [...browserJobs.flat(), ...mcpJobs].map(job => ({ ...job, text: job.token,
    phase: job.offsetMs < durationMs - sampleMs ? `${phase}-warmup` : phase }))
  await Promise.all(pages.map(entry => entry.page.evaluate(items => {
    window.__cpRoundExpected = Object.fromEntries(items.map(item => [item.token, { ...item, completed: false }]))
    window.__cpRoundWatchUids = [...new Set(items.map(item => item.uid))]
    window.__cpInstallRenderCompleteHook()
  }, plannedExpectations)))
  startedAt = Date.now() + 1000
  driverRuntimeMonitor = startManagedRuntimeMonitor(`mcp-collab-driver:${phase}`, phase)
  sampleAt = startedAt + durationMs - sampleMs
  const queueSampler = createQueueDepthSampler({ diagnosticsSession, diagnosticsToken, roomKey, phase, startedAt, sampleAt })
  await Promise.all(pages.map(entry => entry.page.evaluate(({ start, sampleAt, durationMs, phase }) => {
    window.__cpWorkloadWindow = { startedAt: start, endedAt: start + durationMs, sampleAt, phase }
    window.__cpLastQueueSampleAt = 0
    for (const item of Object.values(window.__cpRoundExpected)) item.issuedAt = start + item.offsetMs
  }, { start: startedAt, sampleAt, durationMs, phase })))
  let mcpTick = 0
  let stopBrowserQueue = false
  const issueBrowser = async (index, sequence, plannedAt) => {
    const page = pages[index]
    const uidIndex = index
    const uid = visibleUids[uidIndex]
    const token = browserJobs[index][sequence - 1].token
    const text = token
    try {
      if (stopBrowserQueue) {
        append(samplesPath, { category: 'browser-input-error', phase: plannedAt < sampleAt ? `${phase}-warmup` : phase,
          source: 'browser', userId: page.identity.userId, token, uid, plannedAt, outcome: 'undrained_timeout',
          error: 'browser queue was stopped after the 90-second drain deadline', startedAt: Date.now() })
        return
      }
      const startedAt = Date.now()
      const operationPhase = plannedAt < sampleAt ? `${phase}-warmup` : phase
      const result = await dispatchBrowserEdit(page, pages, uid, text, token, operationPhase, expectationMap, true)
      browserEditsCompleted[index] += 1
      if (Number.isFinite(result.firstKeyAt) && Number.isFinite(result.keyboardSubmittedAt)) {
        browserKeyboardSubmissions[index].push({ sequence, plannedAt, firstKeyAt: result.firstKeyAt,
          keyboardSubmittedAt: result.keyboardSubmittedAt, firstKeyLatenessMs: Math.max(0, result.firstKeyAt - plannedAt),
          submittedLatenessMs: Math.max(0, result.keyboardSubmittedAt - plannedAt) })
      }
      append(samplesPath, { category: 'browser-input-schedule', phase: operationPhase, source: 'browser', userId: page.identity.userId,
        token, uid, plannedAt, queuedStartedAt: startedAt, issuedAt: result.issuedAt, queueDelayMs: Math.max(0, startedAt - plannedAt),
        firstKeyAt: result.firstKeyAt, keyboardSubmittedAt: result.keyboardSubmittedAt,
        firstKeyLatenessMs: Number.isFinite(result.firstKeyAt) ? Math.max(0, result.firstKeyAt - plannedAt) : null,
        dispatchMs: result.dispatchMs, firstKeyEchoMs: result.firstKeyEchoMs, fullTypingMs: result.fullTypingMs,
        dispatchedTextVisible: result.textAfterDispatch === text })
    } catch (error) {
      schedulerErrors.push({ source: 'browser', index, error: error.message, at: Date.now() })
      append(samplesPath, { category: 'browser-input-error', phase: plannedAt < sampleAt ? `${phase}-warmup` : phase, source: 'browser',
        userId: page.identity.userId, token, uid, plannedAt, outcome: 'error', error: safeError(error.message), startedAt: Date.now() })
    }
  }
  const scheduleBrowserEdit = index => {
    if (browserTicks[index] >= expectedBrowserEditsPerClient) return
    const sequence = ++browserTicks[index]
    const plannedAt = startedAt + ((sequence - 1) * BROWSER_EDIT_INTERVAL_MS)
    const task = browserQueues[index].then(() => issueBrowser(index, sequence, plannedAt))
    browserQueues[index] = task.catch(() => {})
    promises.add(task); task.finally(() => promises.delete(task))
  }
  const workerOutput = path.join(path.dirname(samplesPath), `${phase}-worker.jsonl`)
  const pgWaitSampler = await createPgWaitSampler(databaseName, phase)
  const workerJobs = mcpJobs.map(job => ({
    plannedAt: startedAt + job.offsetMs,
    request: { jsonrpc: '2.0', id: job.operationId, method: 'tools/call', params: {
      name: 'update_node', arguments: toolArgs(updateTool, roomKey, job.uid, job.token, job.operationId)
    } },
    meta: { category: 'mcp-single-write', phase: job.offsetMs < durationMs - sampleMs ? `${phase}-warmup` : phase,
      operationId: job.operationId, uid: job.uid }
  }))
  for (const job of workerJobs) {
    const operationId = job.meta.operationId
    mcpRequestRegistry.set(operationId, { operationId, phase: job.meta.phase })
  }
  const worker = new Worker(path.join(__dirname, 'mcp-collab-load-worker.cjs'), { workerData: {
    url: `http://127.0.0.1:${MCP_PORT}/mcp`, token: mcpToken, sessionId: mcp.session.id,
    phase,
    startAt: startedAt, windowEndAt: startedAt + durationMs,
    dispatchIntervalMs: 1000 / MCP_SINGLE_WRITES_PER_SECOND, maxDispatchLatenessMs: 50,
    jobs: workerJobs, outputPath: workerOutput
  } })
  const workerFinished = new Promise((resolve, reject) => {
    worker.on('message', message => {
      if (message.type === 'dispatch') { mcpDispatches.push(message); mcpTick += 1 }
      else if (message.type === 'missed') mcpDispatchMisses.push(message)
      else if (message.type === 'runtime-monitor') {
        workerRuntimeMetrics = message.metrics
        workerWriteSyncMetrics = message.syncJsonlWrite || null
        append(eventsPath, { type: 'worker-runtime-monitor', phase: message.phase || phase,
          observedScope: message.observedScope || message.metrics && message.metrics.observedScope || null,
          metrics: message.metrics, syncJsonlWrite: workerWriteSyncMetrics })
      } else if (message.type === 'done') {
        workerDispatchSchedule = message.dispatchSchedule || null
      }
    })
    worker.once('error', reject)
    worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`MCP load worker exit ${code}`)))
  })
  promises.add(workerFinished)
  workerFinished.finally(() => promises.delete(workerFinished)).catch(() => {})
  await sleep(Math.max(0, startedAt - Date.now()))
  const controlReadSampler = createControlReadSampler({ pages, roomKey, phase, sampleAt })
  const browserTimers = pages.flatMap((_, index) => browserJobs[index].map(job =>
    setTimeout(() => scheduleBrowserEdit(index), Math.max(0, startedAt + job.offsetMs - Date.now()))))
  const resourceTimer = setInterval(() => resourceSampler(phase).catch(error => append(eventsPath, { type: 'resource-sample-error', phase,
    missingComponents: ['containers', 'postgres', 'redis'], error: safePersistedError(error) })), RESOURCE_SAMPLE_INTERVAL_MS)
  for (const page of pages) { page.currentPhase = `${phase}-warmup`; page.page.__cpCurrentPhase = `${phase}-warmup` }
  const samplePhaseTimer = setTimeout(() => { for (const page of pages) { page.currentPhase = phase; page.page.__cpCurrentPhase = phase } }, WARMUP_MS)
  append(eventsPath, { type: 'round-start', phase, startedAt, durationMs, warmupMs: WARMUP_MS, sampleMs, mcpRate: MCP_SINGLE_WRITES_PER_SECOND, browserCount: pages.length })
  await sleep(durationMs)
  const workloadEndedAt = Date.now()
  driverRuntimeMetrics = { ...driverRuntimeMonitor.stop(), phase, observedScope: 'setup-and-workload-window' }
  driverRuntimeMonitor = null
    append(eventsPath, { type: 'driver-runtime-monitor', phase, observedScope: driverRuntimeMetrics.observedScope,
      source: driverRuntimeMetrics.source,
      metrics: driverRuntimeMetrics })
  clearTimeout(samplePhaseTimer); clearInterval(resourceTimer); browserTimers.forEach(clearInterval)
  await controlReadSampler.stop()
  const drainDeadline = Date.now() + 90000
  while (promises.size && Date.now() < drainDeadline) await sleep(100)
  if (promises.size) {
    stopBrowserQueue = true
    await Promise.allSettled(browserQueues)
  }
  await workerFinished
  await queueSampler.stop()
  const browserSettlement = await waitForBrowserWriteSettlement(pages, Math.max(1, drainDeadline - Date.now()))
  await pgWaitSampler.stop()
  const workerRows = fs.readFileSync(workerOutput, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).filter(row => row.type === 'result')
  for (const row of workerRows.sort((a, b) => a.plannedAt - b.plannedAt)) {
    const rpcResult = row.response && row.response.result
    const normalized = normalizeToolResult(rpcResult)
    const pathValue = readPath(normalized)
    const outcome = row.outcome === 'success' && (!row.httpOk || !row.response || row.response.error || rpcResult && rpcResult.isError) ? 'error' : row.outcome
    append(samplesPath, { ...row, source: 'mcp', tool: 'update_node', requestStartedAt: row.startedAt,
      latencyMs: row.latencyMs, driverDispatchDelayMs: row.driverDispatchDelayMs,
      queueDelayMs: row.driverDispatchDelayMs, queueDelayScope: 'compatibility alias for driverDispatchDelayMs; not server queue time', outcome,
      path: pathValue.path, submissionPath: pathValue.submissionPath, fallbackReason: pathValue.fallbackReason,
      result: normalized, response: undefined, error: row.error || (outcome !== 'success' ? 'mcp_response_missing_or_rejected' : null) })
    if (outcome === 'success') {
      const sourceJob = mcpJobs.find(job => job.operationId === row.operationId)
      if (sourceJob) expectationMap.set(row.uid, sourceJob.token)
    }
  }
  const undrained = promises.size
  const minBrowserTickCount = Math.min(...browserTicks)
  const minBrowserCompletedCount = Math.min(...browserEditsCompleted)
  const browserSubmittedCounts = browserKeyboardSubmissions.map(rows => rows.length)
  const minBrowserSubmittedCount = Math.min(...browserSubmittedCounts)
  const browserAllOnTimeCounts = browserKeyboardSubmissions.map(rows => rows.filter(row => row.firstKeyLatenessMs <= BROWSER_EDIT_INTERVAL_MS).length)
  const browserMinOnTimeCount = Math.min(...browserAllOnTimeCounts)
  const browserExpectedTotal = expectedBrowserEditsPerClient * BROWSER_CLIENTS
  const browserOnTimeTotal = browserAllOnTimeCounts.reduce((sum, count) => sum + count, 0)
  const mcpStartLateness = mcpDispatches.map(row => row.startLatenessMs)
  const mcpOneSecondBins = summarizeMcpDispatchBins(mcpDispatches, startedAt, durationMs)
  const workloadDurationMs = workloadEndedAt - startedAt
  const round = {
    phase, startedAt, endedAt: workloadEndedAt, drainedAt: Date.now(), durationMs,
    workloadDurationMs, warmupMs: WARMUP_MS, sampleMs,
    expectedScheduledMcpCalls, scheduledMcpCalls: mcpTick, mcpDispatchStartedCount: mcpDispatches.length,
    mcpDispatchedWriteCount: mcpDispatches.length,
    mcpMissedDispatchCount: mcpDispatchMisses.length,
    mcpLateDispatchCount: mcpDispatches.filter(row => Number(row.startLatenessMs) > 0).length,
    mcpDispatchSchedule: workerDispatchSchedule,
    mcpQueueDelayDefinition: 'driverDispatchDelayMs is monotonic planned-slot-to-dispatch delay; queueDelayMs is a compatibility alias and is not server-side queue time.',
    mcpResponseLatencyClockBasis: 'Worker performance.now elapsed time; wall startedAt/completedAt timestamps are retained for correlation only.',
    mcpMissedDispatches: mcpDispatchMisses.slice(0, 100),
    mcpUnsubmittedWriteCount: mcpDispatchMisses.length,
    mcpUnknownOutcomeCount: workerRows.filter(row => row.writeSubmitted !== false && row.outcome === 'unknown').length,
    mcpSchedulingCompletenessPct: expectedScheduledMcpCalls ? Number((mcpDispatches.length / expectedScheduledMcpCalls * 100).toFixed(2)) : 100,
    mcpScheduledRatePerSecond: workloadDurationMs > 0 ? Number((mcpDispatches.length / workloadDurationMs * 1000).toFixed(2)) : null,
    mcpStartLateness: metric(mcpStartLateness), mcpOneSecondBins,
    mcpOneSecondBinsClockBasis: 'Fixed plannedAt offset from round start plus monotonic worker dispatch lateness; wall-clock dispatchedAt is retained for correlation only.',
    driverRuntime: { phase, source: driverRuntimeMetrics && driverRuntimeMetrics.source, metrics: driverRuntimeMetrics },
    workerRuntime: { phase, source: workerRuntimeMetrics && workerRuntimeMetrics.source, metrics: workerRuntimeMetrics,
      syncJsonlWrite: workerWriteSyncMetrics },
    expectedBrowserEditsPerClient, browserEdits: browserTicks,
    browserEditScheduledCompletenessPct: expectedBrowserEditsPerClient ? Number((minBrowserTickCount / expectedBrowserEditsPerClient * 100).toFixed(2)) : 100,
    browserEditsCompleted, browserEditCompletionPct: expectedBrowserEditsPerClient ? Number((minBrowserCompletedCount / expectedBrowserEditsPerClient * 100).toFixed(2)) : 100,
    browserKeyboardSubmittedPerClient: browserSubmittedCounts,
    browserKeyboardSubmissionCompletenessPct: browserExpectedTotal ? Number((browserSubmittedCounts.reduce((sum, count) => sum + count, 0) / browserExpectedTotal * 100).toFixed(2)) : 100,
    browserMinKeyboardSubmissionCompletenessPct: expectedBrowserEditsPerClient ? Number((minBrowserSubmittedCount / expectedBrowserEditsPerClient * 100).toFixed(2)) : 100,
    browserOnTimeKeyboardPerClient: browserAllOnTimeCounts,
    browserOnTimeKeyboardCompletenessPct: browserExpectedTotal ? Number((browserOnTimeTotal / browserExpectedTotal * 100).toFixed(2)) : 100,
    browserMinOnTimeKeyboardCompletenessPct: expectedBrowserEditsPerClient ? Number((browserMinOnTimeCount / expectedBrowserEditsPerClient * 100).toFixed(2)) : 100,
    minBrowserTickCount, minBrowserCompletedCount, minBrowserSubmittedCount, browserMinOnTimeCount, undrained, schedulerErrors, browserSettlement
  }
  append(eventsPath, { type: 'round-end', ...round, schedulerErrorCount: schedulerErrors.length })
  return round
}

async function resourceSampler(phase = 'unspecified') {
  resourceSampleCounter += 1
  const sampleIndex = resourceSampleCounter
  if (resourceSamplerRunning) {
    append(eventsPath, { type: 'resource-sample-skipped', phase, at: Date.now(), sampleIndex,
      missingComponents: ['containers', 'postgres', 'redis'],
      reason: 'previous asynchronous resource sample is still running' })
    return
  }
  resourceSamplerRunning = true
  try {
    // Capture cheap host counters first. A failed external probe must not erase
    // CPU/memory evidence or turn an unavailable sample into zero load.
    const host = await hostResourceSnapshot(false)
    const measure = async (component, timeoutMs, work) => {
      const started = performance.now()
      try { return { status: 'fulfilled', value: await work(), durationMs: performance.now() - started, timeoutMs } }
      catch (error) { return { status: 'rejected', reason: error, durationMs: performance.now() - started, timeoutMs, component } }
    }
    const probes = await Promise.all([
      measure('containers', RESOURCE_PROBE_TIMEOUT_MS.containers, async () => {
        const text = await dockerAsync(['stats', '--no-stream', '--format', '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}', ...dockerOwned.keys()], { timeout: RESOURCE_PROBE_TIMEOUT_MS.containers })
        return text.split(/\r?\n/).filter(Boolean).map(line => {
          const [name, cpu, memory, memoryPct, network, block] = line.split('|')
          return { name, cpu, memory, memoryPct, network, block }
        })
      }),
      measure('postgres', RESOURCE_PROBE_TIMEOUT_MS.postgresQuery, async () => {
        const { Pool } = pgModule()
        const pool = new Pool({ ...PG, max: 1, connectionTimeoutMillis: RESOURCE_PROBE_TIMEOUT_MS.postgresConnect,
          query_timeout: RESOURCE_PROBE_TIMEOUT_MS.postgresQuery })
        try {
          const result = await pool.query("select datname, count(*) filter(where state='active')::int as active, count(*) filter(where wait_event is not null)::int as waiting from pg_stat_activity where datname like 'mcp_cp_20261014_%' group by datname order by datname")
          return result.rows.map(row => [row.datname, row.active, row.waiting].join('|'))
        } finally { await pool.end() }
      }),
      measure('redis', RESOURCE_PROBE_TIMEOUT_MS.redis, async () => {
        const client = redisModule().createClient({ url: `redis://${REDIS_HOST}:${REDIS_PORT}/${REDIS_DB}`,
          socket: { connectTimeout: RESOURCE_PROBE_TIMEOUT_MS.redis, reconnectStrategy: false } })
        client.on('error', () => {})
        const deadline = setTimeout(() => { if (client.isOpen) client.disconnect().catch(() => {}) }, RESOURCE_PROBE_TIMEOUT_MS.redis)
        try {
          await client.connect()
          const [memory, clients, keyspace, size] = await Promise.all([client.info('memory'), client.info('clients'), client.info('keyspace'), client.dbSize()])
          return { dbSize: size, memory: parseRedisInfo(memory), clients: parseRedisInfo(clients), keyspace: keyspace.match(/db\d+:.*$/m)?.[0] || '' }
        } finally {
          clearTimeout(deadline)
          if (client.isOpen) await client.disconnect().catch(() => {})
        }
      }),
    ])
    const labels = ['containers', 'postgres', 'redis']
    const resourceErrors = probes.flatMap((result, index) => result.status === 'rejected'
      ? [{ component: labels[index], error: safePersistedError(result.reason) }] : [])
    const probeTiming = Object.fromEntries(probes.map((result, index) => [labels[index], {
      status: result.status, durationMs: Number(result.durationMs.toFixed(3)), timeoutMs: result.timeoutMs,
      error: result.status === 'rejected' ? safePersistedError(result.reason) : null,
    }]))
    append(eventsPath, {
      type: 'resource-sample', phase, at: Date.now(), sampleIndex, host, probeTiming,
      containers: probes[0].status === 'fulfilled' ? probes[0].value : null,
      postgres: probes[1].status === 'fulfilled' ? probes[1].value : null,
      redis: probes[2].status === 'fulfilled' ? probes[2].value : null,
      partial: resourceErrors.length > 0, resourceErrors,
      missingComponents: resourceErrors.map(error => error.component)
    })
  } finally { resourceSamplerRunning = false }
}

function parseRedisInfo(text) {
  const result = {}
  for (const line of String(text).split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf(':')
    if (index > 0) result[line.slice(0, index)] = line.slice(index + 1)
  }
  return result
}

function selectEventWriteUids(allLeaves, sharedViewportUids, offset, count) {
  const leafSet = new Set(allLeaves.map(String))
  const visibleLeaves = sharedViewportUids.map(String).filter(uid => leafSet.has(uid))
  const rotatedLeaves = allLeaves.slice(offset).concat(allLeaves.slice(0, offset)).map(String)
  const ordered = [...new Set([...visibleLeaves, ...rotatedLeaves])]
  assert(ordered.length >= count, `事件场景需要 ${count} 个独立已加载叶 UID，实际 ${ordered.length}`)
  return ordered.slice(0, count)
}

async function inspectWriteSetOnPage(entry, items) {
  return entry.page.evaluate(async items => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const mm = window.__perfRepairMindMap
    const renderer = mm && mm.renderer
    const adapter = mm && mm.cooperate && mm.cooperate.collabV2Adapter
    const status = adapter && adapter.getStatus && adapter.getStatus()
    const trace = window.__cpTrace || {}
    const viewport = mm && mm.el && mm.el.getBoundingClientRect()
    const domByUid = new Map(Array.from(document.querySelectorAll('.smm-node[data-node-uid]'))
      .map(el => [String(el.getAttribute('data-node-uid')), el]))
    const rows = items.map(item => {
      const node = renderer && renderer.findNodeByUid(item.uid)
      const dataText = window.__cpReadNodePlainText ? window.__cpReadNodePlainText(node) : ''
      const element = domByUid.get(String(item.uid))
      const bounds = element && element.getBoundingClientRect()
      const style = element && getComputedStyle(element)
      const intersectsViewport = !!(bounds && viewport && bounds.width > 2 && bounds.height > 2 &&
        bounds.right > viewport.left && bounds.left < viewport.right && bounds.bottom > viewport.top && bounds.top < viewport.bottom &&
        style.display !== 'none' && style.visibility !== 'hidden' && style.pointerEvents !== 'none')
      const domText = element ? String(element.innerText || element.textContent || '').trim() : null
      const renderComplete = (trace.rendered || []).some(row => row.token === item.token && String(row.uid) === String(item.uid) &&
        row.renderComplete === true && row.stable === true && Number.isFinite(row.version))
      return { uid: item.uid, token: item.token, nodeLoaded: !!node, modelMatches: dataText === item.text,
        hasDom: !!element, intersectsViewport, domMatches: element ? domText.includes(item.text) : null, renderComplete }
    })
    const visible = rows.filter(row => row.intersectsViewport)
    const mode = window.__perfRepairRenderMode || 'natural'
    const requiredDom = mode === 'full' ? rows : visible
    const modelMatches = rows.filter(row => row.nodeLoaded && row.modelMatches).length
    const domStableMatches = requiredDom.filter(row => row.hasDom && row.domMatches && row.renderComplete).length
    return { label: window.__perfRepairPageLabel || null, revision: Number(status && status.lastServerRevision) || 0,
      rendererIdle: !!renderer && renderer.isRendering === false, itemCount: rows.length, modelMatches,
      modelMismatches: rows.filter(row => !row.nodeLoaded || !row.modelMatches).map(row => ({ uid: row.uid, loaded: row.nodeLoaded, modelMatches: row.modelMatches })).slice(0, 20),
      visibleDomCount: visible.length, visibleDomStableMatches: visible.filter(row => row.hasDom && row.domMatches && row.renderComplete).length,
      requiredDomCount: requiredDom.length, requiredDomStableMatches: domStableMatches,
      requiredDomMismatches: requiredDom.filter(row => !row.hasDom || !row.domMatches || !row.renderComplete).map(row => ({ uid: row.uid, hasDom: row.hasDom, domMatches: row.domMatches, renderComplete: row.renderComplete })).slice(0, 20),
      rows: rows.map(({ uid, modelMatches, hasDom, intersectsViewport, domMatches, renderComplete }) => ({ uid, modelMatches, hasDom, intersectsViewport, domMatches, renderComplete })) }
  }, items)
}

async function waitForWriteSetCatchup(pages, items, startedAt, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  let perClient = []
  while (Date.now() < deadline) {
    perClient = await Promise.all(pages.map(entry => inspectWriteSetOnPage(entry, items)))
    const allClientsCaughtUp = perClient.every(row => row.itemCount === items.length && row.modelMatches === items.length && row.rendererIdle)
    const allRequiredDomStable = perClient.every(row => row.requiredDomCount > 0 && row.requiredDomStableMatches === row.requiredDomCount)
    if (allClientsCaughtUp && allRequiredDomStable) {
      return { allClientsCaughtUp, allRequiredDomStable, perClient, catchupMs: Date.now() - startedAt, timedOut: false }
    }
    await sleep(100)
  }
  perClient = await Promise.all(pages.map(entry => inspectWriteSetOnPage(entry, items)))
  return { allClientsCaughtUp: perClient.every(row => row.itemCount === items.length && row.modelMatches === items.length && row.rendererIdle),
    allRequiredDomStable: perClient.every(row => row.requiredDomCount > 0 && row.requiredDomStableMatches === row.requiredDomCount),
    perClient, catchupMs: Date.now() - startedAt, timedOut: true }
}

async function runBatch100(mcp, mcpToken, pages, roomKey, allLeaves, sharedViewportUids, updateTool, mcpToolList, expectationMap) {
  const batchTool = mcpToolList.get('apply_nodes')
  assert(batchTool, 'MCP tools/list 未声明 apply_nodes；无法验收100项批量')
  const operationId = randomUUID()
  const items = []
  const targetUids = selectEventWriteUids(allLeaves, sharedViewportUids, 410, 100)
  const issuedAt = Date.now()
  for (let index = 0; index < 100; index += 1) {
    const uid = targetUids[index]
    const token = makeToken('batch', index + 1)
    const text = token
    items.push({ uid, token, text, op: 'update' })
    expectationMap.set(uid, text)
    append(samplesPath, { category: 'mcp-batch-item', phase: 'batch100', token, uid, operationId, expectedText: text })
    await registerRenderExpectation(pages, uid, text, token, 'mcp-batch', 'mcp-batch-writer', issuedAt, 'batch100')
  }
  const properties = batchTool.inputSchema && batchTool.inputSchema.properties || {}
  const itemSchema = properties.operations && properties.operations.items && properties.operations.items.properties || {}
  const operations = items.map(item => {
    const record = { op: itemSchema.op ? 'update' : 'update' }
    const uidField = itemSchema.uid ? 'uid' : itemSchema.node_uid ? 'node_uid' : 'node'
    record[uidField] = item.uid
    record.text = item.text
    return record
  })
  const argsValue = toolArgs(batchTool, roomKey, null, null, operationId, operations)
  const batchStart = Date.now()
  const start = performance.now()
  const sample = await callMcpTool(mcp, mcpToken, 'apply_nodes', argsValue, operationId, { category: 'mcp-batch', phase: 'batch100', plannedAt: issuedAt })
  const responseMs = performance.now() - start
  const catchup = await waitForWriteSetCatchup(pages, items, batchStart)
  const check = { category: 'batch100-catchup', operationId, responseMs, catchupMs: catchup.catchupMs,
    allClientsCaughtUp: catchup.allClientsCaughtUp, allRequiredDomStable: catchup.allRequiredDomStable,
    catchupSemantics: renderMode === 'full'
      ? 'full mode checks all 100 loaded UID model values, idle renderers, DOM text and render_complete on every page'
      : 'natural mode checks all 100 loaded UID model values and idle renderers on every page; actual viewport-intersecting items additionally require matching DOM text and render_complete',
    sharedViewportTargetCount: items.filter(item => sharedViewportUids.includes(item.uid)).length,
    perClient: catchup.perClient, timedOut: catchup.timedOut, outcome: sample.outcome, result: sample.result }
  append(samplesPath, check)
  return check
}

async function waitForRenderTokens(pages, tokens, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  let reports = []
  while (Date.now() < deadline) {
    reports = await Promise.all(pages.map(entry => entry.page.evaluate(expected => {
      const rendered = new Set((window.__cpTrace && window.__cpTrace.rendered || [])
        .filter(row => row.renderComplete && row.stable && Number.isFinite(row.version))
        .map(row => row.token))
      return expected.filter(token => rendered.has(token)).length
    }, tokens).catch(() => 0)))
    if (reports.every(count => count === tokens.length)) break
    await sleep(100)
  }
  return { allClientsStable: reports.length === pages.length && reports.every(count => count === tokens.length), perClientStableItems: reports, waitedMs: Math.min(timeoutMs, Date.now() - (deadline - timeoutMs)) }
}

async function verifyInteractiveBrowserPath(pages, visibleUids, expectationMap) {
  assert(visibleUids.length >= BROWSER_CLIENTS, `键盘预检没有足够的共同可点击 UID：${visibleUids.length}`)
  const uid = visibleUids[0]
  const token = makeToken('browser-preflight', 1)
  const text = token
  const phase = 'preflight-real-keyboard'
  const issuedAt = Date.now()
  expectationMap.set(uid, text)
  await registerRenderExpectation(pages, uid, text, token, 'browser', pages[0].label, issuedAt, 'preflight')
  const local = await runBrowserWrite(pages[0], uid, text, token, 'preflight')
  await pages[0].page.waitForFunction(({ token, uid }) => (window.__cpTrace && window.__cpTrace.submit || []).some(row => row.token === token && row.uid === uid),
    { token, uid }, { timeout: 5000 })
  const [remote, ackWait] = await Promise.all([
    waitForRenderTokens([pages[1]], [token], 15000),
    pages[0].page.waitForFunction(({ token, uid }) => (window.__cpTrace && window.__cpTrace.ack || []).some(row => row.token === token && row.uid === uid),
      { token, uid }, { timeout: 15000 }).then(() => ({ observed: true })).catch(error => ({ observed: false, error: safeError(error.message) }))
  ])
  const writerTrace = await pages[0].page.evaluate(({ token, uid }) => {
    const trace=window.__cpTrace||{}
    return {
      input:(trace.input||[]).find(row=>row.token===token)||null,
      submit:(trace.submit||[]).find(row=>row.token===token&&row.uid===uid)||null,
      ack:(trace.ack||[]).find(row=>row.token===token&&row.uid===uid)||null,
      rendered:(trace.rendered||[]).find(row=>row.token===token&&row.uid===uid)||null
    }
  }, { token, uid })
  const remoteDom = await pages[1].page.evaluate(({ token, uid, text }) => {
    const node=Array.from(document.querySelectorAll('.smm-node[data-node-uid]')).find(el=>el.getAttribute('data-node-uid')===uid)
    const rendered=(window.__cpTrace&&window.__cpTrace.rendered||[]).find(row=>row.token===token&&row.uid===uid&&row.renderComplete===true&&Number.isFinite(row.version))
    return { uid, text:node&&(node.innerText||node.textContent||'').trim()||null, renderComplete:!!rendered, version:rendered&&rendered.version||null }
  }, { token, uid, text })
  const ack=writerTrace.ack
  const ackCorrelated=!!ack&&ack.status==='acked'&&!!ack.traceId&&!!ack.operationId&&String(ack.operationId)===String(ack.ackOperationId)
  const submitObserved=!!writerTrace.submit&&!!writerTrace.submit.traceId&&!!writerTrace.submit.operationId
  const result={ phase, uid, token, local, writerTrace, submitObserved, ackWait, ackCorrelated, remote, remoteDom,
    remoteDomMatches:remoteDom.text===text&&remoteDom.renderComplete }
  assert(local.firstKeyEchoMs!==undefined&&local.textAfterInput===text, `键盘预检没有得到本地真实文本反馈：${JSON.stringify(result).slice(0,1600)}`)
  assert(submitObserved, `键盘预检没有捕获到真实 collabV2 submit trace：${JSON.stringify(result).slice(0,1800)}`)
  append(eventsPath, { type: 'interactive-browser-path-preflight', ...result })
  return result
}

async function runBurst100(mcp, mcpToken, pages, roomKey, allLeaves, sharedViewportUids, updateTool, expectationMap) {
  const issuedAt = Date.now()
  const items = []
  const targetUids = selectEventWriteUids(allLeaves, sharedViewportUids, 610, 100)
  for (let index = 0; index < 100; index += 1) {
    const uid = targetUids[index]
    const operationId = randomUUID()
    const token = makeToken('burst', index + 1)
    const text = token
    items.push({ uid, operationId, token, text })
    expectationMap.set(uid, text)
    await registerRenderExpectation(pages, uid, text, token, 'mcp-burst', 'mcp-burst-writer', issuedAt, 'event-burst-100')
  }
  const start = Date.now()
  const results = await Promise.all(items.map((item, index) => callMcpTool(
    mcp, mcpToken, 'update_node', toolArgs(updateTool, roomKey, item.uid, item.text, item.operationId), item.operationId,
    { category: 'mcp-burst-single', phase: 'event-burst-100', uid: item.uid, token: item.token, expectToken: item.token, plannedAt: start + index }
  )))
  const callMs = Date.now() - start
  const catchup = await waitForWriteSetCatchup(pages, items, start)
  const report = { category: 'event-burst-100', start, callMs, total: results.length,
    successes: results.filter(row => row.outcome === 'success').length, failures: results.filter(row => row.outcome !== 'success').length,
    allClientsCaughtUp: catchup.allClientsCaughtUp, allRequiredDomStable: catchup.allRequiredDomStable,
    catchupMs: catchup.catchupMs, catchupSemantics: renderMode === 'full'
      ? 'full mode verifies all 100 model UIDs and DOM/render_complete on every client'
      : 'natural mode verifies all 100 loaded model UIDs; actual viewport-intersecting items additionally require matching DOM text and render_complete',
    sharedViewportTargetCount: items.filter(item => sharedViewportUids.includes(item.uid)).length,
    perClient: catchup.perClient, timedOut: catchup.timedOut, outcomes: countBy(results, 'outcome') }
  append(samplesPath, report)
  return report
}

function countBy(rows, key) {
  return rows.reduce((result, row) => { const value=row[key]||'missing';result[value]=(result[value]||0)+1;return result }, {})
}

function percentile(values, p) {
  if (!values.length) return null
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]
}

function metric(values) {
  const valid = values.filter(value => Number.isFinite(value))
  if (!valid.length) return { count: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null }
  return { count: valid.length, p50Ms: percentile(valid, 0.5), p95Ms: percentile(valid, 0.95), p99Ms: percentile(valid, 0.99), maxMs: Math.max(...valid) }
}

async function collectBrowserTrace(pages) {
  const trace = { capturedAt: new Date().toISOString(), clients: [], totals: { rendered: 0, input: 0, submit: 0, ack: 0, superseded: 0, observerErrors: 0 } }
  for (const entry of pages) {
    const data = await entry.page.evaluate(() => { window.__cpFinalizePending&&window.__cpFinalizePending();return window.__cpTrace||null }).catch(error => ({ collectionError: error.message }))
    trace.clients.push({ label: entry.label, userId: entry.identity.userId, readyStats: entry.readyStats, socketCount: entry.sockets.length, socketFrames: entry.socketFrames, httpSamples: entry.httpSamples, trace: data })
    if (data && data.rendered) trace.totals.rendered += data.rendered.length
    if (data && data.input) trace.totals.input += data.input.length
    if (data && data.submit) trace.totals.submit += data.submit.length
    if (data && data.ack) trace.totals.ack += data.ack.length
    if (data && data.superseded) trace.totals.superseded += data.superseded.length
    if (data) trace.totals.observerErrors += Number(data.observerErrors || 0)
  }
  fs.writeFileSync(browserTracePath, JSON.stringify(trace, null, 2) + '\n')
  return trace
}

async function collectOperationRows(dbName, roomKey) {
  const { Pool } = pgModule()
  const pool = new Pool({ ...PG, database: dbName, max: 1, connectionTimeoutMillis: 5000 })
  try {
    const identity = await pool.query('select current_database() as database,current_user as username')
    assert(identity.rows[0].database === dbName && identity.rows[0].username === PG.user, 'operation verification DB mismatch')
    await pool.query('begin isolation level repeatable read read only')
    const archive = await pool.query("select to_regclass('public.room_operations_archive') is not null as present")
    const operationsSql = archive.rows[0].present
      ? `with combined as (
           select version,operation_id,actor_id,client_id,operation_type,target_id,payload,event,created_at,0 as source_rank
           from room_operations where room_key=$1
           union all
           select version,operation_id,actor_id,client_id,operation_type,null::text as target_id,payload,event,created_at,1 as source_rank
           from room_operations_archive where room_key=$1
         ), ranked as (
           select combined.*,row_number() over(partition by version order by source_rank) as row_rank from combined
         )
         select version,operation_id,actor_id,client_id,operation_type,target_id,payload,event,created_at
         from ranked where row_rank=1 order by version`
      : `select version,operation_id,actor_id,client_id,operation_type,target_id,payload,event,created_at
         from room_operations where room_key=$1 order by version`
    const result = await pool.query(operationsSql, [roomKey])
    const nodes = await pool.query(`select uid,parent_uid,position,data,is_root
      from room_nodes where room_key=$1 and deleted_at is null order by uid`, [roomKey])
    const room = await pool.query('select version from rooms where room_key=$1', [roomKey])
    await pool.query('commit')
    const state = { version: Number(room.rows[0] && room.rows[0].version || 0), rows: nodes.rows }
    const treeHash = canonicalTreeHash(state.rows)
    writeTreeArtifact('final-tree.json', state, treeHash)
    const operationsFile = path.join(runDir, 'operations-readback.json')
    fs.writeFileSync(operationsFile, JSON.stringify({ identity: { database: dbName, username: PG.user }, operationCount: result.rowCount,
      operations: result.rows, operationSources: archive.rows[0].present ? ['room_operations','room_operations_archive'] : ['room_operations'],
      nodeCount: nodes.rowCount, currentVersion: state.version, finalTreeSha256: treeHash }, null, 2) + '\n')
    return { operations: result.rows, nodeRows: nodes.rows, currentVersion: state.version, finalTreeSha256: treeHash,
      readbackFile: path.basename(operationsFile), operationSources: archive.rows[0].present ? ['room_operations','room_operations_archive'] : ['room_operations'] }
  } catch (error) {
    await pool.query('rollback').catch(() => {})
    throw error
  } finally { await pool.end() }
}

function normalizedNodeData(value) {
  let data = value
  if (typeof data === 'string') { try { data = JSON.parse(data) } catch (_) { data = {} } }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {}
  return { ...data }
}

function stableTreeValue(value) {
  if (Array.isArray(value)) return value.map(stableTreeValue)
  if (!value || typeof value !== 'object') return value
  const result = {}
  for (const key of Object.keys(value).sort()) result[key] = stableTreeValue(value[key])
  return result
}

function canonicalTreeRows(rows) {
  return (rows || []).map(row => ({
    uid: String(row.uid), parentUid: row.parent_uid == null ? null : String(row.parent_uid),
    position: row.position == null ? null : String(row.position), isRoot: row.is_root === true,
    data: stableTreeValue(normalizedNodeData(row.data))
  })).sort((left, right) => left.uid.localeCompare(right.uid))
}

function canonicalTreeHash(rows) {
  return sha256(JSON.stringify(canonicalTreeRows(rows)))
}

function writeTreeArtifact(name, state, hash = canonicalTreeHash(state.rows)) {
  const file = path.join(runDir, name)
  fs.writeFileSync(file, JSON.stringify({ version: state.version, nodeCount: state.rows.length, sha256: hash, rows: state.rows }, null, 2) + '\n')
  return { path: name, version: state.version, nodeCount: state.rows.length, sha256: hash }
}

async function captureRoomTreeState(dbName, roomKey, artifactName) {
  const { Pool } = pgModule()
  const pool = new Pool({ ...PG, database: dbName, max: 1, connectionTimeoutMillis: 5000 })
  try {
    const identity = await pool.query('select current_database() as database,current_user as username')
    assert(identity.rows[0].database === dbName && identity.rows[0].username === PG.user, 'tree checkpoint DB mismatch')
    await pool.query('begin isolation level repeatable read read only')
    const room = await pool.query('select version from rooms where room_key=$1', [roomKey])
    const nodes = await pool.query(`select uid,parent_uid,position,data,is_root
      from room_nodes where room_key=$1 and deleted_at is null order by uid`, [roomKey])
    await pool.query('commit')
    const state = { version: Number(room.rows[0] && room.rows[0].version || 0), rows: nodes.rows }
    const artifact = writeTreeArtifact(artifactName, state)
    return { state, artifact }
  } catch (error) {
    await pool.query('rollback').catch(() => {})
    throw error
  } finally { await pool.end() }
}

function parseJsonValue(value) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch (_) { return null }
}

let productionLegacyApplyNodeText = null

function getProductionLegacyApplyNodeText() {
  if (productionLegacyApplyNodeText) return productionLegacyApplyNodeText
  const Module = require('module')
  const mindDocPath = path.join(APP, 'bin', 'mindDoc.js')
  const source = fs.readFileSync(mindDocPath, 'utf8') +
    '\nmodule.exports.__performanceApplyNodeText = applyNodeText\n'
  const loaded = new Module(mindDocPath, module)
  loaded.filename = mindDocPath
  loaded.paths = Module._nodeModulePaths(path.dirname(mindDocPath))
  loaded._compile(source, mindDocPath)
  assert(typeof loaded.exports.__performanceApplyNodeText === 'function',
    'production mindDoc.applyNodeText helper was not exposed by the isolated test loader')
  productionLegacyApplyNodeText = loaded.exports.__performanceApplyNodeText
  return productionLegacyApplyNodeText
}

function applyReplayPatch(data, patch, versions, options = {}) {
  const source = typeof data === 'string' ? parseJsonValue(data) : data
  const next = { ...normalizedNodeData(source) }
  let legacyTextWasNormalized = false
  if (options.legacyMcpRichText === true &&
    Object.prototype.hasOwnProperty.call(patch || {}, 'text') &&
    patch.text != null && next.richText) {
    // Reuse mindDoc's production text transform for legacy MCP writes. It
    // preserves existing span attributes and escapes input instead of stripping
    // markup and comparing only rendered/plain text.
    getProductionLegacyApplyNodeText()(next, patch.text)
    legacyTextWasNormalized = true
  }
  for (const [key, value] of Object.entries(patch || {})) {
    if (key === '__fv') continue
    if (key === 'text' && legacyTextWasNormalized) continue
    if (value === null) delete next[key]
    else next[key] = value
  }
  // Include LWW versions in the final replay check as well as user data.
  const fieldVersions = { ...(source && source.__fv || {}) }
  Object.entries(versions || {}).forEach(([key, value]) => {
    fieldVersions[key] = Math.max(Number(fieldVersions[key] || 0), Number(value) || 0)
  })
  if (Object.keys(fieldVersions).length) next.__fv = fieldVersions
  return next
}

function replayTreeEvent(nodes, rawEvent, appliedEvents, unsupportedEvents, depth = 0, options = {}) {
  const event = parseJsonValue(rawEvent)
  if (!event || typeof event !== 'object' || depth > 5) {
    unsupportedEvents.push({ type: 'invalid-or-deep-event' })
    return
  }
  const type = String(event.type || '')
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {}
  if (type === 'batch.applied') {
    if (!Array.isArray(payload.events)) unsupportedEvents.push({ type, reason: 'missing_child_events' })
    else payload.events.forEach(child => replayTreeEvent(nodes, child, appliedEvents, unsupportedEvents, depth + 1, options))
    return
  }
  if (type === 'map.updated') { appliedEvents[type] = (appliedEvents[type] || 0) + 1; return }
  if (type === 'node.updated' || type === 'node.moved' || type === 'node.reordered') {
    const uid = String(payload.uid || '')
    const node = nodes.get(uid)
    if (!node) { unsupportedEvents.push({ type, uid, reason: 'target_missing_during_replay' }); return }
    const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch
      : payload.data && typeof payload.data === 'object' ? payload.data
        : payload.text != null ? { text: String(payload.text) } : {}
    const eventDataVersions = payload.data && typeof payload.data === 'object' && payload.data.__fv
      ? payload.data.__fv : {}
    node.data = applyReplayPatch(node.data, patch,
      { ...eventDataVersions, ...(payload.fieldVersions || {}) }, {
        legacyMcpRichText: options.legacyMcpRichText === true
      })
    if (type === 'node.moved' || type === 'node.reordered') {
      if (payload.parentUid != null || payload.parent_uid != null || payload.parent != null) {
        node.parent_uid = String(payload.parentUid || payload.parent_uid || payload.parent || 'root')
      }
      if (payload.position != null) node.position = String(payload.position)
      const siblingPositions = payload.siblingPositions && typeof payload.siblingPositions === 'object' ? payload.siblingPositions : {}
      for (const [siblingUid, position] of Object.entries(siblingPositions)) {
        const sibling = nodes.get(String(siblingUid))
        if (sibling && position != null) sibling.position = String(position)
      }
    }
    appliedEvents[type] = (appliedEvents[type] || 0) + 1
    return
  }
  if (type === 'node.inserted') {
    const uid = String(payload.uid || (payload.data && payload.data.uid) || '')
    if (!uid) { unsupportedEvents.push({ type, reason: 'missing_uid' }); return }
    const data = { ...(payload.data && typeof payload.data === 'object' ? payload.data : {}) }
    if (payload.text != null && data.text == null) data.text = String(payload.text)
    data.uid = uid
    nodes.set(uid, { uid, parent_uid: String(payload.parentUid || payload.parent_uid || 'root'),
      position: String(payload.position || ''), is_root: false, data })
    appliedEvents[type] = (appliedEvents[type] || 0) + 1
    return
  }
  if (type === 'node.deleted') {
    const removedValue = payload.deletedUids || payload.removed || [payload.uid]
    const removed = Array.isArray(removedValue) ? removedValue : [removedValue]
    for (const uid of removed) nodes.delete(String(uid))
    const siblingPositions = payload.siblingPositions && typeof payload.siblingPositions === 'object' ? payload.siblingPositions : {}
    for (const [uid, position] of Object.entries(siblingPositions)) {
      const sibling = nodes.get(String(uid))
      if (sibling && position != null) sibling.position = String(position)
    }
    appliedEvents[type] = (appliedEvents[type] || 0) + 1
    return
  }
  if (type === 'node.restored') {
    const rows = Array.isArray(payload.rows) ? payload.rows : []
    for (const row of rows) if (row && row.uid) nodes.set(String(row.uid), {
      uid: String(row.uid), parent_uid: row.parent_uid == null ? null : String(row.parent_uid),
      position: row.position == null ? null : String(row.position), is_root: row.is_root === true,
      data: normalizedNodeData(row.data)
    })
    appliedEvents[type] = (appliedEvents[type] || 0) + 1
    return
  }
  unsupportedEvents.push({ type: type || 'missing_type', version: event.version || null })
}

function operationEvent(row) {
  const event = parseJsonValue(row.event)
  if (event && event.type) return event
  return null
}

function replayOperations(seedState, operations, finalVersion, options = {}) {
  const nodes = new Map((seedState.rows || []).map(row => [String(row.uid), {
    uid: String(row.uid), parent_uid: row.parent_uid == null ? null : String(row.parent_uid),
    position: row.position == null ? null : String(row.position), is_root: row.is_root === true,
    data: normalizedNodeData(row.data)
  }]))
  const sorted = operations.slice().sort((left, right) => Number(left.version) - Number(right.version))
  const duplicateVersions = []
  for (let index = 1; index < sorted.length; index += 1) {
    if (Number(sorted[index].version) === Number(sorted[index - 1].version)) duplicateVersions.push(Number(sorted[index].version))
  }
  let expectedVersion = Number(seedState.version || 0)
  const versionGaps = []
  const appliedEvents = {}
  const unsupportedEvents = []
  for (const row of sorted) {
    const version = Number(row.version)
    if (!Number.isFinite(version) || version <= expectedVersion) continue
    if (version !== expectedVersion + 1) versionGaps.push({ expected: expectedVersion + 1, actual: version })
    const event = operationEvent(row)
    if (!event) unsupportedEvents.push({ type: 'missing_operation_event', version, operationType: row.operation_type })
    else if (event.type === 'map.replaced' || event.resnapshot === true || event.payload && event.payload.resnapshot === true) {
      unsupportedEvents.push({ type: event.type, version, reason: 'post-seed_full_tree_replacement' })
    } else {
      const requestPayload = parseJsonValue(row.payload)
      const isMcpActor = String(row.actor_id || event.actorId || '') === 'mcp-service'
      const legacyMcpRichText = options.normalizeLegacyMcpRichText === true && isMcpActor &&
        (event.actorId === 'mcp-service' || !!(requestPayload && requestPayload.__mcpRequest))
      replayTreeEvent(nodes, event, appliedEvents, unsupportedEvents, 0, { legacyMcpRichText })
    }
    expectedVersion = version
  }
  return { rows: [...nodes.values()], expectedVersion, versionGaps, duplicateVersions,
    appliedEventCount: Object.values(appliedEvents).reduce((sum, value) => sum + value, 0), appliedEvents, unsupportedEvents,
    versionMatchesFinal: expectedVersion === Number(finalVersion) }
}

function collectCommittedTextIntents(operations) {
  const committed = new Map()
  const visit = (event, row, childIndex = 0, depth = 0) => {
    if (!event || typeof event !== 'object' || depth > 5) return
    const type = String(event.type || '')
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {}
    if (type === 'batch.applied') {
      ;(payload.events || []).forEach((child, index) => visit(child, row, index, depth + 1))
      return
    }
    const setText = (uid, value) => {
      if (!uid) return
      committed.set(String(uid), {
        text: value == null ? null : String(value),
        version: Number(row.version) || 0,
        operationId: row.operation_id || null,
        childIndex
      })
    }
    if (['node.updated', 'node.moved', 'node.reordered', 'node.inserted'].includes(type)) {
      const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : {}
      if (Object.prototype.hasOwnProperty.call(patch, 'text')) setText(payload.uid, patch.text)
      else if (Object.prototype.hasOwnProperty.call(payload, 'text')) setText(payload.uid, payload.text)
      else if (payload.data && Object.prototype.hasOwnProperty.call(payload.data, 'text')) setText(payload.uid || payload.data.uid, payload.data.text)
      return
    }
    if (type === 'node.restored') {
      ;(Array.isArray(payload.rows) ? payload.rows : []).forEach(node => {
        if (node && node.data && Object.prototype.hasOwnProperty.call(node.data, 'text')) setText(node.uid, node.data.text)
      })
    }
  }
  operations.slice().sort((left, right) => Number(left.version) - Number(right.version))
    .forEach(row => visit(operationEvent(row), row))
  return committed
}

function classifyAttemptedTextIntents(expectedTextByUid, committedTextByUid) {
  const matched = []
  const plainRichTextNormalizedMatches = []
  const notCommitted = []
  for (const [uid, expectedText] of expectedTextByUid.entries()) {
    const committed = committedTextByUid.get(String(uid))
    const expected = String(expectedText)
    const comparison = committed
      ? compareClientRenderText({ text: expected }, committed.text)
      : null
    if (comparison && comparison.matches) {
      matched.push(String(uid))
      if (comparison.normalizationKind === 'plain-to-rich-paragraph' && comparison.rawText !== comparison.actualRenderText) {
        plainRichTextNormalizedMatches.push(String(uid))
      }
      continue
    }
    notCommitted.push({
      uid: String(uid), expected,
      lastCommittedText: committed ? committed.text : null,
      lastCommittedVersion: committed ? committed.version : null,
      reason: committed ? 'latest_committed_text_differs' : 'no_committed_text_event'
    })
  }
  return {
    matchedUids: matched,
    plainRichTextNormalizedMatchUids: plainRichTextNormalizedMatches,
    plainRichTextNormalizedMatchCount: plainRichTextNormalizedMatches.length,
    notCommitted
  }
}

function operationCorrectness(operationData, seedState, expectedTextByUid, roomKey) {
  const operations = operationData.operations
  const operationIds = operations.map(row => row.operation_id).filter(Boolean)
  const uniqueOperationIds = new Set(operationIds)
  const duplicateOperationIds = operationIds.length - uniqueOperationIds.size
  const replay = replayOperations(seedState, operations, operationData.currentVersion, {
    normalizeLegacyMcpRichText: variant === 'A'
  })
  const actualRows = canonicalTreeRows(operationData.nodeRows)
  const replayRows = canonicalTreeRows(replay.rows)
  const actualHash = sha256(JSON.stringify(actualRows))
  const replayHash = sha256(JSON.stringify(replayRows))
  const expectedByUid = new Map(actualRows.map(row => [row.uid, row]))
  const replayByUid = new Map(replayRows.map(row => [row.uid, row]))
  const mismatchUids = []
  for (const uid of new Set([...expectedByUid.keys(), ...replayByUid.keys()])) {
    if (JSON.stringify(expectedByUid.get(uid) || null) !== JSON.stringify(replayByUid.get(uid) || null)) mismatchUids.push(uid)
  }
  const intentAudit = classifyAttemptedTextIntents(expectedTextByUid, collectCommittedTextIntents(operations))
  const status = duplicateOperationIds === 0 && replay.duplicateVersions.length === 0 && replay.versionGaps.length === 0 &&
    replay.unsupportedEvents.length === 0 && replay.versionMatchesFinal && actualHash === replayHash &&
    operationData.nodeRows.length === FIXTURE_NODE_COUNT ? 'pass' : 'fail'
  return {
    roomKey, operationRows: operations.length, operationSources: operationData.operationSources,
    duplicateOperationIds, duplicateVersions: replay.duplicateVersions, versionGaps: replay.versionGaps,
    seedVersion: seedState.version, finalVersion: operationData.currentVersion, replayVersion: replay.expectedVersion,
    versionMatchesFinal: replay.versionMatchesFinal, appliedEventCount: replay.appliedEventCount,
    appliedEvents: replay.appliedEvents, unsupportedEvents: replay.unsupportedEvents.slice(0, 100),
    nodeCount: operationData.nodeRows.length, replayNodeCount: replay.rows.length, expectedNodeCount: FIXTURE_NODE_COUNT,
    nodeCountMatches: operationData.nodeRows.length === FIXTURE_NODE_COUNT,
    authoritativeFinalTreeSha256: actualHash, replayedFinalTreeSha256: replayHash,
    treeHashMatches: actualHash === replayHash, treeMismatchCount: mismatchUids.length, treeMismatchUids: mismatchUids.slice(0, 100),
    attemptedIntentCount: expectedTextByUid.size,
    attemptedIntentCommittedMatchCount: intentAudit.matchedUids.length,
    attemptedIntentPlainRichTextNormalizedMatchCount: intentAudit.plainRichTextNormalizedMatchCount,
    attemptedIntentNotCommittedCount: intentAudit.notCommitted.length,
    attemptedIntentsNotCommitted: intentAudit.notCommitted.slice(0, 100),
    artifacts: { seedTree: 'seed-tree.json', finalTree: 'final-tree.json', operationReadback: operationData.readbackFile },
    status
  }
}

function runCorrectnessSelfTest() {
  let assertions = 0
  const check = (condition, message) => { assert(condition, message); assertions += 1 }
  const seedState = {
    version: 10,
    rows: [
      { uid: 'root', parent_uid: null, position: null, is_root: true, data: { uid: 'root', text: 'root', __fv: { text: 1 } } },
      { uid: 'rich', parent_uid: 'root', position: 'a', is_root: false,
        data: { uid: 'rich', text: '<p><span class="keep">before</span></p>', richText: true, __fv: { text: 10, 'field:note': 7 } } },
      { uid: 'plain', parent_uid: 'root', position: 'b', is_root: false,
        data: { uid: 'plain', text: 'plain', custom: { __fv: 'user-data' }, __fv: { text: 10 } } },
      { uid: 'failed', parent_uid: 'root', position: 'c', is_root: false,
        data: { uid: 'failed', text: 'unchanged', __fv: { text: 10 } } }
    ]
  }
  const operations = [
    { version: 11, operation_id: 'op-rich', actor_id: 'mcp-service', payload: { __mcpRequest: { v: 1 } },
      event: { type: 'node.updated', actorId: 'mcp-service', version: 11, payload: {
        uid: 'rich', patch: { text: 'new <strong>literal</strong> & text' }, fieldVersions: { text: 11 }
      } } },
    { version: 12, operation_id: 'op-batch', actor_id: 'mcp-service', payload: { __mcpRequest: { v: 1 } },
      event: { type: 'batch.applied', actorId: 'mcp-service', version: 12, payload: { events: [
        { type: 'node.updated', payload: { uid: 'plain', patch: { text: 'committed' }, fieldVersions: { text: 12 } } }
      ] } } }
  ]
  const legacyReplay = replayOperations(seedState, operations, 12, { normalizeLegacyMcpRichText: true })
  const legacyRich = legacyReplay.rows.find(row => row.uid === 'rich').data
  const expectedRich = { ...seedState.rows.find(row => row.uid === 'rich').data }
  getProductionLegacyApplyNodeText()(expectedRich, 'new <strong>literal</strong> & text')
  expectedRich.__fv = { ...expectedRich.__fv, text: 11 }
  check(JSON.stringify(stableTreeValue(legacyRich)) === JSON.stringify(stableTreeValue(expectedRich)),
    'legacy replay must match mindDoc.applyNodeText output exactly')
  check(legacyRich.text === '<p><span class="keep">new &lt;strong&gt;literal&lt;/strong&gt; &amp; text</span></p>',
    'legacy rich-text transformation must preserve wrapper attributes and escape input markup')
  check(legacyReplay.rows.find(row => row.uid === 'rich').data.__fv.text === 11,
    'event field versions must survive replay and exact tree hashing')
  check(legacyReplay.rows.find(row => row.uid === 'plain').data.custom.__fv === 'user-data',
    'nested user data named __fv must not be filtered from canonical tree content')

  const directReplay = replayOperations(seedState, operations.slice(0, 1), 11, { normalizeLegacyMcpRichText: false })
  check(directReplay.rows.find(row => row.uid === 'rich').data.text === 'new <strong>literal</strong> & text',
    'Direct replay must retain the submitted patch without applying legacy formatting')
  check(!Object.prototype.hasOwnProperty.call(directReplay.rows.find(row => row.uid === 'rich').data, 'resetRichText'),
    'Direct replay must not fabricate the legacy resetRichText marker')

  const expectedIntents = new Map([
    ['rich', 'new <strong>literal</strong> & text'],
    ['plain', 'committed'],
    ['failed', 'requested-but-not-committed']
  ])
  const intentAudit = classifyAttemptedTextIntents(expectedIntents, collectCommittedTextIntents(operations))
  check(intentAudit.matchedUids.length === 2, 'only successful committed events should satisfy expected intents')
  check(intentAudit.notCommitted.length === 1 && intentAudit.notCommitted[0].uid === 'failed',
    'a failed batch item must remain an uncommitted attempt, not a tree-content mismatch')

  const differentlyFormatted = legacyReplay.rows.map(row => row.uid === 'rich'
    ? { ...row, data: { ...row.data, text: '<p><strong>new literal & text</strong></p>' } }
    : row)
  check(canonicalTreeHash(differentlyFormatted) !== canonicalTreeHash(legacyReplay.rows),
    'canonical equality must continue to detect genuine rich-text formatting changes')

  const artifactDir = args['correctness-artifact'] && path.resolve(args['correctness-artifact'])
  let artifactCheck = null
  if (artifactDir) {
    const seed = JSON.parse(fs.readFileSync(path.join(artifactDir, 'seed-tree.json'), 'utf8'))
    const final = JSON.parse(fs.readFileSync(path.join(artifactDir, 'final-tree.json'), 'utf8'))
    const opData = JSON.parse(fs.readFileSync(path.join(artifactDir, 'operations-readback.json'), 'utf8'))
    const replay = replayOperations(seed, opData.operations, opData.currentVersion, { normalizeLegacyMcpRichText: true })
    const actualHash = canonicalTreeHash(final.rows)
    const replayHash = canonicalTreeHash(replay.rows)
    artifactCheck = {
      path: path.relative(ROOT, artifactDir),
      seedVersion: seed.version,
      finalVersion: opData.currentVersion,
      replayVersion: replay.expectedVersion,
      nodeCount: final.rows.length,
      replayNodeCount: replay.rows.length,
      versionGaps: replay.versionGaps,
      duplicateVersions: replay.duplicateVersions,
      unsupportedEvents: replay.unsupportedEvents,
      treeHashMatches: actualHash === replayHash,
      actualTreeHash: actualHash,
      replayTreeHash: replayHash
    }
    check(replay.versionMatchesFinal && replay.versionGaps.length === 0 && replay.duplicateVersions.length === 0 &&
      replay.unsupportedEvents.length === 0 && replay.rows.length === final.rows.length && actualHash === replayHash,
    'saved performance artifact must replay to the exact final tree including field versions')
  }
  return { status: 'pass', assertions, legacyNormalizerSource: 'simple-mind-map/bin/mindDoc.js#applyNodeText', artifactCheck }
}

async function captureLoadedClientStates(pages) {
  return Promise.all(pages.map(async entry => {
    const state = await entry.page.evaluate(() => {
      const mm = window.__perfRepairMindMap
      const renderer = mm && mm.renderer
      const tree = renderer && renderer.renderTree
      const rows = []
      const stack = tree ? [{ node: tree, parentUid: null }] : []
      while (stack.length) {
        const { node, parentUid } = stack.pop()
        const uid = node && node.data && node.data.uid
        if (!uid) continue
        const children = Array.isArray(node.children) ? node.children : []
        rows.push({ uid: String(uid), parentUid, clientRenderText: String(node.data.text || ''),
          clientRichText: node.data.richText === true,
          childUids: children.map(child => String(child && child.data && child.data.uid || '')).filter(Boolean) })
        for (let index = children.length - 1; index >= 0; index -= 1) stack.push({ node: children[index], parentUid: String(uid) })
      }
      const adapter = mm && mm.cooperate && mm.cooperate.collabV2Adapter
      const status = adapter && adapter.getStatus && adapter.getStatus()
      return { rows, revision: Number(status && status.lastServerRevision || 0), rendererIdle: !!(renderer && renderer.isRendering === false),
        domNodeCount: document.querySelectorAll('.smm-node').length,
        domUids: Array.from(document.querySelectorAll('.smm-node[data-node-uid]')).map(el => el.getAttribute('data-node-uid')).filter(Boolean),
        renderCompleteEvents: Number(window.__cpTrace && window.__cpTrace.renderCompleteEvents || 0) }
    })
    return { label: entry.label, userId: entry.identity.userId, ...state }
  }))
}

function collectAffectedUids(operations) {
  const uids = new Set()
  const visit = (raw, depth = 0) => {
    const event = parseJsonValue(raw)
    if (!event || typeof event !== 'object' || depth > 5) return
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {}
    if (event.uid) uids.add(String(event.uid))
    if (payload.uid) uids.add(String(payload.uid))
    for (const list of [event.affectedUids, payload.affectedUids, payload.deletedUids, payload.removed, payload.promoted]) {
      if (Array.isArray(list)) list.forEach(uid => uid && uids.add(String(uid)))
    }
    const positions = payload.siblingPositions
    if (positions && typeof positions === 'object') Object.keys(positions).forEach(uid => uids.add(String(uid)))
    if (Array.isArray(payload.events)) payload.events.forEach(child => visit(child, depth + 1))
  }
  for (const row of operations || []) {
    if (row.target_id) uids.add(String(row.target_id))
    visit(row.event)
  }
  return uids
}

function subtreeHash(rows, rootUid) {
  const childrenByParent = new Map()
  for (const row of rows || []) {
    const parent = row.parent_uid == null ? '' : String(row.parent_uid)
    const children = childrenByParent.get(parent) || []
    children.push(String(row.uid)); childrenByParent.set(parent, children)
  }
  const byUid = new Map((rows || []).map(row => [String(row.uid), row]))
  const included = new Set()
  const stack = [String(rootUid)]
  while (stack.length) {
    const uid = stack.pop()
    if (included.has(uid) || !byUid.has(uid)) continue
    included.add(uid)
    ;(childrenByParent.get(uid) || []).forEach(child => stack.push(child))
  }
  const selected = (rows || []).filter(row => included.has(String(row.uid)))
  return { nodeCount: selected.length, sha256: canonicalTreeHash(selected) }
}

async function verifyClientTreeConvergence(pages, initialStates, seedState, operationData, visibleBranchUid, timeoutMs = 30000) {
  const targetVersion = Number(operationData.currentVersion || 0)
  const waited = await Promise.all(pages.map(async entry => {
    const startedAt = Date.now()
    try {
      await entry.page.waitForFunction(version => {
        const mm = window.__perfRepairMindMap
        const adapter = mm && mm.cooperate && mm.cooperate.collabV2Adapter
        const status = adapter && adapter.getStatus && adapter.getStatus()
        return Number(status && status.lastServerRevision || 0) >= version && !!(mm && mm.renderer && mm.renderer.isRendering === false)
      }, targetVersion, { timeout: timeoutMs, polling: 100 })
      return { label: entry.label, caughtUp: true, waitMs: Date.now() - startedAt }
    } catch (_) { return { label: entry.label, caughtUp: false, waitMs: Date.now() - startedAt } }
  }))
  const finalStates = await captureLoadedClientStates(pages)
  const initialByLabel = new Map((initialStates || []).map(row => [row.label, new Set((row.rows || []).map(item => String(item.uid)))]))
  const authoritative = new Map(canonicalTreeRows(operationData.nodeRows).map(row => [row.uid, row]))
  const affected = collectAffectedUids(operationData.operations)
  const clients = finalStates.map(client => {
    const loaded = new Set(client.rows.map(row => String(row.uid)))
    const before = initialByLabel.get(client.label) || new Set()
    const removedFromLoaded = [...before].filter(uid => !loaded.has(uid))
    const addedToLoaded = [...loaded].filter(uid => !before.has(uid))
    const targetUids = [...affected].filter(uid => before.has(uid))
    const mismatches = []
    const textComparison = {
      comparedCount: 0,
      normalizedPlainTextCount: 0,
      exactHtmlOrRichTextCount: 0,
      matchingCount: 0,
      mismatchCount: 0
    }
    const authorityChildOrder = new Map()
    for (const row of operationData.nodeRows) {
      const parent = row.parent_uid == null ? '' : String(row.parent_uid)
      const list = authorityChildOrder.get(parent) || []
      list.push(row)
      authorityChildOrder.set(parent, list)
    }
    for (const children of authorityChildOrder.values()) children.sort((left, right) => String(left.position || '').localeCompare(String(right.position || '')))
    for (const row of client.rows) {
      const expected = authoritative.get(String(row.uid))
      if (!expected) { mismatches.push({ uid: row.uid, reason: 'missing_from_authoritative_tree' }); continue }
      const textResult = compareClientRenderText(expected.data, row.clientRenderText)
      textComparison.comparedCount += 1
      if (textResult.normalizationKind === 'plain-to-rich-paragraph') textComparison.normalizedPlainTextCount += 1
      else textComparison.exactHtmlOrRichTextCount += 1
      if (textResult.matches) textComparison.matchingCount += 1
      else {
        textComparison.mismatchCount += 1
        mismatches.push({ uid: row.uid, reason: 'text',
          authoritativeRawText: textResult.rawText,
          expectedClientText: textResult.expectedClientText,
          clientRenderText: textResult.actualRenderText,
          clientRichText: row.clientRichText,
          normalizationApplied: textResult.normalizationApplied,
          normalizationKind: textResult.normalizationKind })
      }
      if ((expected.parentUid || null) !== (row.parentUid || null)) mismatches.push({ uid: row.uid, reason: 'parent', expected: expected.parentUid, actual: row.parentUid })
      const expectedChildren = authorityChildOrder.get(String(row.uid)) || []
      if (expectedChildren.length === row.childUids.length) {
        const expectedOrder = expectedChildren.map(item => String(item.uid))
        if (JSON.stringify(expectedOrder) !== JSON.stringify(row.childUids)) mismatches.push({ uid: row.uid, reason: 'child_order', expected: expectedOrder.slice(0, 20), actual: row.childUids.slice(0, 20) })
      }
    }
    const targetUidSet = new Set(targetUids)
    const affectedLoadedMismatches = mismatches.filter(row => targetUidSet.has(String(row.uid)))
    return { label: client.label, userId: client.userId, revision: client.revision, targetVersion,
      revisionCaughtUp: client.revision >= targetVersion, rendererIdle: client.rendererIdle,
      loadedModelUidCount: client.rows.length, domNodeCount: client.domNodeCount, renderCompleteEvents: client.renderCompleteEvents,
      affectedLoadedUidCount: targetUids.length, affectedLoadedMismatchCount: affectedLoadedMismatches.length,
      loadedModelMismatchCount: mismatches.length, loadedModelMismatches: mismatches.slice(0, 30),
      textComparison,
      initialLoadedUidsMissing: removedFromLoaded.length, newlyLoadedUids: addedToLoaded.length }
  })
  const seedRows = seedState.rows || []
  const seedBranches = seedRows.filter(row => String(row.parent_uid || '') === 'root' && String(row.uid).includes('-branch-'))
  const hiddenBranches = seedBranches.filter(row => String(row.uid) !== String(visibleBranchUid || ''))
    .map(row => {
      const before = subtreeHash(seedRows, row.uid)
      const after = subtreeHash(operationData.nodeRows, row.uid)
      return { uid: row.uid, before, after, unchanged: before.sha256 === after.sha256 && before.nodeCount === after.nodeCount }
    })
  const authorityCheckpointOvertaken = clients.some(row => row.revision > targetVersion)
  const status = authorityCheckpointOvertaken ? 'inconclusive_pending_writes' : waited.every(row => row.caughtUp) && clients.every(row => row.revisionCaughtUp && row.rendererIdle && row.loadedModelMismatchCount === 0 && row.initialLoadedUidsMissing === 0) &&
    hiddenBranches.every(row => row.unchanged) ? 'pass' : 'fail'
  return { status, targetVersion, authorityCheckpointOvertaken, waitTimeoutMs: timeoutMs, clients, revisionWait: waited,
    affectedUidCount: affected.size, hiddenBranchAuthority: { branchCount: hiddenBranches.length, unchangedCount: hiddenBranches.filter(row => row.unchanged).length, branches: hiddenBranches } }
}

function summarizeMcpDispatchBins(dispatches, startedAt, durationMs) {
  const bins = Array.from({ length: Math.ceil(durationMs / 1000) }, (_, index) => ({ second: index, count: 0 }))
  for (const row of dispatches) {
    const plannedOffsetMs = Number(row.plannedAt) - Number(startedAt)
    const latenessMs = Number.isFinite(row.startLatenessMs) ? row.startLatenessMs : row.dispatchLatenessMs
    if (!Number.isFinite(plannedOffsetMs) || !Number.isFinite(latenessMs) || latenessMs < 0) continue
    const relativeDispatchOffsetMs = plannedOffsetMs + latenessMs
    const second = Math.floor(relativeDispatchOffsetMs / 1000)
    if (relativeDispatchOffsetMs >= 0 && relativeDispatchOffsetMs < durationMs && bins[second]) bins[second].count += 1
  }
  return bins
}

function summarizeSamples(samples) {
  const rows = samples.filter(row => row.category === 'mcp-single-write' && !String(row.phase).includes('warmup'))
  const byOutcome = countBy(rows, 'outcome')
  const isMissed = row => row.writeSubmitted === false || row.dispatchStatus === 'missed' || row.outcome === 'missed'
  const missedRows = rows.filter(isMissed)
  const submittedRows = rows.filter(row => !isMissed(row) && row.writeSubmitted !== false)
  const directRows = submittedRows.filter(row => row.path === 'direct' || row.submissionPath === 'direct')
  const fullRows = submittedRows.filter(row => row.path === 'full' || row.submissionPath === 'legacy')
  const driverDispatchDelay = metric(submittedRows.map(row => Number.isFinite(row.driverDispatchDelayMs)
    ? row.driverDispatchDelayMs : row.queueDelayMs))
  const result = {
    mcpSingleWriteResponse: metric(submittedRows.map(row => row.latencyMs)),
    responseLatencyDefinition: 'MCP HTTP/tool response elapsed time for requests that were actually dispatched; unsubmitted slots have null latency and are reported separately.',
    outcomes: byOutcome,
    eligibleWrites: rows.length,
    expectedWriteSlots: rows.length,
    submittedWriteCount: submittedRows.length,
    unsubmittedWriteCount: missedRows.length,
    unknownOutcomeCount: rows.filter(row => submittedRows.includes(row) && row.outcome === 'unknown').length,
    dispatchCompletenessPct: rows.length ? Number((submittedRows.length / rows.length * 100).toFixed(2)) : 100,
    directPathCount: directRows.length,
    fullOrLegacyPathCount: fullRows.length,
    pathMissingCount: submittedRows.filter(row => !directRows.includes(row) && !fullRows.includes(row)).length,
    failuresCount: rows.filter(row => row.outcome !== 'success').length,
    driverDispatchDelay: { ...driverDispatchDelay, definition: 'Worker request start minus its absolute planned slot; measures test-driver dispatch lateness, not MCP/server queue waiting.' },
    queueDelay: { ...driverDispatchDelay, aliasOf: 'driverDispatchDelay', definition: 'Compatibility alias for driver dispatch lateness; this is not server queue waiting.' }
  }
  return result
}

function summarizeServiceQueueDiagnostics(events) {
  const rows = events.filter(row => row.type === 'queue-depth-sample')
  const queueMetric = (selector) => metric(rows.map(selector).filter(Number.isFinite))
  return {
    definition: 'Server-reported instantaneous queue and pending-drain snapshots; sample latency is the diagnostics request round trip, not time spent waiting in the service queue.',
    sampleCount: rows.length,
    availableSampleCount: rows.filter(row => row.available === true).length,
    unavailableSampleCount: rows.filter(row => row.available !== true).length,
    diagnosticsRequestRoundTrip: metric(rows.map(row => row.latencyMs)),
    mcpQueuedGlobal: queueMetric(row => row.mcp && row.mcp.currentDepth),
    mcpActiveGlobal: queueMetric(row => row.mcp && row.mcp.active),
    mcpScope: 'isolated-mcp-process',
    apiAQueueStatus: 'unavailable: no room-scoped API A queue poll is added; embedded global API data is discarded',
    apiAQueueDepth: queueMetric(row => row.apiA && row.apiA.currentDepth),
    apiAPendingDrains: queueMetric(row => row.apiA && row.apiA.pendingDrains),
    apiBQueueDepth: queueMetric(row => row.apiB && row.apiB.currentDepth),
    apiBPendingDrains: queueMetric(row => row.apiB && row.apiB.pendingDrains)
  }
}

function summarizeMcpHttpLifecycle(events) {
  const rows = events.filter(row => row.type === 'mcp-http-lifecycle' && row.scope === 'isolated-mcp-process')
  const writerSamples = events.filter(row => row.type === 'queue-depth-sample' && row.mcpWriterScope === 'isolated-mcp-process')
  const countBy = key => Object.fromEntries([...new Set(rows.map(row => row[key]).filter(Boolean))]
    .map(value => [value, rows.filter(row => row[key] === value).length]))
  return {
    scope: 'isolated-mcp-process',
    processBoundary: 'One dedicated local MCP container process; these samples are not a cluster aggregate and are not room-filtered.',
    sampleCount: rows.length,
    uniqueClientRequestCount: new Set(rows.map(row => row.clientRequestId).filter(Boolean)).size,
    writerSnapshotCount: writerSamples.length,
    retentionGapSnapshotCount: writerSamples.filter(row => row.mcpWriter && row.mcpWriter.retentionGap).length,
    cursorResetSnapshotCount: writerSamples.filter(row => row.mcpWriter && row.mcpWriter.cursorResetRequired).length,
    processChangeSnapshotCount: writerSamples.filter(row => row.mcpWriter && row.mcpWriter.processChanged).length,
    stageCounts: countBy('stage'),
    phaseCounts: countBy('phase'),
    responseFinishLatency: metric(rows.filter(row => row.stage === 'response-finish').map(row => row.durationMs)),
    correlatedRequestIds: [...new Set(rows.map(row => row.clientRequestId).filter(Boolean))],
  }
}

function summarizeResourceSampling(events) {
  const sampleRows = events.filter(row => row.type === 'resource-sample')
  const skippedRows = events.filter(row => row.type === 'resource-sample-skipped')
  const errorRows = events.filter(row => row.type === 'resource-sample-error')
  const components = ['containers', 'postgres', 'redis']
  const missingCounts = Object.fromEntries(components.map(component => [component, 0]))
  for (const row of sampleRows) {
    for (const component of row.missingComponents || (row.resourceErrors || []).map(error => error.component)) {
      if (Object.prototype.hasOwnProperty.call(missingCounts, component)) missingCounts[component] += 1
    }
  }
  for (const row of skippedRows) {
    for (const component of row.missingComponents || components) {
      if (Object.prototype.hasOwnProperty.call(missingCounts, component)) missingCounts[component] += 1
    }
  }
  for (const row of errorRows) {
    for (const component of row.missingComponents || components) {
      if (Object.prototype.hasOwnProperty.call(missingCounts, component)) missingCounts[component] += 1
    }
  }
  return {
    definition: 'Each 10-second sampler trigger is counted as an attempt. Skipped or partial probes are missing observations, never zero-valued resource measurements.',
    attemptCount: sampleRows.length + skippedRows.length + errorRows.length,
    completedSampleCount: sampleRows.length,
    skippedSampleCount: skippedRows.length,
    failedSampleCount: errorRows.length,
    partialSampleCount: sampleRows.filter(row => row.partial).length,
    missingProbeCounts: missingCounts,
    resourceProbeFailures: sampleRows.reduce((count, row) => count + (row.resourceErrors || []).length, 0)
  }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

function summarizeTraceCaptureTelemetry(trace) {
  const clients = trace.clients.map(client => {
    const capture = client.trace && client.trace.captureTelemetry
    return { label: client.label, available: !!capture,
      observedRows: Number(capture && capture.observedRows) || 0,
      ringRowsAtCollection: Number(capture && capture.ringRowsAtCollection) || 0,
      ringEvictions: Number(capture && capture.ringEvictions) || 0,
      logReplacements: Number(capture && capture.logReplacements) || 0,
      hookErrors: Number(capture && capture.hookErrors) || 0,
      matchedSubmitRows: Number(capture && capture.matchedSubmitRows) || 0,
      matchedOutboxRows: Number(capture && capture.matchedOutboxRows) || 0,
      matchedAckRows: Number(capture && capture.matchedAckRows) || 0,
      mismatchedAcks: Number(capture && capture.mismatchedAcks) || 0,
      estimatedSerializedTraceBytes: Number(capture && capture.estimatedSerializedBytes) || null,
      traceArrayRowCounts: capture && capture.traceArrayRowCounts || null }
  })
  const sum = key => clients.reduce((total, client) => total + Number(client[key] || 0), 0)
  return { clients, clientCount: clients.length, unavailableClientCount: clients.filter(client => !client.available).length,
    observedRows: sum('observedRows'), ringRowsAtCollection: sum('ringRowsAtCollection'), ringEvictions: sum('ringEvictions'),
    logReplacements: sum('logReplacements'), hookErrors: sum('hookErrors'), matchedSubmitRows: sum('matchedSubmitRows'),
    matchedOutboxRows: sum('matchedOutboxRows'), matchedAckRows: sum('matchedAckRows'), mismatchedAcks: sum('mismatchedAcks'),
    estimatedSerializedTraceBytes: clients.reduce((total, client) => total + Number(client.estimatedSerializedTraceBytes || 0), 0),
    storageNote: 'Product V2 trace storage remains a 400-row ring. Harness captures only active pending-write rows and reports bounded per-page trace-array counts/estimated bytes.' }
}

function summarizeBrowserTrace(trace, operationData = {}, commitDiagnostics = null) {
  const inputs = trace.clients.flatMap(client => client.trace && client.trace.input || []).filter(row => row.phase && row.phase !== 'preflight' && !String(row.phase).includes('warmup'))
  const acks = trace.clients.flatMap(client => client.trace && client.trace.ack || []).filter(row => row.phase && row.phase !== 'preflight' && !String(row.phase).includes('warmup'))
  const submits = trace.clients.flatMap(client => client.trace && client.trace.submit || []).filter(row => row.phase && row.phase !== 'preflight' && !String(row.phase).includes('warmup'))
  const rendered = trace.clients.flatMap(client => client.trace && client.trace.rendered || [])
    .filter(row => row.source && row.issuedAt && row.phase !== 'preflight' && !String(row.phase).includes('warmup') && row.renderComplete === true && Number.isFinite(row.version))
  const tokensByWriter = new Map()
  for (const row of rendered) tokensByWriter.set(row.token, (tokensByWriter.get(row.token) || 0) + 1)
  const remoteUpperBound = []
  const remoteLowerBound = []
  const mcpCommitMarkerLatency = []
  const renderOutcomes = { stable: 0, missing: 0, duplicate: 0, uidMismatch: 0 }
  const remoteByToken = new Map()
  const allSamples = readJsonl(samplesPath).filter(row => !String(row.phase).includes('warmup'))
  const writeRows = allSamples.filter(row => ['browser-input-schedule','browser-input-error','mcp-single-write','mcp-burst-single','mcp-batch-item','mcp-batch'].includes(row.category) && row.token)
  const writes = writeRows.filter(row => ['browser-input-schedule','browser-input-error','mcp-single-write'].includes(row.category))
  const operationById = new Map((operationData.operations || []).filter(row => row.operation_id)
    .map(row => [String(row.operation_id), row]))
  const ackByToken = new Map(acks.filter(row => row.token).map(row => [row.token, row]))
  const submitByToken = new Map(submits.filter(row => row.token).map(row => [row.token, row]))
  const commitMarkersByOperationId = new Map()
  for (const marker of commitDiagnostics && commitDiagnostics.commitMarkers || []) {
    if (!marker.operationId) continue
    const rows = commitMarkersByOperationId.get(String(marker.operationId)) || []
    rows.push(marker); commitMarkersByOperationId.set(String(marker.operationId), rows)
  }
  const writeEvidenceByToken = new Map()
  let missingOperationAnchorCount = 0
  let operationAnchorCount = 0
  let mcpCommitMarkerMissingCount = 0
  let mcpCommitMarkerInconsistentCount = 0
  let createdAtAfterStableCount = 0
  const successRows = writes.filter(write => {
    if (write.category === 'mcp-single-write') return write.outcome === 'success'
    return write.category === 'browser-input-schedule' && !!submitByToken.get(write.token)
  })
  const successTokenSet = new Set(successRows.map(row => row.token))
  for (const write of writes) {
    const ack = ackByToken.get(write.token)
    const submit = submitByToken.get(write.token)
    const operationId = write.source === 'mcp' ? write.operationId :
      (ack && ack.operationId) || (submit && submit.operationId) || null
    const operation = operationId ? operationById.get(String(operationId)) : null
    const createdAtMs = operation && operation.created_at ? new Date(operation.created_at).getTime() : null
    const responseOrAckAtMs = write.source === 'mcp'
      ? (write.outcome === 'success' && write.completedAt != null ? Number(write.completedAt) : null)
      : (ack && ack.status === 'acked' && String(ack.operationId || '') === String(ack.ackOperationId || '')
          && ack.ackEpochMs != null ? Number(ack.ackEpochMs) : null)
    const markerRows = operationId ? commitMarkersByOperationId.get(String(operationId)) || [] : []
    const marker = markerRows.find(row => row.ok !== false && row.atMs != null) || markerRows[0] || null
    const markerAtMs = marker ? (marker.atMs != null && Number.isFinite(Number(marker.atMs)) ? Number(marker.atMs) : Date.parse(marker.at)) : null
    const evidence = { token: write.token, uid: write.uid, source: write.source || null, category: write.category,
      operationId: operationId ? String(operationId) : null, operationRowFound: !!operation,
      transactionStartAtMs: Number.isFinite(createdAtMs) ? createdAtMs : null,
      ackOrToolResponseAtMs: Number.isFinite(responseOrAckAtMs) ? responseOrAckAtMs : null,
      apiCommitMarkerAtMs: Number.isFinite(markerAtMs) ? markerAtMs : null }
    if (operation) operationAnchorCount += 1
    const successfulAttempt = successTokenSet.has(write.token)
    if (successfulAttempt && !Number.isFinite(createdAtMs)) missingOperationAnchorCount += 1
    if (write.source === 'mcp' && write.outcome === 'success' && !Number.isFinite(markerAtMs)) mcpCommitMarkerMissingCount += 1
    if (operation && Number.isFinite(createdAtMs) && Number.isFinite(markerAtMs) && markerAtMs < createdAtMs - 2) mcpCommitMarkerInconsistentCount += 1
    writeEvidenceByToken.set(write.token, evidence)
  }
  const expectedByToken = new Map(writes.map(row => [row.token, row]))
  for (const client of trace.clients) for (const row of client.trace && client.trace.rendered || []) {
    if (row.phase === 'preflight' || String(row.phase).includes('warmup')) continue
    if (row.writer === client.label) continue
    const expectedWrite = expectedByToken.get(row.token)
    if (!expectedWrite || String(row.uid) !== String(expectedWrite.uid)) { renderOutcomes.uidMismatch = (renderOutcomes.uidMismatch || 0) + 1; continue }
    const receivers = remoteByToken.get(row.token) || new Set()
    if (receivers.has(client.label)) renderOutcomes.duplicate += 1
    else receivers.add(client.label)
    remoteByToken.set(row.token, receivers)
    renderOutcomes.stable += 1
    const evidence = writeEvidenceByToken.get(row.token)
    if (!evidence) continue
    const transactionStartAtMs = evidence.transactionStartAtMs
    const ackOrToolResponseAtMs = evidence.ackOrToolResponseAtMs
    const apiCommitMarkerAtMs = evidence.apiCommitMarkerAtMs
    if (Number.isFinite(transactionStartAtMs) && transactionStartAtMs <= Number(row.epochMs)) {
      remoteUpperBound.push(Math.max(0, Number(row.epochMs) - transactionStartAtMs))
    } else if (Number.isFinite(transactionStartAtMs)) createdAtAfterStableCount += 1
    if (Number.isFinite(ackOrToolResponseAtMs)) remoteLowerBound.push(Math.max(0, Number(row.epochMs) - ackOrToolResponseAtMs))
    if (Number.isFinite(apiCommitMarkerAtMs) && Number(row.epochMs) >= apiCommitMarkerAtMs) {
      mcpCommitMarkerLatency.push(Number(row.epochMs) - apiCommitMarkerAtMs)
    }
  }
  const expected = new Map(writes.map(row => [row.token, row]))
  for (const [token, write] of expected) {
    const remoteExpected = write.category === 'browser-input-schedule' ? BROWSER_CLIENTS - 1 : BROWSER_CLIENTS
    const receivers = remoteByToken.get(token) || new Set()
    if (receivers.size < remoteExpected) renderOutcomes.missing += remoteExpected - receivers.size
  }
  return {
    localInput: metric(inputs.map(row => row.localMs)),
    localInputFailed: inputs.filter(row => row.status !== 'rendered').length,
    browserAck: metric(acks.map(row => row.ackMs)),
    browserAckFailed: acks.filter(row => row.status !== 'acked').length,
    ackCorrelation: {
      matchedCount: acks.filter(row => row.traceId && row.operationId && ((row.status === 'acked' && String(row.ackOperationId || '') === String(row.operationId)) || (row.status === 'rejected' && row.correlationKind === 'trace_id_with_outbox_operation_id'))).length,
      correlatedRejectionCount: acks.filter(row => row.status === 'rejected' && row.correlationKind === 'trace_id_with_outbox_operation_id').length,
      mismatchedCount: acks.filter(row => row.traceStage === 'ack_op_id_mismatch').length,
      missingCount: acks.filter(row => !row.traceId || !row.operationId || row.traceStage === 'ack_op_id_mismatch').length
    },
    traceCaptureTelemetry: summarizeTraceCaptureTelemetry(trace),
    remoteStableRenderUpperBound: metric(remoteUpperBound),
    remoteStableRenderLowerBound: metric(remoteLowerBound),
    mcpServerCommitMarkerToStableRender: metric(mcpCommitMarkerLatency),
    commitTimingEvidence: {
      transactionStartAnchor: 'room_operations.created_at is a transaction-start timestamp and therefore an upper-bound anchor for commit-to-stable latency, not the exact commit instant.',
      lowerBoundAnchor: 'Matching browser ACK or successful MCP tool response occurs after commit; stable-render minus this later timestamp is a lower bound only.',
      operationAnchorCount, successfulWriteCount: successRows.length, missingOperationAnchorCount,
      mcpCommitMarkerMissingCount, mcpCommitMarkerInconsistentCount, createdAtAfterStableCount,
      completeForSuccessfulWrites: missingOperationAnchorCount === 0 && createdAtAfterStableCount === 0,
      apiCommitDiagnosticsStatus: commitDiagnostics && commitDiagnostics.status || 'unavailable',
      apiCommitDiagnosticsRetentionGapCount: commitDiagnostics && commitDiagnostics.retentionGaps ? commitDiagnostics.retentionGaps.length : null,
      apiCommitDiagnosticsFailedPollCount: commitDiagnostics && Number(commitDiagnostics.failedPolls) || null,
      timeAlignment: commitDiagnostics && commitDiagnostics.clockAlignment || null
    },
    directRenderRecords: rendered.length,
    renderOutcomes,
    tokensWithMultipleReceivers: [...tokensByWriter.values()].filter(count => count > 1).length,
    renderCompleteEvents: trace.clients.reduce((sum, client) => sum + Number(client.trace && client.trace.renderCompleteEvents || 0), 0),
    httpByRoute: summarizeHttpSamples(trace.clients.flatMap(client => client.httpSamples || []).filter(row => row.phase && !String(row.phase).includes('warmup'))),
    sampleCaveat: '稳定呈现由 mindMap render_complete 触发，并验证 UID 模型值、DOM 文本、renderer idle 和已应用版本。commit→stable 使用 room_operations.created_at→DOM 的保守上界；匹配 ACK/工具响应→DOM 只报告下界，绝不把它当精确提交起点。MCP API 的 post-commit诊断时间单独列出并附时钟偏差/采样缺口。失败、超时、缺操作日志的样本仍计入缺失。',
    commitToStableRenderUpperBoundSampleCount: remoteUpperBound.length,
    commitToStableRenderLowerBoundSampleCount: remoteLowerBound.length,
    commitTimeMissingWriteCount: writes.filter(row => !writeEvidenceByToken.get(row.token)?.transactionStartAtMs).length,
    commitTimeMissingWriteTokens: writes.filter(row => !writeEvidenceByToken.get(row.token)?.transactionStartAtMs).map(row => row.token).slice(0, 100),
    writeTimingAnchors: [...writeEvidenceByToken.values()]
  }
}

function summarizeHttpSamples(rows) {
  const groups = new Map()
  for (const row of rows) {
    const key = `${row.method} ${row.route}`
    const items = groups.get(key) || []
    items.push(row); groups.set(key, items)
  }
  return [...groups.entries()].map(([route, items]) => ({
    route, samples: items.length, failed: items.filter(item => item.outcome !== 'response').length,
    p50Ms: percentile(items.map(item => item.latencyMs), 0.5), p95Ms: percentile(items.map(item => item.latencyMs), 0.95),
    p99Ms: percentile(items.map(item => item.latencyMs), 0.99), maxMs: Math.max(...items.map(item => item.latencyMs))
  })).sort((left, right) => left.route.localeCompare(right.route))
}

function summarizeGate(summary) {
  const result = { gates: [], overall: 'fail' }
  const add = (name, value, threshold, pass, note = '') => result.gates.push({ name, value, threshold, status: pass ? 'pass' : 'fail', note })
  const metrics = summary.metrics || {}
  const workloadRounds = [...(summary.rounds || []), ...(summary.sustained ? [summary.sustained] : [])]
  const mcpScheduleCompleteness = workloadRounds.length
    ? Math.min(...workloadRounds.map(round => Number(round.mcpSchedulingCompletenessPct) || 0))
    : null
  const browserScheduleCompleteness = workloadRounds.length
    ? Math.min(...workloadRounds.map(round => Number(round.browserEditCompletionPct) || 0))
    : null
  add('MCP 5 writes/sec schedule completeness >= 95%', mcpScheduleCompleteness, '>=95%',
    mcpScheduleCompleteness !== null && mcpScheduleCompleteness >= 95,
    '以计划5次/秒乘每轮150秒（含30秒预热）核对实际发起数；请求失败仍计入负载并单独计数。')
  add('10 browser clients edit every 2 sec >= 95%', browserScheduleCompleteness, '>=95%',
    browserScheduleCompleteness !== null && browserScheduleCompleteness >= 95,
    '按10个独立页面分别核对实际键盘输入完成数；失败输入保留在browser-input-error样本。')
  const browserOnTimeKeyboard = workloadRounds.length
    ? Math.min(...workloadRounds.map(round => Number(round.browserMinOnTimeKeyboardCompletenessPct) || 0))
    : null
  add('10 browser clients start real keyboard input on cadence >= 95%', browserOnTimeKeyboard, '>=95%',
    browserOnTimeKeyboard !== null && browserOnTimeKeyboard >= 95,
    '每个计划时点对应真实可见节点键盘输入；首字符超过下一周期才开始的操作计为迟到。')
  const mcpDispatchCompleteness = workloadRounds.length
    ? Math.min(...workloadRounds.map(round => Number(round.mcpSchedulingCompletenessPct) || 0))
    : null
  add('MCP actual RPC dispatch cadence >= 95%', mcpDispatchCompleteness, '>=95%',
    mcpDispatchCompleteness !== null && mcpDispatchCompleteness >= 95,
    '按进入 tools/call RPC 的真实派发数核对；ACK慢或请求失败仍保留为样本，不阻塞后续定时派发。')
  const ackLinkage = metrics.ackCorrelation || {}
  add('browser write queues settled before final tree capture', summary.finalBrowserSettlement && summary.finalBrowserSettlement.settled,
    true, summary.finalBrowserSettlement && summary.finalBrowserSettlement.settled === true,
    'Unfinished client outboxes are reported explicitly; a later optimistic client tree is not compared silently against an earlier database checkpoint.')
  add('browser submit/ACK traceId and opId linkage is observable', ackLinkage, '0 uncorrelated samples',
    Number(ackLinkage.missingCount) === 0 && Number(ackLinkage.mismatchedCount) === 0 && Number(ackLinkage.matchedCount) > 0,
    '性能数值只有在真实 submit trace、同 traceId 的 outbox opId 和 ACK/拒绝回执可关联时才有效；真实拒绝仍保留为失败样本。')
  const traceCapture = metrics.traceCaptureTelemetry || {}
  add('V2 trace capture hook has no loss or replacement', {
    clients: traceCapture.clientCount, unavailable: traceCapture.unavailableClientCount,
    hookErrors: traceCapture.hookErrors, logReplacements: traceCapture.logReplacements,
    ringEvictionsObserved: traceCapture.ringEvictions
  }, 'all 10 clients observed; zero hook errors/replacements',
  Number(traceCapture.clientCount) === BROWSER_CLIENTS && Number(traceCapture.unavailableClientCount) === 0 &&
    Number(traceCapture.hookErrors) === 0 && Number(traceCapture.logReplacements) === 0,
  '400-row产品环形日志可正常覆盖；harness在push时采集活动写入，另报告被环形淘汰的行数和每页trace数组容量。')
  if (summary.variant === 'C') add('真实键盘预检证明 submit/ACK/远端 DOM', summary.interactiveBrowserPreflight &&
    summary.interactiveBrowserPreflight.ackCorrelated && summary.interactiveBrowserPreflight.remoteDomMatches, true,
  !!(summary.interactiveBrowserPreflight && summary.interactiveBrowserPreflight.ackCorrelated && summary.interactiveBrowserPreflight.remoteDomMatches),
  'A/B 将 ACK 延迟、部分失败和远端传播结果作为基线数据保留；C 必须具备完整回执及稳定呈现证据。')
  add('MCP single response P95 <= 500 ms', metrics.mcpSingleWriteResponse && metrics.mcpSingleWriteResponse.p95Ms, 500, !!metrics.mcpSingleWriteResponse && metrics.mcpSingleWriteResponse.p95Ms !== null && metrics.mcpSingleWriteResponse.p95Ms <= 500)
  add('Browser ACK P95 <= 500 ms', metrics.browserAck && metrics.browserAck.p95Ms, 500, !!metrics.browserAck && metrics.browserAck.p95Ms !== null && metrics.browserAck.p95Ms <= 500)
  const renderUpperBound = metrics.remoteStableRenderUpperBound || {}
  const timingEvidence = metrics.commitTimingEvidence || {}
  const timingUpperBoundProven = timingEvidence.completeForSuccessfulWrites === true &&
    Number(timingEvidence.missingOperationAnchorCount) === 0 && Number(timingEvidence.createdAtAfterStableCount) === 0
  const mcpCommitMarkersComplete = timingEvidence.apiCommitDiagnosticsStatus === 'complete' &&
    Number(timingEvidence.mcpCommitMarkerMissingCount) === 0 && Number(timingEvidence.mcpCommitMarkerInconsistentCount) === 0
  if (summary.variant === 'C') add('successful MCP writes have per-operation post-commit diagnostics', {
    missingMarkers: timingEvidence.mcpCommitMarkerMissingCount,
    inconsistentMarkers: timingEvidence.mcpCommitMarkerInconsistentCount,
    collectorStatus: timingEvidence.apiCommitDiagnosticsStatus,
    retentionGaps: timingEvidence.apiCommitDiagnosticsRetentionGapCount,
    failedPolls: timingEvidence.apiCommitDiagnosticsFailedPollCount
  }, 'all successful MCP single writes correlated without collector gaps', mcpCommitMarkersComplete,
  'API诊断的 mcp-write/stage=commit 按 operationId 作为辅助提交锚点；计时门槛仍以 DB transaction-start created_at 的保守上界判定。')
  add('Conservative commit-to-stable render upper-bound P95 <= 1000 ms', {
    p95Ms: renderUpperBound.p95Ms, sampleCount: renderUpperBound.count,
    timingUpperBoundProven, evidence: timingEvidence
  }, 1000, timingUpperBoundProven && renderUpperBound.p95Ms !== null && renderUpperBound.p95Ms <= 1000,
  'P95使用数据库事务起点 created_at→远端稳定呈现的保守上界；ACK/工具返回→呈现另作下界，未将其冒充精确提交时刻。')
  add('Conservative commit-to-stable render upper-bound P99 <= 2000 ms', {
    p99Ms: renderUpperBound.p99Ms, sampleCount: renderUpperBound.count, timingUpperBoundProven
  }, 2000, timingUpperBoundProven && renderUpperBound.p99Ms !== null && renderUpperBound.p99Ms <= 2000)
  add('真实键盘首字符到编辑区两帧画面 P95 <= 100 ms', metrics.browserKeyEcho && metrics.browserKeyEcho.p95Ms, 100,
    !!metrics.browserKeyEcho && metrics.browserKeyEcho.p95Ms !== null && metrics.browserKeyEcho.p95Ms <= 100,
    '按真实 Playwright 键盘事件输入首字符，等待 contenteditable 文本变化及两帧绘制；仅成功键盘输入进入分位数，失败输入由每客户端完成率门槛计入。')
  if (summary.batch100) {
    add('100-item batch response <= 2000 ms', summary.batch100.responseMs, 2000, summary.batch100.responseMs <= 2000 && summary.batch100.outcome === 'success')
    add('100-item batch all-client model catch-up <= 3000 ms', summary.batch100.catchupMs, 3000,
      summary.batch100.catchupMs <= 3000 && summary.batch100.allClientsCaughtUp && summary.batch100.allRequiredDomStable,
      summary.batch100.catchupSemantics)
  }
  if (summary.variant === 'C' && summary.burst100) {
    add('100-event burst all-client catch-up', summary.burst100.catchupMs, '<=10000 ms and all clients caught up',
      summary.burst100.catchupMs <= 10000 && summary.burst100.successes === 100 && summary.burst100.allClientsCaughtUp && summary.burst100.allRequiredDomStable,
      summary.burst100.catchupSemantics)
  }
  add('eligible ordinary MCP writes use Direct path', metrics.eligibleWrites ? metrics.directPathCount === metrics.eligibleWrites : false, 'all', metrics.eligibleWrites > 0 && metrics.directPathCount === metrics.eligibleWrites, `full/legacy=${metrics.fullOrLegacyPathCount}, missing-path=${metrics.pathMissingCount}`)
  if (summary.variant === 'C') {
    add('all attempted writes have stable remote render evidence', metrics.renderOutcomes && metrics.renderOutcomes.missing,
      0, !!metrics.renderOutcomes && metrics.renderOutcomes.missing === 0 && metrics.renderOutcomes.uidMismatch === 0,
      '对失败、超时和未完成请求同样计入缺失；成功事件必须匹配操作 token、UID、render_complete 与 DOM 文本。')
    add('ordinary workload does not request full snapshots', summary.fullSnapshotEvidence && summary.fullSnapshotEvidence.noUnexpectedSnapshots,
      true, !!(summary.fullSnapshotEvidence && summary.fullSnapshotEvidence.available && summary.fullSnapshotEvidence.noUnexpectedSnapshots),
      '与键盘预检后的每实例诊断计数对比，只覆盖三轮普通负载、100项批次、100事件突发及C持续负载。')
  }
  add('operation correctness', summary.correctness && summary.correctness.status, 'pass', !!summary.correctness && summary.correctness.status === 'pass')
  if (summary.variant === 'C') {
    add('two-instance loaded tree convergence and hidden-branch authority', summary.clientTreeConvergence && summary.clientTreeConvergence.status,
      'pass', !!summary.clientTreeConvergence && summary.clientTreeConvergence.status === 'pass',
      '每页核对服务端版本、展开模型中受影响UID的文本/父子关系；隐藏分支以seed与final的权威数据库子树哈希核验，不展开全图。')
  }
  result.overall = result.gates.every(gate => gate.status === 'pass') ? 'pass' : 'fail'
  return result
}

async function cleanupDb(dbName, marker) {
  if (!dbName) return { skipped: true }
  const { Pool } = pgModule()
  const pool = new Pool({ ...PG, max: 1, connectionTimeoutMillis: 4000 })
  try {
    const check = await pool.query(`select datname,shobj_description(oid,'pg_database') as comment from pg_database where datname=$1`, [dbName])
    if (check.rowCount === 0) return { dropped: false, absent: true }
    assert(check.rows[0].comment === marker, `拒绝删除 ownership marker 不匹配的数据库：${dbName}`)
    await pool.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()`, [dbName])
    await pool.query(`DROP DATABASE ${dbName}`)
    return { dropped: true, database: dbName, ownershipMarkerVerified: true }
  } finally { await pool.end() }
}

async function cleanupRedis(dbIndex) {
  const redis = await connectRedis(dbIndex)
  try {
    const sizeBefore = await redis.dbSize()
    await redis.flushDb()
    const sizeAfter = await redis.dbSize()
    assert(sizeAfter === 0, `run-owned Redis DB ${dbIndex} cleanup verification failed (${sizeAfter})`)
    return { flushedLogicalDb: dbIndex, before: sizeBefore, after: sizeAfter, onlyCurrentDatabase: true }
  } finally { await redis.quit().catch(() => {}) }
}

async function stopOwnedContainers() {
  const results = []
  for (const [name, owner] of [...dockerOwned.entries()].reverse()) {
    const labels = docker(['inspect', '--format', '{{index .Config.Labels "codex.mcp-collab-run"}}', name]).trim()
    assert(labels === runId && owner.runId === runId && name.startsWith(`mcp-cp-${runToken}-${variant.toLowerCase()}-`), `owned container label mismatch; refuse cleanup ${name}`)
    const running = docker(['inspect', '--format', '{{.State.Running}}', name]).trim() === 'true'
    if (running) docker(['stop', '--time', '15', name])
    const logs = docker(['logs', name])
    fs.writeFileSync(path.join(runDir, `${owner.role}-container.log`), logs + '\n')
    docker(['rm', name])
    dockerOwned.delete(name)
    results.push({ name, stopped: running, removed: true, ownershipLabelVerified: true })
  }
  return results
}

async function mainRun() {
  assert(args.run, '实际运行需要 --run')
  assert(!args['mechanics-one-client'] || args.smoke, '单客户端仅允许 --smoke 机械诊断，不得用于性能采样')
  assert(['A', 'B', 'C'].includes(variant), '--variant 必须为 A、B 或 C')
  assert(['natural', 'full'].includes(renderMode), '--render-mode 必须为 natural 或 full')
  assert(PERF_IMAGE, `${variant} variant requires an explicit immutable image tag`)
  assert(sourceForVariant().manifest, `${variant} variant requires an explicit source manifest`)
  assertBaselineManifestVersion()
  const schemaSource = fixtureSchemaSource()
  assert(schemaSource.image && schemaSource.manifest,
    'Fixture schema requires --schema-image and --schema-source-manifest from the immutable candidate image for shared 009/010-generation/011/012 migrations')
  const summary = {
    runMode: args['mechanics-one-client'] ? 'mechanics-one-client' : args.smoke ? 'smoke' : args['warmup-precheck'] ? 'warmup-precheck' : 'formal',
    driverEvidence: verifyDriverInputs(),
    schema: 'mcp-collab-performance-v1', runId, variant, renderMode, startedAt: new Date().toISOString(),
    objective: 'baseline and candidate run code from immutable images; 10000 persisted nodes / natural expands 1000 renderer-tree nodes including root / full draws 1000 non-root nodes plus root / 10 real Playwright users / 5 MCP single writes per second',
    nodeVisibilitySemantics: 'Natural mode expands exactly 1000 renderer-tree nodes including root (999 non-root), leaves the default openPerformance viewport culling enabled, records actual viewport-intersecting DOM UIDs, and chooses ordinary edit targets from the intersection across all ten clients. Full mode uses the same 10000-node total fixture, with one additional visible leaf so the renderer tree contains 1001 nodes including root; only temporary Playwright pages call MindMap.updateConfig({openPerformance:false}), and the harness requires exactly 1000 non-root .smm-node elements plus one root (1001 total). Full-mode counts are reported with root separated. The production default is not changed. Optional --force-render-probe is a smoke diagnostic only and is not mixed into performance samples.',
    settings: getRunSettings(), boundaries: { remoteDeployment: false, existingAppRestarted: false, distBuildTargetTouched: false, businessRoomUsed: false },
    evidence: null, run: null, rounds: [], batch100: null, burst100: null,
    metrics: null, correctness: null, diagnostics: {}, cleanup: { containers: [], db: null, redis: null }, errors: []
  }
  let dbName = null
  let marker = null
  let gateways = []
  let browser = null
  let pages = []
  let failure = null
  let commitMarkerCollector = null
  let databaseClockAtLoad = null
  assert(!fs.existsSync(runDir), `run 输出目录已存在，拒绝覆盖：${runDir}`)
  assert(fs.existsSync(path.join(PLAYWRIGHT_MODULE_DIR, 'playwright', 'package.json')), `Playwright missing: ${PLAYWRIGHT_MODULE_DIR}`)
  assert(fs.existsSync(TASK_DEPENDENCIES), `Node20 task dependency mount missing: ${TASK_DEPENDENCIES}`)
  await Promise.all([available(API_PORT), available(API_PORT_B), available(MCP_PORT)])
  const buildDir = buildForVariant()
  assert(buildDir, `${variant} variant requires an explicit extracted frontend directory`)
  const buildEvidence = collectBuildEvidence(buildDir)
  const serviceEvidence = await verifyServices()
  const resourcesBefore = await hostResourceSnapshot(true)
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'preflight.json'), JSON.stringify({ serviceEvidence, buildEvidence, host: { node: process.version, ...resourcesBefore } }, null, 2) + '\n')
  try {
    const sourceEvidence = imageManifestEvidence(PERF_IMAGE, sourceForVariant().manifest, { requiredMigrations: variant === 'C' ? FIXTURE_MIGRATION_PATHS : [] })
    const schemaSourceEvidence = schemaSource.image === PERF_IMAGE && path.resolve(schemaSource.manifest) === path.resolve(sourceForVariant().manifest)
      ? sourceEvidence
      : imageManifestEvidence(schemaSource.image, schemaSource.manifest, { requiredMigrations: FIXTURE_MIGRATION_PATHS })
    buildEvidence.runtimeAssetMatch = verifyRuntimeAssetsInBuildDir(buildDir, sourceEvidence)
    const baselineArchiveEvidence = variant === 'C' ? null : createBaselineArchive()
    const imageId = docker(['image', 'inspect', '--format', '{{.Id}}', PERF_IMAGE]).trim()
    const schemaImageId = docker(['image', 'inspect', '--format', '{{.Id}}', schemaSource.image]).trim()
    const containerNode = docker(['run', '--rm', '--network', DOCKER_NETWORK, '--entrypoint', 'node', PERF_IMAGE, '--version']).trim()
    assert(/^v20\./.test(containerNode), `Server runtime must be Node20: ${containerNode}`)
    const playwrightInfo = await loadPlaywright()
    const markerName = `mcp-collab:${runId}:${variant}`
    dbName = `mcp_cp_20261014_${variant.toLowerCase()}_${runToken}`
    const schema = await createDatabase(dbName, markerName)
    const databaseMigration = await applyFixtureSchemaMigrations(dbName, schemaSource.image, schemaSourceEvidence)
    databaseMigration.sourceImageId = schemaImageId
    const mcpToken = `mcp-collab-test-${randomUUID()}-${randomUUID()}`
    const identityOwner = `mcp-cp-${runToken}-user-01`
    const expectedTextByUid = new Map()
    gateways = [await startGateway(buildDir, API_PORT), await startGateway(buildDir, API_PORT_B)]
    const appOrigins = gateways.map(item => item.origin)
    const namesettings = getRunSettings()
    const apiContainer = startContainer('api-a', dbName, REDIS_DB, namesettings, gateways[0].origin, appOrigins, mcpToken)
    const apiContainerB = startContainer('api-b', dbName, REDIS_DB, namesettings, gateways[0].origin, appOrigins, mcpToken)
    const mcpContainer = startContainer('mcp', dbName, REDIS_DB, namesettings, gateways[0].origin, appOrigins, mcpToken)
    const diagnosticsToken = docker(['exec', apiContainer.name, 'node', '-e', "const {issueMcpUserToken}=require('./bin/mcpUserToken.js');process.stdout.write(issueMcpUserToken(process.env.MIND_MAP_SUPER_ADMIN_IDS,process.env.MCP_TOKEN))"]).trim()
    await Promise.all([
      waitForHttp(`${apiContainer.origin}/api/health`, 'collab API A'),
      waitForHttp(`${apiContainerB.origin}/api/health`, 'collab API B')
    ])
    await waitForHttp(`http://127.0.0.1:${MCP_PORT}/health`, 'MCP HTTP')
    const health = await requestJson(`${apiContainer.origin}/api/health`)
    const healthB = await requestJson(`${apiContainerB.origin}/api/health`)
    const toolSession = await initializeMcp(gateways[0].origin, mcpToken)
    const diagnosticsSession = await initializeMcp(gateways[0].origin, diagnosticsToken)
    const diagnosticsHttpPreflight = await Promise.all([
      diagnosticsEndpointProbe(diagnosticsToken, '', API_PORT),
      diagnosticsEndpointProbe(diagnosticsToken, '', API_PORT_B)
    ])
    assert(diagnosticsHttpPreflight.every(item => item.available),
      `性能诊断 HTTP 端点预检失败: ${JSON.stringify(diagnosticsHttpPreflight.map(item => ({ status: item.status, body: item.body }))).slice(0, 1500)}`)
    const diagnosticsMcpPreflight = await mcpDiagnostics(diagnosticsSession, diagnosticsToken, 'preflight', '')
    assert(diagnosticsMcpPreflight.available,
      `MCP get_performance_diagnostics 预检失败: ${JSON.stringify(diagnosticsMcpPreflight.error || diagnosticsMcpPreflight).slice(0, 1000)}`)
    const updateTool = await verifyMcpSingleTool(toolSession)
    const fixture = makeFixture(runToken)
    const roomKey = `mcp-cp-${runToken}-${variant.toLowerCase()}`
    const userIds = Array.from({ length: BROWSER_CLIENTS }, (_, i) => `mcp-cp-${runToken}-user-${String(i + 1).padStart(2, '0')}`)
    const identities = []
    for (const userId of userIds) identities.push(await createIdentity(gateways[0].origin, userId))
    const seeded = await createRoom(gateways[0].origin, identities[0].cookie, roomKey, fixture.tree)
    const access = await addRunMembers(dbName, roomKey, identities[0], identities)
    const browserSet = await setupBrowserContexts(playwrightInfo.chromium, gateways, roomKey, identities, fixture.visibleLeaves)
    browser = browserSet.browser; pages = browserSet.pages
    summary.httpRefreshAttributionInstallation = await installHttpRefreshAttribution(pages)
    const browserVisibilityProbe = await captureBrowserVisibility(pages, 'fixture-ready')
    databaseClockAtLoad = await captureDatabaseClockAlignment(dbName)
    const initialClientStates = await captureLoadedClientStates(pages)
    const mcpDiagnosticsBefore = await mcpDiagnostics(diagnosticsSession, diagnosticsToken, 'before', roomKey)
    summary.diagnostics.apiBefore = await captureApiInstanceDiagnostics(diagnosticsToken, roomKey, 'before')
    const schemaCount = await (async () => {
      const pool = await verifyPgTarget(dbName)
      try {
        const result = await pool.query('select count(*)::int as count from room_nodes where room_key=$1', [roomKey])
        const indexRows = await pool.query(`select tablename,indexname,indexdef from pg_indexes where schemaname='public' and tablename in ('room_operations','room_operations_archive','room_restore_idempotency','room_nodes') order by tablename,indexname`)
        return { nodeCount: result.rows[0].count, relevantIndexes: indexRows.rows }
      } finally { await pool.end() }
    })()
    assert(schemaCount.nodeCount === FIXTURE_NODE_COUNT, `DB fixture node count ${schemaCount.nodeCount} != ${FIXTURE_NODE_COUNT}`)
    const seedTreeCapture = await captureRoomTreeState(dbName, roomKey, 'seed-tree.json')
    assert(seedTreeCapture.state.rows.length === FIXTURE_NODE_COUNT, `seed checkpoint node count ${seedTreeCapture.state.rows.length} != ${FIXTURE_NODE_COUNT}`)
    if (seeded.response && seeded.response.version != null) {
      assert(Number(seeded.response.version) === seedTreeCapture.state.version,
        `seed room version mismatch: response=${seeded.response.version} checkpoint=${seedTreeCapture.state.version}`)
    }
    summary.evidence = {
      host: { node: process.version, platform: process.platform, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(), freeMemoryAtSetupBytes: resourcesBefore.freeMemoryBytes, dockerContainersAtSetup: resourcesBefore.dockerContainers, playwrightVersion: require(path.join(PLAYWRIGHT_MODULE_DIR, 'playwright', 'package.json')).version },
      server: { image: PERF_IMAGE, imageId, containerNode, cpuLimitPerContainer: 4, memoryLimitPerContainer: '4g', apiProcesses: [apiContainer, apiContainerB], mcpProcess: mcpContainer, sourceBindMounted: false, runtimeCodeSource: 'immutable image; only A/B test dependency directory is bind-mounted at /perf-deps', processDiagnostics: 'MCP get_performance_diagnostics saved separately; direct diagnostics HTTP collected from both collab API instances; baseline missing fields are retained as missing.' },
      source: {
        imageManifest: sourceEvidence, baselineArchiveProvenance: baselineArchiveEvidence,
        sharedFixtureSchemaMigrations: { image: schemaSource.image, imageId: schemaImageId, manifest: schemaSourceEvidence.manifest,
          manifestSha256: schemaSourceEvidence.manifestSha256, migrationFiles: FIXTURE_MIGRATION_PATHS }
      }, frontendBuild: buildEvidence, settings: namesettings,
      configByInstance: { collabServer: { ...namesettings, redisDb: REDIS_DB, postgresDatabase: dbName }, mcpServer: { ...namesettings, redisDb: REDIS_DB, postgresDatabase: dbName } },
      isolatedServices: serviceEvidence, isolatedSchema: schema, databaseMigration, room: { roomKey, requestedNodes: FIXTURE_NODE_COUNT, expandedModelNodesExpected: VISIBLE_NODE_COUNT, persistedNodes: schemaCount.nodeCount, seededVersion: seeded.response && seeded.response.version, seedTree: seedTreeCapture.artifact, seedRequestBytes: seeded.requestBytes, access },
      initialLoadedClientStates: initialClientStates.map(client => ({ label: client.label, userId: client.userId,
        revision: client.revision, rendererIdle: client.rendererIdle, loadedModelUidCount: client.rows.length,
        loadedModelUidSha256: sha256(JSON.stringify(client.rows.map(row => row.uid).sort())), domNodeCount: client.domNodeCount,
        renderCompleteEvents: client.renderCompleteEvents })),
      health: { apiA: health.data || { status: health.response.status }, apiB: healthB.data || { status: healthB.response.status } }, browser: { count: pages.length, apiDistribution: pages.map((page, index) => ({ label: page.label, apiInstance: index < Math.ceil(BROWSER_CLIENTS / 2) ? 'api-a' : 'api-b' })), sharedNaturalViewportUidCount: browserSet.visibleUids.length, sharedNaturalViewportUids: browserSet.visibleUids, visibilityProbe: browserVisibilityProbe, users: pages.map(page => ({ label: page.label, userId: page.identity.userId, expandedModelNodes: page.readyStats.expandedModelNodes, naturalViewportDomNodes: page.readyStats.visibleDomNodes, websocketCount: page.sockets.length, state: page.readyStats.state })) },
      clockAlignment: { postgresqlAtLoad: databaseClockAtLoad, browserAndHarnessClock: 'Browser DOM epochs and harness Date.now use the same local host clock; API clock is sampled during diagnostics collection.' },
      diagnosticsPreflight: { http: diagnosticsHttpPreflight, mcp: diagnosticsMcpPreflight },
      mcpTools: [...toolSession.tools.keys()], mcpDiagnosticsBefore,
      remoteDeploymentAndAdminDiagnostics: { remoteDeployment: '用户要求不操作远端', remoteAdminDiagnostic: 'not attempted by user instruction' },
      apiOrigins: [apiContainer.origin, apiContainerB.origin], browserOrigins: gateways.map(item => item.origin), mcpOrigin: `http://127.0.0.1:${MCP_PORT}`,
      sourceFileHashes: { manifestSha256: sourceEvidence.manifestSha256, matchedImageSourceFiles: sourceEvidence.matchedSourceFileCount,
        imageSourceTreeSha256: sourceEvidence.sourceFilesSha256, runtimeAssetsSha256: sourceEvidence.runtimeAssetsSha256 }
    }
    const renderExpectations = new Map()
    let mcpWriteTool = updateTool
    if (!args.smoke) {
      summary.interactiveBrowserPreflight = await verifyInteractiveBrowserPath(pages, browserSet.visibleUids, renderExpectations)
    }
    if (args.smoke) {
      const browserUid = browserSet.visibleUids[0]
      const browserIssuedAt = Date.now()
      const browserToken = makeToken('browser-smoke', 1)
      const browserText = browserToken
      await registerRenderExpectation(pages, browserUid, browserText, browserToken, 'browser', pages[0].label, browserIssuedAt, 'smoke')
      const browserWrite = await runBrowserWrite(pages[0], browserUid, browserText, browserToken, 'smoke')
      renderExpectations.set(browserUid, browserText)

      const mcpUid = browserSet.visibleUids[1]
      const mcpOperationId = randomUUID()
      const mcpIssuedAt = Date.now()
      const mcpTokenValue = makeToken('mcp-smoke', 1)
      const mcpText = mcpTokenValue
      await registerRenderExpectation(pages, mcpUid, mcpText, mcpTokenValue, 'mcp', 'mcp-smoke-writer', mcpIssuedAt, 'smoke')
      const mcpWrite = await callMcpTool(toolSession, mcpToken, 'update_node', toolArgs(updateTool, roomKey, mcpUid, mcpText, mcpOperationId), mcpOperationId, {
        category: 'mcp-smoke-write', phase: 'smoke', uid: mcpUid, token: mcpTokenValue, plannedAt: mcpIssuedAt
      })
      renderExpectations.set(mcpUid, mcpText)
      const propagation = await waitForRenderTokens(pages, [browserToken, mcpTokenValue], 10000)
      summary.smoke = {
        browserContexts: pages.length,
        uniqueUsers: new Set(pages.map(page => page.identity.userId)).size,
        eachBrowserLive: pages.every(page => page.readyStats.state && (page.readyStats.state.status === 'live' || page.readyStats.state.phase === 'LIVE')),
        browserWrite: { uid: browserUid, token: browserToken, dispatchMs: browserWrite.dispatchMs, dispatchedTextVisible: browserWrite.textAfterDispatch === browserText },
        mcpWrite: { uid: mcpUid, operationId: mcpOperationId, outcome: mcpWrite.outcome, latencyMs: mcpWrite.latencyMs, path: mcpWrite.path, submissionPath: mcpWrite.submissionPath, error: mcpWrite.error },
        propagation,
        note: args['mechanics-one-client'] ? '单客户端机械诊断：10000节点夹具、1个真实浏览器及MCP调用，仅校验输入观测与工具连通，不是多人或性能验收。' : 'Smoke 只验证隔离环境、10000节点夹具、10个真实浏览器会话及真实 MCP 工具调用能启动；不作为性能验收。'
      }
      assert(summary.smoke.uniqueUsers === (args['mechanics-one-client'] ? 1 : BROWSER_CLIENTS) && summary.smoke.eachBrowserLive, 'smoke 未建立预期数量的独立且 live 浏览器会话')
      assert(mcpWrite.outcome === 'success', `smoke MCP write failed: ${mcpWrite.error || 'unknown'}`)
      summary.diagnostics.mcpSmoke = await mcpDiagnostics(diagnosticsSession, diagnosticsToken, 'smoke', roomKey)
    } else {
      summary.diagnostics.mcpPreload = await mcpDiagnostics(diagnosticsSession, diagnosticsToken, 'preload', roomKey)
      summary.diagnostics.apiPreload = await captureApiInstanceDiagnostics(diagnosticsToken, roomKey, 'preload')
      commitMarkerCollector = createApiCommitMarkerCollector(diagnosticsToken, roomKey)
      await commitMarkerCollector.start()
      if (args['warmup-precheck']) {
        const round = await runRound({
          name: 'load-precheck-30s', durationMs: WARMUP_MS, sampleMs: WARMUP_MS,
          pages, mcp: toolSession, mcpToken, updateTool: mcpWriteTool, roomKey, visibleUids: browserSet.visibleUids,
          expectationMap: renderExpectations, resourceSampler, databaseName: dbName, diagnosticsSession, diagnosticsToken
        })
        summary.warmupPrecheck = round
        summary.diagnostics.mcpWarmupPrecheck = await mcpDiagnostics(diagnosticsSession, diagnosticsToken, 'load-precheck-30s', roomKey)
        summary.diagnostics.apiWarmupPrecheck = await captureApiInstanceDiagnostics(diagnosticsToken, roomKey, 'load-precheck-30s')
      } else {
        const roundNames = ['round-1', 'round-2', 'round-3']
        for (const name of roundNames) {
          const round = await runRound({
            name, durationMs: WARMUP_MS + SAMPLE_WINDOW_MS, sampleMs: SAMPLE_WINDOW_MS,
            pages, mcp: toolSession, mcpToken, updateTool: mcpWriteTool, roomKey, visibleUids: browserSet.visibleUids,
            expectationMap: renderExpectations, resourceSampler, databaseName: dbName, diagnosticsSession, diagnosticsToken
          })
          summary.rounds.push(round)
          summary.diagnostics[`mcp-${name}`] = await mcpDiagnostics(diagnosticsSession, diagnosticsToken, name, roomKey)
          summary.diagnostics[`api-${name}`] = await captureApiInstanceDiagnostics(diagnosticsToken, roomKey, name)
        }
        summary.batch100 = await runBatch100(toolSession, mcpToken, pages, roomKey, fixture.visibleLeaves, browserSet.visibleUids, updateTool, toolSession.tools, renderExpectations)
        summary.burst100 = await runBurst100(toolSession, mcpToken, pages, roomKey, fixture.visibleLeaves, browserSet.visibleUids, updateTool, renderExpectations)
        summary.diagnostics.mcpAfterBatch = await mcpDiagnostics(diagnosticsSession, diagnosticsToken, 'after-batch-burst', roomKey)
        summary.diagnostics.apiAfterBatch = await captureApiInstanceDiagnostics(diagnosticsToken, roomKey, 'after-batch-burst')
        if (variant === 'C') {
          summary.sustained = await runRound({
            name: 'sustained-10m', durationMs: WARMUP_MS + SUSTAINED_MS, sampleMs: SUSTAINED_MS,
            pages, mcp: toolSession, mcpToken, updateTool: mcpWriteTool, roomKey, visibleUids: browserSet.visibleUids,
            expectationMap: renderExpectations, resourceSampler, databaseName: dbName, diagnosticsSession, diagnosticsToken
          })
          summary.diagnostics.mcpSustained = await mcpDiagnostics(diagnosticsSession, diagnosticsToken, 'sustained-end', roomKey)
          summary.diagnostics.apiSustained = await captureApiInstanceDiagnostics(diagnosticsToken, roomKey, 'sustained-end')
        }
      }
    }
    if (commitMarkerCollector) {
      summary.commitDiagnostics = await commitMarkerCollector.stop()
      commitMarkerCollector = null
    }
    summary.finalBrowserSettlement = await waitForBrowserWriteSettlement(pages, 60000)
    await sleep(3000)
    const opData = await collectOperationRows(dbName, roomKey)
    summary.evidence.clockAlignment.postgresqlAfterLoad = await captureDatabaseClockAlignment(dbName)
    const finalText = new Map()
    // Latest expected value per UID is recorded by runRound and the discrete scenarios.
    for (const [uid, text] of renderExpectations.entries()) finalText.set(uid, text)
    summary.correctness = operationCorrectness(opData, seedTreeCapture.state, finalText, roomKey)
    summary.clientTreeConvergence = await verifyClientTreeConvergence(pages, initialClientStates, seedTreeCapture.state,
      opData, fixture.visibleBranchUid)
    summary.httpRefreshAttribution = await collectHttpRefreshAttribution(pages)
    const browserTrace = await collectBrowserTrace(pages)
    await flushLogs()
    const samples = readJsonl(samplesPath)
    const events = readJsonl(eventsPath)
    const mcpMetrics = summarizeSamples(samples)
    const browserMetrics = summarizeBrowserTrace(browserTrace, opData, summary.commitDiagnostics)
    const browserKeyEchoRows = samples.filter(row => row.category === 'browser-input-ui' && row.phase !== 'preflight' && !String(row.phase).includes('warmup'))
    summary.metrics = { ...mcpMetrics, ...browserMetrics,
      serviceQueueDiagnostics: summarizeServiceQueueDiagnostics(events), mcpHttpLifecycle: summarizeMcpHttpLifecycle(events),
      resourceSampling: summarizeResourceSampling(events),
      browserKeyEcho: metric(browserKeyEchoRows.map(row => row.firstKeyEchoMs)) }
    summary.diagnostics.mcpFinal = await mcpDiagnostics(diagnosticsSession, diagnosticsToken, 'final', roomKey)
    summary.diagnostics.apiFinal = await captureApiInstanceDiagnostics(diagnosticsToken, roomKey, 'final')
    if (!args.smoke) summary.fullSnapshotEvidence = collectOrdinarySnapshotEvidence(summary.diagnostics)
    if (args['warmup-precheck']) {
      const round = summary.warmupPrecheck
      const minBinCount = round && round.mcpOneSecondBins.length ? Math.min(...round.mcpOneSecondBins.map(bin => bin.count)) : 0
      const maxBinCount = round && round.mcpOneSecondBins.length ? Math.max(...round.mcpOneSecondBins.map(bin => bin.count)) : 0
      const mcpCadenceOk = !!round && round.mcpMissedDispatchCount === 0 &&
        round.mcpSchedulingCompletenessPct >= 95 && minBinCount >= 3 && maxBinCount <= 7
      const browserCadenceOk = !!round && round.browserMinOnTimeKeyboardCompletenessPct >= 95 &&
        round.browserMinKeyboardSubmissionCompletenessPct >= 95 && round.browserEditCompletionPct >= 95
      const mechanicalPathOk = !!(summary.interactiveBrowserPreflight && summary.interactiveBrowserPreflight.submitObserved &&
        summary.interactiveBrowserPreflight.local && summary.interactiveBrowserPreflight.local.modelTextMatches)
      summary.warmupPrecheck = { ...round, result: {
        mcpActualDispatchCadenceOk: mcpCadenceOk, browserActualKeyboardCadenceOk: browserCadenceOk,
        interactiveSubmitPathOk: mechanicalPathOk,
        interactiveAckCorrelated: !!(summary.interactiveBrowserPreflight && summary.interactiveBrowserPreflight.ackCorrelated),
        interactiveRemoteDomMatches: !!(summary.interactiveBrowserPreflight && summary.interactiveBrowserPreflight.remoteDomMatches), sampledMetrics: {
          mcpSingleWriteResponse: summary.metrics.mcpSingleWriteResponse,
          browserAck: summary.metrics.browserAck,
          browserAckFailed: summary.metrics.browserAckFailed,
          remoteStableRenderUpperBound: summary.metrics.remoteStableRenderUpperBound,
          remoteStableRenderLowerBound: summary.metrics.remoteStableRenderLowerBound,
          browserKeyEcho: summary.metrics.browserKeyEcho
        },
        mcpDispatchAccounting: round ? {
          expected: round.expectedScheduledMcpCalls,
          dispatched: round.mcpDispatchedWriteCount,
          missedUnsubmitted: round.mcpUnsubmittedWriteCount,
          unknownAfterDispatch: round.mcpUnknownOutcomeCount,
          lateDispatches: round.mcpLateDispatchCount,
          note: 'Missed slots count against expected dispatches; unknown applies only to requests actually sent. Path coverage excludes unsubmitted slots.'
        } : null,
        slowAckAndPartialFailuresAreObservedOnly: true
      }, status: mcpCadenceOk && browserCadenceOk && mechanicalPathOk ? 'pass' : 'fail' }
      if (summary.warmupPrecheck.status !== 'pass') summary.errors.push({ message: '30秒实际派发预检未达到节拍或交互机械链路门槛；该轮不作为A/B/C正式采样。' })
    } else if (!args.smoke) summary.gates = summarizeGate(summary)
    summary.run = { roomKey, redisDb: REDIS_DB, postgresDatabase: dbName, seedResult: seeded.response, schemaNodeCount: schemaCount.nodeCount }
    summary.finishedAt = new Date().toISOString()
    summary.status = args.smoke ? (summary.smoke && summary.smoke.mcpWrite.outcome === 'success' ? (args['mechanics-one-client'] ? 'mechanics-pass' : 'smoke-pass') : 'smoke-fail')
      : args['warmup-precheck'] ? (summary.warmupPrecheck.status === 'pass' ? 'precheck-pass' : 'precheck-fail')
        : summary.gates.overall === 'pass' ? 'pass' : 'fail'
  } catch (error) {
    failure = error
    summary.errors.push({ message: error.message, stack: String(error.stack || '').split('\n').slice(0, 8).join('\n') })
    summary.status = 'incomplete'
  } finally {
    if (commitMarkerCollector) {
      try { summary.commitDiagnostics = await commitMarkerCollector.stop() }
      catch (error) { summary.errors.push({ message: `commit marker collector: ${error.message}` }) }
      commitMarkerCollector = null
    }
    if (pages.length) {
      try {
        if (!summary.httpRefreshAttribution) summary.httpRefreshAttribution = await collectHttpRefreshAttribution(pages)
        const trace = await collectBrowserTrace(pages)
        summary.partialBrowserTrace = { path: path.basename(browserTracePath), totals: trace.totals }
      } catch (error) { summary.errors.push({ message: `partial browser trace: ${error.message}` }) }
    }
    for (const sampler of [...activeControlReadSamplers]) await sampler.stop().catch(error => summary.errors.push({ message: `control read cleanup: ${error.message}` }))
    for (const sampler of [...activeQueueSamplers]) await sampler.stop().catch(error => summary.errors.push({ message: `queue observer cleanup: ${error.message}` }))
    for (const sampler of [...activePgWaitSamplers]) await sampler.stop().catch(error => summary.errors.push({ message: `lock observer cleanup: ${error.message}` }))
    for (const entry of [...activeRuntimeMonitors]) {
      try {
        const metrics = entry.monitor.stop()
        entry.stopped = true
        entry.result = metrics
        activeRuntimeMonitors.delete(entry)
        append(eventsPath, { type: 'driver-runtime-monitor', phase: entry.phase, source: metrics.source, metrics, stoppedDuringCleanup: true })
      } catch (error) { summary.errors.push({ message: `runtime monitor cleanup: ${error.message}` }) }
    }
    if (browser) await browser.close().catch(error => summary.errors.push({ message: `browser close: ${error.message}` }))
    for (const gateway of gateways) await new Promise(resolve => gateway.server.close(() => resolve()))
    try { summary.cleanup.containers = await stopOwnedContainers() } catch (error) { summary.errors.push({ message: `container cleanup: ${error.message}` }) }
    if (dbName) {
      try { summary.cleanup.db = await cleanupDb(dbName, `mcp-collab:${runId}:${variant}`) } catch (error) { summary.errors.push({ message: `database cleanup: ${error.message}` }) }
    }
    try { summary.cleanup.redis = await cleanupRedis(REDIS_DB) } catch (error) { summary.errors.push({ message: `redis cleanup: ${error.message}` }) }
    try { await flushLogs() } catch (error) { summary.errors.push({ message: `async log flush: ${error.message}` }) }
    summary.finishedAt = summary.finishedAt || new Date().toISOString()
    summary.failure = failure ? safeError(failure.message) : null
    if (summary.status === 'incomplete' && !failure) summary.status = 'fail'
    fs.writeFileSync(summaryPath, JSON.stringify(sanitizePersistedValue(summary), null, 2) + '\n')
  }
  console.log(JSON.stringify({ runDir, summary: summaryPath, status: summary.status, gates: summary.gates || null, cleanup: summary.cleanup, failure: summary.failure }, null, 2))
  if (failure || ['precheck-fail', 'fail', 'incomplete'].includes(summary.status)) process.exitCode = 1
}

async function main() {
  if (args['browser-observation-self-test']) {
    const report = runBrowserObservationSelfTest()
    console.log(JSON.stringify(report, null, 2))
    return
  }
  if (args['correctness-self-test']) {
    const report = runCorrectnessSelfTest()
    console.log(JSON.stringify(report, null, 2))
    return
  }
  if (args['trace-hook-self-test']) {
    const report = runTraceHookSelfTest()
    console.log(JSON.stringify(report, null, 2))
    return
  }
  if (!args.run) {
    const report = preflight()
    console.log(JSON.stringify(report, null, 2))
    return
  }
  await mainRun()
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'preflight-or-setup-failed', message: error.message }, null, 2))
  process.exitCode = 1
})
