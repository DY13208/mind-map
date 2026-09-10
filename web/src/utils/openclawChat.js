/**
 * 本机 OpenClaw Gateway（OpenAI 兼容）客户端。
 * 默认经 /openclaw-api 代理到宿主机 OpenClaw（默认 18791）
 */
import { getRuntimeConfig } from './runtimeConfig'

const TOKEN_KEY = 'openclaw.gatewayToken'
const BASE_KEY = 'openclaw.baseUrl'
const MODEL_KEY = 'openclaw.model'

export function getOpenclawConfig() {
  const runtime =
    (typeof window !== 'undefined' && window.__MIND_MAP_RUNTIME__) || {}
  const cfg = getRuntimeConfig()
  let token = ''
  let baseUrl = ''
  let model = ''
  try {
    token = localStorage.getItem(TOKEN_KEY) || ''
    baseUrl = localStorage.getItem(BASE_KEY) || ''
    model = localStorage.getItem(MODEL_KEY) || ''
  } catch (e) {
    /* ignore */
  }
  // Start-Docker 注入的 runtime Token 优先，避免旧 localStorage 挡住自动配置
  const runtimeToken = String(
    runtime.openclawToken || cfg.openclawToken || ''
  ).trim()
  return {
    baseUrl: String(
      runtime.openclawBase ||
        cfg.openclawBase ||
        baseUrl ||
        '/openclaw-api'
    ).replace(/\/$/, ''),
    token: String(runtimeToken || token || '').trim(),
    model: String(
      runtime.openclawModel ||
        cfg.openclawModel ||
        model ||
        'openclaw/default'
    ).trim(),
    controlUrl: String(
      runtime.openclawControlUrl ||
        cfg.openclawControlUrl ||
        'http://127.0.0.1:18791/chat'
    ),
    fromRuntime: !!runtimeToken
  }
}

export function saveOpenclawConfig({ token, baseUrl, model } = {}) {
  try {
    if (token != null) localStorage.setItem(TOKEN_KEY, String(token))
    if (baseUrl != null) {
      localStorage.setItem(BASE_KEY, String(baseUrl).replace(/\/$/, ''))
    }
    if (model != null) localStorage.setItem(MODEL_KEY, String(model))
  } catch (e) {
    /* ignore */
  }
}

async function checkOpenclawHealth() {
  const { baseUrl, token } = getOpenclawConfig()
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  const paths = ['/healthz', '/health', '/startupz']
  let last = { ok: false, status: 0, message: '无法连接 OpenClaw' }
  for (const p of paths) {
    try {
      const res = await fetch(`${baseUrl}${p}`, {
        headers,
        cache: 'no-store'
      })
      if (res.ok) {
        const json = await res.json().catch(() => ({}))
        return { ok: true, status: res.status, data: json, path: p }
      }
      const hint =
        res.status === 502 || res.status === 503 || res.status === 504
          ? 'OpenClaw Gateway 未启动（请运行 Start-Docker.bat，会自动拉起 Docker 龙虾容器）'
          : `HTTP ${res.status}`
      last = { ok: false, status: res.status, message: hint }
      // 404 换下一个探活路径；502 基本是容器没起来，不用继续试
      if (res.status === 502 || res.status === 503 || res.status === 504) break
    } catch (err) {
      last = {
        ok: false,
        status: 0,
        message: (err && err.message) || '无法连接 OpenClaw'
      }
    }
  }
  return last
}

export async function listOpenclawModels() {
  const { baseUrl, token } = getOpenclawConfig()
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${baseUrl}/v1/models`, {
    headers,
    cache: 'no-store'
  })
  if (!res.ok) {
    const text = await res.text()
    const err = new Error(text || `HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  const json = await res.json()
  return (json && json.data) || []
}

/**
 * 流式聊天。会话用 user=conv:xxx 保持 OpenClaw session。
 */
export async function streamOpenclawChat({
  messages,
  conversationId,
  model,
  signal,
  onDelta
} = {}) {
  const cfg = getOpenclawConfig()
  const useModel = String(model || cfg.model || 'openclaw/default').trim()
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    Accept: 'text/event-stream'
  }
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`

  const body = {
    model: useModel,
    stream: true,
    messages: messages || []
  }
  if (conversationId) {
    body.user = `conv:${conversationId}`
  }

  const res = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
    cache: 'no-store'
  })
  if (!res.ok) {
    const text = await res.text()
    let message = text || `HTTP ${res.status}`
    try {
      const json = JSON.parse(text)
      message =
        (json.error && json.error.message) || json.message || message
    } catch (e) {
      /* keep */
    }
    const err = new Error(message)
    err.status = res.status
    throw err
  }

  const contentType = String(res.headers.get('content-type') || '')
  const looksStream =
    /text\/event-stream|ndjson|octet-stream/i.test(contentType) ||
    (res.body && res.body.getReader)

  if (!looksStream || !res.body || !res.body.getReader) {
    const json = await res.json()
    const content =
      (json.choices &&
        json.choices[0] &&
        json.choices[0].message &&
        json.choices[0].message.content) ||
      ''
    if (onDelta && content) onDelta(content)
    return { content }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''
    for (const line of lines) {
      const t = line.trim()
      if (!t || t.startsWith(':')) continue
      let data = t
      if (t.startsWith('data:')) data = t.slice(5).trim()
      if (!data || data === '[DONE]') continue
      let json
      try {
        json = JSON.parse(data)
      } catch (e) {
        // 非 JSON 的纯文本增量
        if (data && data[0] !== '{' && data[0] !== '[') {
          content += data
          if (onDelta) onDelta(data)
        }
        continue
      }
      if (json.error) {
        throw new Error(
          (json.error && json.error.message) || JSON.stringify(json.error)
        )
      }
      const choice = json.choices && json.choices[0]
      let delta =
        (choice && choice.delta && choice.delta.content) ||
        (choice && choice.message && choice.message.content) ||
        json.content ||
        (json.delta && json.delta.content) ||
        ''
      // 有的实现会回「累计全文」，只追加新增部分
      if (
        typeof delta === 'string' &&
        delta &&
        content &&
        delta.startsWith(content) &&
        delta.length > content.length
      ) {
        delta = delta.slice(content.length)
      }
      if (typeof delta === 'string' && delta) {
        content += delta
        if (onDelta) onDelta(delta)
      }
    }
  }
  // 收尾：若流里没有任何增量，尝试解析剩余 buffer
  if (!content && buffer.trim()) {
    try {
      const json = JSON.parse(buffer.trim())
      const full =
        (json.choices &&
          json.choices[0] &&
          json.choices[0].message &&
          json.choices[0].message.content) ||
        ''
      if (full) {
        content = full
        if (onDelta) onDelta(full)
      }
    } catch (e) {
      /* ignore */
    }
  }
  return { content }
}
