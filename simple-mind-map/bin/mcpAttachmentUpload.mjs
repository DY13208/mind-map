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
