/* eslint-env node */
/**
 * 「运行输出」下面只要完整输出 + 附件 —— 2026-09-29 用户要求。
 *
 * 以前 markdownToNodes() 会把回答**提炼**成：
 *   一句话结论 / 关键要点 / ❗待补充数据 / 产出 / （另有 N 条细节，见附件）
 * 现在改成 markdownToFullNodes()：按章节原样铺开，不提炼、不丢弃，
 * 超长的单条把原文放进 note（节点上截断显示，点开看全）。
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
  new Function('require', 'module', 'exports', code)(
    name => {
      if (name === './nodeAttachmentApi') {
        return { uploadNodeAttachment: async () => ({}) }
      }
      if (name === './flowExpandPrompt') {
        return { nodeUid: n => (n && n.getData('uid')) || '' }
      }
      return {}
    },
    mod,
    mod.exports
  )
  return mod.exports
}

const writer = loadCjs(path.join(WEB, 'src/utils/jobResultWriter.js'))

const MD = [
  '## 一句话结论',
  '他是打辅助的十年老玩家。',
  '',
  '## 关键要点',
  '- 第一条要点',
  '- 第二条要点',
  '- 第三条要点',
  '',
  '## 待补充数据',
  '- 游戏账号 ID —— 要找运营拿',
  '',
  '## 产出',
  '- output/好朋友-人设-2026-09-29.md'
].join('\n')

const texts = nodes => (nodes || []).map(n => (n.data && n.data.text) || '')

console.log('--- 完整展开：章节一条不落 ---')
const full = writer.markdownToFullNodes(MD)
const titles = texts(full.children)
check('4 个章节全部保留', titles.length === 4, JSON.stringify(titles))
check('保留了「待补充数据」（不再单独挪走）', titles.includes('待补充数据'))
check('保留了「产出」', titles.includes('产出'))
const deliver = full.children.find(n => n.data.text === '产出')
check(
  '「产出」下面是文件名',
  deliver && texts(deliver.children)[0] === 'output/好朋友-人设-2026-09-29.md',
  JSON.stringify(deliver && texts(deliver.children))
)
const points = full.children.find(n => n.data.text === '关键要点')
check(
  '要点三条都在（提炼版会被限量）',
  points && texts(points.children).length === 3,
  JSON.stringify(points && texts(points.children))
)
check(
  '不再有「另有 N 条细节」这种省略',
  !titles.some(t => /另有\s*\d+\s*条/.test(t)),
  JSON.stringify(titles)
)

console.log('--- 对比：旧的提炼版确实会丢东西 ---')
const lean = writer.markdownToNodes(MD)
check(
  '旧提炼版节点数更少（说明确实被压缩过）',
  (lean.children || []).length <= (full.children || []).length,
  `${(lean.children || []).length} vs ${(full.children || []).length}`
)

console.log('--- 超长条目：显示截断但原文进 note ---')
const longLine = '很长的内容'.repeat(60)
const longMd = ['## 正文', '- ' + longLine].join('\n')
const longTree = writer.markdownToFullNodes(longMd)
const longItem = longTree.children[0] && longTree.children[0].children[0]
check('超长条目的 note 存了完整原文', !!longItem && longItem.data.note === longLine)
check(
  '节点显示文本被截断（比原文短）',
  !!longItem && longItem.data.text.length < longLine.length,
  longItem ? String(longItem.data.text.length) : '-'
)

console.log('--- 没有标题的段落直接铺开 ---')
const loose = writer.markdownToFullNodes('开场白一句话\n\n另外一句')
check(
  '无标题段落原样成为节点',
  texts(loose.children).length === 2,
  JSON.stringify(texts(loose.children))
)

console.log('--- 空输入不炸 ---')
const empty = writer.markdownToFullNodes('   ')
check('空内容返回空树', (empty.children || []).length === 0)

const failed = results.filter(item => !item.ok)
console.log(
  `\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`
)
if (failed.length) {
  failed.forEach(item => console.log('  FAIL:', item.name))
  process.exit(1)
}
