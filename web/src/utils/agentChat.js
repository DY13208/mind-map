import {
  checkOpenclawHealth,
  getOpenclawConfig,
  listOpenclawModels,
  streamOpenclawChat
} from './openclawChat'
import { streamOpenclawGatewayWs } from './openclawGatewayWs'

/** @deprecated 仅兼容旧配置；执行统一走 OpenClaw */
export const AI_BACKEND_WORKBUDDY = 'workbuddy'
/** @deprecated 仅兼容旧配置；执行统一走 OpenClaw */
export const AI_BACKEND_XIAOCE = 'xiaoce'
export const AI_BACKEND_OPENCLAW = 'openclaw'

/**
 * 统一归一化为助理（OpenClaw）。
 * WorkBuddy / 小策执行路径已下线，不再占用本机代理内存。
 */
export function normalizeAiBackend(_raw) {
  return AI_BACKEND_OPENCLAW
}

export function getAiBackend() {
  return AI_BACKEND_OPENCLAW
}

export function isXiaoceBackend() {
  return false
}

export function isOpenclawBackend() {
  return true
}

export function aiBackendLabel(_backend) {
  return '助理'
}

/**
 * Unified readiness check. Always returns `{ ok, backend, ... }`.
 */
export async function checkAiBackend(_backend) {
  const h = await checkOpenclawHealth()
  return {
    ok: !!(h && h.ok),
    backend: AI_BACKEND_OPENCLAW,
    status: h && h.status,
    data: h && h.data,
    error: h && h.message
  }
}

export async function fetchAiModels(_backend) {
  const list = await listOpenclawModels()
  return (list || []).map(m => ({
    id: m.id || m.name,
    name: m.name || m.id,
    custom: true
  }))
}

/**
 * OpenClaw：优先 Gateway Bridge WS（带 tool），失败回退 HTTP SSE。
 * onDelta 传累计全文，对齐队列消费方式。
 */
async function streamOpenclawUnified({
  messages,
  conversationId,
  model,
  signal,
  onDelta,
  onEvent
} = {}) {
  const cfg = getOpenclawConfig()
  const useModel = String(model || cfg.model || 'openclaw/default').trim()
  const userText = (messages || [])
    .filter(m => m && (m.role === 'user' || m.role === 'system'))
    .map(m => String(m.content || '').trim())
    .filter(Boolean)
    .join('\n\n')

  let content = ''
  const events = []

  const pushDelta = piece => {
    const p = String(piece || '')
    if (!p) return
    if (!content) content = p
    else if (p.startsWith(content)) content = p
    else if (content.startsWith(p)) {
      /* ignore */
    } else content += p
    if (onDelta) onDelta(content)
  }

  try {
    await streamOpenclawGatewayWs({
      message: userText,
      conversationId,
      signal,
      onDelta: piece => pushDelta(piece),
      onTool: info => {
        const name = (info && info.name) || 'tool'
        const phase = (info && info.phase) || ''
        const label = phase ? `${name} ${phase}` : name
        events.push({
          type: 'openclaw.tool',
          name,
          phase,
          detail: (info && info.detail) || ''
        })
        if (onEvent) onEvent(label, info)
      }
    })
    return { content, events, toolCalls: [], eventToolCalls: [] }
  } catch (wsErr) {
    if (wsErr && wsErr.name === 'AbortError') throw wsErr
    const result = await streamOpenclawChat({
      messages,
      conversationId,
      model: useModel,
      signal,
      onDelta: piece => pushDelta(piece)
    })
    return {
      content: content || (result && result.content) || '',
      events,
      toolCalls: [],
      eventToolCalls: []
    }
  }
}

export function streamChat(options = {}) {
  return streamOpenclawUnified(options)
}

// Prefer checkAiBackend for new code. Alias keeps SOP / toolbar working.
export const checkWorkbuddy = checkAiBackend

// 保留旧导出，避免零散 import 报错；执行不再走这些实现。
export {
  getWorkbuddyConfig,
  fetchWorkbuddyModels,
  WORKBUDDY_CUSTOM_MODEL_HINTS,
  checkWorkbuddy as checkWorkbuddyRaw
} from './workbuddyChat'
export {
  getXiaoceConfig,
  fetchXiaoceModels,
  fetchXiaoceOrganizations,
  fetchXiaoceAgents,
  checkXiaoce
} from './xiaoceChat'
export {
  getOpenclawConfig,
  checkOpenclawHealth,
  listOpenclawModels,
  saveOpenclawConfig
} from './openclawChat'
