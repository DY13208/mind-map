const assert = require('assert')
const {
  formatVersionTime,
  localizeGeneratedVersionName
} = require('../bin/collabHistory/versionTime')

assert.strictEqual(
  formatVersionTime('2026-09-17T03:27:00.000Z', 'Asia/Shanghai').slice(0, 16),
  '2026-09-17 11:27'
)
assert.strictEqual(
  localizeGeneratedVersionName({
    type: 'AUTO',
    created_at: '2026-09-17T03:27:00.000Z',
    name: '自动保存 2026-09-17 03:27'
  }),
  '自动保存 2026-09-17 11:27'
)
assert.strictEqual(
  localizeGeneratedVersionName({
    type: 'PRE_RESTORE',
    created_at: '2026-09-17T03:27:00.000Z',
    name: '恢复前 2026-09-17 03:27'
  }),
  '恢复前 2026-09-17 11:27'
)
assert.strictEqual(
  localizeGeneratedVersionName({
    type: 'RESTORE',
    created_at: '2026-09-17T03:27:00.000Z',
    name: '恢复到 2026-09-17 02:39:00'
  }),
  '恢复到 2026-09-17 02:39:00'
)
assert.strictEqual(
  localizeGeneratedVersionName({
    type: 'MANUAL',
    created_at: '2026-09-17T03:27:00.000Z',
    name: '2026/9/17 11:27:42'
  }),
  '2026/9/17 11:27:42'
)

console.log('historyVersionTime.test.js ok')
