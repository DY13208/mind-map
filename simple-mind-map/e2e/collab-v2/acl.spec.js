const { test, expect } = require('@playwright/test')
const { startStack } = require('./server')
const {
  apiJson,
  createRoom,
  openRoom,
  attachConsole,
  assertCleanConsole,
  setCookie,
  createIdentity,
  clickNode,
  pressOnCanvas,
  finishEdit,
  waitForText
} = require('./helpers')

test.describe('viewer editor acl', () => {
  test('owner editor viewer unauthorized and live demote @smoke', async ({
    browser
  }) => {
    const stack = await startStack({ auth: true, collabV2: 1 })
    try {
      const owner = await createIdentity(stack.api, {
        userId: 'e2e-owner',
        name: 'Owner'
      })
      const editor = await createIdentity(stack.api, {
        userId: 'e2e-editor',
        name: 'Editor'
      })
      const viewer = await createIdentity(stack.api, {
        userId: 'e2e-viewer',
        name: 'Viewer'
      })
      const ownerHeaders = { Cookie: 'mind_map_session=' + owner.token }
      const room = await createRoom(stack.api, {
        prefix: 'acl',
        headers: ownerHeaders
      })
      await apiJson(stack.api + '/api/files/' + room + '/members', {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ user_id: editor.userId, role: 'editor' })
      })
      await apiJson(stack.api + '/api/files/' + room + '/members', {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ user_id: viewer.userId, role: 'viewer' })
      })

      const ctxOwner = await browser.newContext()
      const ctxEditor = await browser.newContext()
      const ctxViewer = await browser.newContext()
      const ctxAnon = await browser.newContext()
      await setCookie(ctxOwner, stack.origin, owner.token)
      await setCookie(ctxEditor, stack.origin, editor.token)
      await setCookie(ctxViewer, stack.origin, viewer.token)
      const pageOwner = await ctxOwner.newPage()
      const pageEditor = await ctxEditor.newPage()
      const pageViewer = await ctxViewer.newPage()
      const pageAnon = await ctxAnon.newPage()
      const errors = []
      for (const page of [pageOwner, pageEditor, pageViewer]) {
        errors.push(...(await attachConsole(page)))
      }

      await openRoom(pageOwner, stack.origin, room)
      await openRoom(pageEditor, stack.origin, room)
      await openRoom(pageViewer, stack.origin, room)
      await pageAnon.goto(stack.origin + '/#/?room=' + encodeURIComponent(room), {
        waitUntil: 'domcontentloaded'
      })
      await expect(
        pageAnon.getByText(/没有权限|请先使用企业微信|登录|扫码/)
      ).toBeVisible({ timeout: 25000 })

      await clickNode(pageEditor, 'Alpha')
      await pressOnCanvas(pageEditor, 'Enter')
      await finishEdit(pageEditor)
      await waitForText(pageViewer, '二级节点')

      await clickNode(pageViewer, 'Alpha')
      await pressOnCanvas(pageViewer, 'Enter')
      await pressOnCanvas(pageViewer, 'Tab')
      await pressOnCanvas(pageViewer, 'Delete')
      await pressOnCanvas(pageViewer, 'Control+v')
      await pageViewer.waitForTimeout(600)
      await expect(pageViewer.locator('.toolbarBtn').filter({ hasText: '同级节点' })).toHaveCount(0)

      const forbidden = await pageViewer.evaluate(async roomKey => {
        const res = await fetch('/api/collab-v2/op', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            opId: crypto.randomUUID(),
            roomKey,
            type: 'node.insert',
            payload: { parentUid: 'root', text: 'HACK' }
          })
        })
        return { status: res.status, body: await res.json().catch(() => ({})) }
      }, room)
      expect(forbidden.status === 403 || forbidden.body.code === 'FORBIDDEN').toBeTruthy()

      await apiJson(stack.api + '/api/files/' + room + '/members/' + editor.userId, {
        method: 'PATCH',
        headers: ownerHeaders,
        body: JSON.stringify({ role: 'viewer' })
      })
      await clickNode(pageEditor, 'Alpha')
      await pressOnCanvas(pageEditor, 'Enter')
      await pageEditor.waitForTimeout(800)
      await expect(pageEditor.getByText(/只读|权限已变为只读/)).toBeVisible({
        timeout: 15000
      })
      const after = await pageEditor.evaluate(() => {
        const app = document.querySelector('#app')
        return app && app.__vue__ && app.__vue__.$store
          ? app.__vue__.$store.state.isReadonly
          : null
      })
      expect(after).toBeTruthy()
      assertCleanConsole(errors)
      await ctxOwner.close()
      await ctxEditor.close()
      await ctxViewer.close()
      await ctxAnon.close()
    } finally {
      await stack.close()
    }
  })
})
