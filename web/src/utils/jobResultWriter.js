/**
 * 运行结果写回脑图。
 *
 * 一次运行（工具栏「运行」派发的，或运行历史里「继续执行」派的）跑完之后：
 *   1. 落点一定是「任务 · 时间」容器 —— 运行输出紧跟任务内容，不会甩到 SOP 末尾；
 *   2. 结果节点下**只放提炼过的核心**（结论 / 待补充数据 / 产出），不把整篇塞进脑图；
 *   3. 缺什么数据单独列成「❗待补充数据」分支，一眼看到要补什么；
 *   4. 完整回答另存 .md 附件，运行产出的文件各建一个子节点并挂上附件。
 */
import { uploadNodeAttachment } from './nodeAttachmentApi'
import { nodeUid } from './flowExpandPrompt'

// —— 提炼上限：脑图要能一眼看完，细节留给附件 ——
const POINT_LIMIT = 6
const MISSING_LIMIT = 8
const DELIVER_LIMIT = 6
const EXTRA_SECTION_LIMIT = 1
const EXTRA_POINT_LIMIT = 6
const TABLE_ROW_LIMIT = 6
const NODE_TEXT_LIMIT = 90
/** 完整展开时单条节点的显示上限：比提炼版宽，超过的原文进 note（点开能看全） */
const FULL_TEXT_LIMIT = 160
/** 完整展开的节点总数上限：防止一篇超长回答把导图撑爆 */
const MAX_FULL_NODES = 400
// 一段太长就按句子拆成几条（不是砍掉），最多留几条
const SENTENCE_PER_ITEM = 4
const MAX_NODES = 40
const MAX_ARTIFACT_FILES = 8
// 单个产物超过这个大小就只记名字，不做附件上传（浏览器 base64 + 续传都吃不消）
const MAX_ATTACH_BYTES = 5 * 1024 * 1024
const ATTACH_TEXT_LIMIT = 2400

/**
 * 运行结果是否在脑图上**铺成节点树**。
 *
 * 2026-10-08 用户要求结构是「任务 → 附件 → 完整输出 | 产物」——所以默认**不铺**：
 * 不再建「运行输出 · 时间」这一层，正文完整地放进「完整输出.md」附件里。
 * 想恢复旧的「按章节原样铺开」形态，把这里改成 true 即可。
 */
const INLINE_RESULT_NODES = false

export const MISSING_BRANCH_TITLE = '❗待补充数据'
// 附件（全文 + 产物文件）统一挂在这个分支下，排在「产出」节点后面
export const ATTACH_BRANCH_TITLE = '附件'
// 已有的附件分支（含历史版本叫「产物文件」的）直接复用，不重复建
const ATTACH_BRANCH_RE = /^(产物文件|附件|输出文件|文件清单)/
const MISSING_TITLE_RE = /(待补充|需补充|需要补充|补充数据|缺少|缺失|待确认|需确认|需要提供)/
const DELIVER_TITLE_RE = /(产出|交付|产物|输出文件|文件清单|附件|报表|生成的)/
// 只有这几类标题才铺成「结论」直接挂在结果节点下（要点/发现这类留成一支，别铺平）
const CONCLUSION_TITLE_RE = /(一句话结论|结论|摘要|总结|概要)/
const JUNK_TITLE_RE = /(过程|日志|完整输出|原文|参考|引用|实现要点|验证|校验|命令|步骤)/
// 单纯一句「无」的分支不用建
const EMPTY_ITEM_RE = /^(无|暂无|没有|不涉及|无。|—|-|\/|N\/A|none)$/i
// 没写「待补充数据」章节时，从正文里兜底挑出「缺数据」的句子
const MISSING_SENTENCE_RE = /(待补|需补|缺少|缺失|未提供|没有值|无值|未填|留空|无从获取)/
const MISSING_CONTEXT_RE = /(字段|数据|信息|资料|参数|口径|项)/

function clip(text, limit) {
  const value = String(text == null ? '' : text)
  if (value.length <= limit) return value
  return value.slice(0, limit - 1) + '…'
}

export function cleanInlineMarkdown(text) {
  return String(text || '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s（(])\*([^*\n]+)\*/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

const BULLET_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/
const HEADING_RE = /^(#{1,6})\s+(.*)$/
const TABLE_ROW_RE = /^\|.*\|$/

/** 按句子/分栏切开（不截断），供长文拆条与关键词扫描用 */
function sentencesOf(text) {
  return String(text)
    .split(/(?<=[。；;！!？?])|\s*｜\s*/)
    .map(part => part.trim())
    .filter(Boolean)
}

/**
 * 长文按句子切段（保留内容，不是砍掉），再按行宽合并。
 *
 * 这里**不截断** —— 返回的是原文片段。显示上限交给各自的消费方：
 * 提炼版在 add() 里 clip 到 NODE_TEXT_LIMIT；完整展开版把超长原文放进节点
 * note。以前在这里就 clip 掉了，结果 note 里也只能存半句（2026-09-29 修）。
 */
function splitLong(text, limit = NODE_TEXT_LIMIT) {
  const parts = sentencesOf(text)
  if (parts.length <= 1) return [String(text || '').trim()]
  const out = []
  let acc = ''
  parts.forEach(part => {
    if (acc && (acc + part).length > limit) {
      out.push(acc)
      acc = part
      return
    }
    acc += part
  })
  if (acc) out.push(acc)
  return out
}

function pushItem(items, text, dropped) {
  const lines = splitLong(text)
  if (lines.length > SENTENCE_PER_ITEM) dropped.count += lines.length - SENTENCE_PER_ITEM
  lines.slice(0, SENTENCE_PER_ITEM).forEach(line => items.push(line))
}

/** 把一个章节的行解析成若干条目（列表项合并一级子项；表格按行；长段落拆句） */
function parseItems(lines, dropped) {
  const items = []
  let rows = 0
  const flushPending = pending => {
    if (!pending) return
    const kids = pending.children
      .map(text => clip(text, 40))
      .filter(Boolean)
      .slice(0, 3)
    const text = kids.length ? `${pending.text}：${kids.join('；')}` : pending.text
    if (text) pushItem(items, text, dropped)
  }
  let pending = null
  lines.forEach(line => {
    const trimmed = line.trim()
    if (!trimmed) return
    const bullet = BULLET_RE.exec(line)
    if (bullet) {
      const indent = bullet[1].replace(/\t/g, '  ').length
      const text = cleanInlineMarkdown(bullet[2])
      if (!text) return
      if (indent >= 2 && pending) {
        pending.children.push(text)
        return
      }
      flushPending(pending)
      pending = { text, children: [] }
      return
    }
    if (TABLE_ROW_RE.test(trimmed)) {
      if (rows >= TABLE_ROW_LIMIT) {
        dropped.count += 1
        return
      }
      const cells = trimmed
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map(cell => cleanInlineMarkdown(cell))
      if (cells.every(cell => /^:?-{2,}:?$/.test(cell) || !cell)) return
      flushPending(pending)
      pending = null
      rows += 1
      items.push(clip(cells.join(' ｜ '), NODE_TEXT_LIMIT))
      return
    }
    flushPending(pending)
    pending = null
    // 普通段落：多长都按句子拆，不丢内容
    const text = cleanInlineMarkdown(trimmed.replace(/^>\s?/, ''))
    if (!text) return
    pushItem(items, text, dropped)
  })
  flushPending(pending)
  return items
}

/** 按标题切章节 */
function parseSections(markdown, dropped) {
  const lines = String(markdown || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  const sections = []
  let current = { title: '', lines: [] }
  let inCode = false
  lines.forEach(line => {
    const trimmed = line.trim()
    if (/^```/.test(trimmed)) {
      inCode = !inCode
      if (inCode) dropped.count += 1
      return
    }
    if (inCode) {
      dropped.count += 1
      return
    }
    if (/^([-*_]\s*){3,}$/.test(trimmed)) return
    const heading = HEADING_RE.exec(trimmed)
    if (heading) {
      sections.push(current)
      current = { title: cleanInlineMarkdown(heading[2]), lines: [] }
      return
    }
    current.lines.push(line)
  })
  sections.push(current)
  return sections
    .map(sec => ({ title: sec.title, items: parseItems(sec.lines, dropped) }))
    .filter(sec => sec.title || sec.items.length)
}

/**
 * Markdown → 提炼后的节点结构。
 *
 * 只挑核心：「结论/要点」直接铺在结果节点下，「待补充数据」单独一支，
 * 「产出」一支，其余章节最多再留一个。返回的 root 上带 `missing`（缺的数据）
 * 和 `dropped`（被略过的条数）。
 */
export function markdownToNodes(markdown, options = {}) {
  const pointLimit = Number(options.pointLimit) || POINT_LIMIT
  const dropped = { count: 0 }
  const sections = parseSections(markdown, dropped)
  const lead = []
  const missing = []
  const deliver = []
  const extras = []
  const loose = []
  const allItems = []

  const keep = (bucket, items) => {
    bucket.push(...items)
    allItems.push(...items)
  }

  sections.forEach(sec => {
    if (!sec.items.length) return
    if (!sec.title) {
      // 没有标题的段落（开场白之类）只在完全没有结论可用时兜底
      loose.push(...sec.items)
      allItems.push(...sec.items)
      return
    }
    if (MISSING_TITLE_RE.test(sec.title)) {
      keep(missing, sec.items.filter(item => !EMPTY_ITEM_RE.test(item)))
      return
    }
    if (DELIVER_TITLE_RE.test(sec.title)) {
      keep(deliver, sec.items.filter(item => !EMPTY_ITEM_RE.test(item)))
      return
    }
    if (JUNK_TITLE_RE.test(sec.title)) {
      dropped.count += sec.items.length
      return
    }
    if (CONCLUSION_TITLE_RE.test(sec.title)) {
      keep(lead, sec.items)
      return
    }
    extras.push(sec)
    allItems.push(...sec.items)
  })

  // 没写「待补充数据」章节时，从正文里兜底挑出「缺数据」的句子 ——
  // 用户要求「需要补什么数据单独说」，所以这一支宁可多找一句
  if (!missing.length) {
    const seen = new Set()
    allItems.some(item => {
      sentencesOf(item).forEach(sentence => {
        if (missing.length >= MISSING_LIMIT) return
        if (!MISSING_SENTENCE_RE.test(sentence)) return
        if (!MISSING_CONTEXT_RE.test(sentence)) return
        const text = clip(sentence, NODE_TEXT_LIMIT)
        if (seen.has(text)) return
        seen.add(text)
        missing.push(text)
      })
      return missing.length >= MISSING_LIMIT
    })
    // 已经挪进「待补充数据」的句子，就别在结论里重复一遍
    if (missing.length) {
      const taken = new Set(missing)
      const prune = items => items.filter(item => !taken.has(item))
      const keptLead = prune(lead)
      const keptDeliver = prune(deliver)
      lead.length = 0
      lead.push(...keptLead)
      deliver.length = 0
      deliver.push(...keptDeliver)
      extras.forEach(sec => {
        sec.items = prune(sec.items)
      })
    }
  }

  // 没有「结论」章节时：有标题的章节就各自成一支；整篇只有连标题都没有的段落，
  // 才把它们顶到结果节点下当结论
  if (!lead.length && !extras.length && loose.length) {
    loose.forEach(item => pushItem(lead, item, dropped))
  }

  const rest = []
  extras.slice(0, EXTRA_SECTION_LIMIT).forEach(sec => {
    const items = sec.items.slice(0, EXTRA_POINT_LIMIT)
    dropped.count += sec.items.length - items.length
    rest.push({ title: clip(sec.title, 40), items })
  })
  extras.slice(EXTRA_SECTION_LIMIT).forEach(sec => {
    dropped.count += sec.items.length
  })

  const keptPoints = lead.slice(0, pointLimit)
  dropped.count += lead.length - keptPoints.length
  const keptMissing = missing.slice(0, MISSING_LIMIT)
  dropped.count += missing.length - keptMissing.length
  const keptDeliver = deliver.slice(0, DELIVER_LIMIT)
  dropped.count += deliver.length - keptDeliver.length

  const root = { children: [] }
  let count = 0
  const add = (parent, text, children) => {
    if (!text || count >= MAX_NODES) return null
    const node = {
      data: { text: clip(text, NODE_TEXT_LIMIT) },
      children: (children || []).map(item => ({
        data: { text: clip(item, NODE_TEXT_LIMIT) },
        children: []
      }))
    }
    count += 1 + node.children.length
    parent.children.push(node)
    return node
  }

  keptPoints.forEach(text => add(root, text))
  if (keptMissing.length) {
    add(root, `${MISSING_BRANCH_TITLE}（${keptMissing.length} 项）`, keptMissing)
  }
  if (keptDeliver.length) {
    add(root, '产出', keptDeliver)
  }
  rest.forEach(sec => add(root, sec.title, sec.items))
  if (dropped.count > 0) {
    add(root, `（另有 ${dropped.count} 条细节，见附件）`)
  }

  root.missing = keptMissing
  root.dropped = dropped.count
  return root
}

/**
 * Markdown → **完整展开**的节点结构（不提炼、不丢弃）。
 *
 * 2026-09-29 用户要求：「运行输出」下面**只要完整输出 + 附件**。
 * 所以这里按章节原样铺开 —— 每个标题一个子节点，章内一条一行；
 * 单条超过 FULL_TEXT_LIMIT 的，节点上截断显示、**原文进 note**（点开看全），
 * 不再有「另有 N 条细节」这种省略。
 */
export function markdownToFullNodes(markdown, options = {}) {
  const limit = Number(options.maxNodes) || MAX_FULL_NODES
  const dropped = { count: 0 }
  const sections = parseSections(markdown, dropped)
  const root = { children: [], missing: [], dropped: 0 }
  let count = 0

  const make = text => {
    const raw = String(text || '').trim()
    if (!raw) return null
    const data = { text: clip(raw, FULL_TEXT_LIMIT) }
    if (raw.length > FULL_TEXT_LIMIT) data.note = raw
    return { data, children: [] }
  }

  sections.forEach(sec => {
    const items = (sec.items || []).filter(item => String(item || '').trim())
    if (!items.length) return
    const title = String(sec.title || '').trim()
    if (!title) {
      // 没有标题的段落（开场白之类）直接铺在结果节点下
      items.forEach(item => {
        if (count >= limit) return
        const node = make(item)
        if (!node) return
        count += 1
        root.children.push(node)
      })
      return
    }
    const kids = []
    items.forEach(item => {
      if (count + kids.length + 1 >= limit) return
      const node = make(item)
      if (node) kids.push(node)
    })
    if (!kids.length) return
    const head = { data: { text: clip(title, FULL_TEXT_LIMIT) }, children: kids }
    if (title.length > FULL_TEXT_LIMIT) head.data.note = title
    count += 1 + kids.length
    root.children.push(head)
  })

  return root
}

export function countNodeTrees(trees) {
  let total = 0
  const walk = list => {
    const rows = list || []
    rows.forEach(item => {
      total += 1
      walk(item.children)
    })
  }
  walk(trees)
  return total
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

export function buildResultTitle(date = new Date()) {
  return `运行输出 · ${pad2(date.getMonth() + 1)}-${pad2(
    date.getDate()
  )} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** 任务容器节点：「任务 · 09-23 09:46」——一次运行一个，任务内容与结果都挂在它下面 */
export function buildTaskContainerTitle(date = new Date()) {
  return `任务 · ${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(
    date.getHours()
  )}:${pad2(date.getMinutes())}`
}

/**
 * 概要的默认文案：概要用来包住「这次生成的所有节点」，也是让人二次填写
 * 「下一步做什么」的地方 —— **在图上点它就按这句话派发**，双击是改文字。
 * 还是这句话就说明用户没改过，运行时不采信（按节点默认任务跑）。
 */
export const FOLLOW_UP_PLACEHOLDER =
  '✍️ 下一步做什么？双击改这里，点这里就运行'
const FOLLOW_UP_PLACEHOLDER_RE = /^✍️\s*下一步/

export function isFollowUpPlaceholder(text) {
  return FOLLOW_UP_PLACEHOLDER_RE.test(String(text || '').trim())
}

/**
 * 给「这次生成的这批节点」加一个范围概要（range generalization），
 * 包住它们，并留出「下一步做什么」的填写位。
 * 范围概要可以叠加（simple-mind-map 的 checkHasSelfGeneralization 只管非范围概要），
 * 所以每次运行各加一个，互不干扰。
 */
function addFollowUpGeneralization(mindMap, target, batch) {
  const nodes = (batch || []).filter(
    node => node && typeof node.getData === 'function' && !node.isGeneralization
  )
  if (!nodes.length || !mindMap || typeof mindMap.execCommand !== 'function') {
    return null
  }
  if (target && typeof target.setData === 'function') {
    target.setData({ expand: true })
  }
  // openEdit=false：不要自动弹编辑框，让用户想写时自己双击
  mindMap.execCommand(
    'ADD_GENERALIZATION',
    { text: FOLLOW_UP_PLACEHOLDER },
    false,
    nodes
  )
  // ⚠️ 概要数据落在哪：**范围概要挂在共同父节点上**（也就是这次的容器），
  // 只有一个节点时才挂它自己 —— 见 simple-mind-map 的 parseAddGeneralizationNodeList
  // （group.length > 1 时 `node = uidToParent[uid]`）。以前这里只读 nodes[0]，
  // 结果范围概要读不到、`out.generalization` 永远是 null（提示里那句「已加概要」不出现）。
  const read = node => {
    if (!node || typeof node.getData !== 'function') return []
    const raw = node.getData('generalization')
    return Array.isArray(raw) ? raw : raw ? [raw] : []
  }
  const fromOwner = read(target)
  const list = fromOwner.length ? fromOwner : read(nodes[0])
  return list[list.length - 1] || null
}

const TASK_CONTAINER_RE = /^任务\s*[·・:：]/

export function isTaskContainerNode(node) {
  if (!node || typeof node.getData !== 'function') return false
  return TASK_CONTAINER_RE.test(
    String(node.getData('text') || '')
      .replace(/<[^>]+>/g, '')
      .trim()
  )
}

/** 某个节点下最后一个任务容器（「继续执行」要落在同一个容器里） */
export function lastTaskContainer(node) {
  const list = ((node && node.children) || []).filter(isTaskContainerNode)
  return list[list.length - 1] || null
}

export function sizeText(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function resolveTargetNode(mindMap, uid, options = {}) {
  const renderer = mindMap && mindMap.renderer
  const wanted = String(uid || '').trim()
  if (wanted && renderer && typeof renderer.findNodeByUid === 'function') {
    const hit = renderer.findNodeByUid(wanted)
    if (hit) return hit
  }
  // 按 uid 没找到 → **按标题在整棵树上找回来**（2026-10-09 用户反馈：
  // 「还是显示找不到节点（可能已经删掉了），但实际上已经写入了」）。
  // 成因：记录里存的 uid 会过期 —— 重连 / 整树恢复 / 服务端重建节点后，
  // 节点实例连 uid 一起换了，可内容好端端在图上；这时按 uid 找不到就报错，
  // 而「写入导图」本来是幂等的（按名字复用），按标题找回原容器继续写才对。
  const title = String((options && options.title) || '').trim()
  if (title) {
    const byTitle = findNodeByTitleText(mindMap, title)
    if (byTitle) return byTitle
  }
  if (!wanted) {
    const active = renderer && renderer.activeNodeList && renderer.activeNodeList[0]
    return active || null
  }
  return null
}

/**
 * 在**整棵树**上按节点文字找一个节点（用于「uid 过期了但节点还在」时把它找回来）。
 * 只认完全相等（去 HTML、去空白后），不做模糊匹配 —— 免得写到别的节点上。
 */
function findNodeByTitleText(mindMap, text, limit = 5000) {
  const renderer = mindMap && mindMap.renderer
  const root = renderer && renderer.root
  const wanted = String(text || '').trim()
  if (!root || !wanted) return null
  const stack = [root]
  let seen = 0
  while (stack.length && seen < limit) {
    const node = stack.shift()
    if (!node) continue
    seen += 1
    if (node !== root && !node.isGeneralization && nodeText(node) === wanted) {
      return node
    }
    const kids = node.children || []
    for (let i = 0; i < kids.length; i += 1) stack.push(kids[i])
  }
  return null
}

/**
 * 拿到「当前真正在树上的那个节点」。
 *
 * ⚠️ 为什么不能一直用手里的引用：协同接收到远端改动、或任何一次重渲染，都会**重建节点实例**
 * ——数据还在、我们握着的那只对象已经脱离画布了。此后往它身上插东西，数据能进、但它的
 * `children` 永远不更新 ——「命令没有落到图上」就是这么报出来的（2026-10-08 用户反馈）。
 * 按 uid 现查（引擎自己也这么找节点）就能拿到活的那只。
 */
function liveNode(mindMap, node) {
  const renderer = mindMap && mindMap.renderer
  const uid = node && typeof node.getData === 'function' ? node.getData('uid') : null
  if (
    uid == null ||
    uid === '' ||
    !renderer ||
    typeof renderer.findNodeByUid !== 'function'
  ) {
    return node
  }
  return renderer.findNodeByUid(uid) || node
}

/** 这些 uid 现在都在树上吗（按 uid 现查，不看我们手里那个引用） */
function findInserted(mindMap, uids) {
  const renderer = mindMap && mindMap.renderer
  const hits = []
  ;(uids || []).forEach(uid => {
    if (!uid) return
    const node =
      renderer && typeof renderer.findNodeByUid === 'function'
        ? renderer.findNodeByUid(uid)
        : null
    if (node) hits.push(node)
  })
  return hits
}

/**
 * 「命令没落到图上」时到底为什么 —— 把现场事实一并报出来。
 *
 * 这句话以前只讲「常见原因」，用户没法判断是哪一种，我们只能靠猜（2026-10-08 用户
 * 直接把这句话发回来，还是定位不了）。现在把能查的都查出来：只读？命令队列暂停？
 * 引擎在等子树加载？落点还在不在？它现在有几个子节点？
 */
function insertFailedReason(mindMap, container) {
  const facts = []
  if (mindMap && mindMap.opt && mindMap.opt.readonly) facts.push('房间处于只读态')
  const renderer = mindMap && mindMap.renderer
  if (renderer && renderer._lazyCommandPending) facts.push('引擎正在等子树加载完成')
  if (renderer && renderer._skipLazyHydrate) facts.push('引擎正处于「跳过懒加载」窗口')
  const command = mindMap && mindMap.command
  if (command && command.isPause) facts.push('命令队列处于暂停态')
  const live = liveNode(mindMap, container)
  if (!live) {
    facts.push('落点节点在图上已经找不到了')
  } else {
    const kids = (live.children || []).length
    facts.push(`落点「${nodeText(live) || '未命名'}」现在有 ${kids} 个子节点`)
  }
  const cooperate = mindMap && mindMap.cooperate
  if (cooperate && typeof cooperate.nodeNeedsHydrate === 'function' && live) {
    try {
      if (cooperate.nodeNeedsHydrate(live)) facts.push('落点的子节点还没从服务器拉全')
    } catch (err) {
      /* 查不动就算了，不影响报错 */
    }
  }
  return (
    '写入导图失败：命令没有落到图上（' +
    (facts.join('；') || '原因没查出来') +
    '）—— 先在「运行历史」里点「写入导图」重试；还不行就刷新页面再试，' +
    '并把「协同」面板右下角的诊断复制出来'
  )
}

/** 节点文字（去 HTML 与空白） */
function nodeText(node) {
  const raw =
    node && typeof node.getData === 'function' ? node.getData('text') : ''
  return String(raw || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

/** 结果节点下的附件分支（历史结构里叫「产物文件」） */
function findAttachBranch(resultNode) {
  const kids = (resultNode && resultNode.children) || []
  return kids.find(child => ATTACH_BRANCH_RE.test(nodeText(child).trim())) || null
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 等这次插进去的节点真的挂上，按 **uid** 精确认领（不是「最后一个新子节点」）。
 *
 * 为什么必须按 uid：两个任务可能**同时**往同一个父节点插东西 ——
 * 用「最后一个新出现的」认领会拿到别人插的节点（2026-10-08 用户反馈
 * 「两个任务同时运行，第一个没有完整输出、第二个内容重复」，就是这么来的）。
 *
 * @param {Array}  uids   insertChildren 返回的 uid 列表
 * @param {Boolean} all   true = 等这批**全部**落地（插一批时用）
 * @returns 单个节点 / 节点数组 / null（超时没落地）
 */
async function waitForInserted(mindMap, parent, uids, { all = false, tries = 60 } = {}) {
  const want = new Set((uids || []).filter(Boolean))
  if (!want.size) return null
  const uidOf = node =>
    String((node && node.getData && node.getData('uid')) || '')
  for (let i = 0; i < tries; i += 1) {
    // ① 按 uid **现查**（父节点对象可能已经被重渲染换掉了，但它插进去的节点在树上）
    const found = findInserted(mindMap, uids)
    // ② 再兜一眼活父节点的直接子节点（万一 uid 查不到树、但确实挂在下面）
    const live = liveNode(mindMap, parent)
    const kids = ((live && live.children) || []).filter(node =>
      want.has(uidOf(node))
    )
    const hits = Array.from(new Set(found.concat(kids)))
    if (all) {
      if (hits.length >= want.size) return hits
    } else if (hits.length) {
      return hits[0]
    }
    if (i < tries - 1) await sleep(50)
  }
  return null
}

/**
 * 只读态：`Command.exec` 在 `mindMap.opt.readonly` 为真时**静默丢弃**所有结构命令
 * （见 simple-mind-map/src/core/command/Command.js），命令不落地、也不报错 ——
 * 写回就会「说成功、图上没有」。所以写之前/写完之后都要查一次，并且如实说明原因。
 * 常见来源：房间角色是 viewer、或操作被服务端 ACL 拒了（app 会把人降成只读）。
 */
function readonlyReason(mindMap) {
  const ro = !!(mindMap && mindMap.opt && mindMap.opt.readonly)
  return ro
    ? '这个房间当前是只读的（没有编辑权限），结果写不进去 —— 请让有编辑权限的人来写，' +
        '或把角色改成可编辑后再点「写入导图」'
    : ''
}

/**
 * 插入前先把落点子树的子节点补齐（协同模式下大图是**懒加载**的）。
 *
 * 为什么必须做：`Renderer.runAfterHydrate` 碰到「子节点没拉全」的父节点时，会把插入
 * **推迟**到 hydration 完成之后再执行，而且失败时只 `console.error` 一句 ——
 * 命令等于被静默丢掉。写回是一串连发命令，任一环被推迟，后面就全落空
 * （2026-10-08 用户看到的「可能协同任务丢了」就是这个）。
 * 这里先主动 await 一次 hydration，插入就能当场落树。
 */
async function ensureInsertParent(mindMap, parent) {
  const cooperate = mindMap && mindMap.cooperate
  if (!cooperate || !parent) return
  try {
    if (
      typeof cooperate.nodeNeedsHydrate === 'function' &&
      !cooperate.nodeNeedsHydrate(parent)
    ) {
      return
    }
    if (typeof cooperate.ensurePlacementParent === 'function') {
      await cooperate.ensurePlacementParent(parent)
    }
  } catch (err) {
    // 补不齐也不阻断：下面的插入会走引擎自己的延迟路径，收尾复核会兜住
  }
}

/**
 * 给待插入的节点发**唯一 uid**（引擎会保留传入的 uid，见
 * simple-mind-map/src/utils/index.js 的 createUidForAppointNodes），
 * 插完就能按 uid 精确找回「自己插的那个」。
 */
let insertUidSeq = 0
function makeInsertUid() {
  insertUidSeq += 1
  return `jobres-${Date.now().toString(36)}-${insertUidSeq.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`
}

function stampInsertUids(trees) {
  const uids = []
  const walk = list => {
    (list || []).forEach(tree => {
      if (!tree || !tree.data) return
      if (!tree.data.uid) tree.data.uid = makeInsertUid()
      uids.push(String(tree.data.uid))
      walk(tree.children)
    })
  }
  walk(trees)
  return uids
}

/**
 * 在指定节点下插一批子节点，返回**这次插入的 uid 列表**。
 *
 * ⚠️ 以前这里插完靠 `waitNewChild` 取「最后一个新子节点」认领 —— 两个任务同时往同一个
 * 父节点插东西时会**互相认领错**：2026-10-08 用户反馈「两个任务同时运行，第一个没有
 * 完整输出、第二个内容重复」，就是两条任务认到了同一个「任务容器」，只后共用一个
 * 「附件」分支与「完整输出.md」节点（后者把前者的正文覆盖掉、附件挂到同一节点）。
 * 现在每个节点带唯一 uid，插完按 uid 精确认领，互不干扰。
 */
async function insertChildren(mindMap, parent, trees) {
  if (!trees || !trees.length) return []
  // 插入前把落点换成「当前活的那只」：手里的引用可能是上一次渲染留下的
  const live = liveNode(mindMap, parent)
  if (live && typeof live.setData === 'function') {
    live.setData({ expand: true })
  }
  const uids = stampInsertUids(trees)
  await ensureInsertParent(mindMap, live)
  mindMap.execCommand('INSERT_MULTI_CHILD_NODE', [live], trees)
  return uids
}

/**
 * 插一批节点并**确认真的落地**；没落地就换个 uid 再插一次。
 *
 * 为什么带重试：协同那条链路偶尔会吃掉插入命令（尤其是同时写回两条任务时），
 * 用户 2026-10-08 看到的就是「有 1 个产物节点没落进导图」—— 一次不成再插一次基本就落地了。
 * 重试用**新的 uid**（旧的没落地，不会重复）；万一第一次其实是「落得慢」，
 * 后面按名字查重也能兜住（调用方按名字复用已有节点，见 findAttachBranch / md 查重）。
 *
 * @returns {Promise<{nodes: Array<Object|null>, lost: Array<String>, placedUids: Array<String>}>}
 *          nodes 与入参 trees 一一对应（没落地的那项是 null）；
 *          placedUids = 这次**真的插进树里**的节点 uid（用来问服务端「确认了吗」）
 */
async function insertTreesWithRetry(mindMap, parent, trees, attempts = 2) {
  const list = (trees || []).filter(Boolean)
  if (!list.length) return { nodes: [], lost: [], placedUids: [] }
  const texts = list.map(tree => String((tree.data && tree.data.text) || ''))
  const placed = new Array(list.length).fill(null)
  const placedUids = new Set()
  let pending = list.map((tree, idx) => ({ tree, idx }))
  for (let round = 0; round < attempts && pending.length; round += 1) {
    const batch = pending.map(item => item.tree)
    const uids = await insertChildren(mindMap, parent, batch)
    await waitForInserted(mindMap, parent, uids, { all: true })
    const byUid = new Map()
    // 先按 uid **现查**（父节点引用可能已过期），再兜活父节点的直接子节点
    findInserted(mindMap, uids).forEach(node => {
      const uid = String((node.getData && node.getData('uid')) || '')
      if (uid) byUid.set(uid, node)
    })
    const live = liveNode(mindMap, parent)
    ;((live && live.children) || []).forEach(node => {
      const uid = String((node.getData && node.getData('uid')) || '')
      if (uid && !byUid.has(uid)) byUid.set(uid, node)
    })
    const still = []
    pending.forEach((item, i) => {
      const hit = byUid.get(uids[i])
      if (hit) {
        placed[item.idx] = hit
        placedUids.add(String(uids[i]))
      } else still.push(item)
    })
    pending = still
  }
  const lost = pending.map(item => texts[item.idx]).filter(Boolean)
  return { nodes: placed, lost, placedUids: Array.from(placedUids) }
}

function fileFromText(name, text, type) {
  return new File([text], name, { type: type || 'text/markdown' })
}

function fileFromBase64(name, base64, type) {
  const raw = atob(String(base64 || ''))
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return new File([bytes], name, { type: type || 'application/octet-stream' })
}

/**
 * 把附件绑到节点上。
 * 走项目既有的 `SET_NODE_ATTACHMENT` 命令（跟手动上传附件一条路）——这样节点上会出现
 * 附件按钮、能点开预览，而且协作同步 / 撤销 / 持久化都跟着走。
 * 直接 node.setData() 只会改数据，节点上不会长出附件按钮。
 */
function applyAttachment(mindMap, node, attachment, file) {
  const saved = attachment || {}
  const name = saved.fileName || (file && file.name) || ''
  const meta = {
    attachmentId: saved.id || '',
    attachmentMimeType: saved.mimeType || (file && file.type) || '',
    attachmentStatus: saved.status || 'ready',
    attachmentError: saved.errorMessage || '',
    attachmentExtractedText: String(saved.extractedText || '').slice(
      0,
      ATTACH_TEXT_LIMIT
    ),
    attachmentProgress: 100
  }
  const patch = { attachmentUrl: '', attachmentName: name, ...meta }
  const read = key =>
    String((node && typeof node.getData === 'function' && node.getData(key)) || '')
  // 「落地」的判据：节点 data 里确实写上了名字（有 id 的话 id 也要对上）。
  // 命令可能是静默失败的（引擎旧版、只读态会把 SET_NODE_DATA 直接丢掉），
  // 所以**必须验证**，不能调完就当成功 —— 否则附件传上去了、节点上却没有回形针。
  const landed = () =>
    read('attachmentName') === name &&
    read('attachmentId') === String(meta.attachmentId || '')

  if (mindMap && typeof mindMap.execCommand === 'function') {
    try {
      mindMap.execCommand('SET_NODE_ATTACHMENT', node, '', name, meta)
    } catch (err) {
      // 命令抛错就往下走兜底，别因为一个命令把整条写回炸掉
      console.warn('[writer] SET_NODE_ATTACHMENT failed:', err)
    }
    if (landed()) return true
  }
  // 兜底①：走渲染器的 setNodeData（跟命令同一条数据通路）
  if (
    mindMap &&
    mindMap.renderer &&
    typeof mindMap.renderer.setNodeDataRender === 'function'
  ) {
    try {
      mindMap.renderer.setNodeDataRender(node, patch)
    } catch (err) {
      console.warn('[writer] setNodeDataRender failed:', err)
    }
    if (landed()) return true
  }
  // 兜底②：直接写节点数据 + 重绘。丢掉协作历史，但至少节点上有附件
  const raw = node && node.nodeData && node.nodeData.data
  if (raw) {
    Object.keys(patch).forEach(key => {
      raw[key] = patch[key]
    })
  }
  if (node && typeof node.reRender === 'function') {
    try {
      node.reRender(['attachment'])
    } catch (err) {
      /* 重绘失败不影响数据 */
    }
  }
  return landed()
}

/** 展开一棵子树（协同下 setData 也是异步落树，所以统一放到收尾做） */
function expandBranch(node, depth = 0) {
  if (!node || depth > 8) return
  if (typeof node.setData === 'function') {
    try {
      node.setData({ expand: true })
    } catch (err) {
      /* 只读态会被丢弃，无妨 */
    }
  }
  const kids = (node.children || []).slice()
  kids.forEach(child => expandBranch(child, depth + 1))
}

/**
 * 写回收尾：让刚写进去的东西**当场可见**。
 *
 * 2026-10-08 用户反馈「现在是强制刷新才会出现产物挂载到任务节点」。
 * 根因不是一个点：写回是「本地命令 + 协同同步 + 附件上传」混着走的 ——
 * 协同模式下命令不是同步落树（insertChildren 的注释也写着这一点），
 * 附件命令同样可能被丢弃或撞上竞态，于是本地画布上没有回形针，刷新
 * （从服务端拉全量数据）才出现。这里做三件事，做完就不必再 Ctrl+F5：
 *   1. 展开新节点 —— 折叠状态下插进去的节点在画布上根本看不见
 *   2. 复核每个附件节点：attachmentName 没落上就补写一次
 *   3. 强制整树重绘
 * 另安排一次延迟复核：协同的服务端回包可能晚到，1.2 秒后再看一次。
 */
function ensureResultVisible(mindMap, root, checks = []) {
  if (!mindMap || !root) return
  const verify = () => {
    const list = checks || []
    list.forEach(item => {
      const node = item && item.node
      if (!node || typeof node.getData !== 'function') return
      const cur = String(node.getData('attachmentName') || '')
      if (cur === String(item.name || '')) return
      applyAttachment(mindMap, node, item.attachment, item.file)
    })
  }
  expandBranch(root)
  verify()
  if (typeof mindMap.render === 'function') mindMap.render()
  if (typeof setTimeout === 'function') {
    setTimeout(() => {
      try {
        verify()
        if (typeof mindMap.render === 'function') mindMap.render()
      } catch (err) {
        /* 页面可能已销毁，忽略 */
      }
    }, 1200)
  }
}

function errorDetail(err) {
  const parts = [
    (err && err.message) || String(err || ''),
    err && err.statusCode ? `HTTP ${err.statusCode}` : '',
    err && err.code ? `(${err.code})` : ''
  ].filter(Boolean)
  return parts.join(' ')
}

/** File → 纯 base64（不带 data: 前缀） */
async function fileToBase64(file) {
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/**
 * 把文件挂到节点上，两条通道：
 *   1. 执行主机上的桥接 → 经 MCP `upload_attachment`（服务器部署时更稳，绕开协同服务上传接口）
 *   2. 退回原来的 `uploadNodeAttachment`（页面同域 → nginx → 协同服务 1234）
 * 两条都失败才抛错。桥接回了 extractedText，跟服务端那份保持一致。
 */
async function attachToNode(mindMap, node, roomKey, file, bridgeAttach) {
  const uid = nodeUid(node)
  let bridgeError = ''
  if (bridgeAttach && uid) {
    try {
      const base64 = await fileToBase64(file)
      const res = await bridgeAttach({
        roomKey,
        nodeUid: uid,
        files: [
          {
            name: file.name,
            mimeType: file.type || '',
            base64
          }
        ]
      })
      const first = res && res.ok && (res.attachments || [])[0]
      if (first && first.ok && first.attachmentId) {
        const attachment = {
          id: first.attachmentId,
          fileName: first.fileName || file.name,
          mimeType: first.mimeType || file.type || '',
          status: first.status || 'ready',
          errorMessage: '',
          extractedText: first.extractedText || ''
        }
        if (applyAttachment(mindMap, node, attachment, file)) {
          return { ...attachment, via: 'mcp' }
        }
        bridgeError = '桥接传上去了，可是没绑到节点上'
      }
    } catch (err) {
      // 桥接这条路不通（旧版桥接 / 没配 MCP）就退回协同服务上传，
      // 但**原因要留着** —— 两条都失败时用户得知道分别卡在哪
      bridgeError = errorDetail(err)
    }
  }
  const res = await uploadNodeAttachment(roomKey, {
    file,
    fileName: file.name,
    nodeUid: uid,
    mimeType: file.type || 'application/octet-stream',
    sourceKind: 'attachment'
  })
  const attachment = (res && res.attachment) || {}
  const suffix = bridgeError ? `；桥接那条：${bridgeError}` : ''
  if (!attachment.id) {
    throw new Error(`上传成功但没拿到附件 id${suffix}`)
  }
  if (!applyAttachment(mindMap, node, attachment, file)) {
    throw new Error(
      `附件已上传（${attachment.fileName || file.name}），但没能绑到节点上，节点上不会出现回形针${suffix}`
    )
  }
  return attachment
}

/**
 * 建一个「任务 · 时间」容器：这次的任务内容与结果都挂在它下面。
 * 一次运行一个容器 —— 运行输出永远紧跟任务内容，不会落到 SOP 末尾。
 * 落点已经是任务容器时（从概要点「运行」接着往下做就是这种情况），新容器挂在**它下面**
 * —— 「摘要写的继续的任务放在这个任务下」，所以续写是上一块的最后一个子节点。
 * @returns {Promise<{ uid: String, title: String, node: Object }>}
 */
export async function createJobContainer({
  mindMap,
  nodeUid: targetUid,
  nodeTitle = '',
  prompt
} = {}) {
  if (!mindMap) throw new Error('导图还没准备好，稍后再试')
  const ro = readonlyReason(mindMap)
  if (ro) throw new Error(ro)
  const target = resolveTargetNode(mindMap, targetUid, { title: nodeTitle })
  if (!target) {
    throw new Error(
      `找不到要挂任务的节点（可能已被删掉）：uid=${String(targetUid || '（空）')}` +
        (nodeTitle ? `、标题=${nodeTitle}` : '')
    )
  }

  const text = String(prompt || '').trim()
  const title = buildTaskContainerTitle()
  // 任务内容是多行提示词，节点文本压成一行（脑图上不加备注标签）
  const inline = cleanInlineMarkdown(text).replace(/\s+/g, ' ').trim()
  const tree = {
    data: { text: title },
    children: text
      ? [{ data: { text: `任务内容：${clip(inline, NODE_TEXT_LIMIT)}` } }]
      : []
  }

  // 落点本身是「任务」容器时**不再另起同级分支** —— 用户要的是「续写挂在这个任务下」，
  // 所以走下面那条通用路径：作为它的最后一个子节点插进去（任务内容 / 运行输出 / 附件之后）。
  // 按 uid 认领自己插的那个 —— 另一个任务可能同时在同一个节点下建容器（并发跑两条时）
  const res = await insertTreesWithRetry(mindMap, target, [tree])
  const created = res.nodes[0] || null
  if (!created) throw new Error('建任务节点失败（命令没落到图上），请重试')
  return { uid: nodeUid(created), title, node: created }
}

/**
 * 查「这次运行的结果到底在不在图上」—— 刷新页面后自动补写靠它做判据
 * （2026-10-09 用户要求：「识别到任务内容没挂在节点、并且运行完成」时，
 * 刷新后自动把运行记录的那套「写入导图」接过来重写一遍）。
 *
 * 只认**节点上真实存在的结构**：任务容器在不在、有没有「任务内容：」、
 * 「附件」分支、产物节点、「完整输出.md」。查不到就说明这次写回没落地
 * （或只落了一部分），该补写。
 *
 * @returns {{ok:Boolean, exists:Boolean, title:String, hasTaskContent:Boolean,
 *            hasAttach:Boolean, hasFullOutput:Boolean, artifactNames:Array<String>}}
 */
export function inspectJobResult({ mindMap, nodeUid: targetUid, nodeTitle = '' } = {}) {
  const renderer = mindMap && mindMap.renderer
  const uid = String(targetUid || '').trim()
  const empty = {
    ok: true,
    exists: false,
    title: '',
    // 找到时回报**当前真实的** uid：记录里的 uid 会过期（重连/整树恢复后会换），
    // 调用方拿它把记录修正过来，下次就不用再靠标题兜底了
    uid: '',
    resolvedBy: '',
    hasTaskContent: false,
    hasAttach: false,
    hasFullOutput: false,
    artifactNames: []
  }
  if (!renderer || typeof renderer.findNodeByUid !== 'function') {
    return { ...empty, ok: false }
  }
  let node = uid ? renderer.findNodeByUid(uid) : null
  let resolvedBy = node ? 'uid' : ''
  if (!node && String(nodeTitle || '').trim()) {
    node = findNodeByTitleText(mindMap, nodeTitle)
    if (node) resolvedBy = 'title'
  }
  if (!node) return empty
  const kids = (node.children || []) || []
  const branch = findAttachBranch(node)
  const branchKids = (branch && branch.children) || []
  const names = branchKids.map(child => nodeText(child)).filter(Boolean)
  const kidTexts = kids.map(child => nodeText(child).trim())
  return {
    ok: true,
    exists: true,
    title: String(node.getData('text') || ''),
    uid: nodeUid(node),
    resolvedBy,
    hasTaskContent: kidTexts.some(text => /^任务内容[:：]/.test(text)),
    hasAttach: !!branch,
    hasFullOutput: !!branchKids.find(child => /完整输出/.test(nodeText(child))),
    // 老结构：结果铺在「运行输出」这一层里（那时附件挂在它下面）——
    // 已经写过的老记录不能当成「没写」，否则自动补写会给他补出第二份
    hasLegacyOutput: kidTexts.some(text => /^运行输出/.test(text)),
    artifactNames: names.filter(name => !/完整输出/.test(name))
  }
}

/**
 * @param {Object}   payload
 * @param {Object}   payload.mindMap    simple-mind-map 实例（Edit.vue 持有）
 * @param {String}   payload.nodeUid    落点：运行节点，或这次运行的任务容器
 * @param {String}   payload.markdown   完整输出
 * @param {String}   payload.prompt     任务内容（落点不是容器、需要现建容器时用）
 * @param {String}   payload.roomKey    房间 key，缺了就不挂附件
 * @param {Array}    payload.artifacts  产物文件 [{name, size, mime, base64}]
 * @param {Array}    payload.artifactSkips 桥接报的「文件在、但不在允许目录里」清单
 *                                          [{path, name, error}] —— 只用来给用户解释
 * @param {Object}   payload.artifactDiag  取产物的诊断 {runDir, dirCount, sinceCount, total, error}
 *                                          —— 只在「一个产物都没扫到」时用来解释原因
 * @param {Function} payload.bridgeAttach 经桥接 MCP 挂附件的通道（可选；给了就优先用它）
 * @param {Function} payload.onProgress 进度文字回调
 */
export async function writeJobResultToMap({
  mindMap,
  nodeUid: targetUid,
  nodeTitle = '',
  markdown,
  prompt,
  roomKey,
  artifacts,
  artifactSkips,
  artifactDiag,
  bridgeAttach,
  onProgress
} = {}) {
  const say = text => {
    if (onProgress) onProgress(text)
  }
  if (!mindMap) throw new Error('导图还没准备好，稍后再试')
  const readonly = readonlyReason(mindMap)
  if (readonly) throw new Error(readonly)
  const text = String(markdown || '').trim()
  if (!text) throw new Error('这次运行没有文字输出，没东西可写入脑图')
  const resolved = resolveTargetNode(mindMap, targetUid, { title: nodeTitle })
  if (!resolved) {
    throw new Error(
      `找不到运行的那个节点（可能已被删掉）：uid=${String(targetUid || '（空）')}` +
        (nodeTitle ? `、标题=${nodeTitle}` : '') +
        ' —— 可以在图上重新选中那个任务节点，再点「写入导图」'
    )
  }

  // 落点必须落在「任务」里面：目标本身是容器就用它，否则现建一个 ——
  // 这样运行输出永远跟在这次的任务后面，不会甩在 SOP 末尾
  let container = isTaskContainerNode(resolved) ? resolved : null
  if (!container) {
    say('正在新建任务节点…')
    const made = await createJobContainer({
      mindMap,
      nodeUid: nodeUid(resolved),
      nodeTitle: nodeText(resolved),
      prompt
    })
    container = made.node
  }

  const title = buildResultTitle()
  // 结构（2026-10-08 用户要求）：「任务 → 附件 → 完整输出 | 产物」。
  // 不再建「运行输出」这一层中间节点，正文也不铺成节点树 —— 全文进「完整输出.md」。
  // 两个例外仍然要铺（否则内容就丢了）：
  //   ① INLINE_RESULT_NODES 打开；
  //   ② 没有 roomKey —— 挂不了附件，正文必须以节点形式留在导图上。
  const inlineResult = INLINE_RESULT_NODES || !roomKey
  let tree = { children: [], missing: [], dropped: 0 }
  // ⚠️ 落点换成「当前活的那只」：上面建容器/解析目标之间可能有重渲染，
  // 握着旧引用会让后面所有插入都插到脱离画布的节点上（数据进、画布不长）。
  container = liveNode(mindMap, container) || container
  let resultNode = container
  // 记录「这一步牵涉到的节点」（existing = 复用的旧节点 / placed = 本次新插的）
  // —— 必须在**第一次插入之前**就备好：inlineResult 那条路也要 markPlaced（否则收尾复核
  // 拿不到「本次真插了什么」，见文末「收尾复核」）。
  const touched = new Set()
  const fresh = new Set()
  const markTouched = node => {
    const uid = nodeUid(node)
    if (uid) touched.add(uid)
    return node
  }
  const markPlaced = res => {
    const uids = (res && res.placedUids) || []
    uids.forEach(uid => {
      if (!uid) return
      touched.add(String(uid))
      fresh.add(String(uid))
    })
    return res
  }
  markTouched(container)
  markTouched(resultNode)

  if (inlineResult) {
    tree = markdownToFullNodes(text)
    say('正在把结果写进导图…')
    const res = markPlaced(
      await insertTreesWithRetry(mindMap, container, [
        { data: { text: title }, children: tree.children }
      ])
    )
    const made = res.nodes[0] || null
    if (!made) {
      throw new Error(
        '写入导图失败：命令没有落到图上（协同连接可能断了）—— 刷新页面后点「写入导图」重试'
      )
    }
    resultNode = made
  }

  const out = {
    title,
    nodeUid: nodeUid(resultNode),
    containerUid: nodeUid(container),
    nodes: inlineResult ? 1 + countNodeTrees(tree.children) : 0,
    // 正文是不是铺成了节点（false = 只挂了附件，用来决定提示文案怎么写）
    inlineNodes: inlineResult,
    missing: tree.missing || [],
    dropped: tree.dropped || 0,
    attachments: [],
    warnings: [],
    // 本次写回牵涉的节点 uid —— 给「服务端到底确认了没有」当判据用（见 Toolbar）：
    //   ensuredUids  = 写完之后**应该存在**的节点（含复用到的旧节点）
    //   insertedUids = 这次**新插进去**的节点（有它才能拿到「服务端已确认」的正面证据）
    // 为什么要带出来：光看客户端队列「还有没有没确认的命令」会被**别人的**积压命令误伤
    // （服务器 outbox 积压两万多条），于是每次写回都被判成「没同步」（2026-10-09 反馈）。
    ensuredUids: [],
    insertedUids: []
  }
  if (!roomKey) {
    out.warnings.push('没有房间信息，没挂附件（正文已直接铺进导图）')
  } else {
    // ⚠️ 产物「一个都没挂上」以前是**静默**的：扫不到就当没有、读不回内容就丢掉、
    // 超过上限就截断 —— 界面上照样报「完成」，人只能看着图干瞪眼（2026-10-08 反馈
    // 「产物没有挂上」）。三条路现在都点名说出来。
    const found = (artifacts || []).filter(item => item && item.name)
    const namesOf = list =>
      list
        .slice(0, 3)
        .map(item => String(item.name))
        .join('、') + (list.length > 3 ? ' 等' : '')
    const noContent = found.filter(item => !item.base64)
    if (!found.length) {
      const diag = artifactDiag && typeof artifactDiag === 'object' ? artifactDiag : null
      const scanned = []
      if (diag && diag.runDir) {
        scanned.push(`output/${diag.runDir}/（${Number(diag.dirCount) || 0} 个）`)
      }
      if (diag && (diag.sinceCount != null || diag.error)) {
        scanned.push(
          diag.error
            ? `output 目录（取产物接口出错：${diag.error}）`
            : `output 目录里新增的文件（${Number(diag.sinceCount) || 0} 个）`
        )
      }
      out.warnings.push(
        '这次只写回了正文：没扫到任何产物文件' +
          (scanned.length ? ` —— 已查 ${scanned.join('、')}` : '') +
          '；如果这一步本该产出文件，说明 Agent 没把文件写进这次运行的产物目录'
      )
    } else {
      if (noContent.length) {
        out.warnings.push(
          `有 ${noContent.length} 个产物读不回内容、没挂附件：${namesOf(noContent)}` +
            '（多半是文件超过 5MB 或读取失败）'
        )
      }
      if (found.length > MAX_ARTIFACT_FILES) {
        out.warnings.push(
          `这次产物有 ${found.length} 个，只挂了前 ${MAX_ARTIFACT_FILES} 个：` +
            `${namesOf(found.slice(MAX_ARTIFACT_FILES))}`
        )
      }
    }
    const files = found.filter(item => item.base64).slice(0, MAX_ARTIFACT_FILES)

    // 挂完附件要复核「节点上真的长出回形针没有」——协同模式下命令可能被丢弃或竞态，
    // 收尾时统一补一次（见 ensureResultVisible）。2026-10-08 用户反馈「要强制刷新才出现」。
    const landedChecks = []

    // 附件（产物文件 + 完整输出）统一挂在「附件」分支里，而「附件」**直接挂在任务容器下**
    // —— 2026-10-08 用户要求的结构：任务 → 附件 → 完整输出 | 产物
    say('正在准备附件…')
    // refresh：每一步之后都按 uid 把引用换成「当前活的那只」——插入会触发重渲染，
    // 手里的旧引用从那一刻起就不再更新（数据对、画布对，只有旧引用是死的）。
    const refresh = node => liveNode(mindMap, node) || node
    let branch = findAttachBranch(refresh(container))
    if (!branch) {
      const res = markPlaced(
        await insertTreesWithRetry(mindMap, container, [
          { data: { text: ATTACH_BRANCH_TITLE }, children: [] }
        ])
      )
      branch = res.nodes[0] || null
      markTouched(branch)
    }
    if (!branch) {
      out.warnings.push(
        '附件分支没建起来（命令没落到图上）—— 这次的结果没有写进导图'
      )
    } else {
      out.nodes += 1
      const kids = () => refresh(branch).children || []

      // 1) 产物文件：一个文件一个子节点（同名节点直接复用，不重复建）
      const missing = files.filter(
        info => !kids().some(k => nodeText(k) === String(info.name || ''))
      )
      if (missing.length) {
        say(`正在挂载 ${missing.length} 个产物文件…`)
        // 按 uid 认领 + 没落地就重试一次（协同偶尔会吃掉插入命令）
        const res = markPlaced(
          await insertTreesWithRetry(
            mindMap,
            branch,
            missing.map(info => ({ data: { text: String(info.name) } }))
          )
        )
        out.nodes += res.nodes.filter(Boolean).length
        if (res.lost.length) {
          out.warnings.push(
            `有 ${res.lost.length} 个产物节点没落进导图（命令被协同服务丢了）：` +
              `${res.lost.slice(0, 3).join('、')}${res.lost.length > 3 ? ' 等' : ''}` +
              ' —— 刷新页面后点「写入导图」可重试'
          )
        }
      }
      for (let i = 0; i < files.length; i += 1) {
        const info = files[i]
        // 每一步都重查一次节点（上面的插入会重渲染，引用会失效）
        const node = markTouched(
          kids().find(k => nodeText(k) === String(info.name || ''))
        )
        if (!node) continue
        if (Number(info.size) > MAX_ATTACH_BYTES) {
          out.warnings.push(
            `${info.name} 有 ${sizeText(info.size)}，超过 ${Math.round(
              MAX_ATTACH_BYTES / 1024 / 1024
            )}MB，只记了文件名没挂附件`
          )
          continue
        }
        try {
          const file = fileFromBase64(info.name, info.base64, info.mime)
          const done = await attachToNode(mindMap, node, roomKey, file, bridgeAttach)
          landedChecks.push({ node, file, name: info.name, attachment: done })
          out.attachments.push({
            name: info.name,
            kind: 'artifact',
            via: (done && done.via) || 'collab'
          })
        } catch (err) {
          out.warnings.push(`${info.name} 没挂上：${errorDetail(err)}`)
        }
      }

      // 2) 完整输出：放最后（文件名带时间戳，下载后不重名）
      say('正在把完整输出存成文件挂上…')
      const mdName = `${title}.md`
      const mdLabel = '完整输出.md'
      let mdNode = kids().find(k => nodeText(k) === mdLabel)
      if (!mdNode) {
        // note 里存全文：节点上不铺长文本，但「继续执行」要从这儿取回上次的正文
        const res = markPlaced(
          await insertTreesWithRetry(mindMap, branch, [
            { data: { text: mdLabel, note: text } }
          ])
        )
        mdNode = res.nodes[0] || null
        if (mdNode) out.nodes += 1
        else
          out.warnings.push(
            '「完整输出.md」没落进导图（命令被协同服务丢了，已自动重试过一次）—— ' +
              '刷新页面后点「写入导图」再试'
          )
      }
      markTouched(mdNode)
      // 引用再刷一次（插产物/插完整输出都会引发重渲染）
      mdNode = refresh(mdNode)
      markTouched(mdNode)
      if (mdNode && typeof mdNode.setData === 'function') {
        try {
          mdNode.setData({ note: text })
        } catch (err) {
          /* 只读态丢弃，正文还在附件里 */
        }
      }
      if (mdNode) {
        try {
          const mdFile = fileFromText(mdName, text, 'text/markdown')
          const uploaded = await attachToNode(
            mindMap,
            mdNode,
            roomKey,
            mdFile,
            bridgeAttach
          )
          landedChecks.push({ node: mdNode, file: mdFile, name: mdLabel, attachment: uploaded })
          out.attachments.push({
            name: mdFile.name,
            kind: 'text',
            via: (uploaded && uploaded.via) || 'collab'
          })
        } catch (err) {
          out.warnings.push(`完整输出没挂上：${errorDetail(err)}`)
        }
      }

      // 收尾：展开到新内容、复核附件落地、强制重绘 —— 让结果当场可见，不用手动刷新
      say('正在刷新节点…')
      try {
        ensureResultVisible(mindMap, container, landedChecks)
      } catch (err) {
        console.warn('[writer] ensureResultVisible failed:', err)
      }
    }
  }

  // 产物文件存在、但桥接不许读（不在执行会话工作目录里）—— 这是「产物没挂上」最常见的原因，
  // 一定要说出来，并且告诉用户怎么解（在桥接启动参数里加 --artifact-roots）
  if (artifactSkips && artifactSkips.length) {
    const names = artifactSkips
      .map(item => (item && (item.name || item.path)) || '')
      .filter(Boolean)
    out.warnings.push(
      `有 ${artifactSkips.length} 个产物没挂上（文件在，但不在桥接允许读取的目录里）：` +
        `${names.slice(0, 3).join('、')}${names.length > 3 ? ' 等' : ''}` +
        ' —— 在执行那台电脑启动桥接时加参数 --artifact-roots "产物所在目录"（分号分隔可以给多个）'
    )
  }

  // ⚠️ 收尾复核（2026-10-08「状态栏说成功、图上什么都没有」；2026-10-09 修误报）：
  // 上面整条路都是「不抛错」的写法 —— 命令被协同服务**静默丢掉**时也会一路走到这里，
  // 于是界面报成功、画布上一个节点都没有。所以最后必须确认东西真的落到了图上。
  //
  // 判据**不能**是「落点子节点数有没有变多」（旧写法 `waitContainerGrowth`）：写回是
  // **幂等复用**的 —— 附件分支 / 产物节点 / 完整输出都按名字复用，重试第二次时数量本来就
  // 不会涨。2026-10-09 15:35 用户收到的
  //   「写入导图失败：命令没有落到图上（落点「任务 · 10-09 15:35」现在有 2 个子节点）」
  // 就是那条判据在**重试**时误报的 —— 他手动点一次「写入导图」往往就成，说明内容早在图上。
  //
  // 换成「本次到底插进去了什么」：`fresh` 里的 uid 是 `insertTreesWithRetry` **确认过在树上**
  // 的（命令被静默丢弃时它是空的，见该函数的 `placedUids`）。
  const placedThisRun = Array.from(fresh)
  let landedOk = true
  if (placedThisRun.length) {
    // 本次有新插 → 等它们都真在树上（按 uid 认领，不看数量）
    landedOk = !!(await waitForInserted(mindMap, container, placedThisRun, { all: true }))
  } else {
    // 本次一个新节点都没插 → 两种可能：① 全部复用（幂等重写，结果早在图上，算成功）；
    // ② 该插的一个都没落（命令被丢弃）。用**结构**区分：附件分支还在不在。
    const insp = inspectJobResult({ mindMap, nodeUid: nodeUid(container) })
    landedOk = !!(insp.exists && (!roomKey || insp.hasAttach))
  }
  if (!landedOk) {
    throw new Error(readonlyReason(mindMap) || insertFailedReason(mindMap, container))
  }

  // 给「这次的任务」加一个范围概要：包住任务内容 + 运行输出，
  // 概要留成「下一步做什么」的填写位 —— 下次点运行会读它当任务指令
  say('正在给这次结果加概要…')
  try {
    const batch = ((liveNode(mindMap, container) || container).children || []).slice()
    const generalization = addFollowUpGeneralization(mindMap, container, batch)
    out.generalization = generalization
      ? { nodes: batch.length, text: FOLLOW_UP_PLACEHOLDER }
      : null
  } catch (err) {
    out.generalization = null
    out.warnings.push(`概要没加上：${(err && err.message) || err}`)
  }

  // 交给调用方去问「服务端确认了没有」（Toolbar.verifyWritePersisted）
  out.ensuredUids = Array.from(touched)
  out.insertedUids = Array.from(fresh)
  say('已写入导图')
  return out
}
