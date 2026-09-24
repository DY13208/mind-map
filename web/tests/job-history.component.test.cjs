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

// ---- 可编程的桥接 stub ----
const jobResponses = [] // 每次 listHostJobs 消费一个
const calls = { list: 0, stop: [] }
let stopResult = { ok: true }
const bridgeStub = {
  resolveJobHosts: async () => ({ hosts: [], defaultHost: null }),
  listHostGateways: async () => ({ ok: true, gateways: [] }),
  listHostJobs: async () => {
    calls.list += 1
    if (!jobResponses.length) return { ok: true, jobs: [] }
    const next = jobResponses.shift()
    if (next instanceof Error) throw next
    return next
  },
  stopHostJob: async args => {
    calls.stop.push(args)
    return stopResult
  },
  fetchJobTranscript: async () => ({ ok: true, text: '' }),
  fetchJobArtifacts: async () => ({ ok: true, files: [] }),
  attachFilesViaBridge: async () => ({ ok: false }),
  describeEmptyGateways: () => '',
  dispatchWorkbuddyJob: async () => ({ ok: true, job: { id: 'job-x' } })
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
  if (name === '@/utils/mindmapRunPrompt') return {}
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
    jobPending: null,
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
  vm.jobPending = { id: 'job-lost', nodeUid: 'n-1', nodeTitle: 'x' }
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
  check('到上限后清掉 pending', vm.jobPending === null)
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
  vm.jobPending = { id: 'job-lost' }
  for (let i = 0; i < 26; i += 1) {
    jobResponses.push({ ok: false, error: '连不上 192.168.1.114:8799' })
    await vm.pollJob()
  }
  check(
    '连不上时把连接错误带进提示',
    /连不上 192.168.1.114:8799/.test(vm.jobWriteError) && vm.jobPending === null,
    vm.jobWriteError
  )

  // ---- 10. 中途查到了：计数清零，照常写回 ----
  jobResponses.length = 0
  vm = makeVm()
  vm.jobPollTimer = 8
  vm.jobPending = { id: 'job-x', nodeUid: 'n-1', nodeTitle: 'x' }
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
