/**
 * Per-room Docmost sync coordinator.
 *
 * Guarantees:
 * - single-flight: at most one Adapter.sync() in flight per room
 * - coalescing: enqueue while running marks dirty (never drops the update)
 * - rerun-if-dirty: after each sync, if dirty OR mapping behind canonical, sync again
 *
 * All Docmost sync entry points MUST go through requestSync / requestSyncAndWait.
 * Do not call docmostAdapter.sync() directly from API/scheduler/compile hooks.
 */

const path = require('path')
const mappingStore = require('./docmostMappingStore')

/** @type {Map<string, any>} */
const rooms = new Map()

function getState(roomId) {
  const key = String(roomId || '')
  if (!key) throw new Error('docmostSyncCoordinator: roomId required')
  let st = rooms.get(key)
  if (!st) {
    st = {
      running: null,
      dirty: false,
      pool: null,
      outputDir: null,
      waiters: [],
      lastResult: null,
      runs: 0
    }
    rooms.set(key, st)
  }
  return st
}

function defaultOutputDir() {
  return (
    process.env.KNOWLEDGE_OUTPUT_DIR ||
    path.resolve(__dirname, '../../../knowledge')
  )
}

async function readCanonicalVersion(roomId, outputDir) {
  try {
    const { readCanonical } = require('./adapters/canonicalInput')
    const canonical = await readCanonical(
      outputDir || defaultOutputDir(),
      roomId
    )
    return String(
      (canonical.manifest && canonical.manifest.lastCompiledVersion) || ''
    )
  } catch (_) {
    return ''
  }
}

async function mappingBehindCanonical(pool, roomId, canonicalVersion) {
  if (!pool || !canonicalVersion) return false
  await mappingStore.ensureSchema(pool)
  const rows = await mappingStore.listRoomMappings(pool, roomId)
  const standards = rows.filter(r => r.slot === 'standard')
  if (standards.length === 0) {
    // No standard mapping yet but canonical exists → need sync
    return true
  }
  return standards.some(
    r => String(r.last_synced_version || '') !== String(canonicalVersion)
  )
}

function kick(roomId) {
  const st = getState(roomId)
  if (st.running) return st.running

  st.running = (async () => {
    const adapter = require('./adapters/docmostAdapter')
    let lastResult = null
    try {
      for (;;) {
        st.dirty = false
        st.runs += 1
        const outputDir = st.outputDir || defaultOutputDir()
        lastResult = await adapter.sync(roomId, {
          pool: st.pool,
          outputDir
        })
        st.lastResult = lastResult

        const version = await readCanonicalVersion(roomId, outputDir)
        const behind = await mappingBehindCanonical(st.pool, roomId, version)
        const resultBehind =
          version &&
          lastResult &&
          lastResult.syncedVersion != null &&
          String(lastResult.syncedVersion) !== String(version)

        if (st.dirty || behind || resultBehind) {
          continue
        }
        break
      }

      const waiters = st.waiters.splice(0)
      for (const w of waiters) w.resolve(lastResult)
      return lastResult
    } catch (err) {
      const waiters = st.waiters.splice(0)
      for (const w of waiters) w.reject(err)
      throw err
    } finally {
      st.running = null
      if (st.dirty) kick(roomId)
    }
  })()

  st.running.catch(() => {})
  return st.running
}

/**
 * Enqueue a sync for roomId. Coalesces if already running.
 * @param {string} roomId
 * @param {{ pool?: any, outputDir?: string, wait?: boolean, reason?: string, env?: any }} [opts]
 */
async function requestSync(roomId, opts = {}) {
  const adapter = require('./adapters/docmostAdapter')
  if (!adapter.syncEnabled(opts.env || process.env)) {
    return { roomId, skipped: true, reason: 'DOCMOST_SYNC_ENABLED off' }
  }
  const st = getState(roomId)
  if (opts.pool) st.pool = opts.pool
  if (opts.outputDir) st.outputDir = opts.outputDir

  // Mark dirty so an in-flight sync will rerun after it finishes
  st.dirty = true

  if (opts.wait) {
    return new Promise((resolve, reject) => {
      st.waiters.push({ resolve, reject })
      kick(roomId)
    })
  }

  const coalesced = !!st.running
  kick(roomId)
  return {
    roomId,
    accepted: true,
    coalesced,
    reason: opts.reason || 'enqueue'
  }
}

async function requestSyncAndWait(roomId, opts = {}) {
  return requestSync(roomId, { ...opts, wait: true })
}

function _resetForTests() {
  rooms.clear()
}

function _getStateForTests(roomId) {
  return rooms.get(String(roomId)) || null
}


module.exports = {
  requestSync,
  requestSyncAndWait,
  readCanonicalVersion,
  mappingBehindCanonical,
  _resetForTests,
  _getStateForTests
}
