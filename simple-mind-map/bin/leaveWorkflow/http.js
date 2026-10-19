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
  if (!url.pathname.startsWith('/api/leave-')) return false
  const run = startWorker(db, writer)
  try {
    const path = url.pathname
    let result
    if (path === '/api/leave-template' && req.method === 'GET') {
      const who = await service.identity(db, req)
      result = await service.template(db, req)
      result.publication = await service.publication(db, result, who)
      try {
        await require('../roomAcl').assertRoomAccess(
          db,
          { ...req, forceAcl: true },
          result.source.roomKey,
          'manage'
        )
        result.canPublish = !req.authUser.mcp && !req.verifiedMcpSource
      } catch (_) {
        result.canPublish = false
      }
    } else if (
      path === '/api/leave-template/publish' &&
      req.method === 'POST'
    ) {
      result = await service.publish(db, req, await readBody(req))
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
    else if (path === '/api/leave-requests' && req.method === 'POST')
      result = await service.prepare(db, req, await readBody(req))
    else {
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
