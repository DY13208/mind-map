import assert from 'node:assert/strict'
import { buildSopContext } from '../bin/sopContext.mjs'

const rows = [
  { uid: 'root', parent_uid: null, data: { text: 'Root' } },
  { uid: 'target', parent_uid: 'root', data: { text: 'Same', note: 'Evidence', hyperlink: 'https://example.com', mapRef: { mapId: 'other' }, associativeLineTargets: ['sibling'] } },
  { uid: 'sibling', parent_uid: 'root', data: { text: 'Same' } },
  { uid: 'sop', parent_uid: 'target', data: { text: 'SOP' } },
  { uid: 'c', parent_uid: 'sop', data: { text: 'C：验收' } },
  { uid: 'p', parent_uid: 'sop', data: { text: 'P：执行' } }
]
const byUid = new Map(rows.map(row => [row.uid, row]))
const calls = []
const api = async (url, options = {}) => {
  calls.push({ url, method: options.method || 'GET' })
  if (url.endsWith('/nodes/query')) {
    const body = JSON.parse(options.body)
    const uid = body.selector.value
    let found = body.scope === 'path' ? [byUid.get('root'), byUid.get(uid)]
      : body.scope === 'children' ? rows.filter(row => row.parent_uid === uid)
        : body.scope === 'subtree' ? rows.filter(row => row.uid === uid || (uid === 'target' && ['sop', 'c', 'p'].includes(row.uid))) : []
    found = [...new Map(found.filter(Boolean).map(row => [row.uid, row])).values()]
    const offset = Number(body.cursor || 0)
    return { version: 8, items: found.slice(offset, offset + 1), has_more: offset + 1 < found.length, next_cursor: offset + 1 < found.length ? String(offset + 1) : null, omitted_fields: [], warnings: [] }
  }
  if (url.includes('/attachments/') && url.includes('/text')) {
    const offset = Number(new URL(url, 'http://local').searchParams.get('offset'))
    return { text: offset ? 'text' : 'body-', has_more: !offset, next_offset: offset ? null : 5 }
  }
  if (url.includes('/attachments?')) {
    return { attachments: url.includes('node_uid=target') ? [{ id: 'a1', status: 'ready', fileName: 'a.txt' }] : [] }
  }
  throw new Error(url)
}

const result = await buildSopContext('room', 'target', api)
assert.equal(result.target.uid, 'target')
assert.equal(result.target.revision, 8)
assert.deepEqual(result.path.map(node => node.uid), ['root', 'target'])
assert.deepEqual(result.children.map(node => node.uid), ['sop'])
assert.deepEqual(result.subtree.map(node => node.uid), ['target', 'sop', 'c', 'p'])
assert.deepEqual(result.siblings.map(node => node.uid), ['sibling'])
assert.deepEqual(result.notes, [{ uid: 'target', note: 'Evidence' }])
assert.deepEqual(result.references.map(ref => ref.kind), ['hyperlink', 'map_ref', 'associative'])
assert.equal(result.attachments[0].text, 'body-text')
assert.deepEqual(result.existing_sop, { found: true, sop_uid: 'sop', C: byUid.get('c'), P: byUid.get('p') })
assert.equal(result.complete, true)
assert(calls.every(call => call.method === 'GET' || call.url.endsWith('/nodes/query')))
assert(calls.every(call => !call.url.includes('get_map')))
const leaf = await buildSopContext('room', 'sibling', api)
assert.equal(leaf.existing_sop.found, false)
assert.deepEqual(leaf.children, [])
assert.deepEqual(leaf.siblings.map(node => node.uid), ['target'])
console.log('sopContext tests passed')
