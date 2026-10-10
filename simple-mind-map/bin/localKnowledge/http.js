const { readBody, sendJson, safeRoomKey, getPool } = require('../storage')
const roomAcl = require('../roomAcl')
const { createService } = require('./service')
const { checkTools } = require('./extract')
let service
async function handleApi(req, res, pathname, options = {}) {
  if (
    ![
      '/api/local-knowledge/fill',
      '/api/local-knowledge/refresh',
      '/api/local-knowledge/status'
    ].includes(pathname)
  )
    return false
  const acl = options.acl || roomAcl
  try {
    if (req.method !== (pathname.endsWith('/status') ? 'GET' : 'POST')) {
      sendJson(res, 405, { error: 'method_not_allowed' })
      return true
    }
    if (!req.authUser) {
      sendJson(res, 401, {
        error: '请先登录后使用资料补齐',
        code: 'LOCAL_LOGIN_REQUIRED'
      })
      return true
    }
    if (req.authUser.service) {
      sendJson(res, 403, {
        error: '资料补齐仅供已登录的用户账号使用',
        code: 'LOCAL_USER_REQUIRED'
      })
      return true
    }
    service ||= createService()
    if (pathname.endsWith('/status')) {
      let displayNames = {}
      try {
        displayNames = JSON.parse(
          process.env.LOCAL_KNOWLEDGE_SHAREHOLDER_NAMES || '{}'
        )
      } catch {}
      sendJson(res, 200, {
        ...((options.service || service).status() || { state: 'disabled' }),
        displayNames
      })
      return true
    }
    const body = await readBody(req, { maxBytes: 65536 })
    if (
      typeof body.roomId !== 'string' ||
      !body.roomId ||
      !Array.isArray(body.titles) ||
      !body.titles.length ||
      body.titles.length > 100 ||
      body.titles.some(t => typeof t !== 'string' || t.length > 1000) ||
      (body.existingTexts != null &&
        (!Array.isArray(body.existingTexts) ||
          body.existingTexts.length > 2000 ||
          body.existingTexts.some(t => typeof t !== 'string'))) ||
      (body.selectedCandidateIds != null && (!Array.isArray(body.selectedCandidateIds) || !body.selectedCandidateIds.length || body.selectedCandidateIds.length > 100 || body.selectedCandidateIds.some(id => typeof id !== 'string' || !/^[0-9]{1,4}$/.test(id)) || body.mode !== 'commit' || !body.revision)) ||
      (body.mode != null && !['preview', 'commit'].includes(body.mode)) ||
      (body.revision != null &&
        (typeof body.revision !== 'string' ||
          !/^[a-f0-9]{64}$/.test(body.revision))) ||
      Object.keys(body).some(
        key =>
          !['roomId', 'titles', 'existingTexts', 'mode', 'revision', 'selectedCandidateIds'].includes(
            key
          )
      )
    ) {
      sendJson(res, 400, {
        error: '无效的脑图或节点参数',
        code: 'INVALID_REQUEST'
      })
      return true
    }
    await acl.assertRoomAccess(
      options.db || getPool(),
      req,
      safeRoomKey(body.roomId),
      'edit'
    )
    if (pathname.endsWith('/refresh')) {
      sendJson(res, 200, await (options.service || service).refresh())
      return true
    }
    const controller = new AbortController()
    const onClose = () => {
      if (!res.writableEnded) controller.abort()
    }
    res.on('close', onClose)
    const timer = setTimeout(() => controller.abort(), 600000)
    const write = data => {
      if (!res.destroyed) res.write(JSON.stringify(data) + '\n')
    }
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no'
    })
    try {
      service ||= createService()
      const result = await (options.service || service).fill(body, {
        signal: controller.signal,
        onStatus: status => write({ status })
      })
      write({ result })
    } catch (error) {
      write({
        error:
          error.name === 'AbortError'
            ? '本地资料读取已取消或超时'
            : '本地资料读取失败',
        code: error.code || 'LOCAL_READ_FAILED'
      })
    } finally {
      clearTimeout(timer)
      res.off('close', onClose)
      res.end()
    }
  } catch (error) {
    if (!res.headersSent)
      sendJson(res, error.statusCode || 400, {
        error: error.message,
        code: error.code || 'LOCAL_READ_FAILED'
      })
  }
  return true
}
async function checkConfiguration() {
  if (!process.env.LOCAL_KNOWLEDGE_ROOT && !process.env.LOCAL_KNOWLEDGE_ROOTS) return
  service ||= createService()
  service
    .start()
    .catch(error =>
      console.warn('[local-knowledge] index startup:', error.message)
    )
  const tools = await checkTools()
  console.log('[local-knowledge] extraction provider:', tools)
  if (!tools.configured)
    console.warn(
      '[local-knowledge] MinerU Token missing; readable text sources remain available'
    )
}
module.exports = { handleApi, checkConfiguration }
