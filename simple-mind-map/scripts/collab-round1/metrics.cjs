const percentile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null
}
function summarize(rows) {
  const successes = rows.filter(row => row.ok && Number.isFinite(row.elapsedMs))
  const values = successes.map(row => row.elapsedMs)
  return {
    samples: rows.length, successfulSamples: values.length,
    failures: rows.length - values.length,
    failureRate: rows.length ? (rows.length - values.length) / rows.length : null,
    p50Ms: percentile(values, .50), p95Ms: percentile(values, .95),
    p99Ms: percentile(values, .99), maxMs: values.length ? values.reduce((a,b) => Math.max(a,b), -Infinity) : null,
    maxAttemptMs: rows.some(x => Number.isFinite(x.elapsedMs)) ? rows.map(x => x.elapsedMs).filter(Number.isFinite).reduce((a,b) => Math.max(a,b), -Infinity) : null,
    censoredSamples: rows.filter(x => x.censored).length,
    maxCensoredLowerBoundMs: rows.some(x => Number.isFinite(x.elapsedLowerBoundMs)) ? Math.max(...rows.map(x => x.elapsedLowerBoundMs).filter(Number.isFinite)) : null
  }
}
function correlate(commits, events, expected, cutoffMs = null) {
  const samples = [], issues = [], groups = new Map()
  for (const event of events) {
    if (!event.opId) continue
    const key = `${event.client}:${event.opId}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(event)
  }
  for (const { client, opId } of expected) {
    const commit = commits.get(opId)
    const group = groups.get(`${client}:${opId}`) || []
    const received = group.filter(x => x.kind === 'event_received')
    const applied = group.filter(x => x.kind === 'event_applied' && x.disposition === 'remote' && !x.callbackReturnedFalse)
    for (const [metric, event] of [['commitReceive', received[0]], ['commitApplied', applied[0]]]) {
      const elapsedMs = commit && event ? event.atMs - commit.atMs : null
      const identityMatches = !!(commit && event) &&
        (!commit.roomKey || event.roomKey === commit.roomKey) &&
        (!Number.isFinite(commit.revision) || event.revision === commit.revision)
      samples.push({ metric, client, opId, ok: identityMatches && Number.isFinite(elapsedMs) && elapsedMs >= 0, elapsedMs,
        censored: !event, elapsedLowerBoundMs: commit && !event && Number.isFinite(cutoffMs) ? cutoffMs - commit.atMs : null })
      if (commit && event && !identityMatches) issues.push({ client, opId, reason: 'room_or_revision_mismatch', metric })
    }
    if (!commit) issues.push({ client, opId, reason: 'missing_commit' })
    if (!applied.length) issues.push({ client, opId, reason: 'not_applied_as_operation' })
    if (received.length && !applied.length) issues.push({ client, opId, reason: 'received_not_applied' })
    if (applied.length > 1) issues.push({ client, opId, reason: 'duplicate_application' })
    if (group.some(x => x.callbackReturnedFalse)) issues.push({ client, opId, reason: 'callback_returned_false' })
    if (received.length > 1) issues.push({ client, opId, reason: 'duplicate_receive', count: received.length })
  }
  return { samples, issues }
}
module.exports = { percentile, summarize, correlate }
