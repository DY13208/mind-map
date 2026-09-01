const {
  applyPositionsToTree,
  comparePositions,
  encodeRank,
  STEP
} = require('./fractionalIndex')

function padPosition(index) {
  const n = Number(index)
  if (!Number.isFinite(n) || n < 0) return '00000000'
  return String(Math.min(Math.floor(n), 99999999)).padStart(8, '0')
}

function findRootUid(obj) {
  const uids = Object.keys(obj || {})
  return uids.find(uid => obj[uid] && obj[uid].isRoot) || uids[0] || null
}

function validateNodeGraph(obj) {
  const errors = []
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['invalid object'], nodeCount: 0, rootUid: null }
  }
  const uids = Object.keys(obj)
  if (!uids.length) {
    return { ok: true, errors: [], nodeCount: 0, rootUid: null }
  }
  const roots = uids.filter(uid => obj[uid] && obj[uid].isRoot)
  const rootUid = roots.length === 1 ? roots[0] : findRootUid(obj)
  if (roots.length === 0) errors.push('missing root')
  if (roots.length > 1) errors.push('multiple roots')

  uids.forEach(uid => {
    const node = obj[uid]
    if (!node || typeof node !== 'object') {
      errors.push(`invalid node ${uid}`)
      return
    }
    const children = node.children
    if (children == null) return
    if (!Array.isArray(children)) {
      errors.push(`children not array ${uid}`)
      return
    }
    if (new Set(children).size !== children.length) {
      errors.push(`duplicate children ${uid}`)
    }
    children.forEach(child => {
      if (child === uid) errors.push(`self parent ${uid}`)
      if (!obj[child]) errors.push(`missing child ${child} of ${uid}`)
    })
  })

  if (rootUid && obj[rootUid]) {
    const visiting = new Set()
    const visited = new Set()
    const walk = uid => {
      if (!obj[uid]) return
      if (visiting.has(uid)) {
        errors.push(`cycle at ${uid}`)
        return
      }
      if (visited.has(uid)) return
      visiting.add(uid)
      ;((obj[uid] && obj[uid].children) || []).forEach(walk)
      visiting.delete(uid)
      visited.add(uid)
    }
    walk(rootUid)
    uids.forEach(uid => {
      if (!visited.has(uid)) errors.push(`unreachable ${uid}`)
    })
  }

  return {
    ok: errors.length === 0,
    errors,
    nodeCount: uids.length,
    rootUid
  }
}

function encodeNodeRows(obj) {
  const graph = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}
  applyPositionsToTree(graph)
  const parentOf = {}
  Object.keys(graph).forEach(uid => {
    const children = (graph[uid] && graph[uid].children) || []
    children.forEach(child => {
      parentOf[child] = uid
    })
  })
  return Object.keys(graph).map(uid => {
    const node = graph[uid] || {}
    const data = { ...(node.data || {}), uid }
    return {
      uid,
      parent_uid: parentOf[uid] || null,
      position: node.position || encodeRank(STEP),
      data,
      is_root: !!(node.isRoot || (uid === findRootUid(graph) && !parentOf[uid]))
    }
  })
}

function decodeNodeRows(rows) {
  const obj = {}
  const live = (rows || []).filter(row => !row.deleted_at)
  live.forEach(row => {
    const uid = row.uid
    obj[uid] = {
      isRoot: !!row.is_root,
      data: { ...(row.data || {}), uid },
      children: [],
      position: row.position || ''
    }
  })
  live
    .slice()
    .sort((a, b) =>
      comparePositions(a.position, b.position, a.uid, b.uid)
    )
    .forEach(row => {
      if (row.parent_uid && obj[row.parent_uid] && obj[row.uid]) {
        obj[row.parent_uid].children.push(row.uid)
      }
    })
  return obj
}

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys
    .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`
}

function structureSignature(obj) {
  return Object.keys(obj || {})
    .sort()
    .map(uid => {
      const node = obj[uid] || {}
      return [
        uid,
        node.isRoot ? '1' : '0',
        (node.children || []).join(','),
        stableStringify(node.data || {})
      ].join(':')
    })
    .join('|')
}

function graphsEqual(a, b) {
  return structureSignature(a) === structureSignature(b)
}

function nodesTableAuthorityEnabled() {
  const value = process.env.COLLAB_NODES_AUTHORITY
  return value !== 'json'
}

function canonicalizeNodes(obj) {
  const graph = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}
  const check = validateNodeGraph(graph)
  if (!check.ok) {
    return { ok: false, nodes: graph, errors: check.errors }
  }
  return {
    ok: true,
    nodes: decodeNodeRows(encodeNodeRows(graph)),
    errors: []
  }
}

function pickAuthoritativeNodes(json, table, roomVersion) {
  const jsonObj = json || {}
  const version = Number(roomVersion || 0)
  if (nodesTableAuthorityEnabled() && table && table.nodes && table.count) {
    const check = validateNodeGraph(table.nodes)
    if (check.ok && Number(table.version || 0) >= version) {
      return { nodes: table.nodes, source: 'table' }
    }
  }
  if (
    nodesReadPreferEnabled() &&
    table &&
    table.nodes &&
    Number(table.version || 0) >= version &&
    graphsEqual(table.nodes, jsonObj)
  ) {
    return { nodes: table.nodes, source: 'table' }
  }
  return { nodes: jsonObj, source: 'json' }
}

function auditRoomNodesState(json, table, roomVersion) {
  const jsonObj = json || {}
  const jsonCheck = validateNodeGraph(jsonObj)
  const tableCheck =
    table && table.nodes
      ? validateNodeGraph(table.nodes)
      : { ok: false, errors: ['missing table'], nodeCount: 0 }
  const equal = !!(table && table.nodes && graphsEqual(jsonObj, table.nodes))
  const picked = pickAuthoritativeNodes(jsonObj, table, roomVersion)
  const tableVersion = table ? Number(table.version || 0) : 0
  const version = Number(roomVersion || 0)
  return {
    ok:
      jsonCheck.ok &&
      tableCheck.ok &&
      equal &&
      tableVersion >= version,
    equal,
    source: picked.source,
    roomVersion: version,
    json: {
      valid: jsonCheck.ok,
      count: jsonCheck.nodeCount,
      errors: jsonCheck.errors
    },
    table: {
      valid: tableCheck.ok,
      count: tableCheck.nodeCount,
      version: tableVersion,
      errors: tableCheck.errors
    }
  }
}

function nodesDualWriteEnabled() {
  const value = process.env.COLLAB_NODES_DUAL_WRITE
  return value !== '0' && value !== 'false'
}

function nodesReadPreferEnabled() {
  const value = process.env.COLLAB_NODES_READ
  return value !== '0' && value !== 'false'
}

async function replaceRoomNodes(db, roomKey, obj, version) {
  const graph = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}
  const check = validateNodeGraph(graph)
  if (!check.ok) {
    return { wrote: false, reason: 'invalid', errors: check.errors }
  }
  const rows = encodeNodeRows(graph)
  const uids = rows.map(row => row.uid)
  if (rows.length) {
    await db.query(
      `insert into room_nodes (
         room_key, uid, parent_uid, position, data, is_root, node_version,
         deleted_at, updated_at
       )
       select $1, x.uid, x.parent_uid, x.position, x.data, x.is_root, $2, null, now()
       from unnest(
         $3::text[],
         $4::text[],
         $5::text[],
         $6::jsonb[],
         $7::boolean[]
       ) as x(uid, parent_uid, position, data, is_root)
       on conflict (room_key, uid) do update set
         parent_uid = excluded.parent_uid,
         position = excluded.position,
         data = excluded.data,
         is_root = excluded.is_root,
         node_version = excluded.node_version,
         deleted_at = null,
         updated_at = now()`,
      [
        roomKey,
        Number(version) || 0,
        uids,
        rows.map(row => row.parent_uid),
        rows.map(row => row.position),
        rows.map(row => row.data),
        rows.map(row => row.is_root)
      ]
    )
  }
  if (uids.length) {
    await db.query(
      `update room_nodes
       set deleted_at = now(), updated_at = now()
       where room_key = $1
         and deleted_at is null
         and not (uid = any($2::text[]))`,
      [roomKey, uids]
    )
  } else {
    await db.query(
      `update room_nodes
       set deleted_at = now(), updated_at = now()
       where room_key = $1 and deleted_at is null`,
      [roomKey]
    )
  }
  return { wrote: true, nodeCount: rows.length, rootUid: check.rootUid }
}

async function readRoomNodes(db, roomKey) {
  const res = await db.query(
    `select uid, parent_uid, position, data, is_root, node_version, deleted_at
     from room_nodes
     where room_key = $1 and deleted_at is null`,
    [roomKey]
  )
  if (!res.rows.length) {
    return { nodes: null, version: 0, count: 0 }
  }
  const version = res.rows.reduce(
    (max, row) => Math.max(max, Number(row.node_version || 0)),
    0
  )
  return {
    nodes: decodeNodeRows(res.rows),
    version,
    count: res.rows.length
  }
}

async function migrateRoomNodesFromJson(db, roomKey, obj, version) {
  return replaceRoomNodes(db, roomKey, obj, version)
}

module.exports = {
  padPosition,
  findRootUid,
  validateNodeGraph,
  encodeNodeRows,
  decodeNodeRows,
  structureSignature,
  graphsEqual,
  nodesDualWriteEnabled,
  nodesReadPreferEnabled,
  nodesTableAuthorityEnabled,
  canonicalizeNodes,
  pickAuthoritativeNodes,
  auditRoomNodesState,
  replaceRoomNodes,
  readRoomNodes,
  migrateRoomNodesFromJson
}
