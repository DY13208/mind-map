/**
 * 概要子树「节点变空」回归测试。
 *
 * 现场证据（room-a7rjjy5s 的 room_operations）：
 *   v259 插入子节点 text="分支主题"
 *   v260/v261 用户输入 text="<p>分支12主题</p>"
 *   v262/v263 text=""            ← 输入内容被清成空
 *   v264 text="" + 又插了一个子节点
 * 空文本节点渲染成零尺寸，看起来就是「概要后面的节点直接空了」。
 *
 * 两个修复点：
 * ① createGeneralizationNode 每次都 child.remove() + 重建整棵概要子树。
 *    openRealtimeRenderOnNodeTextEdit 开着时，每次输入都会整树重排，
 *    正在编辑的节点被拆掉，编辑框内容随之丢失。改为按结构签名复用：
 *    结构没变就不拆建。
 * ② 编辑框被重置导致的「假空」不得覆盖节点原有文本。用户真的删空会触发
 *    input / text-change，这条保护不会拦住正常清空。
 */
const fs = require('fs')
const path = require('path')

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`)
}

const ROOT = path.join(__dirname, '../../simple-mind-map/src')
const genFile = path.join(ROOT, 'core/render/node/nodeGeneralization.js')
const genSrc = fs.readFileSync(genFile, 'utf8')

// ---- 1. 结构签名：结构不变时签名相同 ----
function extract(src, name) {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) return null
  let i = src.indexOf('{', start)
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return null
}

const sigSrc = extract(genSrc, 'generalizationStructureSignature')
check('定义了 generalizationStructureSignature', !!sigSrc)

const generalizationStructureSignature = new Function(`${sigSrc}; return generalizationStructureSignature`)()

const item = {
  uid: 'g1',
  range: null,
  children: [
    {
      data: { uid: 'c1', text: '<p>分支12主题</p>', expand: true },
      children: [{ data: { uid: 'c2', text: '分支主题', expand: true }, children: [] }]
    }
  ]
}

check(
  '只改文字 → 结构签名不变（因此不触发拆建）',
  generalizationStructureSignature(item) ===
    generalizationStructureSignature(JSON.parse(JSON.stringify(item)))
)

const added = JSON.parse(JSON.stringify(item))
added.children[0].children.push({ data: { uid: 'c3', text: '', expand: true }, children: [] })
check(
  '加了一个子节点 → 结构签名变化（必须重建）',
  generalizationStructureSignature(item) !== generalizationStructureSignature(added)
)

const collapsed = JSON.parse(JSON.stringify(item))
collapsed.children[0].data.expand = false
check(
  '展开态变化 → 结构签名变化（必须重建）',
  generalizationStructureSignature(item) !== generalizationStructureSignature(collapsed)
)

const reranged = JSON.parse(JSON.stringify(item))
reranged.range = [0, 1]
check(
  '概要范围变化 → 结构签名变化（必须重建）',
  generalizationStructureSignature(item) !== generalizationStructureSignature(reranged)
)

const renamed = JSON.parse(JSON.stringify(item))
renamed.children[0].children[0].data.text = '改过了'
check(
  '深层节点只改文字 → 结构签名不变',
  generalizationStructureSignature(item) === generalizationStructureSignature(renamed)
)

check('空 children 不炸', typeof generalizationStructureSignature({ uid: 'x' }) === 'string')

// ---- 2. createGeneralizationNode 里确实走了复用分支 ----
check(
  'createGeneralizationNode 有结构复用判定',
  /const reusable =/.test(genSrc) && /cur\.structureSig === structureSig/.test(genSrc)
)
check(
  '复用分支不调用 createGeneralizationChildNodes',
  // 复用分支里会先补量尺寸再算高度，代码段较长，这里只校验「reusable 分支内
  // 没有重建、重建只发生在 else 分支」这一结构。
  (() => {
    const start = genSrc.indexOf('if (reusable) {')
    const elseIdx = genSrc.indexOf('} else {', start)
    if (start < 0 || elseIdx < 0) return false
    const reusableBlock = genSrc.slice(start, elseIdx)
    const elseBlock = genSrc.slice(elseIdx, elseIdx + 200)
    return (
      !reusableBlock.includes('layout.createGeneralizationChildNodes') &&
      elseBlock.includes('layout.createGeneralizationChildNodes')
    )
  })()
)
check(
  '数组对象换了（远端快照替换）时强制重建',
  /cur\.childrenRef === item\.children/.test(genSrc)
)
check(
  '复用分支重算了 childrenAreaHeight',
  (() => {
    const start = genSrc.indexOf('if (reusable) {')
    const elseIdx = genSrc.indexOf('} else {', start)
    if (start < 0 || elseIdx < 0) return false
    return genSrc.slice(start, elseIdx).includes('childrenAreaHeight')
  })()
)

// ---- 3. 假空保护 ----
const richSrc = fs.readFileSync(path.join(ROOT, 'plugins/RichText.js'), 'utf8')
const textSrc = fs.readFileSync(path.join(ROOT, 'core/render/TextEdit.js'), 'utf8')

check(
  'RichText: 初始化编辑框后重置 touched 标记',
  /this\.initQuillEditor\(\)[\s\S]{0,220}this\._editTextTouched = false/.test(richSrc)
)
check(
  'RichText: text-change 里置 touched',
  /this\.quill\.on\('text-change', \(\) => \{\s*this\._editTextTouched = true/.test(richSrc)
)
check(
  'RichText: 提交时假空回退到节点原文本',
  /if \(!html && !this\._editTextTouched && node && node\.getData\)/.test(richSrc)
)

check(
  'TextEdit: 显示编辑框后重置 touched 标记',
  /this\.beginEditSession\(node, isFromScale\)/.test(textSrc) &&
    /this\._editTextTouched = false/.test(textSrc)
)
check(
  'TextEdit: input 事件里置 touched',
  /addEventListener\('input', \(\) => \{\s*this\._editTextTouched = true/.test(textSrc)
)
check(
  'TextEdit: 提交时假空回退到节点原文本',
  /if \(!text && !this\._editTextTouched && currentNode && currentNode\.getData\)/.test(textSrc)
)

// 正常清空仍然能提交：touched=true 时不回退
{
  const node = { getData: () => '原来的字' }
  const fallback = (text, touched) => {
    let out = text
    if (!out && !touched && node && node.getData) {
      const committed = node.getData('text')
      if (committed) out = committed
    }
    return out
  }
  check('用户真删空（touched=true）→ 允许提交空', fallback('', true) === '')
  check('假空（touched=false）→ 保留原文本', fallback('', false) === '原来的字')
  check('有内容时不受影响', fallback('新内容', false) === '新内容')
}

const failed = results.filter(r => !r.ok)
console.log(failed.length ? `\n${failed.length} FAILED` : '\nall ok')
process.exit(failed.length ? 1 : 0)
