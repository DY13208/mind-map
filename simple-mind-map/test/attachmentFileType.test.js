/* global require */

const assert = require('assert')
const { getAttachmentFileType } = require('../src/utils/attachmentFileType')

function testKnownExtensions() {
  const testCases = [
    ['report.PDF', 'pdf'],
    ['proposal.docx', 'word'],
    ['quarterly-review.pptx', 'presentation'],
    ['budget.xlsx', 'spreadsheet'],
    ['macro-enabled.xlsm', 'spreadsheet'],
    ['cover.webp', 'image'],
    ['notes.markdown', 'text'],
    ['page.html', 'html'],
    ['index.HTM', 'html'],
    ['source.TS', 'text'],
    ['backup.tar.gz', 'archive']
  ]
  testCases.forEach(([fileName, expected]) => {
    assert.strictEqual(getAttachmentFileType(fileName), expected)
  })
}

function testFallback() {
  assert.strictEqual(getAttachmentFileType('unknown.bin'), 'attachment')
  assert.strictEqual(getAttachmentFileType(''), 'attachment')
  assert.strictEqual(getAttachmentFileType(null), 'attachment')
}

function testMimeTypes() {
  assert.strictEqual(
    getAttachmentFileType('', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
    'presentation'
  )
  assert.strictEqual(getAttachmentFileType('', 'text/html'), 'html')
  assert.strictEqual(getAttachmentFileType('说明.html', 'text/html'), 'html')
  assert.strictEqual(getAttachmentFileType('说明.txt', 'text/plain'), 'text')
}

testKnownExtensions()
testFallback()
testMimeTypes()
console.log('attachment file type tests passed')
