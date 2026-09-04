import { checkIsNodeStyleDataKey } from './index'

export const MAP_META_KEYS = [
  'theme',
  'themeConfig',
  'layout',
  'background',
  'lineStyle',
  'canvas',
  'title'
]

export const VIEW_STATE_KEYS = [
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

export const STYLE_COMMAND_MATRIX = [
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

export function stripViewState(input) {
  const next = { ...(input || {}) }
  VIEW_STATE_KEYS.forEach(key => {
    delete next[key]
  })
  return next
}

export function pickLiveMetaPatch(payload = {}) {
  if (!isPlainObject(payload)) return {}
  if (isPlainObject(payload.patch)) {
    const fromPatch = {}
    MAP_META_KEYS.forEach(key => {
      if (payload.patch[key] !== undefined) fromPatch[key] = payload.patch[key]
    })
    return stripViewState(fromPatch)
  }
  const out = {}
  MAP_META_KEYS.forEach(key => {
    if (payload[key] !== undefined) out[key] = payload[key]
  })
  return stripViewState(out)
}

export function hydrateSharedMetadata(input = {}) {
  const metadata = isPlainObject(input.metadata)
    ? stripViewState(input.metadata)
    : stripViewState(input)
  const theme = input.theme != null ? input.theme : metadata.theme
  const layout = input.layout != null ? input.layout : metadata.layout
  const themeConfig =
    input.themeConfig != null ? input.themeConfig : metadata.themeConfig
  const hasShared = theme != null || layout != null || themeConfig != null
  return {
    metadata: {
      ...metadata,
      ...(theme != null ? { theme } : {}),
      ...(layout != null ? { layout } : {}),
      ...(themeConfig != null ? { themeConfig } : {})
    },
    theme,
    layout,
    themeConfig,
    source: hasShared ? 'server metadata' : 'default'
  }
}

export function collectStyleFields(data = {}, prevFull = null) {
  const out = {}
  Object.keys(data || {}).forEach(key => {
    if (!checkIsNodeStyleDataKey(key)) return
    if (data[key] === undefined) return
    out[key] = data[key]
  })
  if (prevFull) {
    Object.keys(prevFull).forEach(key => {
      if (!checkIsNodeStyleDataKey(key)) return
      if (out[key] === undefined && prevFull[key] != null) {
        out[key] = null
      }
    })
  }
  return out
}

export function canonicalStructureFromTree(root) {
  const rows = []
  const walk = (node, parentUid, index) => {
    if (!node) return
    const data = node.data || (node.nodeData && node.nodeData.data) || {}
    const uid = data.uid || node.uid
    if (uid) {
      rows.push({
        uid,
        parent_uid: parentUid || null,
        position: String(data.position != null ? data.position : index)
      })
    }
    const kids = node.children || (node.nodeData && node.nodeData.children) || []
    kids.forEach((child, i) => walk(child, uid, i))
  }
  walk(root, null, 0)
  rows.sort((a, b) => String(a.uid).localeCompare(String(b.uid)))
  return rows
}

export function structureSignature(rows) {
  return JSON.stringify(rows || [])
}

export function publishMapMetaState(partial = {}) {
  if (typeof window === 'undefined') return null
  const prev = window.__MAP_META_STATE__ || {}
  const next = {
    roomKey: partial.roomKey != null ? partial.roomKey : prev.roomKey || '',
    serverMetadata:
      partial.serverMetadata != null
        ? partial.serverMetadata
        : prev.serverMetadata || {},
    appliedTheme:
      partial.appliedTheme != null ? partial.appliedTheme : prev.appliedTheme || '',
    appliedLayout:
      partial.appliedLayout != null
        ? partial.appliedLayout
        : prev.appliedLayout || '',
    lastMetaRevision:
      partial.lastMetaRevision != null
        ? partial.lastMetaRevision
        : prev.lastMetaRevision || 0,
    source: partial.source || prev.source || 'default'
  }
  window.__MAP_META_STATE__ = next
  return next
}

export function warnStructuralMutation(kind, before, after) {
  const label =
    kind === 'layout' ? 'LAYOUT_STRUCTURAL_MUTATION' : 'THEME_STRUCTURAL_MUTATION'
  const message = {
    kind,
    before,
    after
  }
  if (typeof console !== 'undefined' && console.error) {
    console.error(label, message)
  }
  return label
}
