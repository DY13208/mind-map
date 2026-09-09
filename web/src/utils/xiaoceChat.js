import { getRuntimeConfig } from './runtimeConfig'
import { getLocalConfig } from '@/api'
import { getAuthApiUrl } from './auth'

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
      const err = new Error(exchange.error || '小策账号关联失败')
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
  const response = await fetch(`${auth.baseUrl}${path}`, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: auth.authorization }
  })
  if (response.status === 401 && retry) {
    ssoAccess = null
    const refreshed = await getXiaoceAuthorization(true)
    return fetch(`${refreshed.baseUrl}${path}`, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: refreshed.authorization }
    })
  }
  return response
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

async function agentScopedChat({ message, signal, onDelta, conversationId, organizationId, agentId }) {
  const sessionKey = `${organizationId}:${agentId}:${conversationId || 'default'}`
  let sessionId = agentSessions.get(sessionKey)
  if (!sessionId) {
    const created = await xiaoceFetch(`/api/council/agents/${encodeURIComponent(agentId)}/chat/sessions/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ organization_id: Number(organizationId), title: message.slice(0, 40) }),
      signal
    })
    const session = await created.json().catch(() => ({}))
    if (!created.ok || !session.id) throw new Error(session.error || session.detail || `HTTP ${created.status}`)
    sessionId = session.id
    agentSessions.set(sessionKey, sessionId)
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
  if (!started.ok) throw new Error(startedJson.error || startedJson.detail || `HTTP ${started.status}`)
  const runId = startedJson.run && startedJson.run.id
  for (;;) {
    await waitForPoll(signal)
    const statusResponse = await xiaoceFetch(
      `/api/council/agents/${encodeURIComponent(agentId)}/chat/sessions/${encodeURIComponent(sessionId)}/`,
      { cache: 'no-store', signal }
    )
    const session = await statusResponse.json().catch(() => ({}))
    if (!statusResponse.ok) throw new Error(session.error || session.detail || `HTTP ${statusResponse.status}`)
    const messages = Array.isArray(session.messages) ? session.messages : []
    const reply = [...messages].reverse().find(item => item.role === 'assistant')
    if (!session.active_run && session.last_run_status === 'failed') {
      throw new Error('智能体执行失败，请稍后重试')
    }
    if (!session.active_run && session.last_run_status === 'cancelled') {
      throw new Error('智能体执行已取消')
    }
    if (reply && (!runId || !session.active_run)) {
      if (onDelta && reply.content) onDelta(reply.content)
      return { content: reply.content || '', toolCalls: [], eventToolCalls: [], events: [], conversationId: sessionId, raw: session }
    }
    if (!session.active_run && session.last_run_status === 'completed') {
      throw new Error('智能体执行完成但未返回内容')
    }
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
  conversationId
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
    agentId: scopedAgentId
  })
}
