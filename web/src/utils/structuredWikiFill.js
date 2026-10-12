import { candidatesFor, multipleReports } from 'simple-mind-map/src/utils/fillConflict'
import { extractValues, valuesConflict, latestValues, normalizeField } from 'simple-mind-map/src/utils/genericFill'
import { licenseTexts } from 'simple-mind-map/src/utils/licenseFacts'
import { resultsToChildTrees } from './wikiNodeFill'
import {
  visibleText,
  factKey,
  factKeys,
  factsConflict,
  presentFillTrees,
  capitalCurrency
} from 'simple-mind-map/src/utils/fillFacts'

const aliases = {
  注册地址: ['注册地址', '注册住所', '住所地址', '登记地址', '住所', '注册城市', '注册地区'],
  注册资本: ['注册资本', '注册资金'],
  经营许可: ['经营许可', '经营许可证'],
  股东: ['股东', '股东及出资', '股东及出资情况', '股东信息'],
  法人代表: ['法人代表', '法定代表人']
}
const norm = text =>
  String(text || '')
    .replace(/\s/g, '')
    .replace(/^主体资质[·・：:]/, '')
function evidenceRows(content, options) {
  const excluded = new Set(
    (options.excludeUids || []).map(uid =>
      Array.from(new TextEncoder().encode(String(uid)))
        .map(n => n.toString(16).padStart(2, '0'))
        .join('')
    )
  )
  return String(content || '')
    .split(/(?=<a id="node-[^"]+"><\/a>)/)
    .filter(block => {
      const marker = block.match(/<!-- mindmap:node=([a-f0-9]+)[^>]*-->/)
      return (
        !marker ||
        (!excluded.has(marker[1]) && !/auto_fill=2\b/.test(marker[0]))
      )
    })
    .flatMap(block =>
      block.split(/\r?\n/).map(raw => ({
        raw,
        depth:
          Number(block.match(/<!-- mindmap:node=[^>]*\bdepth=(\d+)/)?.[1]) || 0
      }))
    )
}
export function extractWikiFill(
  results,
  titles,
  existingTexts = [],
  options = {}
) {
  const field = normalizeField(titles[titles.length - 1])
  const company = titles
    .slice(0, -1)
    .reverse()
    .find(t => /公司|Limited|Co\.,?\s*Ltd/i.test(t))
  if (aliases[field] && !company)
    return { reason: 'no_match', trees: [], sources: [], warnings: [] }
  const trees = []
  const evidenceFor = new WeakMap()
  const sources = []
  let matched = 0
  let parsed = 0
  if (company && aliases[field]) {
    for (const item of results || []) {
      if (typeof item.content !== 'string') continue
      parsed++
      const stack = item.section
        ? [
            {
              level: 0,
              title: item.section.replace(/\s*\[coverage:[^\]]*\]/, '')
            }
          ]
        : []
      const rows = evidenceRows(item.content, options)
      rows.forEach(({ raw, depth }, rowIndex) => {
        let heading = /^(#{1,6})\s+(.+)$/.exec(raw.trim())
        let text = visibleText(heading ? heading[2] : raw)
        if (!text) return
        if (!heading && /^\*\*[^\n]+\*\*$/.test(raw.trim())) {
          const previousField = stack
            .map(e => norm(e.title))
            .map(name =>
              Object.values(aliases)
                .flat()
                .some(alias => norm(alias) === name)
            )
            .lastIndexOf(true)
          const currentCompany = stack
            .slice(0, previousField >= 0 ? previousField : stack.length)
            .reverse()
            .find(e => /公司|Limited|Co\.,?\s*Ltd/i.test(e.title))
          const label = Object.values(aliases)
            .flat()
            .some(alias => norm(alias) === norm(text))
          const companyTitle =
            /(?:公司|Limited|Ltd\.?)$/i.test(text) &&
            !/[：:，,；;（）()]/.test(text)
          const shareholderValue =
            previousField >= 0 &&
            aliases.股东.some(
              a => norm(a) === norm(stack[previousField].title)
            ) &&
            companyTitle &&
            presentFillTrees([{ data: { text }, children: [] }], titles).length
          if (depth || label || companyTitle)
            heading = [
              '',
              '#'.repeat(
                depth ||
                  (shareholderValue
                    ? stack[previousField].level + 1
                    : companyTitle
                    ? currentCompany?.level || 6
                    : (currentCompany?.level || 6) + 1)
              ),
              text
            ]
        }
        // Explicit company + representative on one source row is evidence even
        // when stored under a contract section rather than the company field.
        if (field === '法人代表') {
          const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const identity = text.match(
            new RegExp(
              escaped +
                '[（()）：:；;\\s]{0,6}(?:法人代表|法定代表人)[：:\\s]*([\\u4e00-\\u9fff·]{2,10})(?=[）)；;，,\\s]|$)'
            )
          )
          if (identity) {
            const date =
              text.match(
                /(?:19|20)\d{2}(?:年(?:\d{1,2}月(?:\d{1,2}日)?)?|[-/.]\d{1,2}(?:[-/.]\d{1,2})?)/
              )?.[0] ||
              stack
                .map(e => e.title)
                .reverse()
                .map(
                  title =>
                    title.match(
                      /(?:19|20)\d{2}(?:年(?:\d{1,2}月(?:\d{1,2}日)?)?|[-/.]\d{1,2}(?:[-/.]\d{1,2})?)/
                    )?.[0]
                )
                .find(Boolean)
            const value =
              (date ? date + '；' : '') + '法定代表人：' + identity[1]
            matched++
            trees.push({
              data: {
                text: value,
                autoFill: { version: 2, field, key: factKey(value, field) }
              },
              children: []
            })
            sources.push({
              sourceTitle: item.provenance?.sourceTitle || 'Wiki',
              roomId: item.provenance?.roomId || '',
              quote: raw
            })
            evidenceFor.set(trees[trees.length-1], sources[sources.length-1])
          }
        }
        if (heading) {
          const level = depth || heading[1].length
          while (stack.length && stack[stack.length - 1].level >= level)
            stack.pop()
          stack.push({ level, title: text })
        }
        const fieldIndex = stack
          .map(e => norm(e.title))
          .map(name =>
            Object.values(aliases)
              .flat()
              .some(alias => norm(alias) === name)
          )
          .lastIndexOf(true)
        const owner = stack
          .slice(0, fieldIndex >= 0 ? fieldIndex : stack.length)
          .reverse()
          .find(entry => /公司|Limited|Co\.,?\s*Ltd/i.test(entry.title))
        const nearestField =
          fieldIndex >= 0 ? norm(stack[fieldIndex].title) : ''
        if (
          !owner ||
          norm(owner.title) !== norm(company) ||
          !aliases[field].some(alias => norm(alias) === nearestField)
        )
          return
        matched++
        if (
          /^(?:19|20)\d{2}(?:年(?:\d{1,2}月(?:\d{1,2}日)?)?|[-/.]\d{1,2}(?:[-/.]\d{1,2})?)$/.test(
            text
          )
        )
          return
        if (
          aliases[field].some(alias => norm(alias) === norm(text)) ||
          /待核实|尚未找到|未找到资料|暂无资料/.test(text)
        )
          return
        if (field === '股东') {
          const ancestors = stack.slice(
            fieldIndex + 1,
            heading ? -1 : undefined
          )
          const nameCandidate =
            presentFillTrees([{ data: { text }, children: [] }], titles)
              .length > 0
          if (
            nameCandidate &&
            ancestors.some(
              e =>
                !(
                  /^(?:姓名|名称|名称或姓名|股东姓名|股东名称|股东姓名或名称|股东资料|股东信息|自然人股东|法人股东|主要股东|控股股东|股东[一二三四五六七八九十\d]*)$/.test(
                    e.title
                  ) ||
                  /^(?:19|20)\d{2}(?:年(?:\d{1,2}月(?:\d{1,2}日)?)?|[-/.]\d{1,2}(?:[-/.]\d{1,2})?)$/.test(
                    e.title
                  )
                )
            )
          )
            return
        }
        if (
          field === '股东' &&
          (/^(法定代表人|联系电话|电话|邮箱|联系人|注册地址)/.test(text) ||
            (!/股东|名称或姓名|出资|认缴|实缴|持股|股权|\d+(?:\.\d+)?\s*%/.test(
              text
            ) &&
              !presentFillTrees([{ data: { text }, children: [] }], titles)
                .length))
        )
          return
        if (
          field === '注册资本' &&
          !/\d[\d,]*(?:\.\d+)?\s*(?:万美元|万港元|万元|万|美元|港元|欧元|元)/.test(
            text
          )
        )
          return
        if (field === '注册地址' && !/[市区县路街镇号室楼]/.test(text)) return
        if (
          field === '法人代表' &&
          (!/^(?:(?:法人代表|法定代表人)[：:\s]*)?[\u4e00-\u9fff·]{2,10}$/.test(
            text
          ) ||
            /由|担任|签署|出现|应当|可以|不得|任期|必须|是代表|一般|签字|职权|委托/.test(
              text
            ))
        )
          return
        if (field === '经营许可') {
          const next =
            rows
              .slice(rowIndex + 1, rowIndex + 8)
              .map(r => visibleText(r.raw))
              .find(Boolean) || ''
          const compact = licenseTexts(raw, next).join('；')
          if (!compact) return
          text = compact
        }
        const historical = stack
          .map(e => e.title)
          .reverse()
          .find(title =>
            /^(?:19|20)\d{2}(?:年(?:\d{1,2}月(?:\d{1,2}日)?)?|[-/.]\d{1,2}(?:[-/.]\d{1,2})?)$/.test(
              title
            )
          )
        if (historical && !text.includes(historical))
          text = historical + '；' + text
        if (
          /^(?:19|20)\d{2}(?:年(?:\d{1,2}月(?:\d{1,2}日)?)?|[-/.]\d{1,2}(?:[-/.]\d{1,2})?)$/.test(
            visibleText(raw)
          )
        )
          return
        sources.push({
          sourceTitle: item.provenance?.sourceTitle || 'Wiki',
          roomId: item.provenance?.roomId || '',
          section: stack.map(e => e.title).join(' → '),
          quote: raw
        })
        trees.push({
          data: {
            text,
            autoFill: {
              version: 2,
              field,
              key: factKey(text, field),
              sourceKind: 'wiki',
              currency:
                field === '注册资本'
                  ? capitalCurrency(
                      text,
                      /[\d,]+\s*万(?!元|美|港)/.test(text)
                        ? 'UNSPECIFIED'
                        : 'CNY'
                    )
                  : '',
              dateKind: historical ? 'source' : 'unknown',
              granularity:
                field === '注册地址' &&
                (/注册城市|注册地区/.test(nearestField) ||
                  !/[路街镇号室楼]/.test(text))
                  ? 'region'
                  : 'detail'
            }
          },
          children: []
        })
        evidenceFor.set(trees[trees.length-1], sources[sources.length-1])
      })
    }
  } else {
    parsed = results.length
    for (const item of results || []) {
      const pages = [{text:evidenceRows(item.content, options).map(r => r.raw).join('\n')}]
      const facts = extractValues(pages, titles)
      const related = ['申请号','类别','申请日期'].flatMap(label => extractValues(pages,[...titles.slice(0,-1),label]).map(r => ({field:label,text:r.text})))
      const linked = new Set(related.filter(r=>r.field==='申请号').map(r=>r.text)).size === 1 ? related : []
      if (facts.notWrittenReason) sources.push({ sourceTitle: item.provenance?.sourceTitle || 'Wiki', notWrittenReason: facts.notWrittenReason })
      matched += facts.length
      for (const fact of facts) {
        trees.push({ data: { text: fact.text, autoFill: { version: 2, field, key: factKey(fact.text, field), multi: fact.multi, effectiveDate: fact.effectiveDate } }, children: [] })
        sources.push({ sourceTitle: item.provenance?.sourceTitle || 'Wiki', quote: fact.quote, line: fact.line, matchBasis: fact.matchBasis, related: fact.recordId ? [{field:'报告编号',text:fact.recordId},{field:'样品中文名称',text:fact.sample || '原文未明确样品名称'},{field:'归属角色',text:fact.reportRole}] : linked })
        evidenceFor.set(trees[trees.length-1], sources[sources.length-1])
      }
    }

  }
  let reason = !results.length
    ? 'no_results'
    : !parsed
    ? 'parse_error'
    : !matched
    ? 'no_match'
    : !trees.length
    ? 'empty_field'
    : 'success'
  if (
    field === '股东' &&
    reason === 'success' &&
    !presentFillTrees(trees, titles).length
  )
    reason = 'empty_field'
  if (!aliases[field]) {
    const selected = latestValues(trees.map(t => ({ ...t.data.autoFill, tree: t })), field).map(r => r.tree)
    trees.splice(0, trees.length, ...selected)
  }
  const seen = new Set(factKeys(existingTexts, field))
  const unique = []
  const keys = factKeys(
    trees.map(t => t.data.text),
    field
  )
  for (const [index, tree] of trees.entries()) {
    const key = keys[index]
    tree.data.autoFill.key = key
    if (!seen.has(key)) {
      seen.add(key)
      unique.push(tree)
    }
  }
  if (
    factsConflict(
      trees.map(t => t.data.text),
      field
    )
  )
    reason = 'conflict'
  if (
    field === '股东' &&
    reason === 'success' &&
    !presentFillTrees(unique, titles).length
  )
    reason = 'already_exists'
  if (!aliases[field] && valuesConflict(trees.map(t => ({ text: t.data.text, multi: t.data.autoFill?.multi })))) reason = 'conflict'
  if (reason === 'success' && !unique.length) reason = 'already_exists'
  return {
    reason,
    ...(reason === 'conflict' ? (() => {
      const candidates = candidatesFor(trees.map(t => ({ text:t.data.text, ...t.data.autoFill, ...(evidenceFor.get(t) || {quote:t.data.text,sourceTitle:'Wiki'}) })),field).map(({row,...c})=>c)
      const recordSelection = multipleReports(candidates,field)
      const multiple = true
      return {conflictCandidates:candidates,selectionMode:multiple?'multiple':'single',conflictKind:recordSelection?'multiple_records':'contradiction'}
    })() : {}),
    trees: reason === 'success' ? unique : [],
    sources,
    warnings: [],
    matchBasis: aliases[field] ? 'dedicated-field' : 'explicit-field-value',
    notWrittenReason: reason === 'success' ? null : sources.find(s => s.notWrittenReason === 'value_invalid')?.notWrittenReason || sources.find(s => s.notWrittenReason === 'subject_unconfirmed')?.notWrittenReason || reason
  }
}

export function fillStatus(result) {
  if (result.notWrittenReason === 'field_empty' && !result.previewTrees?.length) return '已读取原文中该字段未填写，未补入' + (result.coverage?.pending ? '；其他资料正在后台核查' : '')
  if (!result.coverage?.pending && !result.trees?.length && !result.previewTrees?.length) {
    const messages = { field_empty: '原文中该字段未填写，未补入', subject_unconfirmed: '资料已读取，但无法确认该字段所属公司，未补入', value_invalid: '资料已读取，但字段值未通过校验，未补入', field_value_unmatched: '资料已读取，但未找到明确对应的字段值，未补入', field_not_found: '资料已读取，但未命中目标字段，未补入' }
    if (messages[result.notWrittenReason] && !['conflict','already_exists'].includes(result.reason)) return messages[result.notWrittenReason]
  }
  if (result.reason === 'local_entity_required')
    return '请在具体公司下选择该字段后补齐，未新增子节点'
  if (result.reason === 'local_company_not_found')
    return '未找到该公司的独立资料，未新增子节点'
  if (result.reason === 'already_exists') return '已有相同内容，未新增子节点'
  if (result.reason === 'local_no_match' && !result.coverage?.pending)
    return (
      '已检索该公司的资料，但未提取到明确的' +
      (result.field || result.nodeLabel || '字段') +
      '原文；不代表该信息不存在'
    )

  const mineruMessages = {
    MINERU_NOT_CONFIGURED: 'MinerU 密钥未配置',
    MINERU_AUTH_FAILED: 'MinerU 曾认证失败，正在等待自动验证恢复',
    MINERU_ACCESS_DENIED: 'MinerU 请求或任务访问被拒绝',
    MINERU_RATE_LIMITED: 'MinerU 请求限流，请稍后重试',
    MINERU_TIMEOUT: 'MinerU 解析超时，后台任务可恢复',
    MINERU_NETWORK_ERROR: 'MinerU 网络请求失败',
    MINERU_FORMAT_REJECTED: 'MinerU 未接受该文件格式',
    MINERU_QUOTA_EXCEEDED: 'MinerU 解析额度已用完',
    MINERU_CONVERSION_FAILED: 'MinerU 文件转换失败',
    MINERU_PARSE_FAILED: 'MinerU 文件解析失败',
    MINERU_EMPTY_RESULT: 'MinerU 返回空正文，资料尚未读取',
    MINERU_INVALID_RESULT: 'MinerU 结果不完整或无效'
  }
  const mineruWarning = result.warnings?.find(w => mineruMessages[w.code])
  if (result.coverage && result.previewTrees) {
    const c = result.coverage
    const names = result.previewTrees
      .map(t => visibleText(t.data.text))
      .join('、')
    const state = result.written
      ? `已补入 ${result.written} 条${
          result.incomplete ? '，后台继续核查' : ''
        }`
      : result.reason === 'local_revision_changed'
      ? '资料已变化，请查看更新后的预览'
      : result.reason === 'conflict'
      ? '资料存在冲突，不能写入'
      : result.canCommit
      ? result.incomplete
        ? '已核实原文可补入，资料未核查完整'
        : '已核实原文可补入'
      : c.pending
      ? '后台核查中'
      : !result.canCommit
      ? result.previewTrees.length
        ? '暂未取得可写入原文'
        : '未找到可写入内容'
      : '已核实原文可补入'
    return (
      `${names ? '已找到：' + names + '；' : ''}${state}；已读取 ${c.read}/${
        c.total
      }，待处理 ${c.pending}，失败 ${c.failed}，未支持 ${c.unsupported}` +
      (mineruWarning ? '；' + mineruMessages[mineruWarning.code] : '')
    )
  }
  const warning = mineruWarning
    ? '；' + mineruMessages[mineruWarning.code]
    : result.warnings?.length
    ? result.warnings.every(w => w.code === 'date_unconfirmed')
      ? '；资料日期未确认，请核对来源'
      : '；部分资料未完整读取，请核对来源'
    : ''
  if (result.written)
    return `已新增 ${result.written} 条子节点${
      (result.trees || []).some(t => t.data.autoFill?.granularity === 'region')
        ? '；来源仅提供注册地区，未提供完整地址'
        : ''
    }${warning}`
  const messages = {
    no_results: 'Wiki 未返回资料',
    no_match: 'Wiki 未找到明确字段值',
    empty_field: 'Wiki 条目没有有效资料',
    already_exists: '对应内容已存在，未新增子节点',
    conflict: '资料存在冲突，请核对来源，未新增子节点',
    parse_error: 'Wiki 资料解析失败，未新增子节点',
    local_not_configured: '尚未配置本地资料目录',
    local_root_unavailable: '本地资料目录不可访问',
    local_room_required: '请先打开已保存的协作脑图，再检索本地资料',
    local_no_match: '本地资料未找到明确字段值，未新增子节点',
    local_mineru_unavailable:
      mineruMessages[mineruWarning?.code] || '相关资料尚未完成 MinerU 解析',
    local_company_not_found:
      '未找到与该公司完整名称精确匹配的本地资料；不会套用总公司或其他公司的内容',
    local_read_failed: '相关本地资料未完整读取，未新增子节点',
    local_historical_only:
      '只可靠读取到变更前资料，未补入当前信息，请核对变更后原件',
    local_index_updating:
      '资料索引正在后台建立，候选资料尚未完整读取，请稍后再补齐'
  }
  const sources =
    result.reason === 'conflict' && result.sources?.length
      ? '；来源：' +
        result.sources
          .map(source => source.sourceTitle.split(/[\\/]/).pop())
          .join('、')
      : ''
  if (result.reason === 'local_no_match' && result.matchedCompanyFiles)
    return `已检索该公司的本地资料，但未提取到明确的${
      result.field === '股东' ? '股东姓名' : result.field || '字段内容'
    }；不代表该信息不存在${warning}`
  return (messages[result.reason] || '未新增子节点') + sources + warning
}
