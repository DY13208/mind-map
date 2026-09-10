import {
  AI_BACKEND_OPENCLAW,
  AI_BACKEND_XIAOCE,
  getAiBackend,
  isXiaoceBackend,
  normalizeAiBackend
} from './agentChat'
import {
  createXiaoceWecomTodo,
  createXiaoceWecomTodoViaAgent
} from './xiaoceChat'
import { getWorkbuddyConfig } from './workbuddyChat'
import { streamOpenclawGatewayWs } from './openclawGatewayWs'
import { checkOpenclawHealth, streamOpenclawChat } from './openclawChat'

/**
 * 发企业微信待办：
 * - 小策：优先走智能体官方企微链路（与网页一致，自动过确认门禁）；失败再退 REST
 * - 助理（OpenClaw）：走龙虾 wecom_mcp（与助理页聊天一致）
 * - WorkBuddy：走本机 wecom-cli /v1/wecom/todo
 *
 * @param {object} opts
 * @param {string} [opts.backend] 指定引擎（SOP 任务请传 job.backend）
 */
export async function dispatchTodo({
  assignee,
  title,
  detail,
  context,
  onEvent,
  onDelta,
  signal,
  conversationId,
  model,
  backend
} = {}) {
  const assigneeName =
    String((assignee && assignee.name) || assignee || '负责人').trim() ||
    '负责人'
  const taskTitle =
    String(title || '待办')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || '待办'
  const description = String(detail || context || '')
    .trim()
    .slice(0, 2000)

  const useBackend = normalizeAiBackend(backend || getAiBackend())

  if (useBackend === AI_BACKEND_XIAOCE || isXiaoceBackend(useBackend)) {
    return dispatchTodoViaXiaoce({
      assigneeName,
      taskTitle,
      description,
      detail,
      context,
      onEvent,
      onDelta,
      signal,
      conversationId
    })
  }

  if (useBackend === AI_BACKEND_OPENCLAW) {
    return dispatchTodoViaOpenclaw({
      assigneeName,
      taskTitle,
      description,
      detail,
      context,
      onEvent,
      onDelta,
      signal,
      conversationId
    })
  }

  return dispatchTodoViaWorkbuddy({
    assigneeName,
    taskTitle,
    description,
    detail,
    context,
    onEvent,
    onDelta,
    signal,
    conversationId,
    model
  })
}

async function dispatchTodoViaXiaoce({
  assigneeName,
  taskTitle,
  description,
  detail,
  context,
  onEvent,
  onDelta,
  signal,
  conversationId
}) {
  if (onEvent) onEvent('xiaoce_wecom', { phase: 'preparing', assignee: assigneeName })
  if (onDelta) {
    onDelta(`正在通过小策智能体给 ${assigneeName} 创建企微待办（含自动确认）…\n`)
  }

  // 1) 与小策网页同一条官方企微链路（预览 → 自动确认 → 写入）
  try {
    const created = await createXiaoceWecomTodoViaAgent({
      assignee: assigneeName,
      title: taskTitle,
      description,
      signal,
      onDelta,
      conversationId
    })
    const content =
      String(created.detail || '').trim() || `企微待办已创建：${taskTitle}`
    if (onEvent) {
      onEvent('xiaoce_wecom', {
        phase: 'done',
        via: 'xiaoce-agent',
        syncStatus: created.syncStatus
      })
    }
    if (onDelta) onDelta(`${content}\n`)
    return {
      assignee: assigneeName,
      title: taskTitle,
      userLine: `给${assigneeName}发个代办：${taskTitle}`,
      content,
      success: true,
      toolUsed: true,
      via: 'xiaoce-agent',
      backendLabel: '小策',
      todoId: '',
      error: '',
      detail: detail || '',
      context: context || ''
    }
  } catch (agentErr) {
    if (onDelta) {
      onDelta(
        `智能体链路未成功（${(agentErr && agentErr.message) || '未知错误'}），尝试 REST 直派…\n`
      )
    }
  }

  // 2) 退回平台待办 REST（可能仅平台待办、未必同步原生企微）
  try {
    const created = await createXiaoceWecomTodo({
      assignee: assigneeName,
      title: taskTitle,
      description,
      signal
    })
    const content = created.viaContact
      ? String(created.detail || '').trim() ||
        `企微待办已创建：${taskTitle}`
      : `平台待办已创建（通讯录未命中企微联系人，未同步企微）：${taskTitle}`
    if (onEvent) {
      onEvent('xiaoce_wecom', {
        phase: 'done',
        todo_ids: created.ids,
        syncStatus: created.syncStatus,
        via: 'xiaoce-wecom'
      })
    }
    if (onDelta) onDelta(`${content}\n`)
    return {
      assignee: assigneeName,
      title: taskTitle,
      userLine: `给${assigneeName}发个代办：${taskTitle}`,
      content,
      success: !!created.ok,
      toolUsed: true,
      via: 'xiaoce-wecom',
      backendLabel: '小策',
      todoId: (created.ids && created.ids[0]) || '',
      error: '',
      detail: detail || '',
      context: context || ''
    }
  } catch (err) {
    const message = (err && err.message) || String(err || '派发失败')
    const notFound =
      (err && (err.status === 404 || err.code === 'wecom_user_not_found')) ||
      /找不到|not_found/i.test(message)
    let errHint = message
    if (notFound) {
      errHint = `小策通讯录找不到「${assigneeName}」，请确认姓名。`
    } else if (/wecom_not_configured|尚未配置企业微信/i.test(message)) {
      errHint = '小策企业未配置企业微信 API，或当前账号无权读取通讯录。'
    } else if (/confirmation|确认门禁/i.test(message)) {
      errHint = message
    }
    if (onDelta) onDelta(`${errHint}\n`)
    return {
      assignee: assigneeName,
      title: taskTitle,
      userLine: `给${assigneeName}发个代办：${taskTitle}`,
      content: errHint,
      success: false,
      toolUsed: false,
      via: 'xiaoce-agent',
      backendLabel: '小策',
      error: errHint,
      detail: detail || '',
      context: context || ''
    }
  }
}

async function dispatchTodoViaOpenclaw({
  assigneeName,
  taskTitle,
  description,
  detail,
  context,
  onEvent,
  onDelta,
  signal,
  conversationId
}) {
  if (onEvent) onEvent('openclaw_wecom', { phase: 'preparing', assignee: assigneeName })
  if (onDelta) {
    onDelta(`正在通过助理（OpenClaw）给 ${assigneeName} 创建企微待办…\n`)
  }

  const health = await checkOpenclawHealth()
  if (!health || !health.ok) {
    const errHint =
      (health && health.message) ||
      '助理（OpenClaw）未就绪，请先运行 Start-Docker 或 node scripts/openclaw-gateway.js'
    if (onDelta) onDelta(`${errHint}\n`)
    return {
      assignee: assigneeName,
      title: taskTitle,
      userLine: `给${assigneeName}发个代办：${taskTitle}`,
      content: errHint,
      success: false,
      toolUsed: false,
      via: 'openclaw-wecom',
      backendLabel: '助理',
      error: errHint,
      detail: detail || '',
      context: context || ''
    }
  }

  const message = [
    `请立刻用企业微信（wecom / 企微待办工具）给「${assigneeName}」创建一条待办。`,
    `标题：${taskTitle}`,
    description ? `说明：${description}` : '',
    '要求：只做这一件事；创建成功后用一两句中文确认「已创建」，并尽量写出 todo_id=…；不要搜索本机文件，不要发别的待办。'
  ]
    .filter(Boolean)
    .join('\n')

  let content = ''
  let sawWecomTool = false
  let wecomToolOk = false
  const convId =
    conversationId ||
    `openclaw-todo-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`

  try {
    try {
      await streamOpenclawGatewayWs({
        message,
        conversationId: convId,
        signal,
        onDelta: piece => {
          const p = String(piece || '')
          if (!p) return
          content += p
          if (onDelta) onDelta(p)
        },
        onTool: info => {
          const name = String((info && info.name) || '')
          const phase = String((info && info.phase) || '').toLowerCase()
          if (/wecom|todo/i.test(name)) {
            sawWecomTool = true
            if (phase === 'result' || phase === 'done' || phase === 'end') {
              wecomToolOk = true
            }
          }
          if (onEvent) {
            onEvent('openclaw_wecom', {
              phase: phase || 'update',
              name,
              detail: (info && info.detail) || ''
            })
          }
        }
      })
    } catch (wsErr) {
      if (wsErr && wsErr.name === 'AbortError') throw wsErr
      // Bridge 不可用时退 HTTP（通常无 tool 事件，靠正文判断）
      const result = await streamOpenclawChat({
        messages: [{ role: 'user', content: message }],
        conversationId: convId,
        signal,
        onDelta: piece => {
          const p = String(piece || '')
          if (!p) return
          content += p
          if (onDelta) onDelta(p)
        }
      })
      if (result && result.content && !content) content = String(result.content)
    }
  } catch (err) {
    if (err && err.name === 'AbortError') throw err
    const errHint =
      (err && err.message) || '助理派发企微待办失败'
    if (onDelta) onDelta(`${errHint}\n`)
    return {
      assignee: assigneeName,
      title: taskTitle,
      userLine: `给${assigneeName}发个代办：${taskTitle}`,
      content: errHint,
      success: false,
      toolUsed: sawWecomTool,
      via: 'openclaw-wecom',
      backendLabel: '助理',
      error: errHint,
      detail: detail || '',
      context: context || ''
    }
  }

  const text = String(content || '').trim()
  const todoIdMatch = text.match(
    /(?:todo[_ ]?id|待办\s*ID|待办id)\s*[=：:]\s*([A-Za-z0-9_-]{8,})/i
  )
  const todoId = (todoIdMatch && todoIdMatch[1]) || ''
  const failed =
    /失败|找不到|未授权|未配置|没有权限|无法|error|502|503/i.test(text) &&
    !/已创建|创建成功|已发送|已派发|成功给/.test(text)
  const success =
    wecomToolOk ||
    (!failed &&
      (/已创建|创建成功|已发送|已派发|待办已|成功/.test(text) ||
        (sawWecomTool && text.length > 0)))

  if (!success) {
    const errHint =
      text.slice(0, 280) ||
      '助理未确认企微待办已创建（请确认 OpenClaw 已配置企微工具）'
    if (onDelta && !text) onDelta(`${errHint}\n`)
    return {
      assignee: assigneeName,
      title: taskTitle,
      userLine: `给${assigneeName}发个代办：${taskTitle}`,
      content: errHint,
      success: false,
      toolUsed: sawWecomTool,
      via: 'openclaw-wecom',
      backendLabel: '助理',
      todoId,
      error: errHint,
      detail: detail || '',
      context: context || ''
    }
  }

  const okText =
    text.slice(0, 400) || `企微待办已创建：${taskTitle} → ${assigneeName}`
  if (onEvent) {
    onEvent('openclaw_wecom', {
      phase: 'done',
      via: 'openclaw-wecom',
      todo_id: todoId
    })
  }
  return {
    assignee: assigneeName,
    title: taskTitle,
    userLine: `给${assigneeName}发个代办：${taskTitle}`,
    content: okText,
    success: true,
    toolUsed: true,
    via: 'openclaw-wecom',
    backendLabel: '助理',
    todoId,
    error: '',
    detail: detail || '',
    context: context || ''
  }
}

async function dispatchTodoViaWorkbuddy({
  assigneeName,
  taskTitle,
  description,
  detail,
  context,
  onEvent,
  onDelta,
  signal
}) {
  if (onEvent) onEvent('wecom_cli', { phase: 'preparing', assignee: assigneeName })
  if (onDelta) onDelta(`正在通过 wecom-cli 给 ${assigneeName} 创建企微待办…\n`)

  const { baseUrl, apiKey } = getWorkbuddyConfig()
  let payload = null
  let httpStatus = 0
  try {
    const res = await fetch(`${baseUrl}/v1/wecom/todo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        assignee: assigneeName,
        title: taskTitle,
        description
      }),
      signal
    })
    httpStatus = res.status
    const text = await res.text()
    // nginx/网关失败时常返回 HTML，不能当成功正文刷进执行过程
    if (
      !res.ok ||
      /<!DOCTYPE html>|502 Bad Gateway|503 Service|Bad Gateway/i.test(text)
    ) {
      const friendly =
        res.status === 502 || /502 Bad Gateway/i.test(text)
          ? '连不上 WorkBuddy（HTTP 502）。请确认本机已启动 WorkBuddy API（Start-Docker 或 node scripts/workbuddy-api.js）。'
          : res.status === 503 || /503/i.test(text)
            ? 'WorkBuddy 暂时不可用（HTTP 503），请稍后重试。'
            : text.slice(0, 200) || `HTTP ${res.status}`
      try {
        payload = JSON.parse(text)
      } catch (e) {
        payload = { error: { message: friendly } }
      }
      const msg =
        (payload && payload.error && payload.error.message) ||
        (payload && payload.message) ||
        friendly
      const err = new Error(
        /<!DOCTYPE|Bad Gateway/i.test(msg) ? friendly : msg
      )
      err.status = res.status || 502
      throw err
    }
    try {
      payload = JSON.parse(text)
    } catch (e) {
      payload = { error: { message: text || `HTTP ${res.status}` } }
    }
    if (!res.ok) {
      const msg =
        (payload && payload.error && payload.error.message) ||
        (payload && payload.message) ||
        text ||
        `HTTP ${res.status}`
      const err = new Error(msg)
      err.status = res.status
      err.code = payload && payload.error && payload.error.code
      throw err
    }
  } catch (err) {
    const message = (err && err.message) || String(err || '派发失败')
    const authFail =
      (err && (err.status === 401 || err.code === 'wecom_unauthorized')) ||
      /未授权|unauthorized|401/i.test(message)
    const notFound =
      (err && (err.status === 404 || err.code === 'wecom_user_not_found')) ||
      /找不到|not_found/i.test(message)
    const missingCli =
      (err && err.code === 'wecom_cli_missing') ||
      /未找到 wecom-cli|wecom_cli_missing/i.test(message)
    let errHint = message
    if (authFail) {
      errHint =
        '企业微信 CLI 未授权。请打开 WorkBuddy 客户端完成企微扫码授权后再试。'
    } else if (missingCli) {
      errHint =
        '本机未找到 wecom-cli（WorkBuddy 企微连接器）。请先在客户端安装/启用企微 CLI。'
    } else if (notFound) {
      errHint = `通讯录找不到「${assigneeName}」，请确认姓名。`
    }
    if (onDelta) onDelta(`${errHint}\n`)
    return {
      assignee: assigneeName,
      title: taskTitle,
      userLine: `给${assigneeName}发个代办：${taskTitle}`,
      content: errHint,
      success: false,
      toolUsed: false,
      via: 'wecom-cli',
      backendLabel: 'WorkBuddy',
      error: errHint,
      detail: detail || '',
      context: context || ''
    }
  }

  const content =
    String((payload && payload.content) || '').trim() ||
    `待办创建成功：${(payload && payload.title) || taskTitle}`
  if (onEvent) {
    onEvent('wecom_cli', {
      phase: 'done',
      todo_id: payload && payload.todo_id,
      via: 'wecom-cli'
    })
  }
  if (onDelta) onDelta(`${content}\n`)

  return {
    assignee: assigneeName,
    title: (payload && payload.title) || taskTitle,
    userLine: `给${assigneeName}发个代办：${taskTitle}`,
    content,
    success: !!(payload && payload.ok),
    toolUsed: true,
    via: 'wecom-cli',
    backendLabel: 'WorkBuddy',
    todoId: (payload && payload.todo_id) || '',
    error: payload && payload.ok ? '' : content || '派发未确认成功',
    detail: detail || '',
    context: context || '',
    httpStatus
  }
}

export function appendTodoNote(node, mindMap, { assignee, title, reply }) {
  if (!node || !mindMap) return
  const prev = (node.getData && node.getData('note')) || ''
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false })
  const block = [
    `【待办 ${stamp}】`,
    `接收人：${assignee}`,
    `任务：${title}`,
    reply ? `确认：${String(reply).trim().slice(0, 200)}` : ''
  ]
    .filter(Boolean)
    .join('\n')
  const note = prev ? `${prev}\n\n${block}` : block
  mindMap.execCommand('SET_NODE_DATA', node, { note })
}

function parseDonePending(text) {
  const t = String(text || '').trim()
  if (!t) return null
  if (/\bDONE\b|已完成|完成了|已办结|状态[：:]\s*0\b/i.test(t) && !/PENDING|未完成|进行中/i.test(t.slice(-80))) {
    return true
  }
  if (/\bPENDING\b|未完成|进行中|状态[：:]\s*1\b/i.test(t)) return false
  if (/已完成/.test(t) && !/未完成/.test(t)) return true
  return null
}

async function checkOneWecomTodoViaWorkbuddy(item, signal) {
  const todoId = String((item && item.todoId) || '').trim()
  if (!todoId) return null
  const { baseUrl, apiKey } = getWorkbuddyConfig()
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    Authorization: `Bearer ${apiKey}`
  }
  const tryParse = async res => {
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch (e) {
      json = null
    }
    return { res, text, json }
  }
  const paths = [
    () =>
      fetch(`${baseUrl}/v1/wecom/todo/get`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ todo_id: todoId }),
        signal
      }),
    () =>
      fetch(`${baseUrl}/v1/wecom/todo/${encodeURIComponent(todoId)}`, {
        method: 'GET',
        headers,
        signal
      })
  ]
  for (const run of paths) {
    try {
      const { res, json } = await tryParse(await run())
      if (!res.ok || !json) continue
      const status =
        json.status != null
          ? json.status
          : json.todo && json.todo.status != null
            ? json.todo.status
            : json.data && json.data.status
      if (status === 0 || status === '0' || status === 'done' || status === 'completed') {
        return true
      }
      if (status === 1 || status === '1' || status === 'pending' || status === 'open') {
        return false
      }
      const hint = parseDonePending(JSON.stringify(json))
      if (hint != null) return hint
    } catch (e) {
      /* try next */
    }
  }
  return null
}

async function checkOneWecomTodoViaOpenclaw(item, signal) {
  const title = String((item && (item.title || item.wxTitle)) || '').trim()
  const assignee = String((item && item.assignee) || '').trim()
  const todoId = String((item && item.todoId) || '').trim()
  if (!title && !todoId) return null
  const message = [
    '请用企业微信待办工具查询下面这条待办是否已完成。',
    todoId ? `todo_id：${todoId}` : '',
    title ? `标题关键词：${title}` : '',
    assignee ? `接收人：${assignee}` : '',
    '优先 todo get；没有 id 就用 todo list 按标题/接收人定位。',
    '最后一行只输出 DONE 或 PENDING，不要解释。'
  ]
    .filter(Boolean)
    .join('\n')
  let content = ''
  try {
    try {
      await streamOpenclawGatewayWs({
        message,
        conversationId: `wecom-check-${Date.now().toString(36)}`,
        signal,
        onDelta: piece => {
          content += String(piece || '')
        }
      })
    } catch (wsErr) {
      if (wsErr && wsErr.name === 'AbortError') throw wsErr
      const result = await streamOpenclawChat({
        messages: [{ role: 'user', content: message }],
        conversationId: `wecom-check-${Date.now().toString(36)}`,
        signal
      })
      if (result && result.content) content = String(result.content)
    }
  } catch (err) {
    if (err && err.name === 'AbortError') throw err
    return null
  }
  return parseDonePending(content)
}

/**
 * 检查阻塞企微待办是否已完成（不再看导图待办）
 * @param {Array<{todoId?:string,title?:string,wxTitle?:string,assignee?:string,via?:string}>} items
 * @param {{ backend?: string, signal?: AbortSignal }} [opts]
 */
export async function areWaitingWecomTodosDone(items, opts = {}) {
  const list = (items || []).filter(Boolean)
  if (!list.length) return { done: true, pending: [], completed: [], unknown: [] }
  const backend = normalizeAiBackend(opts.backend || getAiBackend())
  const pending = []
  const completed = []
  const unknown = []
  for (const item of list) {
    let done = null
    if (backend === AI_BACKEND_OPENCLAW || /openclaw/i.test(String(item.via || ''))) {
      done = await checkOneWecomTodoViaOpenclaw(item, opts.signal)
      if (done == null) done = await checkOneWecomTodoViaWorkbuddy(item, opts.signal)
    } else {
      done = await checkOneWecomTodoViaWorkbuddy(item, opts.signal)
      if (done == null) done = await checkOneWecomTodoViaOpenclaw(item, opts.signal)
    }
    const key =
      item.todoId ||
      `${item.assignee || ''}::${item.title || item.wxTitle || ''}`
    if (done === true) completed.push(key)
    else if (done === false) pending.push(key)
    else unknown.push(key)
  }
  return {
    done: pending.length === 0 && unknown.length === 0,
    pending,
    completed,
    unknown
  }
}
