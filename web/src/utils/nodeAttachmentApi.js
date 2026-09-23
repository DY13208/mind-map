import { apiRequest } from './fileApi'
import { roomFromLocation } from './roomLocation'
import { getRuntimeConfig } from './runtimeConfig'
import { collectNodeKnowledge, knowledgeNeedsRemoteExtract } from './nodeKnowledge'
import { Upload } from 'tus-js-client'
import { enqueueAttachmentUpload } from './attachmentUploadQueue'

const MAX_UPLOAD_CHARS = 1.6e6
export const DEFAULT_MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024
export const TUS_CHUNK_BYTES = 8 * 1024 * 1024

export function maxAttachmentBytes() {
  const runtime =
    (typeof window !== 'undefined' && window.__MIND_MAP_RUNTIME__) || {}
  const n = Number(runtime.attachmentMaxBytes)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_ATTACHMENT_BYTES
}

export function formatAttachmentMaxMb(bytes = maxAttachmentBytes()) {
  return Math.max(1, Math.round(Number(bytes) / (1024 * 1024)))
}

export function attachmentUploadTimeoutMs(byteSize) {
  const mb = Math.max(0, Number(byteSize) || 0) / (1024 * 1024)
  return Math.min(
    15 * 60 * 1000,
    Math.max(120000, Math.round(15000 + mb * 6000))
  )
}

function isBinaryFilePayload(body) {
  const file = body && body.file
  if (!file || typeof file !== 'object') return false
  if (body.contentBase64 || body.sourceUrl) return false
  return typeof file.size === 'number'
}

export function attachmentFingerprint(roomKey, file) {
  return [
    'mind-att',
    String(roomKey || ''),
    String((file && file.name) || ''),
    String((file && file.size) || 0),
    String((file && file.lastModified) || 0)
  ].join('-')
}

function tusEndpoint() {
  const base = String(getRuntimeConfig().collabApi || '').replace(/\/$/, '')
  return `${base}/api/attachments/resumable`
}

function headerValue(res, name) {
  if (!res || typeof res.getHeader !== 'function') return ''
  return String(res.getHeader(name) || res.getHeader(name.toLowerCase()) || '')
}

async function fetchTusResult(uploadUrl) {
  const url = String(uploadUrl || '').replace(/\/$/, '') + '/result'
  const res = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store'
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || res.statusText || '读取续传结果失败')
    err.statusCode = res.status
    if (data.code) err.code = data.code
    throw err
  }
  return data
}

function uploadResumableAttachment(roomKey, body) {
  const file = body.file
  const fileName = body.fileName || file.name || 'file'
  const mimeType = body.mimeType || file.type || 'application/octet-stream'
  return enqueueAttachmentUpload(
    () =>
      new Promise((resolve, reject) => {
        let attachmentId = ''
        const upload = new Upload(file, {
          endpoint: tusEndpoint(),
          chunkSize: TUS_CHUNK_BYTES,
          retryDelays: [0, 1000, 3000, 5000, 10000],
          storeFingerprintForResuming: true,
          removeFingerprintOnSuccess: false,
          metadata: {
            filename: fileName,
            filetype: mimeType,
            roomKey: String(roomKey || ''),
            nodeUid: String(body.nodeUid || ''),
            sourceKind: String(body.sourceKind || 'attachment'),
            ...(body.forceExtract ? { forceExtract: '1' } : {})
          },
          fingerprint() {
            return Promise.resolve(attachmentFingerprint(roomKey, file))
          },
          onBeforeRequest(req) {
            const xhr = req && req.getUnderlyingObject && req.getUnderlyingObject()
            if (xhr) xhr.withCredentials = true
          },
          onProgress(bytesUploaded, bytesTotal) {
            if (typeof body.onUploadProgress !== 'function') return
            const total = Number(bytesTotal) || file.size || 0
            const loaded = Number(bytesUploaded) || 0
            body.onUploadProgress({
              loaded,
              total,
              percent: total ? Math.round((loaded / total) * 100) : 0
            })
          },
          onAfterResponse(req, res) {
            const id = headerValue(res, 'X-Mind-Attachment-Id')
            if (id) attachmentId = id
          },
          onError(err) {
            reject(err || new Error('附件上传失败'))
          },
          async onSuccess() {
            try {
              if (typeof body.onUploadProgress === 'function') {
                body.onUploadProgress({
                  loaded: file.size,
                  total: file.size,
                  percent: 100
                })
              }
              if (attachmentId) {
                const data = await getNodeAttachment(roomKey, attachmentId)
                resolve(data)
                return
              }
              const data = await fetchTusResult(upload.url)
              resolve(data)
            } catch (err) {
              reject(err)
            }
          }
        })
        upload
          .findPreviousUploads()
          .then(previous => {
            if (previous && previous.length) {
              upload.resumeFromPreviousUpload(previous[0])
            }
            upload.start()
          })
          .catch(reject)
      })
  )
}

function dataOf(node) {
  if (!node) return {}
  if (node.getData) return node.getData() || {}
  return (node.nodeData && node.nodeData.data) || node.data || {}
}

function resolveImgMap(mindMap) {
  try {
    const tree =
      (mindMap && mindMap.renderer && mindMap.renderer.renderTree) ||
      (mindMap && mindMap.getData && mindMap.getData())
    return (tree && tree.data && tree.data.imgMap) || (tree && tree.imgMap) || {}
  } catch (e) {
    return {}
  }
}

function resolveImagePayload(data, mindMap) {
  const image = String((data && data.image) || '').trim()
  if (!image) return null
  const title = String((data && data.imageTitle) || '节点图片').trim()
  if (/^https?:\/\//i.test(image)) {
    return {
      type: 'image',
      name: title,
      sourceUrl: image,
      fileName: title + '.png',
      mimeType: 'image/png'
    }
  }
  let dataUrl = image
  if (/^smm_img_key_/i.test(image)) {
    dataUrl = String(resolveImgMap(mindMap)[image] || '')
  }
  if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(dataUrl)) return null
  if (dataUrl.length > MAX_UPLOAD_CHARS) {
    return {
      type: 'image',
      name: title,
      status: 'failed',
      error: '本地图片过大，无法上传解析',
      extractedText: ''
    }
  }
  const mime =
    (dataUrl.match(/^data:(image\/[^;]+);base64,/i) || [])[1] || 'image/png'
  return {
    type: 'image',
    name: title,
    fileName: title + '.' + (mime.split('/')[1] || 'png'),
    mimeType: mime,
    contentBase64: dataUrl
  }
}

export function buildEnsureSources(node, mindMap) {
  const data = dataOf(node)
  const sources = []
  if (data.attachmentId && !data.attachmentExtractedText) {
    sources.push({
      type: 'attachment',
      name: data.attachmentName || data.attachmentId,
      attachmentId: data.attachmentId,
      nodeUid: data.uid || ''
    })
  } else if (
    (data.attachmentUrl || data.attachmentName) &&
    !data.attachmentExtractedText &&
    data.attachmentUrl &&
    /^https?:\/\//i.test(data.attachmentUrl)
  ) {
    sources.push({
      type: 'attachment',
      name: data.attachmentName || '附件',
      sourceUrl: data.attachmentUrl,
      fileName: data.attachmentName || 'attachment',
      nodeUid: data.uid || ''
    })
  }

  const hasImageText = !!(data.imageOcrText || data.imageExtractedText)
  if (data.image && !hasImageText) {
    const payload = resolveImagePayload(data, mindMap)
    if (payload) sources.push(payload)
  }
  return sources
}

export async function uploadNodeAttachment(roomKey, body) {
  if (isBinaryFilePayload(body)) {
    return uploadResumableAttachment(roomKey, body)
  }
  return apiRequest(`/api/files/${encodeURIComponent(roomKey)}/attachments`, {
    method: 'POST',
    body: JSON.stringify(body || {}),
    timeoutMs: 60000
  })
}

export async function getNodeAttachment(roomKey, attachmentId) {
  return apiRequest(
    `/api/files/${encodeURIComponent(roomKey)}/attachments/${encodeURIComponent(
      attachmentId
    )}`,
    { method: 'GET' }
  )
}

export async function deleteNodeAttachment(roomKey, attachmentId, nodeUid = '') {
  const query = nodeUid
    ? `?node_uid=${encodeURIComponent(String(nodeUid))}`
    : ''
  return apiRequest(
    `/api/files/${encodeURIComponent(roomKey)}/attachments/${encodeURIComponent(
      attachmentId
    )}${query}`,
    { method: 'DELETE' }
  )
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function waitForAttachmentReady(
  roomKey,
  attachmentId,
  options = {}
) {
  const intervalMs = Math.max(400, Number(options.intervalMs) || 1500)
  const timeoutMs = Math.max(intervalMs, Number(options.timeoutMs) || 15 * 60 * 1000)
  const started = Date.now()
  let last = null
  while (Date.now() - started <= timeoutMs) {
    if (options.signal && options.signal.aborted) {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }
    const data = await getNodeAttachment(roomKey, attachmentId)
    last = (data && data.attachment) || null
    if (typeof options.onUpdate === 'function') options.onUpdate(last)
    const status = String((last && last.status) || '')
    if (status === 'ready' || status === 'failed') return last
    await delay(intervalMs)
  }
  return last
}

export function nodeAttachmentContentUrl(roomKey, attachmentId) {
  const base = String(getRuntimeConfig().collabApi || '').replace(/\/$/, '')
  return `${base}/api/files/${encodeURIComponent(
    roomKey
  )}/attachments/${encodeURIComponent(attachmentId)}/content`
}

export async function fetchNodeAttachmentContent(
  roomKey,
  attachmentId,
  options = {}
) {
  const res = await fetch(nodeAttachmentContentUrl(roomKey, attachmentId), {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    headers: { Accept: 'application/octet-stream' },
    signal: options.signal
  })
  if (!res.ok) {
    let message = res.statusText || '附件读取失败'
    try {
      const data = await res.json()
      message = data.error || message
    } catch (err) {
      // Keep the HTTP status text when the response is not JSON.
    }
    const error = new Error(message)
    error.statusCode = res.status
    throw error
  }
  return {
    buffer: await res.arrayBuffer(),
    contentType: res.headers.get('content-type') || ''
  }
}

export async function ensureNodeKnowledgeRemote(roomKey, sources) {
  if (!roomKey || !sources || !sources.length) {
    return { ok: true, sources: [] }
  }
  return apiRequest(
    `/api/files/${encodeURIComponent(roomKey)}/knowledge/ensure`,
    {
      method: 'POST',
      body: JSON.stringify({ sources }),
      timeoutMs: 90000
    }
  )
}

export async function enrichNodeKnowledge(mindMap, node, options = {}) {
  const roomKey = options.roomKey || roomFromLocation() || ''
  const local = collectNodeKnowledge(node, { mindMap })
  if (!roomKey || !knowledgeNeedsRemoteExtract(local)) {
    return { knowledge: local, remoteSources: [], roomKey }
  }

  const ensureSources = buildEnsureSources(node, mindMap).filter(
    item => item && (item.attachmentId || item.contentBase64 || item.sourceUrl)
  )
  if (!ensureSources.length) {
    return { knowledge: local, remoteSources: [], roomKey }
  }

  try {
    const res = await ensureNodeKnowledgeRemote(roomKey, ensureSources)
    const remoteSources = (res && res.sources) || []
    const knowledge = collectNodeKnowledge(node, {
      mindMap,
      extraSources: remoteSources
    })
    return { knowledge, remoteSources, roomKey }
  } catch (err) {
    console.warn('[nodeKnowledge] remote ensure failed', err)
    return {
      knowledge: local,
      remoteSources: [],
      roomKey,
      error: err
    }
  }
}
