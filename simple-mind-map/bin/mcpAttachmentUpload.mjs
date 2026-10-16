import fs from 'node:fs/promises'
import path from 'node:path'

// JSON base64 upload shares the HTTP 32MiB body budget; leave headroom.
export const MAX_MCP_UPLOAD_BYTES = 24 * 1024 * 1024

function guessFileNameFromUrl(sourceUrl) {
  try {
    const name = decodeURIComponent(
      new URL(sourceUrl).pathname.split('/').pop() || ''
    )
    return name || 'file'
  } catch (e) {
    return 'file'
  }
}

function toForwardSlashes(p) {
  return String(p || '').replace(/\\/g, '/')
}

/**
 * Map host / OpenClaw paths to paths readable inside the app container.
 * - WorkBuddy: C:\\Users\\...\\WorkBuddy\\x → /workbuddy/x
 * - OpenClaw:  .../.openclaw/workspace/output/x → /app/output/x
 */
export function remapAttachmentFilePath(filePath, env = process.env) {
  const raw = String(filePath || '').trim()
  if (!raw) return raw
  const forward = toForwardSlashes(raw)

  if (
    forward.startsWith('/workbuddy/') ||
    forward === '/workbuddy' ||
    forward.startsWith('/app/output/') ||
    forward === '/app/output'
  ) {
    return forward
  }

  const ocMarker = '/.openclaw/workspace/output/'
  const ocIdx = forward.toLowerCase().indexOf(ocMarker)
  if (ocIdx >= 0) {
    const rest = forward.slice(ocIdx + ocMarker.length)
    return path.posix.join('/app/output', rest)
  }
  if (forward.startsWith('/home/node/.openclaw/workspace/output/')) {
    return path.posix.join(
      '/app/output',
      forward.slice('/home/node/.openclaw/workspace/output/'.length)
    )
  }

  const mount = (
    String(env.WORKBUDDY_MOUNT || '/workbuddy').trim() || '/workbuddy'
  ).replace(/\/+$/, '')
  const hostCandidates = [env.WORKBUDDY_HOST_DIR, env.WORKBUDDY_DATA_DIR]
    .map(item => String(item || '').trim())
    .filter(Boolean)

  for (const host of hostCandidates) {
    const hostFwd = toForwardSlashes(host).replace(/\/+$/, '')
    if (!hostFwd) continue
    const lower = forward.toLowerCase()
    const hostLower = hostFwd.toLowerCase()
    if (lower === hostLower) return mount
    if (lower.startsWith(hostLower + '/')) {
      const rest = forward.slice(hostFwd.length).replace(/^\/+/, '')
      return path.posix.join(mount, rest)
    }
  }

  // Host project output folder (…/output/foo.pdf) when mounted at /app/output
  const outMatch = forward.match(/(?:^|\/)output\/(.+)$/i)
  if (outMatch && !/workbuddy/i.test(forward)) {
    return path.posix.join('/app/output', outMatch[1])
  }

  return raw
}

/**
 * Resolve MCP upload inputs into the JSON body expected by
 * POST /api/files/:room/attachments (contentBase64 | sourceUrl).
 * Same backend path the toolbar「附件」button uses.
 */
export async function resolveAttachmentUploadInput(input = {}) {
  const fileNameHint = String(input.file_name || '').trim()
  let contentBase64 = String(input.content_base64 || '').trim()
  const sourceUrl = String(input.source_url || '').trim()
  const filePathRaw = String(input.file_path || '').trim()
  const filePath = filePathRaw
    ? remapAttachmentFilePath(filePathRaw)
    : ''
  const mimeType = String(input.mime_type || '').trim()
  let fileName = fileNameHint

  if (filePath) {
    let buf
    try {
      buf = await fs.readFile(filePath)
    } catch (err) {
      const msg = err && err.code === 'ENOENT' ? '文件不存在' : '无法读取文件'
      const hint =
        filePath !== filePathRaw
          ? `（已映射 ${filePathRaw} → ${filePath}）`
          : ''
      throw new Error(
        `${msg}: ${filePath}${hint}。Docker 下请把产物放到 WorkBuddy 目录或 ./output，或改传 content_base64`
      )
    }
    if (buf.length > MAX_MCP_UPLOAD_BYTES) {
      throw new Error(
        `文件过大（${buf.length} 字节，上限 ${MAX_MCP_UPLOAD_BYTES}），请改用较小文件`
      )
    }
    contentBase64 = buf.toString('base64')
    if (!fileName) {
      fileName =
        path.basename(filePathRaw.replace(/\\/g, '/')) ||
        path.basename(filePath) ||
        'file'
    }
  } else if (contentBase64) {
    const approx = Math.floor((contentBase64.replace(/\s/g, '').length * 3) / 4)
    if (approx > MAX_MCP_UPLOAD_BYTES) {
      throw new Error(
        `content_base64 过大（约 ${approx} 字节，上限 ${MAX_MCP_UPLOAD_BYTES}）`
      )
    }
  } else if (!sourceUrl) {
    throw new Error('请提供 file_path、content_base64 或 source_url 之一')
  }

  if (!fileName) {
    fileName = sourceUrl ? guessFileNameFromUrl(sourceUrl) : 'file'
  }

  return {
    fileName,
    mimeType: mimeType || undefined,
    contentBase64: contentBase64 || undefined,
    sourceUrl: sourceUrl || undefined,
    nodeUid: String(input.node || input.node_uid || '').trim(),
    resolvedPath: filePath || undefined
  }
}

/** Match toolbar「附件」/ SET_NODE_ATTACHMENT node data fields. */
export function attachmentMetaForNode(attachment = {}) {
  const status = String(attachment.status || 'ready')
  const ready = status === 'ready' || status === 'failed'
  return {
    attachmentUrl: '',
    attachmentName: attachment.fileName || attachment.file_name || '附件',
    attachmentId: attachment.id || '',
    attachmentMimeType: attachment.mimeType || attachment.mime_type || '',
    attachmentStatus: status,
    attachmentError: attachment.errorMessage || attachment.error_message || '',
    attachmentExtractedText: String(
      attachment.extractedText || attachment.extracted_text || ''
    ).slice(0, 2400),
    attachmentProgress: ready ? 100 : 100
  }
}

const ATTACHMENT_EXPECTED_FIELDS = [
  'attachmentId',
  'attachmentUrl',
  'attachmentName'
]
const ATTACHMENT_REQUIRED_MOUNT_FIELDS = [
  'attachmentId',
  'attachmentUrl',
  'attachmentName'
]
const VALID_ATTACHMENT_STATUSES = new Set([
  'pending',
  'processing',
  'ready',
  'failed'
])

const RETRYABLE_HTTP_STATUSES = new Set([408, 423, 429, 502, 503, 504])
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'ERR_SOCKET_TIMEOUT'
])

export class AttachmentUploadWorkflowError extends Error {
  constructor(message, code, details = {}, cause) {
    super(message)
    this.name = 'AttachmentUploadWorkflowError'
    this.code = code
    this.details = details
    const statusCode = Number(cause && (cause.statusCode || cause.status_code))
    if (Number.isFinite(statusCode) && statusCode > 0) {
      this.statusCode = statusCode
    }
    if (cause) this.cause = cause
  }
}

function causeDetails(error) {
  if (!error) return {}
  return {
    cause_code: error.code || '',
    cause_status_code: Number(error.statusCode || error.status_code) || 0,
    cause_message: String(error.message || error).slice(0, 500)
  }
}

function errorChain(error) {
  const result = []
  const seen = new Set()
  let current = error
  while (current && !seen.has(current) && result.length < 4) {
    result.push(current)
    seen.add(current)
    current = current.cause
  }
  return result
}

export function isRetryableAttachmentMountError(error) {
  const chain = errorChain(error)
  return chain.some(item => {
    const status = Number(item.statusCode || item.status_code)
    if (RETRYABLE_HTTP_STATUSES.has(status)) return true
    if (item.code === 'REPLACE_IN_PROGRESS') return true
    if (/正在保存整图/.test(String(item.message || ''))) return true
    if (item.name === 'TimeoutError') return true
    return RETRYABLE_NETWORK_CODES.has(String(item.code || ''))
  })
}

function nodeExpectedSnapshot(data = {}) {
  const expected = {}
  ATTACHMENT_EXPECTED_FIELDS.forEach(key => {
    expected[key] = Object.prototype.hasOwnProperty.call(data, key)
      ? data[key]
      : null
  })
  const fieldVersions = data.__fv
  if (
    fieldVersions &&
    typeof fieldVersions === 'object' &&
    Object.prototype.hasOwnProperty.call(fieldVersions, 'attachment')
  ) {
    expected['__fv.attachment'] = fieldVersions.attachment
  }
  return expected
}

function attachmentMountIsPersisted(actual, expected) {
  if (!actual) return false
  if (
    !ATTACHMENT_REQUIRED_MOUNT_FIELDS.every(key => actual[key] === expected[key])
  ) {
    return false
  }
  return VALID_ATTACHMENT_STATUSES.has(
    String(actual.attachmentStatus || '').trim().toLowerCase()
  )
}

/**
 * Resolve the requested node from the supported /nodes read-back shapes.
 * Current APIs return an array; older callers may provide a UID-keyed map.
 * In either case, an explicitly reported UID must agree with the requested UID.
 */
export function readbackNodeByUid(readback, nodeUid) {
  const targetUid = String(nodeUid || '').trim()
  const nodes = readback && readback.nodes
  if (!targetUid || !nodes || typeof nodes !== 'object') return null

  const explicitUid = node => {
    if (!node || typeof node !== 'object') return ''
    const outerUid = String(node.uid || '').trim()
    const dataUid = String((node.data && node.data.uid) || '').trim()
    if (outerUid && dataUid && outerUid !== dataUid) return null
    return outerUid || dataUid
  }
  const matches = node => {
    const uid = explicitUid(node)
    return uid === null || (uid && uid !== targetUid) ? null : node
  }

  if (Array.isArray(nodes)) {
    return nodes.find(node => {
      const uid = explicitUid(node)
      return uid === targetUid
    }) || null
  }

  if (!Object.prototype.hasOwnProperty.call(nodes, targetUid)) return null
  return matches(nodes[targetUid])
}

function attachmentWorkflowError(message, code, details, cause) {
  return new AttachmentUploadWorkflowError(
    message,
    code,
    { ...details, ...causeDetails(cause) },
    cause
  )
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function safeRevision(value) {
  const present =
    typeof value === 'number' ||
    (typeof value === 'string' && value.trim() !== '')
  if (!present) return null
  const revision = Number(value)
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null
}

/**
 * Upload the bytes once, then attach them to the node with bounded, idempotent
 * retries. The final success decision always comes from a fresh node read.
 */
export async function uploadAttachmentAndMountNode({
  api,
  roomKey,
  nodeRef,
  uploadInput = {},
  confirmSopChange = false,
  operationId,
  maxMountAttempts = 3,
  delay = wait
} = {}) {
  if (typeof api !== 'function') throw new TypeError('api must be a function')
  const room = String(roomKey || '').trim()
  const target = String(nodeRef || '').trim()
  const fileName = String(uploadInput.fileName || '').trim() || 'file'
  if (!room) {
    throw attachmentWorkflowError('缺少 room_key，附件未上传', 'ROOM_KEY_REQUIRED', {
      phase: 'locate',
      file_name: fileName
    })
  }
  if (!target) {
    throw attachmentWorkflowError('缺少目标节点，附件未上传', 'NODE_REQUIRED', {
      phase: 'locate',
      room_key: room,
      file_name: fileName
    })
  }
  const stableOperationId = String(operationId || '').trim()
  if (!stableOperationId) {
    throw attachmentWorkflowError('缺少挂载 operationId，附件未上传', 'OPERATION_ID_REQUIRED', {
      phase: 'locate',
      room_key: room,
      file_name: fileName
    })
  }

  let located
  try {
    located = await api(
      `/api/files/${encodeURIComponent(room)}/locate?uid=${encodeURIComponent(target)}`,
      { timeoutMs: 15000 }
    )
  } catch (error) {
    throw attachmentWorkflowError(
      '无法定位目标节点，附件未上传',
      'ATTACHMENT_NODE_LOCATE_FAILED',
      { phase: 'locate', room_key: room, node_ref: target, file_name: fileName },
      error
    )
  }

  const nodeUid = String((located && located.uid) || '').trim()
  const locatedNodes = (located && located.nodes) || {}
  const locatedNode = nodeUid && locatedNodes[nodeUid]
  const nodeData = locatedNode && locatedNode.data
  if (
    !nodeUid ||
    !nodeData ||
    String(nodeData.uid || '').trim() !== nodeUid
  ) {
    throw attachmentWorkflowError(
      '节点定位结果无效，附件未上传',
      'ATTACHMENT_NODE_UID_INVALID',
      {
        phase: 'locate',
        room_key: room,
        node_ref: target,
        node_uid: nodeUid || null,
        file_name: fileName
      }
    )
  }

  const baseVersion = safeRevision(located && located.version)
  if (baseVersion === null) {
    throw attachmentWorkflowError(
      '节点定位结果缺少有效修订号，附件未上传',
      'ATTACHMENT_NODE_REVISION_INVALID',
      { phase: 'locate', room_key: room, node_uid: nodeUid, file_name: fileName }
    )
  }
  const expected = nodeExpectedSnapshot(nodeData)

  const uploadBody = {
    fileName,
    nodeUid,
    sourceKind: 'attachment'
  }
  if (uploadInput.mimeType) uploadBody.mimeType = uploadInput.mimeType
  if (uploadInput.contentBase64) uploadBody.contentBase64 = uploadInput.contentBase64
  if (uploadInput.sourceUrl) uploadBody.sourceUrl = uploadInput.sourceUrl

  let uploaded
  try {
    uploaded = await api(
      `/api/files/${encodeURIComponent(room)}/attachments`,
      {
        method: 'POST',
        body: JSON.stringify(uploadBody),
        timeoutMs: 120000
      }
    )
  } catch (error) {
    const status = Number(error.statusCode || error.status_code)
    throw attachmentWorkflowError(
      '附件上传请求失败；为避免重复上传，本次没有重试 POST',
      'ATTACHMENT_UPLOAD_FAILED',
      {
        phase: 'upload',
        room_key: room,
        node_uid: nodeUid,
        file_name: fileName,
        upload_outcome: status >= 400 && status < 500 ? 'rejected' : 'unknown'
      },
      error
    )
  }

  const attachment = (uploaded && uploaded.attachment) || uploaded || {}
  const attachmentId = String(attachment.id || '').trim()
  const context = {
    room_key: room,
    node_uid: nodeUid,
    attachment_id: attachmentId || null,
    file_name: attachment.fileName || attachment.file_name || fileName,
    operation_id: stableOperationId,
    base_version: baseVersion,
    attachment_saved: true
  }
  if (!attachmentId) {
    throw attachmentWorkflowError(
      '附件已保存但响应缺少 attachment.id，节点未挂载',
      'ATTACHMENT_ID_MISSING',
      { ...context, phase: 'upload_response' }
    )
  }

  const patch = attachmentMetaForNode(attachment)
  const attempts = Math.max(1, Math.min(3, Math.floor(Number(maxMountAttempts) || 3)))
  let mountAttempts = 0
  let mountError = null
  let mountResponse = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    mountAttempts = attempt
    try {
      mountResponse = await api(
        `/api/files/${encodeURIComponent(room)}/nodes/${encodeURIComponent(nodeUid)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            ...patch,
            expected,
            operationId: stableOperationId,
            baseVersion,
            confirm_sop_change: confirmSopChange === true
          }),
          timeoutMs: 30000
        }
      )
      mountError = null
      break
    } catch (error) {
      mountError = error
      if (!isRetryableAttachmentMountError(error) || attempt === attempts) break
      await delay(Math.min(1000, 250 * attempt))
    }
  }

  let readback
  try {
    const suffix = new URLSearchParams({ uids: nodeUid }).toString()
    readback = await api(
      `/api/files/${encodeURIComponent(room)}/nodes?${suffix}`,
      { timeoutMs: 15000 }
    )
  } catch (error) {
    throw attachmentWorkflowError(
      '附件已保存，但无法读取节点确认挂载状态',
      'ATTACHMENT_MOUNT_UNVERIFIED',
      {
        ...context,
        phase: 'verify',
        mount_attempts: mountAttempts,
        retryable_mount_error: !!(mountError && isRetryableAttachmentMountError(mountError)),
        ...(mountError ? { mount_error: causeDetails(mountError) } : {})
      },
      error
    )
  }

  const persistedNode = readbackNodeByUid(readback, nodeUid)
  const persistedData = persistedNode && persistedNode.data
  const persistedRevision =
    safeRevision(readback && readback.version) ??
    safeRevision(persistedNode && persistedNode.version)
  const mountIsPersisted = attachmentMountIsPersisted(persistedData, patch)
  const mountFailureIsIndeterminate =
    mountError && isRetryableAttachmentMountError(mountError)
  if (
    mountIsPersisted &&
    (!mountError || mountFailureIsIndeterminate)
  ) {
    const persistedStatus = String(persistedData.attachmentStatus || '')
      .trim()
      .toLowerCase()
    const contentUrl = `/api/files/${encodeURIComponent(
      room
    )}/attachments/${encodeURIComponent(attachmentId)}/content`
    return {
      ok: true,
      room_key: room,
      attachment,
      node_uid: nodeUid,
      node:
        mountResponse || {
          ok: true,
          uid: nodeUid,
          version: persistedRevision,
          verifiedByReadback: true
        },
      content_url: contentUrl,
      toolbar_equivalent: true,
      mount_attempts: mountAttempts,
      persistence_verified: true,
      persisted_attachment: {
        id: persistedData.attachmentId,
        url: persistedData.attachmentUrl,
        name: persistedData.attachmentName,
        status: persistedStatus
      },
      message:
        persistedStatus === 'ready'
          ? '已按工具栏「附件」方式挂载，可在网页点击节点回形针查看'
          : persistedStatus === 'processing' || persistedStatus === 'pending'
            ? '已挂载（回形针可见），服务端仍在解析正文；可先点击下载原件'
            : '已挂载（回形针可见），解析未成功；仍可点击下载原件'
    }
  }

  const observedAttachmentId =
    persistedData && Object.prototype.hasOwnProperty.call(persistedData, 'attachmentId')
      ? persistedData.attachmentId
      : null
  const failureCause = mountError || null
  throw attachmentWorkflowError(
    failureCause
      ? '附件已保存，但节点挂载未完成；请根据附件 ID 和错误信息核查'
      : '附件已保存，但节点字段未按预期落地；未覆盖当前节点状态',
    failureCause ? 'ATTACHMENT_MOUNT_FAILED' : 'ATTACHMENT_MOUNT_NOT_VERIFIED',
    {
      ...context,
      phase: 'mount',
      mount_attempts: mountAttempts,
      retryable_mount_error: !!(failureCause && isRetryableAttachmentMountError(failureCause)),
      current_attachment_id: observedAttachmentId,
      ...(persistedData ? { current_attachment_name: persistedData.attachmentName || '' } : {}),
      ...(failureCause ? { mount_error: causeDetails(failureCause) } : {})
    },
    failureCause || undefined
  )
}
