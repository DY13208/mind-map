'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { parseResponseBody, runWorker, transportErrorDetails } = require('./mcp-collab-load-worker.cjs');

assert.deepEqual(transportErrorDetails({ name: 'TypeError', message: 'fetch failed', cause: {
  name: 'SocketError', code: 'UND_ERR_SOCKET', syscall: 'read',
  headers: { authorization: 'must-not-be-retained' }, url: 'must-not-be-retained'
} }), { name: 'TypeError', code: null, causeName: 'SocketError', causeCode: 'UND_ERR_SOCKET', syscall: 'read',
  bytesRead: null, bytesWritten: null, localPort: null, remotePort: null, timeout: null, remoteFamily: null });
assert.equal(transportErrorDetails({ cause: { code: 'token=secret value' } }).causeCode, null);

const workerFile = path.join(__dirname, 'mcp-collab-load-worker.cjs');
const secret = 'selftest-secret-do-not-log';
const sessionId = 'mcp-selftest-session';

const serverWorkerSource = String.raw`
  const { parentPort } = require('node:worker_threads');
  const http = require('node:http');
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    parentPort.postMessage({
      type: 'received',
      at: Date.now(),
      authorization: req.headers.authorization,
      sessionId: req.headers['mcp-session-id'],
      operationHeader: req.headers['x-mcp-request-id'],
      requestId: body.id,
    });
    const failed = body.id === 'selftest-2';
    res.writeHead(failed ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(failed
      ? { jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'synthetic unavailable' } }
      : { jsonrpc: '2.0', id: body.id, result: { accepted: true } }));
  });
  server.listen(0, '127.0.0.1', () => {
    parentPort.postMessage({ type: 'ready', port: server.address().port });
  });
  parentPort.on('message', (message) => {
    if (message === 'close') server.close(() => parentPort.postMessage({ type: 'closed' }));
  });
`;

function nextMessage(worker, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for worker message after ${timeoutMs}ms`));
    }, timeoutMs);
    const onMessage = (message) => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('error', onError);
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
  });
}

async function run() {
  const sse = parseResponseBody('data: {"jsonrpc":"2.0","result":{"ok":true}}\n\n', 'text/event-stream');
  assert.deepEqual(sse, { jsonrpc: '2.0', result: { ok: true } }, 'SSE data should decode to the JSON-RPC object');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-load-worker-selftest-'));
  const outputPath = path.join(tempDir, 'results.jsonl');
  const server = new Worker(serverWorkerSource, { eval: true });
  let loadWorker;
  try {
    const ready = await nextMessage(server, (message) => message.type === 'ready');
    const startAt = Date.now() + 250;
    const jobs = Array.from({ length: 5 }, (_, index) => ({
      plannedAt: startAt + index * 200,
      request: { jsonrpc: '2.0', id: `selftest-${index}`, method: 'tools/call', params: { name: 'test' } },
      meta: { source: 'mcp', phase: 'selftest', operationId: `00000000-0000-4000-8000-00000000000${index}` },
    }));

    const serverMessages = [];
    server.on('message', (message) => serverMessages.push(message));
    const workerMessages = [];
    loadWorker = new Worker(workerFile, {
      workerData: {
        url: `http://127.0.0.1:${ready.port}/mcp`,
        token: secret,
        sessionId,
        phase: 'selftest',
        startAt,
        jobs,
        outputPath,
      },
    });
    loadWorker.on('message', (message) => workerMessages.push(message));

    // Keep the parent event loop unavailable while the worker and test server run.
    // Requests that arrive during this interval prove dispatch does not depend on it.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);

    const completed = await nextMessage(loadWorker, (message) => message.type === 'done', 5000);
    assert.equal(completed.count, 5, 'worker should settle every scheduled request');
    const receivedDeadline = Date.now() + 2000;
    while (serverMessages.filter((message) => message.type === 'received').length < 5 && Date.now() < receivedDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const received = serverMessages.filter((message) => message.type === 'received').sort((a, b) => a.at - b.at);
    assert.equal(received.length, 5, 'fake server should receive all five requests during the parent stall');
    assert(received.every((message) => message.authorization === `Bearer ${secret}`), 'worker should send bearer authorization');
    assert(received.every((message) => message.sessionId === sessionId), 'worker should send the MCP session header');
    for (const message of received) {
      const index = Number(message.requestId.slice('selftest-'.length));
      assert.equal(message.operationHeader, `00000000-0000-4000-8000-00000000000${index}`, 'valid operation ID should be reused only as the request correlation header');
    }
    const rows = fs.readFileSync(outputPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(rows.length, 5, 'JSONL must retain one result per request');
    assert(rows.every((row) => row.type === 'result'), 'all outcomes should be persisted as result records');
    const persistedDispatchGaps = assertPersistedDispatchCadence(rows, { expectedCount: 5, intervalMs: 200, maxLatenessMs: 50 });
    // The server worker's `at` is a server-callback timestamp; it is distinct
    // from the client's persisted monotonic dispatch time and can shift with
    // transport/OS/event-loop scheduling. This separate synthetic fixture models
    // a delayed observer batching receipts; it does not explain any real arrival gap.
    const observerBatchAt = Date.now();
    const delayedClusterReceipts = received.map((message) => ({ requestId: message.requestId, observedAt: observerBatchAt }));
    assert.equal(new Set(delayedClusterReceipts.map((message) => message.observedAt)).size, 1,
      'the test fixture should model delayed, clustered arrival observation');
    assert.equal(persistedDispatchGaps.length, 4, 'dispatch cadence must come from persisted worker monotonic timestamps');
    assert.equal(rows.filter((row) => row.outcome === 'success').length, 4);
    assert.equal(rows.filter((row) => row.outcome === 'unknown').length, 1, 'HTTP 503 should remain a possible-commit outcome');
    assert(rows.filter((row) => row.outcome === 'success').every((row) => row.httpOk === true && row.status === 200));
    assert(rows.filter((row) => row.outcome === 'success').every((row) => row.response?.result?.isError === false), 'response classification metadata should be retained');
    assert(rows.filter((row) => row.outcome === 'success').every((row) => !('content' in (row.response?.result || {}))), 'raw content text must not be retained');
    const failedRow = rows.find((row) => row.operationId === '00000000-0000-4000-8000-000000000002');
    assert.equal(failedRow.httpOk, false);
    assert.equal(failedRow.status, 503);
    assert.equal(failedRow.response?.error?.code, -32000, 'safe error code should be retained without its message');
    assert(rows.every((row) => row.operationId && row.phase === 'selftest'), 'job metadata should be retained');
    assert(!fs.readFileSync(outputPath, 'utf8').includes(secret), 'bearer token must never be written to JSONL');
    assert.equal(workerMessages.filter((message) => message.type === 'dispatch').length, 5);
    assert.equal(workerMessages.filter((message) => message.type === 'result').length, 5);
    const runtime = workerMessages.find(message => message.type === 'runtime-monitor');
    assert(runtime && runtime.phase === 'selftest', 'worker runtime metrics must include the workload phase');
    assert(Number.isInteger(runtime.metrics.eventLoopDelay.sampleCount), 'worker event-loop metrics must define sampleCount');
    assert.equal(runtime.syncJsonlWrite.count, 5, 'synchronous JSONL write timing should aggregate without per-row records');
    assert.equal(runtime.syncJsonlWrite.sampleCount, 5);
    assert(Number.isFinite(runtime.syncJsonlWrite.p95Ms) && Number.isFinite(runtime.syncJsonlWrite.maxMs));

    await testMissedSlots(tempDir);
    await testAbsoluteMonotonicSlots(tempDir);
    await testMonotonicLatencyUnderWallJumps(tempDir);
    await testTransportStages(tempDir);
    await testResponsePrivacy(tempDir);

    console.log('PASS: MCP load worker JSON/SSE parsing, fixed 5/s slots, missed-slot accounting, privacy-safe result projection, sync-write timing, request correlation, transport diagnostics, and parent-event-loop independence.');
  } finally {
    if (loadWorker) await loadWorker.terminate();
    server.postMessage('close');
    await nextMessage(server, (message) => message.type === 'closed', 3000).catch(() => {});
    await server.terminate();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function readRows(file) {
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function assertPersistedDispatchCadence(rows, { expectedCount, intervalMs, maxLatenessMs }) {
  const dispatched = rows.filter((row) => row.writeSubmitted === true).sort((left, right) => left.index - right.index);
  assert.equal(dispatched.length, expectedCount, 'every scheduled request should have a persisted dispatch result');
  for (const row of dispatched) {
    assert(Number.isFinite(row.startedAtMonotonicMs), 'dispatch start must be persisted on the monotonic clock');
    assert(Number.isFinite(row.plannedAtMonotonicMs), 'planned slot must be persisted on the monotonic clock');
    assert(row.startedAtMonotonicMs >= row.plannedAtMonotonicMs, 'a request must not start before its fixed monotonic slot');
    assert(row.dispatchLatenessMs >= 0 && row.dispatchLatenessMs <= maxLatenessMs,
      `submitted request must remain inside the slot deadline (got ${row.dispatchLatenessMs}ms)`);
  }
  const gaps = [];
  for (let index = 1; index < dispatched.length; index += 1) {
    const gap = dispatched[index].startedAtMonotonicMs - dispatched[index - 1].startedAtMonotonicMs;
    const plannedGap = dispatched[index].plannedAtMonotonicMs - dispatched[index - 1].plannedAtMonotonicMs;
    gaps.push(gap);
    assert(plannedGap >= intervalMs, 'successful requests must preserve increasing scheduled slots');
    assert(gap >= plannedGap - maxLatenessMs && gap <= plannedGap + maxLatenessMs + 10,
      `persisted monotonic dispatch gap must match fixed slots (planned gap ${plannedGap}ms, observed ${gap}ms)`);
    assert(Math.abs(dispatched[index].interDispatchIntervalMs - gap) < 10,
      'persisted inter-dispatch interval should agree with monotonic request start times');
  }
  return gaps;
}

function fakeResponse(body = { result: { accepted: true } }, overrides = {}) {
  return {
    status: 200, ok: true,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(body),
    ...overrides,
  };
}

async function testMissedSlots(tempDir) {
  const outputPath = path.join(tempDir, 'missed-slots.jsonl');
  const startAt = Date.now() + 80;
  const interval = 200;
  const jobs = Array.from({ length: 9 }, (_, index) => ({
    plannedAt: startAt + index * interval,
    request: { jsonrpc: '2.0', id: `blocked-${index}`, method: 'tools/call', params: { name: 'test' } },
    meta: { source: 'mcp', operationId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}` },
  }));
  let fetchCount = 0;
  const messages = [];
  const completed = [];
  const runtimeMessages = [];
  await runWorker({ url: 'http://127.0.0.1/unused', token: 'safe-token', phase: 'missed-slot-selftest', startAt,
    windowEndAt: startAt + jobs.length * interval, dispatchIntervalMs: interval, maxDispatchLatenessMs: 50,
    jobs, outputPath }, {
    postMessage: (message) => { messages.push(message); if (message.type === 'done') completed.push(message); if (message.type === 'runtime-monitor') runtimeMessages.push(message); },
    writeSync: (fd, data) => {
      const result = fs.writeSync(fd, data);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      return result;
    },
    fetch: () => {
      fetchCount += 1;
      if (fetchCount === 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 900);
      return Promise.resolve(fakeResponse());
    },
  });
  const rows = readRows(outputPath);
  const dispatched = rows.filter((row) => row.writeSubmitted === true).sort((left, right) => left.startedAt - right.startedAt);
  const missed = rows.filter((row) => row.writeSubmitted === false);
  assert.equal(rows.length, jobs.length, 'all scheduled slots must have a result record');
  assert(missed.length >= 3, `blocking the worker must produce explicit missed slots (got ${missed.length})`);
  assert(dispatched.length < jobs.length, 'late slots must not be caught up as a burst');
  assert(dispatched.every((row) => row.startedAt < startAt + jobs.length * interval), 'no request may start at or beyond the exclusive window end');
  assertPersistedDispatchCadence(rows, { expectedCount: dispatched.length, intervalMs: interval, maxLatenessMs: 50 });
  assert(missed.every((row) => row.latencyMs === null && row.startedAt === null && row.writeSubmitted === false),
    'unsubmitted slots must have null latency/start time and an explicit false writeSubmitted marker');
  assert(missed.some((row) => row.missReason === 'late_dispatch'), 'late slots must expose their reason');
  assert.equal(completed[0].expectedCount, jobs.length);
  assert.equal(completed[0].dispatchedCount, dispatched.length);
  assert.equal(completed[0].missedCount, missed.length);
  assert.equal(messages.filter((message) => message.type === 'dispatch').length, dispatched.length);
  assert.equal(messages.filter((message) => message.type === 'missed').length, missed.length);
  assert.equal(runtimeMessages[0].phase, 'missed-slot-selftest');
  assert.equal(runtimeMessages[0].observedScope, 'dispatch-and-response-drain');
  assert.equal(runtimeMessages[0].metrics.phase, 'missed-slot-selftest');
  assert.equal(runtimeMessages[0].metrics.observedScope, 'dispatch-and-response-drain');
  assert(Number.isInteger(runtimeMessages[0].metrics.eventLoopDelay.sampleCount));
  assert(Number.isInteger(runtimeMessages[0].metrics.timerLateness.sampleCount));
  if (runtimeMessages[0].metrics.eventLoopDelay.sampleCount === 0) {
    assert.equal(runtimeMessages[0].metrics.eventLoopDelay.p95Ms, null);
    assert.equal(runtimeMessages[0].metrics.eventLoopDelay.maxMs, null);
  }
  assert.equal(runtimeMessages[0].syncJsonlWrite.count, rows.length);
  assert(runtimeMessages[0].syncJsonlWrite.maxMs >= 1, 'writeSync timing should include the controlled synchronous delay');
}

async function testAbsoluteMonotonicSlots(tempDir) {
  const outputPath = path.join(tempDir, 'absolute-monotonic-slots.jsonl');
  const wallStart = 2_000_000;
  const startAt = wallStart + 100;
  const interval = 200;
  const count = 10;
  const jobs = Array.from({ length: count }, (_, index) => ({
    plannedAt: startAt + index * interval,
    request: { jsonrpc: '2.0', id: `absolute-${index}`, method: 'tools/call', params: { name: 'test' } },
    meta: { source: 'mcp', operationId: `11000000-0000-4000-8000-${String(index).padStart(12, '0')}` },
  }));
  let mono = 7000;
  let earlyWake = true;
  let sleepCount = 0;
  const dispatches = [];
  const done = [];
  await runWorker({ url: 'http://127.0.0.1/unused', token: 'safe-token', startAt,
    windowEndAt: startAt + count * interval, dispatchIntervalMs: interval, maxDispatchLatenessMs: 50,
    jobs, outputPath }, {
    now: () => wallStart,
    monotonicNow: () => mono,
    sleep: async delay => {
      sleepCount += 1;
      if (earlyWake && delay > 1) mono += delay - 1;
      else mono += delay + 3;
      earlyWake = !earlyWake;
    },
    postMessage: message => { if (message.type === 'dispatch') dispatches.push(message); if (message.type === 'done') done.push(message); },
    fetch: async () => fakeResponse(),
  });
  const rows = readRows(outputPath);
  assert.equal(rows.length, count);
  assert.equal(rows.filter(row => row.writeSubmitted === true).length, count,
    'small repeated timer jitter should not accumulate across absolute slots');
  assert(sleepCount >= count * 2, 'the waiter must re-check after early timer wakes');
  assert(dispatches.every(row => row.dispatchedAtMonotonicMs >= row.plannedAtMonotonicMs),
    'early timer wakeups must never cause early dispatch');
  assert(rows.every(row => Math.abs(row.dispatchLatenessMs - 3) < 0.001),
    'the same small overshoot should remain bounded instead of accumulating');
  assert(rows.slice(1).every((row, index) => Math.abs(row.interDispatchIntervalMs - interval) < 0.001),
    'dispatch starts should remain aligned to the absolute fixed slot grid');
  assert.equal(done[0].dispatchSchedule.mode, 'absolute-monotonic-slots');
  assert.equal(done[0].dispatchSchedule.minObservedInterDispatchMs, interval);
  assert.equal(done[0].dispatchSchedule.interDispatchSampleCount, count - 1);

  const stalledPath = path.join(tempDir, 'absolute-monotonic-stall.jsonl');
  const stalledStart = 3_000_000;
  const stalledJobs = Array.from({ length: 8 }, (_, index) => ({
    plannedAt: stalledStart + index * interval,
    request: { jsonrpc: '2.0', id: `stall-${index}`, method: 'tools/call', params: { name: 'test' } },
    meta: { source: 'mcp', operationId: `12000000-0000-4000-8000-${String(index).padStart(12, '0')}` },
  }));
  mono = 9000;
  let stalled = false;
  const stallDispatches = [];
  const stallDone = [];
  await runWorker({ url: 'http://127.0.0.1/unused', token: 'safe-token', startAt: stalledStart,
    windowEndAt: stalledStart + stalledJobs.length * interval, dispatchIntervalMs: interval, maxDispatchLatenessMs: 50,
    jobs: stalledJobs, outputPath: stalledPath }, {
    now: () => stalledStart,
    monotonicNow: () => mono,
    sleep: async delay => {
      if (!stalled && Math.abs((mono + delay) - (9000 + 2 * interval)) < 0.001) {
        mono += delay + 260;
        stalled = true;
      } else mono += delay;
    },
    postMessage: message => { if (message.type === 'dispatch') stallDispatches.push(message); if (message.type === 'done') stallDone.push(message); },
    fetch: async () => fakeResponse(),
  });
  const stallRows = readRows(stalledPath);
  assert(stallRows.some(row => row.index === 2 && row.writeSubmitted === false && row.missedByMs === 260),
    'a simulated 260ms stall must explicitly miss the affected planned slot');
  assert(stallRows.some(row => row.index === 3 && row.writeSubmitted === false && row.missedByMs === 60),
    'the next slot still outside its deadline must also be missed');
  assert.deepEqual(stallDispatches.map(row => row.index), [0, 1, 4, 5, 6, 7],
    'after a stall, scheduling must resume on the original grid without replaying missed slots');
  assert.equal(stallDone[0].dispatchedCount + stallDone[0].missedCount, stalledJobs.length);
  assert(stallRows.filter(row => !row.writeSubmitted).every(row => row.latencyMs === null && row.dispatchLatenessMs === null),
    'missed slots have no request latency and must not be counted as server outcomes');
}

async function testMonotonicLatencyUnderWallJumps(tempDir) {
  const wallStart = 4_000_000;
  const interval = 200;
  for (const [index, wallJump] of [90000, -180000].entries()) {
    const outputPath = path.join(tempDir, `monotonic-latency-wall-jump-${index}.jsonl`);
    let wall = wallStart;
    let mono = 12000;
    const job = { plannedAt: wallStart,
      request: { jsonrpc: '2.0', id: `wall-jump-${index}`, method: 'tools/call', params: { name: 'test' } },
      meta: { source: 'mcp', operationId: `13000000-0000-4000-8000-${String(index).padStart(12, '0')}` } };
    await runWorker({ url: 'http://127.0.0.1/unused', token: 'safe-token', startAt: wallStart,
      windowEndAt: wallStart + interval, dispatchIntervalMs: interval, jobs: [job], outputPath }, {
      now: () => wall,
      monotonicNow: () => mono,
      sleep: async delay => { mono += delay; },
      fetch: async () => {
        mono += 123;
        wall += wallJump;
        return fakeResponse();
      },
    });
    const row = readRows(outputPath)[0];
    assert.equal(row.latencyMs, 123,
      'request elapsed time must use the monotonic clock despite forward/backward wall-clock jumps');
    assert.equal(row.completedAt - row.startedAt, wallJump,
      'wall timestamps should remain available for correlation even when they jump');
  }

  const fallbackPath = path.join(tempDir, 'monotonic-fallback-wall-jump.jsonl');
  let fallbackWall = wallStart;
  let fallbackMono = 20000;
  const fallbackJob = { plannedAt: wallStart,
    request: { jsonrpc: '2.0', id: 'wall-jump-fallback', method: 'tools/call', params: { name: 'test' } },
    meta: { source: 'mcp', operationId: '13000000-0000-4000-8000-000000000099' } };
  await runWorker({ url: 'http://127.0.0.1/unused', token: 'safe-token', startAt: wallStart,
    windowEndAt: wallStart + interval, dispatchIntervalMs: interval, jobs: [fallbackJob], outputPath: fallbackPath }, {
    now: () => fallbackWall,
    monotonicNow: () => fallbackMono,
    sleep: async delay => { fallbackMono += delay; },
    requestOne: async () => {
      fallbackMono += 77;
      fallbackWall -= 250000;
      throw new Error('private-fallback-error');
    },
  });
  const fallbackRow = readRows(fallbackPath)[0];
  assert.equal(fallbackRow.outcome, 'unknown');
  assert.equal(fallbackRow.latencyMs, 77, 'exception fallback elapsed time must also use monotonic time');
}

async function testTransportStages(tempDir) {
  const outputPath = path.join(tempDir, 'transport-stages.jsonl');
  let clock = Date.now();
  const firstOperationId = '20000000-0000-4000-8000-000000000001';
  const invalidOperationId = 'not-a-uuid';
  const jobs = [firstOperationId, invalidOperationId].map((operationId, index) => ({
    plannedAt: clock + index * 200,
    request: { jsonrpc: '2.0', id: `stage-${index}`, method: 'tools/call', params: { name: 'test' } },
    meta: { source: 'mcp', operationId },
  }));
  const sentHeaders = [];
  let monotonic = 0;
  const maliciousText = 'Bearer top-secret https://private.example/path 203.0.113.8 authorization header body stack';
  await runWorker({ url: 'http://127.0.0.1/unused', token: 'worker-token', startAt: clock,
    windowEndAt: clock + 500, dispatchIntervalMs: 200, jobs, outputPath }, {
    now: () => clock,
    monotonicNow: () => monotonic,
    sleep: async delay => { monotonic += delay; },
    fetch: async (_url, options) => {
      sentHeaders.push(options.headers);
      if (sentHeaders.length === 1) {
        const error = new TypeError(maliciousText);
        error.cause = { name: 'SocketError', code: 'UND_ERR_SOCKET', syscall: 'read', remoteFamily: 'IPv4',
          socket: { bytesRead: 17, bytesWritten: 23, localPort: 43210, remotePort: 8989, timeout: 60000,
            remoteAddress: '203.0.113.8', localAddress: '192.0.2.15' } };
        throw error;
      }
      return fakeResponse(null, { text: async () => { throw new Error(maliciousText); } });
    },
  });
  const rows = readRows(outputPath);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].failureStage, 'fetch');
  assert.equal(rows[0].error, 'fetch_rejected');
  assert.equal(rows[0].outcome, 'unknown');
  assert.equal(rows[0].transportError.bytesRead, 17);
  assert.equal(rows[0].transportError.bytesWritten, 23);
  assert.equal(rows[0].transportError.remotePort, 8989);
  assert.equal(rows[0].transportError.remoteFamily, 'IPv4');
  assert.deepEqual(Object.keys(rows[0].transportError).sort(),
    ['bytesRead', 'bytesWritten', 'causeCode', 'causeName', 'code', 'localPort', 'name', 'remoteFamily', 'remotePort', 'syscall', 'timeout'].sort(),
    'transport errors must contain only allowlisted fields');
  assert.equal(rows[1].failureStage, 'response_body');
  assert.equal(rows[1].error, 'response_body_read_failed');
  assert.equal(rows[1].status, 200, 'a body read failure must retain the received HTTP status');
  assert.equal(rows[1].outcome, 'unknown');
  assert.equal(sentHeaders[0]['x-mcp-request-id'], firstOperationId, 'valid operation_id should be preferred');
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sentHeaders[1]['x-mcp-request-id']),
    'invalid operation IDs should use a fresh legal request UUID');
  assert(!fs.readFileSync(outputPath, 'utf8').includes(maliciousText), 'raw error messages, URLs, IPs, headers, body, and stack must not be persisted');
  assert(!fs.readFileSync(outputPath, 'utf8').includes('203.0.113.8'), 'socket IP addresses must not be persisted');
}

async function testResponsePrivacy(tempDir) {
  const outputPath = path.join(tempDir, 'response-privacy.jsonl');
  const bodyCanary = 'response-body-private-canary';
  const contentCanary = 'content-text-private-canary';
  const messageCanary = 'embedded-message-private-canary';
  const startAt = Date.now() + 200;
  const jobs = [0, 1].map(index => {
    const operationId = `60000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    return { plannedAt: startAt + index * 200,
      request: { jsonrpc: '2.0', id: operationId, method: 'tools/call', params: { name: 'test' } },
      meta: { source: 'mcp', phase: 'privacy-selftest', operationId, uid: 'safe-uid', token: 'must-not-be-logged', payload: bodyCanary } };
  });
  await runWorker({ url: 'http://127.0.0.1/unused', token: 'safe-token', phase: 'privacy-selftest', startAt,
    windowEndAt: startAt + 1000, dispatchIntervalMs: 200, jobs, outputPath }, {
    fetch: async (_url, options) => {
      const request = JSON.parse(options.body);
      if (request.id === jobs[0].request.id) return fakeResponse({ result: { isError: true, content: [{ type: 'text', text: JSON.stringify({
        uid: 'safe-node-uid', submissionPath: 'direct', fallbackReason: 'collab_v2_disabled', text: contentCanary,
        message: messageCanary, payload: bodyCanary,
      }) }] } });
      return fakeResponse({ error: { code: -32000, message: messageCanary, data: bodyCanary } });
    },
  });
  const rows = readRows(outputPath);
  assert.equal(rows.length, 2);
  assert(rows.every(row => row.outcome === 'rejected'), 'privacy projection must not change rejection classification');
  assert.equal(rows[0].response.result.structuredContent.uid, 'safe-node-uid');
  assert.equal(rows[0].response.result.structuredContent.submissionPath, 'direct');
  assert.equal(rows[0].response.result.structuredContent.fallbackReason, 'collab_v2_disabled');
  assert.equal(rows[1].response.error.code, -32000);
  const persisted = fs.readFileSync(outputPath, 'utf8');
  for (const canary of [bodyCanary, contentCanary, messageCanary, 'must-not-be-logged']) {
    assert(!persisted.includes(canary), `raw MCP response or operation metadata leaked: ${canary}`);
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
