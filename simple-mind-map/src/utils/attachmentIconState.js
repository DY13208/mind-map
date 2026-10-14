/* global module */

function clampPercent(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

function attachmentStatusOf(data) {
  return String((data && (data.attachmentStatus || data.status)) || '')
    .trim()
    .toLowerCase()
}

function hasAttachmentFile(data) {
  return !!(data && (data.attachmentId || data.attachmentUrl))
}

function hasAttachmentIcon(data) {
  if (!data) return false
  if (hasAttachmentFile(data) || data.attachmentName) {
    const status = attachmentStatusOf(data)
    if (
      status === 'uploading' ||
      status === 'pending' ||
      status === 'processing'
    ) {
      return true
    }
  }
  return hasAttachmentFile(data)
}

function isAttachmentBusy(data) {
  const status = attachmentStatusOf(data)
  return (
    status === 'uploading' || status === 'pending' || status === 'processing'
  )
}

function isAttachmentPreviewReady(data) {
  if (!data || attachmentStatusOf(data) === 'uploading') return false
  if (canPreviewOriginalAttachment(data)) return true
  if (isAttachmentBusy(data)) return false
  if (attachmentStatusOf(data) === 'failed') return false
  return hasAttachmentFile(data)
}

// OCR/extraction state does not describe whether the uploaded image/PDF can
// be opened. Keep the original available even when extraction fails.
function canPreviewOriginalAttachment(data = {}) {
  const name = String(data.attachmentName || data.fileName || '')
  const mime = String(data.attachmentMimeType || data.mimeType || '').split(';')[0].trim()
  return !!(data.attachmentId || data.id || data.attachmentUrl) &&
    attachmentStatusOf(data) !== 'uploading' &&
    (/\.(png|jpe?g|webp|gif|pdf)$/i.test(name) || /^(image\/(png|jpe?g|webp|gif)|application\/pdf)$/i.test(mime))
}

const ATTACHMENT_ERROR_TITLE_MAX = 120
const FAILED_BADGE_COLOR = '#B42318'

function attachmentErrorText(data = {}) {
  return String((data && (data.attachmentError || data.errorMessage)) || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncateText(text, max = ATTACHMENT_ERROR_TITLE_MAX) {
  const chars = Array.from(String(text || ''))
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('')
}

function failedAttachmentTitle(name, error) {
  return `${name} · 处理失败${error ? '：' + truncateText(error) : ''} · 点击处理`
}

// 状态角标几何：完整位于图标框内（含 1.5px 白色描边），避免被嵌套 svg 裁剪。
function attachmentBadgeGeometry(iconSize) {
  const size = Math.max(0, Number(iconSize) || 0)
  const r = Math.max(3, Math.round(size * 0.2))
  const ring = 1.5
  const c = size - r - ring / 2
  const barWidth = Math.max(0.9, r * 0.3)
  const barHeight = r * 0.75
  return {
    r,
    cx: c,
    cy: c,
    ring,
    bar: { x: c - barWidth / 2, y: c - r * 0.6, width: barWidth, height: barHeight },
    dot: { cx: c, cy: c + r * 0.5, r: Math.max(0.5, r * 0.17) }
  }
}

function attachmentIconViewState(data = {}) {
  const status = attachmentStatusOf(data)
  const name = String(data.attachmentName || '附件')
  const percent = clampPercent(data.attachmentProgress)
  if (status === 'uploading') {
    return {
      phase: 'uploading',
      previewable: false,
      iconOpacity: 0.28,
      progressMode: 'determinate',
      percent,
      progressColor: '#1677ff',
      badge: null,
      showPercent: true,
      title: `${name} · 正在上传 ${percent}%`
    }
  }
  if (status === 'pending' || status === 'processing') {
    return {
      phase: 'processing',
      previewable: canPreviewOriginalAttachment(data),
      iconOpacity: 0.28,
      progressMode: 'indeterminate',
      percent: 0,
      progressColor: '#fa8c16',
      badge: null,
      showPercent: false,
      title: `${name} · 正在处理${canPreviewOriginalAttachment(data) ? '，点击查看原文件' : ''}`
    }
  }
  if (status === 'failed' && canPreviewOriginalAttachment(data) &&
      /OCR.*(未配置|not.configured)|未配置.*OCR/i.test(data.attachmentError || data.errorMessage || '')) {
    return { phase: 'ready', previewable: true, iconOpacity: 1, progressMode: 'none',
      percent: 100, progressColor: '#12b76a', badge: null, showPercent: false, title: name }
  }
  if (status === 'failed' && data.attachmentErrorIgnored) {
    return {
      phase: 'ready',
      previewable: hasAttachmentFile(data),
      iconOpacity: 1,
      progressMode: 'none',
      percent: 100,
      progressColor: '#12b76a',
      badge: null,
      showPercent: false,
      errorIgnored: true,
      title: `${name} · 已忽略错误`
    }
  }
  if (status === 'failed') {
    return {
      phase: 'failed',
      previewable: canPreviewOriginalAttachment(data),
      iconOpacity: 1,
      progressMode: 'none',
      percent: 0,
      progressColor: '#f04438',
      badge: { color: FAILED_BADGE_COLOR, glyph: 'error' },
      showPercent: false,
      title: failedAttachmentTitle(name, attachmentErrorText(data))
    }
  }
  if (isAttachmentPreviewReady(data)) {
    return {
      phase: 'ready',
      previewable: true,
      iconOpacity: 1,
      progressMode: 'none',
      percent: 100,
      progressColor: '#12b76a',
      badge: null,
      showPercent: false,
      title: name
    }
  }
  return {
    phase: 'empty',
    previewable: false,
    iconOpacity: 1,
    progressMode: 'none',
    percent: 0,
    progressColor: '#98a2b3',
    badge: null,
    showPercent: false,
    title: name
  }
}

function isAttachmentErrorActive(data) {
  return attachmentIconViewState(data || {}).phase === 'failed'
}

module.exports = {
  hasAttachmentIcon,
  isAttachmentErrorActive,
  attachmentErrorText,
  attachmentBadgeGeometry,
  isAttachmentBusy,
  isAttachmentPreviewReady,
  canPreviewOriginalAttachment,
  attachmentIconViewState
}
