const { test, expect } = require('./fixtures')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  clickToolbar,
  pressOnCanvas,
  waitForText,
  waitForNoText,
  createRoom,
  openRoom,
  readRuntime
} = require('./helpers')

function writeTemp(name, contents) {
  const file = path.join(os.tmpdir(), name)
  fs.writeFileSync(file, contents)
  return file
}

test.describe('import undo', () => {
  test('markdown import is map.replace and undo restores @smoke', async ({ pair }) => {
    const { pageA, pageB } = pair
    await clickToolbar(pageA, '导入')
    await expect(pageA.locator('.nodeImportDialog')).toBeVisible()
    const file = writeTemp(
      'e2e-import.json',
      JSON.stringify({
        root: {
          data: { text: 'ImportedRoot' },
          children: [
            { data: { text: 'ImpA' }, children: [] },
            { data: { text: 'ImpB' }, children: [] }
          ]
        }
      })
    )
    await pageA.locator('.nodeImportDialog input[type="file"]').setInputFiles(file)
    await expect(pageA.locator('.nodeImportDialog .el-upload-list')).toContainText(
      'e2e-import.json'
    )
    await pageA.locator('.nodeImportDialog').getByRole('button', { name: '确定' }).click()
    await waitForText(pageB, 'ImportedRoot', 30000)
    await waitForText(pageB, 'ImpA')
    const ops = await pageA.evaluate(async roomKey => {
      const res = await fetch(
        '/api/collab-v2/ops?roomKey=' + encodeURIComponent(roomKey) + '&afterRevision=0'
      )
      return res.json()
    }, pair.room)
    expect((ops.operations || []).some(item => item.type === 'map.replace')).toBeTruthy()
    await pressOnCanvas(pageA, 'Control+z')
    await waitForNoText(pageB, 'ImportedRoot', 20000)
    await waitForText(pageB, 'Alpha')
  })

  test('json import 1k nodes @bench', async ({ browser }) => {
    test.setTimeout(300000)
    const runtime = readRuntime()
    const room = await createRoom(runtime.api, { prefix: 'imp1k' })
    const children = []
    for (let i = 0; i < 1000; i++) {
      children.push({ data: { text: 'Imp-' + i }, children: [] })
    }
    const file = writeTemp(
      'e2e-import-1k.json',
      JSON.stringify({ root: { data: { text: 'BigImport' }, children } })
    )
    const context = await browser.newContext()
    const page = await context.newPage()
    await openRoom(page, runtime.origin, room)
    await clickToolbar(page, '导入')
    await page.locator('.nodeImportDialog input[type="file"]').setInputFiles(file)
    const started = Date.now()
    await page.locator('.nodeImportDialog').getByRole('button', { name: '确定' }).click()
    await waitForText(page, 'BigImport', 120000)
    const duration = Date.now() - started
    expect(duration).toBeLessThan(120000)
    await context.close()
  })
})
