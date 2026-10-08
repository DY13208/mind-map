/* eslint-env node */
/**
 * 派发提示词组装单测。
 *
 * 需求（2026-09-28）：每次执行都带上「【调用CPD 方法论指导专家】」——
 * **该需求已于 2026-09-29 由用户取消**（实测副作用：Agent 为了"调用这个专家"
 * 去翻插件目录找 cpd-guide，白耗十几轮工具调用），现在断言**不再出现**这句。
 * 脑图上的派发有三个出口，行为要一致：
 *
 *   1. 按节点「运行」          → buildNodeRunPrompt
 *   2. 点概要/继续执行          → buildFollowUpPrompt
 *   3. 没选中节点时的兜底文案    → Toolbar.buildDefaultJobPrompt / buildFollowUpJobPrompt
 *
 * 做法照 web/tests/job-hub.test.cjs：babel 转 CJS 后直接加载源码。
 */
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')

const WEB = path.join(__dirname, '..')
const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`)
}

function loadCjs(file) {
  const src = fs.readFileSync(file, 'utf8')
  const { code } = babel.transformSync(src, {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  })
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', code)(require, mod, mod.exports)
  return mod.exports
}

const prompt = loadCjs(path.join(WEB, 'src/utils/mindmapRunPrompt.js'))
const {
  CPD_ADVISOR_LINE,
  withCpdAdvisor,
  buildNodeRunPrompt,
  buildFollowUpPrompt
} = prompt

// 已取消的那句话：保留下来专门用于断言「不再出现」
const LINE = '【调用CPD 方法论指导专家】'

// ---- 极简脑图节点 mock（只满足提示词组装用到的取值） ----
function mkNode(text, children = [], extra = {}) {
  const data = Object.assign({ text }, extra)
  const node = {
    isRoot: false,
    parent: null,
    children: [],
    getData: k => (k === undefined ? data : data[k]),
    setData: patch => Object.assign(data, patch)
  }
  node.children = children
  children.forEach(child => {
    child.parent = node
  })
  return node
}

const root = mkNode('脑图根节点')
const current = mkNode('春天短文', [mkNode('写一篇 52 字的春天短文')])
root.children = [current]
current.parent = root
root.isRoot = true

console.log('--- 常量与包装函数 ---')
check('固定抬头已取消（常量置空）', CPD_ADVISOR_LINE === '', CPD_ADVISOR_LINE)
check('空提示词还是空（不再塞抬头）', withCpdAdvisor('') === '')
check('null 也不炸', withCpdAdvisor(null) === '')
check('普通提示词原样返回（不再加抬头）', withCpdAdvisor('正文') === '正文')
check(
  '重复包也不变（幂等）',
  withCpdAdvisor(withCpdAdvisor('正文')) === '正文'
)

console.log('--- 按节点运行 ---')
const runPrompt = buildNodeRunPrompt({ node: current, room: 'room-1', cwd: '/tmp/wd' })
const runLines = runPrompt.split('\n')
check('第一行不再是固定抬头', runLines[0] !== LINE, runLines[0])
check('整条提示词里不再出现这句话', !runPrompt.includes(LINE))
check('原有内容没被顶掉', runPrompt.includes('【脑图流程的一步'))
check('保留节点名', runPrompt.includes('节点：春天短文'))
check('保留这一步的要求', runPrompt.includes('写一篇 52 字的春天短文'))
check('保留房间号', runPrompt.includes('房间：room-1'))
check(
  '要求「一次做完、不要停下来征求同意」',
  /一次做完/.test(runPrompt) &&
    /要我继续吗/.test(runPrompt) &&
    /写回目标系统/.test(runPrompt)
)
// 2026-09-29 实测：提示词只写「把结果写回目标系统」时，Agent 会去翻 cpd 插件目录、
// 找 mmclient、自己造脚本调 MCP —— 一个 10+10 的任务走了 41 次工具调用、好几分钟。
// 2026-10-08 用户要求**反转这条**：产物要用 MCP 的 upload_attachment 挂回节点
// （光把文字放回答里不够，人得能点开产物文件）。
// 但「翻插件目录找路 / 自己写脚本调接口」这种白耗仍然禁止。
check(
  '要求用 MCP 把本次新增的产物挂回节点（upload_attachment）',
  /upload_attachment/.test(runPrompt) &&
    /room_key/.test(runPrompt) &&
    /新增的产物/.test(runPrompt)
)
check(
  '明确禁止用 note / text 写文件路径冒充附件',
  /冒充附件/.test(runPrompt)
)
// 2026-10-08 现场：Agent 写文件被权限拒绝，就「改以下方正文呈现」——产物直接没有文件。
// 所以必须写明兜底：写不出来就走 MCP 把内容送上去，绝不允许只在回答里贴正文。
check(
  '写文件被拒要有兜底路径（add_node / content_base64），不许只在回答里贴正文',
  /写文件被拒/.test(runPrompt) &&
    /content_base64/.test(runPrompt) &&
    /add_node/.test(runPrompt) &&
    /绝不能因为写不出文件/.test(runPrompt)
)

console.log('--- 继续执行 ---')
const followPrompt = buildFollowUpPrompt('接着上次往下写', {
  node: current,
  room: 'room-1',
  cwd: '/tmp/wd'
})
const followLines = followPrompt.split('\n')
check(
  '继续执行也要求用 MCP 挂产物（不能只说「页面会自动写回」）',
  /upload_attachment/.test(followPrompt) && /room_key/.test(followPrompt)
)
check(
  '继续执行也禁止用 note / text 冒充附件',
  /冒充附件/.test(followPrompt)
)
check('继续执行也不再有固定抬头', followLines[0] !== LINE, followLines[0])
check('继续执行里也不再出现这句话', !followPrompt.includes(LINE))
check('用户输入的正文还在最前', followPrompt.includes('接着上次往下写'))
check('背景块还在', followPrompt.includes('【背景 · 脑图当前节点】'))
check(
  '继续执行也要求一次做完、不要停在征求同意',
  /一次做完/.test(followPrompt) && /征求同意结尾/.test(followPrompt)
)

console.log('--- Toolbar 的两个兜底出口 ---')
const toolbar = fs.readFileSync(
  path.join(WEB, 'src/pages/Edit/components/Toolbar.vue'),
  'utf8'
)
check(
  'import 了 withCpdAdvisor',
  /import\s*\{[\s\S]{0,120}withCpdAdvisor[\s\S]{0,40}\}\s*from\s*'@\/utils\/mindmapRunPrompt'/.test(
    toolbar
  )
)
check(
  '没选中节点的兜底带上抬头',
  /if\s*\(!selected\)\s*\{\s*return withCpdAdvisor\(/.test(toolbar)
)
check(
  '继续执行没节点时也带上',
  /if\s*\(!node\)\s*return withCpdAdvisor\(text\)/.test(toolbar)
)
check(
  '兜底提示词不再直接 return 裸字符串',
  !/if\s*\(!selected\)\s*\{\s*return room\s*\?/.test(toolbar)
)

// ---- 新结构（2026-10-08）：附件直接挂任务容器下，正文在「完整输出.md」的 note 里 ----
// 结构从「任务 → 运行输出 → 附件」压成「任务 → 附件 → 完整输出|产物」后，
// 「继续执行」取上次正文的那几条路径必须跟着兼容，否则会读不到东西。
// （复用文件开头那个 mkNode）
const newAttach = mkNode('附件', [
  mkNode('output/作文-10-08.md'),
  mkNode('完整输出.md', [], { note: '上一次运行的完整正文' })
])
const newContainer = mkNode('任务 · 10-08 15:00', [
  mkNode('任务内容：写个作文'),
  newAttach
])
const newD = mkNode('D：写作文', [newContainer])

const newSelf = prompt.latestSelfResult(newD)
check(
  '新结构：能取到上次正文（来自「完整输出.md」的 note）',
  !!newSelf && String(newSelf.text).includes('上一次运行的完整正文'),
  JSON.stringify(newSelf)
)

const cur = mkNode('当前节点')
const rows = prompt.collectPriorResults([newD, cur])
check(
  '新结构：上游结果里列出了附件里的产物',
  rows.length === 1 && rows[0].files.includes('output/作文-10-08.md'),
  JSON.stringify(rows)
)
check(
  '「完整输出.md」不算产物文件',
  rows.length === 1 && !rows[0].files.includes('完整输出.md'),
  JSON.stringify(rows[0] && rows[0].files)
)
check(
  '新结构：没有「待补充数据」分支时返回空数组',
  prompt.latestMissingData(newD).length === 0
)

// 旧结构必须继续能读（历史上写进去的任务还在图上）
const legacyResult = mkNode('运行输出 · 10-08 09:00', [
  mkNode('一句话结论'),
  mkNode('关键要点')
])
const legacyContainer = mkNode('任务 · 10-08 09:00', [legacyResult])
const legacyD = mkNode('D：老结构', [legacyContainer])
const legacySelf = prompt.latestSelfResult(legacyD)
check(
  '旧结构（运行输出节点）仍能取到正文 —— 兼容不能丢',
  !!legacySelf && String(legacySelf.text).includes('一句话结论'),
  JSON.stringify(legacySelf)
)

// ---- 本次运行的专属产物目录 + 「完整输出只含本次」（2026-10-08 用户要求）----
// 用户原话：「完整输出不要包含之前的 只要这一次运行的东西相关的挂载回节点
// 不要乱不要多不要少」。
// 做法：助理通道给一个专属目录 output/<runDir>/，产物只能写这里，页面只按它挂附件；
// 同时**不让 Agent 自己再挂一遍**（两条路一起走会重复挂 / 挂错节点）。
console.log('--- 产物目录与「只含本次」---')
const jobNode = mkNode('D：写个作文')
const withDir = buildNodeRunPrompt({
  node: jobNode,
  room: 'room-test',
  cwd: 'D:\\良策0010',
  runDir: '20261008-1832'
})
check(
  '给了 runDir → 产物写死到 output/<runDir>/',
  withDir.includes('output/20261008-1832/'),
  ''
)
check(
  '给了 runDir → 明确不许写到 output 根目录 / 覆盖旧产物',
  /不要写到 output 根目录/.test(withDir) &&
    /不要覆盖或改动以前跑出来的文件/.test(withDir)
)
check(
  '给了 runDir → 不让 Agent 自己再挂一遍（否则重复/挂错节点）',
  /不要自己再调 MCP/.test(withDir) &&
    /挂一遍/.test(withDir) &&
    !/用 MCP 工具 `upload_attachment` 挂到当前节点/.test(withDir)
)
check(
  '写文件被拒时的 MCP 兜底仍在（别删）',
  /content_base64/.test(withDir) && /add_node/.test(withDir)
)
check(
  '完整输出只含本次：明确禁止复述上次 / 前序结果',
  /里面只能有本次运行的内容/.test(withDir) && /不要复述/.test(withDir)
)

const noDir = buildNodeRunPrompt({
  node: jobNode,
  room: 'room-test',
  cwd: 'D:\\良策0010'
})
check(
  '没给 runDir（桥接通道）→ 不写死目录、照旧要求 MCP 挂附件',
  !/output\/2026/.test(noDir) &&
    /用 MCP 工具 `upload_attachment` 挂到当前节点/.test(noDir)
)
check('没给 runDir 也一样要求「只含本次」', /里面只能有本次运行的内容/.test(noDir))

const fu = buildFollowUpPrompt('继续做第二步', {
  node: jobNode,
  room: 'room-test',
  cwd: 'D:\\良策0010',
  runDir: '20261008-1832'
})
check(
  '继续执行也带 runDir',
  fu.includes('output/20261008-1832/')
)
check(
  '继续执行也要求「只含本次」+ 写不出文件时用 MCP 兜底',
  /里面只能有本次运行的内容/.test(fu) &&
    /content_base64/.test(fu) &&
    /add_node/.test(fu)
)

// 助理通道不给 cwd（助理跑在自己的 workspace 里，不能把执行主机的 Windows 路径塞给它）
const assistantDir = buildNodeRunPrompt({
  node: jobNode,
  room: 'room-test',
  cwd: '',
  runDir: '20261008-2032'
})
check(
  '助理不给 cwd → 说「当前的工作目录」，并禁止用别的机器的绝对路径',
  /当前的工作目录/.test(assistantDir) &&
    /别用别的机器上的绝对路径/.test(assistantDir),
  ''
)

const failed = results.filter(item => !item.ok)
console.log(
  `\n共 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`
)
if (failed.length) {
  failed.forEach(item => console.log('  FAIL:', item.name))
  process.exit(1)
}
