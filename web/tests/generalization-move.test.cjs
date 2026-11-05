/**
 * 「概要后面的节点不能移动」回归测试。
 *
 * 现象：概要子树里的节点拖不动 —— 没有落点高亮，松手后弹回原位。
 *
 * 三处根因（都在「概要子树不在主树 children 上」这条线上）：
 *  ① Drag.nodeTreeToList 用 bfsWalk(renderer.root) 收集落点候选，遍历不到概要
 *     子树 → 拖拽时找不到任何 prevNode/nextNode/overlapNode → 无法移动。
 *  ② Cooperate.interceptGuardedCommand 的 moving 分支拿节点 uid 去
 *     /api/files/:room/nodes/query 查写保护，虚拟 uid 查不到 → 404
 *     NODE_NOT_FOUND → 守卫抛错 → 整个移动被中止。
 *  ③ Cooperate.flushHttpMove 直接给虚拟 uid 提交 node.move，服务端
 *     resolveParent/getLive 拿不到行 → NODE_DELETED → revertLocalMove → 弹回。
 *
 * 另外还防了跨边界：把主树真实节点拖进概要子树会让它从主树消失但服务端行还在
 * （重复/同步失败），所以落点候选按「拖拽源是否在概要子树里」分成两类。
 */
const fs = require('fs')
const path = require('path')

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`)
}

const ROOT = path.join(__dirname, '../../simple-mind-map/src')
const dragSrc = fs.readFileSync(path.join(ROOT, 'plugins/Drag.js'), 'utf8')
const coopSrc = fs.readFileSync(path.join(ROOT, 'plugins/Cooperate.js'), 'utf8')

// ---- 抽出真实的 nodeTreeToList（依赖 this.mindMap.renderer + checkIsInBeingDragNodeList）----
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
      if (depth === 0) {
        return `function ${name}${src.slice(src.indexOf('(', start), i + 1)}`
      }
    }
  }
  return null
}

const methodSrc = extractMethod(dragSrc, 'nodeTreeToList')
check('抽出 nodeTreeToList', !!methodSrc)

if (methodSrc) {
  // 旧实现用 bfsWalk；注入一个等价实现，让「回退后能断言失败」而不是直接崩。
  const bfsWalk = (rootNode, cb) => {
    const queue = [rootNode]
    while (queue.length) {
      const cur = queue.shift()
      if (!cur) continue
      cb(cur)
      ;(cur.children || []).forEach(c => queue.push(c))
    }
  }
  const fn = new Function('bfsWalk', `${methodSrc}\nreturn nodeTreeToList`)(bfsWalk)

  const mk = (uid, opts = {}) => ({
    uid,
    isGeneralization: !!opts.isGeneralization,
    isRoot: !!opts.isRoot,
    parent: opts.parent || null,
    children: [],
    layerIndex: opts.layerIndex || 0,
    nodeData: { data: { uid, text: uid }, children: [] },
    _generalizationList: [],
    getData(key) {
      if (key === undefined) return this.nodeData.data
      return key === 'uid' ? uid : this.nodeData.data[key]
    }
  })

  // 主树 root → a → a1；a 上挂概要 g1，g1 的children里 gc1（其下 gc1a）、gc2
  const root = mk('root', { isRoot: true })
  const a = mk('a', { parent: root, layerIndex: 1 })
  const a1 = mk('a1', { parent: a, layerIndex: 2 })
  root.children = [a]
  a.children = [a1]
  const g1 = mk('g1', { isGeneralization: true, parent: a, layerIndex: 2 })
  const gc1 = mk('gc1', { parent: g1, layerIndex: 3 })
  const gc1a = mk('gc1a', { parent: gc1, layerIndex: 4 })
  const gc2 = mk('gc2', { parent: g1, layerIndex: 3 })
  g1.children = [gc1, gc2]
  gc1.children = [gc1a]
  a._generalizationList = [{ generalizationNode: g1 }]

  // 遍历桩：复刻 Render.forEachRenderedNode 语义
  const forEachRenderedNode = cb => {
    const seen = new Set()
    const visit = n => {
      if (!n || seen.has(n)) return
      seen.add(n)
      cb(n)
      ;(n.children || []).forEach(visit)
      ;(n._generalizationList || []).forEach(it => {
        const g = it && it.generalizationNode
        if (!g || seen.has(g)) return
        seen.add(g)
        cb(g)
        ;(g.children || []).forEach(visit)
      })
    }
    visit(root)
  }

  const makeHost = (dragList = []) => ({
    mindMap: { renderer: { root, forEachRenderedNode } },
    beingDragNodeList: dragList,
    nodeList: [],
    checkIsInBeingDragNodeList(node) {
      return (this.beingDragNodeList || []).includes(node)
    }
  })

  // ---- 1. 拖拽源在主树：落点候选只在主树里（防跨边界重复） ----
  {
    const host = makeHost([a1])
    fn.call(host)
    const uids = host.nodeList.map(n => n.uid)
    check(
      '主树节点拖拽：落点是主树节点',
      uids.includes('a') && uids.includes('root'),
      JSON.stringify(uids)
    )
    check(
      '主树节点拖拽：不把概要子树节点当落点（防跨边界重复）',
      !uids.includes('gc1') && !uids.includes('gc2') && !uids.includes('gc1a'),
      JSON.stringify(uids)
    )
    check('概要节点自身永远不是落点', !uids.includes('g1'))
  }

  // ---- 2. 拖拽源在概要子树：落点必须在概要子树里（本次修复核心） ----
  {
    const host = makeHost([gc1])
    fn.call(host)
    const uids = host.nodeList.map(n => n.uid)
    check(
      '概要内拖拽：落点包含概要子树节点（关键）',
      uids.includes('gc2'),
      JSON.stringify(uids)
    )
    check(
      '概要内拖拽：落点包含深层后代',
      uids.includes('gc1a'),
      JSON.stringify(uids)
    )
    check(
      '概要内拖拽：不把主树节点当落点',
      !uids.includes('a') && !uids.includes('a1') && !uids.includes('root'),
      JSON.stringify(uids)
    )
    check('概要内拖拽：排除自己', !uids.includes('gc1'))
    check('概要内拖拽：落点非空（否则完全无法移动）', host.nodeList.length > 0)
  }

  // ---- 3. 空拖拽列表按主树处理 ----
  {
    const host = makeHost([])
    fn.call(host)
    const uids = host.nodeList.map(n => n.uid)
    check('空拖拽列表：按主树处理', uids.includes('a') && !uids.includes('gc1'), JSON.stringify(uids))
  }
}

// ---- 4. Cooperate：守卫排除虚拟 uid ----
{
  check(
    '守卫收集 uid 时按实例排除虚拟子树节点',
    /const addUid = node => \{[\s\S]{0,300}?if \(isGeneralizationScopeNode\(node\)\) return/.test(coopSrc)
  )
  check(
    '守卫不再直接用 targets.map(item => item.uid) 建 ids',
    !/const ids = new Set\(targets\.map\(item => item\.uid\)\)/.test(coopSrc)
  )
  check(
    '注释写明了 404 的因果（防误删）',
    /nodes\/query[\s\S]{0,200}?404|404[\s\S]{0,120}?拖不动/.test(coopSrc)
  )
}

// ---- 5. Cooperate：移动同步分流 ----
{
  check(
    'flushHttpMove 把虚拟移动分流到 generalization',
    /const collected = this\.collectMovesFromCommand\(name, args\)[\s\S]{0,700}?isGeneralizationScopeNode\(item\.node\)[\s\S]{0,300}?generalizationScopeOwner\(item\.node\)/.test(coopSrc)
  )
  check(
    '虚拟移动同步 owner 的 generalization',
    /virtualOwners\.forEach\(owner => this\.syncHttpGeneralization\(owner\)\)/.test(coopSrc)
  )
  check(
    '纯虚拟移动提前 return（不提交 node.move）',
    /if \(!moves\.length\) \{[\s\S]{0,200}?'generalization-only'[\s\S]{0,120}?return Promise\.resolve\(\)/.test(coopSrc)
  )
  check(
    '真实移动仍走原来的提交路径',
    /const send = this\.collabV2Adapter[\s\S]{0,200}?submitV2\('node\.move', payload\)/.test(coopSrc)
  )
}

// ---- 6. Drag：落点按拖拽源分类 ----
{
  check(
    'Drag 判断拖拽源是否在概要子树',
    /const draggingVirtual = \(this\.beingDragNodeList \|\| \[\]\)\.some\(isVirtual\)/.test(dragSrc)
  )
  check(
    '落点候选按 virtual 一致性过滤',
    /if \(isVirtual\(node\) !== draggingVirtual\) return/.test(dragSrc)
  )
  check(
    'Drag 用 forEachRenderedNode（含兜底）',
    /renderer\.forEachRenderedNode\(collect\)\s*\} else \{\s*bfsWalk\(renderer\.root, collect\)/.test(dragSrc)
  )
  check(
    '不再只 bfsWalk 主树收集落点',
    !/nodeTreeToList\(\) \{[\s\S]{0,300}?bfsWalk\(this\.mindMap\.renderer\.root/.test(dragSrc)
  )
}

const failed = results.filter(r => !r.ok)
console.log(failed.length ? `\n${failed.length} FAILED` : '\nall ok')
process.exit(failed.length ? 1 : 0)
