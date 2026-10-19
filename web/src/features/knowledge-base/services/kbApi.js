// 文件知识库 API 适配层：独立 axios 实例，所有请求走 /api/kb，携带会话 cookie。
// 接口对接状态见 ../CONTRACT.md。404 missing 是资源不存在或无权查看；501 not_implemented 是能力未实现。
import axios from 'axios'
import { normalizeKbError } from './kbErrors'

export const KB_BASE = '/api/kb'

const http = axios.create({
  baseURL: KB_BASE,
  withCredentials: true,
  timeout: 15000,
  headers: { 'X-Requested-With': 'XMLHttpRequest' }
})
http.interceptors.response.use(
  res => res.data,
  err => Promise.reject(normalizeKbError(err))
)

const enc = encodeURIComponent

export const DEFAULT_LIMIT = 50

// 列表统一为 { items, nextCursor, total }；total 可选（后端未给时为 null）。
// 兼容 {items,next_cursor,total} / {<key>:[...]} / 纯数组。
export function pickList(data, key) {
  if (Array.isArray(data)) return { items: data, nextCursor: null, total: null }
  const d = data || {}
  const items = d.items || (key && d[key]) || []
  const next = d.next_cursor != null ? d.next_cursor : d.nextCursor
  return { items, nextCursor: next || null, total: d.total != null ? Number(d.total) : null }
}

// 去掉空值，统一 snake_case 查询参数
function query(obj) {
  const out = {}
  Object.keys(obj).forEach(k => {
    const v = obj[k]
    if (v !== undefined && v !== null && v !== '') out[k] = v
  })
  return out
}

export default {
  http,
  health: () => http.get('/health'),

  // 文件夹
  // 懒加载：每次只取某个父文件夹的直接子级；parentId 为空表示根
  listFolders: ({ parentId, limit = 100, cursor } = {}) =>
    http.get('/folders', { params: query({ parent_id: parentId || 'root', limit, cursor }) }).then(d => pickList(d, 'folders')),
  createFolder: body => http.post('/folders', body),
  renameFolder: (id, name) => http.patch(`/folders/${enc(id)}`, { name }),
  deleteFolder: id => http.delete(`/folders/${enc(id)}`),

  // 文件
  // keyset 分页：limit + cursor；ids 用于只刷新可见的进行中行
  listFiles: ({ folderId, q, status, limit = DEFAULT_LIMIT, cursor, ids } = {}) =>
    http.get('/files', {
      params: query({ folder_id: folderId, q, status, limit, cursor, ids: ids && ids.length ? ids.join(',') : undefined })
    }).then(d => pickList(d, 'files')),
  getFile: id => http.get(`/files/${enc(id)}`),
  updateFile: (id, body) => http.patch(`/files/${enc(id)}`, body),
  deleteFile: id => http.delete(`/files/${enc(id)}`),
  reparseFile: id => http.post(`/files/${enc(id)}/reparse`),
  previewLayout: id => http.get(`/files/${enc(id)}/layout`),
  restructureFile: (id, body) => http.post(`/files/${enc(id)}/structure`, body),
  // 单文件上传。onProgress(percent, loaded, total)。batchId / clientKey 只有后端批次接口可用时才传（见 detectBatchSupport）。
  uploadFile(file, { folderId, onProgress, signal, batchId, clientKey } = {}) {
    const form = new FormData()
    if (folderId) form.append('folder_id', folderId)
    form.append('file', file, file.name)
    return http.post('/files', form, {
      timeout: 0,
      signal,
      params: query({ folder_id: folderId, batch_id: batchId, client_key: clientKey }),
      onUploadProgress: e => {
        const total = e.total || file.size || 0
        if (onProgress && total) onProgress(Math.round((e.loaded / total) * 100), e.loaded, total)
      }
    })
  },
  // 上传限制：后端目前没有暴露运行时上限（config.js 中 KB_MAX_FILE_BYTES 缺省 100 MiB）。
  // 若 /health 将来带 limits 字段则使用它，否则返回 null，由调用方回退到 100 MiB。见 CONTRACT.md「待后端支持」。
  async getUploadLimits() {
    try {
      const h = await http.get('/health')
      const l = h && (h.limits || h.uploadLimits)
      if (!l) return null
      const num = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null)
      return {
        maxFileBytes: num(l.maxFileBytes),
        maxBatchBytes: num(l.maxBatchBytes),
        maxFilesPerBatch: num(l.maxFilesPerBatch),
        uploadConcurrencyPerUser: num(l.uploadConcurrencyPerUser),
        allowedExtensions: Array.isArray(l.allowedExtensions) ? l.allowedExtensions.map(String) : null
      }
    } catch (_) {
      return null
    }
  },
  getBlocks: (id, { limit = 200, cursor } = {}) =>
    http.get(`/files/${enc(id)}/blocks`, { params: query({ limit, cursor }) }).then(d => pickList(d, 'blocks')),
  rawUrl: id => `${KB_BASE}/files/${enc(id)}/raw`,
  getRaw: id => http.get(`/files/${enc(id)}/raw`, { responseType: 'arraybuffer', timeout: 60000 }),

  // 结构化数据
  listFields: ({ fileId } = {}) => http.get('/fields', { params: query({ file_id: fileId }) }).then(d => pickList(d, 'fields')),
  listRecords: ({ fileId, limit = DEFAULT_LIMIT, cursor } = {}, filters) =>
    http.get('/records', {
      params: query({ file_id: fileId, limit, cursor, filters: filters && filters.length ? JSON.stringify(filters) : undefined })
    }).then(d => pickList(d, 'records')),

  // 检索
  search: ({ q, mode, folderId, limit = 20, cursor } = {}) =>
    http.get('/search', { params: query({ q, mode, folder_id: folderId, limit, cursor }) }).then(d => pickList(d, 'results')),

  // MCP
  mcpStatus: () => http.get('/mcp/status'),
  mcpTools: () => http.get('/mcp/tools').then(d => pickList(d, 'tools')),
  mcpCall: (tool, args) => http.post('/mcp/call', { tool, arguments: args || {} }, { timeout: 30000 }),
  listMcpTokens: () => http.get('/mcp/tokens').then(d => pickList(d, 'tokens')),
  createMcpToken: body => http.post('/mcp/tokens', body),
  revokeMcpToken: id => http.delete(`/mcp/tokens/${enc(id)}`),

  // 吉客云数据源：Key 只在服务端 .env，这里只拿脱敏状态
  geekcloudStatus: () => http.get('/geekcloud/status'),
  geekcloudCheck: () => http.post('/geekcloud/check', {}, { timeout: 30000 }),
  geekcloudCalls: () => http.get('/geekcloud/calls').then(d => pickList(d, 'items')),
  smartQuery: body => http.post('/smart-query', body, { timeout: 60000 }),

  // 批次（后端 services/file-kb/src/batches.js，契约 docs/file-kb/BATCH_API_V2.md）。
  // 探测：GET /batches/<全零 uuid>。路由存在时后端返回 404 missing；路由不存在时为 404 not_found（not_ready）。
  async detectBatchSupport() {
    try {
      await http.get('/batches/00000000-0000-0000-0000-000000000000')
      return { supported: true }
    } catch (e) {
      if (e.kind === 'not_found') return { supported: true }
      if (e.code === 'batch_scope_unsupported') return { supported: true, restricted: true, reason: '当前凭据不能管理批次' }
      return { supported: false, reason: e.kind === 'not_ready' ? '后端未提供批次接口' : e.message }
    }
  },
  createBatch: ({ name, expectedCount }) => http.post('/batches', { name, expectedCount }),
  // 列表按 id 游标分页（后端 order by id），不是按时间；页面按 createdAt 排已加载的项
  listBatches: ({ cursor, limit = 25 } = {}) => http.get('/batches', { params: query({ cursor, limit }) }).then(d => pickList(d, 'items')),
  getBatch: id => http.get(`/batches/${enc(id)}`),
  listBatchItems: (id, { cursor, limit = 50 } = {}) =>
    http.get(`/batches/${enc(id)}/items`, { params: query({ cursor, limit }) }).then(d => pickList(d, 'items')),
  batchAction: (id, action) => http.post(`/batches/${enc(id)}/${enc(action)}`, {}),

  // 权限：type = file | folder
  getAcl: (type, id) => http.get(`/acl/${enc(type)}/${enc(id)}`),
  putGrant: (type, id, grant) => http.put(`/acl/${enc(type)}/${enc(id)}`, grant),
  deleteGrant: (type, id, grant) => http.delete(`/acl/${enc(type)}/${enc(id)}`, { data: grant }),
  transferOwner: (type, id, body) => http.post(`/acl/${enc(type)}/${enc(id)}/transfer`, body)
}
