const fs = require('fs')
const os = require('os')
const path = require('path')
const { Server } = require('@tus/server')
const { FileStore } = require('@tus/file-store')
const { safeRoomKey, sendJson, getPool } = require('../storage')
const roomAcl = require('../roomAcl')
const store = require('./store')
const {
  MAX_BYTES,
  TUS_PATH,
  isAllowedFile,
  normalizeMime,
  safeFileName
} = require('./limits')

const TUS_DIR = String(
  process.env.NODE_KNOWLEDGE_TUS_DIR || path.join(os.tmpdir(), 'mind-map-tus')
).replace(/[/\\]+$/, '')

let tusServer = null

function matchTus(pathname) {
  const m = String(pathname || '').match(
    /^\/api\/attachments\/resumable(?:\/([^/]+))?(?:\/(result))?$/
  )
  if (!m) return null
  return {
    id: m[1] ? decodeURIComponent(m[1]) : '',
    result: m[2] === 'result'
  }
}

function isTusPath(pathname) {
  return /^\/api\/attachments\/resumable(?:\/|$)/.test(String(pathname || ''))
}

function resultPath(uploadId) {
  return path.join(TUS_DIR, `${uploadId}.attachment.json`)
}

function tusFilePath(upload) {
  if (upload && upload.storage && upload.storage.path) return upload.storage.path
  return path.join(TUS_DIR, upload && upload.id)
}

function meta(upload, key, fallback = '') {
  const data = (upload && upload.metadata) || {}
  return String(data[key] || data[key.toLowerCase()] || fallback)
}

function tusError(status, message) {
  const err = new Error(message)
  err.status_code = status
  err.body = message
  return err
}

function nodeReq(req) {
  return (req && req.runtime && req.runtime.node && req.runtime.node.req) || req
}

async function writeResult(uploadId, attachment) {
  await fs.promises.mkdir(TUS_DIR, { recursive: true })
  await fs.promises.writeFile(
    resultPath(uploadId),
    JSON.stringify(attachment || {}),
    'utf8'
  )
}

async function readResult(uploadId) {
  try {
    const raw = await fs.promises.readFile(resultPath(uploadId), 'utf8')
    return JSON.parse(raw)
  } catch (err) {
    return null
  }
}

async function ingestFinishedUpload(req, upload) {
  const node = nodeReq(req)
  const roomKey = safeRoomKey(meta(upload, 'roomKey'))
  const fileName = safeFileName(meta(upload, 'filename') || meta(upload, 'fileName') || 'file')
  const mimeType = normalizeMime(
    meta(upload, 'filetype') || meta(upload, 'mimeType'),
    fileName
  )
  const saved = await store.createFromBuffer(optionsDb(node), {
    roomKey,
    filePath: tusFilePath(upload),
    fileName,
    mimeType,
    nodeUid: meta(upload, 'nodeUid'),
    sourceKind: meta(upload, 'sourceKind') || 'attachment',
    createdBy: (node.authUser && node.authUser.id) || '',
    forceExtract: /^(1|true|yes)$/i.test(meta(upload, 'forceExtract')),
    cleanupFile: false
  })
  await writeResult(upload.id, saved)
  return saved
}

function optionsDb(req) {
  return (req && req._nodeKnowledgeDb) || getPool()
}

function getTusServer() {
  if (tusServer) return tusServer
  fs.mkdirSync(TUS_DIR, { recursive: true })
  const datastore = new FileStore({
    directory: TUS_DIR,
    expirationPeriodInMilliseconds: 24 * 60 * 60 * 1000
  })
  tusServer = new Server({
    path: TUS_PATH,
    datastore,
    maxSize: MAX_BYTES,
    relativeLocation: true,
    respectForwardedHeaders: true,
    allowedCredentials: true,
    disableTerminationForFinishedUploads: true,
    allowedHeaders: [
      'Authorization',
      'x-client-id',
      'X-Mind-Attachment-Id'
    ],
    onIncomingRequest: async (req, res, id) => {
      const node = nodeReq(req)
      if (!node || node.method === 'OPTIONS' || node.method === 'POST') return
      if (!id) return
      const upload = await datastore.getUpload(id).catch(() => null)
      if (!upload) return
      const roomKey = meta(upload, 'roomKey')
      if (!roomKey) throw tusError(400, '缺少房间')
      await roomAcl.assertRoomAccess(
        optionsDb(node),
        node,
        safeRoomKey(roomKey),
        'edit'
      )
    },
    onUploadCreate: async (req, res, upload) => {
      const node = nodeReq(req)
      const roomKey = meta(upload, 'roomKey')
      const fileName = safeFileName(
        meta(upload, 'filename') || meta(upload, 'fileName') || 'file'
      )
      const mimeType = normalizeMime(
        meta(upload, 'filetype') || meta(upload, 'mimeType'),
        fileName
      )
      if (!roomKey) throw tusError(400, '缺少房间')
      if (upload.size && upload.size > MAX_BYTES) {
        throw tusError(413, `文件过大（最多 ${MAX_BYTES} 字节）`)
      }
      if (!isAllowedFile(fileName, mimeType)) {
        throw tusError(415, `不支持的文件类型：${fileName}`)
      }
      await roomAcl.assertRoomAccess(
        optionsDb(node),
        node,
        safeRoomKey(roomKey),
        'edit'
      )
      return { res }
    },
    onUploadFinish: async (req, res, upload) => {
      const saved = await ingestFinishedUpload(req, upload)
      const exposed = String(res.getHeader('Access-Control-Expose-Headers') || '')
      if (!/X-Mind-Attachment-Id/i.test(exposed)) {
        res.setHeader(
          'Access-Control-Expose-Headers',
          exposed ? `${exposed}, X-Mind-Attachment-Id` : 'X-Mind-Attachment-Id'
        )
      }
      return {
        res,
        headers: {
          'X-Mind-Attachment-Id': saved.id || ''
        }
      }
    },
    onResponseError: async (req, res, error) => {
      if (!error) return
      if (error.status_code) return
      if (error.statusCode) {
        return {
          status_code: error.statusCode,
          body: error.message || 'upload error'
        }
      }
    }
  })
  return tusServer
}

async function handleTus(req, res, options = {}) {
  const pathname =
    options.pathname || String((req.url || '').split('?')[0] || '')
  const hit = options.hit || matchTus(pathname)
  if (!hit) return false

  if (hit.result) {
    if (req.method !== 'GET') {
      sendJson(res, 405, {
        ok: false,
        error: 'method not allowed',
        code: 'METHOD_NOT_ALLOWED'
      })
      return true
    }
    if (!hit.id) {
      sendJson(res, 404, { ok: false, error: '附件不存在', code: 'NOT_FOUND' })
      return true
    }
    const db = options.db || getPool()
    const attachment = await readResult(hit.id)
    if (!attachment || !attachment.id) {
      sendJson(res, 404, {
        ok: false,
        error: '续传记录不存在或已过期，请重新上传',
        code: 'NOT_FOUND'
      })
      return true
    }
    await roomAcl.assertRoomAccess(
      db,
      req,
      safeRoomKey(attachment.roomKey),
      'view'
    )
    sendJson(res, 200, { ok: true, attachment })
    return true
  }

  req._nodeKnowledgeDb = options.db || getPool()
  await getTusServer().handle(req, res)
  return true
}

module.exports = {
  TUS_PATH,
  TUS_DIR,
  matchTus,
  isTusPath,
  handleTus,
  getTusServer,
  resultPath
}
