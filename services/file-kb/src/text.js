'use strict'

const fs = require('fs')
const { TextDecoder } = require('util')

const BLOCK_CHARS = 4000

function decodeText(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || '')
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le', { fatal: true }).decode(buffer.subarray(2))
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder('utf-16be', { fatal: true }).decode(buffer.subarray(2))
  }
  const body = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
    ? buffer.subarray(3) : buffer
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch (_) {
    // Windows-created Chinese text files are commonly saved as ANSI/GBK.
    return new TextDecoder('gb18030', { fatal: true }).decode(body)
  }
}

function splitLong(value, max = BLOCK_CHARS) {
  const out = []
  let rest = value
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut < Math.floor(max / 2)) cut = max
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out
}

function textToBlocks(value, max = BLOCK_CHARS) {
  const clean = String(value || '')
    .replace(/^\ufeff/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
  if (!clean) return []
  const chunks = clean.split(/\n[\t ]*\n+/).flatMap(part => splitLong(part.trim(), max)).filter(Boolean)
  return chunks.map((text, seq) => ({
    seq, type: 'paragraph', text, page: null, bbox: null, heading_path: [], table: null
  }))
}

async function parseTextFile(filePath) {
  return textToBlocks(decodeText(await fs.promises.readFile(filePath)))
}

module.exports = { BLOCK_CHARS, decodeText, textToBlocks, parseTextFile }
