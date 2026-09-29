const assert = require('assert').strict
const { assertHistoryPgTestEnvironment } = require('./historyPgSafety')

const safe = {
  MIND_MAP_SKIP_ROOT_ENV: '1',
  PGHOST: '127.0.0.1',
  PGDATABASE: 'mind_map_history_test'
}
assert.equal(assertHistoryPgTestEnvironment(safe), true)
for (const host of ['localhost', '::1']) {
  assert.equal(assertHistoryPgTestEnvironment({ ...safe, PGHOST: host }), true)
}
for (const override of [
  { MIND_MAP_SKIP_ROOT_ENV: '' },
  { MIND_MAP_SKIP_ROOT_ENV: 'true' },
  { PGHOST: '192.168.1.114' },
  { PGHOST: 'production.example.com' },
  { PGHOST: '' },
  { PGDATABASE: 'mind_map' },
  { PGDATABASE: '' }
]) {
  assert.throws(() => assertHistoryPgTestEnvironment({ ...safe, ...override }),
    /Refusing PostgreSQL history test/)
}
assert.throws(() => assertHistoryPgTestEnvironment({}), /Refusing PostgreSQL history test/)
console.log('PASS: history PostgreSQL tests reject business/remote/missing configuration before connecting')
