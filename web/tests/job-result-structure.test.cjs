/* eslint-env node */
/**
 * 写回结构单测 —— 2026-10-08 用户要求：
 *
 *   「生成的产物挂载到附件节点，然后只需要 任务-附件-完整输出|产物」
 *   「现在是强制刷新才会出现产物挂载到任务节点」
 *
 * 断言两件事：
 *   A. 结构：任务 → 附件 → （产物文件 | 完整输出.md）
 *      · 不再有「运行输出 · 时间」这一层中间节点
 *      · 正文不再铺成章节节点树（全文进「完整输出.md」）
 *   B. 免刷新：收尾会展开新节点 + 复核附件落地 + 强制重绘
 *
 * 用内存树 mock 掉 simple-mind-map，直接观察 execCommand 产生的结构。
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

// ---------- 加载被测模块（把外部依赖换成桩） ----------
const src = fs.readFileSync(path.join(WEB, 'src/utils/jobResultWriter.js'), 'utf8')
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
const writer = mod.exports

// ---------- 内存版 mindMap ----------
// slowLand = true 时模拟「协同模式下命令不是同步落树」：一批节点分批落地
// （第一个立刻，其余 30ms 后）。用来验证「附件不要挂错节点」。
// dropInserts = true 时模拟「命令被协同服务静默丢掉」：插入命令一个都不落。
let slowLand = false
let dropInserts = false
// queueInserts = true 时把插入挂起，等测试显式 flush —— 模拟「两个任务同时插入」的竞态
let queueInserts = false
const queuedInserts = []
// 模拟「这次插入被协同吃掉」：dropTreeText 每次都丢，…Once 只丢一次（用来验重试）
let dropTreeText = ''
let dropTreeTextOnce = ''
let seq = 0
function makeNode(text, uid) {
  seq += 1
  const node = {
    nodeData: { data: { text, uid: uid || `uid-${seq}` } },
    children: [],
    parent: null,
    getData(key) {
      return node.nodeData.data[key]
    },
    setData(patch) {
      Object.assign(node.nodeData.data, patch || {})
    },
    reRender() {
      return true
    },
    nodeDataText() {
      return node.nodeData.data.text
    }
  }
  return node
}
function attachTree(parent, tree) {
  // 引擎会**保留**调用方传进来的 data.uid（见 createUidForAppointNodes），照它模拟
  const made = makeNode(
    (tree.data && tree.data.text) || '',
    tree.data && tree.data.uid
  )
  made.parent = parent
  parent.children.push(made)
  ;(tree.children || []).forEach(child => attachTree(made, child))
  return made
}

// swapInstances = true 时模拟「重渲染把节点实例整批换新」：
// 命令照常作用在活的那棵树上，但执行完就把节点对象全部重建 —— 调用方手里的引用
// 从此不再更新（数据对、画布对，只有旧引用是死的）。
let swapInstances = false
function cloneInstances(node) {
  const copy = makeNode(node.getData('text'), node.getData('uid'))
  copy.nodeData = node.nodeData // 数据是共享的（和真实引擎一致）
  ;(node.children || []).forEach(child => {
    const made = cloneInstances(child)
    made.parent = copy
    copy.children.push(made)
  })
  return copy
}
function makeMindMap() {
  const map = {
    renderCount: 0,
    cmds: [],
    // readonly 一开，核心 Command.exec 会**静默丢弃**所有结构命令（真实行为）
    opt: { readonly: false },
    renderer: {
      renderTree: { data: {} },
      activeNodeList: [],
      findNodeByUid(uid) {
        const stack = [map.root]
        while (stack.length) {
          const cur = stack.pop()
          if (!cur) continue
          if (cur.getData('uid') === uid) return cur
          ;(cur.children || []).forEach(c => stack.push(c))
        }
        return null
      },
      setNodeDataRender(node, patch) {
        Object.assign(node.nodeData.data, patch || {})
      }
    },
    render() {
      map.renderCount += 1
    },
    execCommand(cmd, ...args) {
      map.cmds.push(cmd)
      if (cmd === 'INSERT_MULTI_CHILD_NODE') {
        // 命令被协同服务丢掉：插了跟没插一样（这就是「报成功、图上没有」的成因）
        if (dropInserts) return
        // 引擎的签名是 (nodeList, trees) —— 第一个参数是数组
        const parents = args[0]
        const trees = args[1]
        const passed = Array.isArray(parents) ? parents[0] : parents
        // 引擎真正改的是**活的那棵树**上的节点（调用方手里的引用可能早就过期了）
        const parent =
          (passed && map.renderer.findNodeByUid(passed.getData('uid'))) || passed
        const list = (trees || []).filter(tree => {
          const text = tree && tree.data && tree.data.text
          if (dropTreeText && text === dropTreeText) return false
          if (dropTreeTextOnce && text === dropTreeTextOnce) {
            dropTreeTextOnce = ''
            return false
          }
          return true
        })
        // 整批都被吃掉（模拟「命令被协同服务丢了」）
        if (!list.length) return
        if (queueInserts) {
          queuedInserts.push(() => list.forEach(tree => attachTree(parent, tree)))
          return
        }
        if (slowLand && list.length > 1) {
          attachTree(parent, list[0])
          setTimeout(() => {
            list.slice(1).forEach(tree => attachTree(parent, tree))
          }, 30)
        } else {
          list.forEach(tree => attachTree(parent, tree))
        }
        // 重渲染会把**节点实例整批换新**：数据/画布都对，但调用方手里的引用从此刻起
        // 不再更新（它的 children 永远是旧的）—— 2026-10-08「命令没有落到图上」的成因
        if (swapInstances) {
          map.root = cloneInstances(map.root)
        }
        return
      }
      if (cmd === 'SET_NODE_ATTACHMENT') {
        const [node, url, name, meta] = args
        Object.assign(node.nodeData.data, {
          attachmentUrl: url,
          attachmentName: name,
          ...(meta || {})
        })
        return
      }
      if (cmd === 'SET_NODE_DATA') {
        const [node, data] = args
        Object.assign(node.nodeData.data, data || {})
        return
      }
      // ADD_GENERALIZATION 等：记一笔就够，不影响结构断言
    }
  }
  map.root = makeNode('根主题')
  // 真实引擎里 Render 持有 root（findNodeByUid 就是从这里 walk 的）；
  // 我们的「按标题找回」也一样 —— mock 必须补上，否则测的不是真实结构
  map.renderer.root = map.root
  return map
}

const MD = [
  '## 一句话结论',
  '他是打辅助的十年老玩家。',
  '',
  '## 关键要点',
  '- 第一条要点',
  '- 第二条要点'
].join('\n')

const texts = list => (list || []).map(n => String(n.getData('text') || ''))
const findByText = (list, text) => (list || []).find(n => n.getData('text') === text)
const findPrefix = (list, prefix) =>
  (list || []).find(n => String(n.getData('text') || '').startsWith(prefix))

async function main() {
  // ============ A. 结构 ============
  console.log('--- 结构：任务 → 附件 → 完整输出 | 产物 ---')
  const map = makeMindMap()
  const rootUid = map.root.getData('uid')
  const out = await writer.writeJobResultToMap({
    mindMap: map,
    nodeUid: rootUid,
    markdown: MD,
    prompt: '写一个四季如春的作文',
    roomKey: 'room-test',
    artifacts: [
      {
        name: 'output/十二生肖作文.md',
        size: 120,
        mime: 'text/markdown',
        base64: Buffer.from('hello').toString('base64')
      }
    ],
    bridgeAttach: async payload => {
      const sent = (payload && payload.files && payload.files[0]) || {}
      return {
        ok: true,
        attachments: [
          {
            ok: true,
            attachmentId: 'aid-1',
            fileName: sent.name || '',
            mimeType: sent.mimeType || '',
            status: 'ready',
            extractedText: ''
          }
        ]
      }
    }
  })

  const container = map.root.children[0]
  check(
    '任务容器建在落点节点下',
    !!container && /^任务\s*[·・:：]/.test(String(container.getData('text'))),
    container && String(container.getData('text'))
  )

  const containerKids = container.children || []
  check(
    '不再有「运行输出」这一层中间节点',
    !findPrefix(containerKids, '运行输出'),
    JSON.stringify(texts(containerKids))
  )
  check(
    '正文不再铺成章节节点树',
    !findByText(containerKids, '一句话结论') && !findByText(containerKids, '关键要点'),
    JSON.stringify(texts(containerKids))
  )

  const branch = findByText(containerKids, '附件')
  check('「附件」节点直接挂在任务下面', !!branch, JSON.stringify(texts(containerKids)))
  check(
    '附件分支的父节点就是任务容器',
    !!branch && branch.parent === container
  )

  const branchKids = (branch && branch.children) || []
  check(
    '产物文件挂在「附件」下',
    !!findByText(branchKids, 'output/十二生肖作文.md'),
    JSON.stringify(texts(branchKids))
  )
  check(
    '完整输出挂在「附件」下',
    !!findByText(branchKids, '完整输出.md'),
    JSON.stringify(texts(branchKids))
  )
  const artNode = findByText(branchKids, 'output/十二生肖作文.md')
  check(
    '产物节点上真的落了附件（attachmentName 非空）',
    !!artNode && String(artNode.getData('attachmentName') || '') !== '',
    artNode && String(artNode.getData('attachmentName'))
  )
  const mdNode = findByText(branchKids, '完整输出.md')
  check(
    '完整输出节点上也落了附件',
    !!mdNode && String(mdNode.getData('attachmentName') || '') !== '',
    mdNode && String(mdNode.getData('attachmentName'))
  )
  // ============ B. 免刷新 ============
  console.log('--- 免刷新：展开 + 重绘 ---')
  check('收尾强制重绘了一次', map.renderCount >= 1, String(map.renderCount))
  check(
    '任务容器被展开（折叠时新节点在画布上看不见）',
    container.getData('expand') === true,
    String(container.getData('expand'))
  )
  check(
    '附件分支也被展开',
    !!branch && branch.getData('expand') === true,
    branch && String(branch.getData('expand'))
  )
  check(
    '写回结果里报告了附件数量',
    (out.attachments || []).length === 2,
    JSON.stringify(out.attachments)
  )

  // ============ C. 没有 roomKey 时的兜底 ============
  console.log('--- 兜底：挂不了附件时正文要留在导图上 ---')
  const map2 = makeMindMap()
  const out2 = await writer.writeJobResultToMap({
    mindMap: map2,
    nodeUid: map2.root.getData('uid'),
    markdown: MD,
    prompt: '写个作文',
    roomKey: ''
  })
  const container2 = map2.root.children[0]
  const kids2 = (container2 && container2.children) || []
  // 没有房间号时正文会铺出来（挂在「运行输出」节点下），所以要在整棵子树里找
  const allText2 = []
  const collect = list =>
    (list || []).forEach(n => {
      allText2.push(String(n.getData('text') || ''))
      collect(n.children)
    })
  collect(kids2)
  check(
    '没有房间号 → 正文以节点形式铺出来（内容不丢）',
    allText2.includes('一句话结论'),
    JSON.stringify(allText2)
  )
  check(
    '没有房间号 → 不建附件分支',
    !findByText(kids2, '附件'),
    JSON.stringify(texts(kids2))
  )
  check(
    '提示里说明了没挂附件',
    (out2.warnings || []).some(w => /没挂附件/.test(w)),
    JSON.stringify(out2.warnings)
  )

  // ============ D. 协同分批落地时附件不能挂错（2026-10-08 用户要求「不要乱」）============
  // 库里实测到的症状：同一个 node_uid 下同时挂了产物文件和「完整输出」——
  // 因为产物节点还没落地，写回就去认「新出现的那个节点」，认成了产物节点。
  console.log('--- 协同分批落地：附件各归各位 ---')
  const bridgeAttachStub = async payload => {
    const sent = (payload && payload.files && payload.files[0]) || {}
    return {
      ok: true,
      attachments: [
        {
          ok: true,
          attachmentId: `aid-${sent.name || 'x'}`,
          fileName: sent.name || '',
          mimeType: sent.mimeType || '',
          status: 'ready',
          extractedText: ''
        }
      ]
    }
  }
  slowLand = true
  const map3 = makeMindMap()
  await writer.writeJobResultToMap({
    mindMap: map3,
    nodeUid: map3.root.getData('uid'),
    markdown: MD,
    prompt: '两个产物的任务',
    roomKey: 'room-test',
    artifacts: [
      {
        name: 'output/A.md',
        size: 10,
        mime: 'text/markdown',
        base64: Buffer.from('a').toString('base64')
      },
      {
        name: 'output/B.md',
        size: 10,
        mime: 'text/markdown',
        base64: Buffer.from('b').toString('base64')
      }
    ],
    bridgeAttach: bridgeAttachStub
  })
  slowLand = false
  const container3 = map3.root.children[0]
  const branch3 = findByText((container3 && container3.children) || [], '附件')
  const kids3 = (branch3 && branch3.children) || []
  const fileA = findByText(kids3, 'output/A.md')
  const fileB = findByText(kids3, 'output/B.md')
  const md3 = findByText(kids3, '完整输出.md')
  check(
    '两个产物节点 + 完整输出节点都建出来了',
    !!fileA && !!fileB && !!md3,
    JSON.stringify(texts(kids3))
  )
  check(
    '产物 A 节点上挂的就是 A',
    !!fileA && String(fileA.getData('attachmentName') || '') === 'output/A.md',
    fileA && String(fileA.getData('attachmentName'))
  )
  check(
    '产物 B 节点上挂的就是 B',
    !!fileB && String(fileB.getData('attachmentName') || '') === 'output/B.md',
    fileB && String(fileB.getData('attachmentName'))
  )
  check(
    '完整输出节点上挂的是它自己的 md（不是产物）',
    !!md3 && /^运行输出 · /.test(String(md3.getData('attachmentName') || '')),
    md3 && String(md3.getData('attachmentName'))
  )

  // ============ D. 命令被静默丢掉 → 必须报错，不能报成功 ============
  // 2026-10-08 用户反馈「状态栏说成功、图上什么都没有」。成因：整条写回都是
  // 「不抛错」的写法（连 waitNewChild 都退回「最后一个子节点」充数），
  // 命令被协同服务丢掉时也一路走到「已写入导图」。
  console.log('--- 命令没落到图上：必须报错，不能报成功 ---')
  const mapD = makeMindMap()
  const containerD = await writer.createJobContainer({
    mindMap: mapD,
    nodeUid: mapD.root.getData('uid'),
    prompt: '任务内容'
  })
  check('先正常建出任务容器', !!containerD.uid, containerD.uid)

  dropInserts = true
  let threw = ''
  try {
    await writer.writeJobResultToMap({
      mindMap: mapD,
      nodeUid: containerD.uid,
      markdown: MD,
      roomKey: 'room-test',
      artifacts: []
    })
  } catch (err) {
    threw = (err && err.message) || String(err)
  }
  check('命令被丢掉 → 抛错，而不是报「已写入」', /没有落到图上/.test(threw), threw)
  check(
    '抛错时不留下「已写入」的假象（节点数为 0）',
    (containerD.node.children || []).length === 1,
    String((containerD.node.children || []).length)
  )

  // 同一棵树，命令能落 → 正常写回且真的长出节点
  dropInserts = false
  const okOut = await writer.writeJobResultToMap({
    mindMap: mapD,
    nodeUid: containerD.uid,
    markdown: MD,
    roomKey: 'room-test',
    artifacts: []
  })
  check(
    '命令能落时正常写出（附件 + 完整输出）',
    okOut.nodes >= 2 && (containerD.node.children || []).length > 1,
    `nodes=${okOut.nodes} kids=${(containerD.node.children || []).length}`
  )

  // ============ E. 只读房间 / 懒加载 —— 「命令被丢了」的两个真凶 ============
  // 用户 2026-10-08 看到「可能协同任务丢了」。查核心命令层：
  //   · Command.exec 在 mindMap.opt.readonly 为真时**静默丢弃**所有结构命令；
  //   · Renderer.runAfterHydrate 碰到「子节点没拉全」的父节点，会把插入推迟到
  //     hydration 之后，失败只 console.error —— 命令等于丢了。
  console.log('--- 只读房间：命令会被静默丢弃，必须提前说清 ---')
  const mapE = makeMindMap()
  mapE.opt.readonly = true
  let threwE = ''
  try {
    await writer.writeJobResultToMap({
      mindMap: mapE,
      nodeUid: mapE.root.getData('uid'),
      markdown: MD,
      roomKey: 'room-test'
    })
  } catch (err) {
    threwE = (err && err.message) || String(err)
  }
  check(
    '只读房间 → 直接说「只读、没有编辑权限」，不写空账',
    /只读/.test(threwE) && /编辑权限/.test(threwE),
    threwE
  )
  let threwE2 = ''
  try {
    await writer.createJobContainer({
      mindMap: mapE,
      nodeUid: mapE.root.getData('uid'),
      prompt: '任务内容'
    })
  } catch (err) {
    threwE2 = (err && err.message) || String(err)
  }
  check('只读房间 → 建任务容器也当场报只读', /只读/.test(threwE2), threwE2)

  console.log('--- 懒加载父节点：插入前先补 hydration ---')
  const mapF = makeMindMap()
  const hydrateCalls = []
  mapF.cooperate = {
    nodeNeedsHydrate: () => true,
    ensurePlacementParent: async node => {
      hydrateCalls.push((node && node.getData && node.getData('text')) || '')
    }
  }
  const outF = await writer.writeJobResultToMap({
    mindMap: mapF,
    nodeUid: mapF.root.getData('uid'),
    markdown: MD,
    roomKey: 'room-test',
    artifacts: []
  })
  check(
    '每次插入前都对落点补过 hydration',
    hydrateCalls.length >= 3,
    `${hydrateCalls.length}: ${hydrateCalls.join(' / ')}`
  )
  check('补完 hydration 后照常写出', outF.nodes >= 2, String(outF.nodes))

  // ============ F. 两个任务同时跑：落点不能互相认领 ============
  // 用户 2026-10-08 反馈：「两个任务同时运行，第一个没有完整输出、第二个内容重复」。
  // 根因：认领新节点用的是「最后一个新子节点」—— 两条任务同时往同一个父节点插东西时，
  // 双方会认到**同一个**节点，于是共用一个「任务容器」→「附件」分支和「完整输出.md」
  // 被复用，后写的把先写的正文覆盖掉（看起来就是内容重复/丢了）。
  console.log('--- 两个任务同时建容器：各认各的（按 uid） ---')
  const mapG = makeMindMap()
  queueInserts = true
  const boxA = writer.createJobContainer({
    mindMap: mapG,
    nodeUid: mapG.root.getData('uid'),
    prompt: '任务A的内容'
  })
  const boxB = writer.createJobContainer({
    mindMap: mapG,
    nodeUid: mapG.root.getData('uid'),
    prompt: '任务B的内容'
  })
  await new Promise(r => setTimeout(r, 10))
  // 两批插入「同时」落地（真实场景：协同下命令落地时机由服务端回包决定）
  queuedInserts.splice(0).forEach(fn => fn())
  const [madeA, madeB] = await Promise.all([boxA, boxB])
  queueInserts = false
  check(
    '两条任务各拿各的容器（uid 不同）',
    !!madeA.uid && !!madeB.uid && madeA.uid !== madeB.uid,
    `${madeA.uid} / ${madeB.uid}`
  )
  const contentOf = node =>
    ((node.children || [])[0] && node.children[0].getData('text')) || ''
  check(
    'A 的容器里是 A 的任务内容（没认成 B 的节点）',
    /任务A/.test(contentOf(madeA.node)),
    contentOf(madeA.node)
  )
  check(
    'B 的容器里是 B 的任务内容',
    /任务B/.test(contentOf(madeB.node)),
    contentOf(madeB.node)
  )
  check(
    '两个容器都在父节点下（没有互相覆盖）',
    (mapG.root.children || []).length === 2,
    String((mapG.root.children || []).length)
  )

  // ============ G. 插入被协同吃掉时：自动重试一次，仍失败则报出是哪个节点 ============
  // 用户 2026-10-08 看到「有 1 个产物节点没落进导图」——这句太含糊，也不好受。
  console.log('--- 插入被吃掉一次：自动重试补上 ---')
  const mapH = makeMindMap()
  const boxH = await writer.createJobContainer({
    mindMap: mapH,
    nodeUid: mapH.root.getData('uid'),
    prompt: '任务内容'
  })
  dropTreeTextOnce = '附件' // 「附件」分支第一次插入被吃掉
  const outH = await writer.writeJobResultToMap({
    mindMap: mapH,
    nodeUid: boxH.uid,
    markdown: MD,
    roomKey: 'room-test',
    artifacts: []
  })
  check(
    '被吃掉一次后重试补上了（没有告警）',
    outH.nodes >= 2 && !outH.warnings.some(w => /没落进导图|没建起来/.test(w)),
    `nodes=${outH.nodes} warnings=${JSON.stringify(outH.warnings)}`
  )

  console.log('--- 重试也失败：告警要点名是哪个节点 ---')
  const mapI = makeMindMap()
  const boxI = await writer.createJobContainer({
    mindMap: mapI,
    nodeUid: mapI.root.getData('uid'),
    prompt: '任务内容'
  })
  dropTreeText = 'output/B.md' // 这个产物节点两次都落不进去
  const outI = await writer.writeJobResultToMap({
    mindMap: mapI,
    nodeUid: boxI.uid,
    markdown: MD,
    roomKey: 'room-test',
    artifacts: [
      { name: 'output/A.md', size: 10, mime: 'text/markdown', base64: Buffer.from('a').toString('base64') },
      { name: 'output/B.md', size: 10, mime: 'text/markdown', base64: Buffer.from('b').toString('base64') }
    ],
    bridgeAttach: async () => ({ ok: true, attachments: [{ ok: true, attachmentId: 'x', status: 'ready' }] })
  })
  dropTreeText = ''
  check(
    '告警里点名了没落进去的那个节点',
    outI.warnings.some(w => /没落进导图/.test(w) && /output\/B\.md/.test(w)),
    JSON.stringify(outI.warnings)
  )
  check(
    '另一个产物照常落地并挂上附件',
    outI.attachments.some(a => a.name === 'output/A.md'),
    JSON.stringify(outI.attachments.map(a => a.name))
  )

  // ============ H. 产物没挂上时，必须说清为什么（2026-10-08 用户反馈）============
  // 用户原话：「对公司的建议产物没有挂上」。
  // 以前这三条都是静默的：扫不到就当没有、读不回内容就丢掉、超过上限就截断，
  // 界面上照样报「完成」—— 现在都要点名说出来。
  console.log('--- 一个产物都没扫到：说出扫了哪里 ---')
  const mapJ = makeMindMap()
  const boxJ = await writer.createJobContainer({
    mindMap: mapJ,
    nodeUid: mapJ.root.getData('uid'),
    prompt: '对公司的建议'
  })
  const outJ = await writer.writeJobResultToMap({
    mindMap: mapJ,
    nodeUid: boxJ.uid,
    markdown: MD,
    roomKey: 'room-test',
    artifacts: [],
    artifactDiag: { runDir: '20261008-2030', dirCount: 0, sinceCount: 0 }
  })
  check(
    '没扫到产物 → 明说「只写回了正文」',
    outJ.warnings.some(w => /没扫到任何产物文件/.test(w)),
    JSON.stringify(outJ.warnings)
  )
  check(
    '告警里带上扫过哪两个地方、各命中几个',
    outJ.warnings.some(
      w =>
        /output\/20261008-2030\/（0 个）/.test(w) &&
        /output 目录里新增的文件（0 个）/.test(w)
    ),
    JSON.stringify(outJ.warnings)
  )
  const branchJ = findByText(mapJ.root.children[0].children || [], '附件')
  const branchJKids = (branchJ && branchJ.children) || []
  check(
    '正文照常写回（不能因为没产物就整条丢掉）',
    !!findPrefix(branchJKids, '完整输出'),
    JSON.stringify(texts(branchJKids))
  )

  console.log('--- 有产物但读不回内容 / 超过上限 ---')
  const mapK = makeMindMap()
  const boxK = await writer.createJobContainer({
    mindMap: mapK,
    nodeUid: mapK.root.getData('uid'),
    prompt: '任务内容'
  })
  const many = []
  for (let i = 0; i < 10; i += 1) {
    many.push({
      name: `output/P${i}.md`,
      size: 10,
      mime: 'text/markdown',
      base64: Buffer.from(`p${i}`).toString('base64')
    })
  }
  // 一个「文件在、但内容没取回来」的（后端超过 5MB 就只回名字）
  many.splice(1, 0, { name: 'output/大文件.md', size: 9 * 1024 * 1024, mime: 'text/markdown' })
  const outK = await writer.writeJobResultToMap({
    mindMap: mapK,
    nodeUid: boxK.uid,
    markdown: MD,
    roomKey: 'room-test',
    artifacts: many,
    bridgeAttach: async () => ({ ok: true, attachments: [{ ok: true, attachmentId: 'y', status: 'ready' }] })
  })
  check(
    '读不回内容的产物被点名（不再静默丢掉）',
    outK.warnings.some(w => /读不回内容、没挂附件/.test(w) && /output\/大文件\.md/.test(w)),
    JSON.stringify(outK.warnings)
  )
  check(
    '超过上限时说明只挂了前几个、剩哪些没挂',
    outK.warnings.some(w => /这次产物有 \d+ 个，只挂了前 8 个/.test(w)),
    JSON.stringify(outK.warnings)
  )
  check(
    '读不回内容的那个不会建出空节点',
    !(mapK.root.children[0].children || [])
      .flatMap(n => n.children || [])
      .some(n => String(n.getData('text')) === 'output/大文件.md'),
    '不该出现只挂名字的空节点'
  )

  // ============ I. 重渲染把节点实例换掉时，校验不能误报「命令没有落到图上」============
  // 用户 2026-10-08 直接把这条报错发回来：
  // 「写入导图失败：命令没有落到图上 —— 常见原因：① 数据没加载全 ② 没有编辑权限」。
  // 真因：插入会触发重渲染，**节点实例整批换新**，而校验读的是当初拿到的那只旧对象
  // —— 数据进树了、画布也画了，只有旧引用的 children 永远不更新 → 误报。
  console.log('--- 实例被重渲染换掉：按 uid 现查，不再误报 ---')
  swapInstances = true
  const mapS = makeMindMap()
  const boxS = await writer.createJobContainer({
    mindMap: mapS,
    nodeUid: mapS.root.getData('uid'),
    prompt: '对公司的建议'
  })
  const outS = await writer.writeJobResultToMap({
    mindMap: mapS,
    nodeUid: boxS.uid,
    markdown: MD,
    roomKey: 'room-test',
    artifacts: [
      {
        name: 'output/对公司的建议.md',
        size: 20,
        mime: 'text/markdown',
        base64: Buffer.from('hello').toString('base64')
      }
    ],
    bridgeAttach: async () => ({
      ok: true,
      attachments: [{ ok: true, attachmentId: 'sw-1', status: 'ready' }]
    })
  })
  swapInstances = false
  const liveBox = mapS.renderer.findNodeByUid(boxS.uid)
  const liveKids = (liveBox && liveBox.children) || []
  check(
    '实例被换过也能认到自己的节点（不误报「命令没有落到图上」）',
    !!outS && outS.nodes >= 2,
    JSON.stringify(outS && { nodes: outS.nodes, attachments: outS.attachments.length })
  )
  const liveBranch = (liveKids || []).find(n => n.getData('text') === '附件')
  check(
    '活着的容器里确实有「附件」分支',
    !!liveBranch,
    JSON.stringify((liveKids || []).map(n => n.getData('text')))
  )
  check(
    '「附件」里有产物节点 + 完整输出',
    !!liveBranch &&
      ['output/对公司的建议.md', '完整输出.md'].every(name =>
        ((liveBranch.children || []).some(n => n.getData('text') === name))
      ),
    JSON.stringify(((liveBranch && liveBranch.children) || []).map(n => n.getData('text')))
  )
  check(
    '两个附件都挂上了（引用失效也不能漏挂）',
    (outS.attachments || []).length === 2,
    JSON.stringify(outS.attachments.map(a => a.name))
  )

  // 报错也要能说清现场（只读 / 暂停 / 落点状态），而不是只讲「常见原因」
  console.log('--- 真没落图时：报错带上现场事实 ---')
  const mapT = makeMindMap()
  const boxT = await writer.createJobContainer({
    mindMap: mapT,
    nodeUid: mapT.root.getData('uid'),
    prompt: '任务内容'
  })
  dropInserts = true
  let insertErr = ''
  try {
    await writer.writeJobResultToMap({
      mindMap: mapT,
      nodeUid: boxT.uid,
      markdown: MD,
      roomKey: 'room-test',
      artifacts: [],
      bridgeAttach: async () => ({ ok: true, attachments: [] })
    })
  } catch (err) {
    insertErr = (err && err.message) || ''
  }
  dropInserts = false
  check(
    '报错里带上落点与子节点数（能判断是哪种情况）',
    /命令没有落到图上/.test(insertErr) && /落点「[^」]*」现在有 \d+ 个子节点/.test(insertErr),
    insertErr
  )

  // ============ J. 探针：这条运行的结果在不在图上（刷新后自动补写的判据）============
  // 2026-10-09 用户要求：识别到任务内容没挂在节点、且运行完成 → 刷新后自动重写。
  // 判据必须看**图上的真实结构**，不能看记录里的标志位。
  console.log('--- 探针：结果在不在图上 ---')
  const mapP = makeMindMap()
  const boxP = await writer.createJobContainer({
    mindMap: mapP,
    nodeUid: mapP.root.getData('uid'),
    prompt: '对公司的建议'
  })
  const probeBare = writer.inspectJobResult({ mindMap: mapP, nodeUid: boxP.uid })
  check(
    '只有容器（还没写回）→ 认得出「任务内容在、结果不在」',
    probeBare.exists && probeBare.hasTaskContent && !probeBare.hasAttach,
    JSON.stringify(probeBare)
  )
  await writer.writeJobResultToMap({
    mindMap: mapP,
    nodeUid: boxP.uid,
    markdown: MD,
    roomKey: 'room-test',
    artifacts: [
      {
        name: 'output/建议.md',
        size: 10,
        mime: 'text/markdown',
        base64: Buffer.from('x').toString('base64')
      }
    ],
    bridgeAttach: async () => ({
      ok: true,
      attachments: [{ ok: true, attachmentId: 'pp-1', status: 'ready' }]
    })
  })
  const probeFull = writer.inspectJobResult({ mindMap: mapP, nodeUid: boxP.uid })
  check(
    '写完之后 → 附件 / 完整输出 / 产物都认得到',
    probeFull.hasAttach &&
      probeFull.hasFullOutput &&
      probeFull.artifactNames.includes('output/建议.md'),
    JSON.stringify(probeFull)
  )
  check(
    '节点不在（或 uid 不对）→ exists=false，不会误判成「已写」',
    (() => {
      const miss = writer.inspectJobResult({ mindMap: mapP, nodeUid: 'no-such-uid' })
      return miss.ok && miss.exists === false
    })(),
    ''
  )

  // 接线：Toolbar 发 probe_job_result，Edit.vue 接住并调 inspectJobResult
  console.log('--- 接线（防止事件名写错、功能静默不生效）---')
  const toolbarSrc = fs.readFileSync(
    path.join(WEB, 'src/pages/Edit/components/Toolbar.vue'),
    'utf8'
  )
  const editSrc = fs.readFileSync(path.join(WEB, 'src/pages/Edit/components/Edit.vue'), 'utf8')
  check(
    'Toolbar 发的是 probe_job_result（带 result 回填盒）',
    toolbarSrc.includes("$bus.$emit('probe_job_result'") &&
      toolbarSrc.includes('result: box'),
    ''
  )
  check(
    'Edit.vue 注册了 probe_job_result，用 inspectJobResult 且透传 nodeTitle',
    editSrc.includes("$bus.$on('probe_job_result', this.onProbeJobResult)") &&
      editSrc.includes('inspectJobResult({') &&
      editSrc.includes('nodeTitle: data.nodeTitle'),
    ''
  )
  check(
    'Toolbar 发 probe_job_ack 问「我的节点服务端确认了吗」',
    toolbarSrc.includes("$bus.$emit('probe_job_ack'") &&
      toolbarSrc.includes('async probeJobAcks('),
    ''
  )
  check(
    'Edit.vue 注册了 probe_job_ack，并用 ackedUids/pendingUids 给结论',
    editSrc.includes("$bus.$on('probe_job_ack', this.onProbeJobAck)") &&
      editSrc.includes('cooperate.isPersistAcked(uid)') &&
      editSrc.includes('cooperate.pendingUids'),
    ''
  )
  {
    const verifyBody = toolbarSrc.slice(
      toolbarSrc.indexOf('async verifyWritePersisted'),
      toolbarSrc.indexOf('async pushJobResultWithRetry')
    )
    check(
      '判同步按「我这次插的节点」下结论（拿不到逐 uid 判据才回退队列口径）',
      /probeJobAcks\(/.test(verifyBody) &&
        /ack\.hasApi/.test(verifyBody) &&
        /via: 'ack'/.test(verifyBody) &&
        /via: 'queue'/.test(verifyBody),
      ''
    )
  }
  check(
    '刷新后会调度自动补写（mounted 里挂了）',
    /this\.scheduleAutoRepair\(\)/.test(toolbarSrc) &&
      /autoRepairUnwrittenRuns/.test(toolbarSrc),
    ''
  )

  // ---- 写回结果要带出「本次牵涉的节点 uid」（给「服务端确认了没有」当判据用）----
  // 2026-10-09：判同步不能再看客户端队列的全局积压（服务器 outbox 积压两万多条 → 全误报），
  // 必须逐节点问服务端 —— 那写回就得把 uid 交出来（inserted = 本次新插的，ensured = 写完后应该在的）
  {
    const mapU = makeMindMap()
    const containerU = await writer.createJobContainer({
      mindMap: mapU,
      nodeUid: mapU.root.getData('uid'),
      prompt: '任务内容'
    })
    const outU = await writer.writeJobResultToMap({
      mindMap: mapU,
      nodeUid: containerU.uid,
      markdown: MD,
      roomKey: 'room-test',
      artifacts: [{ name: 'a.txt', size: 3, mime: 'text/plain', base64: 'YQ==' }]
    })
    check(
      '写回结果带出 insertedUids / ensuredUids 两串 uid',
      Array.isArray(outU.insertedUids) && Array.isArray(outU.ensuredUids),
      JSON.stringify({ i: outU.insertedUids, e: outU.ensuredUids })
    )
    const kidsU = ((findByText(mapU.root.children || [], '附件 · uid') || {}).children) || null
    // 容器下就是「附件」分支；找它和它下面的节点
    const boxU = mapU.root.children.find(
      item => item.getData('uid') === containerU.uid
    )
    const attachU = findByText((boxU && boxU.children) || [], '附件')
    const mdU = findByText((attachU && attachU.children) || [], '完整输出.md')
    const fileU = findByText((attachU && attachU.children) || [], 'a.txt')
    const inserted = outU.insertedUids || []
    check(
      '新插的节点（附件分支 / 产物 / 完整输出）都在 insertedUids 里',
      !!attachU &&
        !!mdU &&
        !!fileU &&
        inserted.indexOf(attachU.getData('uid')) !== -1 &&
        inserted.indexOf(mdU.getData('uid')) !== -1 &&
        inserted.indexOf(fileU.getData('uid')) !== -1,
      JSON.stringify(inserted)
    )
    check(
      'ensuredUids 覆盖容器 + 所有新插的节点',
      (outU.ensuredUids || []).indexOf(containerU.uid) !== -1 &&
        inserted.every(uid => outU.ensuredUids.indexOf(uid) !== -1),
      JSON.stringify(outU.ensuredUids)
    )
    void kidsU
  }

  // ---- uid 过期（重连/整树恢复后节点换了 uid）→ 按标题找回落点，别报「找不到节点」----
  // 2026-10-09 用户反馈：「还是显示找不到节点 可能已经删掉了，但是实际上已经写入了」
  {
    const mapT = makeMindMap()
    const made = await writer.createJobContainer({
      mindMap: mapT,
      nodeUid: mapT.root.getData('uid'),
      prompt: '任务内容：X'
    })
    const staleUid = made.uid
    const title = String(made.node.getData('text') || '')
    // 模拟「uid 过期」：节点实例还在图上，但 uid 被换掉了
    made.node.nodeData.data.uid = 'uid-reborn-1'

    let threwT = ''
    let outT = null
    try {
      outT = await writer.writeJobResultToMap({
        mindMap: mapT,
        nodeUid: staleUid,
        nodeTitle: title,
        markdown: MD,
        roomKey: 'room-test',
        artifacts: []
      })
    } catch (err) {
      threwT = (err && err.message) || String(err)
    }
    check('uid 过期时按标题找回原容器，不再报「找不到节点」', !threwT && !!outT, threwT)
    check(
      '写进的是那个老容器（没新建第二个任务容器）',
      !!outT &&
        outT.containerUid === 'uid-reborn-1' &&
        mapT.root.children.filter(item => writer.isTaskContainerNode(item)).length === 1,
      outT ? String(outT.containerUid) : ''
    )

    const insp = writer.inspectJobResult({
      mindMap: mapT,
      nodeUid: staleUid,
      nodeTitle: title
    })
    check(
      '探针：uid 过期也能按标题找到，并回报真实 uid（供记录修正）',
      insp.exists === true &&
        insp.resolvedBy === 'title' &&
        insp.uid === 'uid-reborn-1' &&
        insp.hasFullOutput === true,
      JSON.stringify(insp)
    )

    let threw2 = ''
    try {
      await writer.writeJobResultToMap({
        mindMap: mapT,
        nodeUid: 'uid-nowhere',
        markdown: MD,
        roomKey: 'room-test'
      })
    } catch (err) {
      threw2 = (err && err.message) || String(err)
    }
    check(
      '没有标题可兜底时仍然报错，并把 uid 写进报错里',
      /找不到运行的那个节点/.test(threw2) && /uid-nowhere/.test(threw2),
      threw2
    )
  }

  const failed = results.filter(item => !item.ok)
  console.log(
    `\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`
  )
  if (failed.length) {
    failed.forEach(item => console.log('  FAIL:', item.name))
    process.exit(1)
  }
}

main().catch(err => {
  console.error('测试自身出错:', err)
  process.exit(1)
})
