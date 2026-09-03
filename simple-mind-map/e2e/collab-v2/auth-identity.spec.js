const { test, expect } = require('@playwright/test')
const { startStack } = require('./server')
const { openRoom, createRoom } = require('./helpers')

test.describe('acl identity @acl-auth', () => {
  test('e2e-identity sets cookie and /api/auth/me returns the role', async ({
    browser
  }) => {
    const stack = await startStack({ auth: true, collabV2: 1 })
    try {
      const context = await browser.newContext()
      const identityRes = await context.request.post(
        stack.origin + '/api/auth/e2e-identity',
        {
          data: { userId: 'e2e-auth-owner', name: 'AuthOwner' },
          headers: { Accept: 'application/json' }
        }
      )
      const setCookieHeader =
        identityRes.headers()['set-cookie'] ||
        identityRes.headersArray()
          .filter(item => item.name.toLowerCase() === 'set-cookie')
          .map(item => item.value)
          .join('\n')
      expect(identityRes.ok(), await identityRes.text()).toBeTruthy()
      expect(setCookieHeader, 'e2e-identity must Set-Cookie').toMatch(
        /mind_map_session=/
      )
      const identity = await identityRes.json()
      expect(identity.token).toBeTruthy()
      expect(identity.userId).toBe('e2e-auth-owner')

      const cookies = await context.cookies()
      expect(
        cookies.some(item => item.name === 'mind_map_session' && item.value),
        JSON.stringify(cookies)
      ).toBeTruthy()

      const page = await context.newPage()
      await page.goto(stack.origin, { waitUntil: 'domcontentloaded' })
      const me = await page.evaluate(async () => {
        const res = await fetch('/api/auth/me', {
          credentials: 'include',
          headers: { Accept: 'application/json' }
        })
        return { status: res.status, body: await res.json().catch(() => ({})) }
      })
      expect(me.status).toBe(200)
      const user = me.body.user || me.body
      expect(String(user.id || user.userId || '')).toBe('e2e-auth-owner')

      const room = await createRoom(stack.api, {
        prefix: 'auth-me',
        headers: { Cookie: 'mind_map_session=' + identity.token }
      })
      await openRoom(page, stack.origin, room)
      await expect(
        page.locator('[data-testid="cooperate"].cooperating')
      ).toBeVisible({ timeout: 30000 })
      await context.close()
    } finally {
      await stack.close()
    }
  })
})
