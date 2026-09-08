const DEFAULTS = {
  maxTextChars: 6000,
  maxNoteChars: 1600,
  maxAttachmentTextChars: 2400,
  maxSourceChars: 2400,
  maxSources: 8,
  maxImages: 3,
  maxDataUrlChars: 1500000
}

const EXTRACTED_KEYS = [
  'attachmentText',
  'attachmentContent',
  'attachmentExtractedText',
  'fileText',
  'extractedText'
]

function dataOf(node) {
  if (!node) return {}
  if (node.getData) return node.getData() || {}
  return (node.nodeData && node.nodeData.data) || node.data || {}
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

function truncate(value, max) {
  const text = String(value || '')
  if (text.length <= max) return text
  return text.slice(0, Math.max(0, max - 1)) + '…'
}

/**
 * Allow https image URLs for optional vision payloads. Never treat private
 * network hosts as safe. Oversized data URLs are rejected so they cannot
 * enter prompts or outbound requests as raw base64.
 */
export function safeImageUrl(value, maxDataUrlChars = DEFAULTS.maxDataUrlChars) {
  const url = String(value || '').trim()
  if (!url) return ''
  if (/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(url)) {
    return url.length <= maxDataUrlChars ? url : ''
  }
  if (/^smm_img_key_/i.test(url)) return ''
  try {
    const parsed = new URL(url)
    if (!/^https?:$/.test(parsed.protocol)) return ''
    if (
      /^(localhost|127\.|0\.0\.0\.0|::1$|10\.|192\.168\.|169\.254\.)/i.test(
        parsed.hostname
      ) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(parsed.hostname)
    ) {
      return ''
    }
    return parsed.href
  } catch (e) {
    return ''
  }
}

function appendWithinBudget(lines, text, budget) {
  if (!text || budget.remaining <= 0) return true
  const value = String(text)
  if (value.length <= budget.remaining) {
    lines.push(value)
    budget.remaining -= value.length
    return false
  }
  lines.push(value.slice(0, Math.max(0, budget.remaining - 1)) + '…')
  budget.remaining = 0
  return true
}

function pushSource(sources, source, config) {
  if (!source || sources.length >= config.maxSources) return
  sources.push({
    type: source.type || 'unknown',
    name: stripHtml(source.name) || '未命名',
    status: source.status || 'ready',
    extractedText: truncate(
      stripHtml(source.extractedText),
      config.maxSourceChars
    ),
    imageUrl: source.imageUrl || '',
    attachmentId: source.attachmentId || '',
    error: stripHtml(source.error || '').slice(0, 200)
  })
}

function resolveImageDataUrl(image, mindMap) {
  const value = String(image || '').trim()
  if (!value) return ''
  if (/^data:image\//i.test(value)) return value
  if (!/^smm_img_key_/i.test(value) || !mindMap) return ''
  try {
    const tree =
      (mindMap.renderer && mindMap.renderer.renderTree) ||
      (mindMap.getData && mindMap.getData())
    const imgMap =
      (tree && tree.data && tree.data.imgMap) ||
      (tree && tree.imgMap) ||
      {}
    return String(imgMap[value] || '')
  } catch (e) {
    return ''
  }
}

/**
 * Collect node-local knowledge without ever serializing raw binary/base64
 * into the text prompt. Remote/extracted sources can be merged later.
 */
export function collectNodeKnowledge(nodes, options = {}) {
  const config = { ...DEFAULTS, ...options }
  const list = Array.isArray(nodes) ? nodes : [nodes]
  const lines = []
  const sources = []
  const images = []
  const seenImages = new Set()
  const budget = { remaining: config.maxTextChars }
  let attachmentCount = 0
  let skippedImageCount = 0
  let truncated = false

  list.filter(Boolean).forEach(node => {
    const data = dataOf(node)

    const note = stripHtml(data.note)
    if (note) {
      const excerpt = truncate(note, config.maxNoteChars)
      truncated =
        appendWithinBudget(lines, `节点备注：${excerpt}`, budget) || truncated
      pushSource(sources, {
        type: 'note',
        name: '节点备注',
        status: 'ready',
        extractedText: excerpt
      }, config)
    }

    if (data.image) {
      const title = stripHtml(data.imageTitle) || '未命名图片'
      const resolved = resolveImageDataUrl(data.image, options.mindMap)
      const image = safeImageUrl(
        /^https?:/i.test(data.image) ? data.image : resolved,
        config.maxDataUrlChars
      )
      const ocrText = stripHtml(
        data.imageOcrText || data.imageExtractedText || ''
      )
      const status = ocrText
        ? 'ready'
        : data.imageKnowledgeStatus ||
          (image ? 'pending' : 'failed')
      truncated =
        appendWithinBudget(lines, `节点图片：${title}`, budget) || truncated
      if (ocrText) {
        truncated =
          appendWithinBudget(
            lines,
            `图片OCR：${truncate(ocrText, config.maxAttachmentTextChars)}`,
            budget
          ) || truncated
      } else if (status === 'failed') {
        truncated =
          appendWithinBudget(
            lines,
            `图片内容：未能解析（${stripHtml(data.imageKnowledgeError) || '无可用 OCR'}）`,
            budget
          ) || truncated
      } else {
        truncated =
          appendWithinBudget(
            lines,
            '图片内容：待解析（当前 AI 网关不可靠读图，需 OCR 文本）',
            budget
          ) || truncated
      }
      pushSource(sources, {
        type: 'image',
        name: title,
        status,
        extractedText: ocrText,
        imageUrl: image,
        error: data.imageKnowledgeError
      }, config)
      if (image && !seenImages.has(image) && images.length < config.maxImages) {
        images.push(image)
        seenImages.add(image)
      } else if (data.image) {
        skippedImageCount++
      }
    }

    if (
      data.attachmentUrl ||
      data.attachmentName ||
      data.attachmentId
    ) {
      attachmentCount++
      const name = stripHtml(data.attachmentName) || '未命名附件'
      const status = String(data.attachmentStatus || '').toLowerCase() || 'pending'
      let extracted = ''
      EXTRACTED_KEYS.forEach(key => {
        if (!extracted) extracted = stripHtml(data[key])
      })
      if (extracted) {
        truncated =
          appendWithinBudget(
            lines,
            `附件已解析内容（${name}）：${truncate(
              extracted,
              config.maxAttachmentTextChars
            )}`,
            budget
          ) || truncated
      } else if (status === 'failed') {
        truncated =
          appendWithinBudget(
            lines,
            `节点附件：${name}（解析失败：${stripHtml(data.attachmentError) || '未知错误'}）`,
            budget
          ) || truncated
      } else {
        truncated =
          appendWithinBudget(
            lines,
            `节点附件：${name}（文件内容尚未解析）`,
            budget
          ) || truncated
      }
      pushSource(sources, {
        type: 'attachment',
        name,
        status: extracted ? 'ready' : status,
        extractedText: truncate(extracted, config.maxAttachmentTextChars),
        attachmentId: data.attachmentId || '',
        error: data.attachmentError
      }, config)
    } else {
      EXTRACTED_KEYS.forEach(key => {
        const value = stripHtml(data[key])
        if (!value) return
        truncated =
          appendWithinBudget(
            lines,
            `附件已解析内容：${truncate(value, config.maxAttachmentTextChars)}`,
            budget
          ) || truncated
        pushSource(sources, {
          type: 'attachment',
          name: key,
          status: 'ready',
          extractedText: truncate(value, config.maxAttachmentTextChars)
        }, config)
      })
    }
  })

  ;(options.extraSources || []).forEach(source => {
    if (!source) return
    pushSource(sources, source, config)
    if (source.extractedText) {
      truncated =
        appendWithinBudget(
          lines,
          `${source.type || '来源'}「${source.name || ''}」：${truncate(
            source.extractedText,
            config.maxAttachmentTextChars
          )}`,
          budget
        ) || truncated
    } else if (source.status === 'failed' && source.error) {
      truncated =
        appendWithinBudget(
          lines,
          `${source.type || '来源'}「${source.name || ''}」解析失败：${source.error}`,
          budget
        ) || truncated
    }
    if (
      source.imageUrl &&
      !seenImages.has(source.imageUrl) &&
      images.length < config.maxImages
    ) {
      const safe = safeImageUrl(source.imageUrl, config.maxDataUrlChars)
      if (safe) {
        images.push(safe)
        seenImages.add(safe)
      }
    }
  })

  if (truncated && budget.remaining <= 0) {
    lines.push('[知识上下文已截断]')
  }

  return {
    text: lines.join('\n'),
    sources,
    images,
    attachmentCount,
    skippedImageCount,
    truncated
  }
}

/**
 * Build OpenAI-style multimodal content only when the caller explicitly
 * enables vision. Prefer OCR text in the prompt; do not pretend the model
 * can see pixels when the gateway strips image_url blocks.
 */
export function buildVisionContent(text, images, enabled) {
  if (!enabled || !images || !images.length) return text
  return [
    { type: 'text', text },
    ...images.map(url => ({
      type: 'image_url',
      image_url: { url, detail: 'low' }
    }))
  ]
}

export function knowledgeNeedsRemoteExtract(knowledge) {
  if (!knowledge || !Array.isArray(knowledge.sources)) return false
  return knowledge.sources.some(source => {
    if (!source) return false
    if (source.status === 'ready' && source.extractedText) return false
    if (source.type === 'image' || source.type === 'attachment') {
      return source.status === 'pending' || source.status === 'processing' || !source.extractedText
    }
    return false
  })
}
