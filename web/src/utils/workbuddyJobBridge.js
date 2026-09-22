/**
 * 脑图「运行」→ 本机 / 局域网其他主机 的 WorkBuddy 任务派发客户端
 *
 * 协议参考 D:\test\workbuddy\test1.py（每台电脑的桥接）与 comm.py（主服务 · 通讯页）：
 *
 *   主机桥接  test1.py --lan            http://<ip>:8799
 *     GET  /api/gateways                    这台电脑正在运行的 WorkBuddy 会话
 *     GET  /api/jobs?gateway=<url>          某个会话下的任务列表
 *     POST /api/dispatch  {gateway,prompt,name}   派发任务
 *     POST /api/stop      {gateway,id}            停止任务
 *
 *   主服务    comm.py                   http://<页面host>:5000
 *     GET  /api/peers                       各主机登记表（name/ip/port/online）
 *     GET  /api/gateways?ip=&port=          代查某台主机
 *     GET  /api/jobs?ip=&port=&gateway=
 *     POST /api/dispatch  {ip,port,gateway,prompt,name}   按 IP 转发到那台电脑
 *
 * 浏览器直连其他主机依赖 test1.py 的 --lan：接口只放行本机与私网来源，跨源按私网白名单回 CORS。
 * 直连不通（对方未开 --lan、或跨源被拦）时，退回经主服务转发。
 */
import { getRuntimeConfig } from './runtimeConfig'

const DEFAULT_BRIDGE = 'http://127.0.0.1:8799'
const DEFAULT_HUB_PORT = 5000
const HOST_PORT = 8799
const TIMEOUT = 8000
const DISPATCH_TIMEOUT = 60000

function trimBase(url) {
  return String(url || '').replace(/\/+$/, '')
}

function runtime() {
  return (typeof window !== 'undefined' && window.__MIND_MAP_RUNTIME__) || {}
}

function pageHost() {
  const loc =
    typeof window !== 'undefined' ? window.location || {} : {}
  const host = String(loc.hostname || '').trim()
  return host && host !== '0.0.0.0' ? host : '127.0.0.1'
}

export function isLoopbackIp(ip) {
  return (
    ip === '127.0.0.1' || ip === 'localhost' || ip === '::1' || ip === ''
  )
}

/** 本机（当前浏览器所在电脑）的任务桥地址 */
export function getJobBridgeBase() {
  const cfg = getRuntimeConfig()
  return trimBase(
    runtime().workbuddyJobBridge || cfg.workbuddyJobBridge || DEFAULT_BRIDGE
  )
}

/** 主服务（通讯页 comm.py）地址：默认页面所在主机的 5000 端口 */
export function getJobHubBase() {
  const cfg = getRuntimeConfig()
  const configured = runtime().workbuddyJobHub || cfg.workbuddyJobHub
  if (configured) return trimBase(configured)
  return `http://${pageHost()}:${DEFAULT_HUB_PORT}`
}

export function normalizeHost(raw = {}) {
  const ip = String(raw.ip || raw.host || '').trim()
  const port = Number(raw.port || HOST_PORT) || HOST_PORT
  const name = String(raw.name || raw.title || '').trim()
  return {
    ip,
    port,
    name,
    online: raw.online !== false,
    self: !!raw.self,
    manual: !!raw.manual,
    key: `${ip}:${port}`,
    url: `http://${ip}:${port}`,
    label: (name ? `${name} · ` : '') + `${ip}:${port}`
  }
}

function withRole(host, role) {
  return { ...host, role, label: `${host.label}（${role}）` }
}

export function hostBase(host) {
  if (!host) return DEFAULT_BRIDGE
  if (host.url) return trimBase(host.url)
  const ip = String(host.ip || '127.0.0.1')
  const port = Number(host.port || HOST_PORT) || HOST_PORT
  return `http://${ip}:${port}`
}

async function request(url, options = {}) {
  const useAbort = typeof AbortController !== 'undefined'
  const controller = useAbort ? new AbortController() : null
  const timer = useAbort
    ? setTimeout(
        () => controller.abort(),
        options.timeout || TIMEOUT
      )
    : null
  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller ? controller.signal : undefined
    })
    const text = await res.text()
    let json = {}
    try {
      json = text ? JSON.parse(text) : {}
    } catch (_) {
      json = { raw: text }
    }
    return { ok: res.ok, status: res.status, json }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      offline: true,
      error: (err && err.message) || '请求失败'
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function pickError(res, fallback) {
  const json = res && res.json
  if (res && res.offline) return res.error || fallback
  if (json) {
    if (typeof json.error === 'string' && json.error) return json.error
    if (json.error) return JSON.stringify(json.error)
    if (json.raw) return String(json.raw)
  }
  return `${fallback}（HTTP ${(res && res.status) || 0}）`
}

/** 主服务登记的局域网主机列表（通讯页 /api/peers） */
export async function listHubPeers() {
  const hub = getJobHubBase()
  const res = await request(`${hub}/api/peers`)
  if (!res.ok) {
    return {
      ok: false,
      hub,
      peers: [],
      error: res.offline
        ? `连不上主服务 ${hub}（通讯页 comm.py 是否在运行？）`
        : pickError(res, '主服务没有返回主机列表')
    }
  }
  const rows = res.json && Array.isArray(res.json.peers) ? res.json.peers : []
  return { ok: true, hub, peers: rows.map(normalizeHost) }
}

/** 本机桥接（127.0.0.1:8799）的会话列表 */
export async function listLocalGateways() {
  const res = await request(`${getJobBridgeBase()}/api/gateways`)
  if (!res.ok) {
    return {
      ok: false,
      gateways: [],
      error: pickError(res, '连不上本机任务桥')
    }
  }
  const list = res.json && Array.isArray(res.json.gateways) ? res.json.gateways : []
  return { ok: true, gateways: list }
}

/** 兼容旧调用：以前只认本机桥接 */
export async function listJobGateways() {
  return listLocalGateways()
}

/**
 * 组装可选执行主机：主服务登记表 + 本机桥接 + 主服务（页面所在主机）兜底。
 * 默认主机 = 页面所在的那台（主服务），这样才能「主服务 ↔ 其他主机」互发。
 */
export async function resolveJobHosts() {
  const local = normalizeHost({
    ip: '127.0.0.1',
    port: HOST_PORT,
    name: '这台电脑',
    self: true
  })
  const localProbe = await listLocalGateways()
  local.online = localProbe.ok
  if (!local.online) local.error = localProbe.error

  const hubRes = await listHubPeers()
  const hosts = []
  const seen = new Set()

  const push = item => {
    if (!item.ip || seen.has(item.key)) return
    seen.add(item.key)
    hosts.push(item)
  }

  const pageHostIp = pageHost()
  const server = hubRes.peers.find(p => p.ip === pageHostIp)
  if (server) push(withRole(server, '主服务'))
  // 主服务的 127.0.0.1 登记项由本机探测代替
  hubRes.peers
    .filter(p => !isLoopbackIp(p.ip))
    .forEach(p => push(p))
  push(local)

  const online = hosts.filter(h => h.online)
  const defaultHost =
    (server && server.online && hosts.find(h => h.key === server.key)) ||
    (server && hosts.find(h => h.key === server.key)) ||
    (local.online ? local : null) ||
    online[0] ||
    hosts[0] ||
    null

  return {
    ok: !!(hubRes.ok || local.online),
    hosts,
    defaultHost,
    hub: hubRes.hub,
    error: hubRes.ok || local.online ? '' : hubRes.error
  }
}

/**
 * 某台主机上正在运行的 WorkBuddy 会话。
 * 先直连那台主机的桥接；直连不通时退回主服务代查。
 */
export async function listHostGateways(host) {
  const target = normalizeHost(host || {})
  if (!target.ip) return { ok: false, gateways: [], error: '没有指定主机' }

  const local = isLoopbackIp(target.ip)
  const directBase = local ? getJobBridgeBase() : hostBase(target)

  const res = await request(`${directBase}/api/gateways`)
  if (res.ok) {
    return { ok: true, gateways: readGateways(res.json), diag: readDiag(res.json), via: 'direct' }
  }

  if (!local) {
    const hub = getJobHubBase()
    const relayed = await request(
      `${hub}/api/gateways?ip=${encodeURIComponent(target.ip)}&port=${target.port}`
    )
    if (relayed.ok) {
      return {
        ok: true,
        gateways: readGateways(relayed.json),
        diag: readDiag(relayed.json),
        via: 'hub'
      }
    }
  }

  return {
    ok: false,
    gateways: [],
    error: local
      ? pickError(res, '连不上本机任务桥，请先运行 test1.py')
      : `连不上 ${target.label}（那台电脑要运行 test1.py --lan）`
  }
}

function readGateways(json) {
  return json && Array.isArray(json.gateways) ? json.gateways : []
}

function readDiag(json) {
  return (json && json.diag) || null
}

/** 网关列表为空时，用桥接给的诊断说清楚为什么 */
export function describeEmptyGateways(diag) {
  const count = diag && Number(diag.sessions)
  if (count) {
    const skipped = Array.isArray(diag.skipped) ? diag.skipped : []
    const why = skipped
      .slice(0, 2)
      .map(item => `${item.cwd || '会话'}：${item.why || '不可用'}`)
      .join('；')
    return `这台主机上有 ${count} 条 WorkBuddy 会话，但没有一条的网关可用（${
      why || '网关已失效'
    }）。请重新打开桌面版 WorkBuddy 的任务后再刷新。`
  }
  return '这台主机上没有 WorkBuddy 会话。请在它上面打开桌面版 WorkBuddy，进入任意一条任务，然后点「刷新主机」。'
}

/**
 * 派发任务。host 为空或回环 → 本机桥接；其他主机 → 直连，失败再经主服务转发。
 * @param {{host?: object, gateway?: string, prompt: string, name?: string}} opts
 */
export async function dispatchWorkbuddyJob(opts = {}) {
  const prompt = String(opts.prompt || '').trim()
  if (!prompt) {
    return { ok: false, error: '任务内容不能为空' }
  }
  const target = normalizeHost(opts.host || {})
  const payload = {
    gateway: opts.gateway || undefined,
    prompt,
    name: opts.name || '脑图运行'
  }

  if (isLoopbackIp(target.ip) || !target.ip) {
    const res = await request(`${getJobBridgeBase()}/api/dispatch`, {
      method: 'POST',
      body: payload,
      timeout: DISPATCH_TIMEOUT
    })
    return shapeJobResult(res, target)
  }

  const direct = await request(`${hostBase(target)}/api/dispatch`, {
    method: 'POST',
    body: payload,
    timeout: DISPATCH_TIMEOUT
  })
  if (direct.ok && direct.json && direct.json.ok) {
    return shapeJobResult(direct, target)
  }

  const retriable =
    direct.offline ||
    !direct.status ||
    direct.status === 403 ||
    direct.status === 404 ||
    direct.status === 502
  if (retriable) {
    const hub = getJobHubBase()
    const relayed = await request(`${hub}/api/dispatch`, {
      method: 'POST',
      body: { ip: target.ip, port: target.port, ...payload },
      timeout: DISPATCH_TIMEOUT
    })
    const shaped = shapeJobResult(relayed, target)
    if (shaped.ok) {
      shaped.via = 'hub'
      return shaped
    }
    return {
      ok: false,
      host: target,
      error: shaped.error || `直连与主服务转发都失败`
    }
  }

  return shapeJobResult(direct, target)
}

function shapeJobResult(res, target) {
  const json = (res && res.json) || {}
  if (json.ok) {
    return {
      ok: true,
      host: target,
      job: json.job || {},
      gatewayCwd: json.gatewayCwd || '',
      taskTitle: json.taskTitle || '',
      via: 'direct'
    }
  }
  return {
    ok: false,
    host: target,
    status: res && res.status,
    error: pickError(res, '派发失败')
  }
}

/** 某台主机上某个会话的任务列表 */
export async function listHostJobs({ host, gateway } = {}) {
  const target = normalizeHost(host || {})
  if (!target.ip) return { ok: false, jobs: [], error: '没有指定主机' }
  const query = gateway ? `?gateway=${encodeURIComponent(gateway)}` : ''
  const local = isLoopbackIp(target.ip)
  const directBase = local ? getJobBridgeBase() : hostBase(target)

  const res = await request(`${directBase}/api/jobs${query}`)
  if (res.ok) {
    return {
      ok: true,
      jobs: (res.json && res.json.jobs) || [],
      via: 'direct'
    }
  }
  if (!local) {
    const hub = getJobHubBase()
    const relayed = await request(
      `${hub}/api/jobs?ip=${encodeURIComponent(target.ip)}&port=${
        target.port
      }${gateway ? `&gateway=${encodeURIComponent(gateway)}` : ''}`
    )
    if (relayed.ok) {
      return {
        ok: true,
        jobs: (relayed.json && relayed.json.jobs) || [],
        via: 'hub'
      }
    }
  }
  return { ok: false, jobs: [], error: pickError(res, '拿不到任务列表') }
}

/**
 * 取某个任务的完整回答。
 * 任务列表里的 detail 只有一行摘要（~100 字），全文在桥接的 /api/transcript。
 */
export async function fetchJobTranscript({ host, jobId } = {}) {
  if (!jobId) return { ok: false, error: '缺少任务 id' }
  const target = normalizeHost(host || {})
  const local = isLoopbackIp(target.ip) || !target.ip
  const query = `?id=${encodeURIComponent(jobId)}`

  const res = await request(
    `${local ? getJobBridgeBase() : hostBase(target)}/api/transcript${query}`,
    { timeout: 45000 }
  )
  if (res.ok && res.json && res.json.ok) {
    return { ok: true, ...res.json, via: 'direct' }
  }
  if (!local) {
    const hub = getJobHubBase()
    const relayUrl =
      `${hub}/api/transcript?ip=${encodeURIComponent(target.ip)}` +
      `&port=${target.port}&id=${encodeURIComponent(jobId)}`
    const relayed = await request(relayUrl, { timeout: 60000 })
    if (relayed.ok && relayed.json && relayed.json.ok) {
      return { ok: true, ...relayed.json, via: 'hub' }
    }
  }
  return { ok: false, error: pickError(res, '拿不到完整回答') }
}

/** 停止某台主机上的某个任务（comm.py 没有转发接口，只走直连） */
export async function stopHostJob({ host, gateway, id } = {}) {
  const target = normalizeHost(host || {})
  if (!id) return { ok: false, error: '缺少任务 id' }
  const local = isLoopbackIp(target.ip) || !target.ip
  const res = await request(
    `${local ? getJobBridgeBase() : hostBase(target)}/api/stop`,
    { method: 'POST', body: { gateway, id } }
  )
  if (res.ok && res.json && res.json.ok) return { ok: true, result: res.json }
  return { ok: false, error: pickError(res, '停止失败') }
}
