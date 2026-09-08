import { getRuntimeConfig } from './runtimeConfig'
import { getLocalConfig } from '@/api'

function resolveWorkbuddyModel(runtime, cfg) {
  const saved = getLocalConfig()
  const fromStorage = saved && saved.workbuddyModel
  // auto / 空 → 自定义 DeepSeek（平台积分耗尽时不会空跑）
  const pick = v => (v && v !== 'auto' ? v : '')
  return (
    pick(runtime.workbuddyModel) ||
    pick(fromStorage) ||
    pick(cfg.workbuddyModel) ||
    'deepseek-v4-flash'
  )
}

export function getWorkbuddyConfig() {
  const runtime =
    (typeof window !== 'undefined' && window.__MIND_MAP_RUNTIME__) || {}
  const cfg = getRuntimeConfig()
  const baseUrl = String(
    runtime.workbuddyBase || cfg.workbuddyBase || '/wb-api'
  ).replace(/\/$/, '')
  return {
    baseUrl,
    apiKey: runtime.workbuddyKey || cfg.workbuddyKey || 'local',
    model: resolveWorkbuddyModel(runtime, cfg)
  }
}

/** 本机 WorkBuddy 自定义模型（无平台积分时用） */
export const WORKBUDDY_CUSTOM_MODEL_HINTS = [
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek-V4 Flash（自定义）',
    custom: true
  },
  {
    id: 'deepseek-v4-flash-vision-exp',
    name: 'deepseek-v4-flash-vision-exp（自定义）',
    custom: true
  }
]

export async function fetchWorkbuddyModels() {
  const { baseUrl, apiKey } = getWorkbuddyConfig()
  const res = await fetch(`${baseUrl}/v1/models`, {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${apiKey}` }
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `HTTP ${res.status}`)
  }
  const json = await res.json()
  const list = Array.isArray(json.data) ? json.data : []
  const mapped = list
    .map(item => ({
      id: item.id,
      name: item.name || item.id,
      vendor: item.vendor || '',
      custom: item.custom === true || item.owned_by === 'custom',
      baseId: item.base_id || item.baseId || '',
      supportsToolCall: item.supports_tool_call !== false
    }))
    .filter(item => item.id)

  // 合并本机已知自定义模型，避免被平台同名模型盖住
  const byId = new Map(mapped.map(item => [item.id, item]))
  WORKBUDDY_CUSTOM_MODEL_HINTS.forEach(hint => {
    const prev = byId.get(hint.id)
    byId.set(hint.id, {
      ...(prev || {}),
      ...hint,
      name: hint.name || (prev && prev.name) || hint.id,
      custom: true
    })
  })
  return Array.from(byId.values())
}

export async function checkWorkbuddy() {
  const { baseUrl } = getWorkbuddyConfig()
  try {
    const res = await fetch(`${baseUrl}/health`, { cache: 'no-store' })
    if (!res.ok) return { ok: false, status: res.status }
    const data = await res.json().catch(() => ({}))
    return { ok: true, data }
  } catch (err) {
    return { ok: false, error: err }
  }
}

function eventLabel(event) {
  const type = String((event && event.type) || '')
  if (type === 'workbuddy.tool_call') {
    const name =
      (event.tool && (event.tool.name || event.tool.tool)) ||
      event.name ||
      event.tool_name ||
      event.title ||
      ''
    return name ? `正在调用 ${name}` : '正在使用工具'
  }
  if (type === 'workbuddy.tool_result') return '工具已返回'
  if (type === 'workbuddy.phase') {
    const phase = String(event.phase || event.message || '')
    const labels = {
      model_requesting: '正在请求模型…',
      model_streaming: '正在生成内容…',
      tool_calling: '正在调用工具…',
      tool_executing: '正在执行工具…',
      planning: '正在规划…'
    }
    return labels[phase] || phase || '处理中'
  }
  if (type === 'workbuddy.plan') return '正在规划'
  if (type === 'workbuddy.interruption') return '已中断'
  if (type === 'workbuddy.session_end') return ''
  if (type === 'workbuddy.usage') return ''
  return type.replace(/^workbuddy\./, '') || ''
}

function deltaText(json) {
  if (!json || typeof json !== 'object') return ''
  // Anthropic 风格（偶发被代理到同一 SSE）
  if (json.type === 'content_block_delta') {
    const d = json.delta || {}
    if (typeof d.text === 'string') return d.text
    if (typeof d.content === 'string') return d.content
  }
  if (typeof json.content === 'string' && !json.choices) return json.content
  if (typeof json.text === 'string' && !json.choices) return json.text

  const choice = json.choices && json.choices[0]
  const delta = (choice && (choice.delta || choice.message)) || json.delta
  if (!delta) {
    if (choice && choice.message && typeof choice.message.content === 'string') {
      return choice.message.content
    }
    return ''
  }
  if (typeof delta.content === 'string') return delta.content
  if (typeof delta.text === 'string') return delta.text
  if (Array.isArray(delta.content)) {
    return delta.content
      .map(part => {
        if (typeof part === 'string') return part
        return (
          (part &&
            (part.text || part.content || part.markdown || part.value)) ||
          ''
        )
      })
      .join('')
  }
  return ''
}

export async function streamChat({
  messages,
  signal,
  onDelta,
  onEvent,
  extra = {},
  stream = true,
  conversationId,
  model
} = {}) {
  const { baseUrl, apiKey, model: defaultModel } = getWorkbuddyConfig()
  const useModel = String(model || defaultModel || 'auto').trim() || 'auto'
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    Authorization: `Bearer ${apiKey}`,
    'X-WorkBuddy-Events': '1'
  }
  if (conversationId) {
    headers['X-Conversation-ID'] = String(conversationId)
  }
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: useModel,
      stream: !!stream,
      workbuddy_events: true,
      messages,
      ...extra
    }),
    signal
  })
  if (!res.ok) {
    const text = await res.text()
    let message = text || `HTTP ${res.status}`
    try {
      const json = JSON.parse(text)
      message =
        (json.error && json.error.message) || json.message || message
    } catch (e) {
      /* keep text */
    }
    const err = new Error(message)
    err.status = res.status
    throw err
  }

  // 非流式：一次拿完整 tool_calls，大 payload 更稳
  if (!stream || !res.body || !res.body.getReader) {
    const json = await res.json()
    const message =
      json.choices && json.choices[0] && json.choices[0].message
    const text =
      deltaText(json) || (message && message.content) || ''
    const rawCalls = (message && message.tool_calls) || []
    const toolCalls = rawCalls.map(call => ({
      id: call.id || '',
      name: (call.function && call.function.name) || call.name || '',
      arguments:
        (call.function && call.function.arguments) ||
        call.arguments ||
        ''
    }))
    if (onDelta && text) onDelta(text)
    return {
      content: text || '',
      toolCalls,
      eventToolCalls: [],
      events: json.workbuddy_events || []
    }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  const toolMap = {}
  const eventToolCalls = []
  const events = []

  const pushEventToolCall = (name, args, id) => {
    if (!name) return
    const normalized =
      typeof args === 'string' ? args : JSON.stringify(args || {})
    const existing = eventToolCalls.find(
      item => item.id && id && item.id === id
    )
    if (existing) {
      existing.name = name
      if (normalized) existing.arguments = normalized
      return
    }
    eventToolCalls.push({
      id: id || `evt_${eventToolCalls.length}`,
      name,
      arguments: normalized
    })
  }

  const consume = line => {
    const trimmed = String(line || '').trim()
    if (!trimmed || trimmed.startsWith(':')) return
    if (!trimmed.startsWith('data:')) return
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') return
    let json
    try {
      json = JSON.parse(data)
    } catch (e) {
      return
    }
    const type = json && json.type
    if (type && String(type).startsWith('workbuddy.')) {
      events.push(json)
      if (type === 'workbuddy.tool_call') {
        pushEventToolCall(
          json.name || json.tool_name,
          json.input || json.rawInput,
          json.id
        )
      }
      if (type === 'workbuddy.tool_result') {
        const result = json.result || json.text || json.output
        pushEventToolCall(
          json.name || json.tool_name,
          result,
          json.id
        )
      }
      const label = eventLabel(json)
      if (label && onEvent) onEvent(label, json)
      return
    }
    const piece = deltaText(json)
    if (piece) {
      // 代理偶发推「累计全文」而非增量；避免重复拼接成巨文
      if (!content) {
        content = piece
      } else if (piece.startsWith(content)) {
        content = piece
      } else if (content.startsWith(piece)) {
        // 忽略回退/重复短片
      } else {
        content += piece
      }
      if (onDelta) onDelta(content)
    }
    const choice = json.choices && json.choices[0]
    const delta = choice && choice.delta
    const calls = (delta && delta.tool_calls) || []
    calls.forEach(call => {
      const index = call.index != null ? call.index : 0
      if (!toolMap[index]) {
        toolMap[index] = {
          id: call.id || '',
          name: (call.function && call.function.name) || '',
          arguments: ''
        }
      }
      if (call.id) toolMap[index].id = call.id
      if (call.function && call.function.name) {
        toolMap[index].name = call.function.name
      }
      if (call.function && call.function.arguments) {
        toolMap[index].arguments += call.function.arguments
      }
    })
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''
    lines.forEach(consume)
  }
  if (buffer) consume(buffer)
  const toolCalls = Object.keys(toolMap)
    .sort((a, b) => Number(a) - Number(b))
    .map(key => toolMap[key])
  return { content, toolCalls, eventToolCalls, events }
}
