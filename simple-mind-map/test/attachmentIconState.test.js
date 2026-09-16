/* global require */

const assert = require('assert')
const {
  hasAttachmentIcon,
  isAttachmentBusy,
  isAttachmentPreviewReady,
  attachmentIconViewState
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

console.log('attachment icon state tests passed')
