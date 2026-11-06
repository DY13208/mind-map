/**
 * 「按 delete 键删概要子树节点 → 页面崩溃/卡死」回归测试（2026-11-06）。
 *
 * 真实复现（Chromium，esbuild 打包 full.js）：`renderer.removeNode()` 直接
 * `Target crashed`（OOM）；同一场景 `removeCurrentNode()` 正常 —— 与用户
 * 「一点 delete 就整个页面卡死」完全吻合。
 *
 * 根因是 removeNode 循环的推进不变式被破坏：
 *
 *   let list = isAppointNodes ? appointNodes : this.activeNodeList
 *   const protectedOwners = this.collectProtectedOwners(list)
 *   if (protectedOwners.size) list = list.filter(...)   // ← list 变成新数组
 *   ...
 *   for (let i = 0; i < list.length; i++) {
 *     ...
 *     this.removeNodeFromActiveList(node)   // 只缩短 activeNodeList
 *     i--                                   // 抵消 i++，指望 list 变短来推进
 *   }
 *
 * 原设计是「list 就是 activeNodeList，删掉一个就短一个，i-- 让下标不动」。
 * 但删概要时 collectProtectedOwners 会返回非空 → filter 产生**新数组**，
 * removeNodeFromActiveList 再也缩短不到它 → 长度恒定 + i-- 抵消 i++ →
 * 同一个节点被无限处理，主线程被占死、内存暴涨直到页面崩溃。
 *
 * 只有概要子树里的节点会命中 filter（它们才有 owner），所以只有它们崩；
 * removeCurrentNode 没有 i--，所以不受影响 —— 正好对上现场。
 *
 * 修复：循环自己消费快照（list.slice() + 无条件 splice(i,1) + i--），
 * 终止性不再依赖任何外部副作用，并加循环上限兜底。
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

// ---- 抽出真实的 removeNode 与 collectProtectedOwners ----
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

const removeNodeSrc = extractMethod(renderSrc, 'removeNode')
const collectProtectedSrc = extractMethod(renderSrc, 'collectProtectedOwners')
check('抽出 removeNode', !!removeNodeSrc)
check('抽出 collectProtectedOwners', !!collectProtectedSrc)

// ---- 桩：构造一个「概要子树 + 主树」的最小环境 ----
function makeNode(uid, opts = {}) {
  const data = { uid, text: uid, expand: true }
  return {
    uid,
    isGeneralization: !!opts.isGeneralization,
    isRoot: !!opts.isRoot,
    generalizationBelongNode: opts.owner || null,
    parent: opts.parent || null,
    children: opts.children || [],
    nodeData: { data, children: opts.dataChildren || [] },
    getData(key) {
      if (key === undefined) return data
      return data[key]
    }
  }
}

const MAX_LOOP_GUARD = 200000

function buildHarness(scenario) {
  // 主树 root → n1, n2；root 上挂概要 gen，gen 下 gc1、gc2、gc3
  const root = makeNode('root', { isRoot: true })
  const n1 = makeNode('n-1', { parent: root })
  const n2 = makeNode('n-2', { parent: root })
  root.children = [n1, n2]
  root.nodeData.children = [
    { data: { uid: 'n-1' }, children: [] },
    { data: { uid: 'n-2' }, children: [] }
  ]

  const gen = makeNode('gen-1', { isGeneralization: true, owner: root, parent: root })
  const gc1 = makeNode('gc-1', { parent: gen })
  const gc2 = makeNode('gc-2', { parent: gen })
  const gc3 = makeNode('gc-3', { parent: gen })
  gen.children = [gc1, gc2, gc3]
  gen.nodeData.children = [
    { data: { uid: 'gc-1' }, children: [] },
    { data: { uid: 'gc-2' }, children: [] },
    { data: { uid: 'gc-3' }, children: [] }
  ]

  const activeNodeList = scenario === 'generalization-child' ? [gc2] : [n1]

  let loopGuard = 0
  /** 模拟「实例数组与数据不同步」：removeNodeFromActiveList 有时真的移除不了 */
  const activeRemoveWorks = true

  const host = {
    activeNodeList,
    textEdit: { getCurrentEditNode: () => null, hideEditTextBox() {} },
    mindMap: {
      opt: { deleteNodeActive: false },
      command: { recordContentChange() {} },
      render() {}
    },
    collectProtectedOwners: null, // 下面注入真实实现
    findActiveNodeIndex(node) {
      return this.activeNodeList.indexOf(node)
    },
    removeNodeFromActiveList(node) {
      const idx = this.activeNodeList.indexOf(node)
      if (idx > -1 && activeRemoveWorks) this.activeNodeList.splice(idx, 1)
    },
    deleteNodeGeneralization(node) {
      const parentGen = gen
      const i = parentGen.children.indexOf(node)
      if (i > -1) parentGen.children.splice(i, 1)
    },
    addNodeToActiveList() {},
    emitNodeActiveEvent() {},
    // removeNode 里是 this.getNextActiveNode(list)
    getNextActiveNode() {
      return null
    },
    clearActiveNodeList() {
      this.activeNodeList.length = 0
    },
    _bump() {
      if (++loopGuard > MAX_LOOP_GUARD) {
        throw new Error('LOOP_GUARD_EXCEEDED')
      }
    }
  }

  // 真实 collectProtectedOwners
  const collect = new Function(
    `${collectProtectedSrc}\nreturn collectProtectedOwners`
  )()
  host.collectProtectedOwners = collect.bind(host)

  return { host, root, n1, n2, gen, gc1, gc2, gc3, getLoopGuard: () => loopGuard }
}

// getNextActiveNode / removeFromParentNodeData / formatDataToArray 用等价桩
const stubs = {
  formatDataToArray: v => {
    if (v == null) return []
    return Array.isArray(v) ? v : [v]
  },
  removeFromParentNodeData: node => {
    if (!node || !node.parent) return
    const kids = node.parent.nodeData && node.parent.nodeData.children
    if (!Array.isArray(kids)) return
    const uid = node.uid
    for (let i = kids.length - 1; i >= 0; i--) {
      if (kids[i] && kids[i].data && kids[i].data.uid === uid) kids.splice(i, 1)
    }
  }
}

// 在带 timeout 的沙箱里执行，避免「修复前真的死循环」把测试进程挂死：
// 旧代码会抛 'Script execution timed out'，测试给出明确失败而不是卡住。
function runRemoveNode(host, args, timeoutMs = 3000) {
  const sandbox = {
    formatDataToArray: stubs.formatDataToArray,
    removeFromParentNodeData: stubs.removeFromParentNodeData
  }
  vm.createContext(sandbox)
  vm.runInContext(
    `${removeNodeSrc}\nthis.__fn = removeNode`,
    sandbox,
    { timeout: timeoutMs }
  )
  host.__fn = sandbox.__fn
  // removeNode(appointNodes = []) 只接受一个参数（数组），不能展开
  vm.runInContext(
    `this.__fn.call(this.__host, this.__args)`,
    Object.assign(sandbox, { __host: host, __args: args || [] }),
    { timeout: timeoutMs }
  )
}

if (removeNodeSrc) {

  // ---- 1. 核心回归：删概要子节点必须能终止 ----
  {
    const h = buildHarness('generalization-child')
    let threw = null
    const t0 = Date.now()
    try {
      // 加一道时间上限：修复前这里会真的卡死
      const watchdog = setTimeout(() => {}, 0) // 占位，实际用同步 elapsed 判断
      clearTimeout(watchdog)
      runRemoveNode(h.host, [])
    } catch (e) {
      threw = e
    }
    const elapsed = Date.now() - t0
    check(
      '删概要子节点：removeNode 能返回（不死循环）',
      threw === null,
      threw ? 'threw=' + threw.message : elapsed + 'ms'
    )
    check('删概要子节点：耗时可接受（<2s）', elapsed < 2000, elapsed + 'ms')
    check('删概要子节点：目标被删除', !h.gen.children.includes(h.gc2))
    check('删概要子节点：兄弟仍在', h.gen.children.includes(h.gc1) && h.gen.children.includes(h.gc3))
    check('删概要子节点：宿主 root 仍在', h.root.children.includes(h.n1) && h.root.children.includes(h.n2))
  }

  // ---- 2. 主树节点删除不受影响 ----
  {
    const h = buildHarness('main-child')
    let threw = null
    try {
      runRemoveNode(h.host, [])
    } catch (e) {
      threw = e
    }
    check('删主树节点：正常完成', threw === null, threw ? threw.message : '')
    check('删主树节点：n-1 已被移除', !h.root.children.includes(h.n1))
    check('删主树节点：n-2 仍在', h.root.children.includes(h.n2))
  }

  // ---- 3. 多选（appointNodes）删除概要子节点也要终止 ----
  {
    const h = buildHarness('generalization-child')
    h.host.activeNodeList.length = 0
    let threw = null
    try {
      runRemoveNode(h.host, [h.gc1, h.gc2])
    } catch (e) {
      threw = e
    }
    check('多选删概要子节点：能终止', threw === null, threw ? threw.message : '')
    check(
      '多选删概要子节点：两个都被删',
      !h.gen.children.includes(h.gc1) && !h.gen.children.includes(h.gc2)
    )
    check('多选删概要子节点：gc-3 保留', h.gen.children.includes(h.gc3))
  }

  // ---- 4. 空列表安全 ----
  {
    const h = buildHarness('main-child')
    h.host.activeNodeList.length = 0
    let threw = null
    try {
      runRemoveNode(h.host, [])
    } catch (e) {
      threw = e
    }
    check('空激活列表：直接返回不抛错', threw === null, threw ? threw.message : '')
  }
}

// ---- 5. 源码守卫：推进不变式 ----
{
  const body = removeNodeSrc || ''
  check(
    'removeNode 用 list.slice() 取快照',
    /list = list\.slice\(\)/.test(body)
  )
  check(
    '循环里无条件消费当前项',
    /list\.splice\(i, 1\)\s*\n\s*i--/.test(body)
  )
  check(
    '不再依赖 isAppointNodes 分支才 splice',
    !/if \(isAppointNodes\) list\.splice\(i, 1\)/.test(body)
  )
  check(
    '有循环上限兜底',
    /const maxLoop = list\.length \* 2 \+ 8/.test(body) && /if \(\+\+loopCount > maxLoop\) break/.test(body)
  )
  check(
    '注释说明了别名被 filter 打断的原因',
    /filter（删概要时保护宿主会用）一旦执行/.test(body) ||
      /list 就变成了\*\*新/.test(body) ||
      /新数组/.test(body)
  )

  // removeCurrentNode 同样不能假设 list 与 activeNodeList 同一引用
  const curBody = (() => {
    const s = renderSrc.indexOf('removeCurrentNode(appointNodes = [])')
    return s < 0 ? '' : renderSrc.slice(s, s + 1400)
  })()
  check('removeCurrentNode 也取快照', /list = list\.slice\(\)/.test(curBody))
}

const failed = results.filter(r => !r.ok)
console.log(failed.length ? `\n${failed.length} FAILED` : '\nall ok')
process.exit(failed.length ? 1 : 0)
