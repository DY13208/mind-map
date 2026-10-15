const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { createHarness, repo } = require('./engine-harness.cjs')

test('setData during async viewport indexing cancels old paint and completes the new tree', async () => {
  const phase = process.env.PERF_TDD_PHASE || 'red'
  const destination = path.join(repo, 'work/performance-tdd', phase, 'renderer')
  fs.mkdirSync(destination, { recursive: true })
  const harness = await createHarness({ contents: "import './tests/performance/renderer-browser-entry.js'" })
  try {
    const observed = await harness.page.evaluate(async () => {
      const f = rendererFixture
      const prefixUids = (data, prefix) => {
        data.data.uid = prefix + data.data.uid
        ;(data.children || []).forEach(child => prefixUids(child, prefix))
        return data
      }
      const mm = await f.create(prefixUids(f.wideLayered(4), 'old-'), {
        compactLayout: false, openPerformance: true
      })
      const originalBuild = mm.renderer.buildViewportIndex
      const originalRender = f.MindMapNode.prototype.render
      let signalHeld, release, first = true, switched = false, staleCalls = 0
      const held = new Promise(resolve => { signalHeld = resolve })
      const barrier = new Promise(resolve => { release = resolve })
      // Hold exactly one genuine production index call at the caller's await
      // boundary; after release the original collector and spatial build run.
      mm.renderer.buildViewportIndex = async function(options = {}) {
        if (options.async && first) {
          first = false
          signalHeld()
          await barrier
        }
        return originalBuild.call(this, options)
      }
      f.MindMapNode.prototype.render = function(...args) {
        if (switched && String(this.uid).startsWith('old-')) staleCalls++
        return originalRender.apply(this, args)
      }
      try {
        mm.render()
        await Promise.race([held, f.delay(3000).then(() => {
          throw new Error('HARNESS_BOUNDARY_NOT_REACHED: actual async index did not start')
        })])
        const generationBefore = mm.renderer._renderGeneration
        switched = true
        let completeResolve
        const complete = new Promise(resolve => { completeResolve = resolve })
        const onEnd = () => {
          if (mm.renderer.root && mm.renderer.root.getData('uid') === 'new-root') completeResolve(true)
        }
        mm.on('node_tree_render_end', onEnd)
        mm.setData(prefixUids(f.wideLayered(4), 'new-'))
        // Allow the actual queued replacement render to encounter the in-flight
        // pass before it resumes. This is ordinary state, not the RED assertion.
        await f.delay(10)
        const generationAfter = mm.renderer._renderGeneration
        release()
        const completed = await Promise.race([complete, f.delay(3000).then(() => false)])
        mm.off('node_tree_render_end', onEnd)
        await f.delay(20)
        return { staleCalls, generationBefore, generationAfter, completed,
          isRendering: mm.renderer.isRendering, hasWaitRendering: mm.renderer.hasWaitRendering,
          currentRoot: mm.renderer.root && mm.renderer.root.getData('uid'),
          newRootConnected: !!(mm.renderer.root && mm.renderer.root.group && mm.renderer.root.group.node.isConnected),
          ghosts: mm.nodeDraw.node.querySelectorAll('[data-uid^="old-"]').length }
      } finally {
        release()
        f.MindMapNode.prototype.render = originalRender
        mm.renderer.buildViewportIndex = originalBuild
        mm.destroy()
      }
    })
    const source = fs.readFileSync(path.join(repo, 'simple-mind-map/src/core/render/Render.js'))
    const report = { phase, browser: harness.browser.version(), observed, errors: harness.errors,
      rendererSha256: crypto.createHash('sha256').update(source).digest('hex'),
      boundary: 'Actual engine with one async production index call paused at an await boundary. Replacement uses actual MindMap.setData. No algorithm, cancellation decision, or index result is stubbed.' }
    fs.writeFileSync(path.join(destination, 'viewport-review-barriers.json'), JSON.stringify(report, null, 2))
    assert.deepEqual(harness.errors, [], 'Browser exceptions are infrastructure failures')
    assert.equal(observed.completed, true, 'Cancelling the old index must still finish the new tree')
    assert.equal(observed.currentRoot, 'new-root')
    assert.equal(observed.newRootConnected, true)
    assert.equal(observed.isRendering, false)
    assert.equal(observed.hasWaitRendering, false)
    assert.equal(observed.ghosts, 0)
    assert.equal(observed.staleCalls, 0, 'Old tree must never paint after setData during async indexing')
  } finally { await harness.close() }
})

test('old computed layout callback cannot clear the active replacement render after cancelRender', async () => {
  const phase = process.env.PERF_TDD_PHASE || 'red'
  const destination = path.join(repo, 'work/performance-tdd', phase, 'renderer')
  fs.mkdirSync(destination, { recursive: true })
  const harness = await createHarness({ contents: "import './tests/performance/renderer-browser-entry.js'" })
  try {
    const observed = await harness.page.evaluate(async () => {
      const f = rendererFixture
      const prefixUids = (data, prefix) => {
        data.data.uid = prefix + data.data.uid
        ;(data.children || []).forEach(child => prefixUids(child, prefix))
        return data
      }
      const mm = await f.create(prefixUids(f.wideLayered(4), 'old-'), {
        compactLayout: false, openPerformance: true
      })
      const originalLayout = mm.renderer.layout.doLayout
      const originalRender = f.MindMapNode.prototype.render
      const deliveries = []
      const ready = []
      const held = [new Promise(resolve => { ready[0] = resolve }),
        new Promise(resolve => { ready[1] = resolve })]
      let call = 0, switched = false, staleCalls = 0
      // The genuine layout has completed before its callback is held. Both
      // callbacks still execute their actual captured Render._render closures.
      mm.renderer.layout.doLayout = function(callback) {
        const index = call++
        return originalLayout.call(this, root => {
          if (index < 2) {
            deliveries[index] = () => callback(root)
            ready[index]()
          } else callback(root)
        })
      }
      f.MindMapNode.prototype.render = function(...args) {
        if (switched && String(this.uid).startsWith('old-')) staleCalls++
        return originalRender.apply(this, args)
      }
      const reachBoundary = promise => Promise.race([promise, f.delay(3000).then(() => {
        throw new Error('HARNESS_BOUNDARY_NOT_REACHED: actual completed layout callback did not arrive')
      })])
      try {
        mm.render()
        await reachBoundary(held[0])
        const oldGeneration = mm.renderer._renderGeneration
        mm.renderer.cancelRender()
        const cancelClearedActivePass = !mm.renderer.isRendering
        switched = true
        let completeResolve
        const complete = new Promise(resolve => { completeResolve = resolve })
        const onEnd = () => {
          if (mm.renderer.root && mm.renderer.root.getData('uid') === 'new-root') completeResolve(true)
        }
        mm.on('node_tree_render_end', onEnd)
        mm.setData(prefixUids(f.wideLayered(4), 'new-'))
        await reachBoundary(held[1])
        const newGeneration = mm.renderer._renderGeneration
        const activeBeforeOldDelivery = mm.renderer.isRendering
        deliveries[0]()
        const activeAfterOldDelivery = mm.renderer.isRendering
        deliveries[1]()
        const completed = await Promise.race([complete, f.delay(3000).then(() => false)])
        mm.off('node_tree_render_end', onEnd)
        await f.delay(20)
        return { oldGeneration, newGeneration, cancelClearedActivePass,
          activeBeforeOldDelivery, activeAfterOldDelivery, completed, staleCalls,
          currentRoot: mm.renderer.root && mm.renderer.root.getData('uid'),
          newRootConnected: !!(mm.renderer.root && mm.renderer.root.group && mm.renderer.root.group.node.isConnected),
          finalIsRendering: mm.renderer.isRendering, finalHasWaitRendering: mm.renderer.hasWaitRendering,
          ghosts: mm.nodeDraw.node.querySelectorAll('[data-uid^="old-"]').length }
      } finally {
        f.MindMapNode.prototype.render = originalRender
        mm.renderer.layout.doLayout = originalLayout
        mm.destroy()
      }
    })
    const source = fs.readFileSync(path.join(repo, 'simple-mind-map/src/core/render/Render.js'))
    const report = { phase, browser: harness.browser.version(), observed, errors: harness.errors,
      rendererSha256: crypto.createHash('sha256').update(source).digest('hex'),
      boundary: 'Actual layout executes fully; only callback delivery is paused. Public renderer.cancelRender and actual MindMap.setData start the replacement. Releasing callbacks invokes the original production Render closures.' }
    fs.writeFileSync(path.join(destination, 'viewport-callback-review.json'), JSON.stringify(report, null, 2))
    assert.deepEqual(harness.errors, [], 'Browser exceptions are infrastructure failures')
    assert.equal(observed.cancelClearedActivePass, true)
    assert.ok(observed.newGeneration > observed.oldGeneration)
    assert.equal(observed.activeBeforeOldDelivery, true, 'Replacement layout must genuinely be active at the boundary')
    assert.equal(observed.completed, true, 'New callback must still finish its real render')
    assert.equal(observed.currentRoot, 'new-root')
    assert.equal(observed.newRootConnected, true)
    assert.equal(observed.finalIsRendering, false)
    assert.equal(observed.finalHasWaitRendering, false)
    assert.equal(observed.ghosts, 0)
    assert.equal(observed.staleCalls, 0)
    assert.equal(observed.activeAfterOldDelivery, true, 'Old cancelled callback must not clear the active new pass')
  } finally { await harness.close() }
})
