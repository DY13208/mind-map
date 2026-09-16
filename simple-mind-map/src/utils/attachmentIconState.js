/* global module */

function clampPercent(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

function attachmentStatusOf(data) {
  return String((data && data.attachmentStatus) || '')
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
  if (!data || isAttachmentBusy(data)) return false
  if (attachmentStatusOf(data) === 'failed') return false
  return hasAttachmentFile(data)
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
      previewable: false,
      iconOpacity: 0.28,
      progressMode: 'indeterminate',
      percent: 0,
      progressColor: '#fa8c16',
      badge: null,
      showPercent: false,
      title: `${name} · 正在处理`
    }
  }
  if (status === 'failed') {
    return {
      phase: 'failed',
      previewable: false,
      iconOpacity: 1,
      progressMode: 'none',
      percent: 0,
      progressColor: '#f04438',
      badge: { color: '#f04438' },
      showPercent: false,
      title: `${name} · 处理失败`
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

module.exports = {
  hasAttachmentIcon,
  isAttachmentBusy,
  isAttachmentPreviewReady,
  attachmentIconViewState
}
