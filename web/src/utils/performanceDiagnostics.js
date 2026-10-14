import { getRuntimeConfig } from './runtimeConfig'
import { subscribeCollabPerformance } from 'simple-mind-map/src/utils/collabTrace'

// Opt in for this page only: &perfDiagnostics=1. No content/URLs/identities
// are uploaded. All observers and subscriptions are removed on editor exit.
export function startPerformanceDiagnostics(mindMap, roomKey, bus) {
  if (!roomKey || new URLSearchParams(window.location.search).get('perfDiagnostics') !== '1') return () => {}
  const sessionId = 'pd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  const endpoint = `${getRuntimeConfig().collabApi}/api/diagnostics/performance`
  let queue = []
  let stopped = false
  let sending = false
  let renderAt = null
  let renderId = null
  let dropped = 0
  const pending = new Map()
  const observers = []
  const started = performance.now()
  const add = row => { if (!stopped) { queue.push(row); if (queue.length > 99) { queue.shift(); dropped += 1 } } }
  const onStart = info => { renderAt = performance.now(); renderId = info && info.renderId }
  const onEnd = info => {
    if (!info || info.renderId !== renderId) return
    if (renderAt !== null) add({ kind: 'render', durationMs: performance.now() - renderAt, count: Number(info && info.renderedNodes) || 0 })
    renderAt = null
    renderId = null
  }
  const onCancel = () => { renderAt = null; renderId = null; add({ kind: 'cancel-render', count: 1 }) }
  const onReady = () => add({ kind: 'canvas-ready', durationMs: performance.now() - started })
  mindMap.on('render_started', onStart)
  mindMap.on('render_complete', onEnd)
  mindMap.on('render_cancelled', onCancel)
  bus.$on('room_canvas_ready', onReady)
  const unsubscribe = subscribeCollabPerformance((stage, detail) => {
    if (detail.roomKey && detail.roomKey !== roomKey) return
    if (stage === '2.adapter.submit') {
      if (pending.size >= 500) pending.delete(pending.keys().next().value)
      if (detail.traceId) pending.set(detail.traceId, performance.now())
      add({ kind: 'local', type: detail.type, count: 1 })
    } else if (stage === '8.ack' || stage === '8.ack.fail') {
      const at = pending.get(detail.traceId)
      add({ kind: stage === '8.ack' ? 'ack' : 'ack-failed', type: detail.type,
        ...(at == null ? {} : { durationMs: performance.now() - at }), count: 1 })
      pending.delete(detail.traceId)
    } else if (stage === '10.remote.recv') add({ kind: 'remote', type: detail.type, count: 1 })
    else if (stage === 'api.queue') add({ kind: 'api-queue', route: detail.route, durationMs: detail.durationMs })
  })
  const observe = (type, consume) => {
    try {
      const observer = new PerformanceObserver(list => list.getEntries().forEach(consume))
      observer.observe({ type, buffered: false })
      observers.push(observer)
    } catch (_) { /* browser may not support Long Tasks */ }
  }
  observe('longtask', entry => add({ kind: 'longtask', durationMs: entry.duration }))
  observe('resource', entry => {
    const url = new URL(entry.name, window.location.href)
    const match = url.pathname.match(/^\/api\/files\/([^/]+)(?:\/(preview|subtree|locate|nodes|info|operations|version|export))?/)
    if (match && match[1] === roomKey) add({ kind: 'resource', route: '/api/files/:room/' + (match[2] || (url.searchParams.get('format') === 'meta' ? 'meta' : 'snapshot')), durationMs: entry.duration })
  })
  const flush = async () => {
    if (stopped || sending) return
    try {
      const state = typeof window.__COLLAB_V2_STATUS__ === 'function' ? window.__COLLAB_V2_STATUS__() : null
      if (state && state.roomKey === roomKey) {
        for (const field of ['outboxPending', 'outboxSending', 'reconnectCount', 'gapRecoveredOps', 'snapshotRecoveryCount']) {
          if (Number.isFinite(Number(state[field]))) add({ kind: 'client-state', type: field, count: Number(state[field]) })
        }
      }
    } catch (_) { /* status provider is best effort */ }
    if (!queue.length) return
    const events = queue.concat({ kind: 'client-state', type: 'sampleDrops', count: dropped }); queue = []; sending = true
    try {
      const response = await fetch(endpoint, { method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomKey, sessionId, events }) })
      // Stop instead of continuously hitting unavailable or unauthorized APIs.
      if ([401, 403, 404].includes(response.status)) cleanup()
      else if (response.status >= 400) dropped += events.length
    } catch (_) { dropped += events.length /* no retries compete with editing */ }
    finally { sending = false }
  }
  const timer = setInterval(flush, 10000)
  function cleanup() {
    if (stopped) return
    stopped = true; clearInterval(timer); observers.forEach(o => o.disconnect()); unsubscribe()
    mindMap.off('render_started', onStart); mindMap.off('render_complete', onEnd)
    mindMap.off('render_cancelled', onCancel); bus.$off('room_canvas_ready', onReady)
    pending.clear(); queue = []
  }
  return cleanup
}
