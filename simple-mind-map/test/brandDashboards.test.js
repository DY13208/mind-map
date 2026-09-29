const assert = require('assert').strict
const {
  healthSummary,
  normalizeLevel,
  normalizeSourceUrl,
  rowToDashboard,
  safeFileName,
  ensureCharsetMeta
} = require('../bin/brandDashboards')

assert.equal(safeFileName('my board.html', '数据看板.html'), 'my board.html')
assert.equal(safeFileName('a/b\\c:d*e?f"g<h>i|j.html', 'f.html'), 'a_b_c_d_e_f_g_h_i_j.html')
assert.equal(safeFileName('', '数据看板.html'), '数据看板.html')
assert.equal(safeFileName('   ', '数据看板.html'), '数据看板.html')

assert.equal(ensureCharsetMeta(''), '')
assert.equal(
  ensureCharsetMeta('<html><head><meta charset="gbk"></head></html>'),
  '<html><head><meta charset="gbk"></head></html>'
)
assert.equal(
  ensureCharsetMeta('<html><head><title>x</title></head></html>'),
  '<html><head><meta charset="utf-8"><title>x</title></head></html>'
)
assert.equal(
  ensureCharsetMeta('<!DOCTYPE html><html lang="zh-CN"><div>hi</div></html>'),
  '<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8"><div>hi</div></html>'
)
assert.equal(ensureCharsetMeta('<div>hi</div>'), '<meta charset="utf-8"><div>hi</div>')
assert.equal(ensureCharsetMeta('\uFEFF<html><head></head></html>'), '\uFEFF<html><head></head></html>')

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

assert.equal(
  normalizeSourceUrl('https://laundryou-dashboard.app.workbuddy.host/'),
  'https://laundryou-dashboard.app.workbuddy.host/'
)
assert.equal(normalizeSourceUrl('  http://a.b/c.html '), 'http://a.b/c.html')
assert.equal(normalizeSourceUrl('ftp://a.b/c'), '')
assert.equal(normalizeSourceUrl('not a url'), '')
assert.equal(normalizeSourceUrl(''), '')

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
assert.equal(item.sourceType, 'html')
assert.equal(item.sourceUrl, '')
assert.equal(item.canDelete, false)

const ownedRow = {
  id: 'dash-4',
  title: '自建看板',
  level: 'group',
  file_name: '',
  html_content: '',
  owner_id: 'u1',
  created_at: null,
  updated_at: null
}
assert.equal(rowToDashboard(ownedRow, 'u1').canDelete, true)
assert.equal(rowToDashboard(ownedRow, 'u2').canDelete, false)
assert.equal(rowToDashboard(ownedRow).canDelete, false)

const linked = rowToDashboard({
  id: 'dash-3',
  title: '在线看板',
  level: 'group',
  file_name: 'laundryou-dashboard.app.workbuddy.host',
  html_content: '',
  source_type: 'url',
  source_url: 'https://laundryou-dashboard.app.workbuddy.host/',
  created_at: null,
  updated_at: null
})
assert.equal(linked.sourceType, 'url')
assert.equal(linked.sourceUrl, 'https://laundryou-dashboard.app.workbuddy.host/')
assert.equal(linked.fileName, 'laundryou-dashboard.app.workbuddy.host')
assert.equal(linked.healthSummary, '')

const linkedWithSummary = rowToDashboard({
  id: 'dash-5',
  title: '在线看板',
  level: 'department',
  file_name: 'laundryou-dashboard.app.workbuddy.host',
  html_content: '',
  source_type: 'url',
  source_url: 'https://laundryou-dashboard.app.workbuddy.host/',
  health_summary: '品牌健康分：76.3 = 财务分 66 × 60% + 运营分 91.8 × 40%',
  created_at: null,
  updated_at: null
})
assert.equal(
  linkedWithSummary.healthSummary,
  '品牌健康分：76.3 = 财务分 66 × 60% + 运营分 91.8 × 40%'
)
assert.equal(linkedWithSummary.summaryMissing, false)

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
