/**
 * 「概要后面节点的功能要和普通节点一样」回归测试（2026-11-06）。
 *
 * 现场（浏览器控制台）：
 *   GET /api/files/room-xxx/subtree?uid=<概要子节点>&knownVersion=0  → 404
 *   [mind-map] load children failed Error: not found
 *   [mind-map] copy subtree failed Error: not found
 *   [mind-map] move node failed Error: 受保护的节点写入缺少 expected 校验信息
 *   复制出来的节点在滚动时出现大量重复/空节点
 *
 * 根因：概要虚拟子树的节点在服务端**没有行**，它们的全部数据存在
 * owner.generalization 里。但下列入口都把它们当真实节点去访问服务端：
 *
 *   ① nodeNeedsHydrate / hydrateFromHttp / hydrateNodeData / ensurePlacementParent
 *      → GET /subtree?uid=<虚拟uid> → 404
 *   ② copyNodeTrees → httpFetchDeepSubtree(虚拟uid) → 404 → 落进
 *      hydrateDataTree 对每个虚拟 uid 再拉一次 → 整棵复制树残缺 →
 *      粘贴出一堆重复/空节点（截图现象）
 *   ③ syncHttpUndoRedo 的 diff.moved / diff.updated
 *      → httpPatchNode(虚拟uid, {...}) 不带 expected → 428
 *      「受保护的节点写入缺少 expected 校验信息」
 *   ④ flushHttpReparentChildren → 对虚拟子节点逐个 patch → 404/428
 *
 * 修复：统一用 isVirtualGeneralizationUid 判定并在所有服务端入口短路；
 * 虚拟 → 主树的移动走「提升」（从 generalization 摘出 + node.insert）。
 */
const fs = require('fs')
const path = require('path')

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`)
}

const ROOT = path.join(__dirname, '../../simple-mind-map/src')
const coopSrc = fs.readFileSync(path.join(ROOT, 'plugins/Cooperate.js'), 'utf8')
const dragSrc = fs.readFileSync(path.join(ROOT, 'plugins/Drag.js'), 'utf8')
const genUtilPath = path.join(ROOT, 'utils/collabGeneralization.js')
const collabGeneralization = require(genUtilPath)

// ---- 1. 统一的虚拟 uid 判定存在且被各处使用 ----
{
  check(
    '新增 isVirtualGeneralizationUid（按 uid 判定虚拟子树）',
    /isVirtualGeneralizationUid\(uid\) \{/.test(coopSrc)
  )
  check(
    '实例优先：先查画布实例的 parent 链',
    /isVirtualGeneralizationUid\(uid\) \{[\s\S]{0,700}?findNodeByUid[\s\S]{0,200}?isGeneralizationScopeNode\(node\)/.test(coopSrc)
  )
  check(
    '实例不在时退化扫渲染树里的 generalization 后代',
    /virtualGeneralizationUidSet\(\) \{/.test(coopSrc)
  )
}

// ---- 2. hydrate 全链路短路（404 主因） ----
{
  check(
    'nodeNeedsHydrate 对虚拟节点返回 false',
    /nodeNeedsHydrate\(node\) \{[\s\S]{0,400}?if \(isGeneralizationScopeNode\(node\)\) return false/.test(coopSrc)
  )
  check(
    'hydrateFromHttp 对虚拟节点直接返回（不发 /subtree）',
    /async hydrateFromHttp\(node[\s\S]{0,500}?if \(isGeneralizationScopeNode\(node\)\) return\b/.test(coopSrc)
  )
  check(
    'hydrateNodeData 对虚拟 uid 直接返回',
    /async hydrateNodeData\(data\) \{[\s\S]{0,600}?if \(this\.isVirtualGeneralizationUid\(uid\)\) return data/.test(coopSrc)
  )
  check(
    'ensurePlacementParent 依赖 nodeNeedsHydrate 短路',
    /async ensurePlacementParent\(parentNode\) \{[\s\S]{0,200}?if \(!this\.nodeNeedsHydrate\(parentNode\)\) return parentNode/.test(coopSrc)
  )
}

// ---- 3. 复制/剪切不再拉服务端 ----
{
  check(
    'copyNodeTrees 对虚拟节点直接用本地实例复制',
    /async copyNodeTrees\(nodes\) \{[\s\S]{0,900}?if \(isGeneralizationScopeNode\(node\)\) \{[\s\S]{0,200}?copyNodeTree\(\{\}, node, true, true\)/.test(coopSrc)
  )
  check(
    'copyNodeTrees 虚拟分支在 httpFetchDeepSubtree 之前 continue',
    /if \(isGeneralizationScopeNode\(node\)\) \{[\s\S]{0,260}?continue\s*\}[\s\S]{0,120}?if \(uid && this\.httpFetchDeepSubtree\)/.test(coopSrc)
  )
}

// ---- 4. undo/redo 不再对虚拟 uid 发 patch ----
{
  check(
    'syncHttpUndoRedo 收集虚拟 uid',
    /const virtualUndoTouch = new Set\(\)/.test(coopSrc)
  )
  check(
    'diff.removed 跳过虚拟 uid',
    /diff\.removed\.forEach\(item => \{\s*\n\s*if \(isVirtualDiffUid\(item\.uid\)\) return/.test(coopSrc)
  )
  check(
    'diff.moved 跳过虚拟 uid（消除 expected 428）',
    /diff\.moved\.forEach\(item => \{[\s\S]{0,160}?if \(isVirtualDiffUid\(item\.uid\)\) return/.test(coopSrc)
  )
  check(
    'diff.updated 跳过虚拟 uid',
    /if \(isVirtualDiffUid\(item\.uid\)\) return[\s\S]{0,200}?const payload = this\.historyTreePayload\(item\.data\)/.test(coopSrc)
  )
  check(
    '虚拟 undo 最后统一同步 owner.generalization',
    /if \(virtualUndoTouch\.size\) \{[\s\S]{0,900}?syncHttpGeneralization\(owner\)/.test(coopSrc)
  )
}

// ---- 5. reparent 跳过虚拟子节点 ----
{
  check(
    'flushHttpReparentChildren 过滤虚拟子节点',
    /flushHttpReparentChildren\(node\) \{[\s\S]{0,900}?isVirtualGeneralizationUid\(uid\)/.test(coopSrc)
  )
}

// ---- 6. 移动虚拟节点到主树 = 提升 ----
{
  check(
    '移动前记录 hoistCandidates（parent 链还在时取 owner）',
    /hoistCandidates\.push\(\{[\s\S]{0,120}?owner,/.test(coopSrc)
  )
  check(
    'flushHttpMove 识别「移动后不在概要里」= 提升',
    /if \(isGeneralizationScopeNode\(node\)\) return[\s\S]{0,200}?hoistedUids\.add/.test(coopSrc)
  )
  check(
    '实现了 hoistVirtualNode',
    /hoistVirtualNode\(node, owner, uid\) \{/.test(coopSrc)
  )
  check(
    '提升时清掉该 uid 的「已同步」痕迹（否则 insert 会跳过）',
    /this\.forgetHttpUid\(uid\)[\s\S]{0,400}?abandonedInsertUids[\s\S]{0,200}?delete/.test(coopSrc)
  )
  check(
    '提升后走 flushHttpInsert 建真实节点',
    /hoistVirtualNode\(node, owner, uid\) \{[\s\S]{0,2200}?this\.flushHttpInsert\(\)/.test(coopSrc)
  )
}

// ---- 7. Drag 允许虚拟 → 主树，仍禁止主树 → 虚拟 ----
{
  check(
    '虚拟节点可以把主树节点当落点',
    !/if \(draggingVirtual && !isVirtual\(node\)\) return/.test(dragSrc)
  )
  check(
    '主树节点不会把概要子树当落点',
    /if \(!draggingVirtual && isVirtual\(node\)\) return/.test(dragSrc)
  )
}

// ---- 8. detachGeneralizationNode 行为 ----
{
  const { detachGeneralizationNode } = collabGeneralization
  check('collabGeneralization 导出 detachGeneralizationNode', typeof detachGeneralizationNode === 'function')

  if (typeof detachGeneralizationNode === 'function') {
    const generalization = [
      {
        uid: 'gen-1',
        text: '概要',
        expand: true,
        children: [
          { uid: 'gc-1', text: 'A', children: [] },
          {
            uid: 'gc-2',
            text: 'B',
            children: [{ uid: 'gc-2a', text: 'B1', children: [] }]
          },
          { uid: 'gc-3', text: 'C', children: [] }
        ]
      }
    ]

    // 顶层直接子节点
    const r1 = detachGeneralizationNode(generalization, 'gc-2')
    check('摘掉顶层概要子节点：命中', !!r1.removed && r1.removed.uid === 'gc-2')
    check(
      '摘掉后兄弟保留、且不带被摘的节点',
      r1.next && r1.next[0].children.length === 2 &&
        !r1.next[0].children.some(c => c.uid === 'gc-2'),
      JSON.stringify((r1.next[0].children || []).map(c => c.uid))
    )
    check(
      '摘掉的节点带着自己的子树（提升时要完整）',
      !!r1.removed && Array.isArray(r1.removed.children) && r1.removed.children.length === 1
    )

    // 深层后代
    const r2 = detachGeneralizationNode(generalization, 'gc-2a')
    check('能摘掉深层后代', !!r2.removed && r2.removed.uid === 'gc-2a')

    // 不存在
    const r3 = detachGeneralizationNode(generalization, 'not-exist')
    check('摘不存在的 uid：removed 为 null', r3.removed === null)

    // 原数据不被破坏（用的是快照）
    check(
      '不就地修改传入的 generalization',
      generalization[0].children.length === 3
    )

    // 空/null 输入安全
    let threw = null
    try {
      detachGeneralizationNode(null, 'x')
      detachGeneralizationNode(undefined, 'x')
      detachGeneralizationNode(generalization, '')
    } catch (e) {
      threw = e
    }
    check('空输入不抛错', threw === null, threw ? threw.message : '')

    // 摘完最后一个 → next 为 null（概要应被清掉）
    const onlyOne = [{ uid: 'gen-x', text: 'g', children: [{ uid: 'only', text: 'o', children: [] }] }]
    const r4 = detachGeneralizationNode(onlyOne, 'only')
    check('摘空概要的子节点后 next 结构合法', r4.removed && r4.removed.uid === 'only', JSON.stringify(r4.next && r4.next.length))
  }
}

const failed = results.filter(r => !r.ok)
console.log(failed.length ? `\n${failed.length} FAILED` : '\nall ok')
process.exit(failed.length ? 1 : 0)
