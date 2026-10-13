#!/usr/bin/env node

// Knowledge and Wiki compilers share PostgreSQL with collaboration, but they
// must not run on the collaboration process. Compilation walks whole rooms
// and was holding the room lock longer by blocking that event loop.
require('./loadEnv')

const { initSchema, getPool, operationEvents } = require('./storage')
const {
  createEventBus,
  createPostgresBus,
  setActiveEventBus
} = require('./eventBus')

function enabled(name, fallback) {
  const raw = process.env[name]
  const value = raw == null || raw === '' ? fallback : raw
  return /^(true|1|yes|on)$/i.test(String(value))
}

async function main() {
  await initSchema()
  let bus = createEventBus({ pool: getPool() })
  try {
    if (typeof bus.start === 'function') await bus.start()
  } catch (err) {
    console.error(
      '[compiler] event bus failed, falling back to postgres:',
      (err && err.message) || err
    )
    if (bus && bus.name === 'redis') {
      if (typeof bus.close === 'function') await bus.close().catch(() => {})
      bus = createPostgresBus(getPool())
      setActiveEventBus(bus)
      if (typeof bus.start === 'function') await bus.start()
    } else {
      throw err
    }
  }

  if (enabled('KNOWLEDGE_COMPILER_ENABLED', 'false')) {
    await require('./knowledge').start({
      pool: getPool(),
      operationEvents,
      bus
    })
  } else {
    console.log('[compiler] knowledge compiler disabled')
  }

  if (enabled('WIKI_COMPILER_SYNC_ENABLED', 'true')) {
    await require('./wikiCompiler').start({
      pool: getPool(),
      operationEvents,
      bus
    })
  } else {
    console.log('[compiler] wiki compiler disabled')
  }

  console.log('[compiler] background compilers are outside the collaboration process')
}

main().catch(err => {
  console.error('[compiler] startup failed', (err && err.stack) || err)
  process.exit(1)
})
