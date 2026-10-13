const fs = require('fs')
const Module = require('module')
const crypto = require('crypto')

const metricsFileBase = String(process.env.MCP_BASELINE_METRICS_FILE || '').trim()
const metricsFile = metricsFileBase.replace(/\.jsonl$/i, `-${process.pid}.jsonl`)
const instance = String(process.env.MCP_BASELINE_INSTANCE || 'unknown')
const pending = []
const transactions = new WeakMap()
let sourceObserverInstalled = false

function emit(type, details = {}) {
  pending.push({
    schema: 1,
    time: new Date().toISOString(),
    monotonicNs: process.hrtime.bigint().toString(),
    pid: process.pid,
    instance,
    type,
    ...details
  })
}

function flush() {
  if (!metricsFile || !pending.length) return
  const rows = pending.splice(0, pending.length)
  const lines = rows.map(row => JSON.stringify(row)).join('\n')
  try {
    fs.appendFileSync(metricsFile, `${lines}\n`)
  } catch (error) {
    pending.unshift(...rows)
    try {
      process.stderr.write(`[mcp-baseline] metrics flush failed: ${error.message}\n`)
    } catch (_) {}
  }
}

globalThis.__MCP_BASELINE_RECORD__ = emit
const flushTimer = setInterval(flush, 1000)
if (typeof flushTimer.unref === 'function') flushTimer.unref()
process.on('exit', flush)

function queryText(input) {
  if (typeof input === 'string') return input
  if (input && typeof input.text === 'string') return input.text
  return ''
}

function queryKind(sql) {
  const text = String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase()
  if (/^begin\b/.test(text) || /^start transaction\b/.test(text)) return 'begin'
  if (/^commit\b/.test(text)) return 'commit'
  if (/^rollback\b/.test(text)) return 'rollback'
  if (text.includes(' for update')) return 'lock_acquire'
  if (/\bfrom rooms\b/.test(text) && /^select\b/.test(text)) return 'rooms_read'
  if (/\b(?:insert|update|delete)\s+(?:into\s+)?room_nodes\b/.test(text)) return 'room_nodes_write'
  if (/\bfrom room_nodes\b/.test(text) && /^select\b/.test(text)) return 'room_nodes_read'
  if (/\b(?:insert|update|delete)\s+(?:into\s+)?room_operations\b/.test(text)) return 'operations_write'
  if (/\bfrom\s+room_operations\b/.test(text) && /^select\b/.test(text)) return 'operations_read'
  if (/\b(?:insert|update|delete)\s+(?:into\s+)?room_outbox\b/.test(text)) return 'outbox_write'
  if (/^select\b/.test(text)) return 'select'
  if (/^insert\b/.test(text)) return 'insert'
  if (/^update\b/.test(text)) return 'update'
  if (/^delete\b/.test(text)) return 'delete'
  return 'other'
}

function queryValues(args) {
  const query = args[0]
  if (query && Array.isArray(query.values)) return query.values
  if (Array.isArray(args[1])) return args[1]
  return []
}

function roomMarkerHash(value) {
  return typeof value === 'string' && value.startsWith('mcp-baseline-')
    ? crypto.createHash('sha1').update(value).digest('hex').slice(0, 12)
    : null
}

function shapeHash(sql) {
  const normalized = String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase()
  return normalized ? crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 12) : ''
}

function installPgInstrumentation(pg) {
  const Client = pg && pg.Client
  if (!Client || !Client.prototype || Client.prototype.__mcpBaselineWrapped) return
  const originalQuery = Client.prototype.query
  Object.defineProperty(Client.prototype, '__mcpBaselineWrapped', { value: true })
  Client.prototype.query = function (...args) {
    const sql = queryText(args[0])
    const kind = queryKind(sql)
    const values = queryValues(args)
    const roomKeyHash = roomMarkerHash(values[0])
    const operationId = kind === 'operations_write'
      ? String(values[2] || '')
      : kind === 'operations_read' ? String(values[1] || '') : ''
    const started = process.hrtime.bigint()
    let state = transactions.get(this)
    if (kind === 'begin') {
      state = { started, counts: Object.create(null), lockAcquireRoundTripMs: [], queryMs: 0, roomKeyHash: null, operationIds: new Set() }
      transactions.set(this, state)
    }
    const finish = error => {
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
      state = transactions.get(this)
      if (state && kind !== 'commit' && kind !== 'rollback') {
        state.counts[kind] = (state.counts[kind] || 0) + 1
        state.queryMs += elapsedMs
        if (roomKeyHash) state.roomKeyHash = roomKeyHash
        if (operationId) state.operationIds.add(operationId)
        if (kind === 'lock_acquire') state.lockAcquireRoundTripMs.push(elapsedMs)
      }
      if (kind === 'lock_acquire' || kind === 'room_nodes_read' || kind === 'rooms_read') {
        emit('pg_query', { kind, elapsedMs, sqlShape: shapeHash(sql), roomKeyHash, error: error ? String(error.code || error.message || error) : null })
      }
      if (kind === 'commit' || kind === 'rollback') {
        if (state) {
          emit('pg_transaction', {
            outcome: kind,
            elapsedMs: Number(process.hrtime.bigint() - state.started) / 1e6,
            queryMs: state.queryMs,
            counts: state.counts,
            lockAcquireRoundTripMs: state.lockAcquireRoundTripMs,
            roomKeyHash: state.roomKeyHash,
            operationIds: Array.from(state.operationIds),
            error: error ? String(error.code || error.message || error) : null
          })
          transactions.delete(this)
        }
      }
    }
    const callbackIndex = args.findIndex((arg, index) => index > 0 && typeof arg === 'function')
    if (callbackIndex >= 0) {
      const callback = args[callbackIndex]
      args[callbackIndex] = function (error, ...rest) {
        finish(error)
        return callback.call(this, error, ...rest)
      }
      return originalQuery.apply(this, args)
    }
    const result = originalQuery.apply(this, args)
    if (result && typeof result.then === 'function') {
      return result.then(
        value => { finish(null); return value },
        error => { finish(error); throw error }
      )
    }
    return result
  }
  emit('instrumentation', { component: 'pg.Client.query', installed: true })
}

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  const exported = originalLoad.call(this, request, parent, isMain)
  if (request === 'pg') installPgInstrumentation(exported)
  return exported
}

function instrumentCacheFunction(source) {
  const normalizedSource = String(source).replace(/\r\n?/g, '\n')
  const signature = 'async function applyCommittedLive(roomKey, command, committed) {'
  const trustedMarker = '\n}\n\n/**\n * Trusted in-process mutation'
  const start = normalizedSource.indexOf(signature)
  if (start < 0) return { source, installed: false, reason: 'signature_missing' }
  const close = normalizedSource.indexOf(trustedMarker, start)
  if (close < 0) return { source, installed: false, reason: 'end_marker_missing' }
  const bodyStart = start + signature.length
  const closeBrace = close + 1
  const body = normalizedSource.slice(bodyStart, close)
  const replacement = `${signature}
  const __mcpBaselineCacheStarted = process.hrtime.bigint()
  try {${body}
  } finally {
    globalThis.__MCP_BASELINE_RECORD__ && globalThis.__MCP_BASELINE_RECORD__('cache_sync', {
      operationType: command && command.type,
      operationId: command && command.operationId,
      elapsedMs: Number(process.hrtime.bigint() - __mcpBaselineCacheStarted) / 1e6
    })
  }
}`
  return {
    source: normalizedSource.slice(0, start) + replacement + normalizedSource.slice(closeBrace + 1),
    installed: true
  }
}

const originalCompile = Module.prototype._compile
Module.prototype._compile = function (content, filename) {
  if (!sourceObserverInstalled && /[/\\]simple-mind-map[/\\]bin[/\\]mindApi\.js$/.test(String(filename))) {
    sourceObserverInstalled = true
    const observed = instrumentCacheFunction(content)
    emit('source_observer', { component: 'applyCommittedLive', installed: observed.installed, reason: observed.reason || '' })
    content = observed.source
  }
  return originalCompile.call(this, content, filename)
}

if (typeof globalThis.fetch === 'function') {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async function (input, init) {
    const rawUrl = typeof input === 'string' ? input : input && input.url
    const started = process.hrtime.bigint()
    let response
    let error
    try {
      response = await originalFetch.call(this, input, init)
      return response
    } catch (caught) {
      error = caught
      throw caught
    } finally {
      try {
        const url = new URL(String(rawUrl || ''))
        if (/\/api\/files\//.test(url.pathname)) {
          const roomMatch = url.pathname.match(/^\/api\/files\/([^/]+)/)
          const rawRoomKey = roomMatch ? decodeURIComponent(roomMatch[1]) : ''
          const roomKeyHash = rawRoomKey.startsWith('mcp-baseline-')
            ? crypto.createHash('sha1').update(rawRoomKey).digest('hex').slice(0, 12)
            : null
          const kind = url.searchParams.get('format') === 'meta'
            ? 'mcp_meta_read'
            : /\/nodes(?:\/|$)/.test(url.pathname) ? 'mcp_node_write' : 'api_files'
          emit('http_client', {
            kind,
            roomKeyHash,
            method: String((init && init.method) || (input && input.method) || 'GET').toUpperCase(),
            statusCode: response ? response.status : 0,
            headersElapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
            error: error ? String(error.code || error.message || error) : null
          })
        }
      } catch (_) {}
    }
  }
}

