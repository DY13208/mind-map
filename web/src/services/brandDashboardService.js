import { productRequest } from './productHttp'
import { getRuntimeConfig } from '../utils/runtimeConfig'

export async function listBrandDashboards(options = {}) {
  const data = await productRequest('/api/dashboards', {
    signal: options.signal,
    timeoutMs: options.timeoutMs || 30000
  })
  return {
    list: Array.isArray(data.list) ? data.list : [],
    total: Number(data.total) || 0
  }
}

export async function createDashboard(payload = {}) {
  const body = {
    title: String(payload.title || '').trim(),
    level: payload.level || 'group',
    fileName: payload.fileName || '',
    contentBase64: payload.contentBase64 || '',
    sourceUrl: payload.sourceUrl || ''
  }
  const data = await productRequest('/api/dashboards', {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: 60000
  })
  return (data && data.dashboard) || null
}

export function dashboardContentUrl(id) {
  const base = String(getRuntimeConfig().collabApi || '').replace(/\/$/, '')
  return `${base}/api/dashboards/${encodeURIComponent(id)}/content`
}

export async function deleteDashboard(id) {
  const data = await productRequest(`/api/dashboards/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    timeoutMs: 30000
  })
  return Number(data.deleted) || 0
}

export default {
  listBrandDashboards,
  createDashboard,
  dashboardContentUrl,
  deleteDashboard
}
