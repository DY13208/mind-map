import { formatGetNodeGeneralization } from 'simple-mind-map/src/utils/index'
import { plainText, noteOf } from './flowSearch'

const MAX_OUTLINE_NODES = 1200
const MAX_PROMPT_CHARS = 120000

function uidOf(node) {
  if (!node) return ''
  return node.uid || (node.getData && node.getData('uid')) || ''
}

export function nodeUid(node) {
  return uidOf(node)
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

function lineFor(node, depth = 0) {
  const pad = '  '.repeat(depth)
  const title = plainText(node) || '(空)'
  const uid = uidOf(node)
  const note = noteOf(node)
  let line = `${pad}- ${title}${uid ? ` [${uid}]` : ''}`
  if (note) line += ` （备注: ${String(note).slice(0, 120)}）`
  return line
}

function outlineFromData(nodeData, depth, maxDepth, counter) {
  if (!nodeData || depth > maxDepth || counter.count >= MAX_OUTLINE_NODES) {
    return []
  }
  counter.count++
  const text = stripHtml(nodeData.data && nodeData.data.text) || '(空)'
  const lines = [`${'  '.repeat(depth)}- ${text}`]
  const note = nodeData.data && nodeData.data.note
  if (note) {
    lines.push(
      `${'  '.repeat(depth + 1)}(备注: ${String(note).slice(0, 120)})`
    )
  }
  ;(nodeData.children || []).forEach(child => {
    lines.push(...outlineFromData(child, depth + 1, maxDepth, counter))
  })
  return lines
}

function subtreeOutline(node, depth, maxDepth, counter) {
  if (!node || depth > maxDepth || counter.count >= MAX_OUTLINE_NODES) {
    return []
  }
  counter.count++
  const lines = [lineFor(node, depth)]

  if (node.getData) {
    const genList = formatGetNodeGeneralization(node.getData())
    genList.forEach(item => {
      if (counter.count >= MAX_OUTLINE_NODES) return
      const gText = stripHtml(item.text)
      if (!gText) return
      counter.count++
      lines.push(`${'  '.repeat(depth + 1)}- [概要] ${gText}`)
      ;(item.children || []).forEach(child => {
        lines.push(...outlineFromData(child, depth + 2, maxDepth, counter))
      })
    })
  }

  const kids = node.children || []
  if (kids.length) {
    kids.forEach(child => {
      lines.push(...subtreeOutline(child, depth + 1, maxDepth, counter))
    })
  } else if (node.nodeData && node.nodeData.children) {
    node.nodeData.children.forEach(child => {
      lines.push(...outlineFromData(child, depth + 1, maxDepth, counter))
    })
  }
  return lines
}

function ancestorPath(node) {
  const lines = []
  let cur = node
  while (cur) {
    lines.unshift(lineFor(cur, 0))
    cur = cur.parent
  }
  return lines
}

function ancestorTitles(node) {
  const titles = []
  let cur = node
  while (cur) {
    const t = plainText(cur)
    if (t) titles.unshift(t)
    cur = cur.parent
  }
  return titles
}

/** 岗位文案 → 更可能归属的部门关键词 */
function departmentHintsForPosition(query, position) {
  const q = `${query || ''} ${position || ''}`
  const hints = []
  if (/天猫|淘宝|京东|拼多多|抖音电商|电商|运营|店铺|直通车/.test(q)) {
    hints.push('运营', '电商', '天猫', '营销', '增长')
  }
  if (/\bITBP\b|信息|信息化|系统|研发|技术|AI|算法|数据/.test(q)) {
    hints.push('AI', '技术', '研发', 'IT', '信息', '数据')
  }
  if (/\bHRBP\b|人事|人力|招聘专员/.test(q)) {
    hints.push('人事', '人力', 'HR')
  }
  if (/财务|会计|出纳/.test(q)) hints.push('财务')
  if (/法务|律师/.test(q)) hints.push('法务')
  if (/产品经理|产品运营(?!店铺)/.test(q)) hints.push('产品')
  return hints
}

function findDepartmentByHints(root, hints, maxVisit = 6000) {
  if (!root || !hints.length) return ''
  let best = ''
  let bestScore = 0
  let n = 0
  const queue = [root]
  while (queue.length && n < maxVisit) {
    const cur = queue.shift()
    if (!cur) continue
    n++
    const t = plainText(cur)
    const isDept =
      /部$|部门$|中心$|事业部/.test(t) &&
      !/招聘部门|提交|提供|模块|概要|公司模型|日常|业务|SOP|负责人/i.test(t)
    if (isDept) {
      let score = 0
      hints.forEach(h => {
        if (t.includes(h)) score += h.length >= 2 ? 3 : 1
      })
      // 精确一点：运营部 / 电商部 对天猫
      if (score > bestScore) {
        bestScore = score
        best = t
      }
    }
    ;(cur.children || []).forEach(c => queue.push(c))
    if (
      (!cur.children || !cur.children.length) &&
      cur.nodeData &&
      cur.nodeData.children
    ) {
      cur.nodeData.children.forEach(raw => queue.push(wrapDataNode(raw, cur)))
    }
  }
  return bestScore > 0 ? best : ''
}

/** 从路径/岗位/导图部门节点提取填值事实 */
export function extractMapFillFacts(mindMap, targetNode) {
  const facts = {
    department: '',
    company: '',
    city: '',
    path: ancestorTitles(targetNode),
    departmentSource: ''
  }
  const query = plainText(targetNode)
  const root = mindMap && mindMap.renderer && mindMap.renderer.root

  const isDept = t =>
    /部$|部门$|中心$|事业部|BG$|线$/.test(t) &&
    !/招聘部门|提交|提供|模块|概要|公司模型|日常|业务|SOP|负责人/i.test(t)

  // 岗位 / 职级
  if (/初级/.test(query)) facts.level = '初级'
  else if (/中级/.test(query)) facts.level = '中级'
  else if (/高级|资深/.test(query)) facts.level = '高级'
  const pos = query.match(
    /招聘(?:一个|一名|一位)?\s*([A-Za-z0-9\u4e00-\u9fa5]{2,})/i
  )
  if (pos) {
    facts.position = pos[1].replace(/^(初级|中级|高级)/, '') || pos[1]
  }
  if (/\bITBP\b/i.test(query)) facts.position = 'ITBP'
  if (/\bHRBP\b/i.test(query)) facts.position = 'HRBP'
  if (/天猫运营/.test(query)) facts.position = '天猫运营'

  // 祖先路径上的部门（仅作候选，不直接全局扫图乱取）
  let ancestorDept = ''
  for (let i = facts.path.length - 1; i >= 0; i--) {
    const t = facts.path[i]
    if (!ancestorDept && isDept(t)) ancestorDept = t
    if (!facts.company && /(有限公司|科技|良策|工程)/.test(t) && t.length >= 2) {
      facts.company = t
    }
  }

  const hints = departmentHintsForPosition(query, facts.position)
  const hintedDept = findDepartmentByHints(root, hints)

  // 部门决策：
  // 1) 导图里存在与岗位匹配的部门（如天猫运营 → 运营部）→ 优先用
  // 2) 否则用祖先路径部门（如 ITBP 挂在 AI部下）
  // 3) 祖先部门与岗位明显冲突时（天猫运营 vs AI部）→ 不用祖先，改用岗位默认部门名
  const conflict =
    ancestorDept &&
    hints.length &&
    !hints.some(h => ancestorDept.includes(h)) &&
    /天猫|淘宝|电商|运营|财务|法务|人事/.test(
      `${query} ${facts.position || ''}`
    )

  if (hintedDept) {
    facts.department = hintedDept
    facts.departmentSource = '导图匹配部门'
  } else if (ancestorDept && !conflict) {
    facts.department = ancestorDept
    facts.departmentSource = '节点路径'
  } else if (conflict || (!ancestorDept && hints.length)) {
    // 岗位默认部门名（导图未必有该节点）
    if (/天猫|淘宝|京东|电商|运营/.test(`${query} ${facts.position || ''}`)) {
      facts.department = '运营部'
      facts.departmentSource = '按岗位推断'
    } else if (/\bHRBP\b|人事/.test(`${query} ${facts.position || ''}`)) {
      facts.department = '人事部'
      facts.departmentSource = '按岗位推断'
    } else if (conflict) {
      // 仍冲突又没有更好匹配时，不强行用 AI部
      facts.department = ''
      facts.departmentSource = '路径部门与岗位冲突，交由模型判断'
    }
  }

  // 公司 / 城市：只在父分支局部扫，避免整图噪声
  const scanRoots = []
  if (targetNode && targetNode.parent) scanRoots.push(targetNode.parent)
  if (targetNode && targetNode.parent && targetNode.parent.parent) {
    scanRoots.push(targetNode.parent.parent)
  }
  const seen = new Set()
  scanRoots.forEach(r => {
    if (!r || seen.has(r)) return
    seen.add(r)
    let n = 0
    const queue = [r]
    while (queue.length && n < 400) {
      const cur = queue.shift()
      if (!cur) continue
      n++
      const t = plainText(cur)
      if (
        !facts.company &&
        /(有限公司|股份|集团|良策)/.test(t) &&
        t.length >= 2 &&
        t.length <= 40
      ) {
        facts.company = t
      }
      if (!facts.city) {
        const m = t.match(/(深圳|北京|上海|广州|杭州|成都|武汉|西安|苏州)/)
        if (m) facts.city = m[1]
      }
      ;(cur.children || []).forEach(c => queue.push(c))
    }
  })

  return facts
}

function formatFactsBlock(facts) {
  const lines = [
    '## 已从导图/岗位提取的事实（填值时优先采用）'
  ]
  if (facts.path && facts.path.length) {
    lines.push(`节点路径：${facts.path.join(' → ')}`)
  }
  if (facts.department) {
    lines.push(
      `招聘部门：${facts.department}${
        facts.departmentSource ? `（来源：${facts.departmentSource}）` : ''
      }`
    )
  } else {
    lines.push(
      '招聘部门：未确定（勿因测试节点挂在 AI部下就填 AI部；按岗位归属填写）'
    )
  }
  if (facts.company) lines.push(`公司主体：${facts.company}`)
  if (facts.position) lines.push(`招聘岗位：${facts.position}`)
  if (facts.level) lines.push(`职级：${facts.level}`)
  if (facts.city) lines.push(`招聘城市：${facts.city}`)
  lines.push(
    '注意：ITBP≠IT部门；天猫运营≠AI部。部门按岗位业务归属，不要复用无关路径上的部门。'
  )
  return lines.join('\n')
}

function wrapDataNode(raw, parent) {
  if (!raw) return null
  if (raw.getData) return raw
  return {
    nodeData: raw,
    data: raw.data,
    parent,
    children: [],
    getData(key) {
      if (key == null) return this.nodeData && this.nodeData.data
      return this.nodeData && this.nodeData.data && this.nodeData.data[key]
    }
  }
}

function walkFind(node, visit, maxVisit = 20000) {
  const queue = [node]
  let n = 0
  while (queue.length && n < maxVisit) {
    const cur = queue.shift()
    if (!cur) continue
    n++
    if (visit(cur)) return cur
    const kids = cur.children || []
    for (let i = 0; i < kids.length; i++) queue.push(kids[i])
    if ((!kids || !kids.length) && cur.nodeData && cur.nodeData.children) {
      for (const raw of cur.nodeData.children) {
        queue.push(wrapDataNode(raw, cur))
      }
    }
  }
  return null
}

function walkFindCollect(node, visit, out, maxVisit = 20000) {
  const queue = [node]
  let n = 0
  while (queue.length && n < maxVisit) {
    const cur = queue.shift()
    if (!cur) continue
    n++
    if (visit(cur)) out.push(cur)
    const kids = cur.children || []
    for (let i = 0; i < kids.length; i++) queue.push(kids[i])
    if ((!kids || !kids.length) && cur.nodeData && cur.nodeData.children) {
      for (const raw of cur.nodeData.children) {
        queue.push(wrapDataNode(raw, cur))
      }
    }
  }
  return out
}

function countSubtreeNodes(node) {
  let count = 0
  const stack = [node]
  while (stack.length) {
    const cur = stack.pop()
    if (!cur) continue
    count++
    ;(cur.children || []).forEach(c => stack.push(c))
    if (cur.getData) {
      formatGetNodeGeneralization(cur.getData()).forEach(g => {
        count++
        const walkData = list => {
          ;(list || []).forEach(item => {
            count++
            walkData(item.children)
          })
        }
        walkData(g.children)
      })
    }
  }
  return count
}

function findSopRoot(root) {
  if (!root) return null
  for (const child of root.children || []) {
    const t = plainText(child)
    if (/^sop$/i.test(t) || /^sop\b/i.test(t)) return child
    for (const grand of child.children || []) {
      const gt = plainText(grand)
      if (/^sop$/i.test(gt) || /^sop\b/i.test(gt)) return grand
      for (const great of grand.children || []) {
        const ggt = plainText(great)
        if (/^sop$/i.test(ggt) || /^sop\b/i.test(ggt)) return great
      }
    }
  }
  return (
    walkFind(root, n => /^sop$/i.test(plainText(n)), 25000) ||
    walkFind(root, n => /^sop\b/i.test(plainText(n)), 25000)
  )
}

export function findRelevantSopTemplate(sopNode, query) {
  if (!sopNode) return null
  const q = String(query || '')
  const keywords = []
  if (/招聘|hrbp|itbp|offer|jd|用人|逐鹿/i.test(q)) keywords.push('招聘')
  if (/入职/.test(q)) keywords.push('入职')
  if (/离职/.test(q)) keywords.push('离职')
  if (/审批/.test(q)) keywords.push('审批')
  if (!keywords.length) {
    const words = q.match(/[\u4e00-\u9fa5]{2,}/g) || []
    keywords.push(...words.slice(0, 3))
  }

  for (const kw of keywords) {
    const candidates = []
    walkFindCollect(
      sopNode,
      n => n !== sopNode && plainText(n) === kw,
      candidates,
      12000
    )
    if (candidates.length) {
      candidates.sort((a, b) => countSubtreeNodes(b) - countSubtreeNodes(a))
      return candidates[0]
    }
  }
  for (const kw of keywords) {
    const hit = walkFind(
      sopNode,
      n => {
        if (n === sopNode) return false
        return plainText(n).includes(kw)
      },
      12000
    )
    if (hit) return hit
  }
  return sopNode
}

export function resolveSopTemplate(mindMap, targetNode) {
  const root = mindMap && mindMap.renderer && mindMap.renderer.root
  const query = plainText(targetNode)
  const sopNode = findSopRoot(root)
  if (!sopNode) {
    return { sopNode: null, templateNode: null, query }
  }
  const templateNode = findRelevantSopTemplate(sopNode, query)
  return { sopNode, templateNode, query }
}

function pruneNodeToJson(node, depth, maxDepth, counter) {
  if (!node || depth > maxDepth || counter.count >= MAX_OUTLINE_NODES) {
    return null
  }
  counter.count++
  const out = { text: plainText(node) || '(空)' }
  const note = noteOf(node)
  if (note) out.note = String(note).slice(0, 120)

  if (node.getData) {
    const genList = formatGetNodeGeneralization(node.getData())
    if (genList.length) {
      out.generalization = genList.map(item => {
        const g = { text: stripHtml(item.text) }
        if (item.note) g.note = String(item.note).slice(0, 120)
        if (item.children && item.children.length) {
          g.children = item.children
            .map(c => dataNodeToJson(c, depth + 1, maxDepth, counter))
            .filter(Boolean)
        }
        return g
      })
    }
  }

  const kids = node.children || []
  if (kids.length) {
    const mapped = kids
      .map(c => pruneNodeToJson(c, depth + 1, maxDepth, counter))
      .filter(Boolean)
    if (mapped.length) out.children = mapped
  } else if (node.nodeData && node.nodeData.children) {
    const mapped = node.nodeData.children
      .map(c => dataNodeToJson(c, depth + 1, maxDepth, counter))
      .filter(Boolean)
    if (mapped.length) out.children = mapped
  }
  return out
}

function dataNodeToJson(nodeData, depth, maxDepth, counter) {
  if (!nodeData || depth > maxDepth || counter.count >= MAX_OUTLINE_NODES) {
    return null
  }
  counter.count++
  const out = {
    text: stripHtml(nodeData.data && nodeData.data.text) || '(空)'
  }
  if (nodeData.data && nodeData.data.note) {
    out.note = String(nodeData.data.note).slice(0, 120)
  }
  const kids = (nodeData.children || [])
    .map(c => dataNodeToJson(c, depth + 1, maxDepth, counter))
    .filter(Boolean)
  if (kids.length) out.children = kids
  return out
}

export const FLOW_EXPAND_SYSTEM = `你是良策思维导图流程补齐助手，通过 WorkBuddy 完成实例化。

工作方式（按优先级）：
1. 若提供了 SOP 流程模板：必须逐层照抄其文案、层级、概要与步骤
2. 若没有明确 SOP 模板：根据导图内【全部节点内容】硬编一套完整、可执行的流程子树
3. 必须调用 add_mindmap_children 返回 children
4. 不要修改待补充节点标题，不要输出「分支主题」

【数据字段必须填满 — 最高优先级】
「提供 / 模块 / 字段」下的每一个叶子数据项，返回时都必须写成「字段名：具体值」，禁止只输出字段名空壳。

推断规则：
- 能从待补充节点文案推断的必须填（例：「招聘一个初级ITBP」→ 招聘岗位：ITBP、职级：初级、招聘人数：1）
- 【强制】招聘部门、公司主体必须以「已从导图提取的事实」和节点路径为准；严禁因岗位含 IT/HR 就猜成 IT部门/HR部门
- 导图其它节点已出现的公司名、部门名等要复用
- 推不出的基础字段也必须给合理默认值，例如：
  - 性别要求：不限
  - 招聘人数：1
  - 工作性质：全职
  - 招聘城市：深圳（或导图中出现的城市）
  - 招聘原因：新增岗位
  - 硬性要求：按岗位写 2～4 条可执行要求（学历/经验/技能），不能留空
  - 试用期带教导师：待指定
  - 新人试用期成长计划表：待补充
有选项子节点的字段（如职级下的初级/中级）：父节点写成「职级：初级」，选项子节点可保留或只保留已选项

【代办人节点 — 必须补充】
在「提供 / 模块」数据区之后（或与之同级、紧接其后），必须接一个「代办人」节点，格式固定为：
- 代办人：具体人名或角色（优先该部门负责人 / 对应 BP，结合导图事实）
不要只写「代办人」空壳，必须带冒号和具体值

【禁止复制的内容 — 必须遵守】
- 禁止在 children 中出现名为「SOP」的节点（这是导图索引，不是实例内容）
- 禁止复制系统/工具清单（如金蝶、吉客云、企业微信、品牌立项、线上运营等目录项）
- 只输出与当前待补充节点直接相关的执行步骤、数据字段与代办人
- 若 SOP 模板中含与当前节点无关的分支，必须裁剪，不得整棵照搬`

/**
 * 一律交给 WorkBuddy：
 * - 有 SOP 模板：重点投喂模板 + 目标节点
 * - 无 SOP：投喂尽量多的整图节点，让 AI 硬编
 */
export function buildFlowExpandPrompt(mindMap, targetNode) {
  const root = mindMap.renderer && mindMap.renderer.root
  const query = plainText(targetNode)
  const { sopNode, templateNode } = resolveSopTemplate(mindMap, targetNode)
  const hasTemplate =
    templateNode &&
    ((templateNode.children && templateNode.children.length) ||
      (templateNode.nodeData &&
        templateNode.nodeData.children &&
        templateNode.nodeData.children.length))

  const sections = []
  const facts = extractMapFillFacts(mindMap, targetNode)

  sections.push(
    [
      '## 待补充节点（实例化目标）',
      lineFor(targetNode, 0),
      '路径：',
      ancestorPath(targetNode).join('\n'),
      targetNode.children && targetNode.children.length
        ? `当前已有子节点（可整棵替换）：\n${targetNode.children
            .slice(0, 40)
            .map(c => lineFor(c, 1))
            .join('\n')}`
        : '当前已有子节点：(无)'
    ].join('\n')
  )

  sections.push(formatFactsBlock(facts))

  // 父分支局部上下文（跳过 SOP 索引等无关兄弟分支）
  if (targetNode && targetNode.parent) {
    const ctxCounter = { count: 0 }
    const branchRoot =
      (targetNode.parent.parent && targetNode.parent.parent) ||
      targetNode.parent
    const branchLines = []
    const appendBranch = (node, depth) => {
      if (!node || depth > 6 || ctxCounter.count >= MAX_OUTLINE_NODES) return
      const title = plainText(node)
      if (
        depth > 0 &&
        (/^sop$/i.test(title) ||
          /^系统|^工具|金蝶|吉客云|企业微信/.test(title))
      ) {
        return
      }
      branchLines.push(...subtreeOutline(node, depth, 6, ctxCounter))
    }
    ;(branchRoot.children || []).forEach(child => appendBranch(child, 0))
    if (!branchLines.length) {
      appendBranch(branchRoot, 0)
    }
    sections.push(
      [
        '## 目标所在分支上下文（请从中读取部门/公司；勿复制 SOP 索引）',
        branchLines.join('\n') || '(空)'
      ].join('\n')
    )
  }

  if (hasTemplate) {
    const outlineCounter = { count: 0 }
    sections.push(
      [
        `## SOP 流程模板（入口：${plainText(templateNode)}）— 优先照抄`,
        subtreeOutline(templateNode, 0, 10, outlineCounter).join('\n') || '(空)'
      ].join('\n')
    )
    const jsonCounter = { count: 0 }
    const jsonTree = pruneNodeToJson(templateNode, 0, 10, jsonCounter)
    if (jsonTree) {
      sections.push(
        [
          '## SOP 结构化 JSON（含概要）',
          JSON.stringify(jsonTree, null, 2).slice(0, 45000)
        ].join('\n')
      )
    }
  } else if (sopNode) {
    const outlineCounter = { count: 0 }
    sections.push(
      [
        '## 已找到 SOP，但未精确匹配子流程；以下为 SOP 子树，请自行对齐后实例化或硬编',
        subtreeOutline(sopNode, 0, 10, outlineCounter).join('\n') || '(空)'
      ].join('\n')
    )
  } else {
    sections.push(
      '## SOP\n未找到名为 SOP 的节点。请根据下方【导图全部节点】硬编完整流程。'
    )
  }

  // 有 SOP 时不再整图投喂（太大易导致 tool 参数截断解析失败）
  // 无 SOP 时才附带有限导图内容供硬编
  if (!hasTemplate && root) {
    const mapCounter = { count: 0 }
    const mapOutline = subtreeOutline(root, 0, 10, mapCounter).join('\n')
    sections.push(
      [
        '## 导图节点（供硬编素材，已限深）',
        mapOutline || '(空)'
      ].join('\n')
    )
  } else if (hasTemplate && root) {
    // 只附一级分支名，帮助定位公司/部门等词
    sections.push(
      [
        '## 导图一级分支（辅助填值）',
        (root.children || [])
          .slice(0, 40)
          .map(c => lineFor(c, 0))
          .join('\n')
      ].join('\n')
    )
  }

  let body = sections.join('\n\n')
  if (body.length > MAX_PROMPT_CHARS) {
    body = body.slice(0, MAX_PROMPT_CHARS) + '\n…(内容过长已截断)'
  }

  const modeHint = hasTemplate
    ? `请仅照抄 SOP「${plainText(templateNode)}」中与「${query}」相关的步骤到该节点下；填满提供字段；禁止挂载 SOP 索引、系统工具清单或其它无关分支。招聘部门以提取事实为准。`
    : `未命中可用 SOP 模板。请基于导图上下文硬编完整流程；部门按岗位业务归属填写；禁止输出 SOP 索引节点。`

  const user = [
    modeHint,
    facts.department
      ? `硬性：招聘部门：${facts.department}（${facts.departmentSource || '已推断'}）`
      : '硬性：招聘部门按岗位归属填写，禁止无依据写成 AI部。',
    '再次强调：性别要求、招聘人数、硬性要求等基础项不能留空；数据区之后必须接「代办人：xxx」节点。',
    '',
    body,
    '',
    '请调用 add_mindmap_children 返回 children。'
  ].join('\n')

  return {
    system: FLOW_EXPAND_SYSTEM,
    user,
    hasTemplate: !!hasTemplate,
    templateLabel: hasTemplate ? plainText(templateNode) : '',
    sopLabel: sopNode ? plainText(sopNode) : '',
    facts
  }
}
