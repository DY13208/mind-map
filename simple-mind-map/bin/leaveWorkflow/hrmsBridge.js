const { createHmac, timingSafeEqual } = require('node:crypto')

const directions = new Set(['snapshot', 'decision', 'attachment'])
const route = '/api/workflow-hrms-bridge'
const maxClockSkew = 300
const workers = new WeakSet()

function isCallback(method, pathname) {
  return method === 'POST' && [route + '/decision', route + '/attachment'].includes(pathname)
}

function denied(message = '人事审批同步签名无效') {
  return Object.assign(new Error(message), { statusCode: 403, code: 'HRMS_BRIDGE_DENIED' })
}

function signature(key, direction, time, body) {
  if (!key || Buffer.byteLength(key) < 32 || !directions.has(direction)) throw denied()
  return createHmac('sha256', key).update(`wcpd-approval-v1\n${direction}\n${time}\n${body}`).digest()
}

function sign(key, direction, payload, now = Date.now()) {
  const time = Math.floor(now / 1000)
  const body = JSON.stringify(payload)
  return { time, body, signature: signature(key, direction, time, body).toString('hex') }
}

function verify(key, direction, envelope, now = Date.now()) {
  const { time, body, signature: digest } = envelope || {}
  if (!Number.isSafeInteger(time) || Math.abs(Math.floor(now / 1000) - time) > maxClockSkew ||
      typeof body !== 'string' || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest) ||
      !timingSafeEqual(signature(key, direction, time, body), Buffer.from(digest, 'hex'))) throw denied()
  return JSON.parse(body)
}

function config(env = process.env) {
  const { readConfig } = require('../hrmsExternalApi')
  const key = (env.WCPD_HRMS_APPROVAL_BRIDGE_KEY || '').trim()
  const base = readConfig(env).baseUrl
  const corp = (env.WCPD_HRMS_APPROVAL_BRIDGE_CORP_ID || env.HRMS_SYNC_CORP_ID || '').trim()
  return { key, base, corp, enabled: Buffer.byteLength(key) >= 32 && !!base && !!corp }
}

function isAgent(row) {
  return !!(row.template.agentInput || row.template.agentDefinition || row.report?.submittedByMcp)
}

async function initSchema(db) {
  await db.query(`create table if not exists approval_hrms_outbox (
    request_id uuid not null references leave_requests(id),
    revision integer not null,
    kind text not null,
    payload jsonb not null,
    retry_at timestamptz not null default now(),
    attempts integer not null default 0,
    last_error text not null default '',
    finished_at timestamptz,
    primary key(request_id, revision)
  );
  create index if not exists approval_hrms_outbox_due on approval_hrms_outbox(retry_at)
    where finished_at is null;`)
}

async function enqueue(db, row, recipients, kind, detail = {}, cfg = config()) {
  if (!cfg.enabled || row.corp_id !== cfg.corp || !isAgent(row)) return
  const step = row.status === 'pending' ? row.steps[row.current_step] : null
  const ids = [...new Set([row.requester_id, step?.assigneeId, ...recipients].filter(Boolean))]
  const { rows } = await db.query(
    'select user_id,wecom_userid from wecom_users where corp_id=$1 and user_id=any($2::text[])',
    [row.corp_id, ids]
  )
  const accounts = new Map(rows.map(person => [person.user_id, person.wecom_userid]))
  let submitted = row
  if (kind === 'withdrawn' && detail.fromReturned) {
    // Edits made after return are a draft, even if the requester then withdraws.
    const { rows: [last] } = await db.query(`
      select detail->'snapshot' as snapshot from leave_events
      where request_id=$1 and action='submit' and detail->>'round'=$2 order by id desc limit 1`,
      [row.id, String(row.round - 1)])
    submitted = last?.snapshot || { template: { title: row.template.title }, fields: {}, report: {} }
  }
  const payload = {
    requestId: row.id,
    corpId: row.corp_id,
    revision: row.revision,
    round: row.round - (kind === 'returned' || detail.fromReturned ? 1 : 0),
    status: row.status,
    kind,
    requester: accounts.get(row.requester_id) || '',
    recipients: [...new Set(recipients.filter(Boolean))].map(id => accounts.get(id) || ''),
    title: submitted.template.title || '请假申请',
    fields: (submitted.template.fields || []).filter(field => field.type !== 'attachment').map(field => ({
      label: field.label, value: submitted.fields[field.key] ?? ''
    })),
    attachments: (submitted.report.attachments || []).map(file => ({ id: file.id, name: file.fileName })),
    ...(detail.decision ? { decision: detail.decision, decidedStep: detail.step, reason: detail.reason } : {}),
    step: step ? {
      index: row.current_step, assignee: accounts.get(step.assigneeId) || '', role: step.role,
      criteria: step.criteria.map(item => ({
        uid: item.uid, text: [item.text || item.uid, ...(item.context || [])].join('\n')
      }))
    } : null
  }
  await db.query(
    'insert into approval_hrms_outbox(request_id,revision,kind,payload) values($1,$2,$3,$4) on conflict do nothing',
    [row.id, row.revision, kind, payload]
  )
}

async function backfill(db, cfg) {
  const { rows } = await db.query(`
    select r.* from leave_requests r
    where r.corp_id=$1 and r.status='pending'
      and (r.template ? 'agentInput' or r.template ? 'agentDefinition' or r.report ? 'submittedByMcp')
      and not exists(select 1 from approval_hrms_outbox o where o.request_id=r.id and o.revision=r.revision)
    order by r.updated_at limit 20 for update of r skip locked`, [cfg.corp])
  for (const row of rows)
    await enqueue(db, row, [row.steps[row.current_step].assigneeId], 'todo', {}, cfg)
}

async function run(pool, options = {}) {
  const cfg = config(options.env)
  if (!cfg.enabled) return
  const { transaction } = require('./service')
  await transaction(pool, db => backfill(db, cfg))
  await transaction(pool, async db => {
    const { rows: [job] } = await db.query(`
      select o.*, r.revision as current_revision
      from approval_hrms_outbox o join leave_requests r on r.id=o.request_id
      where o.finished_at is null and o.retry_at<=now() and r.corp_id=$1
      order by o.retry_at, o.revision limit 1 for update of o skip locked`, [cfg.corp])
    if (!job) return
    try {
      if (job.kind !== 'todo' || job.revision === job.current_revision) {
        const response = await (options.fetch || fetch)(cfg.base + '/api/v1/hrms/external/approvals/wcpd-snapshot', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
          signal: AbortSignal.timeout(10000), body: JSON.stringify(sign(cfg.key, 'snapshot', job.payload))
        })
        const result = await response.json()
        if (!response.ok || result.data?.revision < job.revision || !Number.isInteger(result.data?.revision))
          throw new Error(`人事系统未确认审批事件（HTTP ${response.status}）`)
        if (result.data.unresolved > 0)
          throw new Error(`有 ${result.data.unresolved} 位审批通知收件人未绑定有效的人事账号`)
      }
      await db.query(`update approval_hrms_outbox set finished_at=now(),last_error=''
        where request_id=$1 and revision=$2`, [job.request_id, job.revision])
    } catch (error) {
      await db.query(`update approval_hrms_outbox set attempts=attempts+1,last_error=$3,
        retry_at=now()+least(900,10*power(2,least(attempts,7))) * interval '1 second'
        where request_id=$1 and revision=$2`, [job.request_id, job.revision, String(error.message).slice(0, 200)])
    }
  })
}

function startWorker(pool) {
  if (workers.has(pool) || !config().enabled) return
  workers.add(pool)
  let active = false
  const tick = async () => {
    if (active) return
    active = true
    try { await run(pool) } catch (error) {
      console.error('[approval_hrms_outbox]', error.code || error.name)
    } finally { active = false }
  }
  setInterval(tick, 3000).unref()
  setImmediate(tick)
}

async function handle(req, res, { url, db, readBody, sendJson }) {
  if (!isCallback(req.method, url.pathname)) return false
  try {
    const cfg = config()
    if (!cfg.enabled) throw denied()
    const direction = url.pathname.split('/').pop()
    const input = verify(cfg.key, direction, await readBody(req))
    if (input.corpId !== cfg.corp || typeof input.actor !== 'string' || !input.actor) throw denied()
    const { rows } = await db.query(
      'select user_id from wecom_users where corp_id=$1 and wecom_userid=$2', [cfg.corp, input.actor]
    )
    if (rows.length !== 1) throw denied('无法匹配当前审批人的企微账号')
    const actorReq = { ...req, authUser: { id: rows[0].user_id, wecomUserId: input.actor }, verifiedMcpSource: null }
    const service = require('./service')
    if (direction === 'decision') {
      const result = await service.mutate(db, actorReq, input.requestId, 'decide', {
        operationId: input.operationId, expectedRevision: input.revision, decision: input.decision,
        reason: input.reason, checkedCriteria: input.checkedCriteria
      }, { hrms: { corp: cfg.corp, step: input.step } })
      sendJson(res, 200, { ok: true, revision: result.revision })
    } else {
      const content = await service.attachment(db, actorReq, input.requestId, input.attachmentId,
        { hrms: { corp: cfg.corp, round: input.round } })
      if (!content) throw denied('附件已不可查看')
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-store' })
      res.end(content.buffer)
    }
  } catch (error) {
    sendJson(res, error.statusCode || 400, { ok: false, code: error.code || 'HRMS_BRIDGE_ERROR',
      error: error.statusCode ? error.message : '审批同步请求无效' })
  }
  return true
}

module.exports = { sign, verify, isAgent, isCallback, initSchema, enqueue, run, startWorker, handle }
