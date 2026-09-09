import { getRuntimeConfig } from './runtimeConfig'
import { getLocalConfig } from '@/api'
import { getAuthApiUrl } from './auth'
import { prepareWecomTodoDraft } from './wecomTodoTitle'

let ssoAccess = null
let ssoRequest = null

export function getXiaoceConfig() {
  const runtime =
    (typeof window !== 'undefined' && window.__MIND_MAP_RUNTIME__) || {}
  const cfg = getRuntimeConfig()
  const saved = getLocalConfig() || {}
  const baseUrl = String(
    runtime.xiaoceBase ||
      cfg.xiaoceBase ||
      saved.xiaoceBase ||
      '/yiran'
  ).replace(/\/$/, '')
  const token = String(
    runtime.xiaoceToken || cfg.xiaoceToken || saved.xiaoceToken || ''
  ).trim()
  const model = String(
    runtime.xiaoceModel ||
      saved.xiaoceModel ||
      cfg.xiaoceModel ||
      ''
  ).trim()
  const organizationId = String(
    runtime.xiaoceOrganizationId ||
      saved.xiaoceOrganizationId ||
      cfg.xiaoceOrganizationId ||
      ''
  ).trim()
  const agentId = String(
    runtime.xiaoceAgentId || saved.xiaoceAgentId || cfg.xiaoceAgentId || ''
  ).trim()
  return { baseUrl, token, model, organizationId, agentId }
}

async function getXiaoceAuthorization(force = false) {
  const { baseUrl, token } = getXiaoceConfig()
  const now = Date.now()
  if (!force && ssoAccess && ssoAccess.expiresAt > now + 30000) {
    return { baseUrl, authorization: `MindMap ${ssoAccess.token}` }
  }
  if (ssoRequest) return ssoRequest
  ssoRequest = (async () => {
    const ticketResponse = await fetch(getAuthApiUrl('/api/auth/yiran-token'), {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json' }
    })
    const ticket = await ticketResponse.json().catch(() => ({}))
    if (!ticketResponse.ok || !ticket.assertion) {
      // Backward compatibility only when talking to an older Mind-map server.
      if (ticketResponse.status === 404 && token) {
        return { baseUrl, authorization: `Token ${token}` }
      }
      throw new Error(ticket.error || '无法取得小策单点登录票据')
    }
    const exchangeResponse = await fetch(`${baseUrl}/api/auth/mind-map/exchange/`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({ assertion: ticket.assertion })
    })
    const exchange = await exchangeResponse.json().catch(() => ({}))
    if (!exchangeResponse.ok || !exchange.accessToken) {
      if (exchangeResponse.status === 404 && token) {
        return { baseUrl, authorization: `Token ${token}` }
      }
      const identityHint = ticket.wecomUserId
        ? `（当前会话企微 userid=${ticket.wecomUserId}）`
        : ''
      const baseError = exchange.error || '小策账号关联失败'
      const err = new Error(
        exchange.code === 'WECOM_NOT_BOUND'
          ? `${baseError}${identityHint}。换手机号后请退出并用新号码重新开发者登录；该 userid 须在小策已 matched 绑定`
          : `${baseError}${identityHint}`
      )
      err.status = exchangeResponse.status
      err.code = exchange.code || 'XIAOCE_SSO_FAILED'
      throw err
    }
    ssoAccess = {
      token: exchange.accessToken,
      expiresAt: Date.now() + Number(exchange.expiresIn || 900) * 1000
    }
    return { baseUrl, authorization: `MindMap ${ssoAccess.token}` }
  })()
  try {
    return await ssoRequest
  } finally {
    ssoRequest = null
  }
}

async function xiaoceFetch(path, options = {}, retry = true) {
  const auth = await getXiaoceAuthorization(false)
  const headers = {
    Accept: 'application/json',
    ...(options.headers || {}),
    Authorization: auth.authorization
  }
  if (
    options.body != null &&
    !headers['Content-Type'] &&
    !headers['content-type']
  ) {
    headers['Content-Type'] = 'application/json; charset=utf-8'
  }
  const response = await fetch(`${auth.baseUrl}${path}`, {
    ...options,
    headers
  })
  if (response.status === 401 && retry) {
    ssoAccess = null
    const refreshed = await getXiaoceAuthorization(true)
    return fetch(`${refreshed.baseUrl}${path}`, {
      ...options,
      headers: { ...headers, Authorization: refreshed.authorization }
    })
  }
  return response
}

function normalizePersonKey(name) {
  return String(name || '')
    .replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '')
    .toLowerCase()
}

function personNameMatches(candidate, target) {
  const a = normalizePersonKey(candidate)
  const b = normalizePersonKey(target)
  if (!a || !b) return false
  return a === b || a.includes(b) || b.includes(a)
}

/**
 * 只读探测小策企微应用是否能访问指定成员。
 *
 * 这个检查必须发生在智能体写入前：智能体即使能启动，也可能因应用通讯录
 * 权限不足而在写入阶段失败。调用方可据此改走已授权的 CLI 通道。
 */
export async function probeXiaoceWecomRecipient({ assignee, signal } = {}) {
  const assigneeName = String(assignee || '').trim()
  const contactsRes = await xiaoceFetch('/api/wecom/contacts/', {
    cache: 'no-store',
    signal
  })
  const contactsJson = await contactsRes.json().catch(() => ({}))
  if (!contactsRes.ok) {
    const msg =
      contactsJson.detail ||
      contactsJson.error ||
      `读取企微通讯录失败（HTTP ${contactsRes.status}）`
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
    err.status = contactsRes.status
    err.code = contactsJson.code || 'xiaoce_contacts_failed'
    throw err
  }
  const contacts = Array.isArray(contactsJson.results) ? contactsJson.results : []
  const contact = contacts.find(
    item => item && item.available !== false && personNameMatches(item.name, assigneeName)
  )
  return {
    available: !!(contact && contact.contactId != null),
    contact: contact || null,
    assigneeName
  }
}

/**
 * Create a WeCom-synced work todo via Xiaoce `/api/wecom/todos/`.
 * Resolves assignee by display name against contacts, then platform members.
 */
export async function createXiaoceWecomTodo({
  assignee,
  title,
  description,
  signal,
  resolvedContact
} = {}) {
  const assigneeName = String(assignee || '').trim()
  const draft = prepareWecomTodoDraft({ title, description, assignee: assigneeName })
  if (!draft.ok) {
    const err = new Error(draft.error)
    err.code = draft.code
    throw err
  }
  const taskTitle = draft.title
  const detail = draft.description.slice(0, 1000)

  const probe = resolvedContact
    ? { available: true, contact: resolvedContact }
    : await probeXiaoceWecomRecipient({ assignee: assigneeName, signal })
  const contact = probe.contact

  let body
  if (contact && contact.contactId != null) {
    body = {
      title: taskTitle,
      description: detail,
      platformAssigneeIds: [],
      wecomContactIds: [Number(contact.contactId)],
      syncToWeCom: true
    }
  } else {
    const membersRes = await xiaoceFetch('/api/wecom/todos/members/', {
      cache: 'no-store',
      signal
    })
    const membersJson = await membersRes.json().catch(() => ({}))
    if (!membersRes.ok) {
      throw new Error(
        membersJson.detail ||
          membersJson.error ||
          `读取企业成员失败（HTTP ${membersRes.status}）`
      )
    }
    const members = Array.isArray(membersJson.results) ? membersJson.results : []
    const member = members.find(item => item && personNameMatches(item.name, assigneeName))
    if (!member) {
      const err = new Error(
        `小策通讯录找不到「${assigneeName}」，请确认姓名与企业成员一致`
      )
      err.code = 'wecom_user_not_found'
      err.status = 404
      throw err
    }
    body = {
      title: taskTitle,
      description: detail,
      platformAssigneeIds: [Number(member.id)],
      wecomContactIds: [],
      syncToWeCom: false
    }
  }

  const createRes = await xiaoceFetch('/api/wecom/todos/', {
    method: 'POST',
    body: JSON.stringify(body),
    signal
  })
  const created = await createRes.json().catch(() => ({}))
  if (!createRes.ok) {
    const msg =
      (created && (created.detail || created.error)) ||
      `创建待办失败（HTTP ${createRes.status}）`
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
    err.status = createRes.status
    err.code = created && created.code
    throw err
  }
  return {
    ok: true,
    ids: created.ids || [],
    syncStatus: created.syncStatus || '',
    detail: created.detail || created.syncDetail || '待办已创建',
    viaContact: !!(contact && contact.contactId != null),
    matchedName: (contact && contact.name) || assigneeName
  }
}

export async function fetchXiaoceOrganizations() {
  const res = await xiaoceFetch('/api/auth/me/', { cache: 'no-store' })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || json.detail || `HTTP ${res.status}`)
  return (json.user && json.user.organizations) || []
}

export async function fetchXiaoceAgents(organizationId) {
  const id = String(organizationId || '').trim()
  if (!id) return []
  const res = await xiaoceFetch(
    `/api/council/agents/?view=directory&organization_id=${encodeURIComponent(id)}`,
    { cache: 'no-store' }
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || json.detail || `HTTP ${res.status}`)
  return (json.results || []).map(item => ({
    id: String(item.id),
    name: item.name || item.employee_code || String(item.id),
    emoji: item.emoji || '🤖',
    group: item.group || '',
    role: item.role || ''
  }))
}

const agentSessions = new Map()

function waitForPoll(signal, delay = 800) {
  return new Promise((resolve, reject) => {
    let abort = null
    const timer = setTimeout(() => {
      if (signal && abort) signal.removeEventListener('abort', abort)
      resolve()
    }, delay)
    if (!signal) return
    abort = () => {
      clearTimeout(timer)
      const err = new Error('请求已取消')
      err.name = 'AbortError'
      reject(err)
    }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

export function extractWecomTodoConfirmPhrase(text) {
  const m = String(text || '').match(/确认创建企业微信待办「[^」]+」/)
  return m ? m[0].trim() : ''
}

export function isWecomTodoConfirmationPreview(text) {
  const t = String(text || '')
  return (
    /创建待办预览|尚未执行任何写入|待确认/.test(t) &&
    /确认创建企业微信待办/.test(t)
  )
}

export function isWecomTodoCreateSuccess(text) {
  const t = String(text || '')
  if (isWecomTodoConfirmationPreview(t)) return false
  // 不能因为“创建待办成功”等模型复述，就掩盖工具返回的权限拒绝。
  if (
    /没有读取该成员的权限|无权读取.*通讯录|WEWORK.*(?:NO_PERMISSION|FORBIDDEN)|权限不足|permission denied|forbidden/i.test(
      t
    )
  ) {
    return false
  }
  return /创建待办成功|待办\s*ID|已完成|成功条目/.test(t)
}

async function ensureAgentSession({
  organizationId,
  agentId,
  conversationId,
  title,
  signal
}) {
  const sessionKey = `${organizationId}:${agentId}:${conversationId || 'default'}`
  let sessionId = agentSessions.get(sessionKey)
  if (sessionId) return { sessionKey, sessionId }
  const created = await xiaoceFetch(
    `/api/council/agents/${encodeURIComponent(agentId)}/chat/sessions/`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        organization_id: Number(organizationId),
        title: String(title || 'mind-map').slice(0, 40)
      }),
      signal
    }
  )
  const session = await created.json().catch(() => ({}))
  if (!created.ok || !session.id) {
    throw new Error(session.error || session.detail || `HTTP ${created.status}`)
  }
  sessionId = session.id
  agentSessions.set(sessionKey, sessionId)
  return { sessionKey, sessionId }
}

async function postAgentMessageAndWait({
  agentId,
  sessionId,
  message,
  signal,
  onDelta
}) {
  // 记录发送前最新助手消息，避免确认后仍读到旧的预览文案
  let lastAssistantId = ''
  try {
    const beforeRes = await xiaoceFetch(
      `/api/council/agents/${encodeURIComponent(agentId)}/chat/sessions/${encodeURIComponent(sessionId)}/`,
      { cache: 'no-store', signal }
    )
    const before = await beforeRes.json().catch(() => ({}))
    const beforeMessages = Array.isArray(before.messages) ? before.messages : []
    const lastAssistant = [...beforeMessages]
      .reverse()
      .find(item => item && item.role === 'assistant')
    lastAssistantId = (lastAssistant && lastAssistant.id) || ''
  } catch (e) {
    lastAssistantId = ''
  }

  const started = await xiaoceFetch(
    `/api/council/agents/${encodeURIComponent(agentId)}/chat/sessions/${encodeURIComponent(sessionId)}/messages/`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ message }),
      signal
    }
  )
  const startedJson = await started.json().catch(() => ({}))
  if (!started.ok) {
    throw new Error(
      startedJson.error || startedJson.detail || `HTTP ${started.status}`
    )
  }
  const runId = startedJson.run && startedJson.run.id
  for (;;) {
    await waitForPoll(signal)
    const statusResponse = await xiaoceFetch(
      `/api/council/agents/${encodeURIComponent(agentId)}/chat/sessions/${encodeURIComponent(sessionId)}/`,
      { cache: 'no-store', signal }
    )
    const session = await statusResponse.json().catch(() => ({}))
    if (!statusResponse.ok) {
      throw new Error(session.error || session.detail || `HTTP ${statusResponse.status}`)
    }
    const messages = Array.isArray(session.messages) ? session.messages : []
    const reply = [...messages]
      .reverse()
      .find(
        item =>
          item &&
          item.role === 'assistant' &&
          (!lastAssistantId || String(item.id) !== String(lastAssistantId))
      )
    if (!session.active_run && session.last_run_status === 'failed') {
      throw new Error('智能体执行失败，请稍后重试')
    }
    if (!session.active_run && session.last_run_status === 'cancelled') {
      throw new Error('智能体执行已取消')
    }
    if (reply && (!runId || !session.active_run)) {
      if (onDelta && reply.content) onDelta(reply.content)
      return {
        content: reply.content || '',
        conversationId: sessionId,
        raw: session
      }
    }
    if (!session.active_run && session.last_run_status === 'completed') {
      // 有时 completed 时 reply 过滤过严，回退取最后一条助手消息
      const fallback = [...messages]
        .reverse()
        .find(item => item && item.role === 'assistant')
      if (fallback && fallback.content) {
        if (onDelta) onDelta(fallback.content)
        return {
          content: fallback.content || '',
          conversationId: sessionId,
          raw: session
        }
      }
      throw new Error('智能体执行完成但未返回内容')
    }
  }
}

async function agentScopedChat({
  message,
  signal,
  onDelta,
  conversationId,
  organizationId,
  agentId,
  autoConfirmWecomTodos = false
}) {
  const { sessionId } = await ensureAgentSession({
    organizationId,
    agentId,
    conversationId,
    title: message,
    signal
  })
  let result = await postAgentMessageAndWait({
    agentId,
    sessionId,
    message,
    signal,
    onDelta
  })

  // 与小策网页一致：待办预览确认门禁出现后，自动回完整确认句再执行写入
  if (
    autoConfirmWecomTodos &&
    isWecomTodoConfirmationPreview(result.content)
  ) {
    const phrase = extractWecomTodoConfirmPhrase(result.content)
    if (phrase) {
      if (onDelta) onDelta(`\n—— 自动确认门禁 ——\n${phrase}\n`)
      result = await postAgentMessageAndWait({
        agentId,
        sessionId,
        message: phrase,
        signal,
        onDelta
      })
    }
  }

  return {
    content: result.content || '',
    toolCalls: [],
    eventToolCalls: [],
    events: isWecomTodoCreateSuccess(result.content)
      ? [{ type: 'tool_result', label: 'wecom_todo_create' }]
      : [],
    conversationId: sessionId,
    raw: result.raw
  }
}

/**
 * 走小策智能体官方企微待办链路（含确认门禁自动确认），与网页聊天一致。
 */
export async function createXiaoceWecomTodoViaAgent({
  assignee,
  title,
  description,
  signal,
  onDelta,
  conversationId
} = {}) {
  const {
    organizationId: configuredOrganizationId,
    agentId: configuredAgentId
  } = getXiaoceConfig()
  const organizationId = String(configuredOrganizationId || '').trim()
  const agentId = String(configuredAgentId || '').trim()
  if (!organizationId || !agentId) {
    const err = new Error('请先在设置中选择小策所属企业和企业智能体')
    err.code = 'XIAOCE_SCOPE_MISSING'
    throw err
  }
  const assigneeName = String(assignee || '').trim() || '负责人'
  const draft = prepareWecomTodoDraft({ title, description, assignee: assigneeName })
  if (!draft.ok) {
    const err = new Error(draft.error)
    err.code = draft.code
    throw err
  }
  const taskTitle = draft.title
  const detail = draft.description.slice(0, 1000)
  const message = [
    `请立刻通过企业微信给「${assigneeName}」创建一条企微待办（官方企微待办，不是平台内部待办）。`,
    `标题：${taskTitle}`,
    `待办标题必须精确为「${taskTitle}」；不得包含接收人、创建/发送动作、企业微信或说明。`,
    detail ? `说明：${detail}` : '',
    '若出现「创建待办预览 / 待确认」，请在本轮给出可复制的完整确认句；不要停在口头说明。'
  ]
    .filter(Boolean)
    .join('\n')

  const result = await agentScopedChat({
    message,
    signal,
    onDelta,
    conversationId:
      conversationId ||
      `wecom-todo-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
    organizationId,
    agentId,
    autoConfirmWecomTodos: true
  })

  if (isWecomTodoConfirmationPreview(result.content)) {
    const err = new Error(
      '小策待办仍停在确认门禁，自动确认未生效。请在小策网页确认智能体企微写权限可用。'
    )
    err.code = 'wecom_confirmation_pending'
    throw err
  }
  if (
    /没有读取该成员的权限|无权读取.*通讯录|WEWORK.*(?:NO_PERMISSION|FORBIDDEN)|权限不足|permission denied|forbidden/i.test(
      String(result.content || '')
    )
  ) {
    const err = new Error(String(result.content || '').trim().slice(0, 240))
    err.code = 'WEWORK_NO_PERMISSION'
    throw err
  }
  if (!isWecomTodoCreateSuccess(result.content) && !/已创建|创建成功/.test(result.content)) {
    const err = new Error(
      String(result.content || '').trim().slice(0, 240) ||
        '小策未确认企微待办已创建'
    )
    err.code = 'wecom_todo_unconfirmed'
    throw err
  }
  return {
    ok: true,
    ids: [],
    syncStatus: 'synced',
    detail:
      String(result.content || '').trim().slice(0, 400) ||
      `企微待办已创建：${taskTitle}`,
    viaContact: true,
    matchedName: assigneeName,
    via: 'xiaoce-agent'
  }
}

export async function checkXiaoce() {
  try {
    const res = await xiaoceFetch('/api/agent/models/', { cache: 'no-store' })
    return res.ok
  } catch (e) {
    return false
  }
}

export async function fetchXiaoceModels() {
  const res = await xiaoceFetch('/api/agent/models/', {
    cache: 'no-store',
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `HTTP ${res.status}`)
  }
  const json = await res.json()
  const list = []
  const push = (item, custom) => {
    if (!item) return
    const id = item.id || item.model || item.name
    if (!id) return
    list.push({
      id: String(id),
      name: item.name || item.label || String(id),
      custom: !!custom,
      vendor: item.vendor || item.provider || ''
    })
  }
  ;(json.platform_models || json.platform || json.funded || []).forEach(item =>
    push(item, false)
  )
  ;(json.user_models || json.own_key || json.custom || []).forEach(item =>
    push(item, true)
  )
  if (Array.isArray(json.models)) json.models.forEach(item => push(item, false))
  if (Array.isArray(json)) json.forEach(item => push(item, false))
  return list
}

function lastUserMessage(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i]
    if (item && item.role === 'user') {
      if (typeof item.content === 'string') return item.content
      if (Array.isArray(item.content)) {
        return item.content
          .map(part => (part && part.text) || '')
          .filter(Boolean)
          .join('\n')
      }
    }
  }
  return ''
}

/**
 * Call Yiran / 小策 agent chat (JSON, authenticated Token).
 * Same return shape as workbuddy streamChat for SOP/fill callers.
 */
export async function streamChat({
  messages,
  signal,
  onDelta,
  conversationId,
  autoConfirmWecomTodos = true
} = {}) {
  const {
    organizationId: configuredOrganizationId,
    agentId: configuredAgentId
  } = getXiaoceConfig()
  const message = lastUserMessage(messages)
  if (!message) {
    const err = new Error('消息不能为空')
    err.code = 'XIAOCE_EMPTY_MESSAGE'
    throw err
  }
  const scopedOrganizationId = String(configuredOrganizationId || '').trim()
  const scopedAgentId = String(configuredAgentId || '').trim()
  if (!scopedOrganizationId || !scopedAgentId) {
    const err = new Error('请先在设置中选择小策所属企业和企业智能体')
    err.code = 'XIAOCE_SCOPE_MISSING'
    throw err
  }
  return agentScopedChat({
    message,
    signal,
    onDelta,
    conversationId,
    organizationId: scopedOrganizationId,
    agentId: scopedAgentId,
    autoConfirmWecomTodos
  })
}
