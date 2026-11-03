const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function setup() {
  const source = fs.readFileSync(path.join(__dirname, '../src/utils/mapRefMirror.js'), 'utf8')
    .replace(/^import[\s\S]*?from ['"][^'"]+['"]\n/gm, '')
    .replace(/export (async function|function|class)/g, '$1')
    .replace(/export default \{[\s\S]*$/, 'module.exports = { MapRefMirrorSync }')
  const patches = []
  const ref = { mapId: 'peer', nodeId: 'peer-root', syncMode: 'mirror', uidMap: { host: 'peer-root', child: 'peer-child' } }
  const makeNode = (uid, mapRef) => {
    const data = { uid, text: 'Unedited text', note: 'Unedited note', mapRef }
    return { children: [], getData: key => key ? data[key] : data }
  }
  const host = makeNode('host', ref), child = makeNode('child')
  host.children.push(child)
  const context = { module: { exports: {} }, console, setTimeout, clearTimeout, setInterval, clearInterval,
    normalizeMapRef: value => value || null, isMirrorMapRef: value => !!(value && value.syncMode === 'mirror'),
    patchFileNode: async (...args) => { patches.push(args) }, getMapVersion: async () => ({ version: 2 }) }
  vm.runInNewContext(source, context)
  const mindMap = { renderer: { root: host, activeNodeList: [host, child], findNodeByUid: uid => uid === 'host' ? host : child } }
  return { sync: new context.module.exports.MapRefMirrorSync({ mindMap, sourceRoomKey: 'local' }), host, child, patches }
}

test('selection and local view changes never patch nodes in another map', async () => {
  const x = setup()
  for (const node of [x.host, x.child]) {
    for (const patch of [{ isActive: true }, { isActive: false }, { expand: true }, { fillColor: '#fff' }]) {
      await x.sync._forwardLocalCommand('SET_NODE_DATA', [node, patch])
    }
  }
  assert.equal(x.patches.length, 0)
})

test('mirror text and note edits forward only the field actually edited', async () => {
  const x = setup()
  await x.sync._forwardLocalCommand('SET_NODE_DATA', [x.child, { text: 'Unedited text', isActive: true }])
  await x.sync._forwardLocalCommand('SET_NODE_DATA', [x.host, { note: 'Unedited note' }])
  assert.equal(x.patches.length, 2)
  assert.equal(x.patches[0][1], 'peer-child')
  assert.equal(x.patches[0][2].text, 'Unedited text')
  assert.equal(Object.hasOwn(x.patches[0][2], 'note'), false)
  assert.equal(x.patches[1][1], 'peer-root')
  assert.equal(x.patches[1][2].note, 'Unedited note')
  assert.equal(Object.hasOwn(x.patches[1][2], 'text'), false)
})
