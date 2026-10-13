const fs = require('fs'), path = require('path')
const { summarize, percentile } = require('./metrics.cjs')
const base = 'D:/mind-map-collab-round1-results'
const [baseline, bridge, layout, deep] = process.argv.slice(2).map(value => {
  const resolved = path.resolve(base, value)
  if (!resolved.startsWith(path.resolve(base) + path.sep)) throw new Error('report input must be inside diagnostic output')
  return resolved
})
if (!deep) throw new Error('Usage: report.cjs baseline bridge layout deep-correction')
const read = dir => JSON.parse(fs.readFileSync(path.join(dir, 'summary.json')))
const jsonl = file => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
const b = read(baseline), c = read(bridge), l = read(layout), d = read(deep)
if (![b,c,l,d].every(x => x.complete)) throw new Error('Cannot report incomplete runs as a completed baseline')
const number = n => n == null ? '未测/未完成' : Number(n).toFixed(1)
const lines = [
  '# 协作性能第一轮：采集与基线结果', '',
  '日期：2026-10-13（Asia/Shanghai）。本轮只有可关闭的诊断事件与隔离采集工具，没有实施性能修复。', '',
  '源码基于 d5793106，采集运行的具体源码 SHA、差异指纹、镜像 ID、浏览器构建指纹和开关保存在各 run_start/manifest 中。MCP-direct 保持关闭，历史检查点 200，布局偏好未改，编译器开启。桥接对照仅在隔离容器开启 Event Bridge。', '',
  '## 浏览器与 MCP', ''
]
for (const [name, summary] of [['基线 Bridge=0',b],['观测对照 Bridge=1',c]]) {
  lines.push('', `### ${name}`, '', '| 配置 | 指标 | 样本 | 失败 | P50 ms | P95 ms | P99 ms | 最大成功 ms |', '|---|---|---:|---:|---:|---:|---:|---:|')
  for (const [metric, stats] of Object.entries(summary.metrics)) {
    lines.push(`| ${name} | ${metric} | ${stats.samples} | ${stats.failures} (${number(stats.failureRate * 100)}%) | ${number(stats.p50Ms)} | ${number(stats.p95Ms)} | ${number(stats.p99Ms)} | ${number(stats.maxMs)} |`)
  }
  lines.push('', `${name}：Gap Sync=${summary.gapSync}，Resnapshot 尝试=${summary.resnapshotAttempts}，重复事件处理计数=${summary.duplicateReceives}。`, '')
  for (const [mode, stats] of Object.entries(summary.navigationModes || {})) lines.push(`- 导航 ${mode}：n=${stats.samples}，P50/P95/P99=${number(stats.p50Ms)}/${number(stats.p95Ms)}/${number(stats.p99Ms)} ms。`)
  const raw = jsonl(path.join(summary.rawDirectory, 'client.jsonl'))
  const counts = Object.fromEntries(['subtree','locate'].map(endpoint => [endpoint, raw.filter(x => x.kind === 'lazy_request' && x.endpoint === endpoint).length]))
  lines.push(`- 懒加载请求：subtree=${counts.subtree}，locate=${counts.locate}。`)
  lines.push(`- 应用问题：${JSON.stringify(summary.deliveryIssues)}。`)
  const clock = raw.find(x => x.kind === 'clock_calibration')
  lines.push(`- 时钟校准偏移=${number(clock?.offsetMs)} ms，不确定度=${number(clock?.uncertaintyMs)} ms。`)
  for (const row of raw.filter(x => ['acked_persistence','version_consistency'].includes(x.kind))) lines.push(`- 正确性抽检：${JSON.stringify(row)}。`)
}
lines.push('', '说明：firstOpen 是导航到可用状态，包含 1 次新 context 和 4 次缓存重载；合计不是冷启动 P99。Gap Sync、Resnapshot 和请求数量覆盖整个运行，包含打开及初始化，不单独归因 MCP。Commit→Applied 代表远端回调完成并推进连续版本，不是绘制完成；返回 false、未完成或只经快照恢复的操作不冒充逐条应用成功。Bridge=0 缺少 MCP 事件接收是当前配置下的预期观测，不代表 MCP 写入失败。缺失样本按观察窗口截尾，原始样本保留等待下界。', '',
  '## 布局矩阵', '',
  '每组 3 次，独立 Chrome 页面，实际调用当前源码布局。测量 doLayout 至 callback，包含布局期间的节点创建与尺寸测量，排除绘制。', '',
  '| 可见节点 | 树形 | 紧凑 | n | 失败率 | P50 ms | P95 ms | P99 ms | 最大成功 ms |',
  '|---:|---|---|---:|---:|---:|---:|---:|---:|')
const rows = jsonl(path.join(layout, 'layout.jsonl')).filter(x => x.kind === 'sample' && !(x.size === 1000 && x.shape === 'deep'))
rows.push(...jsonl(path.join(deep, 'layout.jsonl')).filter(x => x.kind === 'sample'))
const groups = [...new Set(rows.map(x => `${x.size}/${x.shape}/${x.compact}`))]
for (const key of groups) {
  const [size,shape,compact] = key.split('/'), stats = summarize(rows.filter(x => `${x.size}/${x.shape}/${x.compact}` === key))
  lines.push(`| ${size} | ${shape} | ${compact} | ${stats.samples} | ${number(stats.failureRate * 100)}% | ${number(stats.p50Ms)} | ${number(stats.p95Ms)} | ${number(stats.p99Ms)} | ${number(stats.maxMs)} |`)
}
lines.push('', '1000 层单链原采集出现 Windows Node JSON.stringify 溢栈，是采集器错误，已排除该组六条无效尝试并通过迭代序列化补测。此前中断和启动失败数据仍保留，不作为有效基线。三次样本的 P95/P99 等于最大值，不足以设生产阈值；这里的裸渲染器也不能替代真实编辑器的完整操作矩阵。', '',
  '## 进程资源采样', '', '| 配置 | 进程 | 样本 | CPU P50/P95/P99 % | RSS 峰值 MiB | 事件循环 p99 峰值 ms | 池等待峰值 |', '|---|---|---:|---|---:|---:|---:|')
for (const [name,dir] of [['基线',baseline],['桥接对照',bridge]]) {
  const resources = fs.readdirSync(dir).filter(x => /^server-.*\.jsonl$/.test(x)).flatMap(file => jsonl(path.join(dir,file))).filter(x => x.kind === 'resource')
  for (const role of ['collab','mcp']) {
    const samples = resources.filter(x => x.role === role)
    if (!samples.length) continue
    const cpu = samples.map(x => x.cpuPercent)
    lines.push(`| ${name} | ${role} | ${samples.length} | ${number(percentile(cpu,.5))}/${number(percentile(cpu,.95))}/${number(percentile(cpu,.99))} | ${number(Math.max(...samples.map(x => x.memory.rss)) / 1048576)} | ${number(Math.max(...samples.map(x => x.eventLoop.p99Ms)))} | ${Math.max(0,...samples.flatMap(x => x.pools.map(p => p.waiting)))} |`)
  }
}
lines.push('', 'CPU 100% 表示约占一个逻辑核。这里测整个进程，不单独归因编译器；本轮没有编译开关 A/B 或 CPU profile，不能据此批准后台拆分。', '',
  '## 验证与边界', '',
  '- 新增统计、隔离保护、重复/缺失/身份错误关联及观察器行为测试：8/8 通过。',
  '- collabV2、collabV2.productFix、MCP event bridge 聚焦回归通过；生产构建通过。',
  '- 既有 collabPassiveRefresh 测试：1 通过、1 失败；失败为测试上下文缺少 scheduleRemoteGeometryRender。已核对该测试与 Cooperate.js 均和 HEAD 完全一致，本轮未修改。',
  '- 本轮是单浏览器、单服务实例的采集验证，不是多人/多实例性能验收；桥接重启恢复、多实例、完整重放、权限/SOP/历史/撤销重做矩阵留在后续对应阶段。',
  '- 没有修复后数据，不宣称性能问题已解决。性能改善必须同时满足正确性和长尾门槛。', '',
  '## 原始数据', '', ...[baseline,bridge,layout,deep].map(dir => `- [${path.basename(dir)}](${dir.replace(/\\/g,'/')})`), '',
  '完整原始数据根目录：D:/mind-map-collab-round1-results/。源码采集说明见同目录 README.md。'
)
lines.push('', '## 实际修改文件', '',
  '- simple-mind-map/bin/collabV2/adapter.js：接收、应用、重复、缺口和快照诊断事件。',
  '- simple-mind-map/bin/collabV2/performanceObserver.js：默认关闭、异常隔离的采集入口与可见树形统计。',
  '- simple-mind-map/src/core/render/Render.js：布局耗时与树形记录，未改布局选择。',
  ...fs.readdirSync(__dirname).filter(file => /\.(cjs|js|md|sh)$/.test(file)).sort().map(file => `- simple-mind-map/scripts/collab-round1/${file}`), '')
fs.writeFileSync(path.join(__dirname,'REPORT.md'), lines.join('\n').trimEnd() + '\n')
fs.writeFileSync(path.join(base,'round1-report.md'), lines.join('\n').trimEnd() + '\n')
console.log('Report written: ' + path.join(__dirname,'REPORT.md'))
