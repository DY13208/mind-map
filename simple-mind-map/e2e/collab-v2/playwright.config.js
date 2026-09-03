const path = require('path')

module.exports = {
  testDir: __dirname,
  testMatch: 'collab-v2-core.spec.js',
  timeout: 180000,
  expect: { timeout: 20000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: path.join(__dirname, 'global-setup.js'),
  globalTeardown: path.join(__dirname, 'global-teardown.js'),
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    ignoreHTTPSErrors: true,
    actionTimeout: 15000
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }]
}
