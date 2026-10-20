export function formatSize(n) {
  const v = Number(n)
  if (!isFinite(v) || v < 0) return '-'
  if (v < 1024) return v + ' B'
  if (v < 1048576) return (v / 1024).toFixed(1) + ' KB'
  if (v < 1073741824) return (v / 1048576).toFixed(1) + ' MB'
  return (v / 1073741824).toFixed(2) + ' GB'
}
export function formatTime(t) {
  if (!t) return '-'
  const d = new Date(t)
  if (isNaN(d.getTime())) return String(t)
  const p = x => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
export function maskToken() {
  return '已隐藏'
}
// 递归掩码对象中疑似凭据的字段
export function maskSecrets(value) {
  if (Array.isArray(value)) return value.map(maskSecrets)
  if (value && typeof value === 'object') {
    const out = {}
    Object.keys(value).forEach(k => {
      out[k] = /token|secret|password|authorization|api[_-]?key/i.test(k) && typeof value[k] === 'string'
        ? maskToken(value[k]) : maskSecrets(value[k])
    })
    return out
  }
  return value
}
export function fileKind(file) {
  const name = String((file && (file.name || file.fileName)) || '').toLowerCase()
  const mime = String((file && (file.mime || file.mimeType)) || '').toLowerCase()
  if (mime.includes('pdf') || name.endsWith('.pdf')) return 'pdf'
  if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/.test(name)) return 'image'
  if (/sheet|excel|csv/.test(mime) || /\.(xlsx|xls|csv)$/.test(name)) return 'sheet'
  if (mime.includes('markdown') || /\.(md|markdown)$/.test(name) || String(file && file.ext).toLowerCase() === 'md') return 'markdown'
  if (mime.startsWith('text/') || /\.(txt|html?)$/.test(name)) return 'text'
  return 'other'
}
export function kbEnabled() {
  const runtime = typeof window !== 'undefined' && window.__MIND_MAP_RUNTIME__
  return !!(runtime && runtime.FILE_KB_ENABLED === true)
}
export function kbPageEnabled() {
  const runtime = typeof window !== 'undefined' && window.__MIND_MAP_RUNTIME__
  if (!runtime || runtime.FILE_KB_UI_ENABLED == null) return true
  return runtime.FILE_KB_UI_ENABLED === true
}

// 数据库 row_index 从 0 开始（Excel 行号减 1）。展示和跳转只用表格行号。
export function spreadsheetRow(rowIndex) {
  const n = Number(rowIndex)
  if (!Number.isInteger(n) || n < 0) return null
  return n + 1
}

function finiteNumber(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

// HTTP 列表里的 row 已是表格行号。row_index / rowIndex 一律加 1，不能直接当行号显示。
export function blockLocation(b) {
  const src = (b && (b.source || b.location || b.loc)) || {}
  const pick = k => (b && b[k] != null ? b[k] : src[k])
  const page = pick('page') != null ? Number(pick('page')) : pick('pageNo') != null ? Number(pick('pageNo')) : null
  const bbox = Array.isArray(pick('bbox')) && pick('bbox').length === 4 ? pick('bbox').map(Number) : null
  const sheet = pick('sheet') || null
  const indexed = pick('row_index') != null ? pick('row_index') : pick('rowIndex')
  const row = indexed != null ? spreadsheetRow(indexed) : finiteNumber(pick('row'))
  const col = pick('col') != null ? Number(pick('col')) : null
  const cell = pick('cell') || null
  const lineStart = finiteNumber(pick('lineStart'))
  const lineEnd = finiteNumber(pick('lineEnd'))
  const lines = Number.isInteger(lineStart) && lineStart > 0 && Number.isInteger(lineEnd) && lineEnd >= lineStart
  const precise = lines || !!bbox || (!!sheet && (row != null || !!cell))
  return { page, bbox, sheet, row, col, cell, lineStart: lines ? lineStart : null, lineEnd: lines ? lineEnd : null, precise, known: precise || page != null || !!sheet }
}

function presentSource(source) {
  if (!source || typeof source !== 'object') return source
  const out = { ...source }
  if (out.row_index != null) {
    out.row = spreadsheetRow(out.row_index)
    delete out.row_index
  } else if (out.row != null) out.row = spreadsheetRow(out.row)
  return out
}

function presentIndexedRecord(item) {
  if (!item || typeof item !== 'object') return item
  const out = { ...item }
  if (out.row_index != null) {
    out.row = spreadsheetRow(out.row_index)
    delete out.row_index
  } else if (out.row != null) out.row = spreadsheetRow(out.row)
  if (out.source) out.source = presentSource(out.source)
  return out
}

// query_knowledge_records / get_knowledge_source 的 row 是 row_index。调试器只展示表格行号。
export function presentToolResult(tool, value) {
  const masked = maskSecrets(value)
  if (tool === 'query_knowledge_records' && masked && Array.isArray(masked.items)) {
    return { ...masked, items: masked.items.map(presentIndexedRecord) }
  }
  if (tool === 'get_knowledge_source' && masked && typeof masked === 'object') {
    return { ...masked, source: presentSource(masked.source) }
  }
  return masked
}

export const READ_ONLY_TOOLS = new Set([
  'list_knowledge_files', 'search_knowledge', 'query_knowledge_records',
  'get_knowledge_document', 'get_knowledge_block', 'get_knowledge_source', 'get_knowledge_import_status'
])

export function prepareToolArguments(tool, args) {
  if (!READ_ONLY_TOOLS.has(tool)) {
    const err = new Error('只能调用已授权的只读工具')
    err.__kb = true
    throw err
  }
  const out = { ...(args || {}) }
  ;['userId', 'ownerId', 'actorId', 'subjectId', 'token', 'authorization'].forEach(k => { delete out[k] })
  if (tool === 'get_knowledge_source' && out.row != null && out.row !== '') {
    const n = Number(out.row)
    if (!Number.isInteger(n) || n < 1) {
      const err = new Error('表格行号从 1 开始')
      err.__kb = true
      throw err
    }
    out.row = n - 1
  }
  return out
}
function privateHost(host) {
  if (host.endsWith('.local') || host.endsWith('.lan')) return true
  const parts = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
  if (!parts) return false
  const a = Number(parts[1])
  const b = Number(parts[2])
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127
}

export function mcpEndpoint(loc) {
  const origin = String((loc && loc.origin) || '').replace(/\/$/, '')
  return origin + '/file-kb-mcp/mcp'
}

export function mcpAccessKind(loc) {
  const host = String((loc && loc.hostname) || '').toLowerCase().replace(/^\[|\]$/g, '')
  const protocol = String((loc && loc.protocol) || '')
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return 'local'
  if (privateHost(host)) return 'lan'
  if (protocol === 'https:') return 'public-https'
  return 'remote-http'
}

export function fileKbServerEntry(url, token) {
  const authorization = token ? 'Bearer ' + token : 'Bearer ${env:FILE_KB_MCP_TOKEN}'
  return {
    'file-kb': {
      type: 'http',
      url,
      disabled: false,
      headers: { Authorization: authorization }
    }
  }
}

// 「MCP 接入」页的文件知识库条目：与该页其它条目同格式（服务器名为键，无 mcpServers 根字段）。
// 有本页刚创建的令牌时写入真实 Bearer，可直接粘贴使用；没有时用环境变量占位（Cursor mcp.json 的 ${env:NAME} 语法）。
export const KB_TOKEN_ENV = 'FILE_KB_MCP_TOKEN'
export const KB_TOKEN_PLACEHOLDER = '${env:' + KB_TOKEN_ENV + '}'

export function fileKbAccessConfig(url, token) {
  return JSON.stringify(fileKbServerEntry(url, token), null, 2)
}

// GET /api/kb/mcp/tokens 的条目：未撤销、未过期、带 kb:read 才算可用（与 file-kb-mcp/src/auth.mjs 一致）。
export function usableKbTokenCount(items, now = Date.now()) {
  if (!Array.isArray(items)) return 0
  return items.filter(t => {
    if (!t || t.revokedAt) return false
    if (t.expiresAt) {
      const exp = new Date(t.expiresAt).getTime()
      if (!Number.isFinite(exp) || exp <= now) return false
    }
    return Array.isArray(t.scopes) && t.scopes.includes('kb:read')
  }).length
}

// 把 file-kb 并入「复制完整配置」：url 或令牌为空就原样返回；已有的键一律不覆盖。
export function withFileKbServer(servers, url, token) {
  if (!url || !token) return servers
  const out = { ...servers }
  const entry = fileKbServerEntry(url, token)
  Object.keys(entry).forEach(key => {
    if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = entry[key]
  })
  return out
}

export function cursorMcpConfig(url, token) {
  return JSON.stringify({ mcpServers: fileKbServerEntry(url, token) }, null, 2)
}

export function codexMcpConfig(url) {
  return [
    '[mcp_servers.file-kb]',
    'url = ' + JSON.stringify(url),
    'bearer_token_env_var = "FILE_KB_MCP_TOKEN"',
    'enabled = true'
  ].join('\n')
}

export function locationLabel(loc) {
  if (!loc || !loc.known) return '位置未知'
  if (loc.lineStart != null) return loc.lineStart === loc.lineEnd ? `第 ${loc.lineStart} 行` : `第 ${loc.lineStart}–${loc.lineEnd} 行`
  const parts = []
  if (loc.page != null) parts.push(`第 ${loc.page} 页`)
  if (loc.sheet) parts.push(`工作表「${loc.sheet}」`)
  if (loc.cell) parts.push(`单元格 ${loc.cell}`)
  else if (loc.row != null) parts.push(`第 ${loc.row} 行`)
  return parts.join(' · ')
}
