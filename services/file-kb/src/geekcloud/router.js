'use strict'
// Rule-based routing for smart_knowledge_query. Pure and deterministic so every decision is testable.
// JackYun is only reached when there is exactly one explicit SKU AND a real-time business intent.

const MODES = new Set(['auto', 'file_only', 'geekcloud_only', 'combined'])

const FILE_ONLY = /只查文件|仅查文件|只看文件|只查知识库|仅查知识库|只查资料库|不要?查吉客云|别查吉客云|不查吉客云|不要实时|file[_ ]only/i
const INTENT = {
  stock: /库存|现货|有货|缺货|在库|可用量|可用数|可售|还剩|剩多少|还有多少|多少件|stock|inventory/i,
  price: /价格|价目|售价|零售价|标价|多少钱|price/i,
  goods: /实时|商品资料|商品信息|商品详情|货品资料|货品信息|商品状态|品名|商品名|条码|品牌|分类|规格|单位|是什么商品|哪个商品/i,
  warehouse: /哪些仓库|仓库列表|我的仓库|可查仓库|可见仓库/i
}
const FILE_HINT = /文件|文档|附件|说明书|说明|手册|合同|SOP|制度|规范|流程|表格|报价单|资料说明|相关资料|知识库|记录/i

// Explicit labels win; bare tokens must look like codes (contain a digit) so words are never taken as SKUs.
const LABELED = /(?:sku|货号|货品编号|货品编码|商品编号|商品编码|产品编号|产品编码|编码|条码)\s*[:：=＝]?\s*([A-Za-z0-9][A-Za-z0-9._\-/]{1,63})/gi
const BARE = /(?<![A-Za-z0-9._\-/])([A-Za-z0-9][A-Za-z0-9._\-/]{3,63})(?![A-Za-z0-9._\-/])/g

function extractSkus(text) {
  const found = []
  const add = v => {
    const s = String(v).replace(/[._\-/]+$/, '')
    if (s && /\d/.test(s) && !found.includes(s)) found.push(s)
  }
  for (const m of text.matchAll(LABELED)) add(m[1])
  if (!found.length) {
    for (const m of text.matchAll(BARE)) {
      const tok = m[1]
      if (/^\d{4}-\d{1,2}(-\d{1,2})?$/.test(tok) || /^\d{1,3}$/.test(tok) || /^(19|20)\d{2}$/.test(tok)) continue
      if (/^\d+(\.\d+)?(ml|g|kg|mg|cm|mm|m|l|pcs)?$/i.test(tok) && !/^\d{6,}$/.test(tok)) continue
      add(tok)
    }
  }
  return found
}

function routeQuery({ query, mode = 'auto', includeFileContext } = {}) {
  const text = String(query == null ? '' : query).trim().slice(0, 500)
  const m = MODES.has(mode) ? mode : null
  if (!m) return { decision: 'invalid', error: 'bad_mode', reasons: ['mode 必须是 auto / file_only / geekcloud_only / combined'] }
  if (!text) return { decision: 'invalid', error: 'query_required', reasons: ['query 不能为空'] }

  const skus = extractSkus(text)
  const intents = Object.keys(INTENT).filter(k => INTENT[k].test(text))
  const realtime = intents.filter(k => k !== 'warehouse')
  const fileHint = FILE_HINT.test(text)
  const reasons = []
  const out = { decision: 'file', mode: m, query: text, sku: skus.length === 1 ? skus[0] : null, skus, intents, fileHint, reasons, clarification: null }

  if (m === 'file_only' || FILE_ONLY.test(text)) {
    reasons.push(m === 'file_only' ? 'mode=file_only' : '查询明确要求只查文件')
    out.decision = 'file'
    return out
  }

  const wantsGeek = m === 'geekcloud_only' || m === 'combined' || realtime.length > 0 || intents.includes('warehouse')
  if (intents.includes('warehouse') && !skus.length && m !== 'combined') {
    reasons.push('查询可见仓库')
    out.decision = 'geekcloud_warehouses'
    return out
  }
  if (!wantsGeek) {
    reasons.push(skus.length ? 'SKU 只作为文件筛选条件，未出现实时业务意图' : '普通文件查询')
    out.decision = 'file'
    return out
  }
  if (skus.length !== 1) {
    out.clarification = skus.length > 1
      ? `一次只能查询一个 SKU，检测到 ${skus.length} 个：${skus.slice(0, 5).join('、')}`
      : '需要提供精确的 SKU / 货品编号才能查询吉客云实时数据'
    reasons.push(skus.length > 1 ? '检测到多个 SKU' : '没有明确 SKU')
    out.decision = m === 'geekcloud_only' ? 'clarify' : 'file'
    return out
  }

  const want = { goods: true, stock: realtime.includes('stock'), price: realtime.includes('price') }
  if (!want.stock && !want.price && (!realtime.length || /实时|状态/.test(text))) want.stock = true
  out.want = want

  const withFiles = m === 'combined' || (m === 'auto' && (includeFileContext !== false || fileHint))
  if (m === 'geekcloud_only' || (m === 'auto' && includeFileContext === false && !fileHint)) {
    reasons.push('SKU + 实时业务意图，只查吉客云')
    out.decision = 'geekcloud'
  } else if (withFiles) {
    reasons.push(m === 'combined' ? 'mode=combined' : 'SKU + 实时业务意图，并补充文件资料')
    out.decision = 'combined'
  }
  return out
}

module.exports = { routeQuery, extractSkus, MODES }
