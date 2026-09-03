const playwright = require('@playwright/test')
const base = playwright.test
const expect = playwright.expect
const {
  readRuntime,
  createRoom,
  openRoom,
  attachConsole,
  assertCleanConsole,
  assertServerAlive,
  trackSockets,
  assertNoV1Presence
} = require('./helpers')

base.beforeEach(async () => {
  await assertServerAlive(readRuntime())
})

const test = base.extend({
  pair: async ({ browser }, use) => {
    const runtime = readRuntime()
    await assertServerAlive(runtime)
    const contextA = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN'
    })
    const contextB = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN'
    })
    await contextA.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: runtime.origin
    })
    await contextB.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: runtime.origin
    })
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()
    const socketsA = trackSockets(pageA)
    const socketsB = trackSockets(pageB)
    const errorsA = await attachConsole(pageA)
    const errorsB = await attachConsole(pageB)
    const room = await createRoom(runtime.api)
    await openRoom(pageA, runtime.origin, room)
    await openRoom(pageB, runtime.origin, room)
    assertNoV1Presence(socketsA.concat(socketsB))
    await use({
      runtime,
      room,
      pageA,
      pageB,
      contextA,
      contextB,
      errorsA,
      errorsB,
      socketsA,
      socketsB
    })
    assertNoV1Presence(socketsA.concat(socketsB))
    assertCleanConsole(errorsA.concat(errorsB))
    await contextA.close()
    await contextB.close()
  }
})

module.exports = { test, expect }
