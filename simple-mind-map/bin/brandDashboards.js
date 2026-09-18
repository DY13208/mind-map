const { randomUUID } = require('crypto')

const LEVELS = ['group', 'department', 'project']
const MAX_HTML_BYTES = 8 * 1024 * 1024

function stripHtml(value) {
  return String(value == null ? '' : value)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&times;|&#215;/gi, '×')
    .replace(/\s+/g, ' ')
    .trim()
}

function healthSummary(value) {
  const text = stripHtml(value)
  if (!text) return ''
  const match = text.match(
    /品牌健康分\s*[：:]\s*[^\s=，,；;。]{1,24}\s*=\s*财务分\s*[^\s×xX*＋+=，,；;。]{1,24}\s*[×xX*]\s*[^\s＋+=，,；;。]{1,16}\s*[+＋]\s*运营分\s*[^\s×xX*＋+=，,；;。]{1,24}\s*[×xX*]\s*[^\s，,；;。]{1,16}/i
  )
  return match
    ? match[0]
        .replace(/\s+/g, ' ')
        .replace(/品牌健康分\s*([：:])\s*/i, '品牌健康分$1')
        .trim()
    : ''
}

function normalizeLevel(value) {
  const level = String(value || '').trim()
  return LEVELS.includes(level) ? level : 'group'
}

function normalizeSourceUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    return parsed.toString()
  } catch (error) {
    return ''
  }
}

function iso(value) {
  if (!value) return null
  return value instanceof Date ? value.toISOString() : value
}

function rowToDashboard(row, actorId) {
  const title = String(row.title || '').trim() || '未命名看板'
  const summary = healthSummary(row.html_content)
  return {
    id: row.id,
    title,
    level: normalizeLevel(row.level),
    fileName: row.file_name || '数据看板.html',
    sourceType: row.source_type === 'url' ? 'url' : 'html',
    sourceUrl: row.source_url || '',
    canDelete: !!actorId && row.owner_id === actorId,
    status: 'ready',
    errorMessage: '',
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    projectName: title,
    healthSummary: summary,
    summaryMissing: !summary
  }
}

async function initSchema(db) {
  await db.query(`
    create table if not exists brand_dashboards (
      id text primary key,
      owner_id text not null,
      title text not null default '',
      level text not null default 'group',
      file_name text not null default '',
      html_content text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint brand_dashboards_level_chk
        check (level in ('group', 'department', 'project'))
    )`)
  await db.query(
    `create index if not exists brand_dashboards_owner_updated_idx
     on brand_dashboards(owner_id, updated_at desc)`
  )
  await db.query(
    `alter table brand_dashboards
     add column if not exists source_type text not null default 'html'`
  )
  await db.query(
    `alter table brand_dashboards
     add column if not exists source_url text not null default ''`
  )
}

async function listDashboards(db, actorId) {
  await initSchema(db)
  const result = await db.query(
    `select id, owner_id, title, level, file_name, html_content, source_type, source_url, created_at, updated_at
     from brand_dashboards
     order by updated_at desc`
  )
  return result.rows.map(row => rowToDashboard(row, actorId))
}

async function getDashboard(db, id) {
  await initSchema(db)
  const result = await db.query(
    `select id, owner_id, title, level, file_name, html_content, source_type, source_url, created_at, updated_at
     from brand_dashboards
     where id = $1
     limit 1`,
    [id]
  )
  return result.rows[0] || null
}

async function createDashboard(req, res, context, actor) {
  const db = context.db
  let body = {}
  if (context.readBody) {
    try {
      body =
        (await context.readBody(req, { maxBytes: 12 * 1024 * 1024 })) || {}
    } catch (error) {
      if (error && error.statusCode) throw error
      body = {}
    }
  }
  const title = String(body.title || '').trim()
  if (!title) {
    context.sendJson(res, 400, {
      ok: false,
      code: 'MISSING_TITLE',
      error: '请填写看板名称'
    })
    return
  }
  const rawUrl = String(body.sourceUrl || '').trim()
  const sourceUrl = normalizeSourceUrl(rawUrl)
  if (rawUrl && !sourceUrl) {
    context.sendJson(res, 400, {
      ok: false,
      code: 'INVALID_SOURCE_URL',
      error: '看板链接无效，需为 http/https 地址'
    })
    return
  }
  const base64 = String(body.contentBase64 || '')
  let html = ''
  let fileName = String(body.fileName || '').trim()
  let sourceType = 'html'
  if (sourceUrl) {
    sourceType = 'url'
    if (!fileName) fileName = new URL(sourceUrl).host
  } else if (base64) {
    try {
      html = Buffer.from(base64, 'base64').toString('utf8')
    } catch (error) {
      html = ''
    }
    if (!html || Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
      context.sendJson(res, 400, {
        ok: false,
        code: 'INVALID_CONTENT',
        error: 'HTML 内容无效或过大'
      })
      return
    }
  } else {
    context.sendJson(res, 400, {
      ok: false,
      code: 'MISSING_CONTENT',
      error: '请上传数据看板 HTML 文件或填写看板链接'
    })
    return
  }
  if (!fileName) fileName = '数据看板.html'
  await initSchema(db)
  const id = randomUUID()
  const result = await db.query(
    `insert into brand_dashboards (id, owner_id, title, level, file_name, html_content, source_type, source_url)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id, title, level, file_name, html_content, source_type, source_url, created_at, updated_at`,
    [
      id,
      actor.id,
      title,
      normalizeLevel(body.level),
      fileName,
      html,
      sourceType,
      sourceUrl
    ]
  )
  context.sendJson(res, 201, {
    ok: true,
    dashboard: rowToDashboard(result.rows[0], actor.id)
  })
}

async function updateDashboard(req, res, context, actor, id) {
  const db = context.db
  let body = {}
  if (context.readBody) {
    try {
      body =
        (await context.readBody(req, { maxBytes: 12 * 1024 * 1024 })) || {}
    } catch (error) {
      if (error && error.statusCode) throw error
      body = {}
    }
  }
  await initSchema(db)
  const row = await getDashboard(db, id)
  if (!row) {
    context.sendJson(res, 404, {
      ok: false,
      code: 'DASHBOARD_NOT_FOUND',
      error: '数据看板不存在或已被删除'
    })
    return
  }
  if (row.owner_id !== actor.id) {
    context.sendJson(res, 403, {
      ok: false,
      code: 'FORBIDDEN',
      error: '只能编辑自己创建的看板'
    })
    return
  }
  const rawUrl = String(body.sourceUrl || '').trim()
  const sourceUrl = normalizeSourceUrl(rawUrl)
  if (rawUrl && !sourceUrl) {
    context.sendJson(res, 400, {
      ok: false,
      code: 'INVALID_SOURCE_URL',
      error: '看板链接无效，需为 http/https 地址'
    })
    return
  }
  let html = row.html_content
  let sourceType = row.source_type
  let storedUrl = row.source_url
  let fileName = row.file_name
  const base64 = String(body.contentBase64 || '')
  if (sourceUrl) {
    sourceType = 'url'
    storedUrl = sourceUrl
    html = ''
    fileName = String(body.fileName || '').trim() || new URL(sourceUrl).host
  } else if (base64) {
    let decoded = ''
    try {
      decoded = Buffer.from(base64, 'base64').toString('utf8')
    } catch (error) {
      decoded = ''
    }
    if (!decoded || Buffer.byteLength(decoded, 'utf8') > MAX_HTML_BYTES) {
      context.sendJson(res, 400, {
        ok: false,
        code: 'INVALID_CONTENT',
        error: 'HTML 内容无效或过大'
      })
      return
    }
    html = decoded
    sourceType = 'html'
    storedUrl = ''
    fileName =
      String(body.fileName || '').trim() || fileName || '数据看板.html'
  }
  const title = String(body.title || '').trim() || row.title
  const level = body.level ? normalizeLevel(body.level) : normalizeLevel(row.level)
  const result = await db.query(
    `update brand_dashboards
     set title = $1, level = $2, file_name = $3, html_content = $4,
         source_type = $5, source_url = $6, updated_at = now()
     where id = $7
     returning id, owner_id, title, level, file_name, html_content, source_type, source_url, created_at, updated_at`,
    [title, level, fileName, html, sourceType, storedUrl, id]
  )
  context.sendJson(res, 200, {
    ok: true,
    dashboard: rowToDashboard(result.rows[0], actor.id)
  })
}

async function sendDashboardContent(req, res, context, actor, id) {
  const row = await getDashboard(context.db, id)
  if (!row) {
    context.sendJson(res, 404, {
      ok: false,
      code: 'DASHBOARD_NOT_FOUND',
      error: '数据看板不存在或已被删除'
    })
    return
  }
  if (row.source_type === 'url' && row.source_url) {
    res.writeHead(302, {
      Location: row.source_url,
      'Cache-Control': 'no-store'
    })
    res.end()
    return
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(row.html_content || '')
}

async function deleteDashboard(req, res, context, actor, id) {
  await initSchema(context.db)
  const row = await getDashboard(context.db, id)
  if (!row) {
    context.sendJson(res, 404, {
      ok: false,
      code: 'DASHBOARD_NOT_FOUND',
      error: '数据看板不存在或已被删除'
    })
    return
  }
  if (row.owner_id !== actor.id) {
    context.sendJson(res, 403, {
      ok: false,
      code: 'FORBIDDEN',
      error: '只能删除自己创建的看板'
    })
    return
  }
  const result = await context.db.query(
    `delete from brand_dashboards where id = $1`,
    [id]
  )
  if (!result.rowCount) {
    context.sendJson(res, 404, {
      ok: false,
      code: 'DASHBOARD_NOT_FOUND',
      error: '数据看板不存在或已被删除'
    })
    return
  }
  context.sendJson(res, 200, { ok: true, deleted: result.rowCount })
}

async function handleApi(req, res, context = {}) {
  const url = context.url || new URL(req.url, 'http://127.0.0.1')
  const isList = req.method === 'GET' && url.pathname === '/api/dashboards'
  const isCreate = req.method === 'POST' && url.pathname === '/api/dashboards'
  const contentMatch =
    req.method === 'GET' &&
    url.pathname.match(/^\/api\/dashboards\/([^/]+)\/content$/)
  const deleteMatch =
    req.method === 'DELETE' && url.pathname.match(/^\/api\/dashboards\/([^/]+)$/)
  const updateMatch =
    req.method === 'PATCH' && url.pathname.match(/^\/api\/dashboards\/([^/]+)$/)
  if (!isList && !isCreate && !contentMatch && !deleteMatch && !updateMatch) {
    return false
  }
  const actor = require('./roomAcl').actorFromReq(req)
  if (!actor.id) {
    context.sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', error: '请先登录' })
    return true
  }
  if (isCreate) {
    try {
      await createDashboard(req, res, context, actor)
    } catch (error) {
      context.sendJson(res, error.statusCode || 500, {
        ok: false,
        code: error.code || 'DASHBOARD_CREATE_FAILED',
        error: error.message || '创建数据看板失败'
      })
    }
    return true
  }
  if (deleteMatch) {
    try {
      await deleteDashboard(req, res, context, actor, decodeURIComponent(deleteMatch[1]))
    } catch (error) {
      context.sendJson(res, error.statusCode || 500, {
        ok: false,
        code: error.code || 'DASHBOARD_DELETE_FAILED',
        error: error.message || '删除数据看板失败'
      })
    }
    return true
  }
  if (updateMatch) {
    try {
      await updateDashboard(req, res, context, actor, decodeURIComponent(updateMatch[1]))
    } catch (error) {
      context.sendJson(res, error.statusCode || 500, {
        ok: false,
        code: error.code || 'DASHBOARD_UPDATE_FAILED',
        error: error.message || '修改数据看板失败'
      })
    }
    return true
  }
  if (contentMatch) {
    try {
      await sendDashboardContent(
        req,
        res,
        context,
        actor,
        decodeURIComponent(contentMatch[1])
      )
    } catch (error) {
      context.sendJson(res, error.statusCode || 500, {
        ok: false,
        code: error.code || 'DASHBOARD_CONTENT_FAILED',
        error: error.message || '读取数据看板内容失败'
      })
    }
    return true
  }
  try {
    const list = await listDashboards(context.db, actor.id)
    context.sendJson(res, 200, { ok: true, list, total: list.length })
  } catch (error) {
    context.sendJson(res, error.statusCode || 500, {
      ok: false,
      code: error.code || 'DASHBOARD_LIST_FAILED',
      error: error.message || '读取数据看板失败'
    })
  }
  return true
}

module.exports = {
  LEVELS,
  stripHtml,
  healthSummary,
  normalizeLevel,
  normalizeSourceUrl,
  rowToDashboard,
  initSchema,
  listDashboards,
  getDashboard,
  handleApi
}
