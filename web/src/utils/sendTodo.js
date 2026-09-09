import { isXiaoceBackend } from './agentChat'
import {
  createXiaoceWecomTodo,
  createXiaoceWecomTodoViaAgent,
  probeXiaoceWecomRecipient
} from './xiaoceChat'
import { prepareWecomTodoDraft } from './wecomTodoTitle'
import { getWorkbuddyConfig } from './workbuddyChat'

let workbuddyTodoRouteCache = { available: false, expiresAt: 0 }

/**
 * 发企业微信待办：
 * - 本机 CLI 健康时优先直派，避免先等待无权限的小策应用/智能体链路
 * - CLI 不可用时，小策模式再探测应用权限并尝试官方企微链路
 * - 任一首选链路出现明确的权限/连接拒绝时，切换另一条链路
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
  model
} = {}) {
  const assigneeName =
    String((assignee && assignee.name) || assignee || '负责人').trim() ||
    '负责人'
  const draft = prepareWecomTodoDraft({
    title,
    description: detail || context || '',
    assignee: assigneeName
  })
  if (!draft.ok) {
    const err = new Error(draft.error)
    err.code = draft.code
    throw err
  }
  const taskTitle = draft.title
  const description = draft.description

  const xiaoceMode = isXiaoceBackend()
  if (xiaoceMode && (await isWorkbuddyTodoRouteAvailable({ signal }))) {
    if (onDelta) onDelta('已检测到可用的企业微信 CLI，优先直接创建待办…\n')
    const cliResult = await dispatchTodoViaWorkbuddy({
      assigneeName,
      taskTitle,
      description,
      detail,
      context,
      onEvent,
      onDelta,
      signal
    })
    // 创建 POST 一旦发出，就不能因超时或错误再切另一条写链路，避免重复待办。
    return cliResult
  }

  if (xiaoceMode) {
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
  let resolvedContact = null
  try {
    const probe = await probeXiaoceWecomRecipient({
      assignee: assigneeName,
      signal
    })
    if (!probe.available) {
      return dispatchTodoViaWorkbuddyFallback({
        reason: `小策应用无法访问「${assigneeName}」的企微联系人`,
        assigneeName,
        taskTitle,
        description,
        detail,
        context,
        onEvent,
        onDelta,
        signal
      })
    }
    resolvedContact = probe.contact
  } catch (err) {
    if (isXiaocePermissionFailure(err)) {
      return dispatchTodoViaWorkbuddyFallback({
        reason: '小策企业微信应用无读取该成员的权限',
        assigneeName,
        taskTitle,
        description,
        detail,
        context,
        onEvent,
        onDelta,
        signal
      })
    }
    // 网络等非权限问题仍尝试小策智能体，保持旧链路的可用性。
  }
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
    if (isXiaocePermissionFailure(agentErr)) {
      return dispatchTodoViaWorkbuddyFallback({
        reason: '小策企业微信应用无读取该成员的权限',
        assigneeName,
        taskTitle,
        description,
        detail,
        context,
        onEvent,
        onDelta,
        signal
      })
    }
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
      signal,
      resolvedContact
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
    if (isXiaocePermissionFailure(err)) {
      return dispatchTodoViaWorkbuddyFallback({
        reason: '小策企业微信应用无读取该成员的权限',
        assigneeName,
        taskTitle,
        description,
        detail,
        context,
        onEvent,
        onDelta,
        signal
      })
    }
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

async function isWorkbuddyTodoRouteAvailable({ signal } = {}) {
  const now = Date.now()
  if (workbuddyTodoRouteCache.expiresAt > now) {
    return workbuddyTodoRouteCache.available
  }
  if (signal && signal.aborted) throw signal.reason || new Error('操作已取消')

  const { baseUrl, apiKey } = getWorkbuddyConfig()
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), 1500)
  try {
    const res = await fetch(`${String(baseUrl || '').replace(/\/$/, '')}/health`, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal
    })
    const available = res.ok
    workbuddyTodoRouteCache = {
      available,
      expiresAt: Date.now() + (available ? 30000 : 3000)
    }
    return available
  } catch (err) {
    if (signal && signal.aborted) throw signal.reason || err
    workbuddyTodoRouteCache = { available: false, expiresAt: Date.now() + 3000 }
    return false
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

function isXiaocePermissionFailure(err) {
  const message = String((err && err.message) || err || '')
  const code = String((err && err.code) || '')
  return (
    /WEWORK.*(NO_PERMISSION|FORBIDDEN)|permission|forbidden|没有读取该成员的权限|无权读取.*通讯录|无权限/.test(
      `${code} ${message}`
    ) || (err && (err.status === 401 || err.status === 403))
  )
}

async function dispatchTodoViaWorkbuddyFallback({ reason, onDelta, ...args }) {
  if (onDelta) onDelta(`${reason}，已自动切换至 wecom-cli…\n`)
  const result = await dispatchTodoViaWorkbuddy({ ...args, onDelta })
  return {
    ...result,
    fallbackFrom: 'xiaoce-wecom',
    fallbackReason: reason,
    // CLI 成功时只把最终成功结果交给 SOP，避免前置权限问题污染任务状态。
    error: result.success ? '' : result.error
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
    const gatewayUnavailable =
      (err && err.status === 502) ||
      /502 Bad Gateway|<html[\s>]|connect(?:ion)? refused/i.test(message)
    let errHint = message
    if (gatewayUnavailable) {
      errHint =
        '企业微信 CLI 服务未启动或暂时不可用。请重新运行项目启动脚本后再试。'
    } else if (authFail) {
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
      errorCode: (err && err.code) || '',
      detail: detail || '',
      context: context || '',
      httpStatus
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
    errorCode: '',
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
