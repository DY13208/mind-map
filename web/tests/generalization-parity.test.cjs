/**
 * 「概要后面的节点要和普通节点一样能用」回归测试。
 *
 * 现象：概要子树里的节点看着和普通节点一样，但一批功能用不了 —— 最典型的是
 * 关联线：连不上、也连不到它。
 *
 * 根因：概要子树的数据挂在所属节点的 data.generalization 里，**不在主树的
 * children 上**，所以 `walk(root)` / `bfsWalk(root)` 永远遍历不到它们。
 * 凡是依赖这些遍历的功能就等于看不到概要子树节点：
 *   - AssociativeLine.renderAllLines   → 概要子节点挂的关联线不渲染
 *   - AssociativeLine.checkOverlapNode → 概要子节点不能作为关联线终点
 *   - KeyboardNavigation ×3            → 方向键聚焦不到概要子节点
 *   - Search                           → 搜不到概要子树里的节点
 *
 * 修复：Render 新增 forEachRenderedNode(callback, options)，统一遍历
 * 主树 + 每一层概要子树；上述位置改用它。
 */
const fs = require('fs')
const path = require('path')

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`)
}

const ROOT = path.join(__dirname, '../../simple-mind-map/src')
const renderSrc = fs.readFileSync(path.join(ROOT, 'core/render/Render.js'), 'utf8')

// ---- 抽出真实的 forEachRenderedNode 方法体来跑 ----
function extractMethod(src, name) {
  const start = src.indexOf(`  ${name}(`)
  if (start < 0) return null
  // 注意：参数里有默认值 `options = {}`，不能从方法名后第一个 `{` 开始数，
  // 必须跳过参数列表，从 `) {` 处定位方法体。
  let i = src.indexOf(') {', start)
  if (i < 0) return null
  i += 2
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

const methodSrc = extractMethod(renderSrc, 'forEachRenderedNode')
check('Render 里定义了 forEachRenderedNode', !!methodSrc)

if (methodSrc) {
  const factory = new Function(`${methodSrc.replace(/^\s*forEachRenderedNode/, 'return function forEachRenderedNode')}`)
  const forEachRenderedNode = factory()

  const mk = (uid, kind = 'node') => ({
    uid,
    isGeneralization: kind === 'gen',
    children: [],
    _generalizationList: [],
    getData(key) {
      if (key === undefined) return { uid: this.uid }
      return key === 'uid' ? this.uid : undefined
    }
  })

  // 主树：root → a → a1；a 上挂概要 g1，g1 有子节点 gc1（其下 gc1a）和 gc2；
  // gc1 自己又挂概要 g2（嵌套概要），g2 有子节点 g2c
  const root = mk('root')
  const a = mk('a')
  const a1 = mk('a1')
  root.children = [a]
  a.children = [a1]

  const g1 = mk('g1', 'gen')
  const gc1 = mk('gc1')
  const gc1a = mk('gc1a')
  const gc2 = mk('gc2')
  g1.children = [gc1, gc2]
  gc1.children = [gc1a]
  a._generalizationList = [{ generalizationNode: g1 }]

  const g2 = mk('g2', 'gen')
  const g2c = mk('g2c')
  g2.children = [g2c]
  gc1._generalizationList = [{ generalizationNode: g2 }]

  const seen = []
  forEachRenderedNode.call({ root }, node => seen.push(node.uid))
  check(
    '遍历覆盖主树节点',
    ['root', 'a', 'a1'].every(uid => seen.includes(uid)),
    JSON.stringify(seen)
  )
  check('遍历覆盖概要节点自身', seen.includes('g1'))
  check('遍历覆盖概要下的子节点（关键）', seen.includes('gc1') && seen.includes('gc2'))
  check('遍历覆盖概要子节点的后代', seen.includes('gc1a'))
  check('遍历覆盖嵌套概要节点', seen.includes('g2'))
  check('遍历覆盖嵌套概要的子节点', seen.includes('g2c'))
  check('不重复遍历', seen.length === new Set(seen).size, 'count=' + seen.length)

  // includeGeneralizationNode: false 时概要节点自身不回调，但它的子节点仍要遍历
  const seenWithoutGen = []
  forEachRenderedNode.call({ root }, node => seenWithoutGen.push(node.uid), {
    includeGeneralizationNode: false
  })
  check(
    '可选：排除概要节点自身',
    !seenWithoutGen.includes('g1') && !seenWithoutGen.includes('g2'),
    JSON.stringify(seenWithoutGen)
  )
  check(
    '可选：排除概要节点后，其子节点仍被遍历',
    seenWithoutGen.includes('gc1') && seenWithoutGen.includes('gc1a') && seenWithoutGen.includes('g2c')
  )

  // 空树 / 单节点
  const emptySeen = []
  forEachRenderedNode.call({ root: null }, n => emptySeen.push(n))
  check('root 为空时不抛错', emptySeen.length === 0)

  // 循环引用保护
  const cyc = mk('c1')
  const cyc2 = mk('c2')
  cyc.children = [cyc2]
  cyc2.children = [cyc2] // 自引用
  const cycSeen = []
  let threw = null
  try {
    forEachRenderedNode.call({ root: cyc }, n => cycSeen.push(n.uid))
  } catch (e) {
    threw = e
  }
  check('循环引用不导致死循环/报错', threw === null, threw ? threw.message : '')
  check('循环引用下每个节点只回调一次', cycSeen.length === new Set(cycSeen).size)
}

// ---- 2. 关联线：两处遍历都改了 ----
{
  const assocSrc = fs.readFileSync(path.join(ROOT, 'plugins/AssociativeLine.js'), 'utf8')
  check(
    'renderAllLines 用 forEachRenderedNode 收集节点',
    /const collect = cur => \{[\s\S]{0,600}?renderer\.forEachRenderedNode\(collect\)/.test(assocSrc)
  )
  check(
    'renderAllLines 保留了 walk 兜底（旧运行时不至于白屏）',
    /renderer\.forEachRenderedNode\(collect\)\s*\} else \{\s*walk\(tree/.test(assocSrc)
  )
  check(
    'checkOverlapNode 用 forEachRenderedNode 检测终点',
    /renderer\.forEachRenderedNode\(check\)/.test(assocSrc)
  )
  check(
    'checkOverlapNode 仍排除概要节点自身（addLine 不允许连概要本身）',
    /node\.isGeneralization \|\|\s*\n?\s*node\.uid === this\.creatingStartNode\.uid/.test(assocSrc)
  )
  check(
    '不再用 bfsWalk(root) 检测关联线终点',
    !/checkOverlapNode\(x, y\) \{[\s\S]{0,400}?bfsWalk\(this\.mindMap\.renderer\.root/.test(assocSrc)
  )
}

// ---- 3. 键盘导航：三处都改了 ----
{
  const kbSrc = fs.readFileSync(path.join(ROOT, 'plugins/KeyboardNavigation.js'), 'utf8')
  check('新增 forEachNavigableNode 辅助', /forEachNavigableNode\(callback\) \{/.test(kbSrc))
  const calls = (kbSrc.match(/this\.forEachNavigableNode\(node => \{/g) || []).length
  check('三个方向算法都改用它', calls === 3, 'calls=' + calls)
  check(
    '不再直接 bfsWalk(renderer.root) 做导航',
    !/    bfsWalk\(this\.mindMap\.renderer\.root/.test(kbSrc)
  )
}

// ---- 4. 搜索：递归概要子树 ----
{
  const searchSrc = fs.readFileSync(path.join(ROOT, 'plugins/Search.js'), 'utf8')
  check('新增 collectGeneralization 递归', /const collectGeneralization = \(parentData, depth = 0\) => \{/.test(searchSrc))
  check('递归处理嵌套概要', /collectGeneralization\(gNode, depth \+ 1\)/.test(searchSrc))
  check('搜索结果包含概要下的子节点', /const kids = Array\.isArray\(gNode\.children\)/.test(searchSrc))
  check('保留了 depth 上限防死循环', /if \(depth > 50\) return/.test(searchSrc))
}

// ---- 5. 数据层：概要子节点的字段变更必须同步到 owner ----
{
  const coopSrc = fs.readFileSync(path.join(ROOT, 'plugins/Cooperate.js'), 'utf8')
  check(
    'FIELD_COMMANDS 覆盖关联线/备注/图标等',
    ['SET_NODE_NOTE', 'SET_NODE_ICON', 'SET_NODE_TAG', 'SET_NODE_HYPERLINK', 'ADD_ASSOCIATIVE_LINE'].every(
      cmd => new RegExp(`${cmd}: true`).test(coopSrc)
    )
  )
  check(
    '字段命令先同步 owner 的 generalization（在那几个 early return 之前）',
    (() => {
      const fieldBlock = coopSrc.indexOf('const genOwners = this.collectGeneralizationOwners(name, args)')
      const assocReturn = coopSrc.indexOf("Object.prototype.hasOwnProperty.call(args[1], 'associativeLineTargets')")
      return fieldBlock > 0 && assocReturn > fieldBlock
    })()
  )
}

const failed = results.filter(r => !r.ok)
console.log(failed.length ? `\n${failed.length} FAILED` : '\nall ok')
process.exit(failed.length ? 1 : 0)
