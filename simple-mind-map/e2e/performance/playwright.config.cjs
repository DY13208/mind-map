const path = require('node:path')
module.exports = {
  testDir: __dirname,
  testMatch: '*.spec.cjs',
  timeout: 180000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: path.resolve(__dirname, '../../../work/performance-tdd/playwright'),
  use: { headless: true, channel: 'chrome' }
}
