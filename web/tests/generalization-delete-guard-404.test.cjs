/**
 * 概要虚拟子树节点删除报 404 的回归测试。
 *
 * 现场：删除概要后面的节点，控制台报
 *   POST /api/files/<room>/nodes/query 404 (Not Found)
 *   at fetchWriteGuard → readWriteGuard → interceptGuardedCommand
 *
 * 根因：删除命令执行前，写保护守卫要拿目标 uid 去服务端查 node 行。
 * 概要虚拟子树内的节点没有服务端节点行，查出来是 404 NODE_NOT_FOUND，
 * 守卫抛错 → 整个删除被中止，节点当然「删不掉」。
 *
 * 关键点：interceptGuardedCommand 里那份 collectDeleteRoots 调用漏了
 * isVirtualSubtree（只改了 onBeforeExecCommand 那一处），于是虚拟子树的
 * 普通子节点又被当成真实节点收进 roots。
 *
 * 契约：纯虚拟子树的删除不产生任何守卫目标（因此不会去查 nodes/query），
 *       命令被放行，写入由 owner 的 generalization 通道完成。
 */
const fs = require('fs')
const path = require('path')

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`)
}

const ROOT = path.join(__dirname, '../../simple-mind-map/src')
const collabDelete = require(path.join(ROOT, 'utils/collabDelete.js'))
const cooperateSrc = fs.readFileSync(path.join(ROOT, 'plugins/Cooperate.js'), 'utf8')

// ---- 1. 两处 collectDeleteRoots 都必须带 isVirtualSubtree ----
{
  const calls = cooperateSrc.match(/collabDelete\.collectDeleteRoots\([\s\S]{0,400}?\)/g) || []
  check('有 2 处 collectDeleteRoots 调用', calls.length === 2, 'found=' + calls.length)
  calls.forEach((call, i) => {
    check(
      `第 ${i + 1} 处调用带 isVirtualSubtree`,
      /isVirtualSubtree:\s*node\s*=>\s*isGeneralizationScopeNode\(node\)/.test(call),
      call.slice(0, 80).replace(/\s+/g, ' ')
    )
  })
}

// ---- 2. 守卫逻辑：纯虚拟子树删除不产生 ids → 不会请求 nodes/query ----
{
  function mkNode(uid, opts = {}) {
    const data = { uid, text: uid, expand: true }
    return {
      uid,
      isGeneralization: !!opts.isGeneralization,
      isRoot: !!opts.isRoot,
      generalizationBelongNode: opts.owner || null,
      parent: opts.parent || null,
      children: [],
      nodeData: { data, children: [] },
      getData(key) {
        if (key === undefined) return data
        return data[key]
      }
    }
  }
  const owner = mkNode('owner-1')
  const gen = mkNode('gen-1', { isGeneralization: true, owner, parent: owner })
  const genChild = mkNode('genchild-1', { parent: gen })
  const realChild = mkNode('real-1', { parent: owner })

  const isVirtualSubtree = node => {
    let cur = node
    for (let i = 0; cur && i < 1000; i++) {
      if (cur.isGeneralization) return true
      cur = cur.parent
    }
    return false
  }

  // 模拟 interceptGuardedCommand 的目标计算（修复后的写法）
  const computeTargets = explicit => {
    const sel = collabDelete.collectDeleteRoots(explicit, 'REMOVE_NODE', { isVirtualSubtree })
    return { targets: sel.roots, owners: sel.owners }
  }

  const onlyVirtual = computeTargets([genChild])
  check('删概要子节点：守卫目标为空（不发 nodes/query）', onlyVirtual.targets.length === 0)
  check('删概要子节点：owner 被收集（走 generalization）', onlyVirtual.owners[0] === owner)

  const onlyReal = computeTargets([realChild])
  check('删真实节点：守卫目标正常（要发 nodes/query）', onlyReal.targets.length === 1 && onlyReal.targets[0].uid === 'real-1')

  const mixed = computeTargets([realChild, genChild])
  check('混选：只对真实节点发守卫', mixed.targets.length === 1 && mixed.targets[0].uid === 'real-1')
  check('混选：同时收集 owner', mixed.owners[0] === owner)
}

// ---- 3. 守卫在 targets 为空时必须放行而不是抛错 ----
{
  check(
    'interceptGuardedCommand 在 targets 为空时直接 return（放行）',
    /const targets = deleting[\s\S]{0,200}?if \(!targets\.length\) return/.test(cooperateSrc)
  )
  check(
    '注释说明了 404 的因果（防以后被误删）',
    /nodes\/query[\s\S]{0,200}?404|404 NODE_NOT_FOUND/.test(cooperateSrc)
  )
}

// ---- 4. 服务端确实会对未知 uid 返回 404（确认根因成立） ----
{
  const nodeQuerySrc = fs.readFileSync(path.join(__dirname, '../../simple-mind-map/bin/nodeQuery.js'), 'utf8')
  check(
    'nodeQuery 查不到节点时抛 NODE_NOT_FOUND 404',
    /if \(!targetInfo\) throw queryError\('节点不存在', 'NODE_NOT_FOUND', 404\)/.test(nodeQuerySrc)
  )
}

const failed = results.filter(r => !r.ok)
console.log(failed.length ? `\n${failed.length} FAILED` : '\nall ok')
process.exit(failed.length ? 1 : 0)
