const path = require('path')

const RESERVED_PORTS = new Set([
  80, 443, 3000, 3456, 3847, 5432, 6379, 8080, 8989, 1234, 15432, 16379, 18792
])

function integer(name, fallback, min, max) {
  const raw = process.env[name]
  const value = raw == null || raw === '' ? fallback : Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 的整数`)
  }
  return value
}

function port(name, fallback) {
  const value = integer(name, fallback, 1, 65535)
  if (RESERVED_PORTS.has(value)) {
    throw new Error(`${name}=${value} 与现有脑图、数据库或 Wiki MCP 端口冲突`)
  }
  return value
}

function connectionString() {
  if (process.env.KNOWLEDGE_DATABASE_URL) return process.env.KNOWLEDGE_DATABASE_URL
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const host = process.env.PGHOST
  const database = process.env.PGDATABASE
  const user = process.env.PGUSER
  if (!host || !database || !user) return ''
  const password = process.env.PGPASSWORD || ''
  const portNumber = process.env.PGPORT || '5432'
  const userInfo = password
    ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}`
    : encodeURIComponent(user)
  return `postgres://${userInfo}@${host}:${portNumber}/${database}`
}

function loadConfig(env = process.env) {
  const previous = process.env
  process.env = env
  try {
    const dataDir = path.resolve(
      env.KNOWLEDGE_DATA_DIR || path.join(__dirname, '..', 'data')
    )
    const apiPort = port('KNOWLEDGE_API_PORT', 3920)
    const mcpPort = port('KNOWLEDGE_MCP_PORT', 3921)
    if (apiPort === mcpPort) throw new Error('知识库 API 与 MCP 不能使用同一个端口')
    return {
      bind: env.KNOWLEDGE_BIND || '127.0.0.1',
      apiPort,
      mcpPort,
      databaseUrl: connectionString(),
      poolMax: integer('KNOWLEDGE_PG_POOL', 2, 1, 8),
      parseConcurrency: integer('KNOWLEDGE_PARSE_CONCURRENCY', 1, 1, 2),
      parseTimeoutMs: integer('KNOWLEDGE_PARSE_TIMEOUT_MS', 120000, 1000, 600000),
      maxBytes: integer('KNOWLEDGE_MAX_BYTES', 32 * 1024 * 1024, 1024, 64 * 1024 * 1024),
      maxResponseBytes: integer('KNOWLEDGE_MAX_RESPONSE_BYTES', 20 * 1024, 1024, 64 * 1024),
      pageSize: integer('KNOWLEDGE_PAGE_SIZE', 20, 1, 100),
      maxPageSize: integer('KNOWLEDGE_MAX_PAGE_SIZE', 100, 1, 200),
      dataDir,
      objectPrefix: 'knowledge-library',
      doclingUrl: String(env.DOCLING_SERVE_URL || '').trim().replace(/\/$/, ''),
      doclingOcr: /^(1|true|yes)$/i.test(String(env.DOCLING_OCR || '')),
      devUserHeader: /^(1|true|yes)$/i.test(String(env.KNOWLEDGE_DEV_USER_HEADER || '')),
      workerId: String(env.KNOWLEDGE_WORKER_ID || `worker-${process.pid}`).slice(0, 80)
    }
  } finally {
    process.env = previous
  }
}

module.exports = { loadConfig, RESERVED_PORTS }
