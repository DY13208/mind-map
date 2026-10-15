const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const repo = path.resolve(__dirname, '../..')
const { onlineOutputDirectory } = require('./online-output-directory.cjs')

function distribution(values) {
  assert.ok(values.length > 0 && values.every(Number.isFinite))
  const sorted = [...values].sort((a, b) => a - b)
  const percentile = p => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]
  return { count: sorted.length, min: sorted[0], p50: percentile(0.5), p95: percentile(0.95), max: sorted[sorted.length - 1] }
}

function summarize(phase, instances) {
  const directory = onlineOutputDirectory(phase, instances + '-instance')
  const result = JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8'))
  const samples = JSON.parse(fs.readFileSync(path.join(directory, 'samples.json'), 'utf8'))
  assert.equal(result.status, 'MEASURED')
  assert.equal(result.sampleCount, 200)
  assert.equal(samples.length, 200)
  assert.equal(result.contexts, 13)
  const commonTiming = Object.fromEntries(['commandMs', 'ackMs', 'remoteModelMs', 'remoteDomMs', 'remoteViewportFrameMs']
    .map(metric => [metric, distribution(samples.map(sample => sample.durations[metric]))]))
  const perRemote = Array.from({ length: 12 }, (_, index) => {
    const client = index + 1
    return { client, count: 200, modelMs: distribution(samples.map(sample => sample.records[client].modelAt - sample.command.startedAt)),
      domMs: distribution(samples.map(sample => sample.records[client].domAt - sample.command.startedAt)),
      viewportFrameMs: distribution(samples.map(sample => sample.records[client].frameAt - sample.command.startedAt)),
      nativeEventHostDelayMs: distribution(samples.map(sample => sample.wire.events.find(event => event.client === client).at - sample.command.startedAt)),
      presentRenderEndSamples: samples.filter(sample => Number.isFinite(sample.records[client].renderEndAt)).length }
  })
  const resourceCurves = Array.from({ length: 13 }, (_, client) => result.resources.filter(resource => resource.client === client).map(resource => {
    const tasks = resource.app.longTasks || []
    return { client, stage: resource.stage, at: resource.at, heapUsedBytes: resource.heapUsed, heapTotalBytes: resource.heapTotal,
      cdpDom: resource.dom, models: resource.app.models, nodeCache: resource.app.nodeCache,
      viewportNodes: resource.app.viewportNodes ?? null, viewportLines: resource.app.viewportLines ?? null,
      viewportIndex: resource.app.viewportIndex ?? null, appListeners: resource.app.listeners ?? null,
      appBusListeners: resource.app.appBusListeners ?? null, nativeHistory: resource.app.nativeHistory ?? null,
      lastPushed: resource.app.lastPushed ?? null, ackedUids: resource.app.ackedUids ?? null,
      longTasksObserved: tasks.length, longestObservedTaskMs: tasks.length ? Math.max(...tasks.map(task => task.duration)) : null }
  }))
  const summary = { phase, instances, actualCommands: 200, actualContexts: 13, nodeModelsPerContext: 6001,
    layout: result.layout, compactLayout: result.compactLayout, commonTiming, perRemote, resourceCurves,
    bundles: result.bundleHashes, identities: result.identities,
    boundary: {
      clock: 'The common ACK and protocol event times are Playwright-host observation times. Model/DOM/RAF records use browser performance.timeOrigin + performance.now. Cross-clock protocol-event-to-model causality is not inferred; fresh AFTER native browser-clock observations, if present, are a separate metric.',
      resources: 'CDP DOM counts include retained and detached nodes. Long tasks are actual cumulative PerformanceObserver records. Missing cache/listener/history fields remain null; no earlier observations are backfilled.',
      peerCount: instances === 1 ? 'Each process-local native presence list has13 real contexts' : 'Existing native presence is process-local:7/6; all13 contexts are live and every command still reaches12 actual remote models/DOM/frames',
      startup: 'Actual full App contexts loaded sequentially with ordinary logicalStructure and compactLayout=false; safe-load and later complete PG-tree mount are separately recorded, not simultaneous cold startup',
      samples: 'All200 commands retained, including native retries and slow samples. Observational peer records are not counted as extra commands.'
    }
  }
  fs.writeFileSync(path.join(directory, 'observed-summary.json'), JSON.stringify(summary, null, 2))
  return { phase, instances, commonTiming, perRemoteCount: perRemote.length, resourceSamplesPerClient: resourceCurves.map(curve => curve.length) }
}
if (require.main === module) console.log(JSON.stringify(summarize(process.argv[2] || 'before', Number(process.argv[3] || 1))))
module.exports = { distribution, summarize }
