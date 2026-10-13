const assert = require('assert').strict
const { readBoundedAttachmentResponse } = require('./loadAttachmentUtils.cjs')('boundedAttachmentRead')

async function main() {
  let cancelled = false
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(100)) },
    cancel() { cancelled = true }
  }), { headers: { 'Content-Length': '100' } })
  await assert.rejects(readBoundedAttachmentResponse(response, { maxBytes: 10 }), /过大/)
  assert.equal(cancelled, true, 'reject declared large responses before buffering')

  cancelled = false
  const unknown = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(100)) },
    cancel() { cancelled = true }
  }))
  await assert.rejects(readBoundedAttachmentResponse(unknown, { maxBytes: 10 }), /过大/)
  assert.equal(cancelled, true, 'enforce budget even without Content-Length')

  cancelled = false
  const prefix = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('abcdefghij')) },
    cancel() { cancelled = true }
  }), { headers: { 'Content-Length': '1000000' } })
  const part = await readBoundedAttachmentResponse(prefix, { maxBytes: 5, prefix: true })
  assert.equal(new TextDecoder().decode(part.buffer), 'abcde')
  assert.equal(part.truncated, true)
  assert.equal(cancelled, true)

  const small = await readBoundedAttachmentResponse(new Response('hello'), { maxBytes: 10, prefix: true })
  assert.equal(small.truncated, false)
  assert.equal(new TextDecoder().decode(small.buffer), 'hello')
  const aborted = new Response(new ReadableStream({
    start(controller) { controller.error(new DOMException('cancelled', 'AbortError')) }
  }))
  await assert.rejects(readBoundedAttachmentResponse(aborted, { maxBytes: 10 }), { name: 'AbortError' })
  console.log('Bounded attachment response tests passed')
}
main().catch(err => { console.error(err); process.exitCode = 1 })
