const { candidatesFor, selectCandidates, multipleReports } = require('../../src/utils/fillConflict')
const { extractValues, valuesConflict, latestValues, normalizeField } = require('../../src/utils/genericFill')
const fs = require('node:fs/promises')
const crypto = require('node:crypto')
const path = require('node:path')
const { extractDocument } = require('./extract')
const { configuredRoots, createMultiIndex } = require('./multiIndex')
const { dates, documentDate } = require('./dates')
const {
  visibleText,
  factKey,
  factKeys,
  presentFillTrees,
  capitalCurrency
} = require('../../src/utils/fillFacts')

const ALIASES = {
  注册地址: ['注册地址', '注册住所', '住所地址', '登记地址', '住所', '注册城市', '注册地区'],
  注册资本: ['注册资本', '注册资金'],
  经营许可: ['经营许可', '经营许可证'],
  股东: ['股东', '股东及出资', '股东及出资情况', '股东信息'],
  法人代表: ['法人代表', '法定代表人']
}
const { formatFor } = require('./formats')
const { licenseTexts } = require('../../src/utils/licenseFacts')
const BROAD =
  /^(知识|中心主题|分支主题|子主题|概要|提供|模块|填写|补充数据|.*集团包括)$/
const norm = text =>
  String(text || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s/g, '')
    .replace(/[·・：:_—-]/g, '')
const isCompany = text => /公司|Limited|Co\.,?\s*Ltd/i.test(text)
const directoryName = text =>
  norm(text.replace(/[-_ ]?(?:资质|资料|文件|档案)$/, ''))
const inside = (root, file) => {
  const relative = path.relative(root, file)
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
}
function abort(signal) {
  if (signal?.aborted)
    throw Object.assign(new Error('已取消'), { name: 'AbortError' })
}
function context(titles) {
  const field = normalizeField(titles.at(-1))
  const company = titles.slice(0, -1).reverse().find(isCompany) || ''
  const entity =
    (ALIASES[field] && company) ||
    titles
      .slice(0, -1)
      .reverse()
      .find(t => !BROAD.test(t) && !/^[CPDA][：:]/i.test(t)) ||
    ''
  return { field, company, entity, aliases: ALIASES[field] || [field] }
}
function companyScope(relative, company) {
  const dirs = relative.split(/[\\/]/).slice(0, -1)
  const named = dirs.filter(isCompany)
  return named.length ? directoryName(named.at(-1)) === norm(company) : null
}
function selectFacts(pages, titles, relative, method) {
  const { field, company, entity, aliases } = context(titles)
  if (!field || BROAD.test(field) || (ALIASES[field] && !company)) return []
  const scope = company ? companyScope(relative, company) : null
  if (scope === false) return []
  if (!ALIASES[field]) {
    const values = extractValues(pages, titles)
    const facts = values.map(f => ({ ...f, file: relative, method, date: '', owner: '', values: {} }))
    facts.notWrittenReason = values.notWrittenReason
    return facts
  }
  const facts = []
  const namedHeaders = new Set(
    pages
      .flatMap(p => String(p.text || '').split(/\r?\n/))
      .map(line =>
        visibleText(line)
          .replace(/^(?:公司名称|企业名称|名称)[：:\s]*/, '')
          .replace(/章程$/, '')
          .trim()
      )
      .filter(
        line =>
          /(?:公司|Limited|Ltd\.?)$/i.test(line) &&
          !/[：:，,；;（）()]/.test(line)
      )
      .map(norm)
  )
  const mixedCompany = namedHeaders.size > 1
  const issuedDate = mixedCompany ? '' : documentDate(pages)
  const dateEvidence = issuedDate
    ? pages
        .filter(p => dates(p.text).includes(issuedDate))
        .map(p => ({ page: p.page ?? null, date: issuedDate }))
    : []
  let activeCompany = scope === true ? company : ''
  let personalSection = false
  let scopedDate = issuedDate
  for (const page of pages) {
    const lines = String(page.text || '').split(/\r?\n/)
    const pageText = norm(page.text)
    if (company && scope !== true && !pageText.includes(norm(company))) continue
    if (
      entity &&
      entity !== company &&
      !norm(relative).includes(norm(entity)) &&
      !pageText.includes(norm(entity))
    )
      continue
    let active = false
    let budget = 0
    let date = scopedDate
    let currentOwner = ''
    let columns = []
    let licenseDate = issuedDate
    let pendingField = '',
      bareNameSection = false
    for (let i = 0; i < lines.length; i++) {
      let quote = lines[i].trim()
      let raw = visibleText(quote)
      if (!raw) continue
      if (field === '注册地址' && raw === '住所地址') {
        let before = i - 1
        while (before >= 0 && !visibleText(lines[before])) before--
        let after = i + 1
        while (after < lines.length && !visibleText(lines[after])) after++
        const left = visibleText(lines[before]),
          right = visibleText(lines[after])
        if (
          /[市区县]/.test(left) &&
          right &&
          !/地址|备案|电话|姓名|日期/.test(right)
        ) {
          quote = lines.slice(before, after + 1).join('\n')
          raw = '住所地址：' + left + right
          i = after
        }
      }
      if (pendingField) {
        const prior = pendingField
        pendingField = ''
        if (
          !Object.values(ALIASES)
            .flat()
            .some(alias => norm(raw).startsWith(norm(alias)))
        )
          raw = prior + '：' + raw
      }
      const line = norm(raw)
      if (/^第[一二三四五六七八九十\d]+章/.test(raw))
        personalSection = /股东/.test(raw)
      if (/^(?:名称或姓名|股东姓名或名称|股东姓名|股东名称)[：:\s]/.test(raw))
        personalSection = true
      const header = raw
        .replace(/^#{1,6}\s*/, '')
        .replace(/^(?:公司名称|企业名称|名称)[：:\s]*/, '')
        .replace(/(?:章程|[-_ ]资质)$/, '')
        .trim()
      if (
        company &&
        /(?:公司|Limited|Ltd\.?)$/i.test(header) &&
        !/[：:，,；;（）()]/.test(header) &&
        !/^股东/.test(header)
      ) {
        activeCompany = header
        active = false
        currentOwner = ''
        if (mixedCompany) {
          date = ''
          scopedDate = ''
        }
        continue
      }
      if (company && activeCompany && norm(activeCompany) !== norm(company))
        continue
      const dateMatch = raw.match(
        /(?:19|20)\d{2}\s*(?:年(?:\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?)?|[-/.]\d{1,2}(?:[-/.]\d{1,2})?)/
      )
      if (dates(raw).length === 1) date = scopedDate = dates(raw)[0]
      else if (
        dateMatch &&
        !/(?:年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|[-/.]\d{1,2}[-/.]\d{1,2})/.test(
          dateMatch[0]
        )
      )
        date = scopedDate = dateMatch[0].replace(/\s/g, '')
      if (
        field === '注册资本' &&
        /^(?:变更前|变更后).*注册(?:资本|资金)/.test(raw)
      ) {
        const temporal = raw.startsWith('变更前') ? 'before' : 'after'
        let combined = raw
        for (
          let j = i + 1;
          j < Math.min(lines.length, i + 4) &&
          !/[\d,]+(?:\.\d+)?\s*(?:万?元)/.test(combined);
          j++
        ) {
          const next = visibleText(lines[j])
          if (/^变更|股东|住所|地址|日期|税务/.test(next)) break
          combined += ' ' + next
        }
        const value =
          combined.match(/([\d,]+(?:\.\d+)?)\s*(万元|元)/) ||
          combined.match(/(?:总额|资本|资金)[^\d]{0,30}([\d,]+(?:\.\d+)?)/)
        const unit =
          value?.[2] ||
          (/万元/.test(combined)
            ? '万元'
            : /\(元\)|（元）/.test(combined)
            ? '元'
            : '')
        if (value && unit) {
          const currency =
            combined.match(
              /人民币|美元|美金|港币|港元|欧元|日元|USD|HKD|EUR|JPY|CNY|RMB/i
            )?.[0] || ''
          facts.push({
            text:
              (date ? '资料日期：' + date + '；' : '资料日期未确认；') +
              (temporal === 'before' ? '变更前' : '变更后') +
              '注册资本' +
              (currency ? '（' + currency + '）' : '') +
              '：' +
              value[1] +
              unit,
            date,
            temporal,
            quote: combined,
            file: relative,
            page: page.page ?? null,
            line: i + 1,
            method: page.method || method || 'text',
            dateEvidence,
            currency: capitalCurrency(combined)
          })
          continue
        }
      }
      if (field === '经营许可') {
        const named =
          raw.match(
            /[\u4e00-\u9fffA-Za-z]+(?:有限公司(?:[\u4e00-\u9fff]+分公司)?|股份公司)/g
          ) || []
        if (company && named.some(n => norm(n) !== norm(company))) continue
        const next = visibleText(lines[i + 1])
        const values = licenseTexts(quote, next)
        for (const value of values)
          facts.push({
            text:
              (licenseDate ? '资料日期：' + licenseDate + '；' : '') + value,
            date: licenseDate,
            quote:
              quote +
              (!licenseTexts(quote).length && next ? '\n' + lines[i + 1] : ''),
            file: relative,
            page: page.page ?? null,
            line: i + 1,
            method: page.method || method || 'text',
            dateEvidence
          })
        const previous = facts.at(-1)
        if (
          !values.length &&
          previous?.file === relative &&
          previous.page === (page.page ?? null) &&
          i + 1 - previous.line <= 2 &&
          /^有效(?:期|期限|至|截止)[：:\s]/.test(raw) &&
          /(?:19|20)\d{2}/.test(raw)
        ) {
          previous.text += '；' + raw
          previous.quote += '\n' + quote
        }
        continue
      }
      let hit = aliases.some(alias => line.includes(norm(alias)))
      if (field === '股东') {
        if (/签名|签字|签署|见证/.test(raw)) {
          active = false
          continue
        }
        hit =
          /^(?:第[一二三四五六七八九十\d]+[章条]\s*)?(?:公司)?股东(?:共|[：:,，]|名称|姓名|信息|及出资|出资额|$)/.test(
            raw
          )
        if (
          /^第[一二三四五六七八九十\d]+章/.test(raw) &&
          !/^第[一二三四五六七八九十\d]+章\s*股东$/.test(raw)
        ) {
          active = false
        }
      }
      const other = Object.entries(ALIASES).some(
        ([key, names]) =>
          key !== field && names.some(name => line.startsWith(norm(name)))
      )
      if (
        other ||
        (/^(法定代表人|董事|监事|经理|经办人|签署人|联系人|联系电话|电话|邮箱|住址|身份证)/.test(
          raw
        ) &&
          field === '股东')
      ) {
        active = false
        continue
      }
      if (hit) {
        active = true
        budget = 12
        if (field === '股东')
          bareNameSection = aliases.some(alias => norm(alias) === line)
      } else if (active) budget--
      if (!ALIASES[field] && (!hit || !raw.match(/[：:]\s*\S|\|.+\|/))) continue
      if (!hit && (!active || budget <= 0)) continue
      if (/待核实|尚未找到|未找到资料|暂无资料/.test(raw)) continue
      if (field === '股东') {
        // Bare names and signatures are never interpreted as shareholders.
        if (/股东/.test(raw) && /比例|持股/.test(raw) && !/\d/.test(raw)) {
          columns = [
            ...raw.matchAll(
              /认缴(?:出资额)?|实缴(?:出资额)?|出资比例|持股比例|持股/g
            )
          ].map(m =>
            /比例|持股/.test(m[0])
              ? '比例'
              : m[0].startsWith('认缴')
              ? '认缴'
              : '实缴'
          )
          continue
        }
        if (
          /股权质押|出质人|质权人|甲方|乙方/.test(raw) &&
          !/股东|持股|认缴|实缴/.test(raw)
        )
          continue
        if (/身份证|主体资格证明|^住所|^住址/.test(raw)) continue
        if (
          !/\d+(?:\.\d+)?\s*(?:万元|%)/.test(raw) &&
          !/^(名称或姓名|股东姓名或名称|股东姓名|股东名称|股东)[：:\s]+\S+/.test(
            raw
          ) &&
          !/^出资方式\s*[:：]?\s*\S+/.test(raw) &&
          !(
            bareNameSection &&
            presentFillTrees([{ data: { text: raw }, children: [] }], titles)
              .length
          )
        )
          continue
        if (
          /^(?:第[一二三四五六七八九十\d]+条\s*)?股东(?:会|应当|有权|享有|承担|会议|决定|行使)/.test(
            raw
          )
        )
          continue
        if (
          /^第[一二三四五六七八九十\d]+章/.test(raw) ||
          /^(?:第[一二三四五六七八九十\d]+条\s*)?公司股东共/.test(raw)
        )
          continue
        if (
          /^第[一二三四五六七八九十\d]+条/.test(raw) &&
          !/\d+(?:\.\d+)?\s*(?:万元|%)/.test(raw) &&
          !/股东[：:]/.test(raw)
        )
          continue
      }
      if (aliases.some(alias => line === norm(alias))) {
        if (['注册地址', '注册资本', '法人代表'].includes(field))
          pendingField = field
        continue
      }
      // A row explicitly referring to a different company must not leak into this scope.
      const named =
        raw.match(
          /[\u4e00-\u9fffA-Za-z]+(?:有限公司(?:[\u4e00-\u9fff]+分公司)?|股份公司)/g
        ) || []
      if (
        ALIASES[field] &&
        field !== '股东' &&
        company &&
        named.some(name => norm(name) !== norm(company))
      )
        continue
      if (
        field === '注册地址' &&
        (!hit ||
          !/^(?:(?:第[一二三四五六七八九十\d]+条)\s*)?(?:公司)?(?:注册地址|注册住所|住所地址|登记地址|住所)[：:\s]/.test(
            raw
          ) ||
          (personalSection && !/^(?:公司|注册)/.test(raw)) ||
          !/[市区县路街镇号室楼]/.test(raw))
      )
        continue
      if (field === '注册地址' && /[（(]/.test(raw) && !/[）)]/.test(raw)) {
        for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
          const next = visibleText(lines[j])
          if (!next) continue
          if (!/[）)]/.test(next)) break
          raw +=
            (/[\u4e00-\u9fff]$/.test(raw) && /^[\u4e00-\u9fff]/.test(next)
              ? ''
              : ' ') + next
          i = j
          break
        }
      }
      if (
        field === '注册资本' &&
        (!hit ||
          !/\d[\d,]*(?:\.\d+)?\s*(?:万美元|万港元|万元|万|美元|港元|欧元|元)/.test(
            raw
          ))
      )
        continue
      if (
        field === '法人代表' &&
        (!hit ||
          !/^(?:公司)?(?:法人代表|法定代表人)[：:\s]*[\u4e00-\u9fff·]{2,10}$/.test(
            raw
          ) ||
          /由|担任|签署|出现|应当|可以|不得|任期|必须|是代表|一般|签字|职权|委托/.test(
            raw
          ))
      )
        continue
      const text =
        (date && !raw.includes(date) ? '资料日期：' + date + '；' : '') + raw
      const values = {}
      if (field === '股东') {
        const owner = raw.match(
          /^(?:名称或姓名|股东姓名或名称|股东名称|股东姓名|股东)[：:\s]+([^，,；;：:\s]{2,40})/
        )
        if (owner) currentOwner = owner[1]
        const tableOwner =
          columns.length &&
          raw.match(/^([\u4e00-\u9fffA-Za-z]{2,40})[\s,，|]+\d/)
        if (tableOwner) {
          currentOwner = tableOwner[1]
          const cells = [
            ...raw
              .slice(tableOwner[1].length)
              .matchAll(/\d+(?:\.\d+)?\s*(?:万元|%)/g)
          ].map(m => m[0].replace(/\s/g, ''))
          if (cells.length === columns.length)
            columns.forEach((key, index) => {
              values[key] =
                String(Number(cells[index].replace(/万元|%/g, ''))) +
                (key === '比例' ? '%' : '万元')
            })
        }
        for (const [key, pattern] of [
          [
            '比例',
            /(?:出资|岀资|持股|占比)?比例[：:\s]*([\d.]+)\s*%|持股[：:\s]*([\d.]+)\s*%/
          ],
          ['认缴', /认缴(?:出资额|出资|金额)?[：:\s]*([\d.]+)\s*万元/],
          ['实缴', /实缴(?:出资额|出资|金额)?[：:\s]*([\d.]+)\s*万元/]
        ]) {
          const match = raw.match(pattern)
          if (match)
            values[key] =
              String(Number(match[1] || match[2])) +
              (key === '比例' ? '%' : '万元')
        }
      }
      facts.push({
        text,
        date,
        quote,
        file: relative,
        page: page.page ?? null,
        line: i + 1,
        method: page.method || method || 'text',
        owner: currentOwner,
        values,
        dateEvidence
      })
    }
  }
  return facts
}
function conflicts(facts, field) {
  if (!ALIASES[field]) return valuesConflict(facts)
  const groups = new Map()
  for (const fact of facts) {
    const key = fact.date + '|' + (fact.temporal || '')
    const group = groups.get(key) || []
    group.push(fact)
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    if (
      ['注册地址', '注册资本', '法人代表'].includes(field) &&
      new Set(group.map(f => factKey(f.text, field, f.owner))).size > 1
    )
      return true
    if (field !== '股东') continue
    const sole = group
      .filter(f => /100\s*%|唯一股东|独资/.test(f.text))
      .map(f => f.text.match(/股东[：:]?\s*([^，,；;：:\s]{2,40})/))
      .filter(Boolean)
      .map(m => m[1])
    sole.push(
      ...group
        .filter(f => f.owner && f.values?.比例 === '100%')
        .map(f => f.owner)
    )
    if (new Set(sole).size > 1) return true
    const amounts = new Map()
    for (const fact of group) {
      if (fact.owner)
        for (const [kind, value] of Object.entries(fact.values || {})) {
          const key = fact.owner + kind
          if (amounts.has(key) && amounts.get(key) !== value) return true
          amounts.set(key, value)
        }
      const owner = fact.text.match(/股东[：:]?\s*([^，,；;：:\s]{2,40})/)
      if (!owner) continue
      for (const [kind, re] of [
        ['比例', /(?:持股|比例|占比)[：:]?\s*(\d+(?:\.\d+)?\s*%)/],
        ['认缴', /认缴(?:出资)?[：:]?\s*(\d+(?:\.\d+)?\s*万元)/],
        ['实缴', /实缴(?:出资)?[：:]?\s*(\d+(?:\.\d+)?\s*万元)/]
      ]) {
        const match = fact.text.match(re)
        if (!match) continue
        if (fact.values && fact.values[kind]) continue
        const key = owner[1] + kind
        const value = match[1].replace(/\s/g, '')
        if (amounts.has(key) && amounts.get(key) !== value) return true
        amounts.set(key, value)
      }
    }
  }
  return false
}
function createService({
  root = process.env.LOCAL_KNOWLEDGE_ROOT,
  roots,
  extract = extractDocument,
  cacheDir = process.env.LOCAL_KNOWLEDGE_CACHE_DIR ||
    path.resolve('data/local-knowledge-cache'),
  interval = 60000
} = {}) {
  const directories = configuredRoots(root, roots)
  const index = directories.length
    ? createMultiIndex({
        roots: directories,
        cacheDir,
        interval,
        extract: async (file, options) => {
          if (!formatFor(file))
            throw Object.assign(new Error('不支持的文件'), {
              code: 'unsupported'
            })
          return extract(file, options)
        }
      })
    : null
  const start = () => (index ? index.start() : Promise.resolve())
  const refresh = async () => {
    await start()
    await index.refresh({ retryErrors: true })
    return index.status()
  }
  async function fill(
    { titles, existingTexts = [], mode = 'commit', revision: expectedRevision, selectedCandidateIds },
    options = {}
  ) {
    abort(options.signal)
    if (!directories.length)
      return {
        reason: 'local_not_configured',
        trees: [],
        sources: [],
        warnings: []
      }
    const started = Date.now()
    options.onStatus?.('首次建立索引或检查缓存…')
    try {
      await start()
    } catch {
      return {
        reason: 'local_root_unavailable',
        trees: [],
        sources: [],
        warnings: []
      }
    }
    const warnings = (index.status().rootErrors || []).map(r=>({file:r.label,code:'root_read_failed'}))
    if (index.status().error)
      warnings.push({ file: '', code: 'index_incomplete' })
    const { field, company, entity, aliases } = context(titles)
    if (ALIASES[field] && !company)
      return {
        reason: 'local_entity_required',
        trees: [],
        previewTrees: [],
        canCommit: false,
        sources: [],
        warnings: [],
        coverage: { total: 0, read: 0, pending: 0, failed: 0, unsupported: 0 }
      }
    const companyFiles = company
      ? index.scoped(company, record => {
          const scope = companyScope(record.relative, company)
          return (
            scope === true ||
            (scope !== false &&
              norm(path.basename(record.relative)).includes(norm(company)))
          )
        })
      : []
    const files = company ? companyFiles : index.entries()
    if (company && !companyFiles.length)
      return {
        reason: warnings.some(w=>w.code==='root_read_failed') ? 'local_read_failed' : 'local_company_not_found',
        trees: [],
        previewTrees: [],
        canCommit: false,
        coverage: { total: 0, read: 0, pending: 0, failed: 0, unsupported: 0 },
        sources: [],
        warnings,
        field,
        company,
        scanned: 0,
        matchedCompanyFiles: 0
      }
    const candidates = files
      .filter(record => {
        const relative = record.relative
        const file = relative
        if (company) {
          const scoped =
            companyScope(relative, company) === true ||
            (companyScope(relative, company) !== false &&
              norm(path.basename(file)).includes(norm(company)))
          if (!scoped) return false
          if (ALIASES[field]) {
            const hints =
              field === '股东'
                ? /章程|股东|股权|出资|变更|备案|基础信息/
                : field === '经营许可'
                ? /许可|经营|备案|营业执照|章程|基础信息/
                : /营业执照|章程|变更|备案|基础信息|工商|登记/
            // Filename hints prioritize documents, but are not an exclusion gate.
            return (
              hints.test(path.basename(file)) ||
              aliases.some(alias =>
                norm(path.basename(file)).includes(norm(alias))
              ) ||
              !record.pages ||
              aliases.some(alias =>
                String(record.search || '').includes(norm(alias))
              )
            )
          }
          return true
        }
        // Generic documents may use opaque filenames; verify entity and target in the extracted body.
        return (
          !record.pages ||
          ((!entity || record.search.includes(norm(entity))) &&
            aliases.some(alias =>
              String(record.search || '').includes(norm(alias))
            ))
        )
      })
      .sort(
        (a, b) =>
          Number(/章程|股东|出资/.test(b.relative)) -
          Number(/章程|股东|出资/.test(a.relative))
      )
    const selectedAt = Date.now()
    const primary = candidates.filter(r =>
      field === '股东'
        ? /章程|股东|股权|出资|变更|备案|基础信息/.test(r.relative)
        : aliases.some(a => norm(r.relative).includes(norm(a))) ||
          /章程|变更|备案|营业执照|基础信息|工商|登记/.test(r.relative)
    )
    index.prioritize(primary, 2)
    index.prioritize(company ? companyFiles : candidates, 1)
    if (
      mode === 'commit' &&
      expectedRevision &&
      !(await index.verify(company ? companyFiles : candidates))
    ) {
      await index.refresh()
      return {
        ...(await fill({ titles, existingTexts, mode: 'preview' }, options)),
        reason: 'local_revision_changed',
        trees: []
      }
    }
    const scope = company ? companyFiles : candidates
    const coverage = {
      total: scope.length,
      read: scope.filter(r => r.pages).length,
      pending: scope.filter(r => !r.pages && !r.error).length,
      failed: scope.filter(r => r.error && r.error !== 'unsupported').length,
      unsupported: scope.filter(r => r.error === 'unsupported').length
    }
    const revision = crypto
      .createHash('sha256')
      .update(
        JSON.stringify([
          directories,
          process.env.LOCAL_KNOWLEDGE_SOURCE_ID || '',
          process.env.LOCAL_KNOWLEDGE_SHAREHOLDER_NAMES || '',
          titles,
          scope
            .map(r => [
              r.relative,
              r.fingerprint,
              r.parserKey,
              r.error || '',
              !!r.pages
            ])
            .sort((a, b) => a[0].localeCompare(b[0]))
        ])
      )
      .digest('hex')
    const finish = result => {
      const previewTrees = result.trees || []
      const incomplete =
        !!result.warnings?.some(w=>w.code==='root_read_failed') ||
        !!coverage.pending ||
        !!coverage.failed ||
        !!coverage.unsupported ||
        candidates.some(r => r.pages?.some(p => p.truncated))
      const changed =
        mode === 'commit' && expectedRevision && expectedRevision !== revision
      const canCommit =
        !index.status().error &&
        result.reason === 'success' &&
        previewTrees.length > 0
      const reason = changed
        ? 'local_revision_changed'
        : canCommit
        ? result.reason
        : coverage.pending && result.reason !== 'conflict'
        ? 'local_index_updating'
        : result.reason
      return {
        ...result,
        field,
        company,
        reason,
        previewTrees,
        coverage,
        relatedPending: coverage.pending,
        fieldMatchState: previewTrees.length ? 'matched' : result.notWrittenReason || result.reason,
        revision,
        canCommit,
        incomplete,
        trees: mode === 'commit' && canCommit && !changed ? previewTrees : []
      }
    }
    const extractedAt = Date.now()
    let facts = []
    const matchDiagnostics = []
    for (const record of candidates) {
      if (!files.includes(record)) {
        warnings.push({ file: record.relative, code: 'updating' })
        continue
      }
      if (record.error) {
        warnings.push({ file: record.relative, code: record.error })
        continue
      }
      if (!record.pages) continue
      const pages = record.pages
      if (entity && entity !== company && !record.search.includes(norm(entity)))
        continue
      const cached = record.factQueries || (record.factQueries = {})
      const key = JSON.stringify([
        company,
        entity,
        field,
        field === '经营许可' ? 'license-4' : ALIASES[field] ? 'facts-1' : 'generic-values-7'
      ])
      if (!cached[key]) {
        if (Object.keys(cached).length >= 32)
          delete cached[Object.keys(cached)[0]]
        cached[key] = selectFacts(pages, titles, record.relative)
        ;(record.factDiagnostics ||= {})[key] = cached[key].notWrittenReason
        index.markDirty()
      }
      if (!ALIASES[field] && record.factDiagnostics?.[key]) matchDiagnostics.push({ file: record.relative, code: record.factDiagnostics[key] })
      if (!ALIASES[field]) {
        const related = ['申请号','类别','申请日期'].flatMap(label => extractValues(pages, [...titles.slice(0,-1),label]).map(value => ({ field:label, text:value.text, page:value.page })))
        for (const fact of cached[key]) {
          const samePage = related.filter(r => r.page === fact.page)
          fact.related = fact.recordId ? [{field:'报告编号',text:fact.recordId},{field:'样品中文名称',text:fact.sample || '原文未明确样品名称'},{field:'归属角色',text:fact.reportRole}] : new Set(samePage.filter(r => r.field === '申请号').map(r => r.text)).size === 1 ? samePage : []
        }
      }
      facts.push(
        ...cached[key].map(f => ({
          ...f,
          file: record.relative,
          values: f.values ? { ...f.values } : undefined
        }))
      )
      if (pages.some(page => page.truncated))
        warnings.push({ file: record.relative, code: 'truncated' })
    }
    const metadata = {
      index: index.status(),
      matchedCompanyFiles: companyFiles.length,
      readCompanyFiles: companyFiles.filter(r => r.pages).length,
      timings: {
        indexMs: selectedAt - started,
        waitMs: extractedAt - selectedAt,
        matchMs: Date.now() - extractedAt,
        totalMs: Date.now() - started
      }
    }
    const sources = [...new Set(facts.map(f => f.file))].map(sourceTitle => ({
      sourceTitle,
      evidence: facts
        .filter(f => f.file === sourceTitle)
        .map(({ quote, page, line, method, date, dateEvidence, temporal, matchBasis, effectiveDate }) => ({
          quote,
          page,
          pageMissing: page == null,
          line,
          method,
          date,
          dateEvidence,
          temporal, matchBasis, effectiveDate
        }))
    }))
    if (
      field === '注册资本' &&
      facts.some(f => f.temporal === 'before') &&
      !facts.some(f => f.temporal === 'after')
    )
      return finish({
        reason: 'local_historical_only',
        trees: [],
        sources,
        warnings: [...warnings, { code: 'change_after_unreadable', file: '' }],
        ...metadata
      })
    facts = latestValues(facts, field)
    const unique = new Map()
    for (const fact of facts) {
      if (fact.temporal === 'before') continue
      if (['注册地址', '注册资本', '法人代表'].includes(field) && !fact.date) {
        fact.text = '资料日期未确认；' + fact.text
        warnings.push({ file: fact.file, code: 'date_unconfirmed' })
      }
      const key = factKey(fact.text, field, fact.owner)
      if (!unique.has(key)) unique.set(key, { ...fact, evidence: [] })
      unique.get(key).evidence.push(fact)
    }
    if (conflicts(facts, field)) {
      const allCandidates = candidatesFor(facts, field)
      const recordSelection = multipleReports(allCandidates,field)
      const multiple = true
      const conflictCandidates = allCandidates.map(({ row, ...c }) => c)
      if (!selectedCandidateIds || mode !== 'commit' || !expectedRevision || expectedRevision !== revision) return finish({ reason: 'conflict', trees: [], conflictCandidates, selectionMode: multiple ? 'multiple' : 'single', conflictKind:recordSelection ? 'multiple_records' : 'contradiction', sources, warnings, ...metadata })
      const selected = selectCandidates(allCandidates, selectedCandidateIds, multiple)
      unique.clear()
      for (const candidate of selected) unique.set(factKey(candidate.text, field), candidate.row)
    } else if (selectedCandidateIds) return finish({ reason: 'local_revision_changed', trees: [], sources, warnings, ...metadata })
    const seen = new Set(factKeys(existingTexts, field))
    let trees = [...unique.values()]
      .filter(f => !seen.has(factKey(f.text, field, f.owner)))
      .map(f => ({
        data: {
          text: f.text,
          autoFill: {
            version: 2,
            field,
            key: factKey(f.text, field, f.owner),
            owner: f.owner,
            date: f.date,
            temporal: f.temporal || '',
            dateKind: f.date ? 'document' : 'unknown'
          }
        },
        children: []
      }))
    const hasValidNames =
      field !== '股东' ||
      presentFillTrees(
        [...unique.values()].map(f => ({
          data: { text: f.text, autoFill: { owner: f.owner } },
          children: []
        })),
        titles
      ).length > 0
    if (field === '股东') {
      let names = {}
      try {
        names = JSON.parse(
          process.env.LOCAL_KNOWLEDGE_SHAREHOLDER_NAMES || '{}'
        )
      } catch {}
      const oldNames = presentFillTrees(
        existingTexts.map(text => ({ data: { text }, children: [] })),
        titles,
        names
      )
      for (const t of oldNames) seen.add(factKey(t.data.text, field))
      trees = presentFillTrees(trees, titles, names).filter(
        t => !seen.has(factKey(t.data.text, field))
      )
    }
    const reason = trees.length
      ? 'success'
      : unique.size && hasValidNames
      ? 'already_exists'
      : warnings.some(w => w.code?.startsWith('MINERU_'))
      ? 'local_mineru_unavailable'
      : warnings.length
      ? 'local_read_failed'
      : 'local_no_match'
    return finish({
      reason,
      trees,
      sources,
      warnings,
      field,
      matchBasis: ALIASES[field] ? 'dedicated-field' : 'explicit-field-value',
      notWrittenReason: trees.length ? null : reason === 'conflict' ? 'conflict' : matchDiagnostics.find(w => w.code === 'field_empty')?.code || matchDiagnostics.find(w => w.code === 'value_invalid')?.code || matchDiagnostics.find(w => w.code === 'subject_unconfirmed')?.code || matchDiagnostics.find(w => w.code === 'field_value_unmatched')?.code || 'field_not_found',
      company,
      scanned: candidates.length,
      ...metadata
    })
  }
  return {
    fill,
    start,
    refresh,
    status: () => ({
      ...index?.status(),
      parser: {
        provider: 'mineru',
        model: 'vlm',
        configured: !!process.env.MINERU_API_TOKEN
      }
    }),
    close: () => index?.close()
  }
}
module.exports = { createService, selectFacts, conflicts, inside }
