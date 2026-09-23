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
// 一段太长就按句子拆成几条（不是砍掉），最多留几条
const SENTENCE_PER_ITEM = 4
const MAX_NODES = 40
const MAX_ARTIFACT_FILES = 8
// 单个产物超过这个大小就只记名字，不做附件上传（浏览器 base64 + 续传都吃不消）
const MAX_ATTACH_BYTES = 5 * 1024 * 1024
const ATTACH_TEXT_LIMIT = 2400

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

/** 长文按句子切段（保留内容，不是砍掉），再按行宽合并 */
function splitLong(text, limit = NODE_TEXT_LIMIT) {
  const parts = sentencesOf(text)
  if (parts.length <= 1) return [clip(text, limit)]
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
  return out.map(line => clip(line, limit))
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
  // 概要数据挂在范围第一个节点上
  const raw = nodes[0].getData('generalization')
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
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

function resolveTargetNode(mindMap, uid) {
  const renderer = mindMap && mindMap.renderer
  const wanted = String(uid || '').trim()
  if (wanted && renderer && typeof renderer.findNodeByUid === 'function') {
    // 指定了落点就以它为准：找不到宁可报错，也不要悄悄写到别的节点上
    return renderer.findNodeByUid(wanted) || null
  }
  const active = renderer && renderer.activeNodeList && renderer.activeNodeList[0]
  return active || null
}

function lastChildOf(node) {
  const list = (node && node.children) || []
  return list[list.length - 1] || null
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
 * 等新插入的子节点真的挂上（协作模式下命令可能不是同步落到树上）。
 * 返回新出现的那个子节点。
 */
async function waitNewChild(parent, before, tries = 24) {
  const prev = new Set(before || [])
  for (let i = 0; i < tries; i += 1) {
    const list = (parent && parent.children) || []
    const found = list.find(item => !prev.has(item))
    if (found) return found
    if (i < tries - 1) await sleep(50)
  }
  return lastChildOf(parent)
}

function insertChildren(mindMap, parent, trees) {
  if (!trees || !trees.length) return
  if (parent && typeof parent.setData === 'function') {
    parent.setData({ expand: true })
  }
  mindMap.execCommand('INSERT_MULTI_CHILD_NODE', [parent], trees)
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
  if (mindMap && typeof mindMap.execCommand === 'function') {
    mindMap.execCommand('SET_NODE_ATTACHMENT', node, '', name, meta)
    return
  }
  // 兜底：拿不到命令时直接写数据，至少不丢内容
  const patch = { attachmentUrl: '', attachmentName: name, ...meta }
  if (node && typeof node.setData === 'function') {
    node.setData(patch)
  } else if (
    mindMap &&
    mindMap.renderer &&
    typeof mindMap.renderer.setNodeDataRender === 'function'
  ) {
    mindMap.renderer.setNodeDataRender(node, patch)
  }
  if (node && typeof node.reRender === 'function') {
    node.reRender(['attachment'])
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
        applyAttachment(mindMap, node, attachment, file)
        return { ...attachment, via: 'mcp' }
      }
    } catch (err) {
      // 桥接这条路不通（旧版桥接 / 没配 MCP）就退回协同服务上传
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
  applyAttachment(mindMap, node, attachment, file)
  return attachment
}

/**
 * 在运行节点下建一个「任务 · 时间」容器：这次的任务内容与结果都挂在它下面。
 * 一次运行一个容器 —— 运行输出永远紧跟任务内容，不会落到 SOP 末尾。
 * @returns {Promise<{ uid: String, title: String, node: Object }>}
 */
export async function createJobContainer({
  mindMap,
  nodeUid: targetUid,
  prompt
} = {}) {
  if (!mindMap) throw new Error('导图还没准备好，稍后再试')
  const target = resolveTargetNode(mindMap, targetUid)
  if (!target) throw new Error('找不到要挂任务的节点（可能已被删掉）')

  const text = String(prompt || '').trim()
  const title = buildTaskContainerTitle()
  // 任务内容是多行提示词，节点文本压成一行（脑图上不加备注标签）
  const inline = cleanInlineMarkdown(text).replace(/\s+/g, ' ').trim()
  const before = (target.children || []).slice()
  insertChildren(mindMap, target, [
    {
      data: { text: title },
      children: text
        ? [{ data: { text: `任务内容：${clip(inline, NODE_TEXT_LIMIT)}` } }]
        : []
    }
  ])
  const created = await waitNewChild(target, before)
  if (!created) throw new Error('建任务节点失败，请重试')
  return { uid: nodeUid(created), title, node: created }
}

/**
 * @param {Object}   payload
 * @param {Object}   payload.mindMap    simple-mind-map 实例（Edit.vue 持有）
 * @param {String}   payload.nodeUid    落点：运行节点，或这次运行的任务容器
 * @param {String}   payload.markdown   完整输出
 * @param {String}   payload.prompt     任务内容（落点不是容器、需要现建容器时用）
 * @param {String}   payload.roomKey    房间 key，缺了就不挂附件
 * @param {Array}    payload.artifacts  产物文件 [{name, size, mime, base64}]
 * @param {Function} payload.bridgeAttach 经桥接 MCP 挂附件的通道（可选；给了就优先用它）
 * @param {Function} payload.onProgress 进度文字回调
 */
export async function writeJobResultToMap({
  mindMap,
  nodeUid: targetUid,
  markdown,
  prompt,
  roomKey,
  artifacts,
  bridgeAttach,
  onProgress
} = {}) {
  const say = text => {
    if (onProgress) onProgress(text)
  }
  if (!mindMap) throw new Error('导图还没准备好，稍后再试')
  const text = String(markdown || '').trim()
  if (!text) throw new Error('这次运行没有文字输出，没东西可写入脑图')
  const resolved = resolveTargetNode(mindMap, targetUid)
  if (!resolved) throw new Error('找不到运行的那个节点（可能已被删掉）')

  // 落点必须落在「任务」里面：目标本身是容器就用它，否则现建一个 ——
  // 这样运行输出永远跟在这次的任务后面，不会甩在 SOP 末尾
  let container = isTaskContainerNode(resolved) ? resolved : null
  if (!container) {
    say('正在新建任务节点…')
    const made = await createJobContainer({
      mindMap,
      nodeUid: nodeUid(resolved),
      prompt
    })
    container = made.node
  }

  const title = buildResultTitle()
  const tree = markdownToNodes(text)
  const containerBefore = (container.children || []).slice()
  say('正在把结果写进导图…')
  insertChildren(mindMap, container, [
    { data: { text: title }, children: tree.children }
  ])
  const resultNode = await waitNewChild(container, containerBefore)
  if (!resultNode) throw new Error('写入导图失败，请重试')

  const out = {
    title,
    nodeUid: nodeUid(resultNode),
    containerUid: nodeUid(container),
    nodes: 1 + countNodeTrees(tree.children),
    missing: tree.missing || [],
    dropped: tree.dropped || 0,
    attachments: [],
    warnings: []
  }

  if (!roomKey) {
    out.warnings.push('没有房间信息，本次只写了文字、没挂附件')
  } else {
    const files = (artifacts || [])
      .filter(item => item && item.name && item.base64)
      .slice(0, MAX_ARTIFACT_FILES)

    // 附件（产物文件 + 完整输出）统一挂在一个「附件」分支里，这个分支排在
    // 「产出」节点后面；**不挂在「运行输出」节点本身上**（这样运行输出节点保持干净）
    say('正在准备附件…')
    let branch = findAttachBranch(resultNode)
    if (!branch) {
      const beforeBranch = (resultNode.children || []).slice()
      insertChildren(mindMap, resultNode, [
        { data: { text: ATTACH_BRANCH_TITLE }, children: [] }
      ])
      branch = await waitNewChild(resultNode, beforeBranch)
    }
    if (!branch) {
      out.warnings.push('附件分支没建起来，这次只写了文字')
    } else {
      out.nodes += 1
      const kids = () => branch.children || []

      // 1) 产物文件：一个文件一个子节点（同名节点直接复用，不重复建）
      const missing = files.filter(
        info => !kids().some(k => nodeText(k) === String(info.name || ''))
      )
      if (missing.length) {
        say(`正在挂载 ${missing.length} 个产物文件…`)
        const beforeFiles = kids().slice()
        insertChildren(
          mindMap,
          branch,
          missing.map(info => ({ data: { text: String(info.name) } }))
        )
        await waitNewChild(branch, beforeFiles)
        out.nodes += missing.length
      }
      for (let i = 0; i < files.length; i += 1) {
        const info = files[i]
        const node = kids().find(k => nodeText(k) === String(info.name || ''))
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
        const beforeMd = kids().slice()
        insertChildren(mindMap, branch, [{ data: { text: mdLabel } }])
        mdNode = await waitNewChild(branch, beforeMd)
        out.nodes += 1
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
          out.attachments.push({
            name: mdFile.name,
            kind: 'text',
            via: (uploaded && uploaded.via) || 'collab'
          })
        } catch (err) {
          out.warnings.push(`完整输出没挂上：${errorDetail(err)}`)
        }
      }
    }
  }

  // 给「这次的任务」加一个范围概要：包住任务内容 + 运行输出，
  // 概要留成「下一步做什么」的填写位 —— 下次点运行会读它当任务指令
  say('正在给这次结果加概要…')
  try {
    const batch = (container.children || []).slice()
    const generalization = addFollowUpGeneralization(mindMap, container, batch)
    out.generalization = generalization
      ? { nodes: batch.length, text: FOLLOW_UP_PLACEHOLDER }
      : null
  } catch (err) {
    out.generalization = null
    out.warnings.push(`概要没加上：${(err && err.message) || err}`)
  }

  say('已写入导图')
  return out
}
