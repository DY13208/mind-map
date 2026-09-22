const assert = require('assert')
const path = require('path')

const adapterPath = path.resolve(__dirname, 'adapters/docmostAdapter.js')
const coordinatorPath = path.resolve(__dirname, 'docmostSyncCoordinator.js')
const storePath = path.resolve(__dirname, 'docmostMappingStore.js')
const canonicalPath = path.resolve(__dirname, 'adapters/canonicalInput.js')

/**
 * @param {object} opts
 * @param {Function} opts.fakeSync
 * @param {Array<{file:string}>} [opts.documents]
 * @param {Map|Function} [opts.listMappings] roomId -> rows OR async (db, roomId) => rows
 */
function loadCoordinatorWithFakes(opts) {
  delete require.cache[adapterPath]
  delete require.cache[coordinatorPath]
  delete require.cache[storePath]
  delete require.cache[canonicalPath]

  const versions = new Map() // roomId -> Map(topicKey -> last_synced_version)
  const zombieRows = opts.zombieRows || []

  function rowsFor(roomId) {
    const byTopic = versions.get(String(roomId)) || new Map()
    const rows = []
    for (const [topic_key, last_synced_version] of byTopic) {
      rows.push({
        slot: 'standard',
        owner: 'mindmap',
        topic_key,
        last_synced_version
      })
    }
    for (const z of zombieRows) {
      if (String(z.roomId || roomId) === String(roomId)) rows.push(z)
    }
    return rows
  }

  require.cache[adapterPath] = {
    id: adapterPath,
    filename: adapterPath,
    loaded: true,
    exports: {
      syncEnabled: () => true,
      sync: opts.fakeSync
    }
  }

  require.cache[storePath] = {
    id: storePath,
    filename: storePath,
    loaded: true,
    exports: {
      ensureSchema: async () => {},
      listRoomMappings: async (_db, roomId) =>
        typeof opts.listMappings === 'function'
          ? opts.listMappings(_db, roomId)
          : rowsFor(roomId),
      topicKeyFromCanonicalPath: file => {
        const f = String(file || '').replace(/^\/+/, '')
        if (!f || f === 'README.md') return 'README'
        return f
      },
      __setSyncedVersion: (roomId, topicKey, v) => {
        const key = String(roomId)
        if (!versions.has(key)) versions.set(key, new Map())
        versions.get(key).set(String(topicKey || 'README'), String(v))
      },
      __setRoomVersion: (roomId, v) => {
        const key = String(roomId)
        if (!versions.has(key)) versions.set(key, new Map())
        const m = versions.get(key)
        if (m.size === 0) m.set('README', String(v))
        else for (const t of m.keys()) m.set(t, String(v))
      },
      __versions: versions
    }
  }

  let canonicalVersion = '100'
  let documents = opts.documents || [{ file: 'README.md' }]
  require.cache[canonicalPath] = {
    id: canonicalPath,
    filename: canonicalPath,
    loaded: true,
    exports: {
      readCanonical: async () => ({
        manifest: { lastCompiledVersion: canonicalVersion },
        documents
      }),
      __setVersion: v => {
        canonicalVersion = String(v)
      },
      __setDocuments: docs => {
        documents = docs
      },
      get __version() {
        return canonicalVersion
      }
    }
  }

  // Force short cooldown / rounds for tests unless caller overrides
  if (opts.maxRounds != null) process.env.DOCMOST_SYNC_MAX_ROUNDS = String(opts.maxRounds)
  if (opts.cooldownMs != null) {
    process.env.DOCMOST_SYNC_COOLDOWN_MS = String(opts.cooldownMs)
  }

  delete require.cache[coordinatorPath]
  const coordinator = require('./docmostSyncCoordinator')
  const store = require('./docmostMappingStore')
  const canonical = require('./adapters/canonicalInput')
  return { coordinator, store, canonical }
}

async function test(name, fn) {
  try {
    await fn()
    console.log('ok -', name)
  } catch (err) {
    console.error('FAIL -', name)
    console.error(err)
    process.exitCode = 1
  }
}

;(async () => {
  await test('Case1: already synced → 1 round break', async () => {
    let syncCalls = 0
    process.env.DOCMOST_SYNC_MAX_ROUNDS = '5'
    process.env.DOCMOST_SYNC_COOLDOWN_MS = '60000'
    const { coordinator, store, canonical } = loadCoordinatorWithFakes({
      fakeSync: async roomId => {
        syncCalls += 1
        return {
          roomId,
          status: 'synced',
          syncedVersion: canonical.__version,
          pages: 1,
          warnings: []
        }
      }
    })
    coordinator._resetForTests()
    canonical.__setVersion('100')
    store.__setSyncedVersion('room-a', 'README', '100')
    const result = await coordinator.requestSyncAndWait('room-a', {
      pool: {},
      outputDir: '/tmp'
    })
    assert.strictEqual(String(result.syncedVersion), '100')
    assert.strictEqual(syncCalls, 1)
  })

  await test('Case3-ish: content bump via adapter reflected in behind=false', async () => {
    // Coordinator sees mapping catch up after sync returns
    let syncCalls = 0
    const { coordinator, store, canonical } = loadCoordinatorWithFakes({
      fakeSync: async roomId => {
        syncCalls += 1
        store.__setSyncedVersion(roomId, 'README', canonical.__version)
        return {
          roomId,
          status: 'synced',
          syncedVersion: canonical.__version,
          pages: 1,
          warnings: []
        }
      }
    })
    coordinator._resetForTests()
    canonical.__setVersion('V2')
    store.__setSyncedVersion('room-b', 'README', 'V1')
    const result = await coordinator.requestSyncAndWait('room-b', {
      pool: {},
      outputDir: '/tmp'
    })
    assert.strictEqual(syncCalls, 1)
    assert.strictEqual(String(result.syncedVersion), 'V2')
    assert.strictEqual(String(store.__versions.get('room-b').get('README')), 'V2')
  })

  await test('Case4: zombie mapping must not keep room behind', async () => {
    let syncCalls = 0
    const { coordinator, store, canonical } = loadCoordinatorWithFakes({
      documents: [{ file: 'README.md' }],
      zombieRows: [
        {
          roomId: 'room-z',
          slot: 'standard',
          owner: 'mindmap',
          topic_key: 'branches/old.md',
          last_synced_version: 'V1'
        }
      ],
      fakeSync: async roomId => {
        syncCalls += 1
        store.__setSyncedVersion(roomId, 'README', canonical.__version)
        return {
          roomId,
          status: 'synced',
          syncedVersion: canonical.__version,
          pages: 1,
          warnings: []
        }
      }
    })
    coordinator._resetForTests()
    canonical.__setVersion('V2')
    store.__setSyncedVersion('room-z', 'README', 'V2')
    const behind = await coordinator.mappingBehindCanonical(
      {},
      'room-z',
      'V2',
      '/tmp'
    )
    assert.strictEqual(behind, false, 'zombie topic should be ignored')
    const result = await coordinator.requestSyncAndWait('room-z', {
      pool: {},
      outputDir: '/tmp'
    })
    assert.strictEqual(syncCalls, 1)
    assert.strictEqual(String(result.syncedVersion), 'V2')
  })

  await test('Case6: permanent behind → max rounds then cooldown', async () => {
    let syncCalls = 0
    process.env.DOCMOST_SYNC_MAX_ROUNDS = '3'
    process.env.DOCMOST_SYNC_COOLDOWN_MS = '5000'
    const { coordinator, store, canonical, MAX } = (() => {
      const loaded = loadCoordinatorWithFakes({
        maxRounds: 3,
        cooldownMs: 5000,
        fakeSync: async roomId => {
          syncCalls += 1
          // Never bump mapping — permanent behind
          return {
            roomId,
            status: 'synced',
            syncedVersion: 'V2',
            pages: 1,
            warnings: []
          }
        }
      })
      return loaded
    })()
    coordinator._resetForTests()
    canonical.__setVersion('V2')
    store.__setSyncedVersion('room-stuck', 'README', 'V1')

    const started = Date.now()
    await coordinator.requestSyncAndWait('room-stuck', {
      pool: {},
      outputDir: '/tmp'
    })
    const elapsed = Date.now() - started
    assert.strictEqual(syncCalls, 3, 'expected exactly MAX rounds, got ' + syncCalls)
    assert.ok(elapsed >= 200, 'expected backoff sleeps, elapsed=' + elapsed)
    const st = coordinator._getStateForTests('room-stuck')
    assert.ok(st.cooldownUntil > Date.now(), 'expected cooldownUntil in future')

    // Immediate re-enqueue must not start another infinite run
    const before = syncCalls
    await coordinator.requestSync('room-stuck', {
      pool: {},
      reason: 'during-cooldown'
    })
    await new Promise(r => setTimeout(r, 50))
    assert.strictEqual(syncCalls, before, 'no sync during cooldown')
  })

  await test('Case7: dirty forever still capped by MAX_SYNC_ROUNDS', async () => {
    let syncCalls = 0
    process.env.DOCMOST_SYNC_MAX_ROUNDS = '3'
    process.env.DOCMOST_SYNC_COOLDOWN_MS = '8000'
    const { coordinator, store, canonical } = loadCoordinatorWithFakes({
      maxRounds: 3,
      cooldownMs: 8000,
      fakeSync: async roomId => {
        syncCalls += 1
        store.__setSyncedVersion(roomId, 'README', canonical.__version)
        // Keep dirty=true via external enqueue mid-flight simulated by mutating state
        const st = coordinator._getStateForTests(roomId)
        st.dirty = true
        return {
          roomId,
          status: 'synced',
          syncedVersion: canonical.__version,
          pages: 1,
          warnings: []
        }
      }
    })
    coordinator._resetForTests()
    canonical.__setVersion('9')
    store.__setSyncedVersion('room-dirty', 'README', '9')
    await coordinator.requestSyncAndWait('room-dirty', {
      pool: {},
      outputDir: '/tmp'
    })
    assert.strictEqual(syncCalls, 3)
    const st = coordinator._getStateForTests('room-dirty')
    assert.ok(st.cooldownUntil > Date.now())
  })

  await test('Case8: many stuck rooms each capped (no unbounded per-room spin)', async () => {
    process.env.DOCMOST_SYNC_MAX_ROUNDS = '2'
    process.env.DOCMOST_SYNC_COOLDOWN_MS = '10000'
    const counts = new Map()
    const { coordinator, store, canonical } = loadCoordinatorWithFakes({
      maxRounds: 2,
      cooldownMs: 10000,
      fakeSync: async roomId => {
        counts.set(roomId, (counts.get(roomId) || 0) + 1)
        return {
          roomId,
          status: 'synced',
          syncedVersion: 'X',
          pages: 1,
          warnings: []
        }
      }
    })
    coordinator._resetForTests()
    canonical.__setVersion('X')
    const rooms = []
    for (let i = 0; i < 22; i++) {
      const id = 'room-multi-' + i
      rooms.push(id)
      store.__setSyncedVersion(id, 'README', 'OLD')
    }
    await Promise.all(
      rooms.map(id =>
        coordinator.requestSyncAndWait(id, { pool: {}, outputDir: '/tmp' })
      )
    )
    for (const id of rooms) {
      assert.strictEqual(counts.get(id), 2, id + ' sync count')
      const st = coordinator._getStateForTests(id)
      assert.ok(st.cooldownUntil > Date.now(), id + ' cooldown')
    }
  })

  await test('coalesce + rerun catches latest version without drop', async () => {
    let syncCalls = 0
    process.env.DOCMOST_SYNC_MAX_ROUNDS = '8'
    process.env.DOCMOST_SYNC_COOLDOWN_MS = '60000'
    const { coordinator, store, canonical } = loadCoordinatorWithFakes({
      maxRounds: 8,
      fakeSync: async roomId => {
        syncCalls += 1
        const startedAt = canonical.__version
        await new Promise(r => setTimeout(r, 80))
        store.__setSyncedVersion(roomId, 'README', startedAt)
        return {
          roomId,
          status: 'synced',
          spaceId: 's1',
          spaceKind: 'personal',
          pages: 1,
          syncedVersion: startedAt,
          warnings: []
        }
      }
    })

    coordinator._resetForTests()
    canonical.__setVersion('100')
    store.__setSyncedVersion('room-x', 'README', '99')

    const wait1 = coordinator.requestSyncAndWait('room-x', {
      pool: {},
      outputDir: '/tmp'
    })

    await new Promise(r => setTimeout(r, 15))
    canonical.__setVersion('101')
    await coordinator.requestSync('room-x', { pool: {}, reason: 'compile-101' })
    canonical.__setVersion('102')
    await coordinator.requestSync('room-x', { pool: {}, reason: 'compile-102' })
    canonical.__setVersion('103')
    await coordinator.requestSync('room-x', { pool: {}, reason: 'compile-103' })

    await wait1
    const final = await coordinator.requestSyncAndWait('room-x', {
      pool: {},
      outputDir: '/tmp'
    })

    assert.strictEqual(String(store.__versions.get('room-x').get('README')), '103')
    assert.ok(syncCalls >= 2, 'expected at least one rerun, got ' + syncCalls)
    assert.strictEqual(String(final.syncedVersion), '103')
  })

  await test('API wait and auto enqueue share single-flight', async () => {
    let inFlight = 0
    let maxInFlight = 0
    process.env.DOCMOST_SYNC_MAX_ROUNDS = '5'
    const { coordinator, store, canonical } = loadCoordinatorWithFakes({
      fakeSync: async roomId => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 50))
        inFlight -= 1
        const v = canonical.__version
        store.__setSyncedVersion(roomId, 'README', v)
        return {
          roomId,
          status: 'synced',
          syncedVersion: v,
          pages: 1,
          warnings: []
        }
      }
    })
    coordinator._resetForTests()
    canonical.__setVersion('5')
    store.__setSyncedVersion('room-y', 'README', '5')
    const a = coordinator.requestSyncAndWait('room-y', { pool: {} })
    const b = coordinator.requestSyncAndWait('room-y', { pool: {} })
    const c = coordinator.requestSync('room-y', { pool: {} })
    await Promise.all([a, b, c])
    assert.strictEqual(maxInFlight, 1, 'single-flight violated: ' + maxInFlight)
  })

  console.log('coordinator tests done')
})()
