/**
 * Cognee 知识图谱接入器
 * 浏览器走同源 /cognee-api（网关/开发代理注入 X-Api-Key，勿把密钥写进前端）
 */
import { getRuntimeConfig } from './runtimeConfig'

export function getCogneeConfig() {
  const runtime =
    (typeof window !== 'undefined' && window.__MIND_MAP_RUNTIME__) || {}
  const cfg = getRuntimeConfig()
  return {
    baseUrl: String(
      runtime.cogneeBase || cfg.cogneeBase || '/cognee-api'
    ).replace(/\/$/, ''),
    dataset: String(
      runtime.cogneeDataset || cfg.cogneeDataset || 'liangce'
    ).trim() || 'liangce'
  }
}

async function cogneeFetch(path, { method = 'GET', body, signal } = {}) {
  const { baseUrl } = getCogneeConfig()
  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`
  const headers = {}
  let payload = body
  if (body != null && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json; charset=utf-8'
    payload = JSON.stringify(body)
  }
  const res = await fetch(url, { method, headers, body: payload, signal })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch (e) {
    json = null
  }
  if (!res.ok) {
    const msg =
      (json && (json.detail || json.error || json.message)) ||
      text.slice(0, 240) ||
      `HTTP ${res.status}`
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
    err.status = res.status
    err.payload = json
    throw err
  }
  return json != null ? json : text
}

export async function checkCogneeHealth(signal) {
  try {
    const data = await cogneeFetch('/health', { signal })
    const ok =
      data &&
      (data.health === 'healthy' ||
        data.status === 'ready' ||
        data.status === 'ok')
    return {
      ok: !!ok,
      version: (data && data.version) || '',
      status: (data && (data.status || data.health)) || '',
      raw: data
    }
  } catch (err) {
    return {
      ok: false,
      message: (err && err.message) || 'Cognee 未就绪',
      status: err && err.status
    }
  }
}

export async function listCogneeDatasets(signal) {
  const data = await cogneeFetch('/api/v1/datasets', { signal })
  return Array.isArray(data) ? data : (data && data.datasets) || []
}

/**
 * @param {object} opts
 * @param {string} opts.query
 * @param {string} [opts.searchType=GRAPH_COMPLETION]
 * @param {string|string[]} [opts.datasets]
 * @param {AbortSignal} [opts.signal]
 */
export async function searchCognee({
  query,
  searchType = 'GRAPH_COMPLETION',
  datasets,
  signal
} = {}) {
  const { dataset } = getCogneeConfig()
  const ds = datasets == null || datasets === ''
    ? [dataset]
    : Array.isArray(datasets)
      ? datasets
      : [String(datasets)]
  const data = await cogneeFetch('/api/v1/search', {
    method: 'POST',
    signal,
    body: {
      query: String(query || '').trim(),
      search_type: searchType,
      datasets: ds.filter(Boolean)
    }
  })
  return normalizeSearchResults(data)
}

function normalizeSearchResults(data) {
  const list = Array.isArray(data) ? data : data ? [data] : []
  return list.map(item => {
    const raw = item && item.search_result
    let text = ''
    if (Array.isArray(raw)) {
      text = raw
        .map(x => (typeof x === 'string' ? x : JSON.stringify(x)))
        .join('\n')
    } else if (typeof raw === 'string') {
      text = raw
    } else if (raw != null) {
      text = JSON.stringify(raw)
    }
    return {
      datasetId: (item && item.dataset_id) || '',
      datasetName: (item && item.dataset_name) || '',
      text: text.trim(),
      raw: item
    }
  })
}

/**
 * 追加文本到数据集（JSON 形态；部分部署也支持 multipart）
 */
export async function addCogneeText({
  text,
  datasetName,
  signal
} = {}) {
  const { dataset } = getCogneeConfig()
  const name = String(datasetName || dataset).trim() || 'liangce'
  const content = String(text || '').trim()
  if (!content) throw new Error('内容为空')

  // 优先 multipart（官方 UploadFile 列表）
  const form = new FormData()
  const blob = new Blob([content], { type: 'text/plain; charset=utf-8' })
  form.append('data', blob, `liangce-${Date.now()}.txt`)
  form.append('datasetName', name)
  try {
    return await cogneeFetch('/api/v1/add', {
      method: 'POST',
      body: form,
      signal
    })
  } catch (err) {
    // 回退 JSON
    return cogneeFetch('/api/v1/add', {
      method: 'POST',
      signal,
      body: { data: content, datasetName: name }
    })
  }
}

export async function cognifyCognee({ datasets, signal } = {}) {
  const { dataset } = getCogneeConfig()
  const ds = datasets == null || datasets === ''
    ? [dataset]
    : Array.isArray(datasets)
      ? datasets
      : [String(datasets)]
  return cogneeFetch('/api/v1/cognify', {
    method: 'POST',
    signal,
    body: { datasets: ds.filter(Boolean) }
  })
}
