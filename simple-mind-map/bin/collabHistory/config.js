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
    autoVersionOnCheckpoint: boolEnv('HISTORY_AUTO_VERSION_ON_CHECKPOINT', true),
    snapshotVersion: 1,
    ...overrides
  }
}

module.exports = { historyConfig }
