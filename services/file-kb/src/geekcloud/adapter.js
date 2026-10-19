'use strict'
// Isolated JackYun MCP client. Only typed lookups are exported; there is no generic
// toolName + arguments passthrough. Results are reduced to whitelisted fields and treated as data.
const { CATALOG } = require('./catalog')
const { resolveAccess, FORBIDDEN_REASONS } = require('./policy')
const { tokenFingerprint } = require('./config')
const { createBreaker } = require('../docling/breaker')

const SKU = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,63}$/
// JackYun silently caps a page at 10 rows whatever pageSize says, so page by 10.
const STOCK_PAGE = 10
const STOCK_MAX_PAGES = 10
const MAX_ROWS = 500

class GeekcloudError extends Error {
  constructor(code, message) {
    super(message || code)
    this.code = code
  }
}

const MESSAGES = {
  auth_failed: '吉客云认证失败，请检查服务端密钥',
  timeout: '吉客云请求超时',
  unreachable: '无法连接吉客云',
  rate_limited: '吉客云限流，请稍后再试',
  local_rate_limited: '查询过于频繁，请稍后再试',
  busy: '吉客云查询排队已满',
  breaker_open: '吉客云连续失败，已暂停调用',
  tool_unavailable: '吉客云未提供该工具',
  tool_error: '吉客云返回错误',
  bad_response: '吉客云响应格式无法识别',
  tool_not_allowed: '该吉客云工具不在只读白名单内',
  upstream_error: '吉客云调用失败'
}

function plain(value, max = 300) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

function classify(err) {
  const status = Number(err && err.code)
  const text = String((err && err.message) || '')
  if (err && err.code === 'BREAKER_OPEN') return { code: 'breaker_open', retryable: false, failure: false }
  if (status === 401 || status === 403 || /unauthori[sz]ed|invalid token|forbidden/i.test(text)) return { code: 'auth_failed', retryable: false, failure: true }
  if (status === 429 || /\b429\b|too many requests|rate.?limit/i.test(text)) return { code: 'rate_limited', retryable: false, failure: true }
  if (status === -32001 || /timed? ?out|timeout|aborted/i.test(text)) return { code: 'timeout', retryable: false, failure: true }
  if (status === -32602 && /not found/i.test(text)) return { code: 'tool_unavailable', retryable: false, failure: false }
  if (status === 404 || /session/i.test(text)) return { code: 'unreachable', retryable: true, failure: true, session: true }
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket|network|closed/i.test(text) || (status >= 500 && status < 600)) {
    return { code: 'unreachable', retryable: true, failure: true }
  }
  return { code: 'upstream_error', retryable: false, failure: true }
}

function normalizeRow(fields, row) {
  const out = {}
  if (!row || typeof row !== 'object' || Array.isArray(row)) return out
  for (const [key, type] of Object.entries(fields)) {
    if (row[key] == null || row[key] === '') continue
    if (type === 'number') {
      const n = Number(row[key])
      out[key] = Number.isFinite(n) ? n : null
    } else out[key] = plain(row[key])
  }
  return out
}

// JackYun wraps a second MCP-shaped envelope inside content[0].text; the payload is an array of
// containers like [{"goods":[...]}]. Anything else is rejected instead of guessed at.
function parseRows(def, result) {
  if (!result || result.isError) throw new GeekcloudError('tool_error')
  const textOf = content => {
    const item = Array.isArray(content) ? content.find(c => c && c.type === 'text' && typeof c.text === 'string') : null
    return item ? item.text : null
  }
  const parse = text => {
    try { return JSON.parse(text) } catch (_) { throw new GeekcloudError('bad_response') }
  }
  const first = textOf(result.content)
  if (first == null) throw new GeekcloudError('bad_response')
  let data = parse(first)
  if (data && !Array.isArray(data) && typeof data === 'object' && Array.isArray(data.content)) {
    if (data.isError) throw new GeekcloudError('tool_error')
    const inner = textOf(data.content)
    if (inner == null) throw new GeekcloudError('bad_response')
    data = parse(inner)
  }
  if (!Array.isArray(data)) throw new GeekcloudError('bad_response')
  const rows = []
  for (const el of data) {
    if (!el || typeof el !== 'object' || Array.isArray(el)) throw new GeekcloudError('bad_response')
    if (def.rowKey) {
      if (!Array.isArray(el[def.rowKey])) throw new GeekcloudError('bad_response')
      rows.push(...el[def.rowKey])
    } else {
      const arrays = Object.values(el).filter(Array.isArray)
      if (arrays.length === 1) rows.push(...arrays[0])
      else if (el.goodsNo != null || el.skuBarcode != null) rows.push(el)
      else throw new GeekcloudError('bad_response')
    }
    if (rows.length > MAX_ROWS) break
  }
  return rows.slice(0, MAX_ROWS).map(r => normalizeRow(def.fields, r))
}

function createGeekcloudAdapter({ config, sdk, audit = async () => {}, now = () => Date.now() } = {}) {
  const allowed = new Set(config.allowedTools)
  const breaker = createBreaker({ threshold: config.breakerThreshold, openMs: config.breakerOpenMs, now })
  const conn = { state: config.enabled ? (config.configured ? 'unknown' : 'not_configured') : 'disabled', checkedAt: null, latencyMs: null }
  let lastError = null
  let client = null
  let connecting = null
  let active = 0
  const waiters = []
  const windows = new Map()

  function reset() {
    const c = client
    client = null
    if (c) c.close().catch(() => {})
  }

  async function connect() {
    if (client) return client
    if (connecting) return connecting
    if (!sdk || !sdk.Client || !sdk.StreamableHTTPClientTransport) throw new GeekcloudError('upstream_error', 'mcp sdk missing')
    connecting = (async () => {
      const transport = new sdk.StreamableHTTPClientTransport(new URL(config.endpoint), {
        requestInit: { headers: { Authorization: config.token } }
      })
      const c = new sdk.Client({ name: 'file-kb-geekcloud', version: '0.1.0' })
      try {
        await c.connect(transport, { timeout: config.timeoutMs })
      } catch (err) {
        c.close().catch(() => {})
        throw err
      }
      c.onclose = () => { if (client === c) client = null }
      client = c
      return c
    })()
    try { return await connecting } finally { connecting = null }
  }

  function acquire() {
    if (active < config.maxConcurrency) {
      active++
      return Promise.resolve()
    }
    if (waiters.length >= config.maxConcurrency * 4) return Promise.reject(new GeekcloudError('busy'))
    return new Promise((resolve, reject) => {
      const entry = { go: () => { clearTimeout(timer); active++; resolve() } }
      const timer = setTimeout(() => {
        const i = waiters.indexOf(entry)
        if (i >= 0) waiters.splice(i, 1)
        reject(new GeekcloudError('busy'))
      }, config.timeoutMs)
      waiters.push(entry)
    })
  }

  function release() {
    active--
    const next = waiters.shift()
    if (next) next.go()
  }

  function takeRate(userId) {
    const t = now()
    const hits = (windows.get(userId) || []).filter(x => t - x < 60000)
    if (hits.length >= config.perUserPerMinute) {
      windows.set(userId, hits)
      return false
    }
    hits.push(t)
    windows.set(userId, hits)
    if (windows.size > 5000) windows.delete(windows.keys().next().value)
    return true
  }

  function fail(code, tool) {
    lastError = { code, message: MESSAGES[code] || MESSAGES.upstream_error, tool: tool || null, at: new Date(now()).toISOString() }
    if (code === 'auth_failed') conn.state = 'auth_failed'
    else if (code === 'unreachable' || code === 'timeout') conn.state = 'unreachable'
  }

  async function record(user, action, target, meta) {
    try {
      await audit({ actor: String(user.id), action, target, meta })
    } catch (_) { /* audit is best effort; never block a query */ }
  }

  async function invoke(user, name, params, ctx) {
    if (!allowed.has(name) || !Object.prototype.hasOwnProperty.call(CATALOG, name)) throw new GeekcloudError('tool_not_allowed')
    const def = CATALOG[name]
    const args = def.args(params)
    const started = now()
    let attempts = 0
    let code = null
    let rowsOut = 0
    let held = false
    try {
      if (!takeRate(String(user.id))) throw new GeekcloudError('local_rate_limited')
      await acquire()
      held = true
      try { breaker.before() } catch (err) { throw new GeekcloudError('breaker_open') }
      for (;;) {
        attempts++
        let result
        try {
          const c = await connect()
          result = await c.callTool({ name, arguments: args }, undefined, { timeout: config.timeoutMs })
        } catch (err) {
          const info = classify(err)
          reset()
          if (info.retryable && attempts < 2) continue
          if (info.failure) breaker.failure()
          else breaker.success()
          throw new GeekcloudError(info.code)
        }
        breaker.success()
        conn.state = 'connected'
        const rows = parseRows(def, result)
        rowsOut = rows.length
        return rows
      }
    } catch (err) {
      code = err instanceof GeekcloudError ? err.code : 'upstream_error'
      fail(code, name)
      throw err instanceof GeekcloudError ? err : new GeekcloudError(code)
    } finally {
      if (held) release()
      await record(user, 'geekcloud.call', name, {
        status: code ? 'error' : 'ok', code, durationMs: now() - started, attempts, rows: rowsOut,
        via: (ctx && ctx.via) || 'unknown', sku: params && params.sku ? String(params.sku) : null
      })
    }
  }

  function partError(err) {
    const code = (err && err.code) || 'upstream_error'
    return { code, message: MESSAGES[code] || MESSAGES.upstream_error }
  }

  async function lookupSku(user, { sku, want = {}, via } = {}) {
    const access = resolveAccess(config, user)
    const queriedAt = new Date(now()).toISOString()
    const started = now()
    const base = { source: 'geekcloud', dataKind: 'realtime', sku: sku || null, queriedAt }
    if (!access.allowed) return { ...base, status: FORBIDDEN_REASONS.includes(access.reason) ? 'forbidden' : 'unavailable', reason: access.reason, durationMs: 0 }
    if (!SKU.test(String(sku || ''))) return { ...base, status: 'bad_request', reason: 'bad_sku', durationMs: 0 }
    // Owner scope is checked on the goods row, so goods lookup must be allowed and the scope non-empty.
    if (!access.owners.length) return { ...base, status: 'forbidden', reason: 'no_owner_scope', durationMs: 0 }
    if (!allowed.has('getGoodsListInfoByGoodsNo')) return { ...base, status: 'forbidden', reason: 'owner_unverifiable', durationMs: 0 }
    const owners = new Set(access.owners)
    const inOwnerScope = r => !!r.ownerName && owners.has(r.ownerName)
    const ctx = { via }
    const out = { ...base, status: 'ok', scope: { warehouses: access.warehouses, allWarehouses: access.allWarehouses, owners: access.owners, price: access.price }, goods: null, stock: null, price: null, errors: [], missing: [] }
    const can = name => allowed.has(name)

    if (can('getGoodsListInfoByGoodsNo')) {
      try {
        const all = await invoke(user, 'getGoodsListInfoByGoodsNo', { sku }, ctx)
        const rows = all.filter(inOwnerScope)
        const exact = rows.filter(r => r.goodsNo === sku)
        if (!exact.length && all.some(r => r.goodsNo === sku)) {
          // The SKU exists but belongs to an owner outside the caller's scope: no goods, stock or price.
          out.goods = { status: 'forbidden', items: [], candidates: [] }
          out.status = 'forbidden'
          out.reason = 'owner_out_of_scope'
          out.durationMs = now() - started
          return out
        }
        if (!exact.length) {
          const candidates = rows.filter(r => r.goodsNo || r.skuBarcode).slice(0, 5)
            .map(r => ({ goodsNo: r.goodsNo || null, goodsName: r.goodsName || null, skuName: r.skuName || null, skuBarcode: r.skuBarcode || null, matchedBy: r.skuBarcode === sku ? 'skuBarcode' : 'prefix' }))
          out.goods = { status: 'not_found', items: [], candidates }
          out.status = candidates.length ? 'needs_clarification' : 'not_found'
          out.durationMs = now() - started
          return out
        }
        out.goods = { status: 'ok', items: exact, candidates: [] }
      } catch (err) {
        out.goods = { status: 'error', items: [], candidates: [] }
        out.errors.push({ part: 'goods', ...partError(err) })
        out.status = 'error'
        out.durationMs = now() - started
        return out
      }
    } else out.missing.push('goods')

    if (want.stock) {
      if (!can('getGoodsStockQuantityListInfo')) out.missing.push('stock')
      else if (!access.warehouses.length) out.stock = { status: 'no_warehouse_scope', items: [], totals: null, truncated: false }
      else {
        try {
          // ["*"] = all warehouses: no warehouse filter is sent and rows are not filtered by warehouse.
          // Pages are still capped (STOCK_MAX_PAGES x STOCK_PAGE rows); hitting the cap sets truncated.
          const all = access.allWarehouses === true
          const scope = new Set(access.warehouses)
          const single = !all && access.warehouses.length === 1 ? access.warehouses[0] : null
          const items = []
          const seen = new Set()
          let truncated = false
          // JackYun pages are not stable and may repeat rows; keep the first copy of each sku/warehouse.
          for (let page = 0; page < STOCK_MAX_PAGES; page++) {
            const rows = await invoke(user, 'getGoodsStockQuantityListInfo', { sku, warehouseCode: single, pageIndex: page, pageSize: STOCK_PAGE }, ctx)
            for (const r of rows) {
              const key = `${r.goodsNo}|${r.skuBarcode || ''}|${r.warehouseCode}`
              if (r.goodsNo !== sku || (!all && !scope.has(r.warehouseCode)) || seen.has(key)) continue
              seen.add(key)
              items.push(r)
            }
            if (rows.length < STOCK_PAGE) break
            if (page === STOCK_MAX_PAGES - 1) truncated = true
          }
          const sum = key => items.reduce((acc, r) => acc + (Number.isFinite(r[key]) ? r[key] : 0), 0)
          out.stock = { status: 'ok', items, totals: { currentQuantity: sum('currentQuantity'), useQuantity: sum('useQuantity'), warehouses: items.length }, truncated }
        } catch (err) {
          out.stock = { status: 'error', items: [], totals: null, truncated: false }
          out.errors.push({ part: 'stock', ...partError(err) })
        }
      }
    }

    if (want.price) {
      if (!can('getGoodsPriceListInfo')) out.missing.push('price')
      else if (!access.price) out.price = { status: 'forbidden', reason: 'price_not_allowed', items: [] }
      else {
        try {
          const rows = await invoke(user, 'getGoodsPriceListInfo', { sku }, ctx)
          const items = rows.filter(r => r.goodsNo === sku)
          out.price = { status: items.length ? 'ok' : 'empty', items }
        } catch (err) {
          out.price = { status: 'error', items: [] }
          out.errors.push({ part: 'price', ...partError(err) })
        }
      }
    }

    if (out.errors.length) out.status = 'partial'
    out.durationMs = now() - started
    return out
  }

  async function listWarehouses(user, { via } = {}) {
    const access = resolveAccess(config, user)
    const queriedAt = new Date(now()).toISOString()
    const base = { source: 'geekcloud', dataKind: 'realtime', queriedAt }
    if (!access.allowed) return { ...base, status: FORBIDDEN_REASONS.includes(access.reason) ? 'forbidden' : 'unavailable', reason: access.reason }
    // All warehouses: JackYun needs a code per lookup, so there is no list to show; nothing is called.
    if (access.allWarehouses) return { ...base, status: 'ok', items: [], allWarehouses: true, errors: [], truncated: false }
    if (!allowed.has('getWarehouseListInfo')) return { ...base, status: 'ok', items: access.warehouses.map(code => ({ warehouseCode: code })), missing: ['warehouse'] }
    const items = []
    const errors = []
    for (const code of access.warehouses.slice(0, 10)) {
      try {
        const rows = await invoke(user, 'getWarehouseListInfo', { code }, { via })
        const hit = rows.find(r => r.warehouseCode === code)
        items.push(hit || { warehouseCode: code, missing: true })
      } catch (err) {
        errors.push({ part: 'warehouse', warehouseCode: code, ...partError(err) })
        if (err.code === 'auth_failed' || err.code === 'breaker_open') break
      }
    }
    return { ...base, status: errors.length ? (items.length ? 'partial' : 'error') : 'ok', items, errors, truncated: access.warehouses.length > 10 }
  }

  async function check(user) {
    const access = resolveAccess(config, user)
    if (!access.allowed) return { ok: false, state: conn.state, reason: access.reason }
    const started = now()
    let code = null
    try {
      try { breaker.before() } catch (_) { throw new GeekcloudError('breaker_open') }
      let listed
      try {
        reset()
        const c = await connect()
        listed = await c.listTools(undefined, { timeout: config.timeoutMs })
      } catch (err) {
        const info = classify(err)
        reset()
        if (info.failure) breaker.failure()
        throw new GeekcloudError(info.code)
      }
      breaker.success()
      const remote = new Map((listed.tools || []).map(t => [t.name, t]))
      const tools = config.allowedTools.map(name => {
        const t = remote.get(name)
        const props = t && t.inputSchema && t.inputSchema.properties ? Object.keys(t.inputSchema.properties) : []
        const missingProps = CATALOG[name].requiredProps.filter(p => !props.includes(p))
        return { name, label: CATALOG[name].label, available: !!t, schemaOk: !!t && !missingProps.length, missingProps }
      })
      conn.state = tools.every(t => t.available && t.schemaOk) ? 'connected' : 'schema_mismatch'
      conn.checkedAt = new Date(now()).toISOString()
      conn.latencyMs = now() - started
      return { ok: conn.state === 'connected', state: conn.state, checkedAt: conn.checkedAt, latencyMs: conn.latencyMs, tools, remoteToolCount: remote.size }
    } catch (err) {
      code = err instanceof GeekcloudError ? err.code : 'upstream_error'
      fail(code, null)
      conn.checkedAt = new Date(now()).toISOString()
      conn.latencyMs = now() - started
      return { ok: false, state: conn.state, checkedAt: conn.checkedAt, latencyMs: conn.latencyMs, error: { code, message: MESSAGES[code] || MESSAGES.upstream_error } }
    } finally {
      await record(user, 'geekcloud.check', 'tools/list', { status: code ? 'error' : 'ok', code, durationMs: now() - started })
    }
  }

  function status(user) {
    const access = resolveAccess(config, user)
    let host = null
    try { host = config.endpoint ? new URL(config.endpoint).host : null } catch (_) { host = null }
    return {
      enabled: config.enabled,
      configured: config.configured,
      configErrors: config.errors.map(e => e.replace(/=.*$/, '')),
      endpointHost: host,
      token: { configured: !!config.token, fingerprint: tokenFingerprint(config.token) },
      allowedTools: config.allowedTools.map(name => ({ name, label: CATALOG[name].label, description: CATALOG[name].description })),
      access: { allowed: access.allowed, reason: access.reason, warehouses: access.warehouses, allWarehouses: access.allWarehouses, owners: access.owners, price: access.price },
      connection: { ...conn },
      breaker: breaker.state(),
      lastError,
      limits: { timeoutMs: config.timeoutMs, maxConcurrency: config.maxConcurrency, perUserPerMinute: config.perUserPerMinute }
    }
  }

  function close() { reset() }

  return { lookupSku, listWarehouses, check, status, close }
}

function createDbAudit(query) {
  return ({ actor, action, target, meta }) =>
    query('insert into kb.audit (actor, action, target, meta) values ($1, $2, $3, $4)', [actor, action, target, meta])
}

module.exports = { createGeekcloudAdapter, createDbAudit, parseRows, classify, GeekcloudError, SKU }
