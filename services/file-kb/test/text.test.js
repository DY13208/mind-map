'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { ALLOWED, checkMagic } = require('../src/limits')
const { decodeText, textToBlocks, BLOCK_CHARS } = require('../src/text')

test('txt is accepted as text/plain while binary NUL content is rejected', () => {
  assert.equal(ALLOWED.txt.mime, 'text/plain')
  assert.equal(checkMagic('txt', Buffer.from('知识库 TXT 内容', 'utf8')), true)
  assert.equal(checkMagic('txt', Buffer.from([0x61, 0x00, 0x62])), false)
  assert.equal(checkMagic('txt', Buffer.from([0xff, 0xfe, 0x61, 0x00])), true)
})

test('decodeText supports UTF-8 BOM and UTF-16 text', () => {
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('博瑞特')])), '博瑞特')
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('TXT解析', 'utf16le')])), 'TXT解析')
})

test('textToBlocks creates searchable paragraphs and bounds large blocks', () => {
  const blocks = textToBlocks(`第一段 博瑞特\r\n\r\n第二段\n内容\n\n${'长'.repeat(BLOCK_CHARS + 10)}`)
  assert.equal(blocks[0].text, '第一段 博瑞特')
  assert.equal(blocks[1].text, '第二段\n内容')
  assert.ok(blocks.length >= 4)
  assert.ok(blocks.every((b, i) => b.seq === i && b.text.length <= BLOCK_CHARS))
})
