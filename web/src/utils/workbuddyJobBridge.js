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
 *   主服务    通讯页（LanComm / comm.py）
 *     地址不能靠猜：页面在公网域名上时 http://<域名>:5000 常被别的服务占着
 *     （实测 xx.stillgroup.net:5000 是群晖 NAS），通讯页其实在局域网某台机器上。
 *     所以这里准备一组候选地址逐个探测，谁回的 /api/peers 合法就用谁，见 resolveJobHub()
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
// 通讯页可能监听的端口：新版 5050、老版 5000
const HUB_PORT_CANDIDATES = [5050, 5000]
const HUB_OVERRIDE_KEY = 'mindmap-job-hub'
const HUB_CACHE_KEY = 'mindmap-job-hub-resolved'
const HUB_PROBE_TIMEOUT = 2500
const HUB_CACHE_TTL = 30000
const HUB_FAIL_TTL = 5000
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

function pageOrigin() {
  try {
    const loc = typeof window !== 'undefined' ? window.location || {} : {}
    return loc.origin && loc.origin !== 'null' ? trimBase(loc.origin) : ''
  } catch (err) {
    return ''
  }
}

/** 局域网 / 回环主机名。公网域名不算 —— 那样会把 <域名>:5000 猜成通讯页 */
export function isPrivateHost(host) {
  const value = String(host || '').trim().toLowerCase()
  if (!value) return false
  if (isLoopbackIp(value)) return true
  if (value.endsWith('.local') || value.endsWith('.lan')) return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

function urlHubParam() {
  try {
    const loc = typeof window !== 'undefined' ? window.location || {} : {}
    const q = new URLSearchParams(loc.search || '').get('hub')
    return q ? trimBase(q) : ''
  } catch (err) {
    return ''
  }
}

function storedHubOverride() {
  try {
    return trimBase(window.localStorage.getItem(HUB_OVERRIDE_KEY) || '')
  } catch (err) {
    return ''
  }
}

/** 手动指定的通讯页地址：页面地址加 ?hub=http://ip:端口 优先，其次本地记下的 */
export function getJobHubOverride() {
  return urlHubParam() || storedHubOverride()
}

/** 记住通讯页地址（传空串清掉）。改完会丢掉「上次连上的地址」缓存，下次重新探测 */
export function setJobHubOverride(url) {
  try {
    const value = trimBase(url)
    if (value) window.localStorage.setItem(HUB_OVERRIDE_KEY, value)
    else window.localStorage.removeItem(HUB_OVERRIDE_KEY)
  } catch (err) {
    /* 隐私模式下写不进去，忽略 */
  }
  try {
    window.sessionStorage.removeItem(HUB_CACHE_KEY)
  } catch (err) {
    /* 同上 */
  }
  hubResolved = null
  hubExpireAt = 0
  return getJobHubOverride()
}

/**
 * 通讯页候选地址，按可信度排序：
 * ① 页面 URL 的 ?hub= ② 构建时注入的配置 ③ 本地记下的
 * ④ 页面自己就在局域网时，同主机的 5050 / 5000 ⑤ 同源 /jobhub（服务器把通讯页反代到这儿）
 */
export function jobHubCandidates() {
  const cfg = getRuntimeConfig()
  const out = []
  const push = url => {
    const value = trimBase(url)
    if (value && !out.includes(value)) out.push(value)
  }
  push(urlHubParam())
  push(runtime().workbuddyJobHub)
  push(cfg.workbuddyJobHub)
  push(storedHubOverride())
  const host = pageHost()
  if (isPrivateHost(host)) {
    HUB_PORT_CANDIDATES.forEach(port => push(`http://${host}:${port}`))
  }
  const origin = pageOrigin()
  if (origin) push(`${origin}/jobhub`)
  return out
}

/** 同步拿一个「最可能对」的地址：只用于展示和兜底，真正请求请用 resolveJobHub() */
export function getJobHubBase() {
  const candidates = jobHubCandidates()
  return candidates[0] || `http://${pageHost()}:${DEFAULT_HUB_PORT}`
}

function noHubTip(tried) {
  const list = tried.slice(0, 4).join('、')
  return (
    `没找到通讯页（试过 ${list || '没有候选地址'}）。` +
    '页面在公网域名上时浏览器不允许直连局域网 http 地址：' +
    '可在服务器把 /jobhub 反代到通讯页，或打开页面时加 ?hub=http://<通讯页IP>:端口'
  )
}

function readHubCache() {
  try {
    return trimBase(window.sessionStorage.getItem(HUB_CACHE_KEY) || '')
  } catch (err) {
    return ''
  }
}

function writeHubCache(base) {
  try {
    window.sessionStorage.setItem(HUB_CACHE_KEY, base)
  } catch (err) {
    /* 忽略 */
  }
}

/** 探一个候选：必须回 JSON 且带 peers 数组才算通讯页（群晖那种 HTML 页面不算） */
async function probeJobHub(base) {
  const res = await request(`${base}/api/peers`, { timeout: HUB_PROBE_TIMEOUT })
  if (!res.ok) return null
  const json = res.json
  if (!json || !Array.isArray(json.peers)) return null
  return { base, peers: json.peers }
}

let hubResolved = null
let hubExpireAt = 0
let hubInFlight = null

async function doResolveJobHub() {
  const candidates = jobHubCandidates()
  if (!candidates.length) {
    return { ok: false, base: '', peers: [], tried: [], error: noHubTip([]) }
  }
  const cached = readHubCache()
  const list =
    cached && candidates.includes(cached)
      ? [cached, ...candidates.filter(url => url !== cached)]
      : candidates
  const found = await Promise.all(list.map(base => probeJobHub(base)))
  const hit = found.find(Boolean)
  if (!hit) {
    return { ok: false, base: '', peers: [], tried: list, error: noHubTip(list) }
  }
  writeHubCache(hit.base)
  return { ok: true, base: hit.base, peers: hit.peers, tried: list, error: '' }
}

/**
 * 找到真正能用的通讯页地址：候选并发探一遍，按候选顺序取第一个通的。
 * 成功缓存 30s、失败只缓存 5s（通了就快，断了也能很快自己恢复）。
 */
export async function resolveJobHub({ force = false } = {}) {
  if (!force && hubResolved && Date.now() < hubExpireAt) return hubResolved
  if (!force && hubInFlight) return hubInFlight
  const task = doResolveJobHub()
  hubInFlight = task
  try {
    const value = await task
    hubResolved = value
    hubExpireAt = Date.now() + (value.ok ? HUB_CACHE_TTL : HUB_FAIL_TTL)
    return value
  } finally {
    if (hubInFlight === task) hubInFlight = null
  }
}

/** 转发用的通讯页地址；没解析出来返回空串（调用方退回直连结果） */
async function hubBaseForRelay() {
  const resolved = await resolveJobHub()
  return resolved.base || ''
}

/**
 * 页面是不是从公网地址打开的。
 *
 * Chrome/Edge 142 起的 Local Network Access 不允许**公网页面**访问回环/私网地址
 * （控制台：Permission was denied for this request to access the local address space）。
 * 这种页面直连 127.0.0.1:8799 或 192.168.x.x:8799 一律是死路 —— 桥接活没活、CORS
 * 配没配都一样，浏览器那关就过不去，让同事逐个去改浏览器权限也不现实。
 *
 * 所以公网页面一律走**同源** /jobhub 中继：服务器替我们去连那些电脑，浏览器从头到尾
 * 只跟自己的源打交道 —— 没有 LNA，也没有跨源。
 */
export function isPublicPage() {
  return !isPrivateHost(pageHost())
}

/**
 * 请求某台电脑的桥接：直连 → 不行就同源中继（通讯页代连）。
 *
 * - 页面在私网地址上：先直连（快，且不依赖通讯页）
 * - 页面在公网地址上：跳过直连（必然被 LNA 拦，跑一趟只会刷一堆控制台错误）
 * - 回环目标（127.0.0.1）**不吃中继**：中继是服务器去连，`127.0.0.1` 在那边等于
 *   服务器自己，语义完全不同。回环本机只能靠直连。
 *
 * 返回 `{ ok, status, json, via, error }`，业务层的 ok 由调用方判断。
 */
async function bridgeRequest(target, opts = {}) {
  const local = isLoopbackIp(target.ip) || !target.ip
  const relayable = !local && !!opts.relayPath
  const failures = []

  if (!isPublicPage()) {
    const base = local ? getJobBridgeBase() : hostBase(target)
    const res = await request(`${base}${opts.path || ''}`, {
      method: opts.method,
      body: opts.body,
      timeout: opts.timeout
    })
    if (res.ok) return { ...res, via: 'direct' }
    failures.push(res)
  }

  // 回环地址吃不了中继：中继是通讯页代连，127.0.0.1 在那边等于通讯页自己那台机器。
  if (!relayable) {
    const last = failures[failures.length - 1]
    if (last) return { ...last, via: '', errors: failures }
    return {
      ok: false,
      status: 0,
      offline: true,
      json: {},
      error:
        '本机桥接只能直连，走不了中继；页面在公网地址上时浏览器又不允许直连 —— ' +
        '请在浏览器里把这个站点允许访问本地网络，或者双击 run_bridge.bat 用局域网地址打开页面。',
      errors: failures,
      via: ''
    }
  }

  const hub = await hubBaseForRelay()
  if (!hub) {
    const last = failures[failures.length - 1] || {}
    return {
      ok: false,
      status: last.status || 0,
      offline: true,
      json: {},
      error: isPublicPage()
        ? '页面在公网地址上，浏览器不允许直连局域网，而通讯页（/jobhub 中继）又没找到；' +
          '请让通讯页跑起来，或在服务器上把 /jobhub 反代到它。'
        : pickError(last, '请求失败'),
      errors: failures,
      via: ''
    }
  }

  const relayed = await request(`${hub}${opts.relayPath}`, {
    method: opts.relayMethod || opts.method,
    body: opts.relayBody !== undefined ? opts.relayBody : opts.body,
    timeout: opts.timeout
  })
  if (relayed.ok) return { ...relayed, via: 'hub' }
  failures.push(relayed)
  return { ...relayed, via: '', errors: failures }
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
  const resolved = await resolveJobHub()
  if (!resolved.ok) {
    return {
      ok: false,
      hub: resolved.base || getJobHubBase(),
      peers: [],
      tried: resolved.tried,
      error: resolved.error
    }
  }
  return {
    ok: true,
    hub: resolved.base,
    peers: resolved.peers.map(normalizeHost)
  }
}

/** 本机桥接（127.0.0.1:8799）的会话列表 */
export async function listLocalGateways() {
  const base = getJobBridgeBase()
  const res = await request(`${base}/api/gateways`)
  if (!res.ok) {
    return {
      ok: false,
      gateways: [],
      // 浏览器那句 "Failed to fetch" 帮不了任何人：说清是哪台、怎么办。
      error: res.offline
        ? isPublicPage()
          ? `连不上本机任务桥（${base}）：页面在公网地址上，浏览器（Chrome/Edge 142+ 的` +
            '本地网络访问限制）不允许它连本机服务。给这个站点允许「本地网络访问」，' +
            '或者用局域网地址打开脑图页面 —— 也可以直接选列表里登记过的其它电脑。'
          : `连不上本机任务桥（${base}）—— 这台电脑的桥接没在跑。` +
            '双击 run_bridge.bat（lan-bridge 技能目录里）启动后再点「运行」；' +
            '急着跑也可以在「执行主机」里选别的电脑。'
        : pickError(res, '连不上本机任务桥')
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
  // 通讯页里可能有一条过期的 127.0.0.1 登记；回环地址一律以本机探测为准，别让它盖掉探测结果
  const server = hubRes.peers.find(
    p => p.ip === pageHostIp && !isLoopbackIp(p.ip)
  )
  if (server) push(withRole(server, '主服务'))
  hubRes.peers
    .filter(p => !isLoopbackIp(p.ip))
    .forEach(p => push(p))
  // 公网页面下浏览器不允许连 127.0.0.1，列出来只会让人白点一次；
  // 这时本机会以「局域网身份」出现在上面那批 peer 里（桥接往通讯页登记过）。
  // 一台 peer 都没有时仍留着它 —— 好歹能把「怎么开桥接」说清楚。
  if (!isPublicPage() || !hubRes.peers.length) push(local)

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
  const res = await bridgeRequest(target, {
    path: '/api/gateways',
    relayPath: `/api/gateways?ip=${encodeURIComponent(target.ip)}&port=${target.port}`
  })
  if (res.ok) {
    return {
      ok: true,
      gateways: readGateways(res.json),
      diag: readDiag(res.json),
      via: res.via
    }
  }

  const localProbe = await listLocalGateways()
  return {
    ok: false,
    gateways: [],
    error: local
      ? localProbe.ok === false && localProbe.error
        ? localProbe.error
        : pickError(res, '连不上本机任务桥，请先运行 test1.py')
      : pickError(res, `连不上 ${target.label}（那台电脑要运行 test1.py --lan）`)
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
    // 本机走不了中继（通讯页去连 127.0.0.1 等于连它自己），只能直连
    const res = await bridgeRequest(target, {
      path: '/api/dispatch',
      body: payload,
      timeout: DISPATCH_TIMEOUT
    })
    return shapeJobResult(res, target)
  }

  const res = await bridgeRequest(target, {
    path: '/api/dispatch',
    body: payload,
    timeout: DISPATCH_TIMEOUT,
    relayPath: '/api/dispatch',
    relayBody: { ip: target.ip, port: target.port, ...payload }
  })
  return shapeJobResult(res, target)
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
  const relayQuery =
    `ip=${encodeURIComponent(target.ip)}&port=${target.port}` +
    (gateway ? `&gateway=${encodeURIComponent(gateway)}` : '')
  const res = await bridgeRequest(target, {
    path: `/api/jobs${query}`,
    relayPath: `/api/jobs?${relayQuery}`
  })
  if (res.ok) {
    return {
      ok: true,
      jobs: (res.json && res.json.jobs) || [],
      via: res.via
    }
  }
  return { ok: false, jobs: [], error: pickError(res, '拿不到任务列表') }
}

/**
 * 取某个任务的完整回答。
 * 任务列表里的 detail 只有一行摘要（~100 字），全文在桥接的 /api/transcript。
 */
export async function fetchJobTranscript({ host, gateway, jobId } = {}) {
  if (!jobId) return { ok: false, error: '缺少任务 id' }
  const target = normalizeHost(host || {})
  // 带上 gateway：这台电脑可能有多个会话，不指定会取到别的会话的同名任务
  const query =
    `?id=${encodeURIComponent(jobId)}` +
    (gateway ? `&gateway=${encodeURIComponent(gateway)}` : '')

  const relayQuery =
    `ip=${encodeURIComponent(target.ip)}&port=${target.port}` +
    `&id=${encodeURIComponent(jobId)}` +
    (gateway ? `&gateway=${encodeURIComponent(gateway)}` : '')
  const res = await bridgeRequest(target, {
    path: `/api/transcript${query}`,
    relayPath: `/api/transcript?${relayQuery}`,
    timeout: 60000
  })
  if (res.ok && res.json && res.json.ok) {
    return { ok: true, ...res.json, via: res.via }
  }
  return { ok: false, error: pickError(res, '拿不到完整回答') }
}

/**
 * 这次运行产出的文件：桥接从任务的完整回答里解析路径、校验存在，
 * content=true 时把内容（base64）也带回来，供挂到脑图节点上。
 * 只允许读取执行主机工作目录内的文件。
 */
export async function fetchJobArtifacts({
  host,
  gateway,
  jobId,
  content = true
} = {}) {
  if (!jobId) return { ok: false, files: [], error: '缺少任务 id' }
  const target = normalizeHost(host || {})
  const query =
    `?id=${encodeURIComponent(jobId)}` +
    (gateway ? `&gateway=${encodeURIComponent(gateway)}` : '') +
    `&content=${content ? 1 : 0}`
  const relayQuery =
    `?ip=${encodeURIComponent(target.ip)}&port=${target.port}` +
    `&id=${encodeURIComponent(jobId)}` +
    (gateway ? `&gateway=${encodeURIComponent(gateway)}` : '') +
    `&content=${content ? 1 : 0}`
  const res = await bridgeRequest(target, {
    path: `/api/job-artifacts${query}`,
    relayPath: `/api/job-artifacts${relayQuery}`,
    timeout: 120000
  })
  if (res.ok && res.json && res.json.ok) {
    return {
      ok: true,
      files: res.json.files || [],
      cwd: res.json.cwd || '',
      via: res.via
    }
  }
  return { ok: false, files: [], error: pickError(res, '拿不到产物文件') }
}

/**
 * 让执行主机上的桥接把附件**经 MCP**（upload_attachment）挂到脑图节点上。
 * 这条路绕开页面同域的 /api/attachments/resumable + /api/files/<room>/attachments
 * （那两条要经服务器 nginx 转到协同服务），服务器部署时更稳。
 * 桥接自己从本地读产物；这里只负责把内容送过去。
 */
export async function attachFilesViaBridge({
  host,
  roomKey,
  nodeUid,
  files,
  confirmSopChange = true
} = {}) {
  if (!roomKey) return { ok: false, error: '没有房间信息' }
  if (!nodeUid) return { ok: false, error: '没有节点 uid' }
  const list = (files || []).filter(item => item && item.name && item.base64)
  if (!list.length) return { ok: false, error: '没有要挂的文件' }
  const target = normalizeHost(host || {})
  const res = await bridgeRequest(target, {
    path: '/api/attach',
    body: { roomKey, nodeUid, files: list, confirmSopChange },
    timeout: 180000,
    relayPath: `/api/attach?ip=${encodeURIComponent(target.ip)}&port=${target.port}`
  })
  if (res.ok && res.json && res.json.ok) {
    return {
      ok: true,
      attachments: res.json.attachments || [],
      via: 'bridge-mcp'
    }
  }
  return {
    ok: false,
    error: pickError(res, '经 MCP 挂附件失败'),
    raw: res.json
  }
}

/** 停止某台主机上的某个任务（直连不通就走通讯页中继） */
export async function stopHostJob({ host, gateway, id } = {}) {
  const target = normalizeHost(host || {})
  if (!id) return { ok: false, error: '缺少任务 id' }
  const res = await bridgeRequest(target, {
    path: '/api/stop',
    body: { gateway, id },
    relayPath: '/api/stop',
    relayBody: { ip: target.ip, port: target.port, gateway, id }
  })
  if (res.ok && res.json && res.json.ok) {
    return { ok: true, result: res.json, via: res.via }
  }
  return { ok: false, error: pickError(res, '停止失败') }
}
