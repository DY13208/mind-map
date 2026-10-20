// Indexed metadata discovery, not room snapshots or a fixed workflow directory.
const core = require('./core')
const workflow = require('./workflowCore')
const acl = require('../roomAcl')
function aliases(title, id, list = []) {
  return [
    ...new Set(
      [
        core.label(title),
        id,
        core.label(title).replace(/(?:审批|申请)$/, ''),
        ...list.map(core.plain)
      ].filter(s => s && s.length >= 2 && s.length <= 80)
    )
  ]
}
const {
  isWorkflowIntent: positiveIntent
} = require('../../src/utils/leaveNodeFields')
function matches(text, entry) {
  const value = core.plain(text)
  return entry.aliases.some(alias => value.includes(alias))
}
async function page(db, req, options, { identity, SOURCE }) {
  await identity(db, req)
  const pageSize = Math.min(50, Math.max(1, Math.floor(Number(options.limit)) || 50))
  let after = ['', '', '']
  if (options.cursor) {
    try {
      after = JSON.parse(
        Buffer.from(options.cursor, 'base64url').toString('utf8')
      )
      if (
        !Array.isArray(after) ||
        after.length !== 3 ||
        after.some(s => typeof s !== 'string' || s.length > 200)
      )
        throw Error()
    } catch (_) {
      throw core.failure('INVALID_CURSOR', '流程目录游标无效')
    }
  }
  const rows = (
    await db.query(
      `select m.room_key,m.parent_uid root_uid,m.uid marker_uid,m.data->>'text' marker,r.title room_title,p.data->>'text' title,
    array(select a.data->>'text' from room_nodes g join room_nodes a on a.room_key=g.room_key and a.parent_uid=g.uid and a.deleted_at is null
      where g.room_key=m.room_key and g.parent_uid=m.parent_uid and g.deleted_at is null and regexp_replace(g.data->>'text','<[^>]*>','','g')='触发词' order by a.position,a.uid limit 50) aliases
    from room_nodes m join room_nodes p on p.room_key=m.room_key and p.uid=m.parent_uid and p.deleted_at is null join rooms r on r.room_key=m.room_key and r.deleted_at is null
    where m.deleted_at is null and m.data->>'text' like '%流程标识%' and (m.room_key,m.parent_uid,m.uid)>($1,$2,$3)
    order by m.room_key,m.parent_uid,m.uid limit $4`,
      [...after, pageSize + 1]
    )
  ).rows
  const visible = [],
    access = new Map(),
    seen = new Set()
  const canView = async room => {
    if (!access.has(room)) {
      try {
        await acl.assertRoomAccess(db, { ...req, forceAcl: true }, room, 'view')
        access.set(room, true)
      } catch (e) {
        if (![403, 404].includes(e.statusCode)) throw e
        access.set(room, false)
      }
    }
    return access.get(room)
  }
  // Compatibility entry; it has the same access checks as every discovered template.
  if (!options.cursor && (await canView(SOURCE.roomKey))) {
    const n = (
      await db.query(
        'select data from room_nodes where room_key=$1 and uid=$2 and deleted_at is null',
        [SOURCE.roomKey, SOURCE.nodeUid]
      )
    ).rows[0]
    if (n)
      visible.push({
        source: SOURCE,
        title: core.label(n.data.text),
        kind: 'leave',
        aliases: aliases(n.data.text, '请假', [
          '年假',
          '事假',
          '病假',
          '调休',
          '婚假',
          '产假',
          '陪产假',
          '丧假',
          '长假'
        ]),
        roomTitle: '公司请假制度'
      })
  }
  for (const row of rows.slice(0, pageSize)) {
    const match = workflow.marker(row.marker),
      key = row.room_key + ':' + row.root_uid
    if (
      !match ||
      seen.has(key) ||
      (row.room_key === SOURCE.roomKey && row.root_uid === SOURCE.nodeUid) ||
      !(await canView(row.room_key))
    )
      continue
    seen.add(key)
    visible.push({
      source: { roomKey: row.room_key, nodeUid: row.root_uid },
      title: core.label(row.title).slice(0, 120),
      flowId: match[1],
      kind: 'generic',
      aliases: aliases(row.title, match[1], row.aliases),
      roomTitle: String(row.room_title || row.room_key).slice(0, 120)
    })
  }
  const last = rows[pageSize - 1]
  return {
    list: visible,
    hasMore: rows.length > pageSize,
    nextCursor:
      rows.length > pageSize
        ? Buffer.from(
            JSON.stringify([last.room_key, last.root_uid, last.marker_uid])
          ).toString('base64url')
        : null
  }
}
async function resolve(db, req, text, deps) {
  if (!positiveIntent(text))
    return {
      candidates: [],
      reason: '请输入明确的申请意图，取消或撤回应从现有申请办理'
    }
  const candidates = [],
    seen = new Set()
  let cursor
  for (let i = 0; i < 20; i++) {
    const result = await page(db, req, { cursor }, deps)
    for (const entry of result.list) {
      const key = entry.source.roomKey + ':' + entry.source.nodeUid
      if (!seen.has(key) && matches(text, entry)) {
        seen.add(key)
        candidates.push(entry)
        if (candidates.length > 20)
          throw core.failure(
            'FLOW_AMBIGUOUS',
            '匹配到超过20个审批模板，请补充具体流程名称或明确指定来源'
          )
      }
    }
    if (!result.hasMore)
      return {
        candidates: candidates.map(({ aliases, ...entry }) => entry),
        reason: candidates.length
          ? ''
          : '未找到可访问的审批模板；可在任意脑图登记“流程标识”、触发词、申请字段和审批流程'
      }
    cursor = result.nextCursor
  }
  throw core.failure(
    'CATALOG_LIMIT',
    '可检索模板超过本次范围，请明确指定模板所在房间和节点；不会在未检查完候选时自动选流程'
  )
}
module.exports = { page, resolve, positiveIntent, matches }
