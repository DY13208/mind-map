import { getLocalConfig } from '@/api'
import { getRuntimeConfig } from './runtimeConfig'
import * as workbuddy from './workbuddyChat'
import * as xiaoce from './xiaoceChat'

export const AI_BACKEND_WORKBUDDY = 'workbuddy'
export const AI_BACKEND_XIAOCE = 'xiaoce'

export function getAiBackend() {
  const runtime =
    (typeof window !== 'undefined' && window.__MIND_MAP_RUNTIME__) || {}
  const cfg = getRuntimeConfig()
  const saved = getLocalConfig() || {}
  const raw = String(
    runtime.aiBackend || cfg.aiBackend || saved.aiBackend || AI_BACKEND_WORKBUDDY
  )
    .trim()
    .toLowerCase()
  return raw === AI_BACKEND_XIAOCE ? AI_BACKEND_XIAOCE : AI_BACKEND_WORKBUDDY
}

export function isXiaoceBackend() {
  return getAiBackend() === AI_BACKEND_XIAOCE
}

export function aiBackendLabel(backend = getAiBackend()) {
  return backend === AI_BACKEND_XIAOCE ? '小策' : 'WorkBuddy'
}

/**
 * Unified readiness check. Always returns `{ ok, backend, ... }`.
 */
export async function checkAiBackend() {
  if (isXiaoceBackend()) {
    const ok = await xiaoce.checkXiaoce()
    return { ok: !!ok, backend: AI_BACKEND_XIAOCE }
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

export async function fetchAiModels() {
  if (isXiaoceBackend()) return xiaoce.fetchXiaoceModels()
  return workbuddy.fetchWorkbuddyModels()
}

export function streamChat(options) {
  if (isXiaoceBackend()) return xiaoce.streamChat(options)
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
