/* eslint-env node */
/**
 * 派发提示词固定抬头单测。
 *
 * 需求（2026-09-28）：**每次执行都带上一句**「【调用CPD 方法论指导专家】」，
 * 原样放在提示词开头。脑图上的派发有三个出口，全都必须带上：
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
check('常量就是用户要的那句话', CPD_ADVISOR_LINE === LINE, CPD_ADVISOR_LINE)
check('空提示词只回车固定抬头', withCpdAdvisor('') === LINE)
check('null 也不炸', withCpdAdvisor(null) === LINE)
check(
  '普通提示词 → 抬头换行接原文',
  withCpdAdvisor('正文') === LINE + '\n正文'
)
check(
  '已经带过就不重复加（幂等）',
  withCpdAdvisor(LINE + '\n正文') === LINE + '\n正文' &&
    withCpdAdvisor(withCpdAdvisor('正文')) === LINE + '\n正文'
)

console.log('--- 按节点运行 ---')
const runPrompt = buildNodeRunPrompt({ node: current, room: 'room-1', cwd: '/tmp/wd' })
const runLines = runPrompt.split('\n')
check('第一行是固定抬头', runLines[0] === LINE, runLines[0])
check('只出现一次', runPrompt.split(LINE).length - 1 === 1)
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
// 所以必须明说「脑图由页面自动写回，你别动手」。
check(
  '明确「脑图本身不用你写回」（否则 Agent 会白耗几十轮工具调用）',
  /脑图本身不用你写回/.test(runPrompt) && /MCP/.test(runPrompt)
)

console.log('--- 继续执行 ---')
const followPrompt = buildFollowUpPrompt('接着上次往下写', {
  node: current,
  room: 'room-1',
  cwd: '/tmp/wd'
})
const followLines = followPrompt.split('\n')
check('第一行也是固定抬头', followLines[0] === LINE, followLines[0])
check('只出现一次', followPrompt.split(LINE).length - 1 === 1)
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

const failed = results.filter(item => !item.ok)
console.log(
  `\n共 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`
)
if (failed.length) {
  failed.forEach(item => console.log('  FAIL:', item.name))
  process.exit(1)
}
