const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const source = fs.readFileSync(path.join(__dirname, '../src/plugins/Cooperate.js'), 'utf8')
const start = source.indexOf('  async applyV2PayloadMove(')
const end = source.indexOf('  applyV2PayloadDelete(', start)
const { applyV2PayloadMove } = vm.runInNewContext('({' + source.slice(start, end) + '})', {
  collabMove: require('../src/utils/collabMove'),
  payloadParentUid: p => p.parentUid,
  v2Trace() {}
})
function node(uid, parent = null) {
  const data = { uid }
  return { parent, nodeData: { data, children: [] }, draws: 0,
    getData: key => data[key], setData: patch => Object.assign(data, patch),
    renderLine() { this.draws++ }
  }
}
for (const mode of ['unchanged', 'replaced', 'deleted', 'same-parent']) {
  test('move completion only repaints live parents: ' + mode, async () => {
    const old = node('old')
    const target = mode === 'same-parent' ? old : node('target')
    const child = node('child', old)
    old.nodeData.children.push(child.nodeData)
    const live = new Map([['old', old], ['target', target], ['child', child]])
    let nextOld, nextTarget
    const co = {
      mindMap: { renderer: { findNodeByUid: uid => live.get(uid) }, command: { pause() {}, recovery() {} } },
      snapshotActiveUids: () => [], restoreActiveUids() {}, cleanupDragArtifacts() {},
      nodeDataHasChild: (parent, uid) => parent.nodeData.children.some(n => n.data.uid === uid),
      applyNativeMoveCommand() {
        old.nodeData.children = []
        target.nodeData.children.push(child.nodeData)
        child.parent = target
        return true
      },
      async waitForMoveRender() {
        if (mode === 'replaced') {
          nextOld = node('old')
          nextTarget = node('target')
          nextTarget.nodeData.children.push(child.nodeData)
          live.set('old', nextOld)
          live.set('target', nextTarget)
          child.parent = nextTarget
        } else if (mode === 'deleted') {
          live.delete('old')
          live.delete('target')
          live.delete('child')
        }
      }
    }
    await applyV2PayloadMove.call(co, { uid: 'child', parentUid: target.getData('uid'), index: 0 })
    if (mode === 'replaced' || mode === 'deleted') {
      assert.equal(old.draws, 0, 'detached parent must not recreate old SVG paths')
      assert.equal(target.draws, 0)
    } else {
      assert.equal(old.draws, 1)
      assert.equal(target.draws, 1)
    }
    if (mode === 'replaced') {
      assert.equal(nextOld.draws, 1)
      assert.equal(nextTarget.draws, 1)
    }
    assert.equal(co._v2MoveActive, false)
  })
}
