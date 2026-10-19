const http = require('http')
const fs = require('fs')
const path = require('path')
const { resolveUser, httpError } = require('../auth')
const service = require('../service')
const acl = require('../acl')

function sendJson(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store'
  })
  res.end(data)
}

function readBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > maxBytes) {
        reject(httpError(413, 'PAYLOAD_TOO_LARGE', '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function readFilePart(buffer, contentType) {
  const match = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;]+))/i)
  if (!match) throw httpError(400, 'INVALID_MULTIPART', '需要 multipart/form-data')
  const boundary = `--${(match[1] || match[2] || '').trim()}`
  const delim = Buffer.from(boundary)
  let cursor = buffer.indexOf(delim)
  while (cursor !== -1) {
    const next = buffer.indexOf(delim, cursor + delim.length)
    if (next < 0) break
    let chunk = buffer.subarray(cursor + delim.length, next)
    if (chunk.subarray(0, 2).equals(Buffer.from('\r\n'))) chunk = chunk.subarray(2)
    if (chunk.length >= 2 && chunk.subarray(chunk.length - 2).equals(Buffer.from('\r\n'))) {
      chunk = chunk.subarray(0, chunk.length - 2)
    }
    const split = chunk.indexOf(Buffer.from('\r\n\r\n'))
    if (split >= 0) {
      const head = chunk.subarray(0, split).toString('utf8')
      if (/name="file"/i.test(head)) {
        const name = head.match(/filename="([^"]*)"/i)
        const mime = head.match(/content-type:\s*([^\r\n]+)/i)
        return {
          fileName: path.basename(name ? name[1] : 'upload.bin'),
          mimeType: mime ? mime[1].trim() : 'application/octet-stream',
          bytes: chunk.subarray(split + 4)
        }
      }
    }
    cursor = next
  }
  throw httpError(400, 'FILE_REQUIRED', '请在 file 字段上传一个文件')
}

function pageOptions(url, config) {
  const limit = Number(url.searchParams.get('limit') || config.pageSize)
  const offset = Number(url.searchParams.get('offset') || 0)
  if (!Number.isInteger(limit) || limit < 1 || limit > config.maxPageSize) {
    throw httpError(400, 'INVALID_PAGE', 'limit 超出范围')
  }
  if (!Number.isInteger(offset) || offset < 0) throw httpError(400, 'INVALID_PAGE', 'offset 无效')
  return { limit, offset, maxPageSize: config.maxPageSize, maxResponseBytes: config.maxResponseBytes }
}

async function readJson(req, maxBytes) {
  const raw = await readBuffer(req, maxBytes)
  if (!raw.length) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch (err) {
    throw httpError(400, 'INVALID_JSON', '请求体不是 JSON')
  }
}

function createApiServer(options) {
  const { pool, storage, config } = options
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (req.method === 'GET' && url.pathname === '/health') {
        let db = false
        try {
          await pool.query('select 1')
          db = true
        } catch (err) {
          db = false
        }
        sendJson(res, 200, { ok: true, service: 'file-knowledge', db, docling: Boolean(config.doclingUrl) })
        return
      }
      if (req.method === 'GET' && url.pathname.startsWith('/vendor/')) {
        const relative = url.pathname.slice('/vendor/'.length)
        const root = path.join(__dirname, '..', '..', 'node_modules')
        const mapped = {
          'vue.js': path.join(root, 'vue', 'dist', 'vue.js'),
          'element.js': path.join(root, 'element-ui', 'lib', 'index.js'),
          'theme-chalk/index.css': path.join(root, 'element-ui', 'lib', 'theme-chalk', 'index.css')
        }
        const file = mapped[relative] || (
          relative.startsWith('theme-chalk/fonts/')
            ? path.join(root, 'element-ui', 'lib', 'theme-chalk', 'fonts', path.basename(relative))
            : ''
        )
        if (!file || !fs.existsSync(file)) {
          sendJson(res, 404, { ok: false, error: '前端资源未安装' })
          return
        }
        const type = file.endsWith('.css')
          ? 'text/css'
          : file.endsWith('.js')
            ? 'text/javascript'
            : 'font/woff'
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' })
        fs.createReadStream(file).pipe(res)
        return
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'))
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
        return
      }
      const user = await resolveUser(pool, req, config)
      if (req.method === 'POST' && url.pathname === '/api/files') {
        const body = await readBuffer(req, config.maxBytes + 64 * 1024)
        const file = readFilePart(body, req.headers['content-type'])
        file.folderId = url.searchParams.get('folderId') || null
        const saved = await service.uploadFile(pool, storage, config, user, file)
        sendJson(res, saved.duplicate ? 200 : 201, saved)
        return
      }
      const versionMatch = url.pathname.match(/^\/api\/files\/([^/]+)\/versions$/)
      if (req.method === 'POST' && versionMatch) {
        const body = await readBuffer(req, config.maxBytes + 64 * 1024)
        const file = readFilePart(body, req.headers['content-type'])
        const saved = await service.uploadFile(pool, storage, config, user, {
          ...file,
          fileId: decodeURIComponent(versionMatch[1])
        })
        sendJson(res, 201, saved)
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/files') {
        sendJson(res, 200, await service.listFiles(pool, user, pageOptions(url, config)))
        return
      }
      const statusMatch = url.pathname.match(/^\/api\/files\/([^/]+)\/status$/)
      if (req.method === 'GET' && statusMatch) {
        sendJson(res, 200, await service.fileStatus(pool, user, decodeURIComponent(statusMatch[1])))
        return
      }
      const grantMatch = url.pathname.match(/^\/api\/files\/([^/]+)\/grants$/)
      if (req.method === 'POST' && grantMatch) {
        const body = await readJson(req, 16 * 1024)
        sendJson(res, 200, await service.grantReader(pool, user, decodeURIComponent(grantMatch[1]), body.userId))
        return
      }
      const fileMatch = url.pathname.match(/^\/api\/files\/([^/]+)$/)
      if (req.method === 'GET' && fileMatch) {
        sendJson(res, 200, await service.fileStatus(pool, user, decodeURIComponent(fileMatch[1])))
        return
      }
      const docMatch = url.pathname.match(/^\/api\/documents\/([^/]+)$/)
      if (req.method === 'GET' && docMatch) {
        sendJson(res, 200, await service.getDocument(pool, user, decodeURIComponent(docMatch[1]), pageOptions(url, config)))
        return
      }
      const sourceMatch = url.pathname.match(/^\/api\/blocks\/([^/]+)\/source$/)
      if (req.method === 'GET' && sourceMatch) {
        sendJson(res, 200, await service.getSource(pool, user, decodeURIComponent(sourceMatch[1])))
        return
      }
      const blockMatch = url.pathname.match(/^\/api\/blocks\/([^/]+)$/)
      if (req.method === 'GET' && blockMatch) {
        sendJson(res, 200, await service.getBlock(pool, user, decodeURIComponent(blockMatch[1]), {
          maxResponseBytes: config.maxResponseBytes
        }))
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/search') {
        const body = await readJson(req, 16 * 1024)
        sendJson(res, 200, await service.searchKnowledge(pool, user, {
          query: body.query,
          limit: body.limit,
          offset: body.offset,
          maxPageSize: config.maxPageSize
        }))
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/records/query') {
        const body = await readJson(req, 16 * 1024)
        const filters = body.filters || {
          kind: body.kind,
          text: body.text,
          page: body.page,
          label: body.label
        }
        sendJson(res, 200, await service.queryRecords(pool, user, {
          filters,
          limit: body.limit,
          offset: body.offset,
          maxPageSize: config.maxPageSize
        }))
        return
      }
      const contentMatch = url.pathname.match(/^\/api\/files\/([^/]+)\/content$/)
      if (req.method === 'GET' && contentMatch) {
        const file = await service.readContent(pool, storage, user, decodeURIComponent(contentMatch[1]))
        const disposition = url.searchParams.get('disposition') === 'inline' ? 'inline' : 'attachment'
        res.writeHead(200, {
          'Content-Type': file.mimeType,
          'Content-Length': file.bytes.length,
          'Cache-Control': 'private, no-store',
          'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(file.fileName)}`
        })
        res.end(file.bytes)
        return
      }
      const reparseMatch = url.pathname.match(/^\/api\/files\/([^/]+)\/reparse$/)
      if (req.method === 'POST' && reparseMatch) {
        sendJson(res, 200, await service.reparseFile(pool, user, decodeURIComponent(reparseMatch[1])))
        return
      }
      const fileAccessMatch = url.pathname.match(/^\/api\/files\/([^/]+)\/access$/)
      if (fileAccessMatch) {
        const id = decodeURIComponent(fileAccessMatch[1])
        if (req.method === 'GET') {
          sendJson(res, 200, await acl.describeAccess(pool, user, 'file', id))
          return
        }
        if (req.method === 'PUT') {
          const body = await readJson(req, 16 * 1024)
          if (body.inherit != null) {
            sendJson(res, 200, await acl.setInherit(pool, user, 'file', id, body.inherit))
            return
          }
          if (body.ownerUserId) {
            sendJson(res, 200, await acl.transferOwner(pool, user, 'file', id, body.ownerUserId))
            return
          }
          sendJson(res, 200, await acl.setGrant(pool, user, 'file', id, body))
          return
        }
      }
      const deleteMatch = url.pathname.match(/^\/api\/files\/([^/]+)$/)
      if (req.method === 'DELETE' && deleteMatch) {
        sendJson(res, 200, await service.deleteFile(pool, storage, user, decodeURIComponent(deleteMatch[1])))
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/folders') {
        sendJson(res, 200, await acl.listFolders(pool, user))
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/folders') {
        const body = await readJson(req, 16 * 1024)
        sendJson(res, 201, await acl.createFolder(pool, user, body))
        return
      }
      const folderAccessMatch = url.pathname.match(/^\/api\/folders\/([^/]+)\/access$/)
      if (folderAccessMatch) {
        const id = decodeURIComponent(folderAccessMatch[1])
        if (req.method === 'GET') {
          sendJson(res, 200, await acl.describeAccess(pool, user, 'folder', id))
          return
        }
        if (req.method === 'PUT') {
          const body = await readJson(req, 16 * 1024)
          if (body.inherit != null && !body.subjectId) {
            sendJson(res, 200, await acl.setInherit(pool, user, 'folder', id, body.inherit))
            return
          }
          if (body.ownerUserId) {
            sendJson(res, 200, await acl.transferOwner(pool, user, 'folder', id, body.ownerUserId))
            return
          }
          sendJson(res, 200, await acl.setGrant(pool, user, 'folder', id, body))
          return
        }
      }
      const folderMatch = url.pathname.match(/^\/api\/folders\/([^/]+)$/)
      if (req.method === 'DELETE' && folderMatch) {
        sendJson(res, 200, await acl.deleteFolder(pool, user, decodeURIComponent(folderMatch[1])))
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/teams') {
        const body = await readJson(req, 16 * 1024)
        sendJson(res, 201, await acl.createTeam(pool, user, body.name))
        return
      }
      const teamMemberMatch = url.pathname.match(/^\/api\/teams\/([^/]+)\/members\/([^/]+)$/)
      if (req.method === 'DELETE' && teamMemberMatch) {
        sendJson(res, 200, await acl.removeTeamMember(
          pool, user, decodeURIComponent(teamMemberMatch[1]), decodeURIComponent(teamMemberMatch[2])
        ))
        return
      }
      const teamMembersMatch = url.pathname.match(/^\/api\/teams\/([^/]+)\/members$/)
      if (req.method === 'POST' && teamMembersMatch) {
        const body = await readJson(req, 16 * 1024)
        sendJson(res, 200, await acl.addTeamMember(pool, user, decodeURIComponent(teamMembersMatch[1]), body.userId))
        return
      }
      const tokenMatch = url.pathname.match(/^\/api\/tokens\/([^/]+)$/)
      if (req.method === 'DELETE' && tokenMatch) {
        sendJson(res, 200, await service.revokeToken(pool, user, decodeURIComponent(tokenMatch[1])))
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/tokens') {
        const body = await readJson(req, 8 * 1024)
        sendJson(res, 201, await service.issueToken(pool, user, body.label, body.scopeFolderIds))
        return
      }
      sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: '没有这个接口' })
    } catch (err) {
      const status = err.statusCode || 500
      if (status >= 500) console.error('[file-knowledge] API 错误:', err.message)
      sendJson(res, status, { ok: false, code: err.code || 'ERROR', error: err.message || '内部错误' })
    }
  })
}

module.exports = { createApiServer, readFilePart }
