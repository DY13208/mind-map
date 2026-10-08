/**
 * 运行日志（本地留存）—— 「运行历史」里属于**这台浏览器**的那一份。
 *
 * ## 为什么需要它（2026-10-08 用户反馈「运行没有历史」）
 *
 * 「运行历史」原来是**纯桥接视角**的：它去问执行主机上那台 WorkBuddy 有哪些任务
 * （`/api/v1/jobs`）。于是有两类情况历史是空的：
 *
 * 1. **助理（WorkBuddy/OpenClaw）通道**：流式直连，没有「派发 → 轮询 → 回执」这套，
 *    网关照不到它 —— 用它跑完，历史里**一条都没有**。而它现在是默认通道，所以
 *    「点运行 → 历史空白」是常态。
 * 2. **桥接没起来**（`/bridge` 502，本机就是这么个状态）：连桥接那条也没有记录。
 *
 * 所以这里在**页面本地**留一份运行记录（localStorage），运行历史把它和桥接的任务
 * 合并展示：桥接有的以桥接为准（状态更准），本地这份补上它没有的（尤其是助理那条）。
 *
 * 记录里存了完整正文 —— 刷新页面、桥接不通，都还能在历史里点开看 / 重新写回导图。
 */
const RUN_LOG_STORE = 'mindmap:runLog'
/** 最多留多少条（按时间倒序，老的丢掉） */
const RUN_LOG_MAX = 60
/** 单条正文的上限，防止 localStorage 被长文写爆 */
const RUN_RESULT_MAX = 40000

function store() {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null
    return localStorage
  } catch (err) {
    // 隐私模式 / 被禁：当作没有本地存储，功能降级但不报错
    return null
  }
}

/** 造一个运行 id（助理那条的 conversationId 也用它） */
export function makeRunLogId(prefix = 'run') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`
}

/** 全部记录（新的在前） */
export function readRunRecords() {
  const s = store()
  if (!s) return []
  try {
    const rows = JSON.parse(s.getItem(RUN_LOG_STORE) || '[]')
    if (!Array.isArray(rows)) return []
    return rows.filter(item => item && item.id)
  } catch (err) {
    return []
  }
}

function writeRunRecords(rows) {
  const s = store()
  if (!s) return
  try {
    s.setItem(RUN_LOG_STORE, JSON.stringify((rows || []).slice(0, RUN_LOG_MAX)))
  } catch (err) {
    // 写不进去（配额满 / 隐私模式）不影响这次运行
  }
}

/**
 * 写入（或更新）一条运行记录。
 * 同 id 会与已有字段做浅合并 —— 调用方只传要改的那几个字段即可。
 */
export function saveRunRecord(record) {
  if (!record || !record.id) return null
  const rows = readRunRecords()
  const prev = rows.find(item => item.id === record.id) || null
  const next = {
    source: 'local',
    channel: 'openclaw',
    state: 'working',
    startedAt: Date.now(),
    ...(prev || {}),
    ...record,
    updatedAt: Date.now()
  }
  if (next.result && String(next.result).length > RUN_RESULT_MAX) {
    next.result = String(next.result).slice(0, RUN_RESULT_MAX)
  }
  writeRunRecords([next, ...rows.filter(item => item.id !== record.id)])
  return next
}

/** 只改几个字段（记录不存在时按 patch 建一条） */
export function patchRunRecord(id, patch = {}) {
  if (!id) return null
  return saveRunRecord({ id, ...(patch || {}) })
}

export function removeRunRecord(id) {
  if (!id) return
  writeRunRecords(readRunRecords().filter(item => item.id !== id))
}

export function clearRunRecords() {
  const s = store()
  if (!s) return
  try {
    s.removeItem(RUN_LOG_STORE)
  } catch (err) {
    /* ignore */
  }
}

/**
 * 页面刚打开时收尾：助理那条是**流式直连**，刷新页面 = 这条流断掉，
 * 记录却还停在「执行中」—— 那样历史里会永远挂着一条假的「执行中」，
 * 还带一个点了没反应的「停止」。这里把它们标成已停止。
 *
 * 桥接那条不碰：任务是派到执行主机上跑的，刷新页面它照样在跑，
 * 状态以桥接的列表为准（见 Toolbar 的 mergeRunHistory）。
 */
export function markInterruptedRuns(reason = '页面刷新，这次运行中断了') {
  const rows = readRunRecords()
  let n = 0
  rows.forEach(item => {
    if (item.channel !== 'openclaw') return
    if (item.state !== 'working' && item.state !== 'running') return
    item.state = 'stopped'
    item.detail = reason
    item.updatedAt = Date.now()
    n += 1
  })
  if (n) writeRunRecords(rows)
  return n
}

/**
 * 把本地记录翻成运行历史列表用的形状（跟桥接给的任务对象对齐：
 * 列表、状态文案、时间、搜索都直接复用同一套字段）。
 */
export function recordToHistoryItem(rec) {
  if (!rec || !rec.id) return null
  const title = String(rec.nodeTitle || '').trim()
  return {
    id: String(rec.id),
    name: rec.name || '脑图运行',
    // 列表里的「来自哪个节点」是从 intent 里抠的（见 jobNodeText）
    intent: title ? `节点：${title}` : '',
    state: rec.state || 'working',
    detail: rec.detail || (rec.error ? String(rec.error) : ''),
    result: rec.result || '',
    startedAt: rec.startedAt || rec.updatedAt || 0,
    updatedAt: rec.updatedAt || rec.startedAt || 0,
    source: rec.source || 'local',
    channel: rec.channel || 'openclaw',
    nodeUid: rec.nodeUid || '',
    nodeTitle: title,
    room: rec.room || '',
    gateway: rec.gateway || '',
    hostKey: rec.hostKey || '',
    // 没有执行会话 → 正文/产物都在本地这份记录里，别再按桥接那套去查
    localOnly: !rec.gateway
  }
}
