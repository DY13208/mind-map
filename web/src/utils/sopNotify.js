/**
 * SOP / 流程中的「通知 / 提醒」类节点：
 * - 识别通知、提醒、知会、抄送、催办等标题
 * - 从标题或子节点解析「给谁」
 * - 自动判断阻塞（等待/确认/审批）或继续
 * - WorkBuddy 派发 + 写入导图 CPDA 待办树
 */
import { dispatchTodo } from './sendTodo'
import { createRoomTodo, listRoomTodos } from './fileApi'

/** 通知 / 提醒类节点（命中任一即可） */
export const NOTIFY_TITLE_RE =
  /AI\s*发起\s*(?:通知|提醒)|发起(?:通知|提醒)|^(?:通知|提醒)\s*[：:]|知会|请(?:通知|提醒)|发送(?:通知|提醒)|催办|请催办|^AI\s*[:：].*(?:通知|提醒|催办|抄送)|抄送|(?:通知|提醒)对应的|(?:通知|提醒).{0,12}给/i

/** 阻塞语义：发完后停住，等人完成待办再继续 */
export const BLOCK_TITLE_RE = /等待|确认|审批|阻塞|签核|复核通过|务必完成/i

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
    const cleaned = cleanAssigneeList(raw)
    if (!cleaned || cleaned.length < 2 || cleaned.length > 40) return
    // 跳过纯角色；多人用顿号拆开逐个收
    cleaned.split('、').forEach(part => {
      const p = cleanAssigneeList(part)
      if (!p || p.length < 2 || p.length > 20) return
      if (isRoleAssignee(p)) return
      // 排除常见非人名噪声
      if (/^(?:请|把|将|用|在|到|从|和|与|及|的|了|吗|呢|吧)/.test(p)) return
      if (/资料|说明|约束|链接|补充|要求|产物|模型/.test(p)) return
      const key = p.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      found.push(p)
    })
  }

  const patterns = [
    /(?:代办人|待办人|接收人|通知人|提醒人|接收者)\s*[：:]\s*([^\n；;]+)/gi,
    /给\s*([^\s，,、：:\n]{2,20})\s*(?:发|送)\s*(?:个|一条|了)?\s*(?:代办|待办)/gi,
    /(?:代办|待办)\s*(?:发给|给)\s*[：:]?\s*([^\n；;]+)/gi,
    /发给\s*([^\s，,、：:\n]{2,20})/gi
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
 * 优先用运行前填写的真实人名，覆盖大纲里的 HRBP / 副总 等角色
 */
export function resolveNotifyAssignee(nodeAssignee, extraNote) {
  const fromNote = parseAssigneesFromExtraNote(extraNote)
  if (fromNote.length) return fromNote.join('、')
  const fallback = cleanAssigneeList(nodeAssignee) || '负责人'
  return fallback
}

/** 企微待办标题：短、干净，避免把整段 AI 节点文案塞进去 */
export function buildWecomTodoTitle(node, sop, assignee) {
  const sopTitle = String((sop && sop.title) || '').trim() || 'SOP'
  let action = stripNodeText((node && node.text) || '')
    .replace(/^AI\s*[:：]\s*/i, '')
    .replace(/\s*[|｜].*$/, '')
    .replace(/\s*→\s*代办[：:].*$/, '')
    .trim()
  if (action.length > 28) action = action.slice(0, 28)
  if (!action) action = '流程知会'
  const who = cleanAssigneeList(assignee)
  return `${sopTitle} · ${action}${who ? `（${who}）` : ''}`.slice(0, 72)
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
    if (!text || !isNotifyTitle(text)) return

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
    const block = shouldBlockNotify(text, contextText)
    const notifyKey = `notify:${index}:${text.slice(0, 40)}`
    items.push({
      index,
      text,
      assignee: assignee || '负责人',
      block,
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
  extraNote = ''
} = {}) {
  const list = Array.isArray(nodes) ? nodes : []
  const overrideAssignees = parseAssigneesFromExtraNote(extraNote)
  const results = []
  for (let i = 0; i < list.length; i++) {
    const node = list[i]
    const assignee = resolveNotifyAssignee(node.assignee, extraNote)
    if (onStatus) {
      onStatus(
        `${node.block ? '阻塞' : '知会'}派发 ${i + 1}/${list.length}：「${
          node.text
        }」→ ${assignee}${
          overrideAssignees.length && isRoleAssignee(node.assignee)
            ? '（已用运行前填写的接收人）'
            : ''
        }`
      )
    }
    // 导图卡片标题可详细；发给企微的标题必须短，对齐客户端「给xx发代办：标题」
    const mapTitle = /代办|接收人/.test(node.text)
      ? node.text
      : `${node.text} → 代办：${assignee}`
    const wxTitle = buildWecomTodoTitle(node, sop, assignee)
    const note = [
      `代办人：${assignee}`,
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

    let taskUid = ''
    let cpdaOk = false
    let cpdaError = ''
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
      console.warn('[sopNotify] createRoomTodo failed', err)
    }

    let dispatchReply = ''
    let dispatchOk = false
    let dispatchError = ''
    try {
      const todo = await dispatchTodo({
        assignee: { name: assignee },
        title: wxTitle,
        // 不把 SOP 上下文塞进聊天，避免模型跑偏去分析 JD
        conversationId: conversationId
          ? `${conversationId}-todo-${i}-${Date.now().toString(36)}`
          : undefined,
        model: 'auto',
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
      if (!dispatchOk && dispatchError) {
        dispatchReply = `${dispatchError}\n${dispatchReply}`.trim()
      }
    } catch (err) {
      dispatchReply = (err && err.message) || 'WorkBuddy 派发失败'
      dispatchError = dispatchReply
      console.warn('[sopNotify] dispatchTodo failed', err)
    }

    results.push({
      ...node,
      assignee,
      displayTitle: mapTitle,
      wxTitle,
      taskUid,
      cpdaOk,
      cpdaError,
      dispatchOk,
      dispatchReply,
      dispatchError
    })
  }
  return results
}

export function summarizeNotifyResults(results) {
  const list = Array.isArray(results) ? results : []
  const blocking = list.filter(r => r.block)
  const continued = list.filter(r => !r.block)
  return {
    total: list.length,
    blocking,
    continued,
    hasBlocking: blocking.length > 0,
    waitingTaskUids: blocking.map(r => r.taskUid).filter(Boolean)
  }
}

/** 检查阻塞待办是否都已进入「已完成」 */
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
