/* global require */

const assert = require('assert')
const {
  hasAttachmentIcon,
  isAttachmentBusy,
  isAttachmentPreviewReady,
  attachmentIconViewState,
  attachmentBadgeGeometry,
  isAttachmentErrorActive
} = require('../src/utils/attachmentIconState')

assert.equal(hasAttachmentIcon({ attachmentId: 'a1' }), true)
assert.equal(
  hasAttachmentIcon({ attachmentName: '表.xlsx', attachmentStatus: 'uploading' }),
  true
)
assert.equal(hasAttachmentIcon({ attachmentName: '表.xlsx' }), false)
assert.equal(isAttachmentBusy({ attachmentStatus: 'processing' }), true)
assert.equal(isAttachmentBusy({ attachmentStatus: 'ready' }), false)

assert.equal(
  isAttachmentPreviewReady({
    attachmentId: 'a1',
    attachmentName: '表.xlsx',
    attachmentStatus: 'uploading'
  }),
  false
)
assert.equal(
  isAttachmentPreviewReady({
    attachmentId: 'a1',
    attachmentName: '表.xlsx',
    attachmentStatus: 'processing'
  }),
  false
)
assert.equal(
  isAttachmentPreviewReady({
    attachmentId: 'a1',
    attachmentName: '表.xlsx',
    attachmentStatus: 'failed'
  }),
  false
)
assert.equal(
  isAttachmentPreviewReady({
    attachmentId: 'a1',
    attachmentName: '表.xlsx',
    attachmentStatus: 'ready'
  }),
  true
)
assert.equal(
  isAttachmentPreviewReady({
    attachmentId: 'a1',
    attachmentName: '旧附件.pdf'
  }),
  true
)

const uploading = attachmentIconViewState({
  attachmentName: '表.xlsx',
  attachmentStatus: 'uploading',
  attachmentProgress: 37.4
})
assert.equal(uploading.phase, 'uploading')
assert.equal(uploading.previewable, false)
assert.equal(uploading.percent, 37)
assert.match(uploading.title, /正在上传 37%/)
assert.ok(!/完成后可预览/.test(uploading.title))

const processing = attachmentIconViewState({
  attachmentName: '表.xlsx',
  attachmentStatus: 'processing'
})
assert.equal(processing.phase, 'processing')
assert.equal(processing.progressMode, 'indeterminate')
assert.match(processing.title, /正在处理/)
assert.ok(!/暂不可预览/.test(processing.title))

const ready = attachmentIconViewState({
  attachmentId: 'a1',
  attachmentName: '表.xlsx',
  attachmentStatus: 'ready'
})
assert.equal(ready.phase, 'ready')
assert.equal(ready.previewable, true)
assert.equal(ready.progressMode, 'none')
assert.equal(ready.badge, null)
assert.equal(ready.showPercent, false)
assert.equal(ready.title, '表.xlsx')

assert.equal(uploading.showPercent, true)
const noOcr = attachmentIconViewState({
  attachmentId: 'image-ocr', attachmentName: '图片.png',
  attachmentStatus: 'failed', attachmentError: '图片 OCR 服务未配置'
})
assert.equal(noOcr.phase, 'ready')
assert.equal(noOcr.badge, null)
assert.equal(noOcr.previewable, true)
for (const status of ['failed', 'processing', 'pending']) {
  const image = { attachmentId: 'image-1', attachmentName: '截图.png', attachmentStatus: status }
  assert.equal(isAttachmentPreviewReady(image), true)
  const state = attachmentIconViewState(image)
  assert.equal(state.previewable, true)
  assert.match(state.title, status === 'failed' ? /处理失败 · 点击处理$/ : /点击查看原文件/)
}

// Failed: darker red badge with '!' glyph and the error text in the tooltip.
const longError = '解析失败：' + 'x'.repeat(300)
const failed = attachmentIconViewState({
  attachmentId: 'f1', attachmentName: '报告.docx', attachmentStatus: 'failed', attachmentError: longError
})
assert.equal(failed.phase, 'failed')
assert.deepEqual(failed.badge, { color: '#B42318', glyph: 'error' })
assert.ok(failed.title.startsWith('报告.docx · 处理失败：解析失败：'))
assert.ok(failed.title.endsWith('… · 点击处理'))
assert.ok(Array.from(failed.title).length < 160, 'long errors are truncated in the tooltip')
assert.equal(
  attachmentIconViewState({ attachmentId: 'f2', attachmentName: 'a.docx', attachmentStatus: 'failed' }).title,
  'a.docx · 处理失败 · 点击处理'
)
assert.equal(isAttachmentErrorActive({ attachmentId: 'f1', attachmentStatus: 'failed' }), true)

// Ignored errors: no badge, normal pointer/preview behaviour, softened tooltip.
const ignored = attachmentIconViewState({
  attachmentId: 'f1', attachmentName: '报告.docx', attachmentStatus: 'failed',
  attachmentError: longError, attachmentErrorIgnored: true
})
assert.equal(ignored.phase, 'ready')
assert.equal(ignored.badge, null)
assert.equal(ignored.previewable, true)
assert.equal(ignored.title, '报告.docx · 已忽略错误')
assert.equal(isAttachmentErrorActive({ attachmentId: 'f1', attachmentStatus: 'failed', attachmentErrorIgnored: true }), false)
// A stale ignore flag has no effect once the attachment is no longer failed.
assert.equal(attachmentIconViewState({ attachmentId: 'r', attachmentName: 'r.pdf', attachmentStatus: 'ready', attachmentErrorIgnored: true }).title, 'r.pdf')

// Badge geometry stays fully inside the icon box (including the white ring).
for (const size of [12, 16, 18, 20, 24, 32, 48]) {
  const g = attachmentBadgeGeometry(size)
  assert.equal(g.r, Math.max(3, Math.round(size * 0.2)))
  assert.equal(g.ring, 1.5)
  assert.ok(g.cx + g.r + g.ring / 2 <= size + 1e-9, 'badge right edge in bounds at ' + size)
  assert.ok(g.cy + g.r + g.ring / 2 <= size + 1e-9, 'badge bottom edge in bounds at ' + size)
  assert.ok(g.cx - g.r - g.ring / 2 >= 0, 'badge left edge in bounds at ' + size)
  assert.ok(g.bar.y >= g.cy - g.r && g.bar.y + g.bar.height < g.dot.cy - g.dot.r + 1e-9, 'glyph bar above dot')
  assert.ok(g.dot.cy + g.dot.r <= g.cy + g.r, 'glyph dot inside badge')
}

console.log('attachment icon state tests passed')
