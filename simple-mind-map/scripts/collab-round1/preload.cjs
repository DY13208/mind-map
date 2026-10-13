// Loaded only by the isolated diagnostic containers. Never read repository .env.
if (process.env.COLLAB_ROUND1_DIAG === '1') {
  if (process.env.MIND_MAP_SKIP_ROOT_ENV !== '1' ||
      process.env.PGDATABASE !== 'diag_collab_round1' ||
      process.env.PGHOST !== 'round1-pg') throw new Error('diagnostic isolation guard rejected environment')
  const fs = require('fs')
  const Module = require('module')
  const { monitorEventLoopDelay, performance } = require('perf_hooks')
  const stream = fs.createWriteStream(`/round1-out/server-${process.pid}.jsonl`, { flags: 'a' })
  let loggingFailed = false
  const role = process.argv.some(value => /collabServer\.js$/.test(value)) ? 'collab' : 'mcp'
  stream.on('error', () => { loggingFailed = true; process.stderr.write('ROUND1_DIAGNOSTICS_WRITE_FAILED\n') })
  const emit = row => {
    if (!loggingFailed) stream.write(JSON.stringify({ atMs: performance.timeOrigin + performance.now(), pid: process.pid, role, ...row }) + '\n')
  }
  globalThis.__COLLAB_PERF_OBSERVER__ = emit
  const transactions = new WeakMap(), pools = new Set()
  const originalLoad = Module._load
  Module._load = function (...args) {
    const exported = originalLoad.apply(this, args)
    if ((args[0] === 'http' || args[0] === 'node:http') && !exported.__round1Clock) {
      const createServer = exported.createServer
      exported.__round1Clock = true
      exported.createServer = function (...serverArgs) {
        const index = serverArgs.findIndex(x => typeof x === 'function')
        if (index >= 0) {
          const listener = serverArgs[index]
          serverArgs[index] = function (req, res) {
            if (req.method === 'GET' && req.url === '/__round1_clock') {
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ atMs: performance.timeOrigin + performance.now() })); return
            }
            return listener.call(this, req, res)
          }
        }
        return createServer.apply(this, serverArgs)
      }
    }
    if (args[0] === 'pg' && !exported.Client.prototype.__round1) {
      const Client = exported.Client
      const original = Client.prototype.query
      Object.defineProperty(Client.prototype, '__round1', { value: true })
      Client.prototype.query = function (...queryArgs) {
        const sql = String(typeof queryArgs[0] === 'string' ? queryArgs[0] : queryArgs[0]?.text || '').toLowerCase()
        const values = Array.isArray(queryArgs[1]) ? queryArgs[1] : queryArgs[0]?.values || []
        const start = performance.now()
        if (/^begin\b/.test(sql.trim())) transactions.set(this, { start, ops: [] })
        const tx = transactions.get(this)
        const insertedOp = /insert into room_operations/.test(sql) ? { roomKey: values[0], revision: Number(values[1]), opId: values[2] } : null
        const finish = error => {
          if (!error && insertedOp && tx) tx.ops.push(insertedOp)
          if (/\bfor update\b/.test(sql)) emit({ kind: 'lock_roundtrip', elapsedMs: performance.now() - start, ok: !error })
          if (/^(commit|rollback)\b/.test(sql.trim())) {
            if (tx) {
              emit({ kind: 'transaction', elapsedMs: performance.now() - tx.start, ok: !error, outcome: sql.trim() })
              if (!error && /^commit\b/.test(sql.trim())) for (const op of tx.ops) emit({ kind: 'commit', ...op })
            }
            transactions.delete(this)
          }
        }
        const callbackIndex = queryArgs.findIndex((x, i) => i > 0 && typeof x === 'function')
        if (callbackIndex >= 0) {
          const callback = queryArgs[callbackIndex]
          queryArgs[callbackIndex] = function (error, ...rest) { finish(error); return callback.call(this, error, ...rest) }
          return original.apply(this, queryArgs)
        }
        let result
        try { result = original.apply(this, queryArgs) } catch (error) { finish(error); throw error }
        return result && typeof result.then === 'function'
          ? result.then(value => { finish(null); return value }, error => { finish(error); throw error }) : result
      }
      const OriginalPool = exported.Pool
      exported.Pool = class extends OriginalPool { constructor(...poolArgs) { super(...poolArgs); pools.add(this) } }
      emit({ kind: 'instrumentation', component: 'pg', enabled: true })
    }
    return exported
  }
  const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable()
  let cpu = process.cpuUsage(), previous = performance.now()
  setInterval(() => {
    const now = performance.now(), usage = process.cpuUsage(cpu)
    cpu = process.cpuUsage()
    emit({ kind: 'resource', cpuPercent: (usage.user + usage.system) / ((now - previous) * 1000) * 100,
      memory: process.memoryUsage(), eventLoop: { p50Ms: delay.percentile(50) / 1e6, p95Ms: delay.percentile(95) / 1e6,
        p99Ms: delay.percentile(99) / 1e6, maxMs: delay.max / 1e6 },
      pools: [...pools].map(pool => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount })) })
    previous = now; delay.reset()
  }, 1000).unref()
}
