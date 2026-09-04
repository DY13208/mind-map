const META_KEYS = [
  'theme',
  'themeConfig',
  'layout',
  'background',
  'lineStyle',
  'canvas',
  'title'
]

const VIEW_STATE_KEYS = [
  'zoom',
  'pan',
  'scale',
  'x',
  'y',
  'transform',
  'selection',
  'search',
  'minimap',
  'view',
  'viewData'
]

const VIEW_STATE_SET = new Set(VIEW_STATE_KEYS)

const STYLE_COMMAND_MATRIX = [
  {
    command: 'SET_NODE_STYLE',
    field: 'one style prop on node.data',
    operation: 'node.update',
    remoteApply: 'applyHttpRemoteNodeFields + reRender'
  },
  {
    command: 'SET_NODE_STYLES',
    field: 'style object on node.data',
    operation: 'node.update',
    remoteApply: 'applyHttpRemoteNodeFields + reRender'
  },
  {
    command: 'SET_NODE_SHAPE',
    field: 'shape',
    operation: 'node.update',
    remoteApply: 'applyHttpRemoteNodeFields + reRender'
  },
  {
    command: 'REMOVE_CUSTOM_STYLES',
    field: 'style keys -> null',
    operation: 'node.update',
    remoteApply: 'applyHttpRemoteNodeFields + reRender'
  },
  {
    command: 'REMOVE_ALL_NODE_CUSTOM_STYLES',
    field: 'style keys -> null (many uids)',
    operation: 'node.batch of node.update',
    remoteApply: 'applyHttpRemoteNodeFields + reRender'
  },
  {
    command: 'Painter / setStyles',
    field: 'copied style object',
    operation: 'node.update',
    remoteApply: 'applyHttpRemoteNodeFields + reRender'
  }
]

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stripViewState(input) {
  const next = { ...(input || {}) }
  VIEW_STATE_KEYS.forEach(key => {
    delete next[key]
  })
  return next
}

function pickMetaPatch(payload = {}) {
  if (!isPlainObject(payload)) return {}
  if (isPlainObject(payload.patch) && !payload.theme && !payload.layout && !payload.metadata) {
    return pickMetaPatch(payload.patch)
  }
  const out = {}
  META_KEYS.forEach(key => {
    if (payload[key] !== undefined) out[key] = payload[key]
  })
  if (isPlainObject(payload.metadata)) {
    Object.keys(payload.metadata).forEach(key => {
      if (VIEW_STATE_SET.has(key)) return
      if (out[key] === undefined && payload.metadata[key] !== undefined) {
        out[key] = payload.metadata[key]
      }
    })
  }
  if (isPlainObject(payload.patch)) {
    Object.keys(payload.patch).forEach(key => {
      if (VIEW_STATE_SET.has(key) || key === 'metadata' || key === 'patch') return
      if (payload.patch[key] !== undefined) out[key] = payload.patch[key]
    })
  }
  return stripViewState(out)
}

function mergeMapMetadata(prev = {}, patch = {}) {
  const next = stripViewState(prev)
  const clean = pickMetaPatch(patch)
  Object.keys(clean).forEach(key => {
    if (clean[key] === null) delete next[key]
    else next[key] = clean[key]
  })
  return next
}

function hydrateRoomMetadata(rowOrMeta = {}) {
  const metadata = isPlainObject(rowOrMeta.metadata)
    ? stripViewState(rowOrMeta.metadata)
    : stripViewState(rowOrMeta)
  const hasShared =
    metadata.theme != null ||
    metadata.layout != null ||
    metadata.themeConfig != null ||
    Object.keys(metadata).length > 0
  return {
    metadata,
    theme: metadata.theme,
    themeConfig: metadata.themeConfig,
    layout: metadata.layout,
    source: hasShared ? 'server metadata' : 'default'
  }
}

function canonicalStructureFromGraph(graph = {}) {
  return Object.keys(graph)
    .filter(uid => graph[uid] && !graph[uid].deleted)
    .map(uid => {
      const row = graph[uid]
      return {
        uid,
        parent_uid: row.parent_uid || null,
        position: String(row.position || '')
      }
    })
    .sort((a, b) => String(a.uid).localeCompare(String(b.uid)))
}

function structureSignature(rows) {
  return JSON.stringify(rows || [])
}

async function getRoomMetadata(db, roomKey) {
  const res = await db.query(
    `select metadata, version, title from rooms where room_key = $1`,
    [roomKey]
  )
  const row = res.rows[0]
  if (!row) return { metadata: {}, version: 0, title: '' }
  return {
    metadata: row.metadata || {},
    version: Number(row.version || 0),
    title: row.title || ''
  }
}

async function updateRoomMetadata(db, roomKey, patch, options = {}) {
  const current = await getRoomMetadata(db, roomKey)
  const next = mergeMapMetadata(current.metadata, patch)
  const title =
    options.title != null
      ? String(options.title).trim().slice(0, 80)
      : undefined
  await db.query(
    `update rooms
     set metadata = coalesce(metadata, '{}'::jsonb) || $2::jsonb,
         title = coalesce($3, title),
         updated_at = now()
     where room_key = $1`,
    [roomKey, JSON.stringify(next), title || null]
  )
  return { metadata: next, version: current.version, title: title || current.title }
}

module.exports = {
  META_KEYS,
  VIEW_STATE_KEYS,
  STYLE_COMMAND_MATRIX,
  stripViewState,
  pickMetaPatch,
  mergeMapMetadata,
  hydrateRoomMetadata,
  canonicalStructureFromGraph,
  structureSignature,
  getRoomMetadata,
  updateRoomMetadata
}
