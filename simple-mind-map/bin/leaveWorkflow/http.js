const service = require('./service')
const workers = new WeakMap()
function startWorker(pool, writer) {
  if (workers.has(pool)) return workers.get(pool)
  let busy = false
  const run = async () => {
    if (busy) return
    busy = true
    try {
      await service.project(pool, writer)
    } catch (_) {
      /* retry from durable projection flag */
    } finally {
      busy = false
    }
  }
  const timer = setInterval(run, 15000)
  timer.unref()
  workers.set(pool, run)
  return run
}
async function handle(req, res, { url, db, writer, readBody, sendJson }) {
  if (!/^\/api\/(?:leave|workflow)-/.test(url.pathname)) return false
  const run = startWorker(db, writer)
  try {
    const genericEntry = url.pathname.startsWith('/api/workflow-')
    const path = url.pathname.replace('/api/workflow-', '/api/leave-')
    const source =
      url.searchParams.get('source_room') && url.searchParams.get('source_node')
        ? {
            roomKey: url.searchParams.get('source_room'),
            nodeUid: url.searchParams.get('source_node')
          }
        : undefined
    let result
    if (genericEntry) await service.identity(db, req)
    if (
      genericEntry &&
      path === '/api/leave-template' &&
      req.method === 'GET' &&
      !source
    )
      throw Object.assign(
        new Error('请指定审批模板来源，通用入口不会默认选择请假'),
        { code: 'SOURCE_REQUIRED', statusCode: 400 }
      )
    if (path === '/api/leave-definitions' && req.method === 'GET')
      result = await service.definitions(db,req,url.searchParams.get('room_key'),url.searchParams.get('cursor') || '')
    else if (path === '/api/leave-definitions/invalidate' && req.method === 'POST')
      result = await service.invalidateDefinition(db,req,await readBody(req))
    else if (path === '/api/leave-catalog' && req.method === 'GET')
      result = await service.catalog(db, req, {
        cursor: url.searchParams.get('cursor'),
        limit: url.searchParams.get('limit')
      })
    else if (path === '/api/leave-resolve' && req.method === 'POST')
      result = await service.resolve(db, req, (await readBody(req)).text)
    else if (path === '/api/leave-template' && req.method === 'GET') {
      const who = await service.identity(db, req)
      result = await service.template(db, req, source)
      result.publication = await service.publication(db, result, who)
      try {
        await require('../roomAcl').assertRoomAccess(
          db,
          { ...req, forceAcl: true },
          result.source.roomKey,
          'manage'
        )
        result.canPublish = !req.authUser.mcp && !req.verifiedMcpSource
        if (!result.canPublish)
          result.publishHint =
            '发布须由登录用户在页面办理，MCP / AI 身份不能发布'
      } catch (_) {
        result.canPublish = false
        result.publishHint =
          '当前账号对该脑图没有管理权限，请联系脑图所有者或管理员授权后再发布'
      }
    } else if (
      path === '/api/leave-template/publish' &&
      req.method === 'POST'
    ) {
      const body = await readBody(req)
      if (genericEntry && !body.source)
        throw Object.assign(new Error('发布必须指定模板来源'), {
          code: 'SOURCE_REQUIRED',
          statusCode: 400
        })
      result = await service.publish(db, req, body)
    } else if (path === '/api/leave-members' && req.method === 'GET') {
      const who = await service.identity(db, req),
        q = String(url.searchParams.get('q') || '').slice(0, 80)
      result = {
        list: (
          await db.query(
            'select user_id,name from wecom_users where corp_id=$1 and (name ilike $2 or user_id ilike $2) order by name,user_id limit 20',
            [who.corp_id, '%' + q + '%']
          )
        ).rows
      }
    } else if (
      path === '/api/leave-notifications' &&
      ['GET', 'POST'].includes(req.method)
    )
      result = await service.notices(
        db,
        req,
        req.method === 'POST',
        req.method === 'POST' ? (await readBody(req)).ids : []
      )
    else if (path === '/api/leave-requests' && req.method === 'GET')
      result = await service.list(db, req, Object.fromEntries(url.searchParams))
    else if (path === '/api/leave-requests' && req.method === 'POST') {
      const body = await readBody(req)
      if (genericEntry && !body.source)
        throw Object.assign(
          new Error('请先选择审批模板，通用入口不会默认选择请假'),
          { code: 'SOURCE_REQUIRED', statusCode: 400 }
        )
      result = await service.prepare(db, req, body)
      await service.project(db, writer, result.id)
      result = await service.get(db, req, result.id)
    } else {
      const hit = path.match(
        /^\/api\/leave-requests\/([^/]+)(?:\/(save|import|submit|withdraw|decide|analysis|attachments)(?:\/([^/]+))?)?$/
      )
      if (!hit) return false
      if (req.method === 'GET' && !hit[2])
        result = await service.get(db, req, hit[1], {
          before: url.searchParams.get('before')
        })
      else if (req.method === 'POST' && hit[2] && hit[2] !== 'attachments')
        result = await service.mutate(
          db,
          req,
          hit[1],
          hit[2],
          await readBody(req)
        )
      else if (req.method === 'GET' && hit[2] === 'attachments' && hit[3]) {
        const content = await service.attachment(db, req, hit[1], hit[3])
        if (!content)
          throw Object.assign(new Error('附件不存在'), { statusCode: 404 })
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment',
          'X-Content-Type-Options': 'nosniff',
          'Content-Length': content.buffer.length,
          'Cache-Control': 'private, no-store'
        })
        res.end(content.buffer)
        return true
      } else return false
    }
    if (req.method === 'POST' && /\/(import|submit)$/.test(path))
      await service.project(db, writer, result.id)
    if (path === '/api/leave-catalog')
      result = {
        ...result,
        list: result.list.map(({ aliases, ...entry }) => entry)
      }
    sendJson(res, 200, { ok: true, item: result })
    setImmediate(run)
  } catch (e) {
    sendJson(res, e.statusCode || 400, {
      ok: false,
      code: e.code || 'LEAVE_ERROR',
      error: e.message || '请假处理失败'
    })
  }
  return true
}
module.exports = { handle, startWorker }
