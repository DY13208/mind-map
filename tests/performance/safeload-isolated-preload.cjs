"use strict"
// Test-only guard and observability. Never changes product auth/ACL decisions.
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const root = path.resolve(__dirname, '../..')
const runDir = path.resolve(process.env.PERF_SAFE_RUN_DIR || '')
if (!runDir.startsWith(path.join(root, 'work/performance-tdd/safeload-acceptance') + path.sep)) throw new Error('Invalid SafeLoad evidence root')
const write = fs.writeFileSync.bind(fs), read = fs.readFileSync.bind(fs)
const secrets = ['AUTH_DEV_BYPASS_KEY', 'AUTH_SESSION_SECRET', 'MCP_TOKEN', 'WECOM_SECRET', 'PGPASSWORD'].map(key => process.env[key]).filter(Boolean)
const clean = value => secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(value))
const rootEnv = path.join(root, '.env')
let blockedEnvReads = 0
fs.readFileSync = function(file, ...args) {
  if (typeof file === 'string' && path.resolve(file) === rootEnv) {
    blockedEnvReads++
    throw new Error('SafeLoad fixture forbids repository .env access')
  }
  return read(file, ...args)
}
fs.writeFileSync = function(file, data, ...args) {
  if (typeof file === 'string' && path.resolve(file) === path.join(root, 'simple-mind-map/test/reports/p0-safeload-partial.json')) {
    return write(path.join(runDir, 'legacy-report.json'), data, ...args)
  }
  return write(file, data, ...args)
}
process.on('exit', () => write(path.join(runDir, `env-guard-${process.env.PERF_SAFE_ROLE || 'unknown'}.json`), JSON.stringify({ blockedEnvReads }) + '\n'))
if (process.env.PERF_SAFE_ROLE === 'server') {
  const net = require('node:net'), connect = net.Socket.prototype.connect
  const blocked = []
  net.Socket.prototype.connect = function(...args) {
    let options = args[0]
    if (Array.isArray(options)) options = options[0]
    if (!options || typeof options !== 'object') options = { port: args[0], host: typeof args[1] === 'string' ? args[1] : 'localhost' }
    const host = String(options.host || options.hostname || 'localhost').replace(/^\[|\]$/g, '')
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
      blocked.push({ host, port: Number(options.port) || null })
      write(path.join(runDir, 'blocked-server-egress.json'), JSON.stringify(blocked, null, 2) + '\n')
      throw new Error('SafeLoad fixture forbids non-loopback server connection')
    }
    return connect.apply(this, args)
  }
  process.on('exit', () => write(path.join(runDir, 'server-egress-guard.json'), JSON.stringify({ installed: true, blocked }) + '\n'))
  const listen = http.Server.prototype.listen
  http.Server.prototype.listen = function(...args) {
    this.once('listening', () => {
      const address = this.address()
      if (!address || address.address !== '127.0.0.1') throw new Error('SafeLoad server must listen only on loopback')
      if (process.send) process.send({ safeReady: true, base: 'http://127.0.0.1:' + address.port })
    })
    return listen.apply(this, args)
  }
} else if (process.env.PERF_SAFE_ROLE === 'legacy') {
  const assertions = [], assertionApi = require('node:assert')
  for (const name of ['ok', 'strictEqual']) {
    const original = assertionApi[name]
    assertionApi[name] = function(...args) {
      const belongs = String(new Error().stack).includes('safeLoad.partialChildren.p0.test.js')
      try {
        const result = original.apply(this, args)
        if (belongs) assertions.push({ method: name, passed: true, message: typeof args[args.length - 1] === 'string' ? clean(args[args.length - 1]).slice(0, 300) : null })
        return result
      } catch (error) {
        if (belongs) assertions.push({ method: name, passed: false, message: clean(error.message).slice(0, 1200) })
        throw error
      }
    }
  }
  process.on('exit', () => write(path.join(runDir, 'legacy-assertions.json'), JSON.stringify(assertions, null, 2) + '\n'))
  const pw = require(path.join(root, 'simple-mind-map/node_modules/@playwright/test'))
  const launch = pw.chromium.launch.bind(pw.chromium)
  const allowed = new Set(JSON.parse(process.env.PERF_SAFE_ALLOWED_ORIGINS || '[]'))
  const observations = { contexts: [], network: [], blockedNetwork: [], pageErrors: [], consoleErrors: [] }
  function persist() { write(path.join(runDir, 'browser-observations.json'), clean(JSON.stringify(observations, null, 2)) + '\n') }
  pw.chromium.launch = async function(...args) {
    if (!fs.existsSync(pw.chromium.executablePath()) && !args[0]?.executablePath && !args[0]?.channel) args[0] = { ...args[0], channel: 'chrome' }
    const browser = await launch(...args), newContext = browser.newContext.bind(browser), close = browser.close.bind(browser)
    browser.newContext = async function(...contextArgs) {
      const context = await newContext(...contextArgs)
      await context.route('**/*', route => {
        const url = new URL(route.request().url())
        if (allowed.has(url.origin) || ['data:', 'blob:', 'about:'].includes(url.protocol)) return route.continue()
        observations.blockedNetwork.push({ protocol: url.protocol, host: url.host, pathname: url.pathname })
        return route.abort()
      })
      await context.addInitScript(origins => {
        const allowed = new Set(origins), Native = window.WebSocket
        window.WebSocket = new Proxy(Native, { construct(target, args, receiver) {
          const url = new URL(String(args[0]), location.href)
          if (!allowed.has(url.origin.replace(/^ws/, 'http'))) throw new Error('SafeLoad fixture forbids external WebSocket')
          return Reflect.construct(target, args, receiver)
        } })
      }, [...allowed])
      context.on('page', page => {
        page.on('pageerror', error => { observations.pageErrors.push(clean(error.message)); persist() })
        page.on('console', message => { if (['warning','error'].includes(message.type())) { observations.consoleErrors.push({ text: clean(message.text()).slice(0, 2000), location: { url: clean(message.location().url).split('?')[0], line: message.location().lineNumber, column: message.location().columnNumber } }); persist() } })
        page.on('response', response => {
          const url = new URL(response.url())
          if (url.pathname.startsWith('/api/')) observations.network.push({ type: 'response', status: response.status(), origin: url.origin, hostname: url.hostname, pathname: url.pathname })
        })
        page.on('requestfailed', request => {
          const url = new URL(request.url())
          observations.network.push({ type: 'requestfailed', origin: url.origin, hostname: url.hostname, pathname: url.pathname, error: request.failure() && request.failure().errorText })
        })
      })
      return context
    }
    browser.close = async function(...args) {
      let pageIndex = 0
      for (const context of browser.contexts()) for (const page of context.pages()) {
        const timeout = new Promise(resolve => { const timer = setTimeout(() => resolve({ diagnosticTimeout: true }), 2000); timer.unref() })
        const snapshot = await Promise.race([page.evaluate(() => {
          const mm = window.__C2_MINDMAP__, co = mm && mm.cooperate
          const status = co && co.collabV2Adapter && co.collabV2Adapter.getStatus()
          return { pathname: location.pathname, room: new URL(location.href).searchParams.get('room'),
            hasMM: !!mm, modelNodes: mm && Object.keys(mm.renderer.nodeCache).length,
            rendering: mm && mm.renderer.isRendering, rootAvailable: !!(mm && mm.renderer.root),
            status: status && { phase: status.phase, head: status.lastServerRevision, pending: status.pendingCount, outbox: status.outboxPending },
            loadFailed: !!document.querySelector('.roomLoadFailed'), bodyText: document.body.innerText.slice(0, 1500) }
        }).catch(error => ({ diagnosticError: clean(error.message) })), timeout])
        observations.contexts.push(snapshot)
        await page.screenshot({ path: path.join(runDir, 'page-final-' + pageIndex++ + '.png'), timeout: 3000 }).catch(error => { observations.contexts.push({ screenshotError: clean(error.message) }) })
      }
      persist()
      return close(...args)
    }
    return browser
  }
}
