const { createHash, randomUUID } = require('node:crypto')
const { assertRoomAccess, getAccess, roleAllows } = require('./roomAcl')
const { identity, subtree } = require('./leaveWorkflow/service')
const { plain } = require('./leaveWorkflow/core')
const { marker } = require('./leaveWorkflow/workflowCore')
const { createShortNodeLinks } = require('./shortNodeLinks')
const { resolveRoomRef } = require('./roomNodes')
const { mergeSetting, mergeAllowed } = require('./workflowMerge')

const endpoint = '/api/workflow-development-tasks'
const schemas = new WeakMap()
const nodeLinks = new WeakMap()
const fields = ['适用范围', '数据来源', '缺数据处理']
const columns = `id, version, node_link, status, missing, stage, failure, pr_url, progress, updated_at,
  deployment - 'image' - 'previous' as deployment, merge_review, merge_requested_at, route as merge_route`
const ruleText = value => plain(String(value || '').replace(/<br\b[^>]*>|<\/(?:p|div|li)>/gi, '\n'))

function initSchema(db) {
  if (!schemas.has(db)) {
    schemas.set(db, db.query(`create table if not exists workflow_development_tasks (
      id uuid primary key,
      room_id text not null,
      node_id text not null,
      created_by text not null,
      version text not null,
      node_link text not null,
      snapshot jsonb not null,
      route jsonb,
      status text not null check (status in ('queued','developing','needs_input','failed','pr_created')),
      missing jsonb not null,
      stage text,
      failure text,
      pr_url text,
      tested_commit text,
      test_result jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (room_id, node_id, version)
    );
    alter table workflow_development_tasks
      add column if not exists progress jsonb not null default '[]';
    alter table workflow_development_tasks
      add column if not exists deployment jsonb,
      add column if not exists deployment_checked_at timestamptz,
      add column if not exists merge_review jsonb,
      add column if not exists merge_requested_at timestamptz,
      add column if not exists archived_at timestamptz;
    create index if not exists workflow_development_pending_idx
      on workflow_development_tasks (created_at) where status in ('queued','developing')`)
      .catch(error => { schemas.delete(db); throw error }))
  }
  return schemas.get(db)
}

function validPath(value) {
  return typeof value === 'string' && value.split('/').every(part =>
    /^[^\x00-\x1f\\:*?"<>|]+$/.test(part) && !['.', '..', '.git'].includes(part.toLowerCase()))
}

function validRoute(route) {
  return route && typeof route.repository === 'string' &&
    /^[\w-]+\/[\w.-]+$/.test(route.repository) && validPath(route.repository) &&
    typeof route.branch === 'string' && /^[\w][\w./-]*$/.test(route.branch) &&
    !route.branch.includes('..') && Array.isArray(route.paths) &&
    route.paths.length && route.paths.every(validPath) && Array.isArray(route.test) &&
    route.test.length && route.test.every(arg => typeof arg === 'string' && arg && !arg.includes('\0'))
}

function describe(nodes, roomId, nodeId, routes) {
  const snapshot = nodes.map(({ uid, parent_uid, data, position }) => ({
    uid, parent: uid === nodeId ? null : parent_uid,
    position: uid === nodeId ? null : position,
    data
  }))
  const children = snapshot.filter(node => node.parent === nodeId)
  const root = snapshot.find(node => node.uid === nodeId)
  const markers = children.map(node => marker(node.data.text)).filter(Boolean)
  const title = plain(root.data.text)
  const routeKey = markers.length === 1 ? markers[0][1].trim() : title
  const route = markers.length <= 1 && routes && Object.hasOwn(routes, routeKey) && validRoute(routes[routeKey])
    ? routes[routeKey] : null
  const labels = new Map([
    ['适用范围', fields[0]], ['数据来源', fields[1]],
    ['缺数据处理', fields[2]], ['缺失数据处理', fields[2]],
    ['缺数据时怎么处理', fields[2]], ['缺数据时如何处理', fields[2]]
  ])
  const defined = new Set()
  const substantive = value => /[\p{L}\p{N}]/u.test(value) &&
    !/^(待补充|待确认|待定|未知|TODO|TBD)[。！.!？?]?$/i.test(value)
  const parentsWithContent = new Set(snapshot.filter(node => substantive(ruleText(node.data.text))).map(node => node.parent))
  for (const node of snapshot) {
    for (const line of [ruleText(node.data.text), ruleText(node.data.note)].join('\n').split('\n')) {
      const [label, ...value] = line.trim().split(/[:：]/)
      if (labels.has(label.trim()) && (substantive(value.join('：').trim()) || parentsWithContent.has(node.uid))) {
        defined.add(labels.get(label.trim()))
      }
    }
  }
  const missing = fields.filter(field => !defined.has(field))
  if (!route) missing.push(markers.length > 1 ? '保留一个流程标识' : '请填写已配置开发路由的流程标识')
  const version = createHash('sha256').update(JSON.stringify([roomId, nodeId, snapshot])).digest('hex')
  return { snapshot, version, missing, route }
}

function buildSupplementDraft({ snapshot, missing, version }) {
  const root = snapshot.find(node => node.parent === null)
  const title = ruleText(root.data.text).slice(0, 100)
  const sections = snapshot.filter(node =>
    /^(提交要求|申请字段|必要条件|申请资料)[：:]?$/.test(ruleText(node.data.text)))
  const sectionIds = new Set(sections.map(node => node.uid))
  const lines = snapshot.flatMap(node => [ruleText(node.data.text), ruleText(node.data.note)].join('\n').split('\n'))
  const sources = [...new Set(snapshot.filter(node => sectionIds.has(node.parent))
    .map(node => ruleText(node.data.text).slice(0, 80)).filter(Boolean))].slice(0, 8)
  const resumeBirthYear = sources.some(text => /简历/.test(text)) &&
    lines.some(line => /简历.*(?:出生年份|\d{4}年.{0,5}出生)/.test(line))
  const handling = lines.find(line =>
    /^(若|如|当|如果)?(?:必需|必要|所需|关键)?(?:数据|资料|字段|附件|简历)(?:缺失|缺少|未提供|无法读取|不完整)/.test(line) &&
    /补齐|补填|人工|退回|暂停|跳过/.test(line))
  const entries = {
    [fields[0]]: {
      text: title ? `适用于提交至「${title}」的申请。` : '',
      review: true
    },
    [fields[1]]: {
      text: sources.length ? `读取申请中提交的${sources.join('、')}。${resumeBirthYear ? '从简历附件识别出生年份。' : ''}` : '',
      review: !sources.length
    },
    [fields[2]]: {
      text: handling ? handling.slice(0, 500) : '必需资料缺失、无法读取或关键字段无法确认时，转人工核对并补齐资料。',
      review: !handling
    }
  }
  return { version, fields: fields.filter(field => missing.includes(field)).map(field => ({ field, ...entries[field] })) }
}

async function handle(req, res, { url, db, readBody, sendJson }) {
  if (![endpoint, endpoint + '/retry', endpoint + '/draft', endpoint + '/merge'].includes(url.pathname)) return false
  require('./auth').applyCorsHeaders(req, res)
  try {
    const retry = url.pathname.endsWith('/retry')
    const draft = url.pathname.endsWith('/draft')
    const merge = url.pathname.endsWith('/merge')
    if (req.method !== 'POST' && (req.method !== 'GET' || retry || draft || merge)) {
      sendJson(res, 405, { error: '不支持此操作' })
      return true
    }
    const who = await identity(db, req, req.method === 'POST')
    const source = req.method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams)
    const { roomId, nodeId, taskId } = source || {}
    if (![roomId, nodeId].every(value => typeof value === 'string' && value.trim() && value.length <= 200)) {
      sendJson(res, 400, { error: '请指定规则所在脑图和节点' })
      return true
    }
    const request = { ...req, forceAcl: true }
    const action = merge ? 'manage' : req.method === 'POST' ? 'edit' : 'view'
    const membership = await getAccess(db, roomId, who.user_id)
    const mergeConfig = mergeSetting(process.env.WORKFLOW_DEVELOPMENT_MERGE)
    const canManageMerge = roleAllows(membership.role, 'manage') && mergeConfig?.roomId === roomId
    if (merge && !canManageMerge) {
      sendJson(res, 403, { error: '此脑图的管理员可以发起合入' })
      return true
    }
    const aclRequest = roleAllows(membership.role, action)
      ? { ...request, headers: { ...req.headers, cookie: '' } }
      : request
    const access = await assertRoomAccess(db, aclRequest, roomId, action)
    if (access.shareId) {
      const scope = await db.query(`with recursive ancestors as (
        select uid,parent_uid,array[uid] as trail from room_nodes
        where room_key=$1 and uid=$2 and deleted_at is null
        union all select n.uid,n.parent_uid,a.trail||n.uid from room_nodes n
        join ancestors a on n.uid=a.parent_uid
        where n.room_key=$1 and n.deleted_at is null and not n.uid=any(a.trail) and cardinality(a.trail)<1000
      ) select 1 from ancestors a join node_shares s on s.root_uid=a.uid
        where s.id=$3 and s.room_key=$1 and s.revoked_at is null
          and (s.expires_at is null or s.expires_at>now())`, [roomId, nodeId, access.shareId])
      if (!scope.rows.length) {
        sendJson(res, 403, { error: '规则节点不在当前分享范围内' })
        return true
      }
    }
    await initSchema(db)
    let result
    if (merge) {
      result = await db.query(`update workflow_development_tasks
        set merge_requested_at=coalesce(merge_requested_at,now()),merge_review=null,
          deployment_checked_at=null,updated_at=now()
        where room_id=$1 and node_id=$2 and id::text=$3 and status='pr_created' and pr_url is not null
          and lower(route->>'repository')=lower($4) and route->>'branch'=$5
          and coalesce(deployment->>'state','') not in ('deployed','deploying','rolling_back','closed',
            'superseded','deploy_failed','rolled_back','rollback_failed')
          and (merge_requested_at is null and merge_review is null or
            merge_review->>'state' in ('blocked','failed','checks_failed'))
        returning ${columns}`, [roomId, nodeId, taskId, mergeConfig.repository, mergeConfig.branch])
    } else if (retry) {
      result = await db.query(`update workflow_development_tasks
        set status='queued', stage=null, failure=null, updated_at=now()
        where room_id=$1 and node_id=$2 and id::text=$3 and status='failed'
        returning ${columns}`, [roomId, nodeId, taskId])
      if (!result.rows.length) {
        result = await db.query(`update workflow_development_tasks
          set deployment=null, deployment_checked_at=null, updated_at=now()
          where room_id=$1 and node_id=$2 and id::text=$3 and status='pr_created'
            and deployment->>'state' in ('preview_failed','deploy_failed','rolled_back')
          returning ${columns}`, [roomId, nodeId, taskId])
      }
      if (!result.rows.length) {
        const closed = await db.query(`select id, version, node_link, snapshot, route, created_by
          from workflow_development_tasks
          where room_id=$1 and node_id=$2 and id::text=$3 and status='pr_created'
            and deployment->>'state'='closed'`, [roomId, nodeId, taskId])
        const previous = closed.rows[0]
        if (previous) {
          await db.query(`update workflow_development_tasks
            set archived_at=now(), version=$2, updated_at=now() where id=$1`,
          [previous.id, previous.version + ':closed:' + Date.now()])
          try {
            result = await db.query(`insert into workflow_development_tasks
              (id, room_id, node_id, created_by, version, node_link, snapshot, route, status, missing)
              values ($1,$2,$3,$4,$5,$6,$7,$8,'queued','[]')
              returning ${columns}`, [
              randomUUID(), roomId, nodeId, previous.created_by || who.user_id, previous.version,
              previous.node_link, JSON.stringify(previous.snapshot),
              previous.route ? JSON.stringify(previous.route) : null
            ])
          } catch (error) {
            await db.query(`update workflow_development_tasks
              set archived_at=null, version=$2, updated_at=now() where id=$1`,
            [previous.id, previous.version]).catch(() => {})
            throw error
          }
        }
      }
    } else if (req.method === 'GET') {
      result = await db.query(`select ${columns} from workflow_development_tasks
        where room_id=$1 and node_id=$2 and archived_at is null
          and ($3::text is null or id::text=$3)
        order by created_at desc limit 1`, [roomId, nodeId, taskId || null])
    } else {
      const routes = JSON.parse(process.env.WORKFLOW_DEVELOPMENT_ROUTES || '{}')
      const nodes = await subtree(db, roomId, nodeId)
      const { snapshot, version, route, missing } = describe(nodes, roomId, nodeId, routes)
      const rawSnapshot = JSON.stringify(snapshot)
      if (Buffer.byteLength(rawSnapshot) > 128 * 1024) {
        sendJson(res, 413, { error: '规则子树超过 128 KB，请选中更具体的规则节点' })
        return true
      }
      if (draft) {
        if (source.version && source.version !== version) {
          sendJson(res, 409, { error: '规则已更新，请重新生成补充草稿' })
        } else {
          sendJson(res, 200, { item: buildSupplementDraft({ snapshot, version, missing }) })
        }
        return true
      }
      result = await db.query(`select ${columns} from workflow_development_tasks
        where room_id=$1 and node_id=$2 and version=$3`, [roomId, nodeId, version])
      if (result.rows[0]?.status === 'needs_input' && !missing.length) {
        result = await db.query(`update workflow_development_tasks
          set route=$4,status='queued',missing='[]',updated_at=now()
          where room_id=$1 and node_id=$2 and version=$3 and status='needs_input'
          returning ${columns}`, [roomId, nodeId, version, route])
        if (!result.rows.length) {
          result = await db.query(`select ${columns} from workflow_development_tasks
            where room_id=$1 and node_id=$2 and version=$3`, [roomId, nodeId, version])
        }
      }
      if (!result.rows.length) {
        if (!nodeLinks.has(db)) {
          nodeLinks.set(db, createShortNodeLinks({
            pool: db,
            resolveRef: (roomKey, uid) => resolveRoomRef(db, roomKey, uid),
            assertAccess: (req, roomKey) => assertRoomAccess(db, req, roomKey, 'view')
          }))
        }
        const { code } = await nodeLinks.get(db).create(request, { roomKey: roomId, uid: nodeId })
        const base = process.env.WORKFLOW_DEVELOPMENT_APP_URL || process.env.AUTH_APP_ORIGIN
        const nodeLink = base ? new URL('/s/' + code, base).href : '/s/' + code
        result = await db.query(`insert into workflow_development_tasks
          (id, room_id, node_id, created_by, version, node_link, snapshot, route, status, missing)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          on conflict (room_id,node_id,version) do update set version=excluded.version
          returning ${columns}`, [
          randomUUID(), roomId, nodeId, who.user_id, version, nodeLink, rawSnapshot,
          route, missing.length ? 'needs_input' : 'queued', JSON.stringify(missing)
        ])
      }
    }
    const row = result.rows[0]
    const { merge_route: storedRoute, ...item } = row || {}
    const mergeEnabled = mergeAllowed(mergeConfig, { room_id: roomId, route: storedRoute })
    const conflict = (retry || merge) && !row
    sendJson(res, conflict ? 409 : 200, {
      item: row ? {
        ...item, merge_available: !!canManageMerge && mergeEnabled,
        merge_auto: mergeEnabled && mergeConfig.autoNodes.includes(nodeId)
      } : null,
      ...(conflict ? { error: '任务状态已变化，请刷新后重试' } : {})
    })
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      code: error.statusCode ? error.code : 'WORKFLOW_DEVELOPMENT_ERROR',
      error: error.statusCode ? error.message : '开发任务暂时不可用'
    })
  }
  return true
}

module.exports = { buildSupplementDraft, describe, handle, initSchema, validPath, validRoute }
