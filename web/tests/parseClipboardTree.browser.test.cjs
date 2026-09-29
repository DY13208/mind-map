const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const { chromium } = require('../../simple-mind-map/node_modules/playwright')

async function main() {
  const source = fs
    .readFileSync(path.join(__dirname, '../src/utils/parseClipboardTree.js'), 'utf8')
    .replace(/export const /g, 'const ')
  const handlerSource = fs
    .readFileSync(path.join(__dirname, '../src/utils/handleClipboardText.js'), 'utf8')
    .replace(/^import .*\r?\n/gm, '')
    .replace('export default handleClipboardText', 'return handleClipboardText')
  const systemChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  const browser = await chromium.launch({
    headless: true,
    ...(fs.existsSync(systemChrome) ? { executablePath: systemChrome } : {})
  })
  try {
    const page = await browser.newPage()
    const result = await page.evaluate(async ({ source, handlerSource }) => {
      const parse = new Function(
        `${source}; return { parseClipboardToNodes, parseIndentedOutline }`
      )()
      const text =
        '龙岗WB项目流程图\n\t客户联系依然\n\t\t确认软件版本\n\t\t补足报价信息\n\t审核客户资质'
      const html =
        '<ul><li>龙岗WB项目流程图<ul>' +
        '<li>客户联系依然<ul>' +
        '<li>确认软件版本<br>补足报价信息</li>' +
        '<li>长链接 https://doc.weixin.qq.com/doc/example?code=abc</li>' +
        '</ul></li><li>审核客户资质</li></ul></li></ul>'
      const handleClipboardText = new Function(
        'parseClipboardToNodes', 'imgToDataUrl', handlerSource
      )(parse.parseClipboardToNodes, async () => '')
      return {
        wecom: parse.parseClipboardToNodes(text, html),
        opmlFromHtml: parse.parseClipboardToNodes(
          '根节点\n  误拆的续行\n  又一续行',
          '<opml><body><outline text="根节点"><outline text="真实子节点"/></outline></body></opml>'
        ),
        tabOutline: parse.parseClipboardToNodes('根节点\n\t子节点\n\t同级节点'),
        markedOutline: parse.parseClipboardToNodes('- 根节点\n  - 子节点\n  - 同级节点'),
        ambiguous: parse.parseClipboardToNodes('根节点\n  节点内续行'),
        plain: parse.parseClipboardToNodes('第一行\n第二行'),
        htmlOnly: parse.parseClipboardToNodes('', '<ul><li>节点一</li><li>节点二</li></ul>'),
        internalCopy: await handleClipboardText(JSON.stringify({
          simpleMindMap: true,
          data: [{ data: { text: '已复制节点' }, children: [] }]
        }))
      }
    }, { source, handlerSource })

    assert.equal(result.wecom.length, 1)
    assert.equal(result.wecom[0].children.length, 2)
    assert.equal(result.wecom[0].children[0].children.length, 2)
    assert.equal(
      result.wecom[0].children[0].children[0].data.text,
      '确认软件版本\n补足报价信息'
    )
    assert.match(result.wecom[0].children[0].children[1].data.text, /doc\.weixin\.qq\.com/)
    assert.equal(result.opmlFromHtml[0].children[0].data.text, '真实子节点')
    assert.deepEqual(result.tabOutline[0].children.map(node => node.data.text), [
      '子节点', '同级节点'
    ])
    assert.deepEqual(result.markedOutline[0].children.map(node => node.data.text), [
      '子节点', '同级节点'
    ])
    assert.deepEqual(result.ambiguous, [])
    assert.deepEqual(result.plain, [])
    assert.equal(result.htmlOnly.length, 2)
    assert.equal(result.internalCopy, '')
  } finally {
    await browser.close()
  }
  console.log('clipboard tree browser tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
