/* eslint-env node */
/* global globalThis */
/**
 * 运行历史：拉取失败不能清空列表 —— Toolbar 方法级单测。
 *
 * 回归的是这个 bug：点「停止」时网关（进程刚被杀）会短暂拿不到任务列表，
 * 而 loadJobHistory 原来是**先把 jobHistory 清空**再请求，拉不到就一直是空的，
 * 看起来像"历史记录被清掉了"。
 *
 * 做法照 web/tests/contextmenu.component.test.cjs：vue-template-compiler 拆 SFC
 * → babel 转 CJS → 用 require stub 加载 → 把 methods bind 到手写的 mock vm 上跑。
 */
const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')
const compiler = require('vue-template-compiler')

const WEB = path.join(__dirname, '..')

// 待回写任务落盘用：Node 里没有 localStorage，给个最小实现
const localStore = new Map()
globalThis.localStorage = {
  getItem: k => (localStore.has(k) ? localStore.get(k) : null),
  setItem: (k, v) => localStore.set(k, String(v)),
  removeItem: k => localStore.delete(k),
  clear: () => localStore.clear()
}

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`)
}

function loadCjs(file, stub) {
  const src = fs.readFileSync(file, 'utf8')
  const { code } = babel.transformSync(src, {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  })
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', code)(stub, mod, mod.exports)
  return mod.exports
}

const jobWriter = loadCjs(path.join(WEB, 'src/utils/jobResultWriter.js'), name => {
  if (name === './nodeAttachmentApi') return { uploadNodeAttachment: async () => ({}) }
  if (name === './flowExpandPrompt') return { nodeUid: n => (n && n.getData('uid')) || '' }
  return {}
})

// 运行通道（设置里选的「AI 执行引擎」）—— 用真模块，它只依赖 localStorage
const runChannelUtil = loadCjs(
  path.join(WEB, 'src/utils/runChannel.js'),
  () => ({})
)

// 运行日志（本地留存）—— 也用真模块：运行历史 = 桥接列表 + 这一份，
// 合并逻辑（同 id 以桥接为准 / 本地补正文）就是本轮要测的东西
const runLogUtil = loadCjs(path.join(WEB, 'src/utils/runLog.js'), () => ({}))

// ---- 可编程的桥接 stub ----
const jobResponses = [] // 每次 listHostJobs 消费一个
const calls = { list: 0, stop: [] }
let stopResult = { ok: true }
// 「WorkBuddy 会话（端口）」用例用：可编程的会话列表 + 按会话给任务
// 默认给一个会话：loadJobHistory 现在会先问「这台机器有哪些会话」，再逐个拉任务
// （跨会话历史，见下面 11b 的用例）
let gatewaysResult = {
  ok: true,
  gateways: [{ url: 'http://127.0.0.1:8799' }]
}
let jobsByGateway = {}
// 桥接自动起的会话（/api/sessions/spawned）：老版桥接的 /api/gateways 不带 spawned，
// 前端要靠这份清单兜底认「能不能回收」
let spawnedResult = {
  ok: true,
  items: [],
  count: 0,
  limit: 5,
  remaining: 5,
  canSpawn: true
}
// 取任务全文的结果（默认空 —— 不设的话「超时兜底」用例会拿到空文本）
let transcriptResult = { ok: true, text: '' }
// 派发结果（重试用例要换 job id）
let dispatchResult = { ok: true, job: { id: 'job-x' }, mode: 'jobs' }
// 按时间窗扫会话产物的结果（「自动」会话拿不到回执时的兜底）
let recentArtifactsResult = { ok: true, files: [] }
const bridgeStub = {
  resolveJobHosts: async () => ({ hosts: [], defaultHost: null }),
  listHostGateways: async () => gatewaysResult,
  listSpawnedSessions: async () => spawnedResult,
  listHostJobs: async args => {
    calls.list += 1
    const gw = args && args.gateway
    if (gw && jobsByGateway[gw]) return jobsByGateway[gw]
    if (!jobResponses.length) return { ok: true, jobs: [] }
    const next = jobResponses.shift()
    if (next instanceof Error) throw next
    return next
  },
  stopHostJob: async args => {
    calls.stop.push(args)
    return stopResult
  },
  fetchJobTranscript: async () => transcriptResult,
  fetchJobArtifacts: async () => ({ ok: true, files: [] }),
  fetchRecentArtifacts: async () => recentArtifactsResult,
  spawnHostSession: async () => ({ ok: true, gateway: { url: 'http://127.0.0.1:1' } }),
  releaseHostSession: async () => ({ ok: true }),
  attachFilesViaBridge: async () => ({ ok: false }),
  describeEmptyGateways: () => '',
  dispatchWorkbuddyJob: async () => dispatchResult
}

// ---- 可编程的助理（OpenClaw）流 ----
// 助理通道是**流式直连**（streamChat），没有派发/轮询/回执这一套。
// openclawPlan 每次调用消费一项：{ content } 立刻跑完，{ hold:true } 挂着等
// openclawHold 里的回调放开（模拟"还在跑"）。
const openclawPlan = []
const openclawHold = []
const openclawStreamCalls = []
const openclawWrites = [] // 写回时的落点 nodeUid，按顺序
const agentChatStub = {
  streamChat: opts => {
    openclawStreamCalls.push(opts)
    const plan = openclawPlan.shift() || { content: '' }
    const push = () => {
      if (opts && opts.onDelta) opts.onDelta(plan.content || '')
      return { content: plan.content || '', events: [], toolCalls: [] }
    }
    if (plan.hold) {
      return new Promise(resolve => {
        openclawHold.push(() => resolve(push()))
      })
    }
    return Promise.resolve(push())
  }
}

const parsed = compiler.parseComponent(
  fs.readFileSync(path.join(WEB, 'src/pages/Edit/components/Toolbar.vue'), 'utf8')
)
assert.deepEqual(compiler.compile(parsed.template.content).errors, [])
const { code } = babel.transformSync(parsed.script.content, {
  babelrc: false,
  configFile: false,
  plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', code)(name => {
  if (name === 'vuex') return { mapState: () => ({}) }
  if (name === 'element-ui') return { Notification: () => {} }
  if (name === 'markdown-it') {
    return class MarkdownIt {
      constructor() {
        this.renderer = { rules: {}, renderToken: () => '' }
      }
      render(t) {
        return t
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
  if (name === '@/utils/jobResultWriter') return jobWriter
  if (name === '@/utils/mindmapRunPrompt') {
    // 回显 args（cwd / runDir）—— 「助理不能带执行主机路径」那条要验真实分支
    return {
      buildNodeRunPrompt: args => `NODE:${args.cwd || ''}|${args.runDir || ''}`,
      buildFollowUpPrompt: (text, args) => `FU:${args.cwd || ''}|${args.runDir || ''}`,
      withCpdAdvisor: t => String(t)
    }
  }
  if (name === '@/utils/agentChat') return agentChatStub
  if (name === '@/utils/runChannel') return runChannelUtil
  if (name === '@/utils/runLog') return runLogUtil
  if (name === '@/utils/workbuddyJobBridge') return bridgeStub
  return {}
}, mod, mod.exports)
const component = mod.exports.default

const HOST = { key: '127.0.0.1:8799', ip: '127.0.0.1', port: 8799, online: true }

function makeNode(text, data = {}) {
  const store = { text, ...data }
  return {
    isGeneralization: false,
    children: [],
    getData: key => (key ? store[key] : store),
    setData: patch => Object.assign(store, patch)
  }
}

function makeVm() {
  const messages = []
  const vm = {
    activeNodes: [],
    jobDispatching: false,
    isReadonly: false,
    jobHosts: [HOST],
    jobHostKey: HOST.key,
    jobGateways: [{ url: 'http://127.0.0.1:50323', cwd: 'D:\\良策0010' }],
    jobGateway: 'http://127.0.0.1:50323',
    jobHostsError: '',
    jobGatewaysError: '',
    jobHistory: [],
    jobHistoryLoading: false,
    jobHistoryError: '',
    jobHistoryVisible: false,
    jobCurrentId: '',
    jobActiveId: '',
    jobPendingList: [],
    jobPendingMiss: 0,
    jobPollBusy: false,
    jobSessions: [],
    jobSessionsLoading: false,
    jobSessionsError: '',
    jobSessionsExpanded: false,
    jobStatus: '',
    jobStatusType: 'jobOk',
    jobSearch: '',
    jobPollTimer: null,
    $route: { query: {} },
    $bus: { $emit: () => {}, $on: () => {}, $off: () => {} },
    $message: {
      info: m => messages.push(['info', m]),
      warning: m => messages.push(['warning', m]),
      success: m => messages.push(['success', m]),
      error: m => messages.push(['error', m])
    },
    $nextTick: fn => fn(),
    messages
  }
  Object.entries(component.methods).forEach(([key, fn]) => {
    vm[key] = fn.bind(vm)
  })
  Object.defineProperty(vm, 'jobSelectedHost', {
    get: () => vm.jobHosts.find(h => h.key === vm.jobHostKey) || null,
    configurable: true
  })
  // jobPending 在组件里是 computed（列表里最新那条），这里照着造一个
  Object.defineProperty(vm, 'jobPending', {
    get: () => {
      const list = vm.jobPendingList || []
      return list.length ? list[list.length - 1] : null
    },
    configurable: true
  })
  return vm
}

async function main() {
  // ---- 1. 正常拉取：替换 + 倒序 ----
  let vm = makeVm()
  jobResponses.push({
    ok: true,
    jobs: [
      { id: 'old', name: '旧', updatedAt: 100 },
      { id: 'new', name: '新', updatedAt: 300 },
      { id: 'mid', name: '中', updatedAt: 200 }
    ]
  })
  await vm.loadJobHistory()
  check(
    '正常拉取：按时间倒序替换',
    vm.jobHistory.map(j => j.id).join(',') === 'new,mid,old',
    vm.jobHistory.map(j => j.id).join(',')
  )
  check('成功时清掉错误提示', vm.jobHistoryError === '')

  // ---- 2. 拉取失败：保留旧记录（本次修的 bug）----
  vm = makeVm()
  vm.jobHistory = [{ id: 'a', name: '记录一' }, { id: 'b', name: '记录二' }]
  jobResponses.push({ ok: false, error: '网关暂时不可用' })
  await vm.loadJobHistory()
  check(
    '拉取失败时不清空已有记录',
    vm.jobHistory.length === 2 && vm.jobHistory[0].id === 'a',
    JSON.stringify(vm.jobHistory.map(j => j.id))
  )
  check(
    '并给出错误提示',
    /网关暂时不可用/.test(vm.jobHistoryError),
    vm.jobHistoryError
  )

  // ---- 3. 抛异常也不能清空 ----
  vm = makeVm()
  vm.jobHistory = [{ id: 'keep' }]
  jobResponses.push(new Error('boom'))
  await vm.loadJobHistory()
  check(
    '请求抛异常时保留记录并提示',
    vm.jobHistory.length === 1 && /boom/.test(vm.jobHistoryError),
    `${vm.jobHistory.length} | ${vm.jobHistoryError}`
  )
  check('不管成功失败都收掉 loading', vm.jobHistoryLoading === false)

  // ---- 4. 没有主机时才清空 ----
  vm = makeVm()
  vm.jobHistory = [{ id: 'x' }]
  vm.jobHostKey = ''
  await vm.loadJobHistory()
  check('没选中主机时才清空列表', vm.jobHistory.length === 0)

  // ---- 5. 停止任务：第一次拉不到会重试，列表最终有数据 ----
  vm = makeVm()
  vm.jobHistory = [{ id: 'a', updatedAt: 1 }]
  vm.jobPending = { id: 'job-1' }
  vm.jobCurrentId = 'job-1'
  calls.list = 0
  jobResponses.push(
    { ok: false, error: '停止后网关重连中' },
    { ok: true, jobs: [{ id: 'a', updatedAt: 1 }, { id: 'job-1', updatedAt: 2, state: 'stopped' }] }
  )
  stopResult = { ok: true }
  await vm.stopJobById('job-1')
  await new Promise(r => setTimeout(r, 1300))
  check(
    '停止后第一次失败会重试一次',
    calls.list === 2,
    `listHostJobs x${calls.list}`
  )
  check(
    '重试成功后列表拿到最新记录',
    vm.jobHistory.length === 2 && vm.jobHistory[0].id === 'job-1',
    JSON.stringify(vm.jobHistory.map(j => j.id))
  )
  check(
    '停止被停的那条时状态文案是「已请求停止」',
    vm.jobStatus === '已请求停止',
    vm.jobStatus
  )

  // ---- 6. 停止失败不动列表 ----
  vm = makeVm()
  vm.jobHistory = [{ id: 'a' }]
  calls.list = 0
  stopResult = { ok: false, error: '停不了' }
  await vm.stopJobById('job-9')
  check(
    '停止失败不刷新列表、给错误提示',
    calls.list === 0 && vm.jobHistory.length === 1 && vm.messages.some(m => m[0] === 'error'),
    `list x${calls.list}`
  )

  // ---- 7. 「写入导图」重写历史记录：落点必须是当前选中的节点 ----
  vm = makeVm()
  vm.jobActiveId = 'job-spring'
  vm.jobHistory = [
    { id: 'job-spring', name: '脑图运行 · 生成50字关于春天的小文章', state: 'done' }
  ]
  vm.activeNodes = [makeNode('生成50字关于春天的小文章', { uid: 'spring-1' })]
  const writes = []
  vm.fetchJobText = async () => '## 结论\n补挂附件\n\n## 待补充数据\n无'
  vm.writeJobResultToNode = async (item, opts) => {
    writes.push({ id: item.id, force: !!opts.force, nodeUid: vm.jobRunNodeUid })
    vm.jobWriteState = '已写入「生成50字关于春天的小文章」'
  }
  await vm.rewriteActiveJob()
  check(
    '重写历史记录：落点用当前选中的节点（不是上次派发的旧落点）',
    writes.length === 1 && writes[0].nodeUid === 'spring-1',
    JSON.stringify(writes)
  )
  check('重写走 force（同一条可以重复写）', writes.length === 1 && writes[0].force)
  check(
    '重写成功给提示',
    vm.messages.some(m => m[0] === 'success'),
    JSON.stringify(vm.messages.map(m => m[0]))
  )

  // 没选中节点时拒绝（避免写到别处）
  vm = makeVm()
  vm.jobActiveId = 'job-spring'
  vm.jobHistory = [{ id: 'job-spring', state: 'done' }]
  vm.activeNodes = []
  const writes2 = []
  vm.writeJobResultToNode = async () => {
    writes2.push(1)
  }
  await vm.rewriteActiveJob()
  check(
    '没选中节点时拒绝重写并提示',
    writes2.length === 0 && vm.messages.some(m => m[0] === 'warning' && /选中/.test(m[1])),
    JSON.stringify(vm.messages.map(m => m[1]).slice(0, 1))
  )

  // 还在跑的任务不让写
  vm = makeVm()
  vm.jobActiveId = 'job-run'
  vm.jobHistory = [{ id: 'job-run', state: 'working' }]
  vm.activeNodes = [makeNode('x', { uid: 'n-1' })]
  const writes3 = []
  vm.writeJobResultToNode = async () => {
    writes3.push(1)
  }
  await vm.rewriteActiveJob()
  check('还在跑的任务不让重写', writes3.length === 0)

  // ---- 8. 派发后主机上一直没有这条任务：到上限就停手报错（别永远轮询）----
  jobResponses.length = 0
  vm = makeVm()
  vm.jobPollTimer = 4242
  vm.jobPendingList = [
    { id: 'job-lost', nodeUid: 'n-1', nodeTitle: 'x', miss: 0 }
  ]
  const lostWrites = []
  vm.writeJobResultToNode = async () => {
    lostWrites.push(1)
  }
  // listHostJobs 在 jobResponses 空时默认回 { ok: true, jobs: [] } —— 正好是「查不到」
  for (let i = 0; i < 6; i += 1) await vm.pollJob()
  check(
    '查不到任务时先给个过程状态（不是一直停在「已派发」）',
    /等主机上报/.test(vm.jobStatus),
    vm.jobStatus
  )
  for (let i = 0; i < 22; i += 1) await vm.pollJob()
  check('到上限后停止轮询', vm.jobPollTimer === null)
  check('到上限后清掉 pending', vm.jobPendingList.length === 0)
  check(
    '把原因说清楚（找不到记录 / 可能重启过）',
    /找不到这条任务/.test(vm.jobWriteError) && /重跑/.test(vm.jobWriteError),
    vm.jobWriteError
  )
  check('状态栏标成出错', vm.jobStatusType === 'jobErr' && vm.jobStatus === '没等到结果')
  check('弹一次错误提示', vm.messages.some(m => m[0] === 'error'))
  check('这一路不会误写回导图', lostWrites.length === 0)

  // ---- 9. 拿不到任务列表也算「查不到」，原因带进提示 ----
  jobResponses.length = 0
  vm = makeVm()
  vm.jobPollTimer = 7
  vm.jobPendingList = [{ id: 'job-lost', miss: 0 }]
  for (let i = 0; i < 26; i += 1) {
    jobResponses.push({ ok: false, error: '连不上 192.168.1.114:8799' })
    await vm.pollJob()
  }
  check(
    '连不上时把连接错误带进提示',
    /连不上 192.168.1.114:8799/.test(vm.jobWriteError) &&
      vm.jobPendingList.length === 0,
    vm.jobWriteError
  )

  // ---- 10. 中途查到了：计数清零，照常写回 ----
  jobResponses.length = 0
  vm = makeVm()
  vm.jobPollTimer = 8
  vm.jobPendingList = [
    { id: 'job-x', nodeUid: 'n-1', nodeTitle: 'x', miss: 0 }
  ]
  vm.jobPendingMiss = 5
  const writes4 = []
  vm.writeJobResultToNode = async (job, opts) => {
    writes4.push({ id: job.id, markdown: opts.markdown })
  }
  vm.fetchJobText = async () => '这次任务的全文'
  jobResponses.push({ ok: true, jobs: [{ id: 'job-x', state: 'done' }] })
  await vm.pollJob()
  check('查到了就清零（不会误判成丢失）', vm.jobPendingMiss === 0)
  check(
    '查到 done 照常写回全文',
    writes4.length === 1 && writes4[0].markdown === '这次任务的全文',
    JSON.stringify(writes4)
  )
  check('状态变已完成', /已完成/.test(vm.jobStatus), vm.jobStatus)

  // ---- 10b. 连开多个任务：**每一条**都要写回它自己的容器 ----
  // 现场（2026-09-28）：10:37:41 / 10:37:56 / 10:38:09 连开三个，画布上只有最后一个
  // 有「运行输出」。三个任务其实都 done 了 —— 因为 jobPending 只有一个槽位，
  // 后一个派发把前一个覆盖掉，前两个跑完根本没人写回。
  jobResponses.length = 0
  jobsByGateway = {}
  vm = makeVm()
  vm.jobPollTimer = 9
  vm.jobHosts = [HOST]
  vm.jobHostKey = HOST.key
  vm.jobGateway = 'http://127.0.0.1:50001'
  vm.jobPendingList = [
    { id: 'job-1', nodeUid: 'box-1', nodeTitle: '任务 · 10:37', hostKey: HOST.key, gateway: 'http://127.0.0.1:50001', miss: 0 },
    { id: 'job-2', nodeUid: 'box-2', nodeTitle: '任务 · 10:37', hostKey: HOST.key, gateway: 'http://127.0.0.1:50002', miss: 0 },
    { id: 'job-3', nodeUid: 'box-3', nodeTitle: '任务 · 10:38', hostKey: HOST.key, gateway: 'http://127.0.0.1:50001', miss: 0 }
  ]
  jobsByGateway['http://127.0.0.1:50001'] = {
    ok: true,
    jobs: [
      { id: 'job-1', state: 'done', detail: 'result: 第一篇' },
      { id: 'job-3', state: 'done', detail: 'result: 第三篇' }
    ]
  }
  jobsByGateway['http://127.0.0.1:50002'] = {
    ok: true,
    jobs: [{ id: 'job-2', state: 'done', detail: 'result: 第二篇' }]
  }
  const multiWrites = []
  vm.writeJobResultToNode = async (job, opts) => {
    multiWrites.push({
      id: job.id,
      nodeUid: opts.nodeUid,
      gateway: opts.gateway,
      md: opts.markdown
    })
  }
  vm.fetchJobText = async (id, entry) => `全文-${id}@${entry && entry.gateway}`
  await vm.pollJob()
  check(
    '连开三个：三条都写回，各写各的容器',
    multiWrites.length === 3 &&
      multiWrites
        .map(w => `${w.id}:${w.nodeUid}`)
        .sort()
        .join(',') === 'job-1:box-1,job-2:box-2,job-3:box-3',
    JSON.stringify(multiWrites.map(w => `${w.id}:${w.nodeUid}`))
  )

  check(
    '全部写回后出队并停止轮询',
    vm.jobPendingList.length === 0 && vm.jobPollTimer === null,
    `${vm.jobPendingList.length} / ${vm.jobPollTimer}`
  )

  // ---- 10b-2. 旧版桥接回 alive:true 但 state 已是 done：必须判定「跑完」并回写 ----
  // 现场（2026-09-29）：那台执行主机的桥接是旧版，任务其实跑完了，/api/jobs 里
  // `state=done` 但 `alive` 仍是 true。判断写成 `state在跑 || alive===true` 的话，
  // 卡片永远停在「已派发，等待该会话的 Agent 回复」，**前端永远不触发回写**。
  // 现在 state 是终态就一律按跑完处理。
  jobResponses.length = 0
  jobsByGateway = {}
  vm = makeVm()
  vm.jobPollTimer = 12
  vm.jobHosts = [HOST]
  vm.jobHostKey = HOST.key
  vm.jobGateway = 'http://127.0.0.1:50001'
  vm.jobPendingList = [
    {
      id: 'job-alive',
      nodeUid: 'box-a',
      nodeTitle: '任务 · 10:20',
      hostKey: HOST.key,
      gateway: 'http://127.0.0.1:50001',
      miss: 0
    }
  ]
  jobsByGateway['http://127.0.0.1:50001'] = {
    ok: true,
    jobs: [{ id: 'job-alive', state: 'done', alive: true, detail: 'result: 好朋友' }]
  }
  const aliveWrites = []
  vm.writeJobResultToNode = async (job, opts) => {
    aliveWrites.push({ id: job.id, md: opts.markdown })
  }
  vm.fetchJobText = async () => '写完了的全文'
  await vm.pollJob()
  check(
    'alive:true 但 state=done → 判定跑完并写回',
    aliveWrites.length === 1 && aliveWrites[0].md === '写完了的全文',
    JSON.stringify(aliveWrites)
  )
  check(
    '出队，不再挂成「执行中」',
    (vm.jobPendingList || []).length === 0,
    String((vm.jobPendingList || []).length)
  )

  // ---- 10b-3. 反向保护：state=working 时别被误判成跑完 ----
  jobsByGateway = {
    'http://127.0.0.1:50001': {
      ok: true,
      jobs: [{ id: 'job-run', state: 'working', alive: true }]
    }
  }
  vm = makeVm()
  vm.jobPollTimer = 13
  vm.jobHosts = [HOST]
  vm.jobHostKey = HOST.key
  vm.jobGateway = 'http://127.0.0.1:50001'
  vm.jobPendingList = [
    {
      id: 'job-run',
      nodeUid: 'box-r',
      nodeTitle: '任务 · 10:21',
      hostKey: HOST.key,
      gateway: 'http://127.0.0.1:50001',
      miss: 0
    }
  ]
  const runWrites = []
  vm.writeJobResultToNode = async () => {
    runWrites.push(1)
  }
  await vm.pollJob()
  check(
    'state=working 且 alive=true 时仍算在跑（不误判）',
    runWrites.length === 0 && (vm.jobPendingList || []).length === 1,
    `${runWrites.length} / ${(vm.jobPendingList || []).length}`
  )
  jobsByGateway = {}
  check(
    '取全文按条目自己那条会话（job-2 在 50002，不是当前选中的 50001）',
    multiWrites.find(w => w.id === 'job-2').gateway === 'http://127.0.0.1:50002' &&
      multiWrites.find(w => w.id === 'job-2').md === '全文-job-2@http://127.0.0.1:50002',
    JSON.stringify(multiWrites.map(w => w.gateway))
  )

  // ---- 10c. 一条跑完、一条还在跑：只写回完成那条，轮询继续 ----
  jobsByGateway = {}
  vm = makeVm()
  vm.jobPollTimer = 11
  vm.jobHosts = [HOST]
  vm.jobHostKey = HOST.key
  vm.jobGateway = 'http://127.0.0.1:50001'
  vm.jobPendingList = [
    { id: 'job-a', nodeUid: 'box-a', nodeTitle: 'A', hostKey: HOST.key, gateway: 'http://127.0.0.1:50001', miss: 0 },
    { id: 'job-b', nodeUid: 'box-b', nodeTitle: 'B', hostKey: HOST.key, gateway: 'http://127.0.0.1:50001', miss: 0 }
  ]
  jobsByGateway['http://127.0.0.1:50001'] = {
    ok: true,
    jobs: [
      { id: 'job-a', state: 'done', detail: 'result: A 好了' },
      { id: 'job-b', state: 'working', detail: '还在跑' }
    ]
  }
  const mixWrites = []
  vm.writeJobResultToNode = async (job, opts) => {
    mixWrites.push({ id: job.id, nodeUid: opts.nodeUid })
  }
  vm.fetchJobText = async () => 'A 的全文'
  await vm.pollJob()
  check(
    '只写回已完成的那条',
    mixWrites.length === 1 && mixWrites[0].id === 'job-a' && mixWrites[0].nodeUid === 'box-a',
    JSON.stringify(mixWrites)
  )
  check(
    '还在跑的那条留在队列里，轮询不停',
    vm.jobPendingList.length === 1 &&
      vm.jobPendingList[0].id === 'job-b' &&
      vm.jobPollTimer === 11,
    `${JSON.stringify(vm.jobPendingList.map(x => x.id))} / ${vm.jobPollTimer}`
  )
  check(
    '状态栏看得出还有几个在跑',
    /1 个在跑/.test(vm.jobStatus),
    vm.jobStatus
  )

  // ---- 11. WorkBuddy 会话（端口）一览：默认收起，展开才拉，能看出谁忙谁闲 ----
  jobResponses.length = 0
  jobsByGateway = {}
  gatewaysResult = {
    ok: true,
    gateways: [
      { url: 'http://127.0.0.1:52369', title: '排查本地 API', cwd: 'D:\\cathch' },
      { url: 'http://127.0.0.1:55317', title: '启动 lan-bridge', cwd: 'D:\\demo' }
    ]
  }
  jobsByGateway = {
    'http://127.0.0.1:52369': {
      ok: true,
      jobs: [
        { id: 'j1', name: '脑图运行 · 招聘', state: 'working' },
        { id: 'j0', name: '老任务', state: 'done' }
      ]
    },
    'http://127.0.0.1:55317': {
      ok: true,
      jobs: [{ id: 'j2', name: '旧任务', state: 'done' }]
    }
  }
  vm = makeVm()
  // 派发用的会话就是列表里的第一条（真实场景也是：会话列表头一条默认被选中）
  vm.jobGateway = 'http://127.0.0.1:52369'
  check('会话栏默认收起', vm.jobSessionsExpanded === false && vm.jobSessions.length === 0)
  await vm.toggleJobSessions()
  check(
    '展开后列出全部会话（端口）',
    vm.jobSessions.length === 2 &&
      vm.jobSessions.map(s => s.port).join(',') === '52369,55317',
    JSON.stringify(vm.jobSessions.map(s => s.port))
  )
  check(
    '在跑的那个会话标出运行中的任务',
    vm.jobSessions[0].running.length === 1 && vm.jobSessions[0].running[0].id === 'j1',
    JSON.stringify(vm.jobSessions[0].running.map(j => j.id))
  )
  check('跑完的会话算闲置', vm.jobSessions[1].running.length === 0)
  check(
    '头部计数只数在跑的',
    component.computed.runningSessionCount.call(vm) === 1,
    String(component.computed.runningSessionCount.call(vm))
  )
  check(
    '标出「派发用这条」的那个会话',
    vm.jobSessions.some(s => s.url === vm.jobGateway)
  )
  await vm.toggleJobSessions()
  check('再点一下收起', vm.jobSessionsExpanded === false)

  // ---- 11b. 远程老桥接：/api/gateways 没有 spawned 字段，也要能回收 ----
  // 现场（2026-09-29）：执行主机的桥接是 09-28 之前的版本，gateways 里 5 个会话都没有
  // spawned 字段（但 /api/sessions/spawned 有五条），于是「回收」按钮整片消失 ——
  // 会话攒满 5 个把机器拖卡，又再也收不回去。
  gatewaysResult = {
    ok: true,
    gateways: [
      { url: 'http://127.0.0.1:59561', title: '图谱标题命名', pid: 4564 },
      { url: 'http://127.0.0.1:58959', title: '扩写四季文章', pid: 4632 }
    ]
  }
  spawnedResult = {
    ok: true,
    items: [{ pid: 4564, url: 'http://127.0.0.1:59561/', alive: true }],
    count: 1,
    limit: 5,
    remaining: 4,
    canSpawn: true
  }
  vm = makeVm()
  await vm.loadJobSessions()
  check(
    '老桥接没 spawned 字段时，靠自动会话清单认出来（尾斜杠也要认）',
    vm.jobSessions[0].spawned === true && vm.jobSessions[1].spawned === false,
    JSON.stringify(vm.jobSessions.map(s => s.spawned))
  )
  check(
    '顺手把额度也填上（不再多打一次桥接）',
    vm.jobSpawnInfo.count === 1 && vm.jobSpawnInfo.limit === 5,
    JSON.stringify(vm.jobSpawnInfo)
  )
  spawnedResult = {
    ok: true,
    items: [],
    count: 0,
    limit: 5,
    remaining: 5,
    canSpawn: true
  }

  // ---- 11c. 运行历史跨会话合并：任务存在各自会话里，只问一个就「记录不见了」 ----
  gatewaysResult = {
    ok: true,
    gateways: [
      { url: 'http://127.0.0.1:52369' },
      { url: 'http://127.0.0.1:55317' }
    ]
  }
  jobsByGateway = {
    'http://127.0.0.1:52369': {
      ok: true,
      jobs: [
        { id: 'old-a', name: '早先的活', updatedAt: 100, gateway: 'http://127.0.0.1:52369' },
        { id: 'dup', name: '两边都报同一条', updatedAt: 150 }
      ]
    },
    'http://127.0.0.1:55317': {
      ok: true,
      jobs: [
        { id: 'new-b', name: '刚跑的活', updatedAt: 300 },
        { id: 'dup', name: '两边都报同一条', updatedAt: 150 }
      ]
    }
  }
  vm = makeVm()
  await vm.loadJobHistory()
  check(
    '两个会话的记录合并、按时间倒序',
    vm.jobHistory.map(j => j.id).join(',') === 'new-b,dup,old-a',
    vm.jobHistory.map(j => j.id).join(',')
  )
  check(
    '同一条任务两边都报也只留一条',
    vm.jobHistory.filter(j => j.id === 'dup').length === 1
  )
  check(
    '每条都带上来自哪个会话（停止/取完整回答要用）',
    vm.jobHistory.every(j => !!j.gateway),
    JSON.stringify(vm.jobHistory.map(j => j.gateway))
  )
  jobsByGateway = {}

  // ---- 11d. 待回写任务跨刷新活下来 ----
  // 现场（2026-09-29）：「产物没有回填，都要我去 WorkBuddy 说一声」。
  // 任务其实跑完了、产物也在（桥接 /api/job-artifacts 取得到），
  // 但用户中途刷新过页面 → 内存里的 jobPendingList 一空 → 再没人轮询 → 永不回写。
  localStore.clear()
  vm = makeVm()
  vm.jobPendingList = [
    {
      id: 'p-keep',
      nodeUid: 'box-p',
      nodeTitle: '任务 · 10:40',
      hostKey: HOST.key,
      gateway: 'http://127.0.0.1:50001'
    }
  ]
  vm.savePendingJobs()
  const saved = localStore.get('mindmap:pendingJobs')
  check('待回写任务会落盘', !!saved && /p-keep/.test(saved), String(saved).slice(0, 90))

  // 模拟「刷新页面」：新 vm 什么都不记得
  vm = makeVm()
  check('刷新后内存里是空的', (vm.jobPendingList || []).length === 0)
  const restoredCount = vm.restorePendingJobs()
  check(
    '恢复出上次没回写完的任务',
    restoredCount === 1 && vm.jobPendingList[0].id === 'p-keep',
    `${restoredCount} / ${JSON.stringify(vm.jobPendingList)}`
  )

  // 回写完（列表清空）→ 落盘也清掉，别下次又捡回来
  vm.jobPendingList = []
  vm.savePendingJobs()
  check('回写完成后落盘清空', !localStore.get('mindmap:pendingJobs'))

  // 过期的不捡：超过 TTL 的记录直接丢掉，避免僵尸任务一直被轮询
  localStore.set(
    'mindmap:pendingJobs',
    JSON.stringify([
      {
        id: 'old',
        gateway: 'http://127.0.0.1:50001',
        at: Date.now() - 24 * 3600 * 1000
      }
    ])
  )
  vm = makeVm()
  check(
    '过期任务不恢复',
    vm.restorePendingJobs() === 0 && (vm.jobPendingList || []).length === 0
  )
  localStore.clear()

  // ---- 11e. 并发：两个任务各写各自的容器 ----
  // 现场（2026-09-29）：「两个任务同时执行，只会出现一个任务 / 第二个一直卡着 /
  // 手动点击写回的时候挂载的节点是第一个任务」。根因：prepareJobContainer 里有
  // 一次 await，落点却写在共享的 this.jobRunNodeUid 上 —— 并发时后一条把它覆盖，
  // 两条任务于是都指向同一个容器。现在落点由**返回值**带回。
  const nodeA = makeNode('A 节点', { uid: 'node-a' })
  const nodeB = makeNode('B 节点', { uid: 'node-b' })
  const madeBoxes = ['box-A', 'box-B']
  let boxSeq = 0
  vm = makeVm()
  vm.$bus.$emit = (name, payload) => {
    if (name !== 'create_job_container' || !payload || !payload.result) return
    const uid = madeBoxes[boxSeq++]
    payload.result.promise = Promise.resolve({ ok: true, uid, title: uid })
  }
  const [boxA, boxB] = await Promise.all([
    vm.prepareJobContainer('prompt-a', nodeA),
    vm.prepareJobContainer('prompt-b', nodeB)
  ])
  check(
    '并发准备容器：各自拿到自己的落点',
    boxA.nodeUid === 'box-A' && boxB.nodeUid === 'box-B',
    `${boxA.nodeUid} / ${boxB.nodeUid}`
  )
  check(
    '返回的是落点对象（不再靠 true/false + 实例变量传值）',
    boxA.ok === true && !!boxA.nodeUid && !!boxA.nodeTitle,
    JSON.stringify(boxA)
  )
  check(
    '建容器失败时明确 ok:false（调用方据此中止）',
    (await (async () => {
      let n = 0
      const vm2 = makeVm()
      vm2.$bus.$emit = (name, payload) => {
        if (name !== 'create_job_container' || !payload || !payload.result) return
        n += 1
        payload.result.promise = Promise.resolve({ ok: false, error: '炸了' })
      }
      const out = await vm2.prepareJobContainer('p', nodeA)
      return out.ok === false && n === 1
    })()) === true
  )

  // ---- 11f. 恢复窗口只有 30 分钟：早上跑完的别捡回来重写 ----
  // 现场（2026-09-29）：「我还没执行完就写回了，似乎是之前的写回产物」——
  // 12 小时的窗口把早就被手动处理过的任务也捡回来重写了。
  localStore.set(
    'mindmap:pendingJobs',
    JSON.stringify([
      {
        id: 'stale-3h',
        gateway: 'http://127.0.0.1:50001',
        at: Date.now() - 3 * 3600 * 1000
      }
    ])
  )
  vm = makeVm()
  check(
    '3 小时前派发的不再捡回来',
    vm.restorePendingJobs() === 0 && (vm.jobPendingList || []).length === 0
  )
  localStore.set(
    'mindmap:pendingJobs',
    JSON.stringify([
      {
        id: 'fresh-5m',
        gateway: 'http://127.0.0.1:50001',
        at: Date.now() - 5 * 60 * 1000
      }
    ])
  )
  vm = makeVm()
  check('5 分钟前的还会捡回来（刚派发就刷新的场景）', vm.restorePendingJobs() === 1)
  localStore.clear()

  // ---- 11g. 待回写条目的会话以它自己带的为准 ----
  // 并发派发时 this.jobGateway 可能已被后一条改掉，取错会话就会拉到别的任务的产物。
  vm = makeVm()
  vm.startJobPoll = () => {} // 别真起定时器
  vm.jobGateway = 'http://127.0.0.1:99999'
  vm.addPendingJob({
    id: 'p-own',
    gateway: 'http://127.0.0.1:50001',
    hostKey: '127.0.0.1:8799',
    nodeUid: 'box-own'
  })
  const own = (vm.jobPendingList || []).find(x => x.id === 'p-own')
  check(
    '条目保留自己的 gateway（不被当前选中覆盖）',
    !!own && own.gateway === 'http://127.0.0.1:50001',
    own ? own.gateway : '-'
  )
  vm.addPendingJob({ id: 'p-fallback', nodeUid: 'box-f' })
  const fb = (vm.jobPendingList || []).find(x => x.id === 'p-fallback')
  check(
    '没带时才回退到当前会话',
    !!fb && fb.gateway === 'http://127.0.0.1:99999',
    fb ? fb.gateway : '-'
  )

  // 拿不到会话列表：报错但别炸
  gatewaysResult = { ok: false, error: '连不上 192.168.1.114:8799 的任务桥' }
  vm = makeVm()
  await vm.loadJobSessions()
  check(
    '拿不到会话列表时报错、留空',
    /连不上 192.168.1.114:8799/.test(vm.jobSessionsError) &&
      vm.jobSessions.length === 0 &&
      vm.jobSessionsLoading === false,
    vm.jobSessionsError
  )

  // 展开着的时候刷新运行历史会顺手刷会话
  gatewaysResult = {
    ok: true,
    gateways: [{ url: 'http://127.0.0.1:52369', title: 'A' }]
  }
  jobsByGateway = {
    'http://127.0.0.1:52369': { ok: true, jobs: [{ id: 'j9', state: 'busy' }] }
  }
  vm = makeVm()
  vm.jobSessionsExpanded = true
  vm.jobSessions = []
  jobResponses.push({ ok: true, jobs: [] })
  await vm.loadJobHistory()
  check(
    '展开状态下刷新运行历史会顺手刷会话忙闲',
    vm.jobSessions.length === 1 && vm.jobSessions[0].running.length === 1,
    JSON.stringify(vm.jobSessions.map(s => s.running.length))
  )

  // ---- 15. 「自动」会话不落回执：挑会话时避开它（2026-09-29 现场）----
  vm = makeVm()
  vm.jobSpawnedIndex = new Set(['http://127.0.0.1:54418', 16572])
  const autoRow = { url: 'http://127.0.0.1:54418', pid: 16572 }
  const normalRow = { url: 'http://127.0.0.1:50323', pid: 9001 }
  check(
    '挑派发会话：有普通会话时不选「自动」的那条',
    vm.pickJobGateway([autoRow, normalRow], '') === normalRow.url,
    vm.pickJobGateway([autoRow, normalRow], '')
  )
  check(
    '上次用的正是「自动」会话 → 也换成普通会话',
    vm.pickJobGateway([autoRow, normalRow], autoRow.url) === normalRow.url,
    vm.pickJobGateway([autoRow, normalRow], autoRow.url)
  )
  check(
    '只有「没被证实能用」的自动会话 → 返回空，不派进去白等（让上层提示开桌面版）',
    vm.pickJobGateway([autoRow], '') === '',
    JSON.stringify(vm.pickJobGateway([autoRow], ''))
  )
  check(
    '自动会话**一律不用**（哪怕它走过 jobs）—— 用户要求停用自动会话',
    (() => {
      const fresh = makeVm()
      fresh.jobHostKey = HOST.key
      fresh.jobSpawnedIndex = new Set([autoRow.url, autoRow.pid])
      fresh.noteReceiptSafe(autoRow.url, 'jobs')
      return fresh.pickJobGateway([autoRow], '') === ''
    })()
  )
  check(
    'isAutoSession：url 口径与 pid 口径都认',
    vm.isAutoSession(autoRow) === true &&
      vm.isAutoSession(normalRow) === false &&
      vm.isAutoSession({ url: autoRow.url, pid: 0 }) === true &&
      vm.isAutoSession({ url: 'http://127.0.0.1:60000', pid: 16572 }) === true &&
      vm.isAutoSession(null) === false
  )

  // ---- 16. run 永远不落终态 → 超时后主动从会话历史收一次并写回 ----
  const recovered = []
  transcriptResult = { ok: true, text: '## 一句话结论\n四季如春。' }
  vm = makeVm()
  vm.jobGateway = 'http://127.0.0.1:54418'
  vm.jobHostKey = HOST.key
  jobsByGateway = {
    'http://127.0.0.1:54418': {
      ok: true,
      jobs: [
        {
          id: 'stuck-1',
          state: 'working',
          alive: true,
          name: '写一个四季如春的作文100字',
          detail: ''
        }
      ]
    }
  }
  vm.jobPendingList = [
    {
      id: 'stuck-1',
      gateway: 'http://127.0.0.1:54418',
      hostKey: HOST.key,
      nodeUid: 'box-9',
      nodeTitle: '四季',
      at: Date.now() - 5 * 60 * 1000,
      miss: 0
    }
  ]
  vm.writeJobResultToNode = async (job, opts) => {
    recovered.push(opts)
  }
  await vm.pollJob()
  check(
    '「自动」会话卡在 working：超时后按会话历史收尾并写回',
    recovered.length === 1 &&
      recovered[0].nodeUid === 'box-9' &&
      String(recovered[0].markdown).includes('四季如春'),
    JSON.stringify(recovered.map(r => r.nodeUid))
  )
  check('收尾后这条从待回写列表里出队', vm.jobPendingList.length === 0)

  // ---- 17. 过了放弃线还取不到正文 → 判死收尾，别永远转圈 ----
  transcriptResult = { ok: true, text: '' }
  vm = makeVm()
  vm.jobGateway = 'http://127.0.0.1:54418'
  vm.jobHostKey = HOST.key
  jobsByGateway = {
    'http://127.0.0.1:54418': {
      ok: true,
      jobs: [
        {
          id: 'stuck-2',
          state: 'dispatched',
          alive: true,
          name: 'x',
          detail: ''
        }
      ]
    }
  }
  vm.jobPendingList = [
    {
      id: 'stuck-2',
      gateway: 'http://127.0.0.1:54418',
      hostKey: HOST.key,
      nodeUid: 'box-10',
      nodeTitle: '卡住的',
      at: Date.now() - 7 * 60 * 1000,
      miss: 0
    }
  ]
  vm.writeJobResultToNode = async () => {}
  await vm.pollJob()
  check(
    '过了放弃线仍取不到正文：判死并移出，不再永远显示「已派发」',
    vm.jobPendingList.length === 0 &&
      vm.jobStatusType === 'jobErr' &&
      String(vm.jobWriteError).includes('取不回'),
    vm.jobWriteError
  )
  check(
    '刚派发不久的任务不受宽限影响（还在正常等）',
    vm.pendingReceiptTimedOut({ at: Date.now() }) === false &&
      vm.pendingReceiptGaveUp({ at: Date.now() }) === false &&
      vm.pendingReceiptTimedOut({ at: Date.now() - 5 * 60 * 1000 }) === true &&
      vm.pendingReceiptGaveUp({ at: Date.now() - 7 * 60 * 1000 }) === true
  )

  // ---- 18. 按「派发时实际走的接口」学回执安全性 ----
  // 判据为什么不能只看「是不是自动会话」（2026-09-29 实测）：
  // 本机 WorkBuddy 2.137.1 的**自动会话**走 jobs、任务正常 done；
  // 服务器 2.132.0 的自动会话只能回退 runs、回执取不回。
  // 真正决定成败的是那条会话支不支持 Jobs 接口，而这个事实在派发响应的 mode 里。
  vm = makeVm()
  vm.jobHostKey = HOST.key
  check(
    '还没派发过 → 回执安全性未知(null)，不冤枉任何一条会话',
    vm.receiptSafeOf('http://127.0.0.1:1') === null
  )
  vm.noteReceiptSafe('http://127.0.0.1:54418', 'runs')
  vm.noteReceiptSafe('http://127.0.0.1:56752', 'jobs')
  check(
    'runs 记为不安全、jobs 记为安全',
    vm.receiptSafeOf('http://127.0.0.1:54418') === false &&
      vm.receiptSafeOf('http://127.0.0.1:56752') === true
  )
  check(
    '学习结果落盘（刷新后还记得）',
    String(localStore.get('mindmap:jobReceiptSafe') || '').includes('54418')
  )

  const autoOk = { url: 'http://127.0.0.1:6980', pid: 6980 }
  const plainUnknown = { url: 'http://127.0.0.1:35792', pid: 35792 }
  vm = makeVm()
  vm.jobHostKey = HOST.key
  vm.jobSpawnedIndex = new Set(['http://127.0.0.1:6980', 6980])
  vm.noteReceiptSafe(autoOk.url, 'jobs')
  check(
    '自动会话一律排在门外：哪怕它走过 jobs，也优先用普通会话',
    vm.pickJobGateway([plainUnknown, autoOk], '') === plainUnknown.url,
    vm.pickJobGateway([plainUnknown, autoOk], '')
  )
  vm.noteReceiptSafe('http://127.0.0.1:54418', 'runs')
  check(
    '已知走 runs 的会话 → 被换成别的（哪怕它是上次用的那条）',
    vm.pickJobGateway(
      [{ url: 'http://127.0.0.1:54418', pid: 16572 }, plainUnknown],
      'http://127.0.0.1:54418'
    ) === plainUnknown.url
  )
  check(
    '都没学过时仍然优先上次用的那条（端口稳定原则不变）',
    (() => {
      const fresh = makeVm()
      fresh.jobHostKey = HOST.key
      fresh.jobSpawnedIndex = new Set(['http://127.0.0.1:6980', 6980])
      return fresh.pickJobGateway([autoOk, plainUnknown], plainUnknown.url) ===
        plainUnknown.url
    })()
  )

  // ---- 19. 任务被派到**别的会话**时，轮询得能在别处找到它 ----
  // 2026-09-29 反馈：页面上报「任务桥里找不到这条任务（WorkBuddy 或桥接重启过），
  // 这次没有写回导图」—— 真相是派发目标中途被换过，任务好好跑在另一条会话里，
  // 而轮询只在 entry.gateway 那一条里找。
  const moved = []
  transcriptResult = { ok: true, text: '## 一句话结论\n在别的会话里跑完了' }
  vm = makeVm()
  vm.jobHostKey = HOST.key
  gatewaysResult = {
    ok: true,
    gateways: [{ url: 'http://127.0.0.1:50001' }, { url: 'http://127.0.0.1:50002' }]
  }
  jobsByGateway = {
    'http://127.0.0.1:50001': { ok: true, jobs: [] },
    'http://127.0.0.1:50002': {
      ok: true,
      jobs: [
        { id: 'moved-1', state: 'completed', alive: false, name: '飘走的任务', detail: 'done' }
      ]
    }
  }
  vm.jobPendingList = [
    {
      id: 'moved-1',
      gateway: 'http://127.0.0.1:50001',
      hostKey: HOST.key,
      nodeUid: 'box-m',
      nodeTitle: '飘了',
      at: Date.now(),
      miss: 0
    }
  ]
  vm.writeJobResultToNode = async (job, opts) => {
    moved.push(opts)
  }
  await vm.pollJob()
  check(
    '任务在别的会话里也能找到并写回（不再误报「任务记录消失」）',
    moved.length === 1 &&
      moved[0].nodeUid === 'box-m' &&
      vm.jobPendingList.length === 0,
    JSON.stringify(moved.map(m => m.nodeUid))
  )

  // ---- 20. 失败自动换会话重试（最多 3 次）----
  // 2026-09-29 需求：「加入3次重试作保障」。必须**换会话** —— 失败原因多半就是
  // 那条会话不可用（旧版 WorkBuddy 的自动会话走 runs、任务根本进不去）。
  vm = makeVm()
  vm.jobHostKey = HOST.key
  vm.jobGateways = [
    { url: 'http://127.0.0.1:54418' },
    { url: 'http://127.0.0.1:56752' }
  ]
  vm.jobSpawnedIndex = new Set(['http://127.0.0.1:54418', 16572])
  vm.jobGateway = 'http://127.0.0.1:54418'
  dispatchResult = { ok: true, job: { id: 'retry-1' }, mode: 'jobs' }
  const retryEntry = {
    id: 'fail-1',
    gateway: 'http://127.0.0.1:54418',
    hostKey: HOST.key,
    nodeUid: 'box-r',
    nodeTitle: '会失败的任务',
    at: Date.now(),
    miss: 0,
    prompt: '写一篇短文'
  }
  vm.jobPendingList = [retryEntry]
  const didRetry = await vm.retryPendingJob(retryEntry, '执行失败')
  check(
    '失败时换**另一条**会话重派（不是原地重试）',
    didRetry === true &&
      retryEntry.gateway === 'http://127.0.0.1:56752' &&
      retryEntry.retry === 1 &&
      retryEntry.id === 'retry-1',
    JSON.stringify({
      g: retryEntry.gateway,
      r: retryEntry.retry,
      id: retryEntry.id
    })
  )
  check(
    '重派后条目回到待回写列表（新 id 得有人轮询）',
    vm.jobPendingList.length === 1 &&
      vm.jobPendingList[0].id === 'retry-1'
  )

  retryEntry.retry = 3
  check(
    '用满 3 次就不再重试',
    (await vm.retryPendingJob(retryEntry, 'x')) === false
  )
  check(
    '只有一条会话时无法换会话 → 不重试（免得原地再进同一个坑）',
    (await (async () => {
      const only = {
        id: 'f2',
        gateway: 'http://127.0.0.1:56752',
        hostKey: HOST.key,
        nodeUid: 'b',
        nodeTitle: 'x',
        at: Date.now(),
        miss: 0,
        prompt: 'p'
      }
      vm.jobGateways = [{ url: 'http://127.0.0.1:56752' }]
      return vm.retryPendingJob(only, 'x')
    })()) === false
  )
  check(
    '老条目没记下提示词 → 不重试（安全降级，不当成 bug）',
    (await vm.retryPendingJob({
      id: 'f3',
      gateway: 'http://127.0.0.1:56752',
      hostKey: HOST.key,
      nodeUid: 'b',
      nodeTitle: 'x',
      at: Date.now(),
      miss: 0
    }, 'x')) === false
  )

  // state=failed 走到 pollJob 里 → 应该重派，而不是直接报「没有写回导图」
  vm = makeVm()
  vm.jobHostKey = HOST.key
  vm.jobGateways = [
    { url: 'http://127.0.0.1:54418' },
    { url: 'http://127.0.0.1:56752' }
  ]
  vm.jobSpawnedIndex = new Set(['http://127.0.0.1:54418', 16572])
  vm.jobGateway = 'http://127.0.0.1:54418'
  dispatchResult = { ok: true, job: { id: 'retry-2' }, mode: 'jobs' }
  jobsByGateway = {
    'http://127.0.0.1:54418': {
      ok: true,
      jobs: [{ id: 'fail-2', state: 'failed', alive: false, name: 'x', detail: '' }]
    }
  }
  const failEntry = {
    id: 'fail-2',
    gateway: 'http://127.0.0.1:54418',
    hostKey: HOST.key,
    nodeUid: 'box-f',
    nodeTitle: '跑挂了的任务',
    at: Date.now(),
    miss: 0,
    prompt: '写点东西'
  }
  vm.jobPendingList = [failEntry]
  vm.writeJobResultToNode = async () => {
    throw new Error('不该走到写回')
  }
  await vm.pollJob()
  check(
    '执行失败 → 自动换会话重派，而不是直接报「没有写回导图」',
    failEntry.retry === 1 &&
      failEntry.gateway === 'http://127.0.0.1:56752' &&
      vm.jobPendingList.length === 1,
    JSON.stringify({
      r: failEntry.retry,
      g: failEntry.gateway,
      n: vm.jobPendingList.length
    })
  )

  // ---- 21. 目标会话为空 → 先快速拉一次列表，别一上来就去「起会话」 ----
  // 2026-09-29 反馈：「点运行之后为什么要等好久才能重新点击」。其中一个原因就是
  // 页面刚打开、jobGateway 还没加载完时，ensureDispatchTarget 直接去让桥接起会话
  // （起进程 + 等注册，超时 45s）。多数情况一个 /api/gateways 就挑得到了。
  vm = makeVm()
  vm.jobHostKey = HOST.key
  vm.jobGateways = []
  vm.jobGateway = ''
  gatewaysResult = { ok: true, gateways: [{ url: 'http://127.0.0.1:56752' }] }
  spawnedResult = {
    ok: true,
    items: [],
    count: 0,
    limit: 5,
    remaining: 5,
    canSpawn: true
  }
  const ensured = await vm.ensureDispatchTarget()
  check(
    '目标为空时先拉一次会话列表就能派（不用去起新会话）',
    ensured.ok === true && ensured.gateway === 'http://127.0.0.1:56752',
    JSON.stringify({ ok: ensured.ok, gw: ensured.gateway })
  )

  // ---- 22. 正文拿不到、但能扫到产物 → 也要挂回导图 ----
  // 用户反馈（2026-09-29）：「新建会话这种自动的，没法返回产物，但是能知道跑了」。
  // 这类会话走 runs 通道：run 台账不更新、transcript 也空 —— 但产物确实落在 output/ 下。
  const artWrites = []
  transcriptResult = { ok: true, text: '' }
  recentArtifactsResult = {
    ok: true,
    files: [
      { path: 'D:/cathch/x/output/作文-2026-09-29.md', size: 1200, exists: true }
    ]
  }
  vm = makeVm()
  vm.jobHostKey = HOST.key
  vm.jobGateways = [{ url: 'http://127.0.0.1:54418' }]
  vm.jobGateway = 'http://127.0.0.1:54418'
  jobsByGateway = {
    'http://127.0.0.1:54418': {
      ok: true,
      jobs: [{ id: 'art-1', state: 'working', alive: true, name: 'x', detail: '' }]
    }
  }
  vm.jobPendingList = [
    {
      id: 'art-1',
      gateway: 'http://127.0.0.1:54418',
      hostKey: HOST.key,
      nodeUid: 'box-a',
      nodeTitle: '自动会话的任务',
      at: Date.now() - 5 * 60 * 1000,
      miss: 0
    }
  ]
  vm.writeJobResultToNode = async (job, opts) => {
    artWrites.push(opts)
  }
  await vm.pollJob()
  check(
    '正文拿不到但扫到产物 → 照样写回，并把产物带上（挂附件）',
    artWrites.length === 1 &&
      Array.isArray(artWrites[0].artifacts) &&
      artWrites[0].artifacts.length === 1 &&
      vm.jobPendingList.length === 0,
    JSON.stringify({
      writes: artWrites.length,
      arts: (artWrites[0] && artWrites[0].artifacts || []).length
    })
  )

  // ---- 23. 并发派发自动分流：别都挤在一条会话上排队 ----
  // 2026-09-29 实测：6 秒内派 4 条任务到同一条会话 → 只有第一条按时出结果，
  // 其余干等（一条 WorkBuddy 会话同时只跑一个任务）。
  vm = makeVm()
  vm.jobHostKey = HOST.key
  const busyGw = 'http://127.0.0.1:50001'
  const idleGw = 'http://127.0.0.1:50002'
  vm.jobGateways = [{ url: busyGw }, { url: idleGw }]
  vm.jobPendingList = [
    { id: 'p1', gateway: busyGw, at: Date.now(), miss: 0 }
  ]
  check(
    '会话忙**不再换会话**（用户要求改成队列串行）—— 仍然用上次那条，任务去排队',
    vm.pickJobGateway(vm.jobGateways, busyGw, null) === busyGw,
    vm.pickJobGateway(vm.jobGateways, busyGw, null)
  )
  check(
    '会话闲置时行为完全不变：仍然用它（端口稳定原则不破）',
    (() => {
      const fresh = makeVm()
      fresh.jobHostKey = HOST.key
      fresh.jobGateways = [{ url: busyGw }, { url: idleGw }]
      fresh.jobPendingList = []
      return fresh.pickJobGateway(fresh.jobGateways, busyGw, null) === busyGw
    })()
  )
  check(
    '所有会话都忙 → 还是用上次那条（不乱跳）',
    (() => {
      const fresh = makeVm()
      fresh.jobHostKey = HOST.key
      fresh.jobGateways = [{ url: busyGw }, { url: idleGw }]
      fresh.jobPendingList = [
        { id: 'p1', gateway: busyGw, at: Date.now(), miss: 0 },
        { id: 'p2', gateway: idleGw, at: Date.now(), miss: 0 }
      ]
      return fresh.pickJobGateway(fresh.jobGateways, busyGw, null) === busyGw
    })()
  )

  // ---- 24. 已知走 runs 的会话：兜底更早开始，别白等 4 分钟 ----
  // 现场（2026-09-29 服务器 2.132.0）：那台**所有**会话都走 runs，run 状态从不更新，
  // 所以「等 4 分钟再去看」纯属白等 —— 任务在跑、产物在落，早点扫就早点拿到。
  vm = makeVm()
  vm.jobHostKey = HOST.key
  const runsGw = 'http://127.0.0.1:50009'
  vm.noteReceiptSafe(runsGw, 'runs')
  const twoMinAgo = Date.now() - 2 * 60 * 1000
  const fiveMinAgo = Date.now() - 5 * 60 * 1000
  check(
    '已知走 runs 的会话：2 分钟就去取结果（宽限 90 秒）',
    vm.pendingReceiptTimedOut({ gateway: runsGw, at: twoMinAgo }) === true
  )
  check(
    '没学过的会话仍按 4 分钟宽限（不误判成 runs）',
    vm.pendingReceiptTimedOut({
      gateway: 'http://127.0.0.1:50010',
      at: twoMinAgo
    }) === false
  )
  check(
    '没学过的会话到 5 分钟照样会去取',
    vm.pendingReceiptTimedOut({
      gateway: 'http://127.0.0.1:50010',
      at: fiveMinAgo
    }) === true
  )

  // ---- 25. 队列串行：已有任务在跑就入队，跑完自动派下一个 ----
  // 用户要求（2026-09-29）：「用队列排队执行」。
  vm = makeVm()
  vm.jobHostKey = HOST.key
  vm.jobGateways = [{ url: 'http://127.0.0.1:50001' }]
  vm.jobGateway = 'http://127.0.0.1:50001'
  vm.startJobPoll = () => {}
  vm.jobPendingList = [
    { id: 'run-1', gateway: 'http://127.0.0.1:50001', at: Date.now(), miss: 0 }
  ]
  dispatchResult = { ok: true, job: { id: 'queued-1' }, mode: 'jobs' }
  vm.enqueueDispatch({
    host: HOST,
    gateway: 'http://127.0.0.1:50001',
    prompt: '写点东西',
    name: '脑图运行 · 排队',
    container: { nodeUid: 'box-q', nodeTitle: '排队任务' }
  })
  check(
    '已有任务在路上 → 入队（不并发派发）',
    (vm.jobQueue || []).length === 1 && vm.jobPendingList.length === 1,
    String((vm.jobQueue || []).length)
  )
  check(
    '队列落盘（刷新不丢）',
    String(localStore.get('mindmap:jobQueue') || '').includes('写点东西')
  )
  vm.jobPendingList = []
  await vm.drainJobQueue()
  check(
    '前一个跑完 → 自动派下一个，并进待回写列表',
    (vm.jobQueue || []).length === 0 &&
      vm.jobPendingList.length === 1 &&
      vm.jobPendingList[0].id === 'queued-1',
    JSON.stringify({ q: (vm.jobQueue || []).length, p: vm.jobPendingList.length })
  )

  // ---- 26. 运行通道：设置里选一次，点运行直接按它跑（2026-10-08 用户要求）----
  // 用户原话：「把运行弹窗选择用什么跑 放到右侧栏的设置里面的AI执行引擎 可以下拉选择
  // 点运行就直接按照设置的运行了 就不用弹窗」。
  // 所以这里断言两件事：① 取值/落盘还是那套（默认助理）；② 工具栏**没有弹窗**了，
  // 点运行直接按设置分叉。
  localStore.clear()
  vm = makeVm()
  check(
    '默认通道是助理（WorkBuddy）',
    vm.recallRunChannel() === 'openclaw',
    vm.recallRunChannel()
  )
  localStore.set('mindmap:runChannel', 'bridge')
  check('设置里选过桥接就记住桥接', vm.recallRunChannel() === 'bridge')
  localStore.set('mindmap:runChannel', '乱写的值')
  check('非法值回落到默认（OpenClaw）', vm.recallRunChannel() === 'openclaw')
  check(
    '旧的运行弹窗已拆掉（不再有 pickRunChannel）',
    typeof vm.pickRunChannel !== 'function' &&
      typeof vm.confirmRunChannel !== 'function'
  )
  check(
    '工具栏不再残留弹窗状态',
    vm.runChannelVisible === undefined && vm.runChannelPick === undefined
  )

  // 设置没动过（默认助理）→ 点运行直接走助理通道，全程没有弹窗
  localStore.clear()
  vm = makeVm()
  let openclawCalls = 0
  vm.runViaOpenclaw = async () => {
    openclawCalls += 1
  }
  await vm.runWorkbuddyJob()
  check(
    '按设置（默认助理）点运行 → 直接走助理通道',
    openclawCalls === 1,
    String(openclawCalls)
  )
  check('记下这次用的通道', vm.jobChannel === 'openclaw', vm.jobChannel)
  check('跑完复位 jobDispatching', vm.jobDispatching === false)

  // 设置里选了桥接 → 点运行直接走桥接分支（不再问一次）
  localStore.set('mindmap:runChannel', 'bridge')
  vm = makeVm()
  vm.buildDefaultJobPrompt = () => '任务内容'
  vm.prepareJobContainer = async () => ({ ok: false })
  await vm.runWorkbuddyJob()
  check(
    '按设置（桥接）点运行 → 直接走桥接分支',
    vm.jobChannel === 'bridge',
    vm.jobChannel
  )
  check('跑完通道选择不再残留弹窗态', vm.runChannelVisible === undefined)

  // 显式给通道仍然优先（内部调用 / 单测用）
  localStore.set('mindmap:runChannel', 'bridge')
  vm = makeVm()
  let explicitCalls = 0
  vm.runViaOpenclaw = async () => {
    explicitCalls += 1
  }
  await vm.runWorkbuddyJob({ channel: 'openclaw' })
  check('显式指定通道优先于设置', explicitCalls === 1 && vm.jobChannel === 'openclaw')

  // ---- 27. 助理通道：能并发（有上限）+ 按钮不锁死 + 落点不乱 ----
  // 2026-10-08 用户先反馈「运行按钮一直转圈、不能点第二个任务」→ 先做成排队；
  // 随后问「只能走队列吗 能走并发吗」→ 网关侧实测（不同 conversationId = 独立会话，
  // 并发 2 条总耗时 ≈ 较慢那条，不是两条之和）确认能真并行，于是改成：
  // 上限内直接并行，到上限（设置里配，默认 3）才入队，跑完自动补位。
  localStore.clear()
  openclawPlan.length = 0
  openclawHold.length = 0
  openclawStreamCalls.length = 0
  openclawWrites.length = 0

  // A) 上限内 → 直接并行两条
  vm = makeVm()
  vm.jobQueue = []
  vm.jobOpenclawRuns = {}
  vm.buildFollowUpJobPrompt = t => String(t)
  vm.writeJobResultToNode = async (job, options) => {
    openclawWrites.push(options.nodeUid)
  }
  check(
    '默认并行上限是 3',
    vm.openclawConcurrencyLimit() === 3,
    String(vm.openclawConcurrencyLimit())
  )
  check('没任务在跑时占用为 0', vm.openclawRunCount() === 0)
  check('jobBusyCount 只管桥接（不被助理占用）', vm.jobBusyCount() === 0)

  const ocBoxA = { ok: true, nodeUid: 'u-A', nodeTitle: '任务 · A' }
  const ocBoxB = { ok: true, nodeUid: 'u-B', nodeTitle: '任务 · B' }
  openclawPlan.push({ hold: true, content: '第一条的正文' })
  openclawPlan.push({ hold: true, content: '第二条的正文' })
  const runA = vm.startOpenclawRun({ prompt: '任务A', container: ocBoxA })
  const runB = vm.startOpenclawRun({ prompt: '任务B', container: ocBoxB })
  check(
    '上限内两条**同时**在跑（真并发，不进队列）',
    vm.openclawRunCount() === 2 && (vm.jobQueue || []).length === 0,
    JSON.stringify({ running: vm.openclawRunCount(), queued: (vm.jobQueue || []).length })
  )
  check(
    '每条用自己的 conversationId（网关靠它分会话）',
    new Set(openclawStreamCalls.map(c => c.conversationId)).size === 2,
    openclawStreamCalls.map(c => c.conversationId).join(',')
  )
  check('状态栏说清是并行几条', /并行 2 条/.test(vm.jobStatus), vm.jobStatus)

  openclawHold.forEach(fn => fn())
  await Promise.all([runA, runB])
  for (let i = 0; i < 40 && vm.openclawRunCount(); i++) {
    await new Promise(r => setTimeout(r, 5))
  }
  check('跑完名额清空', vm.openclawRunCount() === 0)
  check(
    '两条各自写回自己的任务容器（并发也不乱）',
    openclawWrites.slice().sort().join(',') === 'u-A,u-B',
    openclawWrites.join(',')
  )

  // B) 上限 = 1 → 退回排队；跑完自动补位
  localStore.set('mindmap:runConcurrency', '1')
  openclawPlan.length = 0
  openclawHold.length = 0
  openclawWrites.length = 0
  vm = makeVm()
  vm.jobQueue = []
  vm.jobOpenclawRuns = {}
  vm.buildFollowUpJobPrompt = t => String(t)
  vm.writeJobResultToNode = async (job, options) => {
    openclawWrites.push(options.nodeUid)
  }
  check('上限能配成 1', vm.openclawConcurrencyLimit() === 1)
  openclawPlan.push({ hold: true, content: 'A 的正文' })
  openclawPlan.push({ content: 'B 的正文' })
  const firstRun = vm.startOpenclawRun({ prompt: '任务A', container: ocBoxA })
  const secondCall = vm.runViaOpenclaw({
    options: { prompt: '任务B', container: ocBoxB }
  })
  check(
    '第二条点了就返回（按钮不再锁到跑完）',
    (await Promise.race([
      secondCall.then(() => 'returned'),
      new Promise(r => setTimeout(() => r('blocked'), 50))
    ])) === 'returned'
  )
  check(
    '到上限了 → 第二条入队（不硬挤）',
    (vm.jobQueue || []).length === 1 && vm.jobQueue[0].prompt === '任务B',
    JSON.stringify((vm.jobQueue || []).map(x => x.prompt))
  )
  check(
    '排队条目自己带着通道与落点（刷新/重排也不乱）',
    vm.jobQueue[0].channel === 'openclaw' &&
      vm.jobQueue[0].nodeUid === 'u-B' &&
      vm.jobQueue[0].container.nodeUid === 'u-B'
  )
  check('第二条只是排队，第一条照旧在跑', vm.openclawRunCount() === 1)

  openclawHold.shift()()
  await firstRun
  for (let i = 0; i < 40 && (vm.openclawRunCount() || (vm.jobQueue || []).length); i++) {
    await new Promise(r => setTimeout(r, 5))
  }
  check('第一条跑完自动补位（队列清空）', (vm.jobQueue || []).length === 0)
  check(
    '两条各自写回自己的任务容器（挂载不乱）',
    openclawWrites.slice().sort().join(',') === 'u-A,u-B',
    openclawWrites.join(',')
  )
  check('全跑完名额放开', vm.openclawRunCount() === 0)
  localStore.clear()

  // C) 写回要排队 —— 并发跑多条时两个结果同时回来，不能丢一个
  // （下游 writeJobResultToMap 里有 `if (this.jobWriteBusy) return` 全局锁）
  vm = makeVm()
  const writeOrder = []
  vm.writeJobResultOnce = async (job, options) => {
    writeOrder.push('start-' + options.nodeUid)
    await new Promise(r => setTimeout(r, 10))
    writeOrder.push('end-' + options.nodeUid)
  }
  await Promise.all([
    vm.writeJobResultToNode({ id: 'r1' }, { nodeUid: 'n1', markdown: 'a', force: true }),
    vm.writeJobResultToNode({ id: 'r2' }, { nodeUid: 'n2', markdown: 'b', force: true })
  ])
  check(
    '两个写回都执行了、而且不重叠（不丢）',
    writeOrder.join(',') === 'start-n1,end-n1,start-n2,end-n2',
    writeOrder.join(',')
  )

  // ---- 28. 运行历史：运行了就得有记录（2026-10-08 用户反馈「运行没有历史」）----
  // 原来历史只有桥接视角（去问执行主机的 WorkBuddy 有哪些任务）：
  //   ① 助理（WorkBuddy）通道是流式直连、没有派发/回执，网关照不到它 → 用它跑完一条都没有；
  //   ② 桥接没起来（本机就是 /bridge 502）时更是全空。
  // 现在本页面留一份运行日志（utils/runLog.js），历史 = 桥接的任务列表 + 这一份。
  localStore.clear()
  openclawPlan.length = 0
  openclawHold.length = 0
  openclawWrites.length = 0
  vm = makeVm()
  vm.jobQueue = []
  vm.jobOpenclawRuns = {}
  vm.jobHistory = []
  vm.jobHistoryVisible = false
  vm.buildFollowUpJobPrompt = t => String(t)
  vm.writeJobResultToNode = async (job, options) => {
    openclawWrites.push(options.nodeUid)
  }
  openclawPlan.push({ content: '助理这一次的正文' })
  await vm.runViaOpenclaw({
    options: {
      prompt: '任务·助理',
      container: { ok: true, nodeUid: 'u-oc', nodeTitle: '任务 · 助理' }
    }
  })
  // 起跑是后台跑（调用方不 await），等它跑完：记录要落成「已完成」
  for (let i = 0; i < 80 && vm.openclawRunCount(); i++) {
    await new Promise(r => setTimeout(r, 5))
  }
  const ocRows = runLogUtil.readRunRecords()
  check('助理跑完在本页面留了运行记录', ocRows.length === 1, JSON.stringify(ocRows.map(r => r.id)))
  check(
    '记录里状态是已完成、正文也在',
    ocRows[0] && ocRows[0].state === 'done' && ocRows[0].result === '助理这一次的正文',
    ocRows[0] && `${ocRows[0].state}/${ocRows[0].result}`
  )
  check(
    '记录标了通道与落点（历史里认得出是谁跑的）',
    ocRows[0] && ocRows[0].channel === 'openclaw' && ocRows[0].nodeTitle === '任务 · 助理',
    ocRows[0] && `${ocRows[0].channel}/${ocRows[0].nodeTitle}`
  )

  // 桥接不通（/bridge 502）→ 历史不该是空的，也不该报错
  gatewaysResult = { ok: false, error: '连不上桥接（/bridge 502）' }
  await vm.loadJobHistory()
  check(
    '桥接不通时助理那条照样在运行历史里',
    vm.jobHistory.length === 1 && vm.jobHistory[0].channel === 'openclaw',
    JSON.stringify(vm.jobHistory.map(x => x.channel))
  )
  check('有本地记录 → 不显示「拿不到运行记录」', vm.jobHistoryError === '', vm.jobHistoryError)
  check(
    '本地那条能看出「没有执行会话」（正文不靠桥接取）',
    vm.jobHistory[0].localOnly === true && vm.jobHistory[0].intent === '节点：任务 · 助理',
    JSON.stringify({ localOnly: vm.jobHistory[0].localOnly, intent: vm.jobHistory[0].intent })
  )

  // 桥接列表里出现了同一条 → 按 id 合并，以桥接为准；桥接没正文时用本地那份补
  const ocId = ocRows[0].id
  gatewaysResult = { ok: true, gateways: [{ url: 'http://127.0.0.1:8799' }] }
  jobsByGateway = {
    'http://127.0.0.1:8799': {
      ok: true,
      jobs: [
        {
          id: ocId,
          name: '桥接看到的这条',
          state: 'done',
          startedAt: Date.now(),
          updatedAt: Date.now()
        }
      ]
    }
  }
  await vm.loadJobHistory()
  check('同一条不会重复（按 id 合并）', vm.jobHistory.length === 1, String(vm.jobHistory.length))
  check(
    '以桥接那条为准（认它是执行会话里的任务）',
    vm.jobHistory[0].gateway === 'http://127.0.0.1:8799' && vm.jobHistory[0].localOnly === false,
    JSON.stringify({ gw: vm.jobHistory[0].gateway, localOnly: vm.jobHistory[0].localOnly })
  )
  check(
    '桥接没正文时用本地留的那份补上',
    vm.jobHistory[0].detail === '助理这一次的正文',
    String(vm.jobHistory[0].detail)
  )

  // 点开本地那条：正文就在记录里（刷新页面、桥接不通都还能看）
  localStore.clear()
  runLogUtil.saveRunRecord({
    id: 'oc-local',
    channel: 'openclaw',
    state: 'done',
    nodeTitle: '任务 · 本地',
    result: '本地留存的正文',
    startedAt: Date.now()
  })
  gatewaysResult = { ok: false, error: '桥接没起来' }
  jobsByGateway = {}
  await vm.loadJobHistory()
  await vm.openHistoryItem(vm.jobHistory[0])
  check('点开本地那条就能看到正文（不依赖桥接）', vm.jobFullText === '本地留存的正文', vm.jobFullText)
  check('本地那条不去查会话历史', vm.jobFullSource === 'local', vm.jobFullSource)

  // 刷新页面：助理是流式直连，刷新这条流就断了 → 别永远停在「执行中」
  localStore.clear()
  runLogUtil.saveRunRecord({ id: 'oc-run', channel: 'openclaw', state: 'working', nodeTitle: 'A' })
  runLogUtil.saveRunRecord({
    id: 'br-run',
    channel: 'bridge',
    state: 'working',
    nodeTitle: 'B',
    gateway: 'http://127.0.0.1:8799'
  })
  const swept = runLogUtil.markInterruptedRuns()
  check(
    '刷新后把助理那条标成已停止（不留假的「执行中」）',
    swept === 1 && runLogUtil.readRunRecords().find(r => r.id === 'oc-run').state === 'stopped',
    String(swept)
  )
  check(
    '桥接那条不动（任务在执行机上照跑，状态以桥接为准）',
    runLogUtil.readRunRecords().find(r => r.id === 'br-run').state === 'working'
  )

  // 列表小字标通道，分得清「这条是谁跑的」
  check(
    '列表小字带通道',
    /助理/.test(vm.jobMetaText({ channel: 'openclaw', startedAt: Date.now() })) &&
      /桥接/.test(vm.jobMetaText({ channel: 'bridge', startedAt: Date.now() })),
    vm.jobMetaText({ channel: 'openclaw', startedAt: Date.now() })
  )

  // 从历史里停助理那条：停的是本页面这条流（没有执行会话可停）
  vm = makeVm()
  let aborted = false
  vm.jobOpenclawRuns = {
    'oc-live': { runId: 'oc-live', abort: { abort: () => (aborted = true) } }
  }
  vm.loadJobHistory = async () => {}
  await vm.stopHistoryItem({ id: 'oc-live', channel: 'openclaw' })
  check('从运行历史里能停助理那条', aborted === true)

  // 收尾：把桩恢复成默认，免得影响别的用例
  gatewaysResult = { ok: true, gateways: [{ url: 'http://127.0.0.1:8799' }] }
  jobsByGateway = {}
  localStore.clear()

  // ---- 29. 「执行完毕没有回写」不能是静默的（2026-10-08 用户反馈）----
  // 真正跑完却没有回写，原来的写法是**静默 return**：界面上一个字都不说，
  // 用户只能看到「执行完毕」然后图上一片空白。现在每一条都要说出来。
  const emitted = []
  localStore.clear()
  vm = makeVm()
  vm.$bus = { $emit: name => emitted.push(name), $on: () => {}, $off: () => {} }
  vm.jobWriteError = ''
  vm.jobWriteBusy = true
  await vm.writeJobResultOnce(
    { id: 'w1' },
    { channel: 'openclaw', markdown: '正文', nodeUid: 'u1' }
  )
  check('写回撞上上一次还没结束 → 明说没写进去', /没有写进导图/.test(vm.jobWriteError), vm.jobWriteError)
  check('没写进去就不该发写回命令', emitted.length === 0, emitted.join(','))

  vm = makeVm()
  vm.jobWriteError = ''
  vm.jobHosts = []
  vm.jobHostKey = ''
  await vm.writeJobResultOnce(
    { id: 'w2' },
    { channel: 'bridge', markdown: '正文', nodeUid: 'u1', force: true }
  )
  check('桥接没有可用主机 → 明说结果取不回来', /执行主机/.test(vm.jobWriteError), vm.jobWriteError)

  vm = makeVm()
  vm.jobWriteError = ''
  await vm.writeJobResultOnce(
    { id: '' },
    { channel: 'bridge', markdown: '正文', nodeUid: 'u1', force: true }
  )
  check('没有任务号 → 明说', /任务号/.test(vm.jobWriteError), vm.jobWriteError)

  // runs 回退没给任务号：任务在执行机上照样跑完，但页面**没有东西可轮询** —— 结果永远回不来
  localStore.set('mindmap:runChannel', 'bridge')
  vm = makeVm()
  vm.$bus = { $emit: () => {}, $on: () => {}, $off: () => {} }
  vm.buildDefaultJobPrompt = () => '任务内容'
  // 「派到哪台机器/哪条会话」不是这条用例要测的 —— 直接给一个可用的目标
  vm.ensureDispatchTarget = async () => ({
    ok: true,
    host: HOST,
    gateway: 'http://127.0.0.1:8799'
  })
  vm.prepareJobContainer = async () => ({
    ok: true,
    nodeUid: 'u-r',
    nodeTitle: '任务 · R'
  })
  vm.jobWriteError = ''
  dispatchResult = { ok: true, job: {}, mode: 'runs' }
  await vm.runWorkbuddyJob()
  check(
    'runs 没给任务号 → 明说收不到结果、不会自动回写',
    /没返回任务号/.test(vm.jobWriteError),
    `${vm.jobWriteError} || status=${vm.jobStatus}`
  )
  check(
    '这种情况不该挂一条空 id 的待回写（挂上去会永远轮询不到）',
    (vm.jobPendingList || []).length === 0,
    JSON.stringify((vm.jobPendingList || []).map(x => x.id))
  )
  dispatchResult = { ok: true, job: { id: 'job-x' }, mode: 'jobs' }
  localStore.clear()

  // ---- 30. 助理通道的提示词不带「执行主机」的工作目录 ----
  // 助理跑在网关自己的 workspace 里；把桥接主机那条 Windows 路径塞进提示词，
  // 它会往一个根本不存在的目录写产物 → 页面上就是「产物没有挂上」（2026-10-08 反馈）。
  vm = makeVm()
  vm.jobGatewayCwd = 'D:\\执行主机的目录'
  const seenCwd = []
  vm.buildFollowUpJobPrompt = (text, node, runDir, cwd) => {
    seenCwd.push(cwd)
    return String(text || '内容')
  }
  vm.prepareJobContainer = async () => ({
    ok: true,
    nodeUid: 'u-oc',
    nodeTitle: '任务 · OC'
  })
  vm.writeJobResultToNode = async () => {}
  openclawPlan.length = 0
  openclawPlan.push({ content: '助理的正文' })
  await vm.runViaOpenclaw({ options: { prompt: '接着做' } })
  check(
    '助理通道传空 cwd（不带执行主机的路径）',
    seenCwd.length === 1 && seenCwd[0] === '',
    JSON.stringify(seenCwd)
  )
  // 桥接通道：不传 cwd 时仍用「执行主机的工作目录」（产物就落在那台机器上）
  vm = makeVm()
  vm.jobGatewayCwd = 'D:\\执行主机的目录'
  vm.$route = { query: { room: 'room-x' } }
  vm.activeNodes = [
    { isGeneralization: false, getData: k => (k === 'uid' ? 'u1' : '节点标题') }
  ]
  check(
    '桥接不传 cwd → 仍用执行主机的工作目录',
    vm.buildDefaultJobPrompt(null, '20261008-2032') ===
      'NODE:D:\\执行主机的目录|20261008-2032',
    vm.buildDefaultJobPrompt(null, '20261008-2032')
  )
  check(
    '显式传空 cwd → 提示词里不带主机路径（助理通道用）',
    vm.buildDefaultJobPrompt(null, '20261008-2032', '') === 'NODE:|20261008-2032',
    vm.buildDefaultJobPrompt(null, '20261008-2032', '')
  )

  // ---- 31. 「刷新就丢」的判据：写回之后要确认真的同步到服务器了 ----
  // 用户 2026-10-08：「强制刷新之后 只有任务跟任务内容了」—— 节点是先在**本机** Yjs 里
  // 插进去的，画布立刻看得见；没提交到协同服务的那些，刷新一 load 就没了。
  // 以前写回只检查本机树，所以离线/积压时照样报「完成」。
  console.log('--- 写回是否真的同步到服务器 ---')
  vm = makeVm()
  check('不在房间里 → 不判同步（单机版没有这个问题）', vm.collabSaveTrouble() === '', vm.collabSaveTrouble())
  vm.collabPhase = 'OFFLINE'
  check('协同离线 → offline', vm.collabSaveTrouble() === 'offline', vm.collabSaveTrouble())
  vm = makeVm()
  vm.collabSaveState = 'error'
  check('协同报错 → failed', vm.collabSaveTrouble() === 'failed', vm.collabSaveTrouble())
  vm = makeVm()
  vm.collabPhase = 'LIVE'
  vm.collabPendingCount = 3
  check('还有 3 条没上去 → pending', vm.collabSaveTrouble() === 'pending', vm.collabSaveTrouble())
  vm = makeVm()
  vm.collabPhase = 'LIVE'
  vm.collabSaveState = 'saved'
  check('已保存 → 没问题', vm.collabSaveTrouble() === '', vm.collabSaveTrouble())

  // 写回结束但协同离线：不能说「完成」，要说清「只在本机、刷新就丢、怎么补」
  vm = makeVm()
  vm.$route = { query: { room: 'room-x' } }
  vm.collabPhase = 'OFFLINE'
  // 不等真实的重试窗口（否则这条用例要跑十几秒）
  vm.waitForCollabSaved = async () => false
  vm.$bus.$emit = (name, payload) => {
    if (name !== 'write_job_result' || !payload || !payload.result) return
    payload.result.promise = Promise.resolve({
      ok: true,
      nodes: 2,
      inlineNodes: false,
      attachments: [{ name: '完整输出.md', kind: 'text', via: 'collab' }],
      warnings: [],
      missing: []
    })
  }
  vm.messages.length = 0
  await vm.writeJobResultOnce(
    { id: 'w-sync' },
    { channel: 'openclaw', markdown: '正文', nodeUid: 'u-sync', force: true }
  )
  check(
    '写回后没同步上去 → 明说「还没同步到服务器、刷新就没了」',
    /还没同步到服务器/.test(vm.jobWriteError) && /刷新就没了/.test(vm.jobWriteError),
    vm.jobWriteError
  )
  check(
    '这种情况下**不能**报成功',
    !vm.messages.some(([kind]) => kind === 'success'),
    JSON.stringify(vm.messages)
  )
  check(
    '运行记录标成「未同步」（历史里能看见、能补写）',
    runLogUtil.readRunRecords().find(r => r.id === 'w-sync').synced === false,
    JSON.stringify(runLogUtil.readRunRecords().find(r => r.id === 'w-sync') || {})
  )
  check(
    '历史条目小字带「未同步」标记',
    /未同步到服务器/.test(vm.jobMetaText({ id: 'w-sync', synced: false, startedAt: Date.now() })),
    vm.jobMetaText({ id: 'w-sync', synced: false, startedAt: Date.now() })
  )

  // 同步没问题时照旧报成功
  vm = makeVm()
  vm.$route = { query: { room: 'room-x' } }
  vm.collabPhase = 'LIVE'
  vm.collabSaveState = 'saved'
  vm.$bus.$emit = (name, payload) => {
    if (name !== 'write_job_result' || !payload || !payload.result) return
    payload.result.promise = Promise.resolve({
      ok: true,
      nodes: 2,
      inlineNodes: false,
      attachments: [{ name: '完整输出.md', kind: 'text', via: 'collab' }],
      warnings: [],
      missing: []
    })
  }
  vm.messages.length = 0
  await vm.writeJobResultOnce(
    { id: 'w-ok' },
    { channel: 'openclaw', markdown: '正文', nodeUid: 'u-ok', force: true }
  )
  check(
    '同步正常 → 报成功、没有告警',
    vm.messages.some(([kind]) => kind === 'success') && !vm.jobWriteError,
    JSON.stringify([vm.messages, vm.jobWriteError])
  )

  // ---- 32. 刷新后「写入导图」补写：产物按 runDir 重新捞回来 ----
  console.log('--- 补写：正文 + 产物一起补 ---')
  vm = makeVm()
  const scanned = []
  const wrote = []
  vm.fetchOpenclawArtifacts = async (since, dir) => {
    scanned.push([since, dir])
    return [{ name: 'output/对公司的建议.md', size: 20, mime: 'text/markdown', base64: 'YQ==' }]
  }
  vm.fetchJobText = async () => '这是一次运行留下的正文'
  vm.writeJobResultToNode = async (job, options) => {
    wrote.push(options)
  }
  vm.jobHistory = [
    {
      id: 'oc-old',
      channel: 'openclaw',
      state: 'done',
      runDir: '20261008-2031',
      nodeUid: 'u-container',
      localOnly: true
    }
  ]
  vm.jobActiveId = 'oc-old'
  await vm.rewriteActiveJob()
  check(
    '补写时按记录里的 runDir 重新捞产物',
    scanned.length === 1 && scanned[0][1] === '20261008-2031',
    JSON.stringify(scanned)
  )
  check(
    '产物一起传下去（补写不是只补正文）',
    wrote.length === 1 && (wrote[0].artifacts || []).length === 1,
    JSON.stringify(wrote.map(w => (w.artifacts || []).map(a => a.name)))
  )
  check(
    '落点用记录里那个任务容器，不用用户现选',
    wrote[0].nodeUid === 'u-container',
    JSON.stringify(wrote[0].nodeUid)
  )

  check(
    'recordToHistoryItem 透出 runDir / 产物名（刷新后才有得补）',
    (() => {
      const item = runLogUtil.recordToHistoryItem({
        id: 'x',
        runDir: '20261008-2031',
        artifactNames: ['a.md']
      })
      return item.runDir === '20261008-2031' && item.artifactNames[0] === 'a.md'
    })(),
    ''
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
