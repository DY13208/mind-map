/**
 * SOP 台账抽取冒烟（纯 Node，不依赖 Vue 打包）
 * 与 web/src/utils/sopRegistryPrompt.js 中 D_REGISTRY_RE / 抽取约定对齐
 * 规则：只认单独「D：标题」，排除 D1/D2
 */
const D_REGISTRY_RE = /^(D)(?!\d)\s*[：:]\s*(.+)$/i

function cleanTitle(title) {
  return String(title || '')
    .replace(/[\s]*[|｜].*$/, '')
    .replace(/[\s]+$/g, '')
    .trim()
}

function matchDRegistryTitle(text) {
  const trimmed = String(text || '')
    .trim()
    .replace(/^[-*•●]\s*/, '')
    .replace(/^【\s*/, '')
    .replace(/\s*】$/, '')
  const m = trimmed.match(D_REGISTRY_RE)
  if (!m) return null
  const title = cleanTitle(m[2])
  if (!title) return null
  return { id: 'D', title }
}

function detectFrequency(text) {
  const t = String(text || '')
  const rules = [
    { re: /每天|每日|daily/i, label: '每天' },
    { re: /每周|weekly/i, label: '每周' },
    { re: /每月|monthly/i, label: '每月' },
    { re: /每季度|季度/i, label: '每季度' },
    { re: /按需|需要时/i, label: '按需' },
    { re: /触发时|事件触发/i, label: '触发时' }
  ]
  for (const rule of rules) {
    if (rule.re.test(t)) return { label: rule.label, cron_hint: null }
  }
  return { label: '未知', cron_hint: null }
}

function parseSample(rawText) {
  const lines = String(rawText || '').split(/\r?\n/)
  const sops = []
  lines.forEach((line, index) => {
    const matched = matchDRegistryTitle(line.trim().replace(/^[-*•]\s*/, ''))
    if (!matched) return
    const { id, title } = matched
    const block = []
    const baseIndent = (line.match(/^(\s*)/) || ['', ''])[1].length
    for (let i = index; i < lines.length && i < index + 30; i++) {
      const l = lines[i]
      if (!l || !l.trim()) continue
      const indent = (l.match(/^(\s*)/) || ['', ''])[1].length
      if (
        i > index &&
        indent <= baseIndent &&
        D_REGISTRY_RE.test(l.trim().replace(/^[-*•]\s*/, ''))
      ) {
        break
      }
      if (i > index && indent <= baseIndent) break
      block.push(l)
    }
    const ctx = block.join('\n')
    const deliverables = []
    block.forEach(l => {
      const t = l.trim()
      if (/交付|产出/.test(t)) {
        deliverables.push({
          name:
            t
              .replace(/^[-*•]\s*/, '')
              .replace(/^[^：:]*[：:]/, '')
              .trim() || t,
          uri_or_path: '',
          kind: 'node'
        })
      }
      const file = t.match(/([\w.\u4e00-\u9fff/-]+\.(xlsx?|docx?|pdf|md))/i)
      if (file) {
        deliverables.push({ name: file[1], uri_or_path: file[1], kind: 'file' })
      }
    })
    const runs = []
    block.forEach(l => {
      const t = l.trim().replace(/^[-*•]\s*/, '')
      if (/^(频率|每天|每日|每周|每月|每季度|按需)/.test(t)) return
      const hasTime = /\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(t)
      const hasRunWord = /(运行记录|执行记录|日志|已完成|完成于)/.test(t)
      if (!hasTime && !hasRunWord) return
      runs.push({
        at: (t.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/) || [''])[0],
        result: /完成|成功/.test(t) ? '完成' : '',
        note: t
      })
    })
    sops.push({
      id,
      title,
      source: { type: 'paste', ref: '粘贴', path: '' },
      frequency: detectFrequency(ctx),
      runs,
      deliverables,
      cpda: { goal: title, C: [], P: [] }
    })
  })
  return {
    sops,
    conflicts: [],
    notes: ''
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed')
}

const sample1 = `公司
  - D：采购目标
    - 频率：每周
    - 交付：采购计划.xlsx`
const r1 = parseSample(sample1)
assert(r1.sops.length === 1, 'one sop')
assert(r1.sops[0].id === 'D', 'id D')
assert(r1.sops[0].title === '采购目标', 'title')

// 排除 D1/D2；正文夹带也不算
assert(!matchDRegistryTitle('Dashboard'), 'Dashboard 不是 SOP')
assert(!matchDRegistryTitle('产品D线'), '产品D线 不是 SOP')
assert(!matchDRegistryTitle('Do：待办'), 'Do：不是台账')
assert(!matchDRegistryTitle('D1：销售目标'), 'D1 不是台账')
assert(!matchDRegistryTitle('D2：采购目标'), 'D2 不是台账')
assert(!matchDRegistryTitle('参考 D：销售目标'), '正文夹带不算')
assert(!matchDRegistryTitle('AD：误匹配'), '前缀字母不算')
assert(matchDRegistryTitle('D：销售目标').id === 'D', '标准 D：')
assert(matchDRegistryTitle('【D：采购目标】').title === '采购目标', '书名号可剥')
assert(matchDRegistryTitle('D: 招聘').title === '招聘', '半角冒号')

const sample2 = `- D：供应商准入
  - 频率：每月
  - 交付：供应商评估表.pdf
  - 运行记录：2026-03-01 已完成
- D1：这不是台账
- D2：也不是
- D：采购目标
  - 每周执行
  - 产出 采购计划.docx`

const r2 = parseSample(sample2)
assert(r2.sops.length === 2, `expect 2 got ${r2.sops.length}`)
const a = r2.sops.find(s => s.title === '供应商准入')
const b = r2.sops.find(s => s.title === '采购目标')
assert(a && a.id === 'D', '准入 id')
assert(a.frequency.label === '每月', '准入 monthly')
assert(a.deliverables.some(d => /供应商评估表/.test(d.name)), '准入 deliverable')
assert(a.runs.length >= 1, '准入 runs')
assert(b && b.id === 'D', '采购 id')
assert(b.frequency.label === '每周', '采购 weekly')

const sample3 = `- D：采购目标A
- D：采购目标B`
const r3 = parseSample(sample3)
assert(r3.sops.length === 2, 'two D titles')
assert(r3.sops[0].id === 'D' && r3.sops[1].id === 'D', 'both id D')

console.log('SOP registry smoke OK')
