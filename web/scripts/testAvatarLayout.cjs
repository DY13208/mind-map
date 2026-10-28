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

async function checkFrame(button, touch, unread) {
  const frame = await button.locator('.notificationAvatarFrame').boundingBox()
  near(frame.width, 34, 'Visual frame width')
  near(frame.height, frame.width, 'Circular visual frame')
  if (!touch) return
  const geometry = await button.evaluate(e => {
    const rail = e.closest('.trigger'), r = rail.getBoundingClientRect()
    const dot = e.parentNode.querySelector('.el-badge__content').getBoundingClientRect()
    return { left: r.left + rail.clientLeft, right: r.left + rail.clientLeft + rail.clientWidth,
      top: r.top + rail.clientTop, bottom: r.top + rail.clientTop + rail.clientHeight,
      width: rail.clientWidth, scrollWidth: rail.scrollWidth,
      dot: { left: dot.left, right: dot.right, top: dot.top, bottom: dot.bottom } }
  })
  near(geometry.width, 44, 'Scrollbar must not consume the touch target')
  assert(geometry.scrollWidth <= geometry.width, 'No content extends beyond the scroll viewport')
  const halo = unread ? 3 : 0
  assert(frame.x - halo >= geometry.left - 0.1 && frame.x + frame.width + halo <= geometry.right + 0.1, 'Unread ring and halo must fit horizontally')
  assert(frame.y - halo >= geometry.top - 0.1 && frame.y + frame.height + halo <= geometry.bottom + 0.1, 'Unread ring and halo must fit vertically')
  if (unread) {
    assert(geometry.dot.left >= geometry.left && geometry.dot.right <= geometry.right && geometry.dot.top >= geometry.top && geometry.dot.bottom <= geometry.bottom, 'Unread dot must be fully visible')
    assert.equal(await button.locator('.notificationAvatarFrame').evaluate(e => getComputedStyle(e).borderTopColor), 'rgb(230, 75, 87)')
  }
}

async function checkRailScroll(page, context, engineName, mobile) {
  await page.bringToFront()
  const rail = page.locator('.sidebarTriggerContainer .trigger'), r = await rail.boundingBox()
  assert(await rail.evaluate(e => e.scrollHeight > e.clientHeight), 'Short viewport exercises an overflowing rail')
  if (engineName === 'chromium') {
    const cdp = await context.newCDPSession(page), x = r.x + r.width / 2, start = r.y + r.height - 24
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start }] })
    for (let step = 1; step <= 6; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: start - step * 20 }] })
      await page.waitForTimeout(20)
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    // Chromium clears touch emulation on detach; context teardown owns this session.
  } else if (!mobile) {
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2)
    await page.mouse.wheel(0, 240)
  } else {
    // Playwright mobile WebKit exposes neither native swipe nor wheel input.
    await rail.evaluate(e => { e.scrollTop += 240 })
  }
  await page.waitForFunction(() => document.querySelector('.sidebarTriggerContainer .trigger').scrollTop > 10)
  const collapse = page.getByRole('button', { name: '收起侧栏', exact: true })
  await collapse.scrollIntoViewIfNeeded()
  await collapse.tap()
  await page.getByRole('button', { name: '展开侧栏', exact: true }).tap()
  await rail.evaluate(e => { e.scrollTop = 0 })
  await page.waitForFunction(() => document.querySelector('.sidebarTriggerContainer .trigger').scrollTop === 0)
}

async function run(name, engine) {
  const browser = await engine.launch()
  const results = []
  try {
    for (const [label, width, height, touch, desktopUA] of [
      ['ipad', 820, 1180, true], ['ipad-landscape', 1194, 834, true],
      ['ipad-pro', 1024, 1366, true], ['ipad-pro-landscape', 1366, 1024, true],
      ['ipad-short', 1278, 608, true], ['ipad-short-desktop-ua', 1278, 608, true, true],
      ['ipad-desktop-ua', 820, 1180, true, true], ['split-screen', 744, 1133, true],
      ['phone', 393, 852, true], ['desktop', 1440, 900, false]
    ]) {
      if (process.env.AVATAR_QA_VIEWPORT && label !== process.env.AVATAR_QA_VIEWPORT) continue
      const context = await browser.newContext({ storageState, viewport: { width, height }, hasTouch: touch, isMobile: touch && !desktopUA,
        ...(desktopUA ? { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15' } : {}) })
      const page = await context.newPage(), errors = []
      page.setDefaultTimeout(20000)
      page.on('pageerror', error => errors.push(error.message))
      // Geometry tests use the local fallback font instead of an external CDN.
      await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
      await page.route('**/__avatar_qa_missing__.png', route => route.abort())
      try {
        await page.goto(`${base}/?room=${encodeURIComponent(room)}&shell=focus`, { waitUntil: 'domcontentloaded' })
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
              if (unread) await page.waitForFunction(() => getComputedStyle(document.querySelector('.notificationAvatarFrame')).borderTopColor === 'rgb(230, 75, 87)')
              const r = await button.boundingBox(), a = await badge.locator('.userAvatar').boundingBox()
              near(r.width, touch ? 44 : 34, 'Avatar target width')
              near(r.height, r.width, `${label}: avatar ring must be circular`)
              assert(Math.abs(a.x + a.width / 2 - r.x - r.width / 2) < 1, 'Avatar centered horizontally')
              assert(Math.abs(a.y + a.height / 2 - r.y - r.height / 2) < 1, 'Avatar centered vertically')
              await checkFrame(button, touch, unread)
            }
          }
          if (label.startsWith('ipad-short')) {
            const rail = await page.locator('.sidebarTriggerContainer').boundingBox(), zoom = await page.locator('.mobileCanvasControls').boundingBox()
            assert(rail.y + rail.height <= zoom.y, 'Scrolling menu and zoom controls must not overlap')
            await page.screenshot({ path: path.join(out, `${name}-${label}-unread.png`), scale: 'css' })
            await checkRailScroll(page, context, name, touch && !desktopUA)
            await checkFrame(button, true, true)
          }
          if (touch) {
            // The decorative unread dot must forward taps to the avatar button.
            const dot = await badge.locator('.el-badge__content.is-dot').boundingBox(), target = await button.boundingBox()
            await button.tap({ position: { x: dot.x + dot.width / 2 - target.x, y: dot.y + dot.height / 2 - target.y } })
          } else await button.click()
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
      } catch (error) {
        await page.screenshot({ path: path.join(out, `${name}-${label}-failure.png`), scale: 'css', timeout: 3000 }).catch(() => {})
        throw error
      } finally { await context.close() }
    }
  } finally { await browser.close() }
  return results
}

async function main() {
  const report = {}
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    if (!process.env.AVATAR_QA_ENGINE || process.env.AVATAR_QA_ENGINE === name) report[name] = await run(name, engine)
  }
  assert(Object.values(report).some(results => results.length), 'No matching engine or viewport')
  fs.writeFileSync(path.join(out, 'regression-report.json'), JSON.stringify(report, null, 2))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
