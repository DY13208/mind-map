const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const repo = path.resolve(__dirname, '../..')
const { onlineOutputDirectory } = require('./online-output-directory.cjs')
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
}
function validate(phase, instances) {
  const directory = onlineOutputDirectory(phase, instances + '-instance')
  const result = JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8'))
  const samples = JSON.parse(fs.readFileSync(path.join(directory, 'samples.json'), 'utf8'))
  const frames = JSON.parse(fs.readFileSync(path.join(directory, 'native-frames.json'), 'utf8'))
  assert.equal(result.contexts, 13)
  assert.equal(samples.length, 200)
  assert.equal(result.persisted.count, 6001)
  assert.equal(result.persisted.root_text, '<p>Update-0200</p>')
  assert.equal(Number(result.persisted.revision), 200)
  assert.equal(result.persisted.operations.length, 200, 'No hidden normalization/remote echo operations')
  const operationIds = samples.map(item => item.wire.opId)
  assert.equal(new Set(operationIds).size, 200)
  assert.deepEqual(new Set(result.persisted.operations.map(item => item.operation_id)), new Set(operationIds))
  const payloadDigests = result.persisted.operations.map(item => crypto.createHash('sha256').update(JSON.stringify(canonical(item.payload))).digest('hex'))
  assert.equal(new Set(payloadDigests).size, 200, 'Every real PG payload corresponds to a distinct text command')
  const rows = new Map(result.persisted.operations.map(item => [item.operation_id, item]))
  const protocol = new Map(operationIds.map(opId => [opId, { sends: 0, successfulAcks: 0, events: new Array(13).fill(0) }]))
  for (const frame of frames) {
    const observed = protocol.get(frame.body && frame.body.opId)
    if (!observed) continue
    if (frame.direction === 'sent' && frame.event === 'op') observed.sends++
    if (frame.client === 0 && frame.direction === 'received' && frame.kind === 'ack' && frame.body.ok) observed.successfulAcks++
    if (frame.direction === 'received' && frame.event === 'op:event') observed.events[frame.client]++
  }
  const perCommand = samples.map(sample => {
    const row = rows.get(sample.wire.opId)
    assert.equal(Number(row.version), sample.iteration)
    assert.equal(Number(sample.wire.revision), sample.iteration)
    assert.ok(JSON.stringify(row.payload).includes(sample.text))
    const observed = protocol.get(sample.wire.opId)
    const events = observed.events.map((count, client) => ({ client, count }))
    assert.ok(observed.sends >= 1 && observed.successfulAcks >= 1)
    assert.ok(events.slice(1).every(item => item.count >= 1))
    assert.equal(sample.records.length, 13)
    assert.ok(sample.records.every(item => item.modelAt && item.domAt && item.frameAt && item.viewport.intersects))
    if (phase === 'after') {
      assert.deepEqual(sample.command.cooperate.pendingTextUids, ['root'], 'Recorded candidate work is the actual fixed root command')
      assert.equal(sample.command.rootText, sample.command.payload, 'The source command read the actual existing current root')
      assert.ok(sample.records.every(item => item.modelText === sample.command.payload), 'Every actual current rendered root matches the committed command')
    }
    return { iteration: sample.iteration, opId: sample.wire.opId, revision: row.version, nativeSends: observed.sends,
      nativeSuccessfulAcks: observed.successfulAcks, nativeEventsPerClient: events }
  })
  const finalResources = result.resources.filter(item => item.stage === 'after-operations')
  assert.equal(finalResources.length, 13)
  for (const item of finalResources) {
    assert.equal(item.app.models, 6001)
    const status = item.app.status
    assert.equal(status.phase, 'LIVE')
    assert.equal(status.socketConnected, true)
    assert.equal(status.pendingCount, 0)
    assert.equal(status.outboxPending, 0)
    assert.equal(status.outboxSending, 0)
    assert.equal(Number(status.lastServerRevision), 200)
    assert.equal(status.peers.length, instances === 1 ? 13 : item.client % 2 === 0 ? 7 : 6)
  }
  const validated = { phase, instances, actualCommands: 200, actualContexts: 13, pgHead: 200, pgOperations: 200,
    uniqueOperationIds: 200, uniqueObservedPayloadSha256: 200,
    digestBoundary: 'SHA256 of observed canonical real PG payloads; native Socket operations do not store the MCP request-principal digest. This is an observation digest, not a claim of a native idempotence authentication contract.',
    all13FinalLiveEmptyOutboxPending: true, rawDuplicates: perCommand.filter(item => item.nativeSends !== 1 || item.nativeSuccessfulAcks !== 1 || item.nativeEventsPerClient.slice(1).some(event => event.count !== 1)),
    perCommand, payloadDigests, source: 'Original recorded real PG state, real raw protocol frames and end resource snapshots; no missing earlier helper fields backfilled' }
  if (phase === 'after') validated.recordedCandidateAudit = {
    candidateVariants: [...new Set(samples.map(item => JSON.stringify(item.command.cooperate.pendingTextUids)))],
    sourceCurrentRootObservedCommands: 200, all13RenderedRootObservedCommands: 200,
    perCommandUidLookup: null,
    boundary: 'The existing recorded command and root model/DOM observations prove this fixed-root scenario. No missing per-command UID-lookup field is backfilled, and missing-model/method branches are not claimed covered.'
  }
  fs.writeFileSync(path.join(directory, 'validated-recording.json'), JSON.stringify(validated, null, 2))
  return { phase, instances, actualCommands: 200, pgHead: 200, uniqueOperationIds: 200, duplicateCommandFrames: validated.rawDuplicates.length }
}
function complete(phase, instances) {
  const checked = validate(phase, instances)
  const directory = onlineOutputDirectory(phase, instances + '-instance')
  const output = path.join(directory, 'completion-manifest.json')
  if (fs.existsSync(output)) return { ...checked, completionManifest: 'Existing original supplemental manifest preserved' }
  const result = JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8'))
  const validation = JSON.parse(fs.readFileSync(path.join(directory, 'validated-recording.json'), 'utf8'))
  const checkpoint = JSON.parse(fs.readFileSync(path.join(directory, 'checkpoint.json'), 'utf8'))
  const resources = result.resources.filter(item => item.stage === 'after-operations')
  fs.writeFileSync(output, JSON.stringify({ observedAfterRecordingAt: Date.now(),
    completionSource: 'Post-processing the original final real PG control result and all13 real browser end resource snapshots, recorded before fixture cleanup. No new PG query after room deletion.',
    maxRecordedEndResourceAt: Math.max(...resources.map(item => item.at)), commands: 200,
    pgHead: Number(result.persisted.revision), pgOperations: result.persisted.operations.length,
    uniqueOperationIds: validation.uniqueOperationIds, uniqueObservedPayloadDigest: validation.uniqueObservedPayloadSha256,
    digestBoundary: validation.digestBoundary, all13FinalLiveEmptyOutboxPending: validation.all13FinalLiveEmptyOutboxPending,
    finalState: resources.map(item => ({ client: item.client, at: item.at, actualModels: item.app.models, status: item.app.status })),
    retryCommands: validation.rawDuplicates, oldCheckpointStatusPreserved: checkpoint.status,
    unobservedEarlierFieldsRemainUnobserved: true }, null, 2))
  return { ...checked, completionManifest: output }
}
if (require.main === module) console.log(JSON.stringify(complete(process.argv[2] || 'before', Number(process.argv[3] || 1))))
module.exports = { validate, complete }
