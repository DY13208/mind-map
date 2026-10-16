'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const harnessPath = path.join(__dirname, 'mcp-collab-performance.cjs');

function extractFunction(source, functionName) {
  const signature = new RegExp(`function\\s+${functionName}\\s*\\(`);
  const match = signature.exec(source);
  assert(match, `function ${functionName} was not found in ${harnessPath}`);
  const start = match.index;
  const bodyMarker = source.indexOf(') {', match.index + match[0].length);
  const open = bodyMarker < 0 ? -1 : bodyMarker + 2;
  assert(open >= 0, `function ${functionName} has no body`);

  let depth = 1;
  let state = 'code';
  for (let index = open + 1; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === 'single' || state === 'double' || state === 'template') {
      const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`';
      if (char === '\\') index += 1;
      else if (char === quote) state = 'code';
      continue;
    }
    if (state === 'line-comment') {
      if (char === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') { state = 'code'; index += 1; }
      continue;
    }
    if (char === '/' && next === '/') { state = 'line-comment'; index += 1; continue; }
    if (char === '/' && next === '*') { state = 'block-comment'; index += 1; continue; }
    if (char === "'") { state = 'single'; continue; }
    if (char === '"') { state = 'double'; continue; }
    if (char === '`') { state = 'template'; continue; }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`function ${functionName} has an unterminated body`);
}

function makeRendered({ token, uid, writer, epochMs }) {
  return { token, uid, writer, epochMs, source: 'browser', issuedAt: epochMs - 1000, phase: 'round-1', renderComplete: true, version: 3 };
}

function makeClient(label, { rendered = [], ack = [], submit = [] } = {}) {
  return { label, trace: { input: [], ack, submit, rendered, renderCompleteEvents: rendered.length }, httpSamples: [] };
}

function metric(values) {
  return { count: values.length, values: values.slice() };
}

function createSummarizer(samples, browserClients = 3) {
  const source = fs.readFileSync(harnessPath, 'utf8');
  const functionSource = extractFunction(source, 'summarizeBrowserTrace');
  const context = {
    BROWSER_CLIENTS: browserClients,
    samplesPath: 'stubbed-samples.jsonl',
    readJsonl: () => samples,
    metric,
    summarizeTraceCaptureTelemetry: () => ({ stubbed: true }),
    summarizeHttpSamples: () => ({ stubbed: true }),
  };
  vm.createContext(context);
  vm.runInContext(`${functionSource}\nthis.__summarize = summarizeBrowserTrace;`, context, { filename: harnessPath });
  return context.__summarize;
}

function assertNoEpochLatency(summary, label) {
  for (const field of ['remoteStableRenderUpperBound', 'remoteStableRenderLowerBound', 'mcpServerCommitMarkerToStableRender']) {
    const values = summary[field].values;
    assert(!values.some((value) => value > 10_000_000), `${label}: ${field} must not contain epoch-sized latency: ${JSON.stringify(values)}`);
  }
}

function testMissingAnchors() {
  const epoch = 1_800_000_000_000;
  const samples = [
    { category: 'browser-input-schedule', source: 'browser', writer: 'writer-1', token: 'token-no-created-at', uid: 'node-no-created-at', plannedAt: epoch - 1000 },
    { category: 'browser-input-schedule', source: 'browser', writer: 'writer-1', token: 'token-no-ack', uid: 'node-no-ack', plannedAt: epoch - 1000 },
    { category: 'browser-input-schedule', source: 'browser', writer: 'writer-1', token: 'token-null-ack-epoch', uid: 'node-null-ack-epoch', plannedAt: epoch - 900 },
    { category: 'mcp-single-write', source: 'mcp', token: 'token-no-marker', operationId: 'op-no-marker', uid: 'node-no-marker', completedAt: null, outcome: 'success' },
  ];
  const clients = [
    makeClient('writer-1', {
      submit: [
        { token: 'token-no-created-at', operationId: 'op-no-created-at', phase: 'round-1' },
        { token: 'token-no-ack', operationId: 'op-no-ack', phase: 'round-1' },
        { token: 'token-null-ack-epoch', operationId: 'op-null-ack-epoch', phase: 'round-1' },
      ],
      ack: [{ token: 'token-null-ack-epoch', phase: 'round-1', status: 'acked', operationId: 'op-null-ack-epoch', ackOperationId: 'op-null-ack-epoch', ackEpochMs: null }],
    }),
    makeClient('peer-1', {
      rendered: [
        makeRendered({ token: 'token-no-created-at', uid: 'node-no-created-at', writer: 'writer-1', epochMs: epoch + 1000 }),
        makeRendered({ token: 'token-no-ack', uid: 'node-no-ack', writer: 'writer-1', epochMs: epoch + 1100 }),
        makeRendered({ token: 'token-null-ack-epoch', uid: 'node-null-ack-epoch', writer: 'writer-1', epochMs: epoch + 1150 }),
        makeRendered({ token: 'token-no-marker', uid: 'node-no-marker', writer: 'mcp', epochMs: epoch + 1200 }),
      ],
    }),
  ];
  const operations = [
    { operation_id: 'op-no-created-at' },
    { operation_id: 'op-no-ack', created_at: new Date(epoch - 500).toISOString() },
    { operation_id: 'op-null-ack-epoch', created_at: new Date(epoch - 400).toISOString() },
    { operation_id: 'op-no-marker', created_at: new Date(epoch - 700).toISOString() },
  ];
  const summarize = createSummarizer(samples);
  const summary = summarize({ clients }, { operations }, { status: 'available', commitMarkers: [] });

  const noCreatedAt = summary.writeTimingAnchors.find((row) => row.token === 'token-no-created-at');
  assert.equal(noCreatedAt.transactionStartAtMs, null, 'missing created_at must stay null');
  assert.equal(noCreatedAt.ackOrToolResponseAtMs, null, 'missing browser ACK must stay null');
  const noAck = summary.writeTimingAnchors.find((row) => row.token === 'token-no-ack');
  assert.equal(noAck.transactionStartAtMs, epoch - 500, 'a valid created_at remains available without ACK');
  assert.equal(noAck.ackOrToolResponseAtMs, null, 'missing ACK must not become Unix epoch zero');
  const nullAckEpoch = summary.writeTimingAnchors.find((row) => row.token === 'token-null-ack-epoch');
  assert.equal(nullAckEpoch.ackOrToolResponseAtMs, null, 'an ACK with null ackEpochMs must not become Unix epoch zero');
  const noMarker = summary.writeTimingAnchors.find((row) => row.token === 'token-no-marker');
  assert.equal(noMarker.apiCommitMarkerAtMs, null, 'missing MCP marker must stay null');
  assert.equal(summary.commitTimingEvidence.mcpCommitMarkerMissingCount, 1, 'missing MCP commit marker must be counted');
  assert(summary.commitTimingEvidence.missingOperationAnchorCount >= 1, 'successful write without a transaction timestamp must be counted as missing an anchor');
  assertNoEpochLatency(summary, 'missing anchors');
  assert.equal(summary.renderOutcomes.uidMismatch, 0, 'no UID mismatch must be explicit zero so the successful-render gate can pass');
}

function testValidAnchorsAndRenderCorrelation() {
  const createdAtMs = 1_800_000_000_000;
  const ackAtMs = createdAtMs + 900;
  const stableAtMs = createdAtMs + 1700;
  const samples = [
    { category: 'browser-input-schedule', source: 'browser', writer: 'writer-1', token: 'token-good', uid: 'node-good', plannedAt: createdAtMs - 100 },
    { category: 'browser-input-schedule', source: 'browser', writer: 'writer-1', token: 'token-bad-uid', uid: 'node-expected', plannedAt: createdAtMs - 50 },
  ];
  const clients = [
    makeClient('writer-1', {
      submit: [
        { token: 'token-good', operationId: 'op-good', phase: 'round-1' },
        { token: 'token-bad-uid', operationId: 'op-bad-uid', phase: 'round-1' },
      ],
      ack: [{ token: 'token-good', phase: 'round-1', status: 'acked', operationId: 'op-good', ackOperationId: 'op-good', ackEpochMs: ackAtMs, ackMs: 12 }],
      rendered: [makeRendered({ token: 'token-good', uid: 'node-good', writer: 'writer-1', epochMs: stableAtMs + 5000 })],
    }),
    makeClient('peer-1', {
      rendered: [
        makeRendered({ token: 'token-good', uid: 'node-good', writer: 'writer-1', epochMs: stableAtMs }),
        makeRendered({ token: 'token-bad-uid', uid: 'node-wrong', writer: 'writer-1', epochMs: stableAtMs + 100 }),
      ],
    }),
    makeClient('peer-2'),
  ];
  const operations = [
    { operation_id: 'op-good', created_at: new Date(createdAtMs).toISOString() },
    { operation_id: 'op-bad-uid', created_at: new Date(createdAtMs).toISOString() },
  ];
  const summarize = createSummarizer(samples);
  const summary = summarize({ clients }, { operations }, { status: 'available', commitMarkers: [] });

  assert.deepEqual(Array.from(summary.remoteStableRenderUpperBound.values), [stableAtMs - createdAtMs], 'valid created_at should produce the stable-render upper bound');
  assert.deepEqual(Array.from(summary.remoteStableRenderLowerBound.values), [stableAtMs - ackAtMs], 'matching ACK should produce the stable-render lower bound');
  assert.deepEqual(Array.from(summary.mcpServerCommitMarkerToStableRender.values), [], 'no MCP marker should produce no marker-to-render latency');
  assert.equal(summary.renderOutcomes.stable, 1, 'only the matching peer UID should count as stable');
  assert.equal(summary.renderOutcomes.uidMismatch, 1, 'a rendered event with a different UID must be rejected');
  assert.equal(summary.renderOutcomes.missing, 3, 'same-writer and mismatched-UID rows must not satisfy remote receiver counts');
  assert.equal(summary.commitTimingEvidence.successfulWriteCount, 2);
}

testMissingAnchors();
testValidAnchorsAndRenderCorrelation();
console.log('PASS: timing summary preserves null anchors, counts missing commit evidence, computes valid bounds, excludes the same writer, and rejects UID mismatches.');
