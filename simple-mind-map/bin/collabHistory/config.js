function numEnv(name, fallback) {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

function boolEnv(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  return !/^(0|false|off|no)$/i.test(String(raw))
}

function historyConfig(overrides = {}) {
  return {
    checkpointEvery: numEnv('HISTORY_CHECKPOINT_EVERY', 200),
    autoVersionMinMs: numEnv('HISTORY_AUTO_VERSION_MIN_MS', 15 * 60 * 1000),
    autoVersionIdleMs: numEnv('HISTORY_AUTO_VERSION_IDLE_MS', 2 * 60 * 1000),
    autoVersionOnCheckpoint: boolEnv('HISTORY_AUTO_VERSION_ON_CHECKPOINT', false),
    autoJobPollMs: numEnv('HISTORY_AUTO_JOB_POLL_MS', 5000),
    autoJobMaxAttempts: numEnv('HISTORY_AUTO_JOB_MAX_ATTEMPTS', 5),
    treeCacheMaxEntries: numEnv('HISTORY_TREE_CACHE_ENTRIES', 32),
    treeCacheMaxNodes: numEnv('HISTORY_TREE_CACHE_NODES', 40000),
    snapshotVersion: 1,
    schemaVersion: 2,
    ...overrides
  }
}

module.exports = { historyConfig }
