const { test, expect } = require('./fixtures')
const {
  clickNode,
  pressOnCanvas,
  finishEdit,
  waitForText,
  pgHash,
  waitForBuildStamp,
  assertServerAlive,
  idbPending
} = require('./helpers')

test.describe.configure({ mode: 'serial' })

test.describe('level1 smoke @level1 @smoke', () => {
  test('page opens with latest build stamp', async ({ pair }) => {
    const build = await waitForBuildStamp(pair.pageA)
    expect(build && build.commit, 'APP_BUILD_COMMIT missing from bundle').toBeTruthy()
    expect(await pair.pageA.locator('[data-testid="mindmap-canvas"]').count()).toBeGreaterThan(0)
    expect(await pair.pageA.locator('[data-testid="cooperate"].cooperating').count()).toBeGreaterThan(0)
  })

  for (let i = 1; i <= 10; i++) {
    test('A Enter appears on B and PG — run ' + i, async ({ pair }) => {
      const { pageA, pageB, room, runtime } = pair
      await assertServerAlive(runtime)
      const before = await pgHash(runtime.api, room)
      await clickNode(pageA, 'Alpha')
      await pressOnCanvas(pageA, 'Enter')
      await waitForText(pageA, '二级节点', 10000)
      await finishEdit(pageA)
      const dump = await pageA.evaluate(() => {
        function walk(vm, seen = new Set()) {
          if (!vm || seen.has(vm)) return null
          seen.add(vm)
          if (vm.mindMap && vm.mindMap.cooperate) return vm.mindMap
          for (const child of vm.$children || []) {
            const found = walk(child, seen)
            if (found) return found
          }
          return null
        }
        const app = document.querySelector('#app') && document.querySelector('#app').__vue__
        const mindMap = walk(app)
        const c = mindMap && mindMap.cooperate
        const nodes = []
        const walkNode = node => {
          if (!node) return
          const uid = node.getData && node.getData('uid')
          nodes.push({
            uid,
            text: String((node.getData && node.getData('text')) || '').replace(/<[^>]+>/g, ''),
            pushed: !!(c && c.lastPushed && uid && c.lastPushed[uid])
          })
          ;(node.children || []).forEach(walkNode)
        }
        walkNode(mindMap && mindMap.renderer && mindMap.renderer.root)
        return {
          status: typeof window.__COLLAB_V2_STATUS__ === 'function'
            ? window.__COLLAB_V2_STATUS__()
            : null,
          httpCollabMode: !!(c && c.httpCollabMode),
          previewApplied: !!(c && c.previewApplied),
          hasAdd: !!(c && c.httpAddNode),
          hasAdapter: !!(c && c.collabV2Adapter),
          lastPushed: c ? Object.keys(c.lastPushed || {}) : [],
          suppressLeft: c ? Math.max(0, Number(c.suppressLocalUntil || 0) - Date.now()) : 0,
          settling: !!(c && c.httpSettlingAfterReplace),
          applying: !!(c && c.isApplyingRemote),
          lazy: !!(mindMap && mindMap.renderer && mindMap.renderer._lazyCommandPending),
          nodes
        }
      })
      const pending = await idbPending(pageA)
      try {
        await expect
          .poll(async () => (await pgHash(runtime.api, room)).count, {
            timeout: 15000
          })
          .toBeGreaterThan(before.count)
      } catch (err) {
        err.message +=
          '\ninsert dump=' + JSON.stringify({ dump, pending, before })
        throw err
      }
      await waitForText(pageB, '二级节点', 20000)
      const after = await pgHash(runtime.api, room)
      expect(after.count).toBeGreaterThan(before.count)
      expect(status && status.status, JSON.stringify(status)).toBe('cooperating')
    })
  }
})
