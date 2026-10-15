const test = require('node:test')
const assert = require('node:assert/strict')
const { createDirectoryRuntime, deferred, room } = require('./helpers/directoryRuntime.cjs')

const settle = () => new Promise(resolve => setImmediate(resolve))
function preview(data, text = data.title) {
  return { preview: { roomKey: data.roomKey, revision: data.revision,
    updatedAt: data.contentUpdatedAt, sketch: { text, children: [] } } }
}

test('[R26] production card/service dispatch bounds 100 actual pending HTTP requests to four', async () => {
  const runtime = createDirectoryRuntime()
  const pending = []
  let active = 0, maximum = 0
  runtime.services.http.setProductHttp((url, options = {}) => {
    const job = deferred()
    active++
    maximum = Math.max(maximum, active)
    pending.push({ job, url, options })
    return job.promise.finally(() => active--)
  })
  const jobs = Array.from({ length: 100 }, (_, i) => runtime.makeCard(room('bounded-' + i)).loadPreview())
  try {
    await settle()
    assert.ok(maximum <= 4, `Production dispatch opened ${maximum} requests; limit is 4`)
  } finally {
    // Resolve every wave, including requests that a future queue starts later.
    for (let round = 0; round < 110; round++) {
      pending.splice(0).forEach(({ job, url }) => {
        const key = decodeURIComponent(url.split('/')[3])
        job.resolve(preview(room(key)))
      })
      await settle()
      if (active === 0) break
    }
    await Promise.all(jobs)
    runtime.destroy()
  }
})

test('[R26] two real cards with the same identity and revision share one pending request', async () => {
  const runtime = createDirectoryRuntime()
  const waiting = []
  runtime.services.http.setProductHttp(() => {
    const job = deferred(); waiting.push(job); return job.promise
  })
  const data = room('same-identity')
  const first = runtime.makeCard(data), second = runtime.makeCard({ ...data })
  const jobs = [first.loadPreview(), second.loadPreview()]
  try {
    await settle()
    assert.equal(waiting.length, 1, 'Same room/version subscriptions must share the HTTP request')
  } finally {
    waiting.forEach(job => job.resolve(preview(data)))
    await Promise.all(jobs)
    runtime.destroy()
  }
})

test('[R26] destroying the last subscriber aborts the real transport signal', async () => {
  const runtime = createDirectoryRuntime()
  const job = deferred()
  let signal
  runtime.services.http.setProductHttp((_url, options = {}) => { signal = options.signal; return job.promise })
  const vm = runtime.makeCard(room('cancel-last'))
  const pending = vm.loadPreview()
  try {
    await settle()
    vm.$destroy()
    assert.ok(signal instanceof AbortSignal, 'Card cancellation must reach productRequest AbortSignal')
    assert.equal(signal.aborted, true, 'Last subscription destruction must abort its HTTP request')
  } finally {
    job.resolve(preview(room('cancel-last')))
    await pending
    runtime.destroy()
  }
})

test('[R27] delayed revision one cannot populate revision two cache for the same room', async () => {
  const runtime = createDirectoryRuntime()
  const old = deferred()
  const current = deferred()
  let calls = 0
  runtime.services.http.setProductHttp(() => ++calls === 1 ? old.promise : current.promise)
  const vm = runtime.makeCard(room('revision-race', 1))
  const pendingOld = vm.loadPreview()
  vm.room = room('revision-race', 2)
  await runtime.Vue.nextTick()
  old.resolve(preview(room('revision-race', 1), 'OLD REVISION'))
  await pendingOld
  const cached = runtime.makeCard(room('revision-race', 2))
  cached.hydrateFromCache()
  try {
    assert.notEqual(cached.sketch && cached.sketch.text, 'OLD REVISION',
      'An R1 response must never be stored using the now-current R2 key')
    const pendingNew = vm.loadPreview()
    current.resolve(preview(room('revision-race', 2), 'CURRENT REVISION'))
    await pendingNew
    assert.equal(vm.sketch && vm.sketch.text, 'CURRENT REVISION')
  } finally {
    current.resolve(preview(room('revision-race', 2), 'CURRENT REVISION'))
    await settle()
    runtime.destroy()
  }
})

test('[R27] fulfilled preview cache is isolated between real identity contexts', async () => {
  const runtime = createDirectoryRuntime()
  const data = room('principal-cache')
  runtime.services.http.setProductHttp(async () => preview(data, 'OWNER ONLY'))
  const owner = runtime.makeCard(data)
  await owner.loadPreview()
  runtime.setIdentity({ id: 'unrelated-user', corpId: 'different-corp' })
  const stranger = runtime.makeCard({ ...data })
  stranger.hydrateFromCache()
  try {
    assert.notEqual(stranger.sketch && stranger.sketch.text, 'OWNER ONLY',
      'Content cached for one authenticated identity must not hydrate a different identity')
  } finally { runtime.destroy() }
})

test('[R28] aborted production preview remains retryable instead of retaining a fallback title', async () => {
  const runtime = createDirectoryRuntime()
  let calls = 0
  const data = room('abort-retry')
  runtime.services.http.setProductHttp(async () => {
    if (++calls === 1) throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
    return preview(data, 'RETRIED CONTENT')
  })
  const vm = runtime.makeCard(data)
  try {
    await vm.loadPreview()
    await vm.loadPreview()
    assert.equal(calls, 2, 'Abort must leave the component eligible to retry')
    assert.equal(vm.sketch && vm.sketch.text, 'RETRIED CONTENT')
  } finally { runtime.destroy() }
})

test('[R26] one cancelled subscriber leaves the other subscriber and shared request alive', async () => {
  const runtime = createDirectoryRuntime()
  const requests = []
  runtime.services.http.setProductHttp((_url, options = {}) => {
    const job = deferred(); requests.push({ job, signal: options.signal }); return job.promise
  })
  const data = room('refcount-survivor')
  const first = runtime.makeCard(data), second = runtime.makeCard({ ...data })
  const pending = [first.loadPreview(), second.loadPreview()]
  try {
    await settle()
    first.$destroy()
    assert.equal(requests.length, 1, 'Two subscribers must own only one shared request')
    assert.equal(requests[0].signal.aborted, false, 'Cancelling one subscription must leave its peer alive')
    requests[0].job.resolve(preview(data, 'SURVIVOR CONTENT'))
    await Promise.all(pending)
    assert.equal(second.sketch.text, 'SURVIVOR CONTENT')
  } finally {
    requests.forEach(item => item.job.resolve(preview(data)))
    await Promise.all(pending)
    runtime.destroy()
  }
})

test('[R26] different revisions issue independent requests instead of coalescing by room alone', async () => {
  const runtime = createDirectoryRuntime()
  const jobs = []
  runtime.services.http.setProductHttp(() => { const job = deferred(); jobs.push(job); return job.promise })
  const pending = [runtime.makeCard(room('distinct-revisions', 1)).loadPreview(),
    runtime.makeCard(room('distinct-revisions', 2)).loadPreview()]
  try {
    await settle()
    assert.equal(jobs.length, 2)
  } finally {
    jobs.forEach((job, i) => job.resolve(preview(room('distinct-revisions', i + 1))))
    await Promise.all(pending)
    runtime.destroy()
  }
})

test('[R28] fulfilled cache evicts its oldest entry after more than 128 production previews', async () => {
  const runtime = createDirectoryRuntime()
  runtime.services.http.setProductHttp(async url => preview(room(decodeURIComponent(url.split('/')[3]))))
  try {
    for (let i = 0; i < 129; i++) {
      const vm = runtime.makeCard(room('lru-' + i)); await vm.loadPreview(); vm.$destroy()
    }
    const first = runtime.makeCard(room('lru-0'))
    first.hydrateFromCache()
    assert.equal(!!first.sketch, false, 'Cache must not keep an unbounded history of fulfilled rooms')
  } finally { runtime.destroy() }
})

test('[R28] fulfilled cache also evicts by four MiB even while its item count is below 128', async () => {
  const runtime = createDirectoryRuntime()
  runtime.services.http.setProductHttp(async url => preview(room(decodeURIComponent(url.split('/')[3])), 'X'.repeat(70 * 1024)))
  try {
    for (let i = 0; i < 70; i++) {
      const vm = runtime.makeCard(room('bytes-' + i)); await vm.loadPreview(); vm.$destroy()
    }
    const first = runtime.makeCard(room('bytes-0'))
    first.hydrateFromCache()
    assert.equal(!!first.sketch, false, 'Serialized preview bytes must stay below the four MiB cache budget')
  } finally { runtime.destroy() }
})

test('[R26] cancelling a queued card never starts its obsolete HTTP request', async () => {
  const runtime = createDirectoryRuntime()
  const waiting = []
  runtime.services.http.setProductHttp(url => { const job = deferred(); waiting.push({ url, job }); return job.promise })
  const cards = Array.from({ length: 5 }, (_, i) => runtime.makeCard(room('queued-' + i)))
  const requests = cards.map(card => card.loadPreview())
  await settle()
  cards[4].$destroy()
  waiting.forEach(item => item.job.resolve(preview(room(decodeURIComponent(item.url.split('/')[3])))))
  await Promise.all(requests)
  await settle()
  try { assert.equal(waiting.length, 4); assert.ok(waiting.every(item => !item.url.includes('queued-4'))) }
  finally { runtime.destroy() }
})

test('[R27] cache keys use actual response revision instead of requested revision', async () => {
  const runtime = createDirectoryRuntime()
  runtime.services.http.setProductHttp(async () => preview(room('actual-version', 2), 'SERVER VERSION TWO'))
  try {
    await runtime.makeCard(room('actual-version', 1)).loadPreview()
    const old = runtime.makeCard(room('actual-version', 1)), current = runtime.makeCard(room('actual-version', 2))
    old.hydrateFromCache(); current.hydrateFromCache()
    assert.equal(old.sketch, null)
    assert.ok(current.sketch, 'Actual response revision/stamps must remain reachable under their real cache key')
    assert.equal(current.sketch.text, 'SERVER VERSION TWO')
  } finally { runtime.destroy() }
})

test('[R27] generation changes retire old work even when content revision is unchanged', async () => {
  const runtime = createDirectoryRuntime()
  const old = deferred(), current = deferred()
  let calls = 0
  runtime.services.http.setProductHttp(() => ++calls === 1 ? old.promise : current.promise)
  const data = { ...room('generation-race'), generation: '1' }
  const card = runtime.makeCard(data)
  const first = card.loadPreview()
  await settle()
  card.room = { ...data, generation: '2' }
  await runtime.Vue.nextTick()
  old.resolve({ preview: { ...preview(data, 'OLD GENERATION').preview, generation: '1' } })
  await first
  const cached = runtime.makeCard({ ...data, generation: '2' }); cached.hydrateFromCache()
  assert.equal(cached.sketch, null)
  const next = card.loadPreview()
  current.resolve({ preview: { ...preview(data, 'NEW GENERATION').preview, generation: '2' } })
  await next
  try { assert.equal(card.sketch.text, 'NEW GENERATION') }
  finally { runtime.destroy() }
})

test('[R27] a fresh authentication object for the same user retires cached session content', async () => {
  const runtime = createDirectoryRuntime()
  const data = room('same-id-new-session')
  runtime.services.http.setProductHttp(async () => preview(data, 'PREVIOUS SESSION'))
  try {
    await runtime.makeCard(data).loadPreview()
    runtime.setIdentity({ id: 'owner', corpId: 'test-corp' })
    const next = runtime.makeCard(data); next.hydrateFromCache()
    assert.equal(next.sketch, null)
  } finally { runtime.destroy() }
})

test('[R28] native fetch AbortError passes through the real service without becoming a read-only-message TypeError', async () => {
  const runtime = createDirectoryRuntime()
  const abort = new DOMException('The operation was aborted', 'AbortError')
  runtime.services.http.setProductHttp(async () => { throw abort })
  try { await assert.rejects(runtime.services.room.getCardPreview('native-abort'), error => error === abort) }
  finally { runtime.destroy() }
})

test('[R27] refreshed room authorization cannot hydrate or request a full preview from a prior grant', async () => {
  const runtime = createDirectoryRuntime()
  const data = { ...room('revoked-client-grant'), role: 'viewer' }
  let calls = 0
  runtime.services.http.setProductHttp(async () => { calls++; return preview(data, 'PRIOR GRANT CONTENT') })
  try {
    await runtime.makeCard(data).loadPreview()
    const denied = runtime.makeCard({ ...data, role: '', canView: false, canEdit: false, canManage: false })
    denied.hydrateFromCache()
    assert.equal(denied.sketch, null, 'A fresh deny grant must not reuse an old authorized sketch')
    await denied.loadPreview()
    assert.equal(calls, 1, 'An explicit current canView=false does not issue a full-room preview')
    const changed = runtime.makeCard({ ...data, role: '', canView: true })
    changed.hydrateFromCache()
    assert.equal(changed.sketch, null, 'Even without an explicit deny, a changed room grant must be reauthorized by the API')
  } finally { runtime.destroy() }
})
