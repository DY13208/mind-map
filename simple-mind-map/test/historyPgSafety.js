const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

function assertHistoryPgTestEnvironment(env = process.env) {
  const skipRootEnv = String(env.MIND_MAP_SKIP_ROOT_ENV || '')
  const host = String(env.PGHOST || '').trim().toLowerCase()
  const database = String(env.PGDATABASE || '').trim()
  const errors = []

  if (skipRootEnv !== '1') {
    errors.push('MIND_MAP_SKIP_ROOT_ENV must be exactly 1')
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    errors.push('PGHOST must be localhost, 127.0.0.1, or ::1')
  }
  if (!database || database === 'mind_map') {
    errors.push('PGDATABASE must be set to a non-business test database')
  }

  if (errors.length) {
    throw new Error('Refusing PostgreSQL history test: ' + errors.join('; '))
  }
  return true
}

module.exports = { assertHistoryPgTestEnvironment }
