import { apiRequest } from './fileApi'
import { roomFromLocation } from './roomLocation'
import { collectNodeKnowledge, knowledgeNeedsRemoteExtract } from './nodeKnowledge'

const MAX_UPLOAD_CHARS = 1.6e6

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
  return apiRequest(`/api/files/${encodeURIComponent(roomKey)}/attachments`, {
    method: 'POST',
    body: JSON.stringify(body || {}),
    timeoutMs: 60000
  })
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
