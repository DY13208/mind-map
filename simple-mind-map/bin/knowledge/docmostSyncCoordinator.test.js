const assert = require('assert')
const path = require('path')
const Module = require('module')

// Fake slow adapter injected via require cache
const adapterPath = path.resolve(__dirname, 'adapters/docmostAdapter.js')
const coordinatorPath = path.resolve(__dirname, 'docmostSyncCoordinator.js')

function loadCoordinatorWithFakeAdapter(fakeSync) {
  // Clear caches
  delete require.cache[adapterPath]
  delete require.cache[coordinatorPath]
  delete require.cache[path.resolve(__dirname, 'docmostMappingStore.js')]

  const fakeAdapter = {
    syncEnabled: () => true,
    sync: fakeSync
  }
  require.cache[adapterPath] = {
    id: adapterPath,
    filename: adapterPath,
    loaded: true,
    exports: fakeAdapter
  }

  // Fake mapping store: in-memory last_synced_version tracking
  const storePath = path.resolve(__dirname, 'docmostMappingStore.js')
  const versions = new Map() // roomId -> version
  require.cache[storePath] = {
    id: storePath,
    filename: storePath,
    loaded: true,
    exports: {
      ensureSchema: async () => {},
      listRoomMappings: async (_db, roomId) => {
        const v = versions.get(String(roomId))
        if (v == null) return []
        return [
          {
            slot: 'standard',
            owner: 'mindmap',
            last_synced_version: v,
            topic_key: 'README'
          }
        ]
      },
      // test helper
      __setSyncedVersion: (roomId, v) => versions.set(String(roomId), String(v)),
      __versions: versions
    }
  }

  // Fake canonicalInput
  const canonicalPath = path.resolve(__dirname, 'adapters/canonicalInput.js')
  let canonicalVersion = '100'
  require.cache[canonicalPath] = {
    id: canonicalPath,
    filename: canonicalPath,
    loaded: true,
    exports: {
      readCanonical: async () => ({
        manifest: { lastCompiledVersion: canonicalVersion },
        documents: []
      }),
      __setVersion: v => {
        canonicalVersion = String(v)
      },
      get __version() {
        return canonicalVersion
      }
    }
  }

  const coordinator = require('./docmostSyncCoordinator')
  const store = require('./docmostMappingStore')
  const canonical = require('./adapters/canonicalInput')
  return { coordinator, store, canonical, fakeAdapter }
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
  await test('coalesce + rerun catches latest version without drop', async () => {
    let syncCalls = 0
    let currentSyncVersion = null
    const delays = []

    const { coordinator, store, canonical } = loadCoordinatorWithFakeAdapter(
      async roomId => {
        syncCalls += 1
        const startedAt = canonical.__version
        currentSyncVersion = startedAt
        // Slow sync: 80ms
        await new Promise(r => setTimeout(r, 80))
        // Persist whatever version we observed at start (stale if compile raced)
        store.__setSyncedVersion(roomId, startedAt)
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
    )

    coordinator._resetForTests()
    canonical.__setVersion('100')
    store.__setSyncedVersion('room-x', '99')

    // Start sync for v100
    const wait1 = coordinator.requestSyncAndWait('room-x', {
      pool: {},
      outputDir: '/tmp'
    })

    // While syncing, compile advances 101, 102, 103 — each enqueue must coalesce
    await new Promise(r => setTimeout(r, 15))
    canonical.__setVersion('101')
    await coordinator.requestSync('room-x', { pool: {}, reason: 'compile-101' })
    canonical.__setVersion('102')
    await coordinator.requestSync('room-x', { pool: {}, reason: 'compile-102' })
    canonical.__setVersion('103')
    await coordinator.requestSync('room-x', { pool: {}, reason: 'compile-103' })

    const result = await wait1
    // Wait until fully idle (final kick may still be running for waiters that joined later)
    // Drain by waiting again for catch-up
    const final = await coordinator.requestSyncAndWait('room-x', {
      pool: {},
      outputDir: '/tmp'
    })

    const st = coordinator._getStateForTests('room-x')
    assert.strictEqual(String(store.__versions.get('room-x')), '103')
    assert.ok(syncCalls >= 2, 'expected at least one rerun, got ' + syncCalls)
    assert.strictEqual(String(final.syncedVersion), '103')
    console.log('  syncCalls=', syncCalls, 'final=', final.syncedVersion)
  })

  await test('API wait and auto enqueue share single-flight', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const { coordinator, store, canonical } = loadCoordinatorWithFakeAdapter(
      async roomId => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 50))
        inFlight -= 1
        const v = canonical.__version
        store.__setSyncedVersion(roomId, v)
        return {
          roomId,
          status: 'synced',
          syncedVersion: v,
          pages: 1,
          warnings: []
        }
      }
    )
    coordinator._resetForTests()
    canonical.__setVersion('5')
    const a = coordinator.requestSyncAndWait('room-y', { pool: {} })
    const b = coordinator.requestSyncAndWait('room-y', { pool: {} })
    const c = coordinator.requestSync('room-y', { pool: {} })
    await Promise.all([a, b, c])
    assert.strictEqual(maxInFlight, 1, 'single-flight violated: ' + maxInFlight)
  })

  console.log('coordinator tests done')
})()