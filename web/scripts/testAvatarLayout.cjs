// Run against an isolated local QA app with a synthetic user and room:
// AVATAR_QA_BASE_URL=http://127.0.0.1:8991 AVATAR_QA_STORAGE_STATE=/absolute/auth.json \
// AVATAR_QA_ROOM=<room> node web/scripts/testAvatarLayout.cjs
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium, webkit } = require('../../simple-mind-map/node_modules/playwright')

const base = process.env.AVATAR_QA_BASE_URL || 'http://127.0.0.1:8991'
const storageState = process.env.AVATAR_QA_STORAGE_STATE
const room = process.env.AVATAR_QA_ROOM
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'Use a local QA server')
assert(storageState && room, 'Provide an isolated QA session and room')
const out = path.resolve(__dirname, '../../output/playwright/ipad-avatar')
fs.mkdirSync(out, { recursive: true })

function picture(width, height) {
  return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#9bd9c7"/><circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 3}" fill="#153052"/></svg>`)
}

function near(actual, expected, message) {
  assert(Math.abs(actual - expected) < 0.1, `${message}: ${actual} vs ${expected}`)
}

async function checkAvatar(avatar, size, image) {
  const box = await avatar.evaluate(e => {
    const r = e.getBoundingClientRect(), img = e.querySelector('img'), q = img && img.getBoundingClientRect()
    return { width: r.width, height: r.height, radius: getComputedStyle(e).borderRadius,
      image: img && { width: q.width, height: q.height, loaded: img.complete && img.naturalWidth > 0, fit: getComputedStyle(img).objectFit } }
  })
  near(box.width, size, 'Avatar width')
  near(box.height, size, 'Avatar height')
  assert.equal(box.radius, '50%')
  if (image) {
    near(box.image.width, size, 'Image width')
    near(box.image.height, size, 'Image height')
    assert.equal(box.image.loaded, true)
    assert.equal(box.image.fit, 'cover')
  }
  else assert.equal(box.image, null)
}

async function run(name, engine) {
  const browser = await engine.launch()
  const results = []
  try {
    for (const [label, width, height, touch, desktopUA] of [
      ['ipad', 820, 1180, true], ['ipad-landscape', 1194, 834, true],
      ['ipad-pro', 1024, 1366, true], ['ipad-pro-landscape', 1366, 1024, true],
      ['ipad-desktop-ua', 820, 1180, true, true], ['split-screen', 744, 1133, true],
      ['phone', 393, 852, true], ['desktop', 1440, 900, false]
    ]) {
      const context = await browser.newContext({ storageState, viewport: { width, height }, hasTouch: touch, isMobile: touch && !desktopUA,
        ...(desktopUA ? { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15' } : {}) })
      const page = await context.newPage(), errors = []
      page.setDefaultTimeout(20000)
      page.on('pageerror', error => errors.push(error.message))
      await page.route('**/__avatar_qa_missing__.png', route => route.abort())
      try {
        await page.goto(`${base}/?room=${encodeURIComponent(room)}&shell=focus`)
        await page.waitForFunction(() => {
          function find(vm) { if (vm && vm.mindMap && vm.mindMap.renderer) return vm; for (const child of (vm && vm.$children) || []) { const match = find(child); if (match) return match } }
          const vm = find(document.querySelector('#app').__vue__)
          return vm && !vm.roomCanvasPending && vm.mindMap.renderer.root && document.querySelector('[data-testid=collab-status].cooperating')
        })
        const badge = page.locator('.notificationBadge--avatar'), button = badge.getByRole('button', { name: '消息中心', exact: true })
        const visible = await button.isVisible()
        if (visible) {
          for (const [kind, avatar] of [['landscape', picture(160, 80)], ['portrait', picture(80, 160)], ['broken', base + '/__avatar_qa_missing__.png'], ['initial', '测'], ['recovered', picture(120, 120)]]) {
            await page.locator('.sidebarTriggerRoot').evaluate((e, value) => { const vm = e.__vue__; vm.authUser = { ...vm.authUser, name: '测试头像', avatar: value } }, avatar)
            const image = !['broken', 'initial'].includes(kind)
            if (image) await page.waitForFunction(() => { const img = document.querySelector('.notificationBadge--avatar img'); return img && img.complete && img.naturalWidth > 0 })
            else await badge.locator('.userAvatarInitial').waitFor()
            await checkAvatar(badge.locator('.userAvatar'), 28, image)
            for (const unread of [false, true]) {
              await page.locator('.sidebarTriggerRoot').evaluate((e, value) => {
                const state = e.__vue__.$children.find(vm => vm.$options.name === 'AccessNotificationTrigger').state
                for (const key of ['total', 'unread', 'leaveUnread', 'mentionUnread', 'announcementUnread']) state[key] = 0
                state.announcementUnread = value ? 1 : 0
              }, unread)
              await page.waitForFunction(expected => document.querySelector('.notificationBadge--avatar button').classList.contains('hasMessages') === expected, unread)
              const r = await button.boundingBox(), a = await badge.locator('.userAvatar').boundingBox()
              near(r.width, touch ? 44 : 34, 'Avatar target width')
              near(r.height, r.width, `${label}: avatar ring must be circular`)
              assert(Math.abs(a.x + a.width / 2 - r.x - r.width / 2) < 1, 'Avatar centered horizontally')
              assert(Math.abs(a.y + a.height / 2 - r.y - r.height / 2) < 1, 'Avatar centered vertically')
            }
          }
          if (touch) await button.tap(); else await button.click()
          const closeMessages = page.getByRole('button', { name: '关闭消息中心', exact: true })
          await closeMessages.click()
          await closeMessages.waitFor({ state: 'hidden' })
          assert.equal(await button.getAttribute('aria-expanded'), 'false')
          if (label === 'ipad') {
            await page.screenshot({ path: path.join(out, `${name}-ipad-editor.png`), scale: 'css' })
            await page.setViewportSize({ width: 1194, height: 834 })
            await page.waitForTimeout(200)
            await checkAvatar(badge.locator('.userAvatar'), 28, true)
            const rotated = await button.boundingBox()
            near(rotated.width, rotated.height, 'Rotated avatar ring')
          }
        } else assert(['phone', 'split-screen'].includes(label), 'Only reader layouts hide the settings rail')

        // Use normal in-app navigation so active editor requests can finish.
        await page.evaluate(() => document.querySelector('#app').__vue__.$router.push('/files?shell=full'))
        await page.locator('.roomCard').first().waitFor()
        if (touch) {
          const collapse = page.getByRole('button', { name: '关闭侧边栏', exact: true })
          if (await collapse.isVisible()) await collapse.tap()
          await page.getByRole('button', { name: '全部功能与设置', exact: true }).tap()
          await page.waitForFunction(() => document.querySelector('.productNavigationDrawer .productNavigation a') === document.activeElement)
        }
        await page.locator('.productShell').evaluate((e, avatar) => { const vm = e.__vue__; vm.profile = { ...vm.profile, avatar } }, picture(160, 80))
        const profile = page.locator(touch ? '.navigationDrawerProfile' : '.accountInfo')
        await profile.locator('img').waitFor()
        await page.waitForFunction(selector => { const img = document.querySelector(selector + ' img'); return img && img.complete && img.naturalWidth > 0 }, touch ? '.navigationDrawerProfile' : '.accountInfo')
        await checkAvatar(profile.locator('.userAvatar'), 28, true)
        await profile.click()
        await page.waitForURL(url => url.pathname === '/profile')
        await checkAvatar(page.locator('.profileCard .userAvatar'), 64, false)
        // Existing room-card ResizeObserver warnings are tracked separately; other errors fail.
        const resizeWarnings = errors.filter(e => e === 'ResizeObserver loop completed with undelivered notifications.')
        assert.deepEqual(errors.filter(e => !resizeWarnings.includes(e)), [])
        results.push({ viewport: label, editorAvatarVisible: visible, resizeWarnings: resizeWarnings.length, passed: true })
        console.log('PASS', name, label)
      } finally { await context.close() }
    }
  } finally { await browser.close() }
  return results
}

async function main() {
  const report = { chromium: await run('chromium', chromium), webkit: await run('webkit', webkit) }
  fs.writeFileSync(path.join(out, 'regression-report.json'), JSON.stringify(report, null, 2))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
