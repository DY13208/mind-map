'use strict'

function flag(value, fallback = false) {
  if (value == null || String(value).trim() === '') return fallback
  return /^(1|true|yes|on)$/i.test(String(value).trim())
}

function int(env, name, fallback, min, max) {
  const raw = env[name]
  const value = raw == null || raw === '' ? fallback : Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`)
  }
  return value
}

// Unset or empty string -> null (no limit / permanent).
function optInt(env, name, min, max) {
  const raw = env[name]
  if (raw == null || String(raw).trim() === '') return null
  return int(env, name, null, min, max)
}

const OCR_MODES = ['auto', 'off', 'always']

// docling OCR. KB_DOCLING_OCR_MODE wins; legacy KB_DOCLING_OCR=true/false maps to always/off; default auto
// (OCR re-run only for PDFs/images whose first pass looks scanned).
function doclingOcrConfig(env) {
  const rawMode = String(env.KB_DOCLING_OCR_MODE || '').trim().toLowerCase()
  const legacy = env.KB_DOCLING_OCR == null || String(env.KB_DOCLING_OCR).trim() === '' ? null : flag(env.KB_DOCLING_OCR)
  const mode = rawMode || (legacy === null ? 'auto' : legacy ? 'always' : 'off')
  if (!OCR_MODES.includes(mode)) throw new Error('KB_DOCLING_OCR_MODE must be auto, off or always')
  const engine = String(env.KB_DOCLING_OCR_ENGINE || '').trim() || 'rapidocr'
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(engine)) throw new Error('KB_DOCLING_OCR_ENGINE must be a docling-serve ocr_preset id')
  const lang = String(env.KB_DOCLING_OCR_LANG || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
  if (lang.length > 8 || lang.some(l => !/^[A-Za-z0-9:_-]{1,32}$/.test(l))) throw new Error('KB_DOCLING_OCR_LANG must be a comma-separated list of language tags')
  return {
    doclingOcr: mode === 'always',
    doclingOcrMode: mode,
    doclingOcrEngine: engine,
    doclingOcrLang: lang,
    doclingOcrForce: flag(env.KB_DOCLING_OCR_FORCE, true),
    doclingOcrMinCharsPerPage: int(env, 'KB_DOCLING_OCR_MIN_CHARS_PER_PAGE', 20, 0, 100000),
    doclingOcrTextlessPagePct: int(env, 'KB_DOCLING_OCR_TEXTLESS_PAGE_PCT', 60, 1, 100),
    doclingOcrMixedMinPages: int(env, 'KB_DOCLING_OCR_MIXED_MIN_PAGES', 1, 0, 100000),
    doclingOcrDocumentTimeoutS: int(env, 'KB_DOCLING_OCR_DOCUMENT_TIMEOUT_S', 1800, 60, 86400),
    doclingOcrTotalTimeoutMs: int(env, 'KB_DOCLING_OCR_TOTAL_TIMEOUT_MS', 60 * 60000, 10000, 6 * 3600000)
  }
}

function loadConfig(env = process.env) {
  const doclingUrl = String(env.DOCLING_URL || '').trim().replace(/\/+$/, '')
  if (doclingUrl && !/^https?:\/\//i.test(doclingUrl)) {
    throw new Error('DOCLING_URL must start with http:// or https://')
  }
  let formatConcurrency
  try { formatConcurrency=JSON.parse(env.KB_FORMAT_CONCURRENCY || '{}') } catch (_) { throw new Error('KB_FORMAT_CONCURRENCY must be JSON') }
  if(!formatConcurrency || Array.isArray(formatConcurrency) || typeof formatConcurrency!=='object' || Object.entries(formatConcurrency).some(([ext,n])=>!['pdf','docx','xlsx','pptx','md','txt','csv','png','jpg','jpeg','tif','tiff','bmp','webp','html','htm','xls'].includes(ext)||!Number.isInteger(n)||n<1||n>8))throw new Error('invalid KB_FORMAT_CONCURRENCY limits')
  return {
    enabled: flag(env.FILE_KB_ENABLED, false),
    host: env.FILE_KB_HOST || '0.0.0.0',
    port: int(env, 'FILE_KB_PORT', 18800, 1, 65535),
    migrateOnStart: flag(env.FILE_KB_MIGRATE_ON_START, true),
    db: {
      host: env.PGHOST || '127.0.0.1',
      port: int(env, 'PGPORT', 5432, 1, 65535),
      database: env.PGDATABASE || 'mind_map',
      user: env.PGUSER || 'kb_app',
      password: env.PGPASSWORD || '',
      max: int(env, 'FILE_KB_PG_POOL_MAX', 10, 1, 10),
      statementTimeoutMs: int(env, 'FILE_KB_STATEMENT_TIMEOUT_MS', 15000, 1000, 120000)
    },
    // Session cache is off unless explicitly set. Revocation is then immediate. Hard cap 30s.
    authCacheTtlMs: int(env, 'FILE_KB_AUTH_CACHE_TTL_MS', 0, 0, 30000),
    authCacheMax: int(env, 'FILE_KB_AUTH_CACHE_MAX', 5000, 0, 100000),
    // MCP tokens always expire: default lifetime and upper bound in days.
    mcpTokenDefaultTtlDays: optInt(env, 'FILE_KB_MCP_TOKEN_DEFAULT_TTL_DAYS', 1, 36500),
    mcpTokenMaxTtlDays: optInt(env, 'FILE_KB_MCP_TOKEN_MAX_TTL_DAYS', 1, 36500),
    superAdminIds: String(env.MIND_MAP_SUPER_ADMIN_IDS || '')
      .split(/[,\s]+/).map(s => s.trim()).filter(Boolean),
    trustedOrigins: String(env.FILE_KB_TRUSTED_ORIGINS || '')
      .split(',').map(s => s.trim()).filter(Boolean),
    doclingUrl,
    doclingHealthTimeoutMs: int(env, 'FILE_KB_DOCLING_HEALTH_TIMEOUT_MS', 2000, 100, 30000),
    doclingApiKey: env.DOCLING_API_KEY || '',
    ...doclingOcrConfig(env),
    doclingTotalTimeoutMs: int(env, 'KB_DOCLING_TOTAL_TIMEOUT_MS', 30 * 60000, 10000, 6 * 3600000),
    breakerThreshold: int(env, 'KB_BREAKER_THRESHOLD', 5, 1, 100),
    breakerOpenMs: int(env, 'KB_BREAKER_OPEN_MS', 60000, 1000, 3600000),
    storageRoot: env.KB_STORAGE_ROOT || '/data/kb',
    maxFileBytes: int(env, 'KB_MAX_FILE_BYTES', 100 * 1024 * 1024, 1024, 2 * 1024 * 1024 * 1024),
    maxBatchBytes: int(env, 'KB_MAX_BATCH_BYTES', 200 * 1024 * 1024, 1024, 4 * 1024 * 1024 * 1024),
    maxFilesPerBatch: int(env, 'KB_MAX_FILES_PER_BATCH', 50, 1, 500),
    maxQueuedPerUser: int(env, 'KB_MAX_QUEUED_PER_USER', 50, 1, 10000),
    uploadConcurrencyPerUser: int(env, 'KB_UPLOAD_CONCURRENCY_PER_USER', 4, 1, 100),
    uploadFilesPerMinute: int(env, 'KB_UPLOAD_FILES_PER_MINUTE', 120, 1, 100000),
    workerId: String(env.FILE_KB_WORKER_ID || `worker-${process.pid}`).slice(0, 80),
    concurrency: int(env, 'KB_WORKER_CONCURRENCY', 2, 1, 8),
    lightConcurrency: int(env, 'KB_LIGHT_CONCURRENCY', 2, 1, 8),
    heavyConcurrency: int(env, 'KB_HEAVY_CONCURRENCY', 1, 1, 4),
    nativeLightParse: flag(env.KB_NATIVE_LIGHT_PARSE, false),
    nativeLightMaxBytes: int(env,'KB_NATIVE_LIGHT_MAX_BYTES',2*1024*1024,1024,16*1024*1024),
    formatConcurrency,
    maxActiveJobs: int(env, 'KB_MAX_ACTIVE_JOBS', 500, 10, 10000),
    leaseMs: int(env, 'KB_LEASE_MS', 600000, 2000, 3600000),
    backoffBaseMs: int(env, 'KB_BACKOFF_BASE_MS', 5000, 10, 600000),
    pollMs: int(env, 'KB_POLL_MS', 1000, 50, 60000)
  }
}

module.exports = { loadConfig, flag }
