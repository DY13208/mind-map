'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createRuntimeMonitor } = require('./mcp-collab-runtime-monitor.cjs');
const { isMainThread, parentPort, workerData } = require('node:worker_threads');

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const DEFAULT_DISPATCH_INTERVAL_MS = 200;
const MAX_DISPATCH_LATENESS_MS = 50;
const MAX_WRITE_TIMING_SAMPLES = 4096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESPONSE_METADATA_KEYS = new Set([
  'uid', 'nodeUid', 'node_uid', 'nodeId', 'node_id', 'submissionPath', 'fallbackReason',
  'operationId', 'operation_id', 'version', 'revision', 'committed', 'success', 'ok',
  'status', 'errorCode', 'error_code', 'code', 'isError',
]);

function transportErrorDetails(error) {
  const code = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : null;
  const finiteNumber = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const socket = error && error.cause && error.cause.socket || error && error.socket || null;
  const remoteFamilyValue = socket && socket.remoteFamily || error && error.cause && error.cause.remoteFamily;
  const remoteFamily = ['IPv4', 'IPv6', 'Unix'].includes(remoteFamilyValue) ? remoteFamilyValue : null;
  return {
    name: code(error && error.name),
    code: code(error && error.code),
    causeName: code(error && error.cause && error.cause.name),
    causeCode: code(error && error.cause && error.cause.code),
    syscall: code(error && error.cause && error.cause.syscall),
    bytesRead: finiteNumber(socket && socket.bytesRead),
    bytesWritten: finiteNumber(socket && socket.bytesWritten),
    localPort: finiteNumber(socket && socket.localPort),
    remotePort: finiteNumber(socket && socket.remotePort),
    timeout: finiteNumber(socket && socket.timeout),
    remoteFamily,
  };
}

function redact(value, secret) {
  if (!secret || value == null) return value;
  if (typeof value === 'string') return value.split(secret).join('[redacted]');
  if (Array.isArray(value)) return value.map((item) => redact(item, secret));
  if (typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = redact(item, secret);
    return result;
  }
  return value;
}

function parseJsonValue(text) {
  try {
    return { parsed: true, value: JSON.parse(text) };
  } catch {
    return { parsed: false };
  }
}

function parseSse(text) {
  const events = [];
  let dataLines = [];
  const flush = () => {
    if (!dataLines.length) return;
    const data = dataLines.join('\n');
    const parsed = parseJsonValue(data);
    events.push(parsed.parsed ? parsed.value : { rawData: data });
    dataLines = [];
  };

  for (const line of text.split(/\r?\n/)) {
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    if (field !== 'data') continue;
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    dataLines.push(value);
  }
  flush();
  return events;
}

function parseResponseBody(text, contentType = '') {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;

  const json = parseJsonValue(trimmed);
  if (json.parsed) return json.value;

  if (/text\/event-stream/i.test(contentType) || /^data:/m.test(trimmed)) {
    const events = parseSse(trimmed);
    return events.length === 1 ? events[0] : events;
  }

  return { rawText: trimmed };
}

function safeResponseMetadata(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return {};
  const projected = {};
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);
  for (const [key, item] of entries) {
    if (['content', 'text', 'message', 'payload', 'params', 'error', 'rawText'].includes(key)) continue;
    if (RESPONSE_METADATA_KEYS.has(key)) {
      if (typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) projected[key] = item;
      else if (typeof item === 'string' && item.length <= 160 && /^[A-Za-z0-9_.:/-]+$/.test(item)) projected[key] = item;
    } else if (item && typeof item === 'object') {
      Object.assign(projected, safeResponseMetadata(item, depth + 1));
    }
  }
  return projected;
}

function safeJobMetadata(meta = {}) {
  const projected = {};
  for (const key of ['category', 'phase', 'source', 'tool']) {
    const value = meta[key];
    if (typeof value === 'string' && value.length <= 100 && /^[A-Za-z0-9_.:/-]+$/.test(value)) projected[key] = value;
  }
  if (typeof meta.operationId === 'string' && UUID_PATTERN.test(meta.operationId)) projected.operationId = meta.operationId;
  if (typeof meta.uid === 'string' && meta.uid.length <= 160 && /^[A-Za-z0-9_.:/-]+$/.test(meta.uid)) projected.uid = meta.uid;
  return projected;
}

function projectResponseForLog(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return null;
  const result = response.result && typeof response.result === 'object' ? response.result : null;
  const metadata = [];
  if (result && Array.isArray(result.content)) {
    for (const item of result.content) {
      if (!item || item.type !== 'text' || typeof item.text !== 'string') continue;
      const parsed = parseJsonValue(item.text);
      if (parsed.parsed) {
        const projected = safeResponseMetadata(parsed.value);
        if (Object.keys(projected).length) metadata.push(projected);
      }
    }
  }
  if (result && result.structuredContent) {
    const projected = safeResponseMetadata(result.structuredContent);
    if (Object.keys(projected).length) metadata.push(projected);
  }
  if (result) {
    const projected = safeResponseMetadata(result);
    if (Object.keys(projected).length) metadata.push(projected);
  }
  const projected = {};
  if (Number.isSafeInteger(response.id) || (typeof response.id === 'string' && UUID_PATTERN.test(response.id))) projected.id = response.id;
  if (response.error && typeof response.error === 'object') {
    const errorCode = response.error.code;
    projected.error = { code: typeof errorCode === 'number' && Number.isFinite(errorCode)
      ? errorCode : typeof errorCode === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(errorCode) ? errorCode : null };
  }
  if (result) projected.result = { isError: result.isError === true, structuredContent: Object.assign({}, ...metadata) };
  return projected;
}

function createWriteTiming() {
  let count = 0;
  const samples = [];
  return {
    record(durationMs) {
      count += 1;
      if (samples.length < MAX_WRITE_TIMING_SAMPLES && Number.isFinite(durationMs)) samples.push(Math.max(0, durationMs));
    },
    snapshot() {
      const sorted = samples.slice().sort((left, right) => left - right);
      const percentile = ratio => sorted.length ? Number(sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)].toFixed(3)) : null;
      return {
        definition: 'Duration around one synchronous fs.writeSync of a worker JSONL result row; not server persistence time.',
        count,
        sampleCount: sorted.length,
        sampleCountCapped: count > sorted.length,
        p50Ms: percentile(0.50),
        p95Ms: percentile(0.95),
        maxMs: sorted.length ? Number(sorted[sorted.length - 1].toFixed(3)) : null,
      };
    },
  };
}

function getOperationId(job) {
  if (job && job.meta && job.meta.operationId != null) return String(job.meta.operationId);
  const args = job && job.request && job.request.params && job.request.params.arguments;
  return args && args.operation_id != null ? String(args.operation_id) : null;
}

function getRequestId(job) {
  const operationId = getOperationId(job);
  return operationId && UUID_PATTERN.test(operationId) ? operationId : randomUUID();
}

function classifyOutcome(httpOk, status, response, transportError) {
  if (transportError) return 'unknown';
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'unknown';
  if (httpOk === false) return 'rejected';
  if (response && typeof response === 'object') {
    const values = Array.isArray(response) ? response : [response];
    if (values.some((item) => item && (item.error || item.result?.isError === true))) return 'rejected';
  }
  return 'success';
}

async function waitUntilMonotonic(target, monotonicNow = () => performance.now(), sleep = delay => new Promise(resolve => setTimeout(resolve, delay))) {
  let observed = monotonicNow();
  while (observed < target) {
    const delay = Math.min(target - observed, MAX_TIMER_DELAY_MS);
    await sleep(delay);
    // Timers may wake early. Always re-check the monotonic clock before dispatch.
    observed = monotonicNow();
  }
  return observed;
}

function positiveIntervalFromJobs(jobs) {
  for (let index = 1; index < jobs.length; index += 1) {
    const interval = Number(jobs[index].plannedAt) - Number(jobs[index - 1].plannedAt);
    if (Number.isFinite(interval) && interval > 0) return interval;
  }
  return DEFAULT_DISPATCH_INTERVAL_MS;
}

function validateWorkerData(data) {
  if (!data || typeof data.url !== 'string' || !data.url) throw new Error('workerData.url is required');
  if (typeof data.token !== 'string' || !data.token) throw new Error('workerData.token is required');
  if (!Array.isArray(data.jobs)) throw new Error('workerData.jobs must be an array');
  if (typeof data.outputPath !== 'string' || !data.outputPath) throw new Error('workerData.outputPath is required');
  for (let i = 0; i < data.jobs.length; i += 1) {
    const job = data.jobs[i];
    if (!job || !job.request || typeof job.request !== 'object') throw new Error(`jobs[${i}].request must be an object`);
    if (!Number.isFinite(Number(job.plannedAt))) throw new Error(`jobs[${i}].plannedAt must be an epoch timestamp`);
  }
  if (data.dispatchIntervalMs !== undefined && (!Number.isFinite(Number(data.dispatchIntervalMs)) || Number(data.dispatchIntervalMs) <= 0)) {
    throw new Error('workerData.dispatchIntervalMs must be a positive number');
  }
  if (data.windowEndAt !== undefined && !Number.isFinite(Number(data.windowEndAt))) {
    throw new Error('workerData.windowEndAt must be an epoch timestamp');
  }
}

function postMessage(runtime, message) {
  if (typeof runtime.postMessage === 'function') runtime.postMessage(message);
  else if (parentPort) parentPort.postMessage(message);
}

function writeWorkerRow(outputFd, row, runtime = {}) {
  const started = performance.now();
  (runtime.writeSync || fs.writeSync)(outputFd, `${JSON.stringify(row)}\n`);
  if (runtime.writeTiming) runtime.writeTiming.record(performance.now() - started);
}

async function requestOne(data, job, index, outputFd, runtime = {}, requestId = getRequestId(job)) {
  const now = runtime.now || Date.now;
  const monotonicNow = runtime.monotonicNow || (() => performance.now());
  const fetchImpl = runtime.fetch || globalThis.fetch;
  const startedAt = now();
  const startedAtMonotonic = monotonicNow();
  const operationId = getOperationId(job);
  let httpOk = null;
  let status = null;
  let response;
  let failureStage = null;
  let error = null;
  let transportDetails = null;
  let responseReadError = null;

  postMessage(runtime, {
    type: 'dispatch',
    index,
    operationId,
    requestId,
    plannedAt: Number(job.plannedAt),
    dispatchedAt: startedAt,
    startLatenessMs: Number.isFinite(runtime.dispatchLatenessMs) ? runtime.dispatchLatenessMs : null,
    dispatchStatus: 'dispatched',
  });

  let res = null;
  try {
    const headers = {
      authorization: `Bearer ${data.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'x-mcp-request-id': requestId,
    };
    if (data.sessionId) headers['mcp-session-id'] = String(data.sessionId);

    res = await fetchImpl(data.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(job.request),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    status = res.status;
    httpOk = res.ok;
  } catch (cause) {
    failureStage = 'fetch';
    error = 'fetch_rejected';
    transportDetails = transportErrorDetails(cause);
  }

  if (res && failureStage === null) {
    try {
      const bodyText = await res.text();
      response = parseResponseBody(bodyText, res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-type') || '' : '');
    } catch (cause) {
      failureStage = 'response_body';
      error = 'response_body_read_failed';
      responseReadError = transportErrorDetails(cause);
    }
  }

  const completedAt = now();
  const completedAtMonotonic = monotonicNow();
  const row = redact({
    type: 'result',
    ...safeJobMetadata(job.meta),
    index,
    operationId,
    requestId,
    plannedAt: Number(job.plannedAt),
    startedAt,
    completedAt,
    plannedAtMonotonicMs: Number.isFinite(runtime.plannedMonotonicAt) ? runtime.plannedMonotonicAt : null,
    startedAtMonotonicMs: startedAtMonotonic,
    completedAtMonotonicMs: completedAtMonotonic,
    interDispatchIntervalMs: Number.isFinite(runtime.interDispatchIntervalMs) ? runtime.interDispatchIntervalMs : null,
    latencyMs: Math.max(0, completedAtMonotonic - startedAtMonotonic),
    writeSubmitted: true,
    status,
    httpOk,
    response: projectResponseForLog(response),
    outcome: failureStage ? 'unknown' : classifyOutcome(httpOk, status, response, false),
    dispatchStatus: 'dispatched',
    dispatchLatenessMs: Number.isFinite(runtime.dispatchLatenessMs) ? runtime.dispatchLatenessMs : null,
    driverDispatchDelayMs: Number.isFinite(runtime.dispatchLatenessMs) ? runtime.dispatchLatenessMs : null,
    failureStage,
    error,
    transportError: transportDetails,
    responseReadError,
  }, data.token);

  writeWorkerRow(outputFd, row, runtime);
  postMessage(runtime, { type: 'result', index, operationId, requestId, completedAt, outcome: row.outcome, dispatchStatus: 'dispatched' });
  return row;
}

function missedRow(data, job, index, requestId, missedAt, reason, targetAt, missedByMs) {
  const operationId = getOperationId(job);
  return redact({
    type: 'result',
    ...safeJobMetadata(job.meta),
    index,
    operationId,
    requestId,
    plannedAt: Number(job.plannedAt),
    startedAt: null,
    completedAt: missedAt,
    latencyMs: null,
    writeSubmitted: false,
    status: null,
    httpOk: null,
    response: null,
    outcome: 'missed',
    dispatchStatus: 'missed',
    dispatchLatenessMs: null,
    driverDispatchDelayMs: null,
    missReason: reason,
    missTargetAt: targetAt,
    missedByMs: Number.isFinite(missedByMs) ? Math.max(0, missedByMs) : null,
    failureStage: null,
    error: 'scheduled_request_not_dispatched',
    transportError: null,
    responseReadError: null,
  }, data.token);
}

async function runWorker(data = workerData, runtime = {}) {
  validateWorkerData(data);
  const now = runtime.now || Date.now;
  const monotonicNow = runtime.monotonicNow || (() => performance.now());
  const sleep = runtime.sleep || (delay => new Promise(resolve => setTimeout(resolve, delay)));
  const fetchImpl = runtime.fetch || globalThis.fetch;
  const dispatchRequest = runtime.requestOne || requestOne;
  const intervalMs = Number(data.dispatchIntervalMs) || positiveIntervalFromJobs(data.jobs);
  const maxLatenessMs = Number.isFinite(Number(data.maxDispatchLatenessMs))
    ? Number(data.maxDispatchLatenessMs) : MAX_DISPATCH_LATENESS_MS;
  const defaultStart = Number.isFinite(Number(data.startAt)) ? Number(data.startAt) : now();
  const wallAnchor = now();
  const monotonicAnchor = monotonicNow();
  const epochToMonotonic = timestamp => monotonicAnchor + (timestamp - wallAnchor);
  const lastPlannedAt = data.jobs.reduce((latest, job) => Math.max(latest, Number(job.plannedAt)), defaultStart);
  const windowEndAt = Number.isFinite(Number(data.windowEndAt)) ? Number(data.windowEndAt) : lastPlannedAt + intervalMs;
  const windowEndMonotonic = epochToMonotonic(windowEndAt);
  const outputPath = path.resolve(data.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const outputFd = fs.openSync(outputPath, 'a');
  const phase = typeof data.phase === 'string' && /^[A-Za-z0-9_.:/-]{1,100}$/.test(data.phase) ? data.phase : 'unspecified';
  let runtimeMonitor;
  const writeTiming = createWriteTiming();
  try {
    runtimeMonitor = createRuntimeMonitor('mcp-load-worker');
  } catch (error) {
    fs.closeSync(outputFd);
    throw error;
  }
  let count = 0;
  let dispatchedCount = 0;
  let missedCount = 0;
  let lateDispatchCount = 0;
  let lastDispatchMonotonicAt = null;
  let minObservedInterDispatchMs = null;
  let interDispatchSampleCount = 0;
  let runtimeMetrics = null;

  try {
    const pending = new Set();
    for (let i = 0; i < data.jobs.length; i += 1) {
      const job = data.jobs[i];
      const plannedAt = Number.isFinite(Number(job.plannedAt)) ? Number(job.plannedAt) : defaultStart + i * 200;
      const scheduledJob = { ...job, plannedAt };
      const requestId = getRequestId(scheduledJob);
      const plannedMonotonicAt = epochToMonotonic(plannedAt);
      const missBeforeDispatch = (reason, observedAt = now(), observedMonotonicAt = monotonicNow()) => {
        const row = missedRow(data, scheduledJob, i, requestId, observedAt, reason, plannedAt,
          observedMonotonicAt - plannedMonotonicAt);
        writeWorkerRow(outputFd, row, { ...runtime, writeTiming });
        missedCount += 1;
        count += 1;
        postMessage(runtime, { type: 'missed', index: i, operationId: row.operationId, requestId, plannedAt,
          missedAt: observedAt, missedByMs: row.missedByMs, missReason: reason, dispatchStatus: 'missed',
          scheduleMode: 'absolute-monotonic-slots' });
        postMessage(runtime, { type: 'result', index: i, operationId: row.operationId, requestId,
          completedAt: observedAt, outcome: 'missed', dispatchStatus: 'missed' });
      };

      if (plannedMonotonicAt >= windowEndMonotonic) {
        missBeforeDispatch('window_elapsed', now(), monotonicNow());
        continue;
      }

      await waitUntilMonotonic(plannedMonotonicAt, monotonicNow, sleep);
      const dispatchMonotonicAt = monotonicNow();
      const dispatchAt = now();
      const latenessMs = dispatchMonotonicAt - plannedMonotonicAt;
      if (dispatchMonotonicAt >= windowEndMonotonic) {
        missBeforeDispatch('window_elapsed', dispatchAt, dispatchMonotonicAt);
        continue;
      }
      if (latenessMs > maxLatenessMs) {
        missBeforeDispatch('late_dispatch', dispatchAt, dispatchMonotonicAt);
        continue;
      }

      const interDispatchIntervalMs = lastDispatchMonotonicAt === null ? null : dispatchMonotonicAt - lastDispatchMonotonicAt;
      if (Number.isFinite(interDispatchIntervalMs) && interDispatchIntervalMs >= 0) {
        minObservedInterDispatchMs = minObservedInterDispatchMs === null
          ? interDispatchIntervalMs : Math.min(minObservedInterDispatchMs, interDispatchIntervalMs);
        interDispatchSampleCount += 1;
      }

      const task = dispatchRequest(data, scheduledJob, i, outputFd, {
        ...runtime,
        now,
        monotonicNow,
        dispatchLatenessMs: latenessMs,
        plannedMonotonicAt: plannedMonotonicAt,
        dispatchMonotonicAt: dispatchMonotonicAt,
        interDispatchIntervalMs,
        fetch: fetchImpl,
        writeTiming,
        postMessage: (message) => postMessage(runtime, message.type === 'dispatch' ? { ...message,
          startLatenessMs: latenessMs, dispatchLatenessMs: latenessMs,
          plannedAtMonotonicMs: plannedMonotonicAt, dispatchedAtMonotonicMs: dispatchMonotonicAt,
          interDispatchIntervalMs } : message),
      }, requestId)
        .catch((error) => {
          const completedAt = now();
          const completedAtMonotonic = monotonicNow();
          const row = redact({
            type: 'result',
            ...safeJobMetadata(job.meta),
            index: i,
            operationId: getOperationId(job),
            requestId,
            plannedAt,
            startedAt: dispatchAt,
            completedAt,
            plannedAtMonotonicMs: plannedMonotonicAt,
            startedAtMonotonicMs: dispatchMonotonicAt,
            completedAtMonotonicMs: completedAtMonotonic,
            interDispatchIntervalMs,
            latencyMs: Math.max(0, completedAtMonotonic - dispatchMonotonicAt),
            writeSubmitted: true,
            status: null,
            httpOk: null,
            response: null,
            outcome: 'unknown',
            dispatchStatus: 'dispatched',
            dispatchLatenessMs: latenessMs,
            driverDispatchDelayMs: latenessMs,
            failureStage: 'worker',
            error: 'worker_request_failed',
            transportError: transportErrorDetails(error),
            responseReadError: null,
          }, data.token);
          writeWorkerRow(outputFd, row, { ...runtime, writeTiming });
          postMessage(runtime, { type: 'result', index: i, operationId: row.operationId, requestId, completedAt, outcome: 'unknown', dispatchStatus: 'dispatched' });
        })
        .finally(() => {
          count += 1;
          pending.delete(task);
        });
      pending.add(task);
      dispatchedCount += 1;
      if (latenessMs > 0) lateDispatchCount += 1;
      lastDispatchMonotonicAt = dispatchMonotonicAt;
    }

    await Promise.allSettled([...pending]);
    const observedScope = 'dispatch-and-response-drain';
    runtimeMetrics = { ...runtimeMonitor.stop(), phase, observedScope };
    postMessage(runtime, { type: 'runtime-monitor', phase, observedScope, metrics: runtimeMetrics, syncJsonlWrite: writeTiming.snapshot() });
    postMessage(runtime, { type: 'done', phase, count, expectedCount: data.jobs.length, dispatchedCount, missedCount, lateDispatchCount,
      dispatchSchedule: { mode: 'absolute-monotonic-slots', intervalMs, maxLatenessMs,
        minimumPossibleGapMs: Math.max(0, intervalMs - maxLatenessMs),
        minObservedInterDispatchMs, interDispatchSampleCount,
        note: 'Fixed planned slots; no catch-up. Actual start gaps may be below the slot interval when one slot uses its lateness allowance.' } });
  } finally {
    fs.closeSync(outputFd);
    if (!runtimeMetrics) {
      const observedScope = 'worker-finalize';
      runtimeMetrics = { ...runtimeMonitor.stop(), phase, observedScope };
      postMessage(runtime, { type: 'runtime-monitor', phase, observedScope, metrics: runtimeMetrics, syncJsonlWrite: writeTiming.snapshot() });
    }
  }
}

if (!isMainThread) {
  runWorker().catch((error) => {
    parentPort.postMessage({ type: 'fatal', error: error && error.message ? error.message : String(error) });
    process.exitCode = 1;
  });
}

module.exports = { classifyOutcome, parseResponseBody, parseSse, projectResponseForLog, safeResponseMetadata, runWorker, validateWorkerData, transportErrorDetails,
  DEFAULT_DISPATCH_INTERVAL_MS, MAX_DISPATCH_LATENESS_MS, waitUntilMonotonic };
