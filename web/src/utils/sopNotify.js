/**
 * SOP / 流程中的「通知 / 提醒」类节点：
 * - 识别通知、提醒、知会、抄送、催办等标题
 * - 从标题或子节点解析「给谁」
 * - 自动判断阻塞（等待/确认/审批）或继续
 * - 当前 AI 后端派发企微待办 + 写入导图 CPDA 待办树
 */
import { createRoomTodo, listRoomTodos } from './fileApi'
import { dispatchTodo, areWaitingWecomTodosDone } from './sendTodo'
import { normalizeWecomTodoTitle } from './wecomTodoTitle'

/** 通知 / 提醒类节点（命中任一即可） */
export const NOTIFY_TITLE_RE =
  /AI\s*发起\s*(?:通知|提醒)|发起(?:通知|提醒)|^(?:通知|提醒)\s*[：:]|知会|请(?:通知|提醒)|发送(?:通知|提醒)|催办|请催办|^AI\s*[:：].*(?:通知|提醒|催办|抄送)|抄送|(?:通知|提醒)对应的|(?:通知|提醒).{0,12}给/i

/** 阻塞语义：发完后停住，等人完成待办再继续 */
export const BLOCK_TITLE_RE =
  /等待|确认|审批|阻塞|签核|复核通过|务必完成|点击发送|点击.*发送|人工(?:完成|确认|处理)|手动(?:完成|发送)|手工/i

/** 人工闸门：不自动往下跑，必须等人做完 */
export const MANUAL_GATE_RE =
  /点击发送|点击.*发送|请(?:人工|手动|手工)|人工(?:完成|确认|处理|发送)|手动(?:完成|发送)|待人工|等人完成/i

export function isManualGateTitle(text) {
  const t = stripNodeText(text)
  if (!t || t.length > 80) return false
  return MANUAL_GATE_RE.test(t)
}

/** 明确非阻塞（知会类） */
export const CONTINUE_HINT_RE = /知会|抄送|仅通知|仅提醒|不阻塞|无需等待|顺便告知/i

/** 不像通知动作的长叙述（避免误伤） */
const NOTIFY_EXCLUDE_RE =
  /查询|生成JD|筛选简历|输出评价|内部评估|结合简历|预起草|成长计划/

export function stripNodeText(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/^[-*•●]\s*/, '')
    .trim()
}

export function isNotifyTitle(text) {
  const t = stripNodeText(text)
  if (!t) return false
  if (NOTIFY_EXCLUDE_RE.test(t) && !/(?:通知|提醒|催办|知会|抄送)/.test(t.slice(0, 12))) {
    return false
  }
  if (NOTIFY_TITLE_RE.test(t)) return true
  // 短标题含「通知/提醒/催办」且像动作节点
  if (
    t.length <= 40 &&
    /(?:通知|提醒|催办)/.test(t) &&
    !NOTIFY_EXCLUDE_RE.test(t)
  ) {
    return true
  }
  return false
}

/**
 * 是否阻塞：标题/附近上下文含等待类词，且没有「仅知会」类豁免
 */
export function shouldBlockNotify(text, contextText = '') {
  const blob = `${stripNodeText(text)}\n${stripNodeText(contextText)}`
  if (CONTINUE_HINT_RE.test(blob) && !/必须等待|务必确认|强制阻塞/.test(blob)) {
    return false
  }
  return BLOCK_TITLE_RE.test(blob)
}

export function parseAssigneeFromText(text) {
  const raw = stripNodeText(text)
  const m = raw.match(
    /^(?:代办人|待办人|接收人|负责人|通知人|提醒人|接收者)\s*[：:]\s*(.+)$/
  )
  if (!m) return ''
  return String(m[1] || '')
    .replace(/[|｜].*$/, '')
    .trim()
}

/**
 * 从通知/提醒标题里拆出「给谁」
 * 例：AI:通知对应的HRBP → HRBP
 *     抄送副总、人事 → 副总、人事
 *     …给:行政、人事、IT → 行政、人事、IT
 * 注意：「提醒：行政准备工位」这类「提醒：任务内容」不把整句当接收人
 */
export function parseAssigneeFromNotifyTitle(text) {
  const t = stripNodeText(text)
  if (!t) return ''

  let m = t.match(/给\s*[:：]\s*(.+)$/)
  if (m) return cleanAssigneeList(m[1])

  m = t.match(/抄送\s*[:：]?\s*(.+)$/)
  if (m) return cleanAssigneeList(m[1])

  m = t.match(/(?:通知|提醒|催办|知会)对应的\s*(.+)$/i)
  if (m) return cleanAssigneeList(m[1])

  // 通知HRBP / 提醒行政（角色紧跟动词、后面可有任务）
  m = t.match(
    /(?:通知|提醒|催办|知会)\s*(行政|人事|HRBP|IT|需求方|总经理|副总|负责人)((?:、|\/|,|，)[^：:]*)?/i
  )
  if (m) {
    return cleanAssigneeList(m[2] ? `${m[1]}${m[2]}` : m[1])
  }

  return ''
}

function cleanAssigneeList(raw) {
  return String(raw || '')
    .replace(/[|｜].*$/, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\s+/g, '')
    .replace(/[、,，]/g, '、')
    .replace(/^、|、$/g, '')
    .trim()
}

const ROLE_ASSIGNEE_RE =
  /^(?:行政|人事|HRBP|ITBP|IT|需求方|总经理|副总|负责人|部门负责人)(?:、(?:行政|人事|HRBP|ITBP|IT|需求方|总经理|副总|负责人|部门负责人))*$/i

export function isRoleAssignee(name) {
  const s = cleanAssigneeList(name)
  return !s || ROLE_ASSIGNEE_RE.test(s)
}

/**
 * 从运行前备注 / 提交资料里解析真实接收人
 * 例：给黄炜龙发个代办、代办人：黄炜龙、接收人：张三、发给李四
 */
export function parseAssigneesFromExtraNote(note) {
  const text = String(note || '').trim()
  if (!text) return []
  const found = []
  const seen = new Set()
  const push = raw => {
    let cleaned = cleanAssigneeList(raw)
    // 「给杨晓东也发」非贪婪失败时可能把「也」吃进名字
    cleaned = cleaned.replace(/(?:也|再|顺便|顺带)$/g, '')
    // 「给黄炜龙发送代办」被拆成「黄炜龙发」时去掉尾部动词残片
    cleaned = cleaned.replace(/[发送]$/g, '')
    if (!cleaned || cleaned.length < 2 || cleaned.length > 40) return
    // 跳过纯角色；多人用顿号拆开逐个收
    cleaned.split('、').forEach(part => {
      let p = cleanAssigneeList(part)
        .replace(/(?:也|再|顺便|顺带)$/g, '')
        .replace(/[发送]$/g, '')
      if (!p || p.length < 2 || p.length > 20) return
      if (isRoleAssignee(p)) return
      // 排除常见非人名噪声
      if (/^(?:请|把|将|用|在|到|从|和|与|及|的|了|吗|呢|吧)/.test(p)) return
      if (/资料|说明|约束|链接|补充|要求|产物|模型|负责人/.test(p)) return
      const key = p.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      found.push(p)
    })
  }

  const patterns = [
    /(?:代办人|待办人|接收人|通知人|提醒人|接收者)\s*[：:]\s*([^\n；;]+)/gi,
    // 「给黄炜龙发送代办」整词匹配，避免拆成「黄炜龙发」+「送代办」
    /给\s*([\u4e00-\u9fffA-Za-z·•]{2,12})\s*发送(?:代办|待办)/gi,
    // 「顺带给杨晓东也发个代办」
    /给\s*([\u4e00-\u9fffA-Za-z·•]{2,12}?)(?:也|再|顺便|顺带)?(?:发个|发一条|发了)(?:代办|待办)/gi,
    // 「给杨晓东发代办」（无「个」），但不要吃「发送」的「发」
    /给\s*([\u4e00-\u9fffA-Za-z·•]{2,12}?)(?:也|再|顺便|顺带)?发(?!送)(?:代办|待办)/gi,
    // 「给胡晓龙建一个测试待办」等创建式指令
    /给\s*([\u4e00-\u9fffA-Za-z·•]{2,12}?)\s*(?:创建|新建|建(?:立)?|添加|安排)(?:一(?:个|条))?.{0,40}?(?:代办|待办)/gi,
    /(?:代办|待办)\s*(?:发给|给)\s*[：:]?\s*([^\n；;]+)/gi,
    /发给\s*([\u4e00-\u9fffA-Za-z·•]{2,12})/gi
  ]
  patterns.forEach(re => {
    let m
    const r = new RegExp(re.source, re.flags)
    while ((m = r.exec(text))) {
      push(m[1])
    }
  })
  // 整段很短且像人名：直接当接收人（用户只填了「黄炜龙」）
  if (!found.length) {
    const compact = text.replace(/\s+/g, '')
    if (/^[\u4e00-\u9fffA-Za-z·•]{2,12}$/.test(compact)) push(compact)
  }
  return found
}

/**
 * 优先用运行前填写的真实人名，覆盖大纲里的 HRBP / 副总 等角色。
 * 若节点已是具体人名，不要用备注整表覆盖（多条子代办会串人）。
 */
export function resolveNotifyAssignee(nodeAssignee, extraNote) {
  const fromNote = parseAssigneesFromExtraNote(extraNote)
  if (fromNote.length && isRoleAssignee(nodeAssignee)) {
    return fromNote.join('、')
  }
  const fallback = cleanAssigneeList(nodeAssignee) || '负责人'
  return fallback
}

/** SOP 标题本身就是「给某人发企微代办」这类动作 */
export const WECOM_TODO_SOP_RE =
  /企业微信.*(?:代办|待办)|(?:发送|创建|新建|建(?:立)?|添加|安排|发个?|发一条).*(?:代办|待办)|给.+(?:发|创建|新建|建(?:立)?|添加|安排).*(?:代办|待办)|(?:代办|待办).*(?:发给|给)/i

/**
 * 单行是否像「给某人发企微代办」动作。
 * 必须含「给/发给 + 人 + 发/发送…代办」，避免「最近运行…待办预览」等台账噪声。
 */
export const WECOM_TODO_LINE_RE =
  /给\s*[\u4e00-\u9fffA-Za-z·•]{2,12}(?:也|再|顺便|顺带)?(?:发个|发一条|发了|发送|发(?!送)|创建|新建|建(?:立)?|添加|安排).{0,12}(?:代办|待办)|(?:使用)?(?:企业微信|企微).{0,20}给\s*[\u4e00-\u9fffA-Za-z·•]{2,12}.{0,12}(?:代办|待办)|(?:代办|待办)\s*(?:发给|给)\s*[\u4e00-\u9fffA-Za-z·•]{2,12}/i

/** 大纲里的台账/状态行，绝不当成待办指令 */
export function isWecomTodoNoiseLine(text) {
  const t = stripNodeText(text)
  if (!t) return true
  if (
    /^(?:最近运行|期望产物|耗时约|标题\s*[:：]|未真正|小策|WorkBuddy|刷新前|——|›|进度|模型输出|signal is aborted|已打包|使用模型|检查 |拉取 |发现 |知会)/i.test(
      t
    )
  ) {
    return true
  }
  if (/只返回了待办预览|确认门禁|未实际写入企业微信|可重新点运行|续跑会重新执行/.test(t)) {
    return true
  }
  // 纯台账回写句，没有「给某人发」动作
  if (/耗时约|期望产物|未真正派发/.test(t) && !/给\s*[\u4e00-\u9fff]{2,12}.{0,8}发/.test(t)) {
    return true
  }
  return false
}

export function isWecomTodoOrientedSop(sop) {
  const title = [sop && sop.id, sop && sop.title].filter(Boolean).join('：')
  return WECOM_TODO_SOP_RE.test(String(title || ''))
}

/** 从「说… / ：…」里抽出待办正文 */
export function extractWecomTodoBody(text) {
  const t = stripNodeText(text)
  if (!t) return ''
  let m = t.match(/(?:代办|待办)\s*(?:说|内容)\s*[：:]\s*(.+)$/)
  if (m) return stripNodeText(m[1]).slice(0, 200)
  m = t.match(/(?:代办|待办)\s*说\s*(.+)$/)
  if (m) return stripNodeText(m[1]).slice(0, 200)
  // 「说你的胆子…」但排除「说明」
  m = t.match(/说\s*[：:]?\s*(.+)$/)
  if (m && !/说明/.test(t)) {
    const body = stripNodeText(m[1])
    if (body.length >= 2 && body.length <= 120 && !/^(?:明|一下)/.test(body)) {
      return body
    }
  }
  return ''
}

/**
 * 从 SOP 标题 / 备注合成一条通知节点（大纲里没有「AI发起通知」时也能直派企微待办）
 */
export function synthesizeWecomTodoNotifyNode(sop, extraNote = '') {
  const title = stripNodeText((sop && sop.title) || '') || '企微待办'
  const fromTitle = parseAssigneesFromExtraNote(title)
  const fromNote = parseAssigneesFromExtraNote(extraNote)
  const assignee = (fromNote[0] || fromTitle[0] || '').trim() || '负责人'
  const body = extractWecomTodoBody(title)
  const todoTitle = normalizeWecomTodoTitle(body || title)
  return {
    // 从这一刻起，展示与派发都使用事项标题；原始指令只作为审计说明。
    text: todoTitle || body,
    todoTitle,
    originalText: title,
    detail: [
      [sop && sop.id, sop && sop.title].filter(Boolean).join('：'),
      `原始指令：${title}`,
      body ? `待办内容：${body}` : '',
      extraNote ? `备注：${String(extraNote).trim()}` : ''
    ]
      .filter(Boolean)
      .join('\n'),
    assignee,
    block: false,
    notifyKey: `wecom-todo:${String((sop && (sop.uid || sop.id)) || title).slice(0, 80)}`
  }
}

/**
 * 扫整棵 SOP 大纲：父节点 + 子节点里每一条「给某人发代办」都生成一条直派节点。
 * 过滤台账噪声，同一接收人只保留一条「标题型」代办 + 各条有独立正文的子指令。
 */
export function extractWecomTodoNotifyNodesFromOutline(
  outline,
  sop,
  extraNote = ''
) {
  const sopTitle = stripNodeText((sop && sop.title) || '')
  const lines = String(outline || '')
    .split(/\r?\n/)
    .map(line =>
      stripNodeText(line.replace(/^(\s*)/, '').replace(/^[-*•●]\s*/, ''))
    )
    .map(t => t.replace(/^(?:[A-Za-z]\d*\s*[:：]\s*|标题\s*[:：]\s*)/, ''))
    .filter(Boolean)

  const nodes = []
  const seen = new Set()
  const pushNode = (rawText, forceAssignee = '') => {
    let text = stripNodeText(rawText)
    text = text.replace(/^(?:[A-Za-z]\d*\s*[:：]\s*|标题\s*[:：]\s*)/, '')
    if (!text || isWecomTodoNoiseLine(text)) return
    if (!WECOM_TODO_LINE_RE.test(text)) return
    const assignees = forceAssignee
      ? [forceAssignee]
      : parseAssigneesFromExtraNote(text)
    if (!assignees.length) return // 解析不出人名就跳过，避免「负责人」乱发
    const body = extractWecomTodoBody(text)
    assignees.forEach(assignee => {
      const who = cleanAssigneeList(assignee)
        .replace(/(?:也|再|顺便|顺带)$/g, '')
        .replace(/[发送]$/g, '')
      if (!who || who === '负责人' || isRoleAssignee(who)) return
      // 标题回声（父节点/标题行）按接收人去重；带独立正文的子指令按正文去重
      const isTitleEcho =
        !body ||
        body === sopTitle ||
        body === text ||
        /给.+发.*(?:代办|待办)/.test(body)
      const key = isTitleEcho
        ? `assignee:${who}`
        : `${who}::${String(body).slice(0, 80)}`
      if (seen.has(key)) return
      // 已有该人的标题型代办时，不再加另一条标题回声
      if (isTitleEcho && seen.has(`assignee:${who}`)) return
      seen.add(key)
      if (isTitleEcho) seen.add(`assignee:${who}`)
      const taskText = isTitleEcho ? sopTitle || text : body || text
      const todoTitle = normalizeWecomTodoTitle(taskText)
      nodes.push({
        // 保留原始句用于说明，但不要让它成为待办卡片标题。
        text: todoTitle,
        todoTitle,
        originalText: text,
        detail: [
          [sop && sop.id, sop && sop.title].filter(Boolean).join('：'),
          text !== taskText ? `原始指令：${text}` : '',
          !isTitleEcho && text !== body ? `原文：${text}` : '',
          body && !isTitleEcho ? `待办内容：${body}` : '',
          extraNote ? `备注：${String(extraNote).trim()}` : ''
        ]
          .filter(Boolean)
          .join('\n'),
        assignee: who,
        block: false,
        notifyKey: `wecom-todo:${who}:${String(body || text).slice(0, 48)}`
      })
    })
  }

  lines.forEach(line => pushNode(line))

  // 大纲为空或没命中时，退回标题合成
  if (!nodes.length) {
    const one = synthesizeWecomTodoNotifyNode(sop, extraNote)
    if (one && one.assignee && one.assignee !== '负责人') nodes.push(one)
    else if (one) nodes.push(one)
  }

  // 运行备注里若还有大纲未覆盖的接收人，补一条（仅当备注本身像发代办）
  const noteAssignees = parseAssigneesFromExtraNote(extraNote)
  noteAssignees.forEach(who => {
    if (seen.has(`assignee:${who}`) || [...seen].some(k => k.startsWith(`${who}::`))) {
      return
    }
    if (!WECOM_TODO_LINE_RE.test(String(extraNote || '')) && nodes.length) return
    pushNode(extraNote || `给${who}发送代办`, who)
  })

  return nodes
}

/** 企微待办标题：短、干净，避免把整段 AI 节点文案塞进去 */
export function buildWecomTodoTitle(node, sop, assignee) {
  const structuredTitle = normalizeWecomTodoTitle(node && node.todoTitle)
  if (structuredTitle) return structuredTitle
  const sopTitle = String((sop && sop.title) || '').trim() || 'SOP'
  let action = stripNodeText((node && node.text) || '')
    .replace(/^AI\s*[:：]\s*/i, '')
    .replace(/\s*[|｜].*$/, '')
    .replace(/\s*→\s*代办[：:].*$/, '')
    .trim()
  // 父节点回声：不要「标题 · 标题」
  if (
    !action ||
    action === sopTitle ||
    action.includes(sopTitle) ||
    /给.+发.*(?:代办|待办)/.test(action)
  ) {
    const body = extractWecomTodoBody(action)
    action = body && body !== sopTitle ? body : ''
  }
  // 企微标题只保留可执行事项；SOP 名称、接收人和渠道信息都放到描述中。
  return normalizeWecomTodoTitle(action || sopTitle)
}

/**
 * 从大纲文本抽取通知/提醒节点（按缩进父子关系取代办人 / 上下文）
 */
export function extractNotifyNodesFromOutline(outline) {
  const lines = String(outline || '').split(/\r?\n/)
  const items = []
  lines.forEach((line, index) => {
    const indent = (line.match(/^(\s*)/) || ['', ''])[1].length
    const text = stripNodeText(
      line.replace(/^(\s*)/, '').replace(/^[-*•●]\s*/, '')
    )
    if (!text) return
    const manualGate = isManualGateTitle(text)
    if (!manualGate && !isNotifyTitle(text)) return

    const nearby = []
    let assignee = ''
    // 子节点显式「代办人：」优先于标题启发式
    for (let i = index + 1; i < lines.length && i < index + 24; i++) {
      const l = lines[i]
      if (!l || !l.trim()) continue
      const ind = (l.match(/^(\s*)/) || ['', ''])[1].length
      if (ind <= indent && i > index) break
      const t = stripNodeText(l.replace(/^(\s*)/, '').replace(/^[-*•●]\s*/, ''))
      if (!t) continue
      nearby.push(t)
      if (!assignee) {
        const a = parseAssigneeFromText(t)
        if (a) assignee = a
      }
    }
    if (!assignee) {
      assignee = parseAssigneeFromNotifyTitle(text)
    }
    // 向上找同级/父级代办人
    if (!assignee) {
      for (let i = index - 1; i >= 0 && i >= index - 30; i--) {
        const l = lines[i]
        const ind = (l.match(/^(\s*)/) || ['', ''])[1].length
        const t = stripNodeText(
          l.replace(/^(\s*)/, '').replace(/^[-*•●]\s*/, '')
        )
        if (!t) continue
        if (ind < indent) {
          const a =
            parseAssigneeFromText(t) || parseAssigneeFromNotifyTitle(t)
          if (a) {
            assignee = a
            break
          }
          if (ind === 0) break
        }
        if (ind === indent) {
          const a = parseAssigneeFromText(t)
          if (a) {
            assignee = a
            break
          }
        }
      }
    }

    const contextText = nearby.join('\n')
    const block = manualGate || shouldBlockNotify(text, contextText)
    const notifyKey = `notify:${index}:${text.slice(0, 40)}`
    items.push({
      index,
      text,
      assignee: assignee || (manualGate ? '执行人' : '负责人'),
      block,
      manualGate: !!manualGate,
      nearby,
      contextText,
      notifyKey,
      detail: nearby
        .filter(t => !parseAssigneeFromText(t))
        .slice(0, 8)
        .join('；')
    })
  })
  return items
}

/**
 * 处理通知节点：写入 CPDA 待办 + WorkBuddy 派发
 */
export async function processNotifyNodes({
  roomKey,
  nodes,
  sop,
  conversationId,
  onStatus,
  onDelta,
  onEvent,
  signal,
  extraNote = '',
  skipKeys = [],
  stopOnFirstBlock = true,
  backend = ''
} = {}) {
  const list = Array.isArray(nodes) ? nodes : []
  const skip = new Set((skipKeys || []).filter(Boolean))
  const overrideAssignees = parseAssigneesFromExtraNote(extraNote)
  const results = []
  for (let i = 0; i < list.length; i++) {
    const node = list[i]
    if (node && node.notifyKey && skip.has(node.notifyKey)) {
      results.push({
        ...node,
        skipped: true,
        dispatchOk: true,
        text: node.text,
        assignee: node.assignee,
        block: !!node.block
      })
      continue
    }
    const assignee = resolveNotifyAssignee(node.assignee, extraNote)
    if (onStatus) {
      onStatus(
        `${node.block ? '阻塞' : '知会'}派发 ${i + 1}/${list.length}：「${
          node.todoTitle || node.text
        }」→ ${assignee}${
          overrideAssignees.length && isRoleAssignee(node.assignee)
            ? '（已用运行前填写的接收人）'
            : ''
        }`
      )
    }
    const wxTitle = buildWecomTodoTitle(node, sop, assignee)
    const note = [
      `代办人：${assignee}`,
      node.originalText ? `原始指令：${node.originalText}` : '',
      node.detail || '',
      `来源：${
        [sop && sop.id, sop && sop.title].filter(Boolean).join('：') || 'SOP'
      }`,
      node.block
        ? '完成此待办后流程才会继续。'
        : '知会/提醒类通知，流程已继续执行。'
    ]
      .filter(Boolean)
      .join('\n')

    if (!wxTitle) {
      const error = '无法识别待办标题，已跳过创建。请在指令中填写“标题：具体事项”。'
      if (onStatus) onStatus(error)
      results.push({
        ...node,
        assignee,
        displayTitle: '',
        wxTitle: '',
        taskUid: '',
        cpdaOk: false,
        cpdaError: error,
        dispatchOk: false,
        dispatchReply: error,
        dispatchError: error,
        dispatchVia: '',
        dispatchBackendLabel: ''
      })
      continue
    }
    // 导图 CPDA 和企业微信共用同一个规范标题，原始指令进入 note，不再出现双标题。
    const mapTitle = wxTitle

    let taskUid = ''
    let cpdaOk = false
    let cpdaError = ''
    // 不再把导图「待办」当作阻塞条件；可选写入仅作留痕，失败忽略
    try {
      const childNodes = [{ text: `代办人：${assignee}` }]
      if (node.detail) {
        childNodes.push({
          text: `详情：${String(node.detail).slice(0, 200)}`
        })
      }
      const created = await createRoomTodo(roomKey, {
        text: mapTitle,
        note,
        assignee,
        block: !!node.block,
        sop_id: (sop && sop.id) || '',
        sop_uid: (sop && (sop.uid || (sop.uids && sop.uids[0]))) || '',
        notify_key: node.notifyKey,
        children: childNodes
      })
      taskUid = (created && created.task_uid) || ''
      cpdaOk = !!taskUid
    } catch (err) {
      cpdaError = (err && err.message) || String(err || '写入待办失败')
      console.warn('[sopNotify] createRoomTodo failed (ignored for wait)', err)
    }

    let dispatchReply = ''
    let dispatchOk = false
    let dispatchError = ''
    let dispatchVia = ''
    let dispatchBackendLabel = ''
    let todoId = ''
    try {
      const todo = await dispatchTodo({
        assignee: { name: assignee },
        title: wxTitle,
        // 标题只传待办事项；派发人、来源和阻塞说明进入描述，供小策/企微查看。
        detail: note,
        // 不把 SOP 上下文塞进聊天，避免模型跑偏去分析 JD
        conversationId: conversationId
          ? `${conversationId}-todo-${i}-${Date.now().toString(36)}`
          : undefined,
        model: 'auto',
        backend,
        signal,
        onEvent: (label, raw) => {
          if (onEvent) onEvent(label, raw)
        },
        onDelta: text => {
          if (onDelta) {
            onDelta(`【企微待办 → ${assignee}】\n${String(text || '')}`)
          }
        }
      })
      dispatchReply = (todo && todo.content) || ''
      dispatchOk = !!(todo && todo.success)
      dispatchError = (todo && todo.error) || ''
      dispatchVia = (todo && todo.via) || ''
      todoId = (todo && todo.todoId) || ''
      dispatchBackendLabel =
        (todo && todo.backendLabel) ||
        (dispatchVia === 'xiaoce-wecom'
          ? '小策'
          : dispatchVia === 'openclaw-wecom'
            ? '助理'
            : 'WorkBuddy')
      if (!dispatchOk && dispatchError) {
        dispatchReply = `${dispatchError}\n${dispatchReply}`.trim()
      }
    } catch (err) {
      dispatchReply = (err && err.message) || '企微派发失败'
      dispatchError = dispatchReply
      console.warn('[sopNotify] dispatchTodo failed', err)
    }

    results.push({
      ...node,
      assignee,
      displayTitle: mapTitle,
      wxTitle,
      taskUid,
      todoId,
      cpdaOk,
      cpdaError,
      dispatchOk,
      dispatchError,
      dispatchReply,
      dispatchVia,
      dispatchBackendLabel
    })
    // 逐步执行：企微派发成功后立刻停，等企微待办完成再继续
    if (stopOnFirstBlock && node.block && dispatchOk) {
      if (onStatus) {
        onStatus(
          `已停在阻塞步骤「${node.text}」，等待企业微信待办完成后继续`
        )
      }
      break
    }
  }
  return results
}

export function summarizeNotifyResults(results) {
  const list = Array.isArray(results) ? results : []
  const blocking = list.filter(r => r.block && !r.skipped)
  const continued = list.filter(r => !r.block && !r.skipped)
  // 阻塞等待只认企微派发成功；导图待办不再作为条件
  const waitingBlock = list.filter(r => r.block && !r.skipped && r.dispatchOk)
  const dispatchFailed = list.filter(
    r => r.block && !r.skipped && !r.dispatchOk
  )
  const waitingWecomTodos = waitingBlock.map(r => ({
    todoId: r.todoId || '',
    title: r.wxTitle || r.text || r.title || '',
    wxTitle: r.wxTitle || '',
    assignee: r.assignee || '',
    via: r.dispatchVia || '',
    notifyKey: r.notifyKey || ''
  }))
  return {
    total: list.length,
    blocking,
    continued,
    hasBlocking: waitingBlock.length > 0,
    dispatchFailed,
    waitingTaskUids: waitingBlock.map(r => r.taskUid).filter(Boolean),
    waitingWecomTodos
  }
}

/** @deprecated 导图待办不再用于阻塞；保留兼容旧调用 */
export async function areWaitingTodosDone(roomKey, taskUids) {
  const uids = (taskUids || []).filter(Boolean)
  if (!uids.length) return { done: true, pending: [], completed: [] }
  const data = await listRoomTodos(roomKey, { includeCompleted: true })
  const pendingSet = new Set(
    ((data && data.pending) || []).map(t => t.uid).filter(Boolean)
  )
  const completedSet = new Set(
    ((data && data.completed) || []).map(t => t.uid).filter(Boolean)
  )
  const stillPending = uids.filter(uid => pendingSet.has(uid))
  const doneUids = uids.filter(uid => completedSet.has(uid))
  const missing = uids.filter(
    uid => !pendingSet.has(uid) && !completedSet.has(uid)
  )
  return {
    done: stillPending.length === 0 && missing.length === 0,
    pending: stillPending,
    completed: doneUids,
    missing
  }
}

export { areWaitingWecomTodosDone }
