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
let slowLand = false
let seq = 0
function makeNode(text) {
  seq += 1
  const node = {
    nodeData: { data: { text, uid: `uid-${seq}` } },
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
  const made = makeNode((tree.data && tree.data.text) || '')
  made.parent = parent
  parent.children.push(made)
  ;(tree.children || []).forEach(child => attachTree(made, child))
  return made
}
function makeMindMap() {
  const map = {
    renderCount: 0,
    cmds: [],
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
        // 引擎的签名是 (nodeList, trees) —— 第一个参数是数组
        const parents = args[0]
        const trees = args[1]
        const parent = Array.isArray(parents) ? parents[0] : parents
        const list = trees || []
        if (slowLand && list.length > 1) {
          attachTree(parent, list[0])
          setTimeout(() => {
            list.slice(1).forEach(tree => attachTree(parent, tree))
          }, 30)
          return
        }
        list.forEach(tree => attachTree(parent, tree))
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
