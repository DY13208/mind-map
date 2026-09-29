/**
 * Per-room Docmost sync coordinator.
 *
 * Guarantees:
 * - single-flight: at most one Adapter.sync() in flight per room
 * - coalescing: enqueue while running marks dirty (never drops the update)
 * - rerun-if-dirty: after each sync, if dirty OR mapping behind canonical, sync again
 * - finite rounds + backoff + cooldown: never spin forever on a stuck room
 *
 * All Docmost sync entry points MUST go through requestSync / requestSyncAndWait.
 * Do not call docmostAdapter.sync() directly from API/scheduler/compile hooks.
 */

const path = require('path')
const mappingStore = require('./docmostMappingStore')

const MAX_SYNC_ROUNDS = Math.max(
  1,
  Number(process.env.DOCMOST_SYNC_MAX_ROUNDS) || 5
)
const COOLDOWN_MS = Math.max(
  1000,
  Number(process.env.DOCMOST_SYNC_COOLDOWN_MS) || 60000
)
/** Backoff before retry rounds 2..N (first sync never sleeps). Cap at last entry. */
const RETRY_BACKOFF_MS = Object.freeze([200, 500, 1000, 2000, 4000])

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
      runs: 0,
      cooldownUntil: 0,
      wakeTimer: null
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

function retryBackoffMs(completedRounds) {
  // completedRounds = how many syncs already finished before this retry
  const idx = Math.max(0, completedRounds - 1)
  return RETRY_BACKOFF_MS[Math.min(idx, RETRY_BACKOFF_MS.length - 1)]
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function clearWakeTimer(st) {
  if (st.wakeTimer) {
    clearTimeout(st.wakeTimer)
    st.wakeTimer = null
  }
}

function scheduleCooldownWake(roomId) {
  const st = getState(roomId)
  clearWakeTimer(st)
  const delay = Math.max(0, Number(st.cooldownUntil || 0) - Date.now())
  st.wakeTimer = setTimeout(() => {
    st.wakeTimer = null
    st.cooldownUntil = 0
    if (st.dirty || st.waiters.length) kick(roomId)
  }, delay)
  if (typeof st.wakeTimer.unref === 'function') st.wakeTimer.unref()
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

/**
 * Behind iff any *current canonical topic* lacks a standard mapping at
 * canonicalVersion. Soft-deleted / zombie / non-canonical topics are ignored.
 *
 * @param {any} pool
 * @param {string} roomId
 * @param {string} canonicalVersion
 * @param {string} [outputDir]
 */
async function mappingBehindCanonical(
  pool,
  roomId,
  canonicalVersion,
  outputDir
) {
  if (!pool || !canonicalVersion) return false

  let topicKeys
  try {
    const { readCanonical } = require('./adapters/canonicalInput')
    const canonical = await readCanonical(
      outputDir || defaultOutputDir(),
      roomId
    )
    topicKeys = new Set(
      (canonical.documents || []).map(doc =>
        mappingStore.topicKeyFromCanonicalPath(doc.file)
      )
    )
  } catch (_) {
    // Cannot resolve current topic set — do not spin on mapping alone.
    // adapter.sync will surface compile/publish errors on the next attempt.
    return false
  }

  if (topicKeys.size === 0) return false

  await mappingStore.ensureSchema(pool)
  const rows = await mappingStore.listRoomMappings(pool, roomId)
  const byTopic = new Map()
  for (const r of rows) {
    if (r.slot !== 'standard') continue
    byTopic.set(String(r.topic_key), r)
  }

  for (const topicKey of topicKeys) {
    const row = byTopic.get(String(topicKey))
    if (!row) return true
    if (String(row.last_synced_version || '') !== String(canonicalVersion)) {
      return true
    }
  }
  return false
}

function logRound(fields) {
  const parts = [
    '[docmost-sync]',
    'room=' + fields.roomId,
    'round=' + fields.round,
    'maxRounds=' + fields.maxRounds,
    'dirty=' + fields.dirty,
    'canonicalVersion=' + fields.canonicalVersion,
    'syncedVersion=' + fields.syncedVersion,
    'mappingBehindCanonical=' + fields.mappingBehindCanonical,
    'resultBehind=' + fields.resultBehind,
    'syncDuration=' + fields.syncDuration + 'ms',
    'backoffMs=' + fields.backoffMs,
    'action=' + fields.action
  ]
  if (fields.action === 'cooldown') {
    console.error(
      parts.join(' ') +
        ' cooldownUntil=' +
        (fields.cooldownUntil
          ? new Date(fields.cooldownUntil).toISOString()
          : '')
    )
  } else {
    console.log(parts.join(' '))
  }
}

function kick(roomId) {
  const st = getState(roomId)
  if (st.running) return st.running

  if (st.cooldownUntil && Date.now() < st.cooldownUntil) {
    scheduleCooldownWake(roomId)
    return null
  }

  st.running = (async () => {
    const adapter = require('./adapters/docmostAdapter')
    let lastResult = null
    try {
      for (let round = 1; round <= MAX_SYNC_ROUNDS; round++) {
        st.dirty = false
        st.runs += 1
        const outputDir = st.outputDir || defaultOutputDir()
        const syncStarted = Date.now()
        lastResult = await adapter.sync(roomId, {
          pool: st.pool,
          outputDir
        })
        st.lastResult = lastResult
        const syncDuration = Date.now() - syncStarted

        const version = await readCanonicalVersion(roomId, outputDir)
        const behind = await mappingBehindCanonical(
          st.pool,
          roomId,
          version,
          outputDir
        )
        const resultBehind =
          !!version &&
          !!lastResult &&
          lastResult.syncedVersion != null &&
          String(lastResult.syncedVersion) !== String(version)
        const dirty = !!st.dirty
        const needRetry = dirty || behind || resultBehind

        if (!needRetry) {
          logRound({
            roomId,
            round,
            maxRounds: MAX_SYNC_ROUNDS,
            dirty,
            canonicalVersion: version,
            syncedVersion:
              lastResult && lastResult.syncedVersion != null
                ? lastResult.syncedVersion
                : '',
            mappingBehindCanonical: behind,
            resultBehind,
            syncDuration,
            backoffMs: 0,
            action: 'break'
          })
          break
        }

        if (round >= MAX_SYNC_ROUNDS) {
          st.cooldownUntil = Date.now() + COOLDOWN_MS
          // Keep dirty so a wake after cooldown re-attempts; do not spin now.
          if (dirty) st.dirty = true
          logRound({
            roomId,
            round,
            maxRounds: MAX_SYNC_ROUNDS,
            dirty,
            canonicalVersion: version,
            syncedVersion:
              lastResult && lastResult.syncedVersion != null
                ? lastResult.syncedVersion
                : '',
            mappingBehindCanonical: behind,
            resultBehind,
            syncDuration,
            backoffMs: 0,
            action: 'cooldown',
            cooldownUntil: st.cooldownUntil
          })
          console.error(
            '[docmost-sync] room exhausted sync rounds' +
              ' room=' +
              roomId +
              ' rounds=' +
              round +
              ' canonicalVersion=' +
              version +
              ' syncedVersion=' +
              (lastResult && lastResult.syncedVersion != null
                ? lastResult.syncedVersion
                : '') +
              ' behind=' +
              behind +
              ' resultBehind=' +
              resultBehind +
              ' dirty=' +
              dirty +
              ' action=cooldown' +
              ' cooldownUntil=' +
              new Date(st.cooldownUntil).toISOString()
          )
          scheduleCooldownWake(roomId)
          break
        }

        const backoffMs = retryBackoffMs(round)
        logRound({
          roomId,
          round,
          maxRounds: MAX_SYNC_ROUNDS,
          dirty,
          canonicalVersion: version,
          syncedVersion:
            lastResult && lastResult.syncedVersion != null
              ? lastResult.syncedVersion
              : '',
          mappingBehindCanonical: behind,
          resultBehind,
          syncDuration,
          backoffMs,
          action: 'retry'
        })
        if (backoffMs > 0) await sleep(backoffMs)
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
      if (st.dirty) {
        if (st.cooldownUntil && Date.now() < st.cooldownUntil) {
          scheduleCooldownWake(roomId)
        } else {
          kick(roomId)
        }
      }
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

  if (st.cooldownUntil && Date.now() < st.cooldownUntil && !st.running) {
    scheduleCooldownWake(roomId)
    if (opts.wait) {
      return new Promise((resolve, reject) => {
        st.waiters.push({ resolve, reject })
      })
    }
    return {
      roomId,
      accepted: true,
      coalesced: true,
      skipped: false,
      reason: opts.reason || 'cooldown',
      cooldownUntil: st.cooldownUntil
    }
  }

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
  for (const st of rooms.values()) clearWakeTimer(st)
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
  MAX_SYNC_ROUNDS,
  COOLDOWN_MS,
  RETRY_BACKOFF_MS,
  retryBackoffMs,
  _resetForTests,
  _getStateForTests
}
