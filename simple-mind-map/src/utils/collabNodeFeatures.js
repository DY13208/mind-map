const NODE_FEATURE_STRUCTURAL_KEYS = [
  'parentUid',
  'parent_uid',
  'parent',
  'index',
  'position',
  'order'
]

const NODE_FEATURE_MATRIX = [
  {
    feature: 'RichText',
    uiEntry: 'RichTextToolbar / Quill hideEditText',
    command: 'SET_NODE_TEXT',
    fields: ['text', 'richText'],
    operation: 'node.update',
    pgField: 'room_nodes.data.text + data.richText',
    remoteApply: 'applyHttpRemoteNodeFields patch-only + reRender',
    undoRedo: 'inverse patch of text/richText',
    refreshPersistence: true,
    status: 'fixed'
  },
  {
    feature: 'Note',
    uiEntry: 'Toolbar showNodeNote / NodeNote / NodeNoteSidebar',
    command: 'SET_NODE_NOTE',
    fields: ['note'],
    operation: 'node.update',
    pgField: 'room_nodes.data.note',
    remoteApply: 'applyHttpRemoteNodeFields patch-only',
    undoRedo: 'inverse patch of note',
    refreshPersistence: true,
    status: 'pass'
  },
  {
    feature: 'Tag',
    uiEntry: 'Toolbar showNodeTag / NodeTag / NodeTagStyle',
    command: 'SET_NODE_TAG',
    fields: ['tag'],
    operation: 'node.update | node.batch',
    pgField: 'room_nodes.data.tag',
    remoteApply: 'applyHttpRemoteNodeFields patch-only',
    undoRedo: 'inverse patch of tag array',
    refreshPersistence: true,
    status: 'pass'
  },
  {
    feature: 'Hyperlink',
    uiEntry: 'Toolbar showNodeLink / NodeHyperlink',
    command: 'SET_NODE_HYPERLINK',
    fields: ['hyperlink', 'hyperlinkTitle'],
    operation: 'node.update',
    pgField: 'room_nodes.data.hyperlink + data.hyperlinkTitle',
    remoteApply: 'applyHttpRemoteNodeFields patch-only',
    undoRedo: 'inverse patch of hyperlink fields',
    refreshPersistence: true,
    status: 'pass'
  },
  {
    feature: 'Icon',
    uiEntry: 'Toolbar / NodeIcon / NodeIconSidebar',
    command: 'SET_NODE_ICON',
    fields: ['icon'],
    operation: 'node.update | node.batch',
    pgField: 'room_nodes.data.icon',
    remoteApply: 'applyHttpRemoteNodeFields patch-only',
    undoRedo: 'inverse patch of icon array',
    refreshPersistence: true,
    status: 'pass'
  },
  {
    feature: 'Image',
    uiEntry: 'Toolbar showNodeImage / NodeImage',
    command: 'SET_NODE_IMAGE',
    fields: ['image', 'imageTitle', 'imageSize'],
    operation: 'node.update',
    pgField: 'room_nodes.data.image + imageTitle + imageSize',
    remoteApply: 'applyHttpRemoteNodeFields patch-only',
    undoRedo: 'inverse patch of image group',
    refreshPersistence: true,
    status: 'pass-with-base64-risk'
  },
  {
    feature: 'Image Resize',
    uiEntry: 'NodeImgAdjust plugin drag handle',
    command: 'SET_NODE_IMAGE',
    fields: ['imageSize'],
    operation: 'node.update',
    pgField: 'room_nodes.data.imageSize',
    remoteApply: 'applyHttpRemoteNodeFields patch-only + size + connector',
    undoRedo: 'inverse patch of imageSize',
    refreshPersistence: true,
    status: 'pass'
  },
  {
    feature: 'Formula',
    uiEntry: 'Toolbar formula / FormulaSidebar',
    command: 'INSERT_FORMULA → SET_NODE_TEXT',
    fields: ['text', 'richText'],
    operation: 'node.update',
    pgField: 'room_nodes.data.text (ql-formula data-value LaTeX)',
    remoteApply: 'applyHttpRemoteNodeFields patch-only',
    undoRedo: 'inverse richText HTML',
    refreshPersistence: true,
    status: 'fixed-via-richtext'
  },
  {
    feature: 'Painter',
    uiEntry: 'Toolbar painter → node_click',
    command: 'SET_NODE_STYLES',
    fields: ['style keys only'],
    operation: 'node.update',
    pgField: 'room_nodes.data.<style keys>',
    remoteApply: 'applyHttpRemoteNodeFields patch-only',
    undoRedo: 'inverse style keys',
    refreshPersistence: true,
    status: 'pass'
  },
  {
    feature: 'Shape',
    uiEntry: 'Style sidebar shape',
    command: 'SET_NODE_SHAPE / SET_NODE_STYLE(shape)',
    fields: ['shape'],
    operation: 'node.update',
    pgField: 'room_nodes.data.shape',
    remoteApply: 'applyHttpRemoteNodeFields patch-only',
    undoRedo: 'inverse shape',
    refreshPersistence: true,
    status: 'pass'
  },
  {
    feature: 'Style',
    uiEntry: 'Style sidebar',
    command: 'SET_NODE_STYLE / SET_NODE_STYLES',
    fields: [
      'fontSize',
      'fontFamily',
      'fontWeight',
      'fontStyle',
      'color',
      'fillColor',
      'borderColor',
      'borderWidth',
      'borderRadius',
      'lineColor',
      'paddingX',
      'paddingY',
      'shape'
    ],
    operation: 'node.update | node.batch',
    pgField: 'room_nodes.data.<flat style keys>',
    remoteApply: 'applyHttpRemoteNodeFields patch-only',
    undoRedo: 'inverse style keys',
    refreshPersistence: true,
    status: 'pass'
  },
  {
    feature: 'mapRef',
    uiEntry: 'Contextmenu + MapRefDialog',
    command: 'SET_NODE_MAP_REF',
    fields: ['mapRef'],
    operation: 'node.update',
    pgField: 'room_nodes.data.mapRef',
    remoteApply: 'applyHttpRemoteNodeFields patch-only',
    undoRedo: 'inverse mapRef',
    refreshPersistence: true,
    status: 'pass'
  },
  {
    feature: 'Attachment',
    uiEntry: 'Toolbar attachment (commented out)',
    command: 'SET_NODE_ATTACHMENT',
    fields: ['attachmentUrl', 'attachmentName'],
    operation: 'node.update',
    pgField: 'room_nodes.data.attachmentUrl + attachmentName',
    remoteApply: 'applyHttpRemoteNodeFields patch-only',
    undoRedo: 'inverse attachment fields',
    refreshPersistence: false,
    status: 'not enabled'
  }
]

function isCollabImageKey(url) {
  return typeof url === 'string' && /^smm_img_key_/.test(url)
}

function isCollabBase64Image(url) {
  return typeof url === 'string' && /^data:/i.test(url)
}

function resolveCollabImage(image, imgMap) {
  if (!image || typeof image !== 'string') return image || null
  if (isCollabImageKey(image)) {
    const mapped = imgMap && imgMap[image]
    return mapped || image
  }
  return image
}

function collabImagePayloadRisk(image) {
  if (!image) return 'empty'
  if (isCollabBase64Image(image)) return 'base64'
  if (isCollabImageKey(image)) return 'key-unresolved'
  return 'url'
}

const NULLABLE_FEATURE_GROUPS = {
  image: ['image', 'imageTitle', 'imageSize'],
  hyperlink: ['hyperlink', 'hyperlinkTitle'],
  tag: ['tag'],
  icon: ['icon'],
  mapRef: ['mapRef']
}

function isEmptyFeatureValue(key, value) {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    (key === 'imageSize' &&
      value &&
      typeof value === 'object' &&
      !value.width &&
      !value.height &&
      !value.custom)
  )
}

function applyNullableGroupClears(full, data = {}, prevFull = null) {
  Object.keys(NULLABLE_FEATURE_GROUPS).forEach(group => {
    const keys = NULLABLE_FEATURE_GROUPS[group]
    const hadPrev = !!(prevFull && keys.some(key => !isEmptyFeatureValue(key, prevFull[key])))
    const hadNow = keys.some(key =>
      Object.prototype.hasOwnProperty.call(data, key)
    )
    const nowEmpty = keys.every(key => isEmptyFeatureValue(key, data[key]))
    if ((hadPrev || hadNow) && nowEmpty) {
      keys.forEach(key => {
        full[key] = null
      })
    }
  })
  return full
}

function buildNodeContentFields(data = {}, prevFull = null) {
  const isRich = !!data.richText
  const text = String(data.text == null ? '' : data.text)
  const out = {
    text,
    note: data.note || ''
  }
  if (isRich) out.richText = true
  else if (prevFull && prevFull.richText) out.richText = null
  return out
}

function extractFormulaLatexFromHtml(html) {
  const text = String(html || '')
  const out = []
  const re = /class="ql-formula"[^>]*data-value="([^"]*)"/g
  let match
  while ((match = re.exec(text))) {
    out.push(String(match[1] || '').replace(/&quot;/g, '"'))
  }
  return out
}

function painterStyleOnly(sourceData, checkIsNodeStyleDataKey) {
  const style = {}
  Object.keys(sourceData || {}).forEach(key => {
    if (typeof checkIsNodeStyleDataKey === 'function') {
      if (checkIsNodeStyleDataKey(key)) style[key] = sourceData[key]
      return
    }
    if (
      key === 'uid' ||
      key === 'parent' ||
      key === 'position' ||
      key === 'generalization' ||
      key === 'mapRef' ||
      key === 'text' ||
      key === 'note' ||
      key === 'tag' ||
      key === 'image'
    ) {
      return
    }
    style[key] = sourceData[key]
  })
  return style
}

function featureStructuralHits(payload = {}) {
  return NODE_FEATURE_STRUCTURAL_KEYS.filter(
    key => payload && payload[key] !== undefined
  )
}

function stripFeatureStructuralKeys(payload = {}) {
  const next = { ...(payload || {}) }
  const hit = featureStructuralHits(next)
  hit.forEach(key => {
    delete next[key]
  })
  return { payload: next, hit }
}

function guardFeatureStructuralMutation(payload = {}) {
  const stripped = stripFeatureStructuralKeys(payload)
  return {
    ...stripped,
    label: stripped.hit.length ? 'NODE_FEATURE_STRUCTURAL_MUTATION' : null
  }
}

function isRichHtml(text) {
  return /<\/?[a-z][\s\S]*>/i.test(String(text || ''))
}

function shouldPreserveRichHtml(data = {}) {
  return !!(data && data.richText && isRichHtml(data.text))
}

const UNDO_CONTROL_KEYS = [
  'targetOperationId',
  'target_operation_id',
  'targetOpId',
  'clientSeq',
  'baseRevision',
  'baseVersion',
  'confirm_sop_change',
  'undoOf',
  'redoOf',
  'ops',
  'traceId',
  'clientId',
  'client_id'
]

const FEATURE_RECREATE_KEYS = {
  text: ['text'],
  richText: ['text'],
  resetRichText: ['text'],
  note: ['note'],
  tag: ['tag'],
  icon: ['icon'],
  image: ['image'],
  imageTitle: ['image'],
  imageSize: ['image'],
  hyperlink: ['hyperlink'],
  hyperlinkTitle: ['hyperlink'],
  mapRef: ['mapRef'],
  formula: ['text'],
  shape: ['text'],
  fillColor: ['text'],
  fontSize: ['text'],
  fontFamily: ['text'],
  fontWeight: ['text'],
  fontStyle: ['text'],
  color: ['text']
}

const GEOMETRY_KEYS = {
  text: true,
  richText: true,
  tag: true,
  icon: true,
  image: true,
  imageSize: true,
  formula: true,
  hyperlink: true,
  hyperlinkTitle: true,
  mapRef: true,
  note: true,
  shape: true,
  fontSize: true,
  paddingX: true,
  paddingY: true
}

function isUndoControlPayload(payload) {
  if (!payload || typeof payload !== 'object') return false
  if (payload.uid && (payload.patch || payload.data || payload.tag || payload.note || payload.image || payload.mapRef || payload.hyperlink || payload.text != null)) {
    return false
  }
  return !!(
    payload.targetOperationId ||
    payload.target_operation_id ||
    payload.targetOpId
  )
}

function payloadFeaturePatch(payload) {
  if (payload && Object.prototype.hasOwnProperty.call(payload, 'patch')) {
    return { ...(payload.patch || {}) }
  }
  const data = { ...((payload && (payload.data || payload)) || {}) }
  ;['uid', 'traceId', 'clientId', 'client_id', 'operationId'].forEach(key => {
    delete data[key]
  })
  NODE_FEATURE_STRUCTURAL_KEYS.forEach(key => {
    delete data[key]
  })
  UNDO_CONTROL_KEYS.forEach(key => {
    delete data[key]
  })
  return data
}

function normalizeAppliedUpdatePayload(op) {
  const event = (op && op.event) || {}
  const eventPayload = (event && event.payload) || {}
  const opPayload = (op && op.payload) || {}
  const preferred = !isUndoControlPayload(eventPayload)
    ? eventPayload
    : !isUndoControlPayload(opPayload)
      ? opPayload
      : eventPayload
  const patch =
    (preferred && preferred.patch) ||
    (eventPayload && eventPayload.patch) ||
    (opPayload && opPayload.patch) ||
    null
  const uid =
    preferred.uid ||
    eventPayload.uid ||
    opPayload.uid ||
    (op && (op.targetId || op.target_id)) ||
    ''
  const next = payloadFeaturePatch(
    patch
      ? { uid, patch }
      : preferred && Object.keys(preferred).length
        ? preferred
        : eventPayload
  )
  return {
    uid,
    patch: next,
    payload: { uid, patch: next }
  }
}

function recreateTypesFromPatch(patch = {}) {
  const types = new Set()
  Object.keys(patch || {}).forEach(key => {
    const list = FEATURE_RECREATE_KEYS[key]
    if (list) list.forEach(item => types.add(item))
    else types.add('text')
  })
  return Array.from(types)
}

function needsGeometryRefresh(patch = {}) {
  return Object.keys(patch || {}).some(key => GEOMETRY_KEYS[key])
}

function publishUndoApplyTrace(row = {}) {
  const next = {
    timestamp: Date.now(),
    ...row
  }
  if (typeof window === 'undefined') return next
  window.__UNDO_APPLY_TRACE__ = next
  if (!Array.isArray(window.__UNDO_APPLY_TRACE_LOG__)) {
    window.__UNDO_APPLY_TRACE_LOG__ = []
  }
  window.__UNDO_APPLY_TRACE_LOG__.push(next)
  if (window.__UNDO_APPLY_TRACE_LOG__.length > 50) {
    window.__UNDO_APPLY_TRACE_LOG__.shift()
  }
  return next
}

function publishRichTextPersistTrace(row = {}) {
  const next = {
    timestamp: Date.now(),
    ...row
  }
  if (typeof window === 'undefined') return next
  window.__RICHTEXT_PERSIST_TRACE__ = next
  if (!Array.isArray(window.__RICHTEXT_PERSIST_TRACE_LOG__)) {
    window.__RICHTEXT_PERSIST_TRACE_LOG__ = []
  }
  window.__RICHTEXT_PERSIST_TRACE_LOG__.push(next)
  if (window.__RICHTEXT_PERSIST_TRACE_LOG__.length > 50) {
    window.__RICHTEXT_PERSIST_TRACE_LOG__.shift()
  }
  return next
}

function siblingUids(parentNode) {
  const kids =
    (parentNode &&
      parentNode.nodeData &&
      parentNode.nodeData.children) ||
    (parentNode && parentNode.children) ||
    []
  return kids
    .map(child => (child && child.data && child.data.uid) || (child && child.uid))
    .filter(Boolean)
}

function publishNodeFeatureMatrix() {
  if (typeof window === 'undefined') return NODE_FEATURE_MATRIX
  window.__NODE_FEATURE_MATRIX__ = NODE_FEATURE_MATRIX
  return NODE_FEATURE_MATRIX
}

const api = {
  NODE_FEATURE_MATRIX,
  NODE_FEATURE_STRUCTURAL_KEYS,
  isCollabImageKey,
  isCollabBase64Image,
  resolveCollabImage,
  collabImagePayloadRisk,
  buildNodeContentFields,
  applyNullableGroupClears,
  isEmptyFeatureValue,
  NULLABLE_FEATURE_GROUPS,
  extractFormulaLatexFromHtml,
  painterStyleOnly,
  featureStructuralHits,
  stripFeatureStructuralKeys,
  guardFeatureStructuralMutation,
  payloadFeaturePatch,
  isRichHtml,
  shouldPreserveRichHtml,
  isUndoControlPayload,
  normalizeAppliedUpdatePayload,
  recreateTypesFromPatch,
  needsGeometryRefresh,
  publishUndoApplyTrace,
  publishRichTextPersistTrace,
  siblingUids,
  publishNodeFeatureMatrix
}

module.exports = api
module.exports.default = api
