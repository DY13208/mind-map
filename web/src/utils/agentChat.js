import { getLocalConfig } from '@/api'
import { getRuntimeConfig } from './runtimeConfig'
import * as workbuddy from './workbuddyChat'
import * as xiaoce from './xiaoceChat'
import {
  checkOpenclawHealth,
  getOpenclawConfig,
  listOpenclawModels,
  streamOpenclawChat
} from './openclawChat'
import { streamOpenclawGatewayWs } from './openclawGatewayWs'

export const AI_BACKEND_WORKBUDDY = 'workbuddy'
export const AI_BACKEND_XIAOCE = 'xiaoce'
export const AI_BACKEND_OPENCLAW = 'openclaw'

export function normalizeAiBackend(raw) {
  const v = String(raw || '')
    .trim()
    .toLowerCase()
  if (v === AI_BACKEND_XIAOCE) return AI_BACKEND_XIAOCE
  if (v === AI_BACKEND_OPENCLAW || v === 'assistant' || v === '龙虾') {
    return AI_BACKEND_OPENCLAW
  }
  return AI_BACKEND_WORKBUDDY
}

export function getAiBackend() {
  const runtime =
    (typeof window !== 'undefined' && window.__MIND_MAP_RUNTIME__) || {}
  const cfg = getRuntimeConfig()
  const saved = getLocalConfig() || {}
  return normalizeAiBackend(
    runtime.aiBackend || cfg.aiBackend || saved.aiBackend || AI_BACKEND_WORKBUDDY
  )
}

export function isXiaoceBackend(backend = getAiBackend()) {
  return normalizeAiBackend(backend) === AI_BACKEND_XIAOCE
}

export function isOpenclawBackend(backend = getAiBackend()) {
  return normalizeAiBackend(backend) === AI_BACKEND_OPENCLAW
}

export function aiBackendLabel(backend = getAiBackend()) {
  const b = normalizeAiBackend(backend)
  if (b === AI_BACKEND_XIAOCE) return '小策'
  if (b === AI_BACKEND_OPENCLAW) return '助理'
  return 'WorkBuddy'
}

/**
 * Unified readiness check. Always returns `{ ok, backend, ... }`.
 * @param {string} [backend] 指定引擎（多任务按 job.backend）
 */
export async function checkAiBackend(backend) {
  const b = normalizeAiBackend(backend || getAiBackend())
  if (b === AI_BACKEND_XIAOCE) {
    const ok = await xiaoce.checkXiaoce()
    return { ok: !!ok, backend: AI_BACKEND_XIAOCE }
  }
  if (b === AI_BACKEND_OPENCLAW) {
    const h = await checkOpenclawHealth()
    return {
      ok: !!(h && h.ok),
      backend: AI_BACKEND_OPENCLAW,
      status: h && h.status,
      data: h && h.data,
      error: h && h.message
    }
  }
  const wb = await workbuddy.checkWorkbuddy()
  return {
    ok: !!(wb && wb.ok),
    backend: AI_BACKEND_WORKBUDDY,
    status: wb && wb.status,
    data: wb && wb.data,
    error: wb && wb.error
  }
}

export async function fetchAiModels(backend) {
  const b = normalizeAiBackend(backend || getAiBackend())
  if (b === AI_BACKEND_XIAOCE) return xiaoce.fetchXiaoceModels()
  if (b === AI_BACKEND_OPENCLAW) {
    const list = await listOpenclawModels()
    return (list || []).map(m => ({
      id: m.id || m.name,
      name: m.name || m.id,
      custom: true
    }))
  }
  return workbuddy.fetchWorkbuddyModels()
}

/**
 * OpenClaw：优先 Gateway Bridge WS（带 tool），失败回退 HTTP SSE。
 * onDelta 传累计全文，对齐 WorkBuddy 队列消费方式。
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
    // Bridge 不可用时回退 HTTP
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
  const b = normalizeAiBackend(options.backend || getAiBackend())
  if (b === AI_BACKEND_XIAOCE) return xiaoce.streamChat(options)
  if (b === AI_BACKEND_OPENCLAW) return streamOpenclawUnified(options)
  return workbuddy.streamChat(options)
}

// Prefer checkAiBackend for new code. Alias keeps SOP / toolbar working while
// switching backends (returns unified `{ ok }`).
export const checkWorkbuddy = checkAiBackend

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
