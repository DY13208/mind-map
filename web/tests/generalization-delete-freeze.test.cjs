/**
 * 「概要后面的节点点删除会卡死」回归测试。
 *
 * 现象：选中概要子树里的节点按删除 → 页面卡住（画布不再更新，操作无响应）。
 *
 * 链条（三处，前两处是本 bug 的直接成因，第三处是卡死的放大器）：
 *
 * ① removeNode / removeCurrentNode 删除普通节点时，只调 removeFromParentNodeData
 *    改 nodeData.children，**实例数组 parent.children 没有同步**，被删节点仍留在
 *    里面。
 * ② 紧接着 getNextActiveNode 用 getNodeIndexInNodeList 在该数组里找刚删的节点：
 *      nodeIndex === -1
 *      if (nodeIndex < broList.length - 1)  // -1 < n-1 恒真
 *        needActiveNode = broList[nodeIndex + 1]  // = broList[0]
 *    于是把一个**不该激活**的节点（可能是已删实例）重新 addNodeToActiveList。
 *    后续渲染去画它，而它的 SVG group 可能已移除 → 渲染抛错。
 * ③ 渲染抛错后 isRendering 永不复位（各 layout 的 doLayout 在出错时不回调），
 *    协作层在 while(true) 里等 waitV2RendererReady（要求 !isRendering）→ 死转。
 *
 * 修复：①② 同步实例数组 + 索引 -1 时退回父节点；③ 布局失败释放渲染状态 +
 * 远端等待加硬边界。
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`)
}

const ROOT = path.join(__dirname, '../../simple-mind-map/src')
const renderSrc = fs.readFileSync(path.join(ROOT, 'core/render/Render.js'), 'utf8')
const coopSrc = fs.readFileSync(path.join(ROOT, 'plugins/Cooperate.js'), 'utf8')
const utilsSrc = fs.readFileSync(path.join(ROOT, 'utils/index.js'), 'utf8')

function extractMethod(src, name) {
  const start = src.indexOf(`  ${name}(`)
  if (start < 0) return null
  let i = src.indexOf(') {', start)
  if (i < 0) return null
  i += 2
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return `function ${name}${src.slice(src.indexOf('(', start), i + 1)}`
    }
  }
  return null
}

// ---- 1. 抽出真实的 getNextActiveNode 验证索引 -1 的行为 ----
const nextSrc = extractMethod(renderSrc, 'getNextActiveNode')
const idxSrc = (() => {
  const s = utilsSrc.indexOf('export const getNodeIndexInNodeList')
  if (s < 0) return null
  const e = utilsSrc.indexOf('\n}', s)
  return utilsSrc.slice(s, e + 2)
    .replace('export const getNodeIndexInNodeList =', 'function getNodeIndexInNodeList')
    .replace(/\n\}\)?;?\s*$/, '\n}')
})()

// 直接用等价实现，避免源码抽取的格式噪声
const getNodeIndexInNodeList = (node, list) => {
  const uid = (node.getData && node.getData('uid')) || node.uid
  return (list || []).findIndex(item =>
    ((item.getData && item.getData('uid')) || item.uid) === uid
  )
}

check('抽出 getNextActiveNode', !!nextSrc)

if (nextSrc) {
  const getNextActiveNode = new Function(
    'getNodeIndexInNodeList',
    `${nextSrc}\nreturn getNextActiveNode`
  )(getNodeIndexInNodeList)

  const mk = (uid, opts = {}) => ({
    uid,
    isGeneralization: !!opts.isGeneralization,
    parent: opts.parent || null,
    children: opts.children || [],
    getData(key) {
      if (key === undefined) return { uid: this.uid }
      return key === 'uid' ? this.uid : undefined
    }
  })

  // 场景：概要节点 g 有两个子节点 a、b。删除 b。
  // 实例数组仍是 [a, b]（不同步），b 已被删。
  const g = mk('g', { isGeneralization: true })
  const a = mk('a', { parent: g })
  const b = mk('b', { parent: g })
  g.children = [a, b]
  b.parent = g

  const host = {
    activeNodeList: [b],
    mindMap: { opt: { deleteNodeActive: true } },
    findActiveNodeIndex(node) {
      return this.activeNodeList.indexOf(node)
    }
  }

  // 删除前索引是有效的（节点还在实例数组里）→ 激活前面的兄弟，这是正常行为
  const target = getNextActiveNode.call(host, [b])
  check(
    '删除前索引有效：激活前面的兄弟节点',
    target === a,
    target ? 'got=' + target.uid : 'got=null'
  )

  // 实例数组已不同步（被删节点已不在 children 里）→ 索引 -1。
  // 修复前：-1 < length-1 恒真 → broList[0] 被当成「下一个兄弟」错误激活。
  const g3 = mk('g3', { isGeneralization: true })
  const c = mk('c', { parent: g3 })
  const d = mk('d', { parent: g3 })
  g3.children = [c] // d 已被移出实例数组
  const host3 = {
    activeNodeList: [d],
    mindMap: { opt: { deleteNodeActive: true } },
    findActiveNodeIndex(n) { return this.activeNodeList.indexOf(n) }
  }
  const t3 = getNextActiveNode.call(host3, [d])
  check(
    '索引 -1 时绝不取 broList[0] 误激活别的节点',
    t3 !== c,
    t3 ? 'got=' + (t3.uid || '') : 'got=null'
  )
  check(
    '索引 -1 时退回父节点或 null',
    t3 === null || t3 === g3,
    t3 ? 'got=' + (t3.uid || '') : 'got=null'
  )

  // 正常情况：索引能取到时，仍是「后面的兄弟」
  const g2 = mk('g2', { isGeneralization: true })
  const x = mk('x', { parent: g2 })
  const y = mk('y', { parent: g2 })
  g2.children = [x, y]
  const host2 = {
    activeNodeList: [x],
    mindMap: { opt: { deleteNodeActive: true } },
    findActiveNodeIndex(n) { return this.activeNodeList.indexOf(n) }
  }
  const t2 = getNextActiveNode.call(host2, [x])
  check('正常场景：删除首个子节点激活后面的兄弟', t2 === y, t2 ? 'got=' + t2.uid : 'got=null')
}

// ---- 2. 删除分支必须同步实例数组 ----
{
  const removeNodeBody = (() => {
    const s = renderSrc.indexOf('removeNode(appointNodes = [])')
    return s < 0 ? '' : renderSrc.slice(s, s + 4200)
  })()
  const removeCurrentBody = (() => {
    const s = renderSrc.indexOf('removeCurrentNode(appointNodes = [])')
    return s < 0 ? '' : renderSrc.slice(s, s + 3200)
  })()

  check(
    'removeNode 删除普通节点后同步 parent.children',
    /const parentNode = node\.parent[\s\S]{0,220}?parentNode\.children\.indexOf\(node\)/.test(removeNodeBody)
  )
  check(
    'removeCurrentNode 删除普通节点后同步 parent.children',
    /Array\.isArray\(parent\.children\)[\s\S]{0,240}?parent\.children\.indexOf\(node\)/.test(removeCurrentBody)
  )
  check(
    'removeCurrentNode 不再盲信 getNodeDataIndex 的结果',
    /if \(index > -1\)/.test(removeCurrentBody)
  )
  check(
    '索引 -1 时按 uid 过滤兜底（不 splice(-1)）',
    /const kept = parent\.nodeData\.children\.filter/.test(removeCurrentBody)
  )
  check(
    'getNextActiveNode 对 -1 索引有专门分支',
    /if \(nodeIndex === -1\) \{/.test(nextSrc || '')
  )
}

// ---- 3. 渲染失败必须释放 isRendering（卡死放大器） ----
{
  check(
    '_render 有布局失败的释放函数',
    /const releaseOnLayoutFailure = err => \{/.test(renderSrc)
  )
  check(
    '释放时会复位 isRendering 与 hasWaitRendering',
    (() => {
      const s = renderSrc.indexOf('const releaseOnLayoutFailure')
      if (s < 0) return false
      const body = renderSrc.slice(s, s + 900)
      return /this\.isRendering = false/.test(body) && /this\.hasWaitRendering = false/.test(body)
    })()
  )
  check(
    'doLayout 调用被 try/catch 包住',
    /try \{\s*\n\s*this\.layout\.doLayout/.test(renderSrc)
  )
  check(
    'catch 里调用释放',
    /\} catch \(err\) \{\s*\n\s*releaseOnLayoutFailure\(err\)/.test(renderSrc)
  )
  check(
    '异步布局分支（不回调）有看门狗',
    /layoutWatchdog = setTimeout\(/.test(renderSrc)
  )
  check(
    '布局成功后清掉看门狗',
    /if \(layoutWatchdog\) \{\s*\n\s*clearTimeout\(layoutWatchdog\)/.test(renderSrc)
  )
  check(
    '释放时发出 render_end，唤醒等待方',
    /emit\('node_tree_render_end', \{ reason: 'layout-error' \}\)/.test(renderSrc)
  )
}

// ---- 4. 协作层等待有硬边界 ----
{
  check(
    'while(true) 有等待上限',
    /let waited = 0[\s\S]{0,900}?if \(waited > 200\)/.test(coopSrc)
  )
  check(
    '超限时放弃本次远端应用并告警',
    /renderer never became ready, skip remote op/.test(coopSrc)
  )
}

const failed = results.filter(r => !r.ok)
console.log(failed.length ? `\n${failed.length} FAILED` : '\nall ok')
process.exit(failed.length ? 1 : 0)
