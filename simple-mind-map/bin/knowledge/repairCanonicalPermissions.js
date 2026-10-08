'use strict'

const fs = require('fs/promises')
const path = require('path')
const { Pool } = require('pg')
const { safeId } = require('./utils')
const { repairRoomPermissions } = require('./manifestStore')

function outputRoot(env = process.env) {
  return path.resolve(env.KNOWLEDGE_OUTPUT_DIR || path.resolve(__dirname, '../../../knowledge'))
}

function parseSelection(args) {
  if (args[0] === '--all' && args.length === 1) return { all: true }
  if (args[0] === '--rooms' && args.length > 1) {
    const roomIds = [...new Set(args.slice(1).flatMap(value => String(value).split(/[\s,]+/)).filter(Boolean))]
      .map(safeId)
    if (roomIds.length) return { all: false, roomIds }
  }
  throw new Error('Usage: repairCanonicalPermissions.js --rooms <roomId...> | --all')
}

async function listRoomIds(root) {
  const entries = await fs.readdir(root, { withFileTypes: true })
  return entries.filter(entry => {
    if (!entry.isDirectory() || entry.name.startsWith('.')) return false
    try { return safeId(entry.name) === entry.name } catch { return false }
  }).map(entry => entry.name)
}

async function main(args = process.argv.slice(2), env = process.env) {
  const selection = parseSelection(args)
  const root = outputRoot(env)
  const roomIds = selection.all ? await listRoomIds(root) : selection.roomIds
  if (!env.PGHOST || !env.PGDATABASE || !env.PGUSER) {
    throw new Error('PostgreSQL connection settings are required to share the compiler room lock')
  }
  // Load the application compiler only for an actual maintenance run. This
  // keeps argument parsing and filesystem contract tests independent from the
  // full renderer dependency tree.
  const { KnowledgeCompiler } = require('./compiler')
  const pool = new Pool({
    host: env.PGHOST,
    port: Number(env.PGPORT || 5432),
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    application_name: 'mind-map-canonical-permission-repair',
    max: 1,
    connectionTimeoutMillis: Math.max(1000, Number(env.PGPOOL_CONNECT_TIMEOUT_MS || 8000))
  })
  const compiler = new KnowledgeCompiler({ pool, outputDir: root, log: () => {} })
  let failed = 0
  try {
    await pool.query('select 1')
    for (const roomId of roomIds) {
      try {
        const locked = await compiler.withLock(roomId, async () => repairRoomPermissions(root, roomId))
        if (locked.status === 'busy') throw new Error('Knowledge compilation is active; retry after it finishes')
        console.log(`[CanonicalPermissions] repaired room=${locked.roomId} files=${locked.files}`)
      } catch (error) {
        failed += 1
        console.error(`[CanonicalPermissions] failed room=${roomId}: ${error.message}`)
      }
    }
  } finally {
    await pool.end()
  }
  console.log(`[CanonicalPermissions] total=${roomIds.length} failed=${failed}`)
  if (failed) process.exitCode = 1
}

if (require.main === module) {
  require('../loadEnv')
  main().catch(error => {
    console.error(`[CanonicalPermissions] ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = { outputRoot, parseSelection, listRoomIds, main }
