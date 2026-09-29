const test = require('node:test')
const assert = require('node:assert/strict')

function node(text, parent) {
  const current = {
    parent: parent || null,
    children: [],
    getData(key) {
      if (key === 'text') return text
      return ''
    }
  }
  if (parent) parent.children.push(current)
  return current
}

test('query walks parents then adds the selected node', async () => {
  const { buildWikiFillQuery } = await import(
    '../web/src/utils/wikiNodeFill.js'
  )
  const root = node('中心主题')
  const contract = node('合同', root)
  const live = node('直播推广', contract)
  const fee = node('预付款', live)
  assert.equal(buildWikiFillQuery(fee), '合同的直播推广的预付款')
  assert.equal(buildWikiFillQuery(live), '合同的直播推广')
})

test('markdown content becomes child nodes without invented locators', async () => {
  const { contentToChildren, resultsToChildTrees } = await import(
    '../web/src/utils/wikiNodeFill.js'
  )
  const children = contentToChildren(
    '### 胡可直播业务合同（still0730）\n\n- 甲方：依然电商\n- 预付款：10万\n'
  )
  assert.equal(children.length, 1)
  assert.equal(children[0].data.text, '胡可直播业务合同（still0730）')
  assert.deepEqual(
    children[0].children.map(item => item.data.text),
    ['甲方：依然电商', '预付款：10万']
  )

  const trees = resultsToChildTrees(
    [
      {
        topic: '直播推广',
        section: '预付款',
        content: '- 按销售收入支付',
        source: ['公司模型 / 公司模型']
      }
    ],
    ['按销售收入支付'],
    '合同的直播推广的预付款',
    ['合同', '直播推广', '预付款']
  )
  assert.equal(trees.length, 0)

  const fresh = resultsToChildTrees(
    [
      {
        topic: '直播推广',
        section: '预付款',
        content: '- 按销售收入支付',
        source: ['公司模型 / 公司模型']
      },
      { topic: '宿舍补贴', section: '说明', content: '', source: [] }
    ],
    [],
    '合同的直播推广的预付款',
    ['合同', '直播推广', '预付款']
  )
  assert.deepEqual(
    fresh.map(item => item.data.text),
    ['按销售收入支付']
  )
  assert.equal(fresh[0].children.length, 0)
  assert.equal(JSON.stringify(fresh).includes('第4条'), false)
})

test('section named in the sentence is preferred over sibling sections', async () => {
  const { resultsToChildTrees } = await import('../web/src/utils/wikiNodeFill.js')
  const trees = resultsToChildTrees(
    [
      { topic: '直播推广', section: '合同双方', content: '- 甲方：依然', source: [] },
      { topic: '直播推广', section: '预付款', content: '- 预付款：10万', source: [] },
      { topic: '品牌经销', section: '合同双方', content: '- 经销', source: [] }
    ],
    [],
    '合同的直播推广的预付款'
  )
  assert.deepEqual(
    trees.map(item => item.data.text),
    ['预付款：10万']
  )
})

test('a child of one contract does not pull sibling contracts or other topics', async () => {
  const { resultsToChildTrees } = await import('../web/src/utils/wikiNodeFill.js')
  const huke = [
    '### 胡可直播业务合同（still0730）',
    '- 主播：胡可｜平台：淘宝直播',
    '### 刘虞佳Rena&Biodance 直播合作协议（still0803）',
    '- 主播：刘虞佳Rena'
  ].join('\n')
  const titles = [
    '合同',
    '直播推广',
    '胡可直播业务合同（still0730）',
    '主要内容'
  ]
  const trees = resultsToChildTrees(
    [
      { topic: '品牌经销', section: '主要内容', content: '- 尚无已提取合同。', source: [] },
      { topic: '分销', section: '主要内容', content: '- 尚无已提取合同。', source: [] },
      { topic: '直播推广', section: '主要内容', content: huke, source: [] },
      { topic: '直播推广', section: '合同双方', content: '- 甲方：依然', source: [] }
    ],
    [],
    titles.join('的'),
    titles
  )
  assert.deepEqual(
    trees.map(item => item.data.text),
    ['主播：胡可｜平台：淘宝直播']
  )
  assert.equal(JSON.stringify(trees).includes('刘虞佳'), false)
  assert.equal(JSON.stringify(trees).includes('品牌经销'), false)
  assert.ok(trees.every(item => Array.from(item.data.text).length <= 40))
})

test('胡可直播合同的合同双方 writes that contract only, directly and within 40 chars', async () => {
  const { resultsToChildTrees } = await import('../web/src/utils/wikiNodeFill.js')
  const content = [
    '### 胡可直播业务合同（still0730）',
    '- 甲方：深圳市依然电商科技有限公司（法定代表人：徐健）',
    '- 甲方联系：深圳市南山区艺园路139号唐商科技大厦A座1701｜陈永健｜13266842296｜chenyongjian@stillgroup.net',
    '### 刘虞佳Rena&Biodance 直播合作协议（still0803）',
    '- 甲方：深圳市依然电商科技有限公司（法定代表人：徐健）',
    '- 乙方：杭州轰贝传媒有限责任公司（法定代表人：张金路尹）'
  ].join('\n')
  const titles = ['胡可直播合同', '合同双方']
  const trees = resultsToChildTrees(
    [
      { topic: '品牌经销', section: '合同双方', content: '- 尚无已提取合同。', source: [] },
      { topic: '直播推广', section: '合同双方', content, source: ['公司模型 / 公司模型'] },
      { topic: '直播推广', section: '主要内容', content: '- 主播：胡可', source: [] }
    ],
    [],
    titles.join('的'),
    titles
  )
  assert.deepEqual(
    trees.map(item => item.data.text),
    [
      '甲方：深圳市依然电商科技有限公司（法定代表人：徐健）',
      '甲方联系：深圳市南山区艺园路139号唐商科技大厦A座1701｜陈永健｜13266842296｜chenyongjian@stillgroup.net'
    ]
  )
  assert.equal(JSON.stringify(trees).includes('刘虞佳'), false)
  assert.equal(JSON.stringify(trees).includes('杭州轰贝'), false)
})

test('AI JSON and local rewrite keep contact details labeled', async () => {
  const { compactEvidence, parseAbbreviatedLines } = await import(
    '../web/src/utils/wikiNodeFill.js'
  )
  const rewritten = compactEvidence([
    '甲方联系：深圳市南山区艺园路139号唐商科技大厦A座1701｜陈永健｜13266842296｜chenyongjian@stillgroup.net',
    '合作品牌：laundryou兰濯优（附件二委托书，委托方=甲方）'
  ])
  assert.deepEqual(rewritten, [
    '甲方联系：深圳市南山区艺园路139号唐商科技大厦A座1701',
    '联系人：陈永健',
    '电话：13266842296',
    '邮箱：chenyongjian@stillgroup.net',
    '合作品牌：laundryou兰濯优（附件二委托书，委托方=甲方）'
  ])
  assert.ok(rewritten.every(item => Array.from(item).length <= 40))
  assert.equal(rewritten.some(item => item.endsWith('）') && !item.includes('委托')), false)
  const parsed = parseAbbreviatedLines(
    '好的\n```json\n["甲方：依然电商","法定代表人：徐健","联系人：陈永健"]\n```'
  )
  assert.deepEqual(parsed, ['甲方：依然电商', '法定代表人：徐健', '联系人：陈永健'])
  const term = compactEvidence([
    '关联期限：素材 30 天｜分成结算周期 30 天｜保价 90 天｜发票 60 个工作日内｜逾期通知 5 日/证明 7 日'
  ])
  assert.deepEqual(term, [
    '关联期限：素材 30 天；分成结算周期 30 天；保价 90 天；发票 60 个工作日内；逾期通知 5 日/证明 7 日'
  ])
  const parsedTerms = parseAbbreviatedLines(
    '["关联期限：素材 30 天","关联期限：分成结算周期 30 天","关联期限：保价 90 天","关联期限：发票 60 个工作日内","关联期限：逾期通知 5 日/证明 7 日"]'
  )
  assert.equal(parsedTerms.length, 1)
  assert.match(parsedTerms[0], /^关联期限：/)
  assert.match(parsedTerms[0], /保价 90 天/)
  assert.match(parsedTerms[0], /逾期通知/)
})

test('search writes nothing when the API returns no results', async () => {
  const { searchWikiCompiler, resultsToChildTrees } = await import(
    '../web/src/utils/wikiNodeFill.js'
  )
  const found = await searchWikiCompiler('公司员工宿舍补贴', {
    url: 'http://127.0.0.1:8989/wiki-compiler/api/search'
  })
  assert.equal(found.results.length, 0)
  assert.equal(resultsToChildTrees(found.results, []).length, 0)
})

test('search for 胡可直播合同的合同双方 returns only that contract', async () => {
  const { searchWikiCompiler, resultsToChildTrees } = await import(
    '../web/src/utils/wikiNodeFill.js'
  )
  const titles = ['胡可直播合同', '合同双方']
  const found = await searchWikiCompiler(titles.join('的'), {
    url: 'http://127.0.0.1:8989/wiki-compiler/api/search',
    top_k: 8
  })
  const trees = resultsToChildTrees(found.results, [], titles.join('的'), titles)
  assert.ok(trees.length > 0)
  assert.ok(trees.some(item => item.data.text.startsWith('甲方：')))
  assert.equal(JSON.stringify(trees).includes('刘虞佳'), false)
  assert.equal(JSON.stringify(trees).includes('杭州轰贝'), false)
  assert.equal(JSON.stringify(trees).includes('直播推广：'), false)
})
