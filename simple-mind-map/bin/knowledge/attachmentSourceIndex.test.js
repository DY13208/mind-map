const test = require('node:test')
const assert = require('node:assert/strict')
const { renderDocument, ATTACHMENT_SOURCE_INDEX_VERSION } = require('./markdownRenderer')

function input(status = 'ready', extractedText = '供应商费用需要完成合规审查。') {
  return {
    roomId: 'attachment-source-room',
    snapshotVersion: 7,
    sourceRevision: 3,
    model: {
      rootUid: 'root',
      branchRoots: ['branch'],
      children: new Map([['root', ['branch']], ['branch', []]]),
      byUid: new Map([
        ['root', { uid: 'root', parent_uid: null, position: '00000000' }],
        ['branch', { uid: 'branch', parent_uid: 'root', position: '00000000' }]
      ])
    },
    data: new Map([['root', { text: 'Root' }], ['branch', { text: '费用流程', attachmentId: 'file-1' }]]),
    attachments: [{
      id: 'file-1', node_uid: 'branch', file_name: '流程.txt', status,
      extracted_text: extractedText, extracted_chars: extractedText.length,
      content_hash: 'sha256-file', source_kind: 'attachment'
    }]
  }
}

test('renderDocument indexes the extracted text range and source identity', () => {
  const rendered = renderDocument(input(), 'branch', null)
  const body = rendered.text.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
  assert.equal(rendered.attachmentSourceIndexVersion, ATTACHMENT_SOURCE_INDEX_VERSION)
  assert.equal(rendered.attachmentSources.length, 1)
  const source = rendered.attachmentSources[0]
  assert.equal(source.room_key, 'attachment-source-room')
  assert.equal(source.node_uid, 'branch')
  assert.equal(source.attachment_id, 'file-1')
  assert.equal(source.content_hash, 'sha256-file')
  assert.equal(source.version, 7)
  assert.equal(source.source_revision, 3)
  assert.equal(body.slice(source.start, source.end), '供应商费用需要完成合规审查。')
})

test('renderer includes non-ready attachments without inventing a text range', () => {
  const rendered = renderDocument(input('processing', ''), 'branch', null)
  const [source] = rendered.attachmentSources
  assert.equal(source.status, 'processing')
  assert.equal(source.start, null)
  assert.equal(source.end, null)
  assert.equal(source.total_chars, 0)
})

test('unchanged render still returns the index for manifest metadata refresh', () => {
  const first = renderDocument(input(), 'branch', null)
  const next = renderDocument(input(), 'branch', { sourceHash: first.sourceHash })
  assert.equal(next.unchanged, true)
  assert.equal(next.attachmentSourceIndexVersion, ATTACHMENT_SOURCE_INDEX_VERSION)
  assert.equal(next.attachmentSources[0].start, first.attachmentSources[0].start)
})
