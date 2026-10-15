const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { createHash } = require('node:crypto')
const { startFixture, repo } = require('./online-web-fixture.cjs')
const { openEditor } = require('./online-browser-smoke.cjs')
const { mountPersistedTree, settled } = require('./online-browser-matrix.cjs')
const { chromium } = require(path.join(repo, 'simple-mind-map/node_modules/@playwright/test'))
const { runRendererCorrectness, prepareRendererCorrectnessFixture } = require(path.join(repo, 'simple-mind-map/test/c2RendererCorrectness.browser.test.js'))
const observe = require('./online-browser-observation.cjs')
const { closeOwnedFixture } = require('./online-cleanup.cjs')
const sourceManifest = require('./online-source-manifest.cjs')
const { onlineOutputDirectory } = require('./online-output-directory.cjs')
const { PDFDocument } = require(path.join(repo, 'simple-mind-map/node_modules/pdf-lib'))

async function waitMoveCommit(frames, moveId, targetId) {
  const deadline = Date.now() + 300000
  while (Date.now() < deadline) {
    const sent = frames.find(frame => frame.direction === 'sent' && frame.event === 'op' && frame.body.type === 'node.move' &&
      JSON.stringify(frame.body.payload).includes(moveId) && JSON.stringify(frame.body.payload).includes(targetId))
    const ack = sent && frames.find(frame => frame.direction === 'received' && frame.kind === 'ack' && frame.body.opId === sent.body.opId && frame.body.ok)
    if (ack) return { sent, ack }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Actual native move commit ACK deadline')
}

let lastAttachmentObservation
async function attachmentState(client, present, expected, timeoutMs = 300000, clearRepresentation = 'blank-or-canonical-absent') {
  const deadline = Date.now() + timeoutMs
  let lastSavedAt = 0
  const output = onlineOutputDirectory(process.env.PERF_TDD_ONLINE_PHASE || 'after', 'full-App-correctness')
  while (Date.now() < deadline) {
    lastAttachmentObservation = await client.page.evaluate(({ present, expected, clearRepresentation }) => {
      const mm = __onlineMM, r = mm.renderer, root = r.findNodeByUid('root'), raw = r.renderTree && r.renderTree.data
      const data = root && root.getData(), group = root && root.group && root.group.node
      const icon = group && group.querySelector('.smm-attachment-icon')
      const actual = root && root._attachmentData && root._attachmentData.node.node
      const rect = group && group.getBoundingClientRect(), canvas = mm.el.getBoundingClientRect()
      const iconRect = icon && icon.getBoundingClientRect()
      const visible = box => !!(box && box.right > canvas.left && box.bottom > canvas.top && box.left < canvas.right && box.top < canvas.bottom)
      const sameFields = !!data && Object.keys(expected).every(key => data[key] === expected[key])
      // The actual NodeAttachment UI uses blank strings for local clearing;
      // Cooperate normalizes these nullable feature values to canonical null.
      const localBlankFields = !!data && Object.keys(expected).every(key => data[key] === '')
      const canonicalAbsentFields = !!data && Object.keys(expected).every(key => data[key] == null)
      const absentFields = clearRepresentation === 'blank' ? localBlankFields :
        !!data && Object.keys(expected).every(key => data[key] === '' || data[key] == null)
      const validIcon = !!(icon && icon === actual && icon.isConnected && mm.nodeDraw.node.contains(icon) &&
        icon.getAttribute('data-smm-attachment-state') === 'ready' && icon.getAttribute('data-smm-attachment-preview') === 'ready' &&
        Number(icon.getAttribute('width')) > 0 && Number(icon.getAttribute('height')) > 0 &&
        icon.querySelector('title')?.textContent.includes(expected.attachmentName))
      const fields = value => value && Object.fromEntries(Object.keys(expected).map(key => [key, value[key]]))
      const fieldTypes = value => value && Object.fromEntries(Object.keys(expected).map(key => [key, { present: Object.hasOwn(value, key),
        type: value[key] === null ? 'null' : typeof value[key] }]))
      const rootViewportVisible = visible(rect), iconViewportVisible = visible(iconRect)
      return { expectedPresent: present, rootExists: !!root, modelUid: raw && raw.uid, instanceUid: data && data.uid,
        rawFields: fields(raw), instanceFields: fields(data), rawFieldTypes: fieldTypes(raw), instanceFieldTypes: fieldTypes(data), sameFields,
        clearRepresentation, localBlankFields, canonicalAbsentFields, absentFields, validIcon,
        rootConnected: !!(group && group.isConnected), rootViewportVisible,
        icon: { exists: !!icon, connected: !!(icon && icon.isConnected), actualObjectMatches: icon === actual, viewportVisible: iconViewportVisible },
        renderer: { isRendering: r.isRendering, renderTimer: !!r.renderTimer, hasWaitRendering: r.hasWaitRendering },
        matches: present ? sameFields && validIcon && rootViewportVisible && iconViewportVisible : absentFields && !icon }
    }, { present, expected, clearRepresentation })
    if (Date.now() - lastSavedAt >= 5000 || lastAttachmentObservation.matches) {
      // Auxiliary evidence failures are captured and cannot reject the actual
      // product predicate or crash its dedicated runner.
      try { fs.appendFileSync(path.join(output, 'attachment-state-observations.ndjson'), JSON.stringify({ at: Date.now(), ...lastAttachmentObservation }) + '\n') }
      catch (error) { console.error('HARNESS_ATTACHMENT_OBSERVATION_WRITE_ERROR:', error.message) }
      lastSavedAt = Date.now()
    }
    if (lastAttachmentObservation.matches) return lastAttachmentObservation
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('Actual attachment predicate deadline: ' + JSON.stringify(lastAttachmentObservation))
}

async function attachmentOperation(client, fixture, roomKey, frames, command, attachment) {
  const start = frames.length
  const commandObservation = await client.page.evaluate(async ({ command }) => {
    const mm = __onlineMM
    if (command === 'CLEAR') {
      const components = [document.querySelector('#app').__vue__], owners = []
      while (components.length) {
        const vm = components.pop()
        if (vm.mindMap === mm && vm.$options.name === 'NodeAttachment') owners.push(vm)
        components.push(...(vm.$children || []))
      }
      if (owners.length !== 1) throw new Error('HARNESS_FIXTURE: actual NodeAttachment UI owner is not unique')
      const meta = { attachmentId: '', attachmentMimeType: '', attachmentStatus: '', attachmentError: '', attachmentExtractedText: '', attachmentProgress: 0 }
      const result = owners[0].applyAttachment(mm.renderer.findNodeByUid('root'), '', '', meta)
      if (!result || !result.applied) throw new Error('Actual NodeAttachment applyAttachment did not apply its clear command')
      return { command: 'SET_NODE_ATTACHMENT', invokedThroughActualVueMethod: 'NodeAttachment.applyAttachment', url: '', name: '', meta,
        boundary: 'Actual UI command path for clearing an attachment pointer; synthetic metadata does not exercise managed attachment DELETE API or binary operations' }
    }
    mm.execCommand(command)
    if (mm.cooperate._v2HistoryQueue) await mm.cooperate._v2HistoryQueue
    return { command }
  }, { command })
  const deadline = Date.now() + 300000
  let sent, ack
  while (Date.now() < deadline) {
    const candidates = frames.slice(start)
    sent = candidates.find(frame => frame.direction === 'sent' && frame.event === 'op' && (command === 'CLEAR'
      ? JSON.stringify(frame.body.payload).includes('attachmentUrl')
      : frame.body.type === (command === 'BACK' ? 'operation.undo' : 'operation.redo')))
    ack = sent && candidates.find(frame => frame.kind === 'ack' && frame.direction === 'received' && frame.body.opId === sent.body.opId && frame.body.ok)
    if (ack) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(ack, 'Actual native attachment/Undo/Redo commit ACK')
  const present = command === 'BACK'
  const output = onlineOutputDirectory(process.env.PERF_TDD_ONLINE_PHASE || 'after', 'full-App-correctness')
  const state = await fixture.apps[0].control('state', { roomKey })
  const tree = await fixture.apps[0].control('tree', { roomKey })
  fs.writeFileSync(path.join(output, 'attachment-ack-' + command + '.json'), JSON.stringify({ command, commandObservation, present, sent, ack,
    actualPg: { revision: state.revision, count: state.count,
      rootFields: Object.fromEntries(Object.keys(attachment).map(key => [key, tree.data[key]])),
      rootFieldTypes: Object.fromEntries(Object.keys(attachment).map(key => [key, { present: Object.hasOwn(tree.data, key),
        type: tree.data[key] === null ? 'null' : typeof tree.data[key] }])) } }, null, 2))
  await attachmentState(client, present, attachment, process.env.PERF_TDD_ONLINE_ATTACHMENT_DIAGNOSTIC === '1' ? 30000 : 300000,
    command === 'CLEAR' ? 'blank' : 'blank-or-canonical-absent')
  for (const key of Object.keys(attachment)) {
    if (present) assert.equal(tree.data[key], attachment[key], 'Actual PG restored attachment metadata: ' + key)
    else assert.ok(tree.data[key] == null, 'Actual PG removed attachment metadata: ' + key)
  }
  assert.equal(Number(state.revision), Number(ack.body.serverRevision))
  assert.equal(state.count, 10000)
  return { command, present, opId: sent.body.opId, ack, state, rootFields: Object.fromEntries(Object.keys(attachment).map(key => [key, tree.data[key]])) }
}

async function main() {
  const phase = process.env.PERF_TDD_ONLINE_PHASE || 'after'
  const output = onlineOutputDirectory(phase, 'full-App-correctness')
  fs.mkdirSync(output, { recursive: true })
  if (['result.json', 'failure.json'].some(name => fs.existsSync(path.join(output, name)))) throw new Error('REFUSE_OVERWRITE: preserve previous complete-App correctness evidence')
  const observedSource = sourceManifest.capture(phase, output)
  if (process.env.PERF_TDD_ONLINE_FROZEN_CLIENT_SOURCE) {
    const reference = path.resolve(process.env.PERF_TDD_ONLINE_FROZEN_CLIENT_SOURCE)
    assert.ok(reference.startsWith(path.join(repo, 'work/performance-tdd') + path.sep), 'Frozen reference must be in the owned evidence area')
    const frozenBytes = fs.readFileSync(reference)
    const frozen = JSON.parse(frozenBytes)
    assert.deepEqual(observedSource.webpackAssets, frozen.webpackAssets, 'Actual served webpack assets exactly match the frozen client source witness')
    observedSource.clientSourceBoundary = { reference, sha256: createHash('sha256').update(frozenBytes).digest('hex'),
      note: 'Actual current working-tree files are observed above, but the browser executes the unchanged frozen webpack5 assets. The referenced pre-change source manifest identifies that client; current uncompiled Demo/replay edits are not claimed executed. Actual backend child startup hashes are separate.' }
    fs.writeFileSync(path.join(output, 'frozen-webpack-client-source-reference.json'), frozenBytes)
    fs.writeFileSync(path.join(output, 'production-source-manifest.json'), JSON.stringify(observedSource, null, 2))
  }
  fs.writeFileSync(path.join(output, 'harness-manifest.json'), JSON.stringify({ capturedAt: Date.now(), runtime: process.version,
    files: ['online-browser-correctness.cjs','online-browser-matrix.cjs','online-browser-smoke.cjs','online-browser-observation.cjs',
      'online-web-fixture.cjs','online-server-child.cjs','online-cleanup.cjs','online-output-directory.cjs','isolation.cjs']
      .map(file => ({ file, sha256: createHash('sha256').update(fs.readFileSync(path.join(__dirname, file))).digest('hex') })),
    reusableScenario: { file: 'simple-mind-map/test/c2RendererCorrectness.browser.test.js',
      sha256: createHash('sha256').update(fs.readFileSync(path.join(repo, 'simple-mind-map/test/c2RendererCorrectness.browser.test.js'))).digest('hex') } }, null, 2))
  const fixture = await startFixture({ phase, instances: 1 })
  const frames = [], stages = []
  let browser, client, prepared, checks
  try {
    const seed = await fixture.apps[0].control('seed', { shape: 'bush' })
    assert.equal(seed.count, 10000)
    prepared = prepareRendererCorrectnessFixture(await fixture.apps[0].control('tree', { roomKey: seed.roomKey }))
    const attachment = { attachmentUrl: fixture.fronts[0].base + '/synthetic-metadata-only.pdf', attachmentName: 'Synthetic metadata only.pdf',
      attachmentId: randomUUID(), attachmentStatus: 'ready', attachmentMimeType: 'application/pdf' }
    Object.assign(prepared.tree.data, attachment)
    const persistedFixture = await fixture.apps[0].control('persistTree', { roomKey: seed.roomKey, tree: prepared.tree })
    assert.equal(persistedFixture.count, 10000)
    const tree = await fixture.apps[0].control('tree', { roomKey: seed.roomKey })
    const byUid = new Map(), stack = [tree]
    while (stack.length) { const node = stack.pop(); assert.ok(!byUid.has(node.data.uid)); byUid.set(node.data.uid, node); stack.push(...(node.children || [])) }
    assert.equal(byUid.size, 10000)
    const expected = new Map(), preparedStack = [prepared.tree]
    while (preparedStack.length) { const node = preparedStack.pop(); expected.set(node.data.uid, node); preparedStack.push(...(node.children || [])) }
    for (const uid of prepared.featureIds) {
      for (const key of ['text', 'richText', 'image', 'imageSize', 'tag', 'icon', 'hyperlink', 'hyperlinkTitle', 'fontSize', 'fontWeight', 'generalization', 'associativeLineTargets', 'outerFrame']) {
        assert.deepEqual(byUid.get(uid).data[key], expected.get(uid).data[key], 'Feature was persisted in actual PG: ' + uid + '/' + key)
      }
    }
    assert.equal(byUid.get(prepared.summaryOwnerUid).children[0].data.uid, prepared.summaryChildUid)
    for (const key of Object.keys(attachment)) assert.equal(tree.data[key], attachment[key], 'Attachment metadata starts in actual PG')
    fs.writeFileSync(path.join(output, 'persisted-fixture.json'), JSON.stringify({ persistedFixture,
      summaryOwnerUid: prepared.summaryOwnerUid, summaryChildUid: prepared.summaryChildUid, summaryUid: prepared.summaryUid,
      featureData: prepared.featureIds.map(uid => ({ uid, data: byUid.get(uid).data })) }, null, 2))
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    client = await openEditor(browser, { ...fixture, roomKey: seed.roomKey }, 0, { setupTimeoutMs: 300000, liveTimeoutMs: 300000,
      onPage: async page => {
        observe.observeWire(page, 0, frames)
        await observe.installStartupObserver(page)
        page.on('console', message => { if (message.text().startsWith('[c2-correctness-stage]')) stages.push({ at: Date.now(), text: message.text() }) })
      } })
    await mountPersistedTree(client, tree, await fixture.apps[0].control('state', { roomKey: seed.roomKey }))
    await settled(client)
    if (process.env.PERF_TDD_ONLINE_FRAME_DIAGNOSTIC === '1') {
      const observations = []
      const snapshot = stage => client.page.evaluate(({ stage, uid }) => {
        const mm = __onlineMM, r = mm.renderer, node = r.findNodeByUid(uid)
        const group = node && node.group && node.group.node
        const shape = node && node.group && node.group.findOne('.smm-node-shape')
        const rect = group && group.getBoundingClientRect(), canvas = mm.el.getBoundingClientRect()
        let box, boxError
        try { const value = shape && shape.rbox(); if (value) box = { x: value.x, y: value.y, width: value.width, height: value.height,
          finite: [value.x, value.y, value.width, value.height].every(Number.isFinite) } } catch (error) { boxError = error.message }
        return { stage, uid, nodeExists: !!node, groupConnected: !!(group && group.isConnected),
          viewportVisible: !!(rect && rect.right > canvas.left && rect.bottom > canvas.top && rect.left < canvas.right && rect.top < canvas.bottom),
          modelBox: node && { left: node.left, top: node.top, width: node.width, height: node.height }, shapeBox: box, shapeBoxError: boxError,
          frameData: node && node.getData('outerFrame'), layoutEpoch: r._layoutEpoch, frameEpoch: mm.outerFrame._frameEpoch,
          frames: mm.outerFrame.outerFrameElList.map(frame => ({ connected: frame.node.isConnected,
            stroke: frame.attr('stroke'), width: frame.attr('width'), height: frame.attr('height'),
            inPluginDraw: mm.outerFrame.draw.node.contains(frame.node) })),
          uidIndex: r.nodeIndex.size, isRendering: r.isRendering, adapterRevision: mm.cooperate.collabV2Adapter.getStatus().lastServerRevision }
      }, { stage, uid: prepared.frameNodeUid })
      observations.push(await snapshot('initial-ready'))
      for (const [stage, uid] of [['frame-visible', prepared.frameNodeUid], ['leave-frame', 'root'], ['frame-reentry', prepared.frameNodeUid]]) {
        await client.page.evaluate(uid => __onlineMM.execCommand('GO_TARGET_NODE', uid), uid)
        await settled(client)
        await client.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        observations.push(await snapshot(stage))
      }
      fs.writeFileSync(path.join(output, 'frame-diagnostic.json'), JSON.stringify({ status: 'DIAGNOSTIC_ONLY', browser: browser.version(),
        observations, boundary: 'Actual full App, canonical PG fixture and native GO_TARGET_NODE view commands; no manual frame render, option change, model edit or assertion bypass' }, null, 2))
      return
    }
    const config = await client.page.evaluate(() => {
      window.__C2_STABLE_MM__ = __onlineMM
      return { openPerformance: __onlineMM.opt.openPerformance, compactLayout: __onlineMM.opt.compactLayout,
        layout: __onlineMM.getLayout(), actualAdapter: !!__onlineMM.cooperate.collabV2Adapter }
    })
    assert.ok(config.openPerformance && config.actualAdapter)
    if (process.env.PERF_TDD_ONLINE_ATTACHMENT_DIAGNOSTIC === '1') {
      for (const uid of [prepared.frameNodeUid, 'root']) {
        await client.page.evaluate(uid => __onlineMM.execCommand('GO_TARGET_NODE', uid), uid)
        await settled(client)
        await client.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      }
      await attachmentState(client, true, attachment, 30000)
      const actualOperations = []
      for (const command of ['CLEAR', 'BACK', 'FORWARD']) actualOperations.push(await attachmentOperation(client, fixture, seed.roomKey, frames, command, attachment))
      // Real chain check: after FORWARD settles, a single BACK must restore the
      // original attachment metadata and visible icon. A redundant queued
      // notification pushed onto the undo stack would otherwise make the next
      // Undo a no-op. A failed predicate here fails the run (real RED evidence).
      await settled(client)
      const undoBefore = await client.page.evaluate(() => {
        const status = __onlineMM.cooperate.collabV2Adapter.getStatus()
        return { undoDepth: status.undoDepth, redoDepth: status.redoDepth, undoTop: status.undoTop }
      })
      const undoAfterForward = await attachmentOperation(client, fixture, seed.roomKey, frames, 'BACK', attachment)
      fs.writeFileSync(path.join(output, 'attachment-undo-after-forward.json'), JSON.stringify({
        status: 'UNDO_AFTER_FORWARD_MEASURED', undoBefore, undoAfterForward, browser: browser.version(),
        boundary: 'Actual full App/PG attachment fixture and native CLEAR/BACK/FORWARD/settle/BACK; no manual model or predicate mutation, no fabricated ACK, no inspector' }, null, 2))
      fs.writeFileSync(path.join(output, 'attachment-diagnostic.json'), JSON.stringify({ status: 'DIAGNOSTIC_ONLY_ATTACHMENT_CHAIN_OBSERVED',
        actualOperations, lastAttachmentObservation, browser: browser.version(),
        boundary: 'Actual full App/PG attachment fixture, frame→root native viewport commands, native CLEAR/BACK/FORWARD and real ACKs; no inspector, no model/predicate mutation or manual frame draw' }, null, 2))
      return
    }
    await attachmentState(client, true, attachment)
    checks = await runRendererCorrectness(client.page, tree, { fixture: prepared })
    fs.writeFileSync(path.join(output, 'checks.json'), JSON.stringify(checks, null, 2))
    Object.entries(checks).forEach(([key, value]) => assert.equal(value, true, key + ' full-App correctness'))
    const moveCommit = await waitMoveCommit(frames, prepared.moveId, prepared.moveTargetId)
    // A genuine ACK can arrive before a large local move layout completes.
    // Observe the final model/render boundary before the next UI command.
    await settled(client)
    // The existing feature scenario navigates to a deep edited node. Arrange
    // the actual viewport for the following root attachment visibility check.
    await client.page.evaluate(() => __onlineMM.execCommand('GO_TARGET_NODE', 'root'))
    await client.page.waitForFunction(() => {
      const mm = __onlineMM, root = mm.renderer.findNodeByUid('root')
      const group = root && root.group && root.group.node
      const rect = group && group.getBoundingClientRect(), canvas = mm.el.getBoundingClientRect()
      return group && group.isConnected && rect.right > canvas.left && rect.bottom > canvas.top &&
        rect.left < canvas.right && rect.top < canvas.bottom
    }, null, { timeout: 300000 })
    await client.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const attachments = []
    for (const command of ['CLEAR', 'BACK', 'FORWARD']) attachments.push(await attachmentOperation(client, fixture, seed.roomKey, frames, command, attachment))
    await settled(client)
    const committed = await fixture.apps[0].control('state', { roomKey: seed.roomKey })
    assert.equal(committed.count, 10000)
    // The attachment clear must not leave a trailing redundant content
    // notification after the history ops: such a write would enter the undo
    // stack as a no-op step (the next Undo would do nothing). The final
    // committed revision must therefore be the FORWARD acknowledgement and no
    // extra root attachment content write may follow it.
    assert.equal(Number(committed.revision), Number(attachments.at(-1).ack.body.serverRevision), 'Final PG revision equals the FORWARD acknowledgement')
    const rootAttachmentWrites = frames.filter(frame => frame.direction === 'sent' && frame.event === 'op' && frame.body.type === 'node.update' && frame.body.payload && frame.body.payload.uid === 'root' && Object.prototype.hasOwnProperty.call(frame.body.payload, 'attachmentUrl'))
    assert.equal(rootAttachmentWrites.length, 1, 'Exactly one root attachment content write (the CLEAR); no trailing redundant notification')
    const committedTree = await fixture.apps[0].control('tree', { roomKey: seed.roomKey })
    for (const key of Object.keys(attachment)) assert.ok(committedTree.data[key] == null, 'Actual final PG root attachment field is cleared: ' + key)
    const committedRows = new Map(), committedStack = [{ node: committedTree, parent: null }]
    while (committedStack.length) {
      const { node, parent } = committedStack.pop()
      committedRows.set(node.data.uid, { data: node.data, parent })
      for (const child of node.children || []) committedStack.push({ node: child, parent: node.data.uid })
    }
    assert.equal(committedRows.get(prepared.moveId).parent, prepared.moveTargetId, 'Actual native move is durable in PG')
    assert.ok(committedRows.get(prepared.featureIds[1]).data.text.includes('Edited text'), 'Actual Redo final text is durable in PG')
    assert.deepEqual(committedRows.get(prepared.summaryOwnerUid).data.generalization[0].range, [0, 0])
    const exported = await client.page.evaluate(({ summaryOwnerUid, summaryUid, summaryChildUid, featureIds }) => {
      const mm = __onlineMM
      const modelUids = [], modelStack = [mm.renderer.renderTree]
      while (modelStack.length) { const node = modelStack.pop(); modelUids.push(node.data.uid); modelStack.push(...(node.children || [])) }
      const offscreenBefore = modelUids.slice(-10).map(uid => {
        const node = mm.renderer.findNodeByUid(uid)
        const group = node && node.group && node.group.node
        const rect = group && group.getBoundingClientRect()
        return { uid, attached: !!(group && group.isConnected), inViewport: !!(rect && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight) }
      })
      const startedAt = performance.now()
      const data = mm.getSvgData()
      const exportReturnedAt = performance.now()
      const doc = new DOMParser().parseFromString(data.svgHTML, 'image/svg+xml')
      const groups = Array.from(doc.querySelectorAll('g.smm-node'))
      const byUid = new Map(groups.map(group => [group.getAttribute('data-node-uid'), group]))
      const owner = mm.renderer.findNodeByUid(summaryOwnerUid)
      const summary = owner._generalizationList.find(item => item.generalizationNode.getData('uid') === summaryUid)
      const summaryGroup = summary.generalizationNode.group.node
      const bracket = summary.generalizationLine
      const bracketD = bracket.attr('d')
      const cloneBracket = Array.from(doc.querySelectorAll('path')).find(element => element.getAttribute('d') === bracketD)
      const formulaGroup = byUid.get(featureIds[3])
      const math = formulaGroup && formulaGroup.querySelector('.ql-formula math msup')
      const imageGroup = byUid.get(featureIds[4])
      const image = imageGroup && imageGroup.querySelector('image')
      const frame = Array.from(doc.querySelectorAll('.smm-outer-frame-container rect')).find(element => element.getAttribute('stroke') === '#123456')
      const canvas = mm.el.getBoundingClientRect()
      const nativePoint = (element, point) => new DOMPoint(point.x, point.y).matrixTransform(element.getScreenCTM())
      const fullEdges = Array.from(mm.renderer._visibleViewportEdges).map(item => {
        const element = item.element, rect = element.getBoundingClientRect(), length = element.getTotalLength()
        const from = nativePoint(element, element.getPointAtLength(0))
        const to = nativePoint(element, element.getPointAtLength(length))
        const middle = nativePoint(element, element.getPointAtLength(length / 2))
        return { item, element, length, rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
          from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y }, middle: { x: middle.x, y: middle.y } }
      })
      const center = { x: canvas.left + mm.width / 2, y: canvas.top + mm.height / 2 }
      const inside = point => point.x >= canvas.left && point.x <= canvas.right && point.y >= canvas.top && point.y <= canvas.bottom
      const crossing = fullEdges.find(edge => edge.length > 2 * Math.max(mm.width, mm.height) && /[CQ]/.test(edge.element.getAttribute('d')) &&
        !inside({ x: edge.from.x + center.x - edge.middle.x, y: edge.from.y + center.y - edge.middle.y }) &&
        !inside({ x: edge.to.x + center.x - edge.middle.x, y: edge.to.y + center.y - edge.middle.y }))
      if (!crossing) throw new Error('HARNESS_FIXTURE: no long primary connector with both endpoints outside centered viewport')
      window.__onlineExportScene = { fullEdges, crossing, center, beforeTransform: mm.view.getTransformData().transform }
      const result = { elapsedMs: performance.now() - startedAt, getSvgDataMs: exportReturnedAt - startedAt,
        parseAndInspectMs: performance.now() - exportReturnedAt, nodeGroups: doc.querySelectorAll('g.smm-node').length,
        parserErrors: doc.querySelectorAll('parsererror').length, searchText: data.svgHTML.includes('Search needle'),
        editedText: data.svgHTML.includes('Edited text'), bytes: new Blob([data.svgHTML]).size,
        completeModelGroups: modelUids.every(uid => byUid.has(uid)), modelUniqueUids: new Set(modelUids).size,
        offscreenBefore, tailExported: offscreenBefore.every(item => byUid.has(item.uid)),
        formula: !!(math && math.querySelector('mi')?.textContent === 'x' && math.querySelector('mn')?.textContent === '2'),
        image: !!(image && /^data:image\//.test(image.getAttribute('href') || image.getAttributeNS('http://www.w3.org/1999/xlink','href') || '') &&
          Number(image.getAttribute('width')) > 0 && Number(image.getAttribute('height')) > 0),
        outerFrame: !!(frame && Number(frame.getAttribute('width')) > 0 && Number(frame.getAttribute('height')) > 0),
        summary: { ownerUid: summaryOwnerUid, childUid: summaryChildUid, uid: summaryUid,
          ownerChild: owner.children[0].getData('uid') === summaryChildUid, correctParent: summary.generalizationNode.parent === owner,
          connectedNode: mm.nodeDraw.node.contains(summaryGroup) && summaryGroup.isConnected,
          connectedBracket: mm.lineDraw.node.contains(bracket.node) && bracket.node.isConnected,
          bracketD, bracketBox: { width: bracket.bbox().width, height: bracket.bbox().height },
          cloneNode: !!byUid.get(summaryUid), cloneBracket: !!cloneBracket } }
      if (data.svg && data.svg.node !== mm.svg.node) data.svg.remove()
      return result
    }, prepared)
    assert.equal(exported.parserErrors, 0)
    assert.equal(exported.modelUniqueUids, 10000)
    assert.ok(exported.nodeGroups >= 10001 && exported.completeModelGroups && exported.tailExported && exported.searchText && exported.editedText,
      'Explicit SVG export contains every actual model UID, summary, and final text')
    assert.ok(exported.formula && exported.image, 'Explicit SVG export preserves actual MathML and image geometry')
    assert.ok(exported.outerFrame, 'Complete SVG export preserves the actual feature frame with positive geometry')
    assert.ok(exported.summary.ownerChild && exported.summary.correctParent && exported.summary.connectedNode && exported.summary.connectedBracket &&
      exported.summary.cloneNode && exported.summary.cloneBracket && /M/.test(exported.summary.bracketD) && /[QL]/.test(exported.summary.bracketD) &&
      exported.summary.bracketBox.width > 0 && exported.summary.bracketBox.height > 0, 'Actual summary node and bracket connect to the intended child and survive full SVG export')
    const raster = await client.page.evaluate(async () => {
      const mm = __onlineMM, exporter = mm.doExport
      const nativeGetSvgData = exporter.getSvgData
      let input
      // Observe the real SVG sent through the native PNG exporter; the return
      // value and arguments are preserved, and the original is always restored.
      exporter.getSvgData = async function (...args) {
        const result = await nativeGetSvgData.apply(this, args)
        const doc = new DOMParser().parseFromString(result.str, 'image/svg+xml')
        const root = doc.documentElement
        input = { width: Number(root.getAttribute('width')), height: Number(root.getAttribute('height')),
          nodeGroups: doc.querySelectorAll('g.smm-node').length,
          uniqueNodeUids: new Set(Array.from(doc.querySelectorAll('g.smm-node')).map(group => group.getAttribute('data-node-uid'))).size,
          formula: !!doc.querySelector('.ql-formula math msup'), image: !!doc.querySelector('image'),
          clipData: result.clipData || null }
        return result
      }
      try {
        const png = await exporter.png('full-app-10k-protection')
        const dimensions = await new Promise((resolve, reject) => {
          const image = new Image()
          image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
          image.onerror = () => reject(new Error('Native 10k PNG could not be decoded'))
          image.src = png
        })
        const pdf = await mm.doExportPDF.pdf(png)
        return { png, pdf, input, dimensions, dpr: Math.max(devicePixelRatio, mm.opt.minExportImgCanvasScale),
          maxCanvasSize: mm.opt.maxCanvasSize, boundary: 'Native PNG contains the full SVG input at configured canvas scaling. PDF wraps the same actual PNG; dimensions do not prove individual raster pixels or external binary attachment downloads.' }
      } finally { exporter.getSvgData = nativeGetSvgData }
    })
    assert.ok(raster.input && !raster.input.clipData, 'Native PNG used complete un-clipped SVG')
    assert.equal(raster.input.nodeGroups, 10001)
    assert.equal(raster.input.uniqueNodeUids, 10001)
    assert.ok(raster.input.formula && raster.input.image)
    let expectedWidth = raster.input.width * raster.dpr, expectedHeight = raster.input.height * raster.dpr
    if (expectedWidth > raster.maxCanvasSize) { expectedHeight *= raster.maxCanvasSize / expectedWidth; expectedWidth = raster.maxCanvasSize }
    else if (expectedHeight > raster.maxCanvasSize) { expectedWidth *= raster.maxCanvasSize / expectedHeight; expectedHeight = raster.maxCanvasSize }
    assert.ok(Math.abs(raster.dimensions.width - expectedWidth) < 1 && Math.abs(raster.dimensions.height - expectedHeight) < 1,
      'Native PNG preserves full SVG aspect and configured maximum-canvas scaling')
    const pngBytes = Buffer.from(raster.png.split(',')[1], 'base64')
    const pdfBytes = Buffer.from(raster.pdf.split(',')[1], 'base64')
    const pdfDocument = await PDFDocument.load(pdfBytes)
    assert.equal(pdfDocument.getPageCount(), 1)
    assert.deepEqual(pdfDocument.getPages()[0].getSize(), raster.dimensions, 'Actual PDF page covers the native PNG full bounds')
    fs.writeFileSync(path.join(output, 'full-10k.png'), pngBytes)
    fs.writeFileSync(path.join(output, 'full-10k.pdf'), pdfBytes)
    const rasterBounds = { input: raster.input, dimensions: raster.dimensions, dpr: raster.dpr, maxCanvasSize: raster.maxCanvasSize,
      pages: 1, pdfSize: pdfDocument.getPages()[0].getSize(), pngBytes: pngBytes.length, pdfBytes: pdfBytes.length,
      pngSha256: createHash('sha256').update(pngBytes).digest('hex'), pdfSha256: createHash('sha256').update(pdfBytes).digest('hex'), boundary: raster.boundary }
    const viewportRecovery = await client.page.evaluate(async () => {
      const mm = __onlineMM, r = mm.renderer, scene = __onlineExportScene
      const before = { nodes: mm.nodeDraw.node.querySelectorAll('g.smm-node').length, edges: r._visibleViewportEdges.size }
      const target = scene.crossing
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { mm.off('node_tree_render_end', done); reject(new Error('Post-export actual view render timeout')) }, 300000)
        const done = event => {
          if (!event || event.reason !== 'view') return
          clearTimeout(timeout); mm.off('node_tree_render_end', done); resolve()
        }
        mm.on('node_tree_render_end', done)
        mm.view.translateXY(scene.center.x - target.middle.x, scene.center.y - target.middle.y)
      })
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const afterTransform = mm.view.getTransformData().transform
      const dx = afterTransform.translateX - scene.beforeTransform.translateX
      const dy = afterTransform.translateY - scene.beforeTransform.translateY
      const canvas = mm.el.getBoundingClientRect(), padding = mm.opt.performanceConfig.padding || 0
      const expectedEdges = scene.fullEdges.filter(edge => edge.rect.right + dx >= canvas.left - padding && edge.rect.left + dx <= canvas.right + padding &&
        edge.rect.bottom + dy >= canvas.top - padding && edge.rect.top + dy <= canvas.bottom + padding)
      const missing = expectedEdges.filter(edge => !edge.element.isConnected || !mm.lineDraw.node.contains(edge.element))
      const actualGroups = Array.from(mm.nodeDraw.node.querySelectorAll('g.smm-node'))
      const attachedSet = new Set(Array.from(r._visibleViewportNodes).map(node => node.group && node.group.node))
      const actualLines = Array.from(mm.lineDraw.node.querySelectorAll('path'))
      const actualEdgeSet = new Set(Array.from(r._visibleViewportEdges).map(edge => edge.element))
      const modelIds = new Set(), stack = [r.renderTree]
      while (stack.length) { const node = stack.pop(); modelIds.add(node.data.uid); stack.push(...(node.children || [])) }
      const matrix = target.element.getScreenCTM()
      const point = target.element.getPointAtLength(target.length / 2)
      const middle = matrix && new DOMPoint(point.x, point.y).matrixTransform(matrix)
      const from = { x: target.from.x + dx, y: target.from.y + dy }, to = { x: target.to.x + dx, y: target.to.y + dy }
      const inside = point => point && point.x >= canvas.left && point.x <= canvas.right && point.y >= canvas.top && point.y <= canvas.bottom
      const summary = r.findNodeByUid('c2-generalization')
      const result = { before, after: { nodes: actualGroups.length, edges: actualLines.length, models: modelIds.size,
          visibleNodeSet: r._visibleViewportNodes.size, visibleEdgeSet: r._visibleViewportEdges.size, uidIndex: r.nodeIndex.size },
        expectedPrimaryEdges: expectedEdges.length, missingPrimaryEdges: missing.map(edge => edge.element.getAttribute('d')).slice(0, 8),
        nodeSetMatchesAttached: actualGroups.length === attachedSet.size && actualGroups.every(group => attachedSet.has(group)),
        edgeSetMatchesAttached: actualLines.length === actualEdgeSet.size && actualLines.every(line => actualEdgeSet.has(line)),
        summaryRetainedInModelIndex: !!summary && summary.getData('uid') === 'c2-generalization',
        crossing: { connected: target.element.isConnected && mm.lineDraw.node.contains(target.element), midpointVisible: inside(middle),
          bothEndpointsOutside: !inside(from) && !inside(to), d: target.element.getAttribute('d') } }
      delete window.__onlineExportScene
      return result
    })
    assert.equal(viewportRecovery.after.models, 10000)
    assert.equal(viewportRecovery.after.uidIndex, 10001)
    assert.ok(viewportRecovery.after.nodes < viewportRecovery.before.nodes && viewportRecovery.summaryRetainedInModelIndex,
      'Actual post-export view change restores culling without losing the complete model/summary index')
    assert.ok(viewportRecovery.nodeSetMatchesAttached && viewportRecovery.edgeSetMatchesAttached && !viewportRecovery.missingPrimaryEdges.length,
      'Actual attached node/primary connector sets equal their viewport records and keep every intersecting primary path')
    assert.ok(viewportRecovery.crossing.connected && viewportRecovery.crossing.midpointVisible && viewportRecovery.crossing.bothEndpointsOutside,
      'Actual primary curve crosses the viewport while both endpoints are outside after full export')
    const result = { phase, status: 'FULL_APP_PLUGIN_PROTECTION_MEASURED', checks, config, seed,
      authentication: 'Synthetic auth plus explicit fixture health/runtime bootstrap; actual full App, native plugin components and real ACL/PG/business HTTP/socket',
      fixtureBoundaries: fixture.fixtureBoundaries,
      boundary: 'Reusable plugin scenario from c2RendererCorrectness runs on actual complete App; explicit synchronous complete SVG export measured separately; data-URI image/formula are real plugins; attachment metadata/icon/delete/Undo/Redo use real PG/native ACK and visible SVG, but synthetic attachment URL/ID does not prove upload/binary download/file preview; external network blocked',
      stages, exported, rasterBounds, viewportRecovery, committed, moveCommit, attachments, persistedFixture, errors: client.errors, bundleHashes: fixture.bundleHashes, browser: browser.version(),
      runtime: process.version, appRuntime: fixture.apps[0].runtime,
      resources: await observe.resourceSnapshot(client) }
    assert.equal(client.errors.length, 0)
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
  } catch (error) {
    let diagnostics, timer
    if (client && prepared) {
      try {
        diagnostics = await Promise.race([client.page.evaluate(prepared => {
          const mm = __onlineMM, renderer = mm && mm.renderer
          if (!renderer) return { editorUnavailable: true }
          const canvas = mm.el && mm.el.getBoundingClientRect()
          const inside = box => !!(box && canvas && box.right > canvas.left && box.bottom > canvas.top && box.left < canvas.right && box.top < canvas.bottom)
          const nodes = prepared.featureIds.map(uid => {
            const node = renderer.findNodeByUid(uid), element = node && node.group && node.group.node
            const box = element && element.getBoundingClientRect()
            return { uid, exists: !!node, attached: !!(element && element.isConnected), inViewport: inside(box),
              box: box && box.toJSON(), currentText: node && node.getData('text'),
              foreignObject: !!(node && node._textData && node._textData.node && node._textData.node.node.querySelector('foreignObject')),
              imageData: !!(node && node._imgData), parentUid: node && node.parent && node.parent.getData('uid') }
          })
          const owner = renderer.findNodeByUid(prepared.summaryOwnerUid)
          return { nodes, summaryOwnerUid: prepared.summaryOwnerUid, summaryCount: owner && owner._generalizationList.length,
            rootText: renderer.root && renderer.root.getData('text'), isRendering: renderer.isRendering,
            generation: renderer._renderGeneration, cacheCount: Object.keys(renderer.nodeCache || {}).length,
            nodeIndex: renderer.nodeIndex && renderer.nodeIndex.size, status: mm.cooperate.collabV2Adapter.getStatus(),
            associatedLines: mm.associativeLine.lineList.length, outerFrames: mm.outerFrame.outerFrameElList.length,
            longTasks: (window.__onlineLongTasks || []).slice(-10) }
        }, { featureIds: prepared.featureIds, summaryOwnerUid: prepared.summaryOwnerUid }),
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Read-only failure diagnostic exceeded5s')), 5000) })])
      } catch (captureError) { diagnostics = { captureError: captureError.message } }
      finally { clearTimeout(timer) }
    }
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, stages, checks, diagnostics, lastAttachmentObservation }, null, 2))
    throw error
  } finally {
    fs.writeFileSync(path.join(output, 'native-frames.json'), JSON.stringify(frames, null, 2))
    fs.writeFileSync(path.join(output, 'cleanup.json'), JSON.stringify(await closeOwnedFixture(browser, client ? [client] : [], fixture), null, 2))
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
