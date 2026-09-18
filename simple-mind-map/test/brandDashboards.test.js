const assert = require('assert').strict
const {
  healthSummary,
  normalizeLevel,
  rowToDashboard
} = require('../bin/brandDashboards')

assert.equal(
  healthSummary(
    '<div>品牌健康分： <b>68</b> = 财务分 40 × 70% + 运营分 100 × 40%</div>'
  ),
  '品牌健康分：68 = 财务分 40 × 70% + 运营分 100 × 40%'
)
assert.equal(healthSummary('没有对应公式'), '')

assert.equal(normalizeLevel('group'), 'group')
assert.equal(normalizeLevel('department'), 'department')
assert.equal(normalizeLevel('project'), 'project')
assert.equal(normalizeLevel('bogus'), 'group')
assert.equal(normalizeLevel(''), 'group')

const item = rowToDashboard({
  id: 'dash-1',
  title: 'FULLY项目',
  level: 'department',
  file_name: 'board.html',
  html_content: '品牌健康分：68 = 财务分 40 × 70% + 运营分 100 × 40%',
  created_at: new Date('2026-09-18T00:00:00.000Z'),
  updated_at: new Date('2026-09-18T00:00:00.000Z')
})
assert.equal(item.id, 'dash-1')
assert.equal(item.title, 'FULLY项目')
assert.equal(item.level, 'department')
assert.equal(item.status, 'ready')
assert.equal(
  item.healthSummary,
  '品牌健康分：68 = 财务分 40 × 70% + 运营分 100 × 40%'
)
assert.equal(item.summaryMissing, false)
assert.equal(item.updatedAt, '2026-09-18T00:00:00.000Z')

const bare = rowToDashboard({
  id: 'dash-2',
  title: '',
  level: 'weird',
  file_name: '',
  html_content: '<p>暂无公式</p>',
  created_at: null,
  updated_at: null
})
assert.equal(bare.title, '未命名看板')
assert.equal(bare.level, 'group')
assert.equal(bare.fileName, '数据看板.html')
assert.equal(bare.summaryMissing, true)
assert.equal(bare.updatedAt, null)

console.log('brand dashboard tests passed')
