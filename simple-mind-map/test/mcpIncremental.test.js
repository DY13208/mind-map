'use strict'

// Focused phase-4 regression tests. The PostgreSQL/API cases below remain
// explicit TODOs until the baseline and event-bridge gates have passed; this
// file must not be run against a business database or a production gateway.

const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { once } = require('node:events')
const { test } = require('node:test')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function waitFor(predicate, message, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(message)
}

function assertBusyError(error, code) {
  assert.equal(error && error.code, code)
  assert.equal(error && error.statusCode, 503)
  assert.ok(Number(error && error.retryAfterMs) > 0)
}

function queuedBytes(gate) {
  return Number(gate.status().queuedBytes)
}

function runNodeScript(source, env = {}) {
  const result = spawnSync(process.execPath, ['-e', source], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      MIND_MAP_SKIP_ROOT_ENV: '1',
      ...env
    },
    encoding: 'utf8',
    timeout: 10000
  })
  assert.equal(
    result.status,
    0,
    `child process failed (${result.status}):\n${result.stderr}\n${result.stdout}`
  )
  const lines = result.stdout.trim().split(/\r?\n/)
  return JSON.parse(lines[lines.length - 1])
}

test('auth-disabled requests mark only server-verified MCP credentials', () => {
  const output = runNodeScript(
    `
      const auth = require('./bin/auth')
      const { issueMcpUserToken } = require('./bin/mcpUserToken')
      const token = 'mcp-incremental-test-token-only'
      const userToken = issueMcpUserToken('user-7', token)
      async function inspect(authorization, clientId) {
        const req = {
          method: 'POST',
          headers: {
            ...(authorization ? { authorization } : {}),
            ...(clientId ? { 'x-client-id': clientId } : {})
          }
        }
        await auth.requireAuthenticatedRequest(req, {})
        return {
          source: req.verifiedMcpSource || null,
          actorId: (req.authUser && req.authUser.id) || 'anonymous',
          hasAuthUser: !!req.authUser
        }
      }
      ;(async () => {
        const result = {
          service: await inspect('Bearer ' + token, 'ordinary-client'),
          user: await inspect('Bearer ' + userToken, 'ordinary-client'),
          invalid: await inspect('Bearer mmcp_v1.forged.signature', 'mcp-forged'),
          prefixOnly: await inspect('', 'mcp-forged'),
          missingSecret: auth.verifyMcpAuthorization('Bearer ' + token, '')
        }
        process.stdout.write(JSON.stringify(result) + '\\n')
      })().catch(error => {
        console.error(error)
        process.exitCode = 1
      })
    `,
    {
      WECOM_AUTH_ENABLED: '0',
      ONEID_AUTH_ENABLED: '0',
      WORKBUDDY_AUTH_ENABLED: '0',
      MCP_TOKEN: 'mcp-incremental-test-token-only'
    }
  )

  assert.deepEqual(output.service.source, {
    principalId: 'mcp-service',
    kind: 'service'
  })
  assert.deepEqual(output.user.source, { principalId: 'user-7', kind: 'user' })
  assert.equal(output.service.actorId, 'anonymous')
  assert.equal(output.user.actorId, 'anonymous')
  assert.equal(output.service.hasAuthUser, false)
  assert.equal(output.user.hasAuthUser, false)
  assert.equal(output.invalid.source, null)
  assert.equal(output.prefixOnly.source, null)
  assert.equal(output.missingSecret, null)
  for (const entry of [output.service.source, output.user.source]) {
    assert.equal(Object.hasOwn(entry, 'token'), false)
    assert.equal(Object.hasOwn(entry, 'authorization'), false)
  }
})

test('MCP authorization helper rejects invalid and empty-secret credentials', () => {
  const output = runNodeScript(
    `
      const auth = require('./bin/auth')
      const { issueMcpUserToken } = require('./bin/mcpUserToken')
      const secret = 'mcp-incremental-test-token-only'
      const userToken = issueMcpUserToken('user-7', secret)
      async function inspect(authorization) {
        const req = { method: 'POST', headers: { authorization } }
        await auth.requireAuthenticatedRequest(req, {})
        return req.verifiedMcpSource || null
      }
      ;(async () => {
        process.stdout.write(JSON.stringify({
          service: auth.verifyMcpAuthorization('Bearer ' + secret, secret),
          user: auth.verifyMcpAuthorization('Bearer ' + userToken, secret),
          invalid: auth.verifyMcpAuthorization('Bearer mmcp_v1.invalid.signature', secret),
          wrongSecret: auth.verifyMcpAuthorization('Bearer ' + secret, 'different-secret'),
          emptySecret: auth.verifyMcpAuthorization('Bearer ' + secret, ''),
          requestWithMissingConfiguredSecret: await inspect('Bearer ' + secret)
        }) + '\\n')
      })().catch(error => {
        console.error(error)
        process.exitCode = 1
      })
    `,
    {
      WECOM_AUTH_ENABLED: '0',
      ONEID_AUTH_ENABLED: '0',
      WORKBUDDY_AUTH_ENABLED: '0',
      MCP_TOKEN: ''
    }
  )
  assert.deepEqual(output.service, { principalId: 'mcp-service', kind: 'service' })
  assert.deepEqual(output.user, { principalId: 'user-7', kind: 'user' })
  assert.equal(output.invalid, null)
  assert.equal(output.wrongSecret, null)
  assert.equal(output.emptySecret, null)
  assert.equal(output.requestWithMissingConfiguredSecret, null)
})

test('MCP Direct startup validates shared trimmed collab flags', () => {
  const source = `
    try {
      require('./bin/auth')
      process.stdout.write('started')
    } catch (error) {
      process.stdout.write(error.message)
    }
  `
  const result = spawnSync(process.execPath, ['-e', source], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      MIND_MAP_SKIP_ROOT_ENV: '1',
      WECOM_AUTH_ENABLED: '0',
      ONEID_AUTH_ENABLED: '0',
      WORKBUDDY_AUTH_ENABLED: '0',
      COLLAB_MCP_DIRECT: ' 1 ',
      COLLAB_V2: ' false ',
      COLLAB_V2_EVENT_BRIDGE: '1'
    },
    encoding: 'utf8',
    timeout: 10000
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /requires COLLAB_V2 and COLLAB_V2_EVENT_BRIDGE/)
})

test('operation digest ignores retry metadata but covers business identity and fields', () => {
  const { digestMcpOperation } = require('../bin/mcpOperationIdentity')
  const input = {
    roomKey: 'room-digest-test',
    principalId: 'mcp-service',
    type: 'node.insert',
    payload: {
      parentUid: 'root',
      text: '新节点',
      note: '备注',
      __mcpResult: { outcome: 'partial', items: [{ index: 0, status: 'applied' }] },
      operation_id: '550e8400-e29b-41d4-a716-446655440000',
      baseVersion: 4,
      clientSeq: 8
    }
  }
  const digest = digestMcpOperation(input)
  const retried = digestMcpOperation({
    ...input,
    payload: {
      ...input.payload,
      __mcpResult: { outcome: 'all_failed', items: [{ index: 0, status: 'failed' }] },
      operation_id: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
      baseVersion: 19,
      clientSeq: 99
    }
  })
  assert.equal(retried, digest)

  assert.notEqual(
    digestMcpOperation({
      ...input,
      principalId: 'user-7'
    }),
    digest
  )
  assert.notEqual(
    digestMcpOperation({
      ...input,
      roomKey: 'another-room'
    }),
    digest
  )
  assert.notEqual(
    digestMcpOperation({
      ...input,
      payload: { ...input.payload, parentUid: 'branch-1' }
    }),
    digest
  )
  assert.notEqual(
    digestMcpOperation({
      ...input,
      payload: { ...input.payload, text: '不同业务内容' }
    }),
    digest
  )
  assert.notEqual(
    digestMcpOperation({
      ...input,
      payload: { data: { client_id: 'business-A' } }
    }),
    digestMcpOperation({
      ...input,
      payload: { data: { client_id: 'business-B' } }
    }),
    'nested fields with transport-like names remain semantic business input'
  )
  assert.notEqual(
    digestMcpOperation({
      ...input,
      payload: { data: JSON.parse('{"__proto__":"business-A"}') }
    }),
    digestMcpOperation({
      ...input,
      payload: { data: JSON.parse('{"__proto__":"business-B"}') }
    }),
    'prototype-named business keys remain in the digest'
  )

  // A UID used to identify an existing update/delete target is semantic input.
  assert.notEqual(
    digestMcpOperation({
      ...input,
      type: 'node.update',
      payload: { uid: 'node-a', text: '改后' }
    }),
    digestMcpOperation({
      ...input,
      type: 'node.update',
      payload: { uid: 'node-b', text: '改后' }
    })
  )
})

test('private request metadata is removed recursively while ordinary business fields remain', () => {
  const { stripMcpRequestMetadata } = require('../bin/mcpOperationIdentity')
  assert.deepEqual(
    stripMcpRequestMetadata({
      __mcpRequest: { principalId: 'forged', digest: 'fake' },
      requestDigest: 'fake',
      data: {
        text: 'normal',
        client_id: 'business-field',
        nested: { requestDigest: 'fake', value: 1 }
      }
    }),
    {
      data: {
        text: 'normal',
        client_id: 'business-field',
        nested: { value: 1 }
      }
    }
  )
})

test('Direct policy accepts verified custom UID references without UUID assumptions', () => {
  const { isMcpDirectShape } = require('../bin/mcpDirectPolicy')
  const source = { principalId: 'mcp-service', kind: 'service' }
  const knownUids = new Set(['fixture-6001-branch-09'])
  const routedPatch = {
    uid: 'fixture-6001-branch-09',
    patch: { text: 'updated' },
    parentUid: undefined,
    index: undefined
  }
  assert.equal(isMcpDirectShape({ type: 'node.update', payload: routedPatch }, source, knownUids), true)
  assert.equal(isMcpDirectShape({ type: 'node.update', payload: { ...routedPatch, index: 0 } }, source, knownUids), false)
  assert.equal(
    isMcpDirectShape(
      {
        type: 'node.update',
        payload: { uid: 'fixture-6001-branch-09', patch: { text: 'updated' } }
      },
      source,
      knownUids
    ),
    true
  )
  assert.equal(
    isMcpDirectShape(
      {
        type: 'node.update',
        payload: { uid: 'missing-custom-uid', patch: { text: 'updated' } }
      },
      source,
      knownUids
    ),
    false
  )
})

test('duplicate resolution requires the same verified principal and digest', () => {
  const { resolveDuplicate } = require('../bin/mcpOperationIdentity')
  const existing = {
    operation_id: '550e8400-e29b-41d4-a716-446655440000',
    version: 12,
    payload: {
      __mcpRequest: {
        v: 1,
        principalId: 'mcp-service',
        digest: 'sha256:semantic-request'
      }
    }
  }
  const replay = resolveDuplicate({
    existing,
    principalId: 'mcp-service',
    digest: 'sha256:semantic-request'
  })
  assert.equal(replay.duplicate, true)
  assert.equal(replay.existing, existing)

  assert.throws(
    () =>
      resolveDuplicate({
        existing,
        principalId: 'user-7',
        digest: 'sha256:semantic-request'
      }),
    error => error.code === 'OPERATION_ID_CONFLICT' && error.statusCode === 409
  )
  assert.throws(
    () =>
      resolveDuplicate({
        existing,
        principalId: 'mcp-service',
        digest: 'sha256:different-request'
      }),
    error => error.code === 'OPERATION_ID_CONFLICT' && error.statusCode === 409
  )
  assert.throws(
    () =>
      resolveDuplicate({
        existing: {
          ...existing,
          payload: { nodes: { root: { data: { text: 'legacy' } } } }
        },
        principalId: 'mcp-service',
        digest: 'sha256:semantic-request'
      }),
    error =>
      error.code === 'OPERATION_ID_UNVERIFIABLE' && error.statusCode === 409
  )
})

test('MCP submit gate permits one write per room and four across rooms', async () => {
  const { createMcpSubmitGate } = require('../bin/mcpSubmitGate')
  const gate = createMcpSubmitGate({
    maxGlobal: 4,
    maxPerRoom: 1,
    maxQueuedGlobal: 10,
    maxQueuedPerRoom: 10,
    maxWaitMs: 2000
  })

  const roomStarted = deferred()
  const roomRelease = deferred()
  let sameRoomQueuedStarted = false
  let otherRoomStarted = false
  const first = gate.run('room-a', async () => {
    roomStarted.resolve()
    await roomRelease.promise
    return 'first'
  })
  await roomStarted.promise
  const sameRoomQueued = gate.run('room-a', async () => {
    sameRoomQueuedStarted = true
    return 'second'
  })
  const otherRoom = gate.run('room-b', async () => {
    otherRoomStarted = true
    return 'other'
  })
  await otherRoom
  assert.equal(otherRoomStarted, true)
  assert.equal(sameRoomQueuedStarted, false)
  roomRelease.resolve()
  assert.deepEqual(await Promise.all([first, sameRoomQueued]), ['first', 'second'])
  assert.equal(sameRoomQueuedStarted, true)
  assert.deepEqual(gate.status().metrics, {
    submitted: 3,
    started: 3,
    completed: 3,
    failed: 0,
    queued: 1,
    rejected: 0,
    timedOut: 0,
    cancelled: 0,
    queueHighWater: 1,
    queuedBytesHighWater: 0
  })

  const globalGate = createMcpSubmitGate({
    maxGlobal: 4,
    maxPerRoom: 1,
    maxQueuedGlobal: 2,
    maxQueuedPerRoom: 2,
    maxWaitMs: 2000
  })
  const releases = Array.from({ length: 5 }, () => deferred())
  const starts = []
  let active = 0
  let maxActive = 0
  const tasks = Array.from({ length: 4 }, (_, index) =>
    globalGate.run(`room-${index}`, async () => {
      active++
      maxActive = Math.max(maxActive, active)
      starts.push(index)
      await releases[index].promise
      active--
      return index
    })
  )
  await waitFor(() => starts.length === 4, 'expected four concurrent writes to start')
  const fifth = globalGate.run('room-4', async () => {
    active++
    maxActive = Math.max(maxActive, active)
    starts.push(4)
    await releases[4].promise
    active--
    return 4
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(starts.length, 4)
  releases[0].resolve()
  await waitFor(() => starts.length === 5, 'fifth write should start after a global slot frees')
  releases[4].resolve()
  for (let index = 1; index < 4; index++) releases[index].resolve()
  await Promise.all([...tasks, fifth])
  assert.equal(maxActive, 4)
})

test('MCP submit gate bounds queued writes and reports stable busy/timeout errors', async () => {
  const { createMcpSubmitGate } = require('../bin/mcpSubmitGate')
  const gate = createMcpSubmitGate({
    maxGlobal: 1,
    maxPerRoom: 1,
    maxQueuedGlobal: 1,
    maxQueuedPerRoom: 1,
    maxWaitMs: 1000
  })
  const started = deferred()
  const release = deferred()
  const active = gate.run('room-full', async () => {
    started.resolve()
    await release.promise
  })
  await started.promise
  const queued = gate.run('room-full', async () => 'queued')
  await assert.rejects(
    gate.run('room-full', async () => 'overflow'),
    error => {
      assertBusyError(error, 'MCP_WRITE_BUSY')
      return true
    }
  )
  release.resolve()
  await Promise.all([active, queued])
  assert.equal(gate.status().metrics.submitted, 3)
  assert.equal(gate.status().metrics.rejected, 1)
  assert.equal(gate.status().metrics.completed, 2)

  const timeoutGate = createMcpSubmitGate({
    maxGlobal: 1,
    maxPerRoom: 1,
    maxQueuedGlobal: 1,
    maxQueuedPerRoom: 1,
    maxQueuedBytes: 1024,
    maxWaitMs: 25
  })
  const timeoutStarted = deferred()
  const timeoutRelease = deferred()
  const timeoutActive = timeoutGate.run('room-timeout', async () => {
    timeoutStarted.resolve()
    await timeoutRelease.promise
  })
  await timeoutStarted.promise
  const timedOut = timeoutGate.run(
    'room-timeout',
    async () => 'must-not-run',
    { estimatedBytes: 17 }
  )
  assert.equal(queuedBytes(timeoutGate), 17)
  await assert.rejects(
    timedOut,
    error => {
      assertBusyError(error, 'MCP_WRITE_QUEUE_TIMEOUT')
      return true
    }
  )
  assert.equal(queuedBytes(timeoutGate), 0)
  assert.equal(timeoutGate.status().metrics.timedOut, 1)
  assert.equal(timeoutGate.status().metrics.queued, 1)
  timeoutRelease.resolve()
  await timeoutActive
})

test('MCP submit gate bounds queued payload bytes and releases the byte budget', async () => {
  const { createMcpSubmitGate } = require('../bin/mcpSubmitGate')
  const defaultGate = createMcpSubmitGate()
  assert.equal(Number(defaultGate.status().queuedBytesLimit), 64 * 1024 * 1024)

  const gate = createMcpSubmitGate({
    maxGlobal: 1,
    maxPerRoom: 1,
    maxQueuedGlobal: 10,
    maxQueuedPerRoom: 10,
    maxQueuedBytes: 10,
    maxWaitMs: 1000
  })
  const started = deferred()
  const release = deferred()
  const active = gate.run(
    'room-bytes',
    async () => {
      started.resolve()
      await release.promise
    },
    { estimatedBytes: 100 }
  )
  await started.promise
  assert.equal(queuedBytes(gate), 0, 'running work is outside the queued-byte budget')
  assert.equal(Number(gate.status().queuedBytesLimit), 10)

  const queued = gate.run('room-bytes', async () => 'queued', {
    estimatedBytes: 7
  })
  assert.equal(queuedBytes(gate), 7)
  await assert.rejects(
    gate.run('room-bytes', async () => 'over-budget', { estimatedBytes: 4 }),
    error => {
      assertBusyError(error, 'MCP_WRITE_BUSY')
      return true
    }
  )
  assert.equal(queuedBytes(gate), 7, 'rejected request must not remain accounted')

  release.resolve()
  assert.equal(await queued, 'queued')
  await active
  assert.equal(queuedBytes(gate), 0, 'starting work must release its queued-byte charge')
})

test('aborting a queued MCP write removes its waiter without freeing the active slot', async () => {
  const { createMcpSubmitGate } = require('../bin/mcpSubmitGate')
  const gate = createMcpSubmitGate({
    maxGlobal: 1,
    maxPerRoom: 1,
    maxQueuedGlobal: 1,
    maxQueuedPerRoom: 1,
    maxWaitMs: 1000
  })
  const started = deferred()
  const release = deferred()
  const active = gate.run('room-abort', async () => {
    started.resolve()
    await release.promise
    return 'active'
  })
  await started.promise

  const controller = new AbortController()
  const cancelled = gate
    .run(
      'room-abort',
      async () => assert.fail('aborted waiter must not execute'),
      { signal: controller.signal, estimatedBytes: 13 }
    )
    .then(
      () => null,
      error => error
    )
  controller.abort()
  assert.equal(queuedBytes(gate), 0, 'abort must immediately release queued payload bytes')
  let nextRan = false
  const nextStarted = deferred()
  const next = gate.run('room-abort', async () => {
    nextRan = true
    nextStarted.resolve()
    return 'next'
  })

  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(nextRan, false, 'canceling a waiter must not release the running slot')
  release.resolve()
  assert.equal(await active, 'active')
  assert.equal(await next, 'next')
  await nextStarted.promise
  const cancellationError = await cancelled
  assert.ok(
    cancellationError &&
      (cancellationError.name === 'AbortError' ||
        cancellationError.code === 'ABORT_ERR' ||
        cancellationError.code === 'MCP_WRITE_ABORTED')
  )
})

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

async function freePort() {
  const server = http.createServer()
  const port = await listen(server)
  await new Promise(resolve => server.close(resolve))
  return port
}

async function readRequestJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function parseMcpResponse(raw) {
  if (!raw.startsWith('event:') && !raw.includes('\ndata:')) return JSON.parse(raw)
  let parsed = null
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('data:')) parsed = JSON.parse(line.slice(5).trim())
  }
  return parsed
}

async function waitForMcp(url, child, stderr) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      assert.fail(`MCP process exited ${child.exitCode}: ${stderr.join('')}`)
    }
    try {
      const response = await fetch(`${url}/health`)
      if (response.ok) return
    } catch (_) {
      // MCP process is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`MCP process did not become healthy: ${stderr.join('')}`)
}

async function stopChild(child) {
  if (child.exitCode != null || child.signalCode != null) return
  const exited = once(child, 'exit')
  child.kill()
  await exited
}

test('only ordinary node tools retry transient failures, at most three times with one operation ID', async () => {
  const token = 'mcp-incremental-retry-test-token'
  const attemptsByText = new Map()
  const requests = []
  const diagnosticsQueries = []
  let revisionReads = 0
  const apiServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const body = await readRequestJson(req)
    if (req.method === 'GET' && url.pathname === '/api/diagnostics/performance') {
      diagnosticsQueries.push(url.searchParams)
      return sendJson(res, 200, { cursor: 555, events: [] })
    }
    if (req.method === 'GET' && url.searchParams.get('format') === 'meta') {
      if (url.pathname.endsWith('/no-meta-room')) {
        return sendJson(res, 503, {
          code: 'META_UNAVAILABLE',
          error: 'room metadata unavailable'
        })
      }
      revisionReads += 1
      return sendJson(res, 200, { room_key: 'retry-room', currentRevision: revisionReads })
    }
    if (req.method === 'POST' && url.pathname.endsWith('/nodes')) {
      const text = String(body.text || '')
      const attempts = (attemptsByText.get(text) || 0) + 1
      attemptsByText.set(text, attempts)
      requests.push({ text, body })
      if (text === 'retry-success' && attempts <= 2) {
        return sendJson(res, 503, {
          code: 'MCP_WRITE_BUSY',
          error: 'MCP write is busy',
          retryAfterMs: 5
        })
      }
      if (text === 'retry-generated' && attempts === 1) {
        return sendJson(res, 503, {
          code: 'MCP_WRITE_BUSY',
          error: 'MCP write is busy',
          retryAfterMs: 5
        })
      }
      if (text === 'retry-network' && attempts === 1) {
        res.destroy()
        return
      }
      if (text === 'retry-network-reject' && attempts === 1) {
        res.destroy()
        return
      }
      if (text === 'retry-network-reject') {
        return sendJson(res, 403, {
          code: 'FORBIDDEN',
          error: 'write is forbidden'
        })
      }
      if (text === 'retry-exhaust') {
        return sendJson(res, 503, {
          code: 'MCP_WRITE_BUSY',
          error: 'MCP write is busy',
          retryAfterMs: 5
        })
      }
      if (text === 'no-retry-conflict') {
        return sendJson(res, 409, {
          code: 'SOP_PROTECTED',
          error: 'SOP confirmation required'
        })
      }
      return sendJson(res, 200, { uid: 'generated-node', version: 2 })
    }
    if (req.method === 'POST' && url.pathname.endsWith('/todos/complete')) {
      requests.push({ text: 'complete_todo', body })
      return sendJson(res, 503, {
        code: 'MCP_WRITE_BUSY',
        error: 'MCP write is busy',
        retryAfterMs: 5
      })
    }
    return sendJson(res, 404, { code: 'NOT_FOUND', error: 'not found' })
  })

  const apiPort = await listen(apiServer)
  const mcpPort = await freePort()
  const stderr = []
  const mcpServer = spawn(process.execPath, ['bin/mcpServer.mjs', '--http'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      MIND_MAP_SKIP_ROOT_ENV: '1',
      MIND_MAP_API: `http://127.0.0.1:${apiPort}`,
      MCP_PORT: String(mcpPort),
      MCP_HOST: '127.0.0.1',
      MCP_TOKEN: token,
      MCP_CLIENT_ID: 'incremental-retry-test',
      PERFORMANCE_DIAGNOSTICS: '1'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  })
  mcpServer.stderr.on('data', chunk => stderr.push(String(chunk)))

  const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`
  let sessionId = ''
  let rpcId = 0
  async function rpc(method, params) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      'MCP-Protocol-Version': '2024-11-05'
    }
    if (sessionId) headers['mcp-session-id'] = sessionId
    const response = await fetch(mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params })
    })
    sessionId = response.headers.get('mcp-session-id') || sessionId
    const raw = await response.text()
    assert.ok(response.ok, `${method} HTTP ${response.status}: ${raw}`)
    const parsed = parseMcpResponse(raw)
    assert.ok(parsed && parsed.result, `${method} response missing result: ${raw}`)
    return parsed.result
  }

  async function callTool(name, args) {
    return rpc('tools/call', { name, arguments: args })
  }

  function toolPayload(result) {
    if (result.structuredContent) return result.structuredContent
    const text = result.content.find(item => item.type === 'text')?.text
    return text ? JSON.parse(text) : null
  }

  try {
    await waitForMcp(`http://127.0.0.1:${mcpPort}`, mcpServer, stderr)
    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-incremental-retry-test', version: '1.0.0' }
    })

    const successId = '550e8400-e29b-41d4-a716-446655440000'
    const success = await callTool('add_node', {
      room_key: 'retry-room',
      parent: 'root',
      text: 'retry-success',
      operation_id: successId
    })
    assert.equal(success.isError, undefined)
    assert.equal(toolPayload(success).base_revision, 1)
    const successAttempts = requests.filter(item => item.text === 'retry-success')
    assert.equal(successAttempts.length, 3)
    assert.deepEqual(
      successAttempts.map(item => item.body.operation_id || item.body.operationId),
      [successId, successId, successId]
    )
    assert.deepEqual(
      successAttempts.map(item => item.body.baseVersion),
      [1, 1, 1],
      'automatic retries must keep the first observed base revision'
    )

    const generated = await callTool('add_node', {
      room_key: 'retry-room',
      parent: 'root',
      text: 'retry-generated'
    })
    assert.equal(generated.isError, undefined)
    const generatedAttempts = requests.filter(item => item.text === 'retry-generated')
    assert.equal(generatedAttempts.length, 2)
    const generatedIds = generatedAttempts.map(
      item => item.body.operation_id || item.body.operationId
    )
    assert.ok(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        String(generatedIds[0] || '')
      ),
      'legacy calls without operation_id still receive a generated stable UUID'
    )
    assert.deepEqual(generatedIds, [generatedIds[0], generatedIds[0]])

    const networkId = '7ba7b810-9dad-41d1-80b4-00c04fd430c8'
    const networkRetry = await callTool('add_node', {
      room_key: 'retry-room',
      parent: 'root',
      text: 'retry-network',
      operation_id: networkId
    })
    assert.equal(networkRetry.isError, undefined)
    const networkAttempts = requests.filter(item => item.text === 'retry-network')
    assert.equal(networkAttempts.length, 2)
    assert.deepEqual(
      networkAttempts.map(item => item.body.operation_id || item.body.operationId),
      [networkId, networkId]
    )

    const exhaustedId = '6ba7b810-9dad-41d1-80b4-00c04fd430c8'
    const exhausted = await callTool('add_node', {
      room_key: 'retry-room',
      parent: 'root',
      text: 'retry-exhaust',
      operation_id: exhaustedId
    })
    assert.equal(exhausted.isError, true)
    const exhaustedAttempts = requests.filter(item => item.text === 'retry-exhaust')
    assert.equal(exhaustedAttempts.length, 4, 'one initial call plus at most three retries')
    assert.ok(
      exhaustedAttempts.every(
        item => (item.body.operation_id || item.body.operationId) === exhaustedId
      )
    )
    assert.match(exhausted.content.map(item => item.text || '').join(''), /busy/i)
    const errorMeta = exhausted.structuredContent || exhausted._meta || {}
    assert.equal(errorMeta.operation_id || errorMeta.operationId, exhaustedId)
    assert.equal(errorMeta.code, 'MCP_WRITE_BUSY')
    assert.equal(Number(errorMeta.statusCode), 503)
    assert.equal(errorMeta.outcomeUnknown, false, 'queue rejection is known not to have applied')
    assert.equal(errorMeta.base_revision, exhaustedAttempts[0].body.baseVersion)
    assert.equal(errorMeta.writeSubmitted, true)
    assert.ok(Number(errorMeta.retryAfterMs) > 0)

    const uncertainId = '9ba7b810-9dad-41d1-80b4-00c04fd430c8'
    const uncertain = await callTool('add_node', {
      room_key: 'retry-room',
      parent: 'root',
      text: 'retry-network-reject',
      operation_id: uncertainId
    })
    assert.equal(uncertain.isError, true)
    assert.equal(uncertain.structuredContent.outcome, 'unknown')
    assert.equal(uncertain.structuredContent.outcomeUnknown, true)
    const uncertainAttempts = requests.filter(item => item.text === 'retry-network-reject')
    assert.equal(uncertainAttempts.length, 2)
    assert.equal(uncertainAttempts[0].body.baseVersion, uncertainAttempts[1].body.baseVersion)
    assert.equal(uncertain.structuredContent.base_revision, uncertainAttempts[0].body.baseVersion)
    assert.equal(uncertain.structuredContent.writeSubmitted, true)

    const metadataFailure = await callTool('add_node', {
      room_key: 'no-meta-room',
      parent: 'root',
      text: 'metadata-never-submitted',
      operation_id: '7ba7b811-9dad-41d1-80b4-00c04fd430c8'
    })
    assert.equal(metadataFailure.isError, true)
    assert.equal(metadataFailure.structuredContent.writeSubmitted, false)
    assert.equal(Object.hasOwn(metadataFailure.structuredContent, 'base_revision'), false)
    assert.equal(
      requests.filter(item => item.text === 'metadata-never-submitted').length,
      0,
      'metadata failure happens before the write request is submitted'
    )

    const diagnostics = await callTool('get_performance_diagnostics', {
      room_key: 'retry-room',
      after: 17,
      writer_after: 0
    })
    assert.equal(diagnostics.isError, undefined)
    const diagnosticResult =
      diagnostics.structuredContent ||
      JSON.parse(diagnostics.content.find(item => item.type === 'text').text)
    assert.equal(diagnosticResult.cursor, 555)
    assert.ok(diagnosticResult.mcpWriter.samples.events.length > 0)
    assert.ok(
      diagnosticResult.mcpWriter.samples.events.some(
        event =>
          event.kind === 'mcp-queue' &&
          event.stage === 'start' &&
          Number.isFinite(Number(event.durationMs))
      ),
      'queue-start samples include the measured queue wait'
    )
    assert.equal(diagnosticsQueries.length, 1)
    assert.equal(diagnosticsQueries[0].get('after'), '17')
    assert.equal(diagnosticsQueries[0].has('writer_after'), false)

    const conflict = await callTool('add_node', {
      room_key: 'retry-room',
      parent: 'root',
      text: 'no-retry-conflict',
      operation_id: '8ba7b810-9dad-41d1-80b4-00c04fd430c8'
    })
    assert.equal(conflict.isError, true)
    assert.equal(
      requests.filter(item => item.text === 'no-retry-conflict').length,
      1,
      'permission/business conflicts must not retry'
    )

    const complete = await callTool('complete_todo', {
      room_key: 'retry-room',
      task: 'task-1',
      sop_uid: 'sop-1',
      sop_version: '1',
      check_results: []
    })
    assert.equal(complete.isError, true)
    assert.equal(
      requests.filter(item => item.text === 'complete_todo').length,
      1,
      'business slow-path tools must keep their existing single-attempt behavior'
    )
  } finally {
    await stopChild(mcpServer)
    if (apiServer.closeAllConnections) apiServer.closeAllConnections()
    await new Promise(resolve => apiServer.close(resolve))
  }
})

test.todo(
  'isolated PG/API: ordinary add/update/delete/move use Direct for authenticated UID/root references; title/path, expected, attachment, validateBase, and business/slow operations retain their explicit compatibility path'
)
test.todo(
  'isolated PG/API: active and archived rows with one operation_id resolve from one consistent lookup and cannot be committed twice'
)
test.todo(
  'isolated PG/API: duplicate replay preserves the current room cache head and restore epoch after a later VERSION_RESTORE'
)
test.todo(
  'isolated PG/API: V2 meta avoids node JSON/full-tree reads; empty-title root lookup is bounded and uninitialized legacy fallback is measured'
)
