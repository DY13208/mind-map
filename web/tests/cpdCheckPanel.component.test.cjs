const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const babel = require('@babel/core')
const vueCompiler = require('vue-template-compiler')

const calls = { create: 0, list: 0, get: 0, confirm: 0, review: 0, source: 0, retry: 0 }
const payloads = { create: null, review: null, retry: null }
let holdSourceRead = false
let releaseSourceRead = null
let failHistoryRead = false
const dependencies = {
  '@/utils/fileApi': {
    createCpdCheckRun: async (_room, body) => {
      calls.create += 1
      payloads.create = body
      return { run: { id: 'new-run', nodeUid: body.nodeUid, status: 'pending', report: { mode: body.mode } } }
    },
    listCpdCheckRuns: async () => {
      calls.list += 1
      if (failHistoryRead) throw new Error('模拟读取历史失败')
      return { runs: [{ id: 'old-run', nodeUid: 'node-1', status: 'passed' }] }
    },
    getCpdCheckRun: async (_room, id) => {
      calls.get += 1
      if (failHistoryRead) throw new Error('模拟读取报告失败')
      return { run: { id, nodeUid: 'node-1', status: 'passed', report: { findings: [] } } }
    },
    confirmCpdCheckCandidate: async () => {
      calls.confirm += 1
      return { run: { id: 'old-run', nodeUid: 'node-1', status: 'passed', report: { findings: [] } } }
    },
    submitCpdCheckReview: async (_room, id, body) => {
      calls.review += 1
      payloads.review = body
      return { run: { id, nodeUid: 'node-1', status: 'passed', report: { mode: 'business', revision: body.expectedRevision + 1, findings: [] } } }
    },
    getCpdCheckSource: async () => {
      calls.source += 1
      if (holdSourceRead) await new Promise(resolve => { releaseSourceRead = resolve })
      return { ok: true, source: { title: 'Wiki 正文', path: '销售 / 会员 / 复购', content: '实际完整原文', complete: true, status: 'ready', changed: false, provenance: { origin: 'business' } } }
    },
    retryCpdCheckSource: async (_room, id, _sourceId, body) => {
      calls.retry += 1
      payloads.retry = body
      return { run: { id, nodeUid: 'node-1', status: 'pending', report: { mode: 'business', revision: body.expectedRevision + 1, findings: [] } } }
    }
  }
}

function loadComponent() {
  const filename = path.resolve(__dirname, '../src/pages/Edit/components/CPDCheckPanel.vue')
  const parsed = vueCompiler.parseComponent(fs.readFileSync(filename, 'utf8'))
  const template = vueCompiler.compile(parsed.template.content)
  assert.deepEqual(template.errors, [], 'CPDCheckPanel template should compile')
  const { code } = babel.transformSync(parsed.script.content, {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  })
  const moduleRef = { exports: {} }
  new Function('require', 'module', 'exports', code)(
    request => {
      if (!dependencies[request]) throw new Error(`Unmocked dependency: ${request}`)
      return dependencies[request]
    },
    moduleRef,
    moduleRef.exports
  )
  return { component: moduleRef.exports.default, template: parsed.template.content }
}

function makeContext(component, values = {}) {
  const ctx = {
    ...component.data(),
    roomKey: 'room-1',
    nodeUid: 'node-1',
    nodeTitle: '选中节点',
    readonly: false,
    $emit(event, value) { this.emitted = [event, value] },
    ...values
  }
  Object.assign(ctx, component.methods)
  Object.keys(component.computed).forEach(key => {
    Object.defineProperty(ctx, key, {
      configurable: true,
      get() {
        return component.computed[key].call(ctx)
      }
    })
  })
  return ctx
}

async function main() {
  const { component, template } = loadComponent()
  const toolbar = fs.readFileSync(path.resolve(__dirname, '../src/pages/Edit/components/Toolbar.vue'), 'utf8')
  assert.match(template, /data-testid="cpd-check-panel"/)
  assert.doesNotMatch(template, /补齐缺项|确认写入并复检|apply-supplement/)
  assert.match(template, /data-testid="cpd-check-scope"/)
  assert.doesNotMatch(template, /cpd-semantic-service|模型辅助判断|语义服务/)
  assert.match(template, /label="问题与依据"/)
  assert.match(template, /label="参考资料"/)
  assert.match(template, /label="检查历史"/)
  assert.ok(template.indexOf('待确认的流程候选') < template.indexOf('统计 <small>各分类互斥'), '流程候选先于问题统计呈现')
  assert.doesNotMatch(template, /检查模式|<el-option[^>]*演示检查|定位节点|UID\s*:/, '正式检查界面不展示模式选择、定位按钮或节点 UID')
  assert.doesNotMatch(toolbar, /@locate-node|locateCpdCheckNode/, '工具栏不再接收检查面板的定位事件')
  assert.match(template, /演示结果，不能用于正式通过/)
  assert.match(template, /按正式检查执行，已标记的演示资料不会作为正式依据/)
  assert.match(template, /勾选表示已阅读原文，不代表通过；请阅读全部依据后作出判断。核对通过仅处理本项；判定未通过会记录该项问题，需修改后重新检查。/)
  assert.match(template, /placeholder="填写判断理由（必填）"/)
  assert.match(template, />核对通过<\/el-button>/)
  assert.match(template, />判定未通过<\/el-button>/)
  assert.match(template, />撤销核对<\/el-button>/)
  const scoped = makeContext(component, { run: { report: { chain: {
    nodeUids: ['c', 'ancestorP', 'p', 'owner', 'd', 'detail'],
    auditNodeUids: ['c', 'p', 'owner', 'd', 'detail'], contextNodeUids: ['ancestorP'],
    checkRootUids: ['c'], planRootUids: ['p'], executionUids: ['d'],
    check: [{ uid: 'c', text: 'C：项目利润' }],
    plan: [{ uid: 'p', text: 'P：客服运营' }],
    execution: [{ uid: 'd', text: 'D：客服绩效管理' }]
  } } } })
  assert.match(scoped.scopeSummary, /相关 C：项目利润.*相关 P：客服运营.*D：客服绩效管理/)
  assert.match(scoped.scopeSummary, /检查 5 个节点，祖先上下文 1 个节点/)
  const uidOnlyCoverage = makeContext(component, {
    nodeUid: 'target-node',
    run: { report: {
      chain: { nodeUids: ['target-node', 'covered-node'], auditNodeUids: ['target-node', 'covered-node'] },
      coverage: { checkedNodes: ['covered-node', { nodeUid: 'target-node' }, { name: '可读节点名' }], checkedLocations: ['target-node'] }
    } }
  })
  assert.match(uidOnlyCoverage.scopeSummary, /可读节点名/)
  assert.doesNotMatch(uidOnlyCoverage.scopeSummary, /target-node|covered-node/)

  const readableReport = makeContext(component, { run: { report: {
    chain: {
      nodes: [
        { uid: 'd-1', text: 'D：客服绩效管理' },
        { uid: 'p-1', text: 'P：客服运营' }
      ]
    },
    findings: [{ ruleId: 'CK-09', title: 'D 五要素齐全', nodeUid: 'd-1', status: 'needs_supplement', message: 'D 节点缺少产物。' }]
  } } })
  const wikiNoMatch = makeContext(component, { run: { report: { sourceStatuses: [
    { scope: 'wiki', status: 'no_results', matchReason: '未找到与当前业务相关的 Wiki SOP。' }
  ] } } })
  assert.equal(wikiNoMatch.wikiNoMatchReason, '未找到与当前业务相关的 Wiki SOP。')
  assert.equal(makeContext(component, { run: { report: { sourceStatuses: [{ scope: 'wiki', status: 'unavailable' }] } } }).wikiNoMatchReason, '', '服务不可用不能误报为无相关结果')
  assert.match(template, /cpd-wiki-no-match/)
  assert.equal(readableReport.findingRule(readableReport.findings[0]), 'D 五要素齐全')
  assert.equal(readableReport.findingRule({ ruleId: 'CK-10' }), '检查项名称未提供', 'missing titles should not fall back to rule IDs')
  assert.equal(readableReport.findingRule({ ruleId: 'CK-10', title: 'CK-10' }), '检查项名称未提供', 'identifier-only titles should use the honest fallback')
  assert.equal(readableReport.findingRule({ ruleId: 'CK-10', title: 'CK-10 产物完整' }), '产物完整', 'strip identifiers embedded in a human-readable title')
  assert.equal(readableReport.findingNextStep({ ruleId: 'CK-04', title: '结构待修正', status: 'failed', issue: '检查项尚未对应' }),
    '修正 CPD 结构或对应关系后重新检查', 'rule-ID-based guidance should remain active after IDs are hidden from titles')
  assert.equal(readableReport.findingNodeTitle(readableReport.findings[0]), '客服绩效管理')
  assert.equal(readableReport.findingNodeUid(readableReport.findings[0]), 'd-1')
  assert.doesNotMatch(template, /CK(?:-\d+| 编号)/i, 'the visible statistics note should not expose rule IDs')
  assert.equal(readableReport.findingIssue(readableReport.findings[0]), 'D 节点缺少产物。')
  assert.notEqual(
    readableReport.findingKey({ ruleId: 'CK-07', nodeUid: 'node-a' }, 0),
    readableReport.findingKey({ ruleId: 'CK-07', nodeUid: 'node-b' }, 1),
    'same rule findings on different nodes need distinct render keys'
  )

  const oldReport = makeContext(component, { run: { report: {
    chain: { check: [{ uid: 'c-old', text: 'C：客户复购' }] },
    findings: [{ rule_id: 'CK-12', title: 'C 目标可追溯', node_uid: 'c-old' }]
  } } })
  assert.equal(oldReport.findingRule(oldReport.findings[0]), 'C 目标可追溯', 'older findings with title metadata remain readable')
  assert.equal(oldReport.findingNodeTitle(oldReport.findings[0]), '客户复购', 'legacy check arrays provide node titles')
  const impactReport = makeContext(component, { run: { report: { findings: [
    { ruleId: 'CK-10', title: '项目资料完整' },
    { ruleId: 'CK-11' }
  ] } } })
  const sourceImpact = impactReport.sourceErrorImpact({ relatedRuleIds: ['CK-10', 'CK-11', 'CK-99'] })
  assert.equal(sourceImpact, '项目资料完整、检查项名称未提供', 'source impact should show names and deduplicate honest fallbacks')
  assert.doesNotMatch(sourceImpact, /CK-\d+/)
  assert.equal(Object.hasOwn(component.computed, 'semanticServiceWarning'), false)
  const sourceReport = makeContext(component, { run: { report: {
    sources: [
      { title: '客服绩效', path: '运营 / 客服 / 绩效', version: '1', contentHash: 'same', sourceRef: { type: 'map_node', nodeUid: 'd1' } },
      { title: '客服绩效', path: '运营 / 客服 / 绩效', version: '1', contentHash: 'same', sourceRef: { type: 'map_node', nodeUid: 'd1', query: '责任人' } },
      { title: '客服绩效旧版', path: '运营 / 客服 / 绩效', version: '0', contentHash: 'old', sourceRef: { type: 'map_node', nodeUid: 'd1' } }
    ],
    sourceStatuses: [
      { scope: 'map_knowledge', status: 'ok' }, { scope: 'map_knowledge', status: 'ok' },
      { scope: 'chain', status: 'ready', candidateId: 'source-1', operation: 'read' },
      { scope: 'wiki', status: 'no_results' }
    ],
    findings: [
      { ruleId: 'CK-09', nodeUid: 'd1', field: 'owner', status: 'needs_supplement' },
      { ruleId: 'CK-32', nodeUid: 'd1', status: 'needs_supplement', message: '缺少：责任人、频率' }
    ]
  } } })
  assert.equal(sourceReport.sources.length, 2, '相同来源版本去重，不同版本保留')
  assert.equal(sourceReport.sourcePath(sourceReport.sources[0]), '运营 / 客服 / 绩效')
  assert.equal(sourceReport.searchStatuses.find(item => item.scope === 'map_knowledge').count, 2)
  assert.equal(sourceReport.searchStatuses.find(item => item.scope === 'chain').count, 0)
  assert.equal(sourceReport.searchStatuses.find(item => item.scope === 'chain').readCount, 1)
  assert.equal(sourceReport.searchStatuses.find(item => item.scope === 'chain').title, '本链路材料')
  assert.equal(sourceReport.wikiStatus, '无结果')
  assert.equal(sourceReport.missingSummaries.length, 1)
  assert.equal(sourceReport.findingGroups.reduce((count, group) => count + group.items.length, 0), 1, '缺项汇总不重复呈现原检查项')
  assert.equal(sourceReport.sourcePath({}), '', '空路径不重复显示无意义占位文本')
  const groupedSources = makeContext(component, { run: { id: 'source-groups', selection: {
    sourceRef: { type: 'wiki_compiler', roomId: 'room-1', topic: '选中主题', section: '标准' }
  }, report: {
    findings: [{ ruleId: 'CK-09', nodeUid: 'n1', status: 'needs_supplement', field: 'owner', evidenceEntries: [{ id: 'e1', sourceId: 'evidenced-source', sourceRef: { type: 'wiki_compiler', roomId: 'room-1', topic: '证据主题', section: '责任人' }, quote: '项目证据原文' }] }],
    sources: [
      { sourceId: 'chain-source', sourceRole: 'current_chain', title: '本链材料', path: 'branches/123e4567-e89b-12d3-a456-426614174000.md', complete: true, status: 'ready', sourceRef: { type: 'chain_node', nodeUid: 'n1' } },
      { sourceId: 'evidenced-source', title: '已引用知识库', path: '知识库 / 项目 / 责任人', complete: true, status: 'ready', sourceRef: { type: 'wiki_compiler', roomId: 'room-1', topic: '证据主题', section: '责任人' } },
      { sourceId: 'selected-source', title: '已选参考', path: 'Wiki / 选中主题 / 标准', complete: true, status: 'ready', sourceRef: { type: 'wiki_compiler', roomId: 'room-1', topic: '选中主题', section: '标准' } },
      { sourceId: 'candidate-source', title: '候选参考', path: 'Wiki / 其他主题 / 资料', status: 'ready', sourceRef: { type: 'wiki_compiler', roomId: 'room-1', topic: '其他主题', section: '资料' } },
      { sourceId: 'partial-source', title: '未完整来源', path: 'branches/89abcdef0123456789abcdef01234567.md', complete: false, status: 'incomplete', sourceRef: { type: 'canonical', path: 'branches/89abcdef0123456789abcdef01234567.md' } }
    ]
  } } })
  assert.deepEqual(groupedSources.sourceGroups.map(group => [group.key, group.sources.map(source => source.sourceId)]), [
    ['used', ['chain-source', 'evidenced-source', 'selected-source']],
    ['unused', ['candidate-source', 'partial-source']]
  ], '本链依据、引用证据和已选流程默认归入已采用依据，其余折叠为候选')
  assert.deepEqual(groupedSources.sourceGroups.map(group => group.title), ['已采用依据', '未采用候选'])
  assert.equal(groupedSources.sourceGroups[0].collapsed, false)
  assert.equal(groupedSources.sourceGroups[1].collapsed, true)
  assert.equal(groupedSources.sourceUsageLabel(groupedSources.sources[0]), '本链依据')
  assert.equal(groupedSources.sourceUsageLabel(groupedSources.sources[1]), '外部参考')
  assert.equal(groupedSources.sourceUsageLabel(groupedSources.sources[3]), '未采用候选')
  assert.equal(groupedSources.sourceDisplayStatus(groupedSources.sources[0]), '完整全文')
  assert.equal(groupedSources.sourceDisplayStatus(groupedSources.sources[1]), '待确认适用')
  assert.equal(groupedSources.sourceDisplayStatus(groupedSources.sources[2]), '已采用')
  assert.equal(groupedSources.sourceDisplayStatus(groupedSources.sources[4]), '未读完整')
  assert.equal(groupedSources.sourceDisplayStatus({ ...groupedSources.sources[2], status: 'parse_failed', complete: false }), '未读完整', '已选来源读取失败时仍标记未读完整')
  assert.equal(groupedSources.isTechnicalSourcePath(groupedSources.sourcePath(groupedSources.sources[0])), true)
  assert.equal(groupedSources.isTechnicalSourcePath('业务资料 / 客服绩效 / 月度考核'), false, '业务路径保留在来源卡')
  assert.match(template, /检查来源/)
  assert.match(template, /sourceUsageLabel\(source\)/)
  assert.match(template, /sourceDisplayStatus\(source\)/)
  const referenceReport = makeContext(component, { run: { report: {
    referenceComparison: { note: '仅作参考', fields: [
      { field: 'frequency', currentValues: [{ value: '每月' }], referenceValues: ['每周'], comparison: 'different' },
      { field: 'owner', currentValues: [], referenceValues: [], comparison: 'not_available' }
    ] }
  } } })
  assert.match(template, /data-testid="cpd-reference-fields"/)
  assert.deepEqual(referenceReport.referenceFields.map(item => [item.label, item.current, item.reference, item.state]), [
    ['频率', '每月', '每周', '字段值不同'], ['责任人', '未明确', '未明确', '两侧均未明确']
  ])

  const ctx = makeContext(component, {
    run: {
      id: 'run-1',
      status: 'needs_confirmation',
      report: {
        summary: { passed: false, blockers: 2, needsSupplement: 3, warnings: 1, notApplicable: 5 },
        findings: [
          { ruleId: 'CK-1', status: 'needs_info', severity: 'blocker', issue: '缺少关键依据' },
          { ruleId: 'CK-2', status: 'needs_supplement', field: 'owner', issue: '待补责任人' },
          { ruleId: 'CK-3', status: 'unknown', issue: '需要人工判断' },
          { ruleId: 'CK-4', status: 'passed', issue: '已核验' },
          { ruleId: 'CK-5', status: 'not_applicable', issue: '非当前阶段' }
        ],
        flowCandidates: [
          {
            candidateId: 'flow-1',
            kind: 'flow',
            title: '候选流程',
            path: [{ uid: 'c-1', text: '检查' }, { uid: 'p-1', text: '计划' }],
            source: 'canonical',
            reason: '业务目标相近',
            cpd: { c: '异常识别', p: '处置计划', d: '逐项执行' }
          }
        ],
        materialCandidates: [{ candidateId: 'material-1', kind: 'material', title: '引用材料' }],
        candidates: [
          { candidateId: 'unknown-1', kind: 'other', title: '未分类' },
          { candidateId: 'flow-1', kind: 'flow', title: '重复流程候选' }
        ],
        sources: [{ title: '已读来源', sourceRef: { type: 'canonical', path: 'sop/check.md' }, status: 'ok' }]
      }
    }
  })

  assert.deepEqual(ctx.findingGroups.map(group => [group.key, group.items.length]), [
    ['missing', 2],
    ['hint', 1]
  ])
  assert.equal(ctx.verifiedFindings.length, 1)
  assert.equal(ctx.notApplicableFindings.length, 1)
  assert.equal(ctx.candidates.length, 1, 'only process candidates may be confirmed')
  assert.equal(ctx.materialCandidates.length, 1, 'material candidates remain references, not flow confirms')
  assert.equal(ctx.unclassifiedCandidates.length, 1)
  assert.match(ctx.overviewText, /阻断 2 · 待补齐 3 · 提示 1 · 本阶段不适用 5/)
  assert.equal(
    ctx.candidatePath(ctx.candidates[0]),
    '检查 / 计划',
    'when a readable path exists, show only the path'
  )
  const screenshotCandidate = {
    source: 'wiki',
    sourceId: 'source-0e327a1b',
    pathText: 'Wiki / 会员运营SOP / C：会员成交与利润目标',
    sourceRef: {
      type: 'wiki_compiler',
      topic: '会员运营SOP',
      section: 'C：会员成交与利润目标',
      sourceId: 'source-0e327a1b'
    }
  }
  assert.equal(
    ctx.candidatePath(screenshotCandidate),
    'Wiki / 会员运营SOP / C：会员成交与利润目标',
    'use the readable path without repeating the topic, category, or sourceId'
  )
  assert.equal(ctx.candidatePath({
    source: { type: 'map_knowledge', pathText: '脑图资料 / 运维规范', sourceId: 'source-map' },
    sourceRef: { type: 'map_node', uid: 'node-secret' }
  }), '脑图资料 / 运维规范', 'nested source objects should supply a readable path')
  assert.equal(ctx.candidatePath({
    source: 'canonical',
    sourceRef: { type: 'canonical', path: 'branches/89abcdef0123456789abcdef01234567.md', title: '项目质量手册' }
  }), '项目质量手册', 'hide technical paths and fall back to a sourceRef title')
  assert.equal(ctx.candidatePath({
    source: 'wiki',
    sourceRef: { type: 'wiki_compiler', topic: '会员运营SOP', section: '责任人' }
  }), '会员运营SOP / 责任人', 'use a readable sourceRef topic and section when a path is absent')
  assert.equal(ctx.candidatePath({
    source: 'chain',
    sourceId: 'source-attachment-secret',
    sourceRef: { type: 'attachment', id: 'attachment-secret', nodeUid: 'node-secret' }
  }), '节点附件', 'prefer the precise reference type and hide identifiers when no readable name or path exists')
  assert.equal(ctx.candidatePath({ sourceId: 'source-unknown' }), '资料来源（类型未标注）', 'avoid IDs when source metadata is unavailable')
  assert.match(ctx.candidateSummary(ctx.candidates[0]), /C: 异常识别；P: 处置计划；D: 逐项执行/)
  assert.deepEqual(ctx.candidateParts(ctx.candidates[0]).slice(0, 3).map(part => part.value), ['异常识别', '处置计划', '逐项执行'], '候选 C/P/D 分行显示')
  assert.equal(ctx.candidateParts(ctx.candidates[0]).length, 8, '候选按 C/P/D 和五个检查字段共八行展示')
  const wikiCandidate = {
    referenceDetails: {
      C: [{ heading: '检查范围', text: '销售回款' }],
      P: ['月回款率达到 95%'],
      D: [{ heading: '执行动作', text: '每月对账' }],
      fields: { frequency: ['每月'], input: ['销售台账'], criterion: ['回款率不低于 95%'], owner: ['财务负责人'], artifact: ['月度对账表'] }
    }
  }
  assert.deepEqual(ctx.candidateParts(wikiCandidate).map(part => part.value), [
    '检查范围：销售回款', '月回款率达到 95%', '执行动作：每月对账', '每月', '销售台账', '回款率不低于 95%', '财务负责人', '月度对账表'
  ], '兼容 Wiki 的 C/P/D 对象数组与五个字段字符串数组')
  assert.equal(ctx.statusLabel('something-unknown'), '待确认', 'unknown states must never render as passed')
  const stage = (run) => makeContext(component, { run }).reportStageLabel
  assert.equal(stage({ status: 'needs_confirmation', report: { selectionStage: 'chain' } }), '待选链路')
  assert.equal(stage({ status: 'needs_confirmation', report: { selectionStage: 'source' } }), '待选参考流程')
  assert.equal(stage({ status: 'needs_supplement', report: { summary: { categories: { review: 2, missing: 3 } } } }), '待人工核对')
  assert.equal(stage({ status: 'needs_supplement', report: { summary: { categories: { missing: 3 } } } }), '待补齐')
  assert.equal(stage({ status: 'needs_supplement', report: { summary: { categories: { source_error: 1 } } } }), '尚未核验')
  assert.equal(stage({ status: 'stale', report: {} }), '报告过期')
  assert.equal(stage({ status: 'failed', report: {} }), '检查失败')
  assert.equal(stage({ status: 'passed', report: {} }), '检查通过')
  assert.equal(component.methods.historyStageLabel.call(ctx, { status: 'needs_confirmation', report: { selectionStage: 'source' } }), '待选参考流程')

  const manualReviewStates = makeContext(component, { run: { status: 'needs_confirmation', report: {
    summary: { categories: { review: 2, missing: 2 } },
    findings: [
      { findingKey: 'manual-reviewable', ruleId: 'CK-10', nodeUid: 'manual-1', status: 'needs_info', severity: 'blocker', category: 'review', validationType: 'manual_text_review', reviewable: true, nextStep: '服务端的通用下一步' },
      { findingKey: 'manual-validation', ruleId: 'CK-27', nodeUid: 'manual-2', status: 'needs_info', severity: 'blocker', validation_type: 'manual_text_review' },
      { findingKey: 'missing-supplement', ruleId: 'CK-09', nodeUid: 'missing-1', status: 'needs_supplement', severity: 'blocker', category: 'missing', field: 'owner', reviewable: true },
      { findingKey: 'missing-info', ruleId: 'CK-09', nodeUid: 'missing-2', status: 'needs_info', severity: 'blocker', category: 'missing', field: 'inputs', reviewable: true }
    ]
  } } })
  assert.equal(manualReviewStates.reportStageLabel, '待人工核对', '报告阶段与核对分类使用一致的人工作业文案')
  assert.deepEqual(manualReviewStates.findingGroups.map(group => [group.key, group.title, group.count]), [
    ['missing', '缺少信息', 2], ['review', '待人工核对', 2]
  ], 'reviewable/validationType 项归入待人工核对，明确 missing 项仍归入缺少信息')
  const manualFinding = manualReviewStates.findings[0]
  const trueMissingFinding = manualReviewStates.findings[3]
  assert.equal(manualReviewStates.findingStateLabel(manualFinding), '待人工核对')
  assert.equal(manualReviewStates.findingNextStep(manualFinding), '阅读原文依据，填写判断理由后选择核对结果', '人工核对项提供对应下一步')
  assert.equal(manualReviewStates.findingStateLabel(trueMissingFinding), '待补齐', 'category=missing 优先保留真实缺项语义')
  assert.equal(manualReviewStates.findingStateLabel({ ruleId: 'CK-30', status: 'needs_info', category: 'source_error' }), '来源异常', 'source errors should not be presented as missing information')
  assert.equal(manualReviewStates.findingStateLabel({ ruleId: 'CK-30', status: 'passed', category: 'source_error' }), '通过', 'a passed state keeps precedence over source-error presentation')
  assert.equal(manualReviewStates.findingStateLabel({ ruleId: 'CK-30', status: 'failed', category: 'source_error' }), '未通过', 'a failed state keeps precedence over source-error presentation')
  assert.equal(manualReviewStates.sourceStatusLabel('unavailable', 'canonical_storage_permission_denied'), '房间资料目录无读取权限')
  assert.doesNotMatch(template, /（\{\{\s*sourceError\.error/, 'technical source errors must not be rendered into the report card')
  assert.deepEqual(manualReviewStates.categoryStatistics.map(item => [item.key, item.label, item.count]), [
    ['missing', '待补齐', 2], ['review', '待人工核对', 2]
  ])

  const coverage = makeContext(component, { run: { report: { coverage: {
    checkedNodes: ['节点 A', { nodeUid: 'node-b', name: '节点 B' }],
    checkedLocations: [{ nodeUid: 'node-b', kind: 'field', label: '责任人字段' }]
  } } } })
  assert.match(coverage.scopeSummary, /节点 A、节点 B.*责任人字段/)
  assert.doesNotMatch(coverage.scopeSummary, /node-b/)
  assert.doesNotMatch(coverage.scopeSummary, /\[object Object\]/)

  const merged = makeContext(component, { run: { report: {
    summary: { categories: { missing: 2, auxiliary: 1 } },
    findings: [
      { findingKey: 'f-owner', ruleId: 'CK-09', nodeUid: 'node-1', status: 'needs_supplement', category: 'missing', field: 'owner', issue: '责任人未提供', nextStep: '从项目资料补充', evidenceEntries: [{ id: 'e1', quote: '客服绩效管理', complete: true }] },
      { findingKey: 'f-frequency', ruleId: 'CK-09', nodeUid: 'node-1', status: 'needs_supplement', category: 'missing', field: 'frequency', issue: '频率未提供', nextStep: '从链路资料补充', evidenceEntries: [{ id: 'e1', quote: '客服绩效管理', complete: true }] },
      { findingKey: 'ck32', ruleId: 'CK-32', nodeUid: 'node-1', status: 'needs_supplement', category: 'auxiliary', display: true, message: '缺项汇总' }
    ]
  } } })
  assert.equal(merged.findingGroups.length, 1)
  assert.equal(merged.findingGroups[0].items.length, 1, '同节点同规则字段合并成一张卡')
  assert.equal(merged.findingGroups[0].count, 2, '分组计数仍是逐项检查数')
  assert.deepEqual(merged.categoryStatistics.map(item => [item.key, item.count]), [['missing', 2], ['auxiliary', 1]])
  const mergedCard = merged.findingGroups[0].items[0]
  assert.deepEqual(merged.findingFields(mergedCard), ['责任人', '频率'])
  assert.deepEqual(merged.findingDetails(mergedCard).map(item => merged.findingDetailMessage(item)), ['责任人未提供', '频率未提供'])
  assert.deepEqual(merged.evidenceEntries(mergedCard).map(item => item.quote), ['客服绩效管理'], '合并后同一原文只展示一次')
  assert.equal(merged.findingGroups.reduce((count, group) => count + group.items.length, 0), 1, 'CK-32 辅助汇总不重复进入问题分组')
  assert.equal(merged.findingQuote({ evidence: '旧字段不应显示', quote: '旧 quote 不应显示', evidenceEntries: [{ id: 'original', quote: '只显示原文', complete: true }] }), '只显示原文')

  const evidenceFormatter = makeContext(component)
  const sameTitleEvidence = { id: 'same-title', label: 'C · 节点正文 · 客服绩效管理', quote: 'C： 客服绩效管理  ' }
  assert.deepEqual(evidenceFormatter.evidenceDisplay(sameTitleEvidence), {
    label: 'C · 节点正文', quote: 'C： 客服绩效管理  ', text: 'C · 节点正文：C： 客服绩效管理  '
  }, '规范化空白和 C 前缀后相同的节点标题只显示一次，并保留角色和来源类型')
  assert.deepEqual(sameTitleEvidence, { id: 'same-title', label: 'C · 节点正文 · 客服绩效管理', quote: 'C： 客服绩效管理  ' }, '展示格式化不修改原始依据或身份')

  const noteEvidence = { id: 'different-note', label: 'C · 节点备注 · 客服绩效管理', quote: 'C：客服绩效管理备注：质检规则更新' }
  assert.equal(evidenceFormatter.evidenceDisplay(noteEvidence).text, 'C · 节点备注 · 客服绩效管理：C：客服绩效管理备注：质检规则更新', '节点备注正文不同则完整保留标题与正文')
  const attachmentEvidence = { id: 'different-attachment', label: 'D · 节点附件 · 质检流程.pdf', quote: '附件正文：质检员每周抽查客服记录' }
  assert.equal(evidenceFormatter.evidenceDisplay(attachmentEvidence).text, 'D · 节点附件 · 质检流程.pdf：附件正文：质检员每周抽查客服记录', '附件正文完整保留，不因包含附件名片段而被截断')
  const similarEvidence = { id: 'similar-body', label: 'D · 节点正文 · 客服绩效管理', quote: 'D：客服绩效管理流程' }
  assert.equal(evidenceFormatter.evidenceDisplay(similarEvidence).text, 'D · 节点正文 · 客服绩效管理：D：客服绩效管理流程', '相似但不相同的正文不能按子串删标题')
  assert.equal(evidenceFormatter.evidenceDisplay({ id: 'no-label', label: '', quote: 'C：验收标准' }, '核对原文').text, '核对原文：C：验收标准', '空标签使用人工核对的可读兜底文案')

  const sameContent = makeContext(component, { run: { report: { findings: [{ evidenceEntries: [
    { id: 'node-c', label: 'C · 节点正文 · 相同标题', quote: 'C：相同标题' },
    { id: 'node-p', label: 'P · 节点备注 · 相同标题', quote: 'P：相同标题' }
  ] }] } } })
  const sameContentEntries = sameContent.evidenceEntries(sameContent.findings[0])
  assert.deepEqual(sameContentEntries.map(entry => entry.id), ['node-c', 'node-p'], '相同正文的不同依据仍保留各自核对身份')
  assert.deepEqual(sameContentEntries.map(entry => sameContent.evidenceDisplay(entry).label), ['C · 节点正文', 'P · 节点备注'], '相同正文仍保留角色和来源类型标签以便区分')

  const materialLinked = makeContext(component, { run: { report: {
    summary: { categories: { missing: 1 } },
    findings: [{ findingKey: 'missing-frequency', ruleId: 'CK-09', nodeUid: 'n-material', status: 'needs_supplement', category: 'missing', field: 'frequency', issue: 'D 节点缺少频率。' }],
    materialCandidates: [
      { sourceId: 'wiki-frequency', nodeUid: 'n-material', field: 'frequency', title: 'Wiki 频率规范', quote: '每月检查一次。' },
      { sourceId: 'wiki-frequency', nodeUid: 'n-material', field: 'frequency', title: 'Wiki 频率规范', quote: '每月检查一次。' },
      { sourceId: 'wiki-frequency', nodeUid: 'n-material', field: 'owner', title: 'Wiki 责任人规范', quote: '项目经理负责。' },
      { sourceId: 'wrong-field', nodeUid: 'n-material', field: 'owner', title: '负责人资料', quote: '项目经理负责。' },
      { sourceId: 'wrong-node', nodeUid: 'other-node', field: 'frequency', title: '其他链路', quote: '每周检查一次。' }
    ]
  } } })
  const materialFinding = materialLinked.findingGroups[0].items[0]
  assert.equal(materialLinked.materialCandidates.length, 4, '同一来源匹配不同字段时保留各字段候选')
  assert.equal(materialLinked.relatedMaterialCandidates(materialFinding).length, 1, '候选按节点 UID 和字段匹配，并按来源及原文去重')
  assert.equal(materialLinked.relatedMaterialCandidates(materialFinding)[0].quote, '每月检查一次。')
  assert.equal(materialLinked.isMissingFinding(materialFinding), true, '有关联候选仍保持待补齐')
  assert.equal(materialLinked.isPassedFinding(materialFinding), false, '材料候选不会自动让缺项通过')
  assert.equal(materialLinked.findingGroups[0].count, 1, '材料候选不改变检查项统计')
  assert.match(template, /当前图仍缺字段或引用/)
  assert.match(template, /candidate\.quote/)

  const staleReview = makeContext(component, { run: { id: 'stale-run', status: 'stale', report: {
    revision: 8,
    findings: [{ findingKey: 'stale-f', ruleId: 'CK-09', nodeUid: 'node-1', status: 'passed', category: 'passed', reviewable: true, manualReview: { decision: 'confirm', invalidated: true, reason: '已过期' } }]
  } } })
  assert.equal(staleReview.reportIsStale, true)
  assert.equal(staleReview.reportStaleReason, '报告已过期，请重新检查')
  staleReview.run.report.staleReason = '链路节点、对应关系或附件已变化，请重新检查。'
  assert.equal(staleReview.reportStaleReason, staleReview.run.report.staleReason, '展示服务端过期原因，解释为何不能确认')
  assert.match(template, /\{\{ reportStaleReason \}\}/)
  assert.equal(staleReview.reviewDisabled(staleReview.findings[0], 'revoke'), true, '过期报告禁止人工核对和撤销')
  assert.match(staleReview.manualReviewLabel(staleReview.findings[0], true), /不作为当前有效结论/)

  const reviewFinding = {
    findingKey: 'node-1:CK-09:owner', ruleId: 'CK-09', nodeUid: 'node-1', status: 'needs_supplement',
    category: 'missing', field: 'owner', reviewable: true, requiredEvidenceIds: ['ev-1'],
    evidenceEntries: [{ id: 'ev-1', label: '当前图资料', quote: '客服绩效由客户满意度决定', complete: true }]
  }
  const reusedAudit = makeContext(component, { run: { id: 'new-run-with-audit', status: 'needs_supplement', report: {
    mode: 'business', revision: 4, reviewDecisions: [{ decision: 'confirm', invalidated: true }], findings: [reviewFinding]
  } } })
  assert.equal(reusedAudit.reportIsStale, false, '复用核对后保留的历史失效审计不应使新报告过期')
  assert.equal(reusedAudit.reviewDisabled(reviewFinding, 'confirm'), false, '新报告仍允许重新核对')

  const reviewContext = makeContext(component, { visible: true, checkedTarget: { nodeUid: 'node-1', roomKey: 'room-1', nodeTitle: '选中节点' }, run: {
    id: 'review-run', nodeUid: 'node-1', status: 'needs_supplement', report: { mode: 'business', revision: 4, findings: [reviewFinding] }
  } })
  const reviewCallsBeforeMissingReason = calls.review
  reviewContext.setReviewReason(reviewFinding, '   ')
  assert.equal(await component.methods.submitReview.call(reviewContext, reviewFinding, 'confirm'), null)
  assert.equal(reviewContext.error, '请填写判断理由。')
  assert.equal(calls.review, reviewCallsBeforeMissingReason, '缺少判断理由时不提交核对请求')
  reviewContext.setReviewReason(reviewFinding, '按项目负责人提供的原文核验')
  reviewContext.toggleReviewEvidence(reviewFinding, 'ev-1', true)
  await component.methods.submitReview.call(reviewContext, reviewFinding, 'confirm')
  assert.deepEqual(Object.fromEntries(Object.entries(payloads.review).filter(([key]) => key !== 'requestId')), {
    expectedRevision: 4, findingKey: 'node-1:CK-09:owner', decision: 'confirm',
    reason: '按项目负责人提供的原文核验', evidenceIds: ['ev-1']
  })
  reviewContext.run = { id: 'review-run', nodeUid: 'node-1', status: 'needs_supplement', report: { mode: 'business', revision: 4, findings: [reviewFinding] } }
  await component.methods.submitReview.call(reviewContext, reviewFinding, 'reject')
  assert.equal(payloads.review.decision, 'reject', '支持判定未通过')
  const confirmedReview = { ...reviewFinding, reviewable: false, manualReview: { decision: 'confirm', reason: '之前的核对' } }
  reviewContext.run = { id: 'review-run', nodeUid: 'node-1', status: 'passed', report: { mode: 'business', revision: 4, findings: [confirmedReview] } }
  reviewContext.setReviewReason(confirmedReview, '依据变化后撤销')
  assert.equal(reviewContext.reviewDisabled(confirmedReview, 'revoke'), false, '通过项仍可撤销人工核对')
  await component.methods.submitReview.call(reviewContext, confirmedReview, 'revoke')
  assert.equal(payloads.review.decision, 'revoke')
  assert.deepEqual(payloads.review.evidenceIds, [])
  const reviewCallsBeforeDemo = calls.review
  const demoContext = makeContext(component, { visible: true, checkedTarget: { nodeUid: 'node-1', roomKey: 'room-1' }, run: {
    id: 'demo-run', nodeUid: 'node-1', report: { mode: 'demo', revision: 2, findings: [reviewFinding] }
  } })
  demoContext.setReviewReason(reviewFinding, '演示核对')
  demoContext.toggleReviewEvidence(reviewFinding, 'ev-1', true)
  assert.equal(await component.methods.submitReview.call(demoContext, reviewFinding, 'confirm'), null)
  assert.equal(calls.review, reviewCallsBeforeDemo, '演示报告不能提交正式人工通过')

  const sourceContext = makeContext(component, { visible: true, checkedTarget: { nodeUid: 'node-1', roomKey: 'room-1' }, run: {
    id: 'source-run', nodeUid: 'node-1', status: 'needs_supplement', report: { mode: 'business', revision: 5, sources: [
      { sourceId: 'wiki-source', title: 'Wiki 主题', path: '销售 / 会员', status: 'parse_failed', sourceRef: { type: 'wiki_compiler', topic: '会员复购', section: '规则', query: '频率' } }
    ] }
  } })
  const source = sourceContext.sources[0]
  const sourceDetail = await component.methods.readSource.call(sourceContext, source)
  assert.equal(sourceDetail.title, 'Wiki 正文')
  assert.equal(sourceContext.sourceTechnical(sourceDetail.provenance), '{\n  "origin": "business"\n}')
  const technicalSource = JSON.parse(sourceContext.sourceTechnical({
    sourceId: 'source-7', version: 'v2', path: 'branches/example.md',
    sourceRef: { type: 'map_node', nodeUid: 'private-node', uid: 'private-node', path: 'branches/example.md' },
    nested: [{ node_uid: 'private-node-2', uid: 'private-node-2' }]
  }))
  assert.deepEqual(technicalSource, {
    sourceId: 'source-7', version: 'v2', path: 'branches/example.md',
    sourceRef: { type: 'map_node', path: 'branches/example.md' },
    nested: [{}]
  }, '技术来源详情隐藏节点 UID，同时保留来源 ID、版本和路径')
  assert.equal(sourceContext.findingNodeTitle({ nodeUid: 'unmapped-node' }), '未命名节点', '缺少名称时显示可读占位，不显示 UID')
  assert.equal(sourceContext.sourceRetryable(source), true)
  const retryCallsBefore = calls.retry
  await component.methods.retrySource.call(sourceContext, source)
  assert.equal(calls.retry, retryCallsBefore + 1)
  assert.equal(payloads.retry.expectedRevision, 5)
  assert.ok(payloads.retry.requestId)

  const interruptedByClose = makeContext(component, { visible: true, checkedTarget: { nodeUid: 'node-1', roomKey: 'room-1' }, run: {
    id: 'source-run-close', nodeUid: 'node-1', report: { revision: 5, sources: [source] }
  } })
  holdSourceRead = true
  const pendingRead = component.methods.readSource.call(interruptedByClose, source)
  await Promise.resolve()
  assert.equal(interruptedByClose.sourceLoadingId, 'wiki-source')
  assert.equal(typeof releaseSourceRead, 'function')
  component.methods.close.call(interruptedByClose)
  assert.equal(interruptedByClose.sourceLoadingId, '', '关闭面板中断读取时清除来源读取 busy')
  assert.equal(interruptedByClose.sourceRetryingId, '')
  assert.equal(interruptedByClose.reviewSubmittingKey, '')
  holdSourceRead = false
  releaseSourceRead()
  assert.equal(await pendingRead, null, '关闭后忽略过期来源响应')
  interruptedByClose.visible = true
  assert.equal((await component.methods.readSource.call(interruptedByClose, source)).title, 'Wiki 正文', '关闭中断后仍能重新读取来源')

  const interruptedByNewRequest = makeContext(component, {
    visible: true,
    checkedTarget: { nodeUid: 'node-1', roomKey: 'room-1' },
    run: { id: 'review-run', nodeUid: 'node-1', report: { revision: 4, findings: [reviewFinding], sources: [source] } }
  })
  holdSourceRead = true
  const pendingBeforeReview = component.methods.readSource.call(interruptedByNewRequest, source)
  await Promise.resolve()
  assert.equal(interruptedByNewRequest.sourceLoadingId, 'wiki-source')
  interruptedByNewRequest.setReviewReason(reviewFinding, '新请求打断来源读取')
  interruptedByNewRequest.toggleReviewEvidence(reviewFinding, 'ev-1', true)
  await component.methods.submitReview.call(interruptedByNewRequest, reviewFinding, 'confirm')
  assert.equal(interruptedByNewRequest.sourceLoadingId, '', '新请求开始后释放被中断的来源读取 busy')
  assert.equal(interruptedByNewRequest.reviewSubmittingKey, '', '人工核对请求结束后释放 busy')
  holdSourceRead = false
  releaseSourceRead()
  assert.equal(await pendingBeforeReview, null, '新请求开始后忽略旧来源响应')
  assert.equal((await component.methods.readSource.call(interruptedByNewRequest, source)).title, 'Wiki 正文', '新请求中断后来源仍可再次读取')

  const staleBusy = makeContext(component, {
    checking: true, confirming: true, confirmingCandidateId: 'flow-1',
    sourceLoadingId: 'source-1', sourceRetryingId: 'source-2', reviewSubmittingKey: 'finding-1'
  })
  component.methods.beginRequest.call(staleBusy)
  assert.deepEqual([
    staleBusy.checking, staleBusy.confirming, staleBusy.confirmingCandidateId,
    staleBusy.sourceLoadingId, staleBusy.sourceRetryingId, staleBusy.reviewSubmittingKey
  ], [false, false, '', '', '', ''], '新请求开始时清除所有旧请求 busy 标志')
  component.methods.invalidateRequests.call(staleBusy)
  assert.equal(staleBusy.reviewSubmittingKey, '', '关闭或切换目标也会清理人工核对 busy')

  const staleSourceContext = makeContext(component, { visible: true, checkedTarget: { nodeUid: 'node-1', roomKey: 'room-1' }, run: {
    id: 'stale-source-run', nodeUid: 'node-1', status: 'stale', report: { revision: 5, sources: [source] }
  } })
  assert.equal(staleSourceContext.reviewDisabled(reviewFinding, 'confirm'), true)
  await component.methods.retrySource.call(staleSourceContext, source)
  assert.equal(calls.retry, retryCallsBefore + 1, '过期报告禁止重读并复检')

  const snapshot = makeContext(component, { visible: true, checkedTarget: { nodeUid: 'fixed-node', roomKey: 'fixed-room', nodeTitle: '固定检查对象' }, nodeUid: 'new-selection', nodeTitle: '新选中节点', run: { report: {} } })
  assert.equal(snapshot.checkTargetUid, 'fixed-node')
  assert.equal(snapshot.checkTargetTitle, '固定检查对象')
  assert.equal(snapshot.checkRoomKey, 'fixed-room')
  component.watch.nodeUid.call(snapshot, 'new-selection', 'node-1')
  assert.equal(snapshot.checkTargetUid, 'fixed-node', '检查面板打开后锁定目标快照')
  assert.equal(component.methods.locateNode, undefined, '检查面板不再提供定位节点操作')
  assert.match(reviewContext.formatBeijingTime('2026-09-28T10:11:43.940Z'), /18:11:43/)

  const readonly = makeContext(component, { readonly: true })
  await component.methods.open.call(readonly)
  assert.equal(calls.list, 1, 'read-only open should load history')
  assert.equal(calls.get, 1, 'read-only open should load the full latest report')
  assert.equal(calls.create, 0, 'read-only open must not create a check run')
  await component.methods.confirmCandidate.call(readonly, { candidateId: 'flow-1', kind: 'flow' })
  assert.equal(calls.confirm, 0, 'read-only users must not confirm candidates')

  const editable = makeContext(component)
  await component.methods.open.call(editable)
  assert.equal(calls.create, 1, 'editable check-button open should create a fresh run')
  assert.equal(payloads.create.mode, 'business', '新建检查固定使用正式模式')

  const readonlySwitch = makeContext(component, {
    readonly: true,
    nodeUid: 'new-node', roomKey: 'new-room', nodeTitle: '新对象',
    checkedTarget: { nodeUid: 'old-node', roomKey: 'old-room', nodeTitle: '旧对象' },
    run: { id: 'old-run', nodeUid: 'old-node', roomKey: 'old-room', report: { findings: [{ ruleId: 'CK-1' }] } },
    history: [{ id: 'old-run' }]
  })
  failHistoryRead = true
  await component.methods.open.call(readonlySwitch)
  failHistoryRead = false
  assert.equal(readonlySwitch.run, null, '新对象只读历史读取失败时不保留旧对象报告')
  assert.deepEqual(readonlySwitch.history, [], '切换只读检查对象时先清空旧历史')

  console.log('CPDCheckPanel component contract tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
