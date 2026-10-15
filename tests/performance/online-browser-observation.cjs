const assert = require('node:assert/strict')

function packet(payload) {
  const raw = String(payload)
  // Engine.IO message + native Socket.IO event/ACK. No transport is replaced.
  const match = raw.match(/^4([23])(\d*)?(\[.*)$/s)
  if (!match) return null
  try {
    const value = JSON.parse(match[3])
    return match[1] === '2'
      ? { kind: 'event', ackId: match[2] || null, event: value[0], body: value[1] }
      : { kind: 'ack', ackId: match[2] || null, body: value[0] }
  } catch (_) { return null }
}

function observeWire(page, index, frames) {
  page.on('websocket', socket => {
    for (const [event, direction] of [['framesent', 'sent'], ['framereceived', 'received']]) {
      socket.on(event, frame => {
        const parsed = packet(frame.payload)
        if (!parsed) return
        const body = parsed.body || {}
        // Keep actual operation/event/ACK bytes; initial bulk sync is metadata only.
        const operationFrame = parsed.event === 'op' || parsed.event === 'op:event' || (parsed.kind === 'ack' && body.opId)
        frames.push({ client: index, at: Date.now(), direction, ...parsed,
          raw: operationFrame ? String(frame.payload) : undefined })
      })
    }
  })
}

async function installStartupObserver(page) {
  await page.addInitScript(() => {
    window.__onlineLongTasks = []
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) __onlineLongTasks.push({ start: performance.timeOrigin + entry.startTime,
          duration: entry.duration, name: entry.name })
      }).observe({ type: 'longtask', buffered: true })
    }
  })
}

async function installEditorObserver(page) {
  await page.evaluate(() => {
    const mm = __onlineMM
    const records = Object.create(null)
    const clock = () => performance.timeOrigin + performance.now()
    function inspect(source) {
      const root = mm.renderer.root
      const rawText = root && root.getData('text')
      const text = String(rawText || '').replace(/<[^>]*>/g, '')
      if (!/^Update-\d{4,}$/.test(text || '')) return
      const record = records[text] || (records[text] = { text, modelText: rawText })
      if (!record.modelAt && mm.renderer.renderTree.data.text === rawText) record.modelAt = clock()
      if (source === 'node_tree_render_end' && !record.renderEndAt) record.renderEndAt = clock()
      const element = root.group && root.group.node
      if (!element || !element.isConnected || !element.textContent.includes(text)) return
      if (!record.domAt) record.domAt = clock()
      if (!record.frameAt && !record.framePending) {
        record.framePending = true
        requestAnimationFrame(() => {
          record.framePending = false
          if (root.getData('text') !== rawText || !element.isConnected || !element.textContent.includes(text)) return
          const rect = element.getBoundingClientRect()
          record.viewport = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
            width: rect.width, height: rect.height,
            intersects: rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight }
          if (record.viewport.intersects) record.frameAt = clock()
        })
      }
    }
    const data = () => inspect('data_change')
    const end = () => inspect('node_tree_render_end')
    mm.on('data_change', data)
    mm.on('node_tree_render_end', end)
    const mutation = new MutationObserver(() => inspect('mutation'))
    mutation.observe(document.querySelector('#mindMapContainer'), { childList: true, subtree: true, characterData: true, attributes: true })
    __onlineObservation = { records, command(text) {
      const startedAt = clock()
      const payload = '<p>' + text + '</p>'
      mm.execCommand('SET_NODE_TEXT', mm.renderer.root, payload)
      inspect('local_command')
      const c = mm.cooperate
      return { text, payload, startedAt, returnedAt: clock(), rootText: mm.renderer.root.getData('text'),
        readonly: mm.opt.readonly, compactLayout: mm.opt.compactLayout,
        cooperate: { isSetData: c.isSetData, isApplyingRemote: c.isApplyingRemote, previewApplied: c.previewApplied,
          hydratingCurrentData: c.hydratingCurrentData, httpHydrating: c.httpHydrating, httpReplacing: c.httpReplacing,
          httpSettlingAfterReplace: c.httpSettlingAfterReplace, suppressLocalUntil: c.suppressLocalUntil,
          ackedRoot: c.isPersistAcked('root'), lastPushed: c.lastPushed.root, pendingTextUids: c._pendingTextUids && Array.from(c._pendingTextUids) } }
    }, cleanup() { mm.off('data_change', data); mm.off('node_tree_render_end', end); mutation.disconnect() } }
    inspect('installed')
  })
}

async function resourceSnapshot(client) {
  const session = await client.page.context().newCDPSession(client.page)
  await session.send('Performance.enable')
  const [{ metrics }, dom, app] = await Promise.all([
    session.send('Performance.getMetrics'), session.send('Memory.getDOMCounters'), client.page.evaluate(() => {
      const mm = __onlineMM
      const r = mm && mm.renderer
      let models = r ? 0 : null
      if (r) { const stack = [r.renderTree]; while (stack.length) { const item = stack.pop(); if (item) { models++; stack.push(...(item.children || [])) } } }
      return { models, nodeCache: r && Object.keys(r.nodeCache || {}).length,
        nodeIndex: r && r.nodeIndex ? r.nodeIndex.size : null,
        lastPushed: mm && mm.cooperate ? Object.keys(mm.cooperate.lastPushed || {}).length : null,
        ackedUids: mm && mm.cooperate && mm.cooperate.ackedUids ? mm.cooperate.ackedUids.size : null,
        viewportNodes: r && r._visibleViewportNodes ? r._visibleViewportNodes.size : null,
        viewportLines: r && r._visibleViewportEdges ? r._visibleViewportEdges.size : null,
        viewportIndex: r && r._viewportIndex && r._viewportIndex.leaves ? r._viewportIndex.leaves.size : null,
        connectedDom: document.querySelectorAll('*').length,
        connectedMindMapNodes: document.querySelectorAll('#mindMapContainer .smm-node').length,
        listeners: mm && mm.event && mm.event.eventNames ? mm.event.eventNames().reduce((sum, name) => sum + mm.event.listenerCount(name), 0) : null,
        appBusListeners: (() => { const app = document.querySelector('#app'); const bus = app && app.__vue__ && app.__vue__.$bus; return bus && bus._events
          ? Object.values(bus._events).reduce((sum, listeners) => sum + (Array.isArray(listeners) ? listeners.length : listeners ? 1 : 0), 0) : null })(),
        appBusListenerEvents: (() => {
          const app = document.querySelector('#app'), bus = app && app.__vue__ && app.__vue__.$bus
          if (!bus || !bus._events) return null
          if (!window.__onlineBusHandlerIds) { window.__onlineBusHandlerIds = new WeakMap(); window.__onlineBusHandlerSequence = 0 }
          return Object.entries(bus._events).map(([event, handlers]) => ({ event,
            handlers: (Array.isArray(handlers) ? handlers : handlers ? [handlers] : []).map(handler => {
              if (!__onlineBusHandlerIds.has(handler)) __onlineBusHandlerIds.set(handler, ++__onlineBusHandlerSequence)
              return { id: __onlineBusHandlerIds.get(handler), name: handler.name || '' }
            }) })).filter(item => item.handlers.length)
        })(),
        longTasks: __onlineLongTasks.slice(), status: mm && mm.cooperate && mm.cooperate.collabV2Adapter.getStatus() }
    })
  ])
  await session.detach()
  const byName = Object.fromEntries(metrics.map(item => [item.name, item.value]))
  return { at: Date.now(), heapUsed: byName.JSHeapUsedSize, heapTotal: byName.JSHeapTotalSize,
    dom, app }
}

function assertWireSample(frames, text, clients) {
  const sent = frames.find(frame => frame.direction === 'sent' && frame.event === 'op' && JSON.stringify(frame.body.payload).includes(text))
  assert.ok(sent, 'Native socket sent the text operation')
  const opId = sent.body.opId
  const ack = frames.find(frame => frame.client === sent.client && frame.direction === 'received' && frame.kind === 'ack' && frame.body.opId === opId)
  assert.ok(ack && ack.body.ok, 'Native socket ACK confirms commit')
  const events = frames.filter(frame => frame.direction === 'received' && frame.event === 'op:event' && frame.body.opId === opId)
  const seen = new Set(events.map(frame => frame.client))
  assert.ok(Array.from({ length: clients }, (_, i) => i).filter(i => i !== sent.client).every(i => seen.has(i)), 'All remote contexts received real op:event')
  return { opId, sentAt: sent.at, ackAt: ack.at, events: events.map(({ client, at }) => ({ client, at })), revision: ack.body.serverRevision }
}

module.exports = { packet, observeWire, installStartupObserver, installEditorObserver, resourceSnapshot, assertWireSample }
