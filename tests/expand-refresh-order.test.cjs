const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
test('refresh restoration waits for layout and hydrated render before traversing nested children', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../web/src/pages/Edit/components/CooperateDialog.vue'), 'utf8')
  const begin = source.indexOf('    async restorePersonalExpandState() {')
  const end = source.indexOf('\n    unbindPersonalExpandState()', begin)
  let applied = false, rendered = false, loaded = false, nestedRendered = false, scans = 0
  const fn = vm.runInNewContext('({' + source.slice(begin, end) + '}).restorePersonalExpandState', {
    Promise, Object, applyPersonalExpandState: () => { if (applied) return false; applied = true; return true }
  })
  const component = {
    personalExpandRoomKey: 'room', personalExpandState: { parent: true }, personalExpandApplying: false,
    mindMap: {
      render: callback => setImmediate(() => { rendered = true; if (loaded) nestedRendered = true; if (callback) callback() }),
      cooperate: { hydrateExpandedPartialParents: async () => {
        scans++
        assert.equal(rendered, true, 'hydration must not scan the pre-expansion layout')
        if (!loaded) { loaded = true; return { changed: true } }
        assert.equal(nestedRendered, true, 'nested hydration must see loaded rendered instances')
        return { changed: false }
      } }
    }
  }
  await fn.call(component)
  assert.equal(scans, 2)
  assert.equal(component.personalExpandApplying, false)
})
