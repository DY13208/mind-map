const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

// 直接加载生产插件，仅替换浏览器依赖的导入，避免复制待测方法。
const source = fs
  .readFileSync(path.join(__dirname, '../src/plugins/Export.js'), 'utf8')
  .replace(/^import[\s\S]*?from ['"][^'"]+['"]\r?\n/gm, '')
  .replace('export default Export', 'module.exports = Export')

function createExport(themeConfig, imgToDataUrl) {
  const module = { exports: {} }
  vm.runInNewContext(source, { module, imgToDataUrl }, { filename: 'Export.js' })
  return new module.exports({ mindMap: { themeConfig } })
}

async function settles(promise) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('background export timed out')), 1000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

;(async () => {
  for (const backgroundImage of [undefined, 'none']) {
    const calls = []
    const plugin = createExport({ backgroundImage }, () => {
      throw new Error('no background image should be loaded')
    })
    const result = await settles(plugin.drawBackgroundToSvg({
      css: (...args) => calls.push(args)
    }))
    assert.strictEqual(result, undefined)
    assert.deepStrictEqual(calls, [['background-color', '#fff']])
  }

  const calls = []
  const imageUrl = 'https://example.test/background.png'
  const plugin = createExport({
    backgroundColor: '#123456',
    backgroundImage: imageUrl,
    backgroundRepeat: 'no-repeat'
  }, async url => {
    assert.strictEqual(url, imageUrl)
    return 'data:image/png;base64,test'
  })
  const result = await settles(plugin.drawBackgroundToSvg({
    css: (...args) => calls.push(args)
  }))
  assert.strictEqual(result, undefined)
  assert.deepStrictEqual(calls, [
    ['background-color', '#123456'],
    ['background-image', 'url(data:image/png;base64,test)'],
    ['background-repeat', 'no-repeat']
  ])

  const loadError = new Error('image conversion failed')
  const failingPlugin = createExport({ backgroundImage: imageUrl }, async () => {
    throw loadError
  })
  await assert.rejects(
    settles(failingPlugin.drawBackgroundToSvg({ css() {} })),
    error => error === loadError
  )

  const styleError = new Error('SVG style failed')
  await assert.rejects(
    settles(createExport({}, () => {}).drawBackgroundToSvg({
      css() { throw styleError }
    })),
    error => error === styleError
  )
  console.log('exportBackground.test.js passed')
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
