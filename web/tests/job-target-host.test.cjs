/* eslint-env node */
/* global globalThis */
/**
 * 「执行主机」默认目标的选择 —— Toolbar.prepareLocalTarget 的单测。
 *
 * 回归的坑：本机桥接（127.0.0.1:8799）没跑时，它原来是**无条件把默认目标设成本机**，
 * 于是点「运行」直接 `GET http://127.0.0.1:8799/api/gateways → ERR_CONNECTION_REFUSED`，
 * 页面报「连不上本机任务桥」，明明局域网里别的电脑是好的，整条路却被堵死。
 *
 * 做法照 web/tests/job-history.component.test.cjs：vue-template-compiler 拆 SFC
 * → babel 转 CJS → require stub → methods bind 到手写的 mock vm 上跑。
 */
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')
const compiler = require('vue-template-compiler')

const WEB = path.join(__dirname, '..')
const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`)
}

const LOCAL_KEY = '127.0.0.1:8799'

// 组件用 window.localStorage 记住「派发固定用哪条会话」，这里给个最小实现
const lsStore = new Map()
globalThis.window = {
  localStorage: {
    getItem: k => (lsStore.has(k) ? lsStore.get(k) : null),
    setItem: (k, v) => lsStore.set(k, String(v)),
    removeItem: k => lsStore.delete(k)
  }
}

// ---- 可编程的桥接 stub ----
let resolveResult = { hosts: [], defaultHost: null, hub: '', error: '' }
let gatewayResult = { ok: true, gateways: [{ url: 'http://127.0.0.1:50001', cwd: 'D:\\demo' }] }
const calls = { gateways: 0, history: 0, spawn: 0 }
// 起会话相关（默认：额度 5 个、还能起）
let spawnInfoResult = {
  ok: true,
  items: [],
  count: 0,
  limit: 5,
  remaining: 5,
  canSpawn: true
}
let spawnResult = { ok: false, error: '（测试没给 spawnResult）' }

const bridgeStub = {
  resolveJobHosts: async () => resolveResult,
  listHostGateways: async () => {
    calls.gateways += 1
    return gatewayResult
  },
  listHostJobs: async () => {
    calls.history += 1
    return { ok: true, jobs: [] }
  },
  listSpawnedSessions: async () => spawnInfoResult,
  spawnHostSession: async () => {
    calls.spawn += 1
    return typeof spawnResult === 'function' ? spawnResult() : spawnResult
  },
  releaseHostSession: async () => ({ ok: true }),
  describeEmptyGateways: () => '这台主机上没有 WorkBuddy 会话',
  stopHostJob: async () => ({ ok: true }),
  fetchJobTranscript: async () => ({ ok: true, text: '' }),
  fetchJobArtifacts: async () => ({ ok: true, files: [] }),
  attachFilesViaBridge: async () => ({ ok: false, res: null })
}

const parsed = compiler.parseComponent(
  fs.readFileSync(path.join(WEB, 'src/pages/Edit/components/Toolbar.vue'), 'utf8')
)
const { code } = babel.transformSync(parsed.script.content, {
  babelrc: false,
  configFile: false,
  plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
})
const mod = { exports: {} }
// stub 清单照 web/tests/job-history.component.test.cjs —— Toolbar 顶层还会 new markdown-it 等，
// 少一个就会在加载阶段炸（不是在被测逻辑上）
new Function('require', 'module', 'exports', code)(name => {
  if (name === 'vuex') return { mapState: () => ({}) }
  if (name === 'element-ui') return { Notification: () => {} }
  if (name === 'markdown-it') {
    return class MarkdownIt {
      constructor() {
        this.renderer = { rules: {}, renderToken: () => '' }
      }
      render(text) {
        return text
      }
    }
  }
  if (name === 'simple-mind-map/example/exampleData') return {}
  if (name === 'simple-mind-map/src/utils/index') {
    return { throttle: fn => fn, isMobile: () => false }
  }
  if (name === 'simple-mind-map/src/utils') {
    return { getTextFromHtml: html => String(html || '').replace(/<[^>]+>/g, '') }
  }
  if (name === '@/utils/jobResultWriter') {
    return { writeJobResult: async () => ({ ok: true }), runJobWriteBack: async () => ({ ok: true }) }
  }
  if (name === '@/utils/mindmapRunPrompt') return {}
  if (name === '@/utils/workbuddyJobBridge') return bridgeStub
  return {}
}, mod, mod.exports)
const methods = (mod.exports.default && mod.exports.default.methods) || {}
if (!methods.prepareLocalTarget) throw new Error('拿不到 prepareLocalTarget')

function makeVm() {
  const vm = {
    jobHosts: [],
    jobHostKey: '',
    jobHostsLoading: false,
    jobHostsError: '',
    jobGateways: [],
    jobGateway: '',
    jobGatewaysError: '',
    jobHistory: [],
    jobHistoryLoading: false,
    jobHistoryError: '',
    jobStatus: '',
    jobStatusType: '',
    jobRunNodeUid: '',
    $message: Object.assign(() => {}, {
      warning: () => {},
      error: () => {},
      success: () => {}
    }),
    $bus: { $on: () => {}, $off: () => {}, $emit: () => {} }
  }
  Object.defineProperty(vm, 'jobSelectedHost', {
    get() {
      return this.jobHosts.find(item => item.key === this.jobHostKey) || null
    }
  })
  // 只 bind 需要的方法（loadJobHistory 在 job-history 测试里覆盖）
  vm.prepareLocalTarget = methods.prepareLocalTarget.bind(vm)
  vm.resetJobFullText = methods.resetJobFullText
    ? methods.resetJobFullText.bind(vm)
    : () => {}
  vm.jobHistory = []
  vm.loadJobHistory = async () => {
    calls.history += 1
    vm.jobHistory = []
    vm.jobHistoryError = ''
  }
  vm.loadJobGateways = methods.loadJobGateways.bind(vm)
  // 自动挑端口 / 自动等会话这一组
  vm.jobSpawnInfo = { count: 0, limit: 5, remaining: 5, canSpawn: true }
  vm.jobSpawning = false
  vm.jobGatewayCwd = ''
  ;[
    'isJobRunning',
    'pickJobGateway',
    'ensureDispatchTarget',
    'autoSpawnSession',
    'loadSpawnInfo',
    'chooseSession',
    'rememberSession',
    'recallSession',
    'sessionStoreKey'
  ].forEach(name => {
    if (methods[name]) vm[name] = methods[name].bind(vm)
  })
  return vm
}

function host(ip, port, online, name) {
  return {
    ip,
    port,
    name: name || ip,
    online,
    self: ip === '127.0.0.1',
    manual: false,
    key: `${ip}:${port}`,
    url: `http://${ip}:${port}`,
    label: `${name || ip} · ${ip}:${port}`
  }
}

async function main() {
  // ---- 1. 本机在线 → 默认派给自己 ----
  resolveResult = {
    hosts: [host('192.168.1.114', 8799, true, 'DESKTOP'), host('127.0.0.1', 8799, true, '这台电脑')],
    hub: 'http://192.168.0.54:5000',
    error: ''
  }
  let vm = makeVm()
  await vm.prepareLocalTarget()
  check('本机在线：默认目标还是本机', vm.jobHostKey === LOCAL_KEY, vm.jobHostKey)
  check('本机在线：不报错', vm.jobHostsError === '')
  check('本机在线：顺带拉了会话列表', vm.jobGateway === 'http://127.0.0.1:50001', vm.jobGateway)

  // ---- 2. 本机离线 + 有在线主机 → 改成那台（不要卡死） ----
  resolveResult = {
    hosts: [host('192.168.1.114', 8799, true, 'DESKTOP'), host('127.0.0.1', 8799, false, '这台电脑')],
    hub: 'http://192.168.0.54:5000',
    error: ''
  }
  vm = makeVm()
  await vm.prepareLocalTarget()
  check(
    '本机桥接没跑：自动改选在线的别台电脑',
    vm.jobHostKey === '192.168.1.114:8799',
    vm.jobHostKey
  )
  check('有在线主机时不弹红字', vm.jobHostsError === '', vm.jobHostsError)
  check('选中的确实是主机列表里那台', vm.jobSelectedHost && vm.jobSelectedHost.online === true)

  // ---- 3. 本机离线 + 全都不在线 → 保持本机（好把「怎么起桥接」说清楚） ----
  resolveResult = {
    hosts: [host('127.0.0.1', 8799, false, '这台电脑'), host('192.168.0.230', 8799, false, 'LAPTOP')],
    hub: '',
    error: '连不上本机任务桥（http://127.0.0.1:8799）—— 这台电脑的桥接没在跑。'
  }
  // 本机桥接连不上时，会话列表这一路也会失败
  gatewayResult = {
    ok: false,
    gateways: [],
    error: '连不上本机任务桥（http://127.0.0.1:8799）—— 这台电脑的桥接没在跑。'
  }
  vm = makeVm()
  vm.jobGatewaysError = ''
  await vm.prepareLocalTarget()
  check('全都离线时：还选本机', vm.jobHostKey === LOCAL_KEY, vm.jobHostKey)
  check(
    '全都离线时：把原因原样留着给用户看',
    /桥接没在跑/.test(vm.jobHostsError),
    vm.jobHostsError
  )
  check(
    '没有可派会话时状态栏给的是原因',
    /桥接没在跑|没有可派/.test(vm.jobStatus),
    vm.jobStatus
  )
  gatewayResult = { ok: true, gateways: [{ url: 'http://127.0.0.1:50001', cwd: 'D:\\demo' }] }

  // ---- 4. 本机不在列表里（比如桥接根本没探测到） ----
  resolveResult = {
    hosts: [host('192.168.1.114', 8799, true, 'DESKTOP')],
    hub: 'http://192.168.0.54:5000',
    error: ''
  }
  vm = makeVm()
  await vm.prepareLocalTarget()
  check('列表里没有本机：选在线的那台', vm.jobHostKey === '192.168.1.114:8799', vm.jobHostKey)

  // ---- 5. 一台都没有 ----
  resolveResult = { hosts: [], hub: '', error: '没找到通讯页' }
  vm = makeVm()
  await vm.prepareLocalTarget()
  check('一台主机都没有：不炸、key 为空', vm.jobHostKey === '', JSON.stringify(vm.jobHostKey))
  check('一台都没有：错误信息保留', /没找到通讯页/.test(vm.jobHostsError), vm.jobHostsError)

  // ---- 6. resolveJobHosts 抛异常也不能把页面搞崩 ----
  resolveResult = null
  bridgeStub.resolveJobHosts = async () => {
    throw new Error('boom')
  }
  vm = makeVm()
  await vm.prepareLocalTarget()
  check('探测抛异常：兜住并提示', vm.jobHosts.length === 0 && /boom|读取失败/.test(vm.jobHostsError), vm.jobHostsError)
  bridgeStub.resolveJobHosts = async () => resolveResult

  // ---- 7. 没有可派端口（会话）时：**让桥接起一个**再用 ----
  // 现场：桥接在线但 WorkBuddy 一条会话都没有。以前直接拒绝，让用户自己去桌面版开一条；
  // 现在点运行就自动起（最多 5 个），起来直接用。
  resolveResult = {
    hosts: [host('127.0.0.1', 8799, true, '这台电脑')],
    hub: '',
    error: ''
  }
  gatewayResult = { ok: true, gateways: [], diag: null }
  spawnInfoResult = { ok: true, items: [], count: 0, limit: 5, remaining: 5, canSpawn: true }
  calls.spawn = 0
  vm = makeVm()
  await vm.prepareLocalTarget()
  check('一开始没有会话：gateway 为空', vm.jobGateway === '', JSON.stringify(vm.jobGateway))
  // 起会话成功 → 之后网关列表里就多出这条
  spawnResult = () => {
    gatewayResult = {
      ok: true,
      gateways: [{ url: 'http://127.0.0.1:50001', cwd: 'D:\\demo', spawned: true }]
    }
    return {
      ok: true,
      gateway: { url: 'http://127.0.0.1:50001', port: 50001 },
      count: 1,
      limit: 5,
      remaining: 4
    }
  }
  const spawned = await vm.ensureDispatchTarget()
  // 用户要求（2026-09-29）：「不走自动会话、不创建自动会话，反正都不能用」——
  // 桥接 spawn 的自动会话在旧版 WorkBuddy 上走 runs 回退通道，起了也白起，现在一律不起。
  check(
    '没有可用会话 → **不再自动起会话**，直接报错',
    spawned.ok === false && calls.spawn === 0,
    `${calls.spawn} · ${spawned.error}`
  )
  check('报错里给了能照做的出路', /会话|桌面版/.test(spawned.error), spawned.error)

  // ---- 7b. 额度用完了：不再起，直接给能照做的原因 ----
  gatewayResult = { ok: true, gateways: [], diag: null }
  spawnInfoResult = { ok: true, items: [], count: 5, limit: 5, remaining: 0, canSpawn: true }
  calls.spawn = 0
  vm = makeVm()
  await vm.prepareLocalTarget()
  const capped = await vm.ensureDispatchTarget()
  check(
    '额度满也不起会话',
    capped.ok === false && calls.spawn === 0,
    `${calls.spawn} · ${capped.error}`
  )

  // ---- 7c. 桥接起不了（找不到 codebuddy）：说清怎么配 ----
  gatewayResult = { ok: true, gateways: [], diag: null }
  spawnInfoResult = { ok: true, items: [], count: 0, limit: 5, remaining: 5, canSpawn: false }
  vm = makeVm()
  await vm.prepareLocalTarget()
  const noCli = await vm.ensureDispatchTarget()
  check(
    '桥接起不了会话的场景也一样：不起，给原因',
    noCli.ok === false && calls.spawn === 0,
    `${calls.spawn} · ${noCli.error}`
  )
  spawnInfoResult = { ok: true, items: [], count: 0, limit: 5, remaining: 5, canSpawn: true }
  spawnResult = { ok: false, error: '起会话失败（测试占位）' }
  gatewayResult = { ok: true, gateways: [{ url: 'http://127.0.0.1:50001', cwd: 'D:\\demo' }] }

  // ---- 8. 桥接都没在线：别干等，立刻给原因 ----
  resolveResult = {
    hosts: [host('127.0.0.1', 8799, false, '这台电脑')],
    hub: '',
    error: '这台电脑的桥接没在跑'
  }
  gatewayResult = { ok: false, gateways: [], error: '这台电脑的桥接没在跑' }
  vm = makeVm()
  await vm.prepareLocalTarget()
  const t0 = Date.now()
  const dead = await vm.ensureDispatchTarget()
  const cost = Date.now() - t0
  check(
    '桥接没在线：不干等，马上给原因',
    dead.ok === false && cost < 2500,
    `${cost}ms · ${dead.error}`
  )
  check('原因是桥接/会话，用户能照做', /桥接|会话/.test(dead.error), dead.error)
  gatewayResult = { ok: true, gateways: [{ url: 'http://127.0.0.1:50001', cwd: 'D:\\demo' }] }

  // ---- 9. 多条会话时自动挑一条，但不冲掉用户手动选的 ----
  vm = makeVm()
  vm.jobHosts = [host('127.0.0.1', 8799, true, '这台电脑')]
  vm.jobHostKey = LOCAL_KEY
  const two = [
    { url: 'http://127.0.0.1:50001', port: 50001 },
    { url: 'http://127.0.0.1:50002', port: 50002 }
  ]
  // 现场（2026-09-28）：用户看到"每次运行端口都变了、像把上一个回收了换最新的，
  // 也不管上个任务跑完没"。根因是这里原来「优先挑没在跑任务的那条」，
  // 而桥接给的列表按心跳新鲜度排（刚用过那条排最前）→ 页面一刷新就换一条。
  lsStore.clear()
  vm.jobGateway = ''
  check(
    '已选的那条还在：保持不动（忙也用它，任务排在这条会话里）',
    vm.pickJobGateway(two, 'http://127.0.0.1:50002') === 'http://127.0.0.1:50002'
  )
  check('只有一条：直接用', vm.pickJobGateway([two[0]], '') === two[0].url)
  check(
    '多条且没选过：用第一条 —— 不再按忙闲跳来跳去',
    vm.pickJobGateway(two, '') === two[0].url
  )

  // 记住过的那条（localStorage）优先于第一条 —— 刷新页面也不换端口
  vm.rememberSession('http://127.0.0.1:50002')
  check(
    '刷新页面后还记得上次用的那条',
    vm.pickJobGateway(two, '') === 'http://127.0.0.1:50002',
    vm.pickJobGateway(two, '')
  )
  check(
    '记住的那条没了：退回第一条（不会挑不出来）',
    vm.pickJobGateway([two[0]], '') === two[0].url
  )

  // 点会话栏那一行 = 手动指定并记住
  vm.jobGateway = two[0].url
  vm.chooseSession(two[1])
  check(
    '点会话行即选中并记住',
    vm.jobGateway === two[1].url && vm.recallSession() === two[1].url,
    `${vm.jobGateway} / ${vm.recallSession()}`
  )
  check(
    '手动选完之后不会再被换掉',
    vm.pickJobGateway(two, vm.jobGateway) === two[1].url
  )

  const failed = results.filter(r => !r.ok)
  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  if (failed.length) {
    console.log('失败项：' + failed.map(r => r.name).join(' / '))
    process.exit(1)
  }
  process.exit(0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
