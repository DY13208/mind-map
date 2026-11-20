// Query-only adapter for the supplied jackyun-erp-operations skill (2026.08.26.1).
// Sources: helpers/jackyun_signature.py, modules/{sales_order,stock_doc,transfer,inventory,warehouse}.py.
// The approval engine cannot invoke the skill's create, audit, reject or pay operations.
const { createHash } = require('node:crypto')
const { warehouseStock } = require('./jackyunInventory')

const VERSION = '2026.08.26.1'
const DEFAULT_URL = 'https://open.jackyun.com/open/openapi/do'
const METHODS = {
  sales_order: {
    label: '销售单/网店订单', method: 'oms.trade.fullinfoget',
    identifiers: { tradeNo: ['tradeNo', 'billNo'], sourceTradeNos: ['onlineTradeNo', 'sourceTradeNo'] },
    containers: ['trades'],
    defaults: { fields: [
      'tradeNo', 'billNo', 'onlineTradeNo', 'shopName', 'shopCode', 'tradeType',
      'totalFee', 'payment', 'payStatus', 'tradeTime', 'consignTime', 'remark',
      'tradeStatus', 'tradeStatusExplain', 'warehouseName', 'warehouseCode',
      'logisticName', 'logisticCode', 'flagNames', 'customerName',
      'goodsDetail.goodsNo', 'goodsDetail.goodsName', 'goodsDetail.specName', 'goodsDetail.barcode',
      'goodsDetail.sellCount', 'goodsDetail.sellPrice', 'goodsDetail.sellTotal',
      'goodsDetail.isGift', 'goodsDetail.goodsDelivery.batchNo',
      'goodsDetail.goodsDelivery.sendCount'
    ].join(',') }
  },
  stock_out: {
    label: '出库单', method: 'erp.storage.goodsdocout.v2',
    identifiers: { goodsdocNo: ['goodsdocNo'], billNo: ['billNo'], outBillNo: ['outBillNo'] },
    containers: [], defaults: { selelctFields: [
      'recId', 'goodsdocNo', 'billNo', 'outBillNo', 'checkStatus', 'inouttype',
      'warehouseName', 'channelName', 'gmtCreate', 'gmtModified', 'logisticNo',
      'logisticName', 'goodsDocDetailList.goodsNo', 'goodsDocDetailList.goodsName',
      'goodsDocDetailList.quantity', 'goodsDocDetailList.unitPrice'
    ].join(',') }
  },
  stock_in: {
    label: '入库单', method: 'erp.storage.goodsdocin.v2',
    identifiers: { goodsdocNo: ['goodsdocNo'], billNo: ['billNo'] }, containers: [],
    defaults: { selelctFields: [
      'recId', 'goodsdocNo', 'billNo', 'checkStatus', 'inouttype', 'warehouseName',
      'channelName', 'gmtCreate', 'gmtModified', 'goodsDocDetailList.goodsNo',
      'goodsDocDetailList.goodsName', 'goodsDocDetailList.quantity', 'goodsDocDetailList.unitPrice'
    ].join(',') }
  },
  transfer: {
    label: '调拨单', method: 'erp.allocate.get',
    identifiers: { allocateNos: ['allocateNo'] }, containers: ['stockAllocate']
  },
  stock_in_apply: {
    label: '入库申请单', method: 'erp.stockin.get.v2',
    identifiers: { inNo: ['inNo'], relDataId: ['relDataId'] }, containers: ['stockInList', 'stockin'],
    defaults: { cols: [
      'inNo', 'relDataId', 'inType', 'inTypeName', 'inStatus', 'inWarehouseCode',
      'inWarehouseName', 'applyDate', 'gmtCreate', 'gmtModified', 'goodsNo',
      'goodsName', 'skuName', 'skuCount', 'skuPrice', 'goodsTotalAmount', 'totalAmount',
      'totalSkuCount', 'innerCount', 'uninnerCount', 'batchNo', 'memo'
    ].join(',') }
  },
  stock_out_apply: {
    label: '出库申请单', method: 'erp.stockout.get.v2',
    identifiers: { outNo: ['outNo'], relDataId: ['relDataId'] }, containers: ['stockOutList', 'stockout'],
    defaults: { cols: [
      'outNo', 'relDataId', 'outType', 'outTypeName', 'status', 'outStatus',
      'outWarehouseCode', 'outWarehouseName', 'applyDate', 'gmtCreate', 'goodsNo',
      'goodsName', 'skuName', 'skuCount', 'skuPrice', 'goodsTotalAmount', 'totalAmount',
      'totalSkuCount', 'outedCount', 'unOutedCount', 'batchNo', 'memo'
    ].join(',') }
  }
}
const BUSINESS_FIELDS = new Set([
  'tradeNo', 'billNo', 'onlineTradeNo', 'sourceTradeNo', 'goodsdocNo', 'outBillNo',
  'allocateNo', 'inNo', 'outNo', 'relDataId', 'recId', 'shopName', 'shopCode',
  'tradeType', 'totalFee', 'payment', 'payStatus', 'tradeTime', 'consignTime',
  'remark', 'tradeStatus', 'tradeStatusExplain', 'warehouseName', 'warehouseCode',
  'inWarehouseCode', 'inWarehouseName', 'outWarehouseCode', 'outWarehouseName',
  'channelName', 'channelCode', 'customerName', 'checkStatus', 'inouttype',
  'gmtCreate', 'gmtModified', 'createTime', 'applyDate', 'auditDate', 'status',
  'inStatus', 'outStatus', 'inType', 'outType', 'logisticNo', 'logisticName',
  'logisticCode', 'flagNames', 'goodsNo', 'goodsName', 'skuName', 'specName',
  'quantity', 'unitPrice', 'sellCount', 'sellPrice', 'sellTotal', 'amount', 'barcode', 'skuBarcode',
  'totalAmount', 'totalMoney', 'price', 'unit', 'batchNo', 'sendCount', 'isGift',
  'inTypeName', 'outTypeName', 'skuCount', 'skuPrice', 'goodsTotalAmount',
  'totalSkuCount', 'innerCount', 'uninnerCount', 'outedCount', 'unOutedCount', 'memo',
  'goodsDetail', 'goodsDelivery', 'goodsDocDetailList', 'detailList',
  'goodsList', 'stockInDetailList', 'stockOutDetailList', 'stockAllocateDetailList'
])

function config(env = process.env) {
  const timeout = Number(env.JACKYUN_API_TIMEOUT_MS)
  return {
    enabled: env.JACKYUN_APPROVAL_ENABLED !== '0',
    appKey: String(env.JACKYUN_APP_KEY || '').trim(),
    appSecret: String(env.JACKYUN_APP_SECRET || '').trim(),
    url: String(env.JACKYUN_API_URL || DEFAULT_URL).trim(),
    timeoutMs: timeout > 0 ? Math.min(timeout, 30000) : 8000,
    inventoryBudgetMs: 20000,
    maxInventoryPages: 100
  }
}

function sign(params, secret) {
  const body = Object.keys(params).filter(key => !['sign', 'contextid', 'token'].includes(key))
    .sort().map(key => key + params[key]).join('')
  return createHash('md5').update((secret + body + secret).toLowerCase(), 'utf8').digest('hex')
}

function timestamp(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).format(date)
}

function signedParams(method, bizcontent, cfg, date) {
  const params = {
    method, appkey: cfg.appKey, version: 'v1.0', contenttype: 'json',
    timestamp: timestamp(date), bizcontent: JSON.stringify(bizcontent)
  }
  return { ...params, sign: sign(params, cfg.appSecret) }
}

function project(value, depth = 0) {
  if (depth > 8) throw Error('单据明细层级过深，需人工核验')
  if (Array.isArray(value)) return value.map(item => project(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => BUSINESS_FIELDS.has(key))
    .map(([key, item]) => [key, project(item, depth + 1)]))
  return value
}

function records(payload, spec) {
  if (!payload || typeof payload !== 'object') throw Error('吉客云响应结构无法核验')
  let data = payload.result
  if (data === undefined || data === null) throw Error('吉客云未返回单据数据')
  for (let depth = 0; depth < 5; depth++) {
    if (Array.isArray(data)) {
      if (data.some(item => !item || typeof item !== 'object' || Array.isArray(item))) break
      return data
    }
    if (!data || typeof data !== 'object') break
    const total = Number(data.totalCount ?? data.total)
    if (Number.isFinite(total) && total > 20) throw Error('单据查询结果不完整，需人工核验')
    if (!Object.keys(data).length) {
      if (!depth) throw Error('吉客云未返回单据数据')
      return []
    }
    const wrapper = [...spec.containers, 'data', 'rows', 'records', 'list']
      .find(key => Object.hasOwn(data, key))
    if (wrapper) { data = data[wrapper]; continue }
    if (Object.values(spec.identifiers).flat().some(key => Object.hasOwn(data, key))) return [data]
    break
  }
  throw Error('吉客云响应结构无法核验')
}

// Limit response bytes before parsing; oversized documents must not be silently truncated.
async function readJson(response) {
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 1024 * 1024) throw Error('吉客云单据内容过大，需人工核验')
      chunks.push(Buffer.from(value))
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function request(method, bizcontent, cfg) {
  if (![...Object.values(METHODS).map(spec => spec.method), 'erp.warehouse.get', 'erp.stockquantity.get'].includes(method)) {
    throw Error('不支持的吉客云只读查询')
  }
  if (!cfg.enabled || !cfg.appKey || !cfg.appSecret) throw Error('吉客云审批查询未启用或未配置凭据')
  // No model-supplied URLs, method names, field lists or broad search filters.
  const url = new URL(cfg.url)
  if (url.protocol !== 'https:' || url.username || url.password) throw Error('吉客云接口地址配置无效')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: new URLSearchParams(signedParams(method, bizcontent, cfg)).toString()
    })
    if (!response.ok) throw Error(`吉客云接口返回 HTTP ${response.status}`)
    const payload = await readJson(response)
    if (!['10000', '200'].includes(String(payload.code))) {
      const code = String(payload.subCode || payload.code || 'unknown').replace(/[^\w-]/g, '').slice(0, 30)
      // Never echo upstream messages: they may contain signed payloads or credentials.
      throw Error(`吉客云接口调用失败（错误码 ${code}），未能核验单据`)
    }
    return payload
  } catch (error) {
    if (controller.signal.aborted) throw Error('吉客云查询超时，未能核验单据')
    if (/^吉客云|^单据/.test(error.message)) throw error
    throw Error('吉客云查询失败，未能核验单据')
  } finally {
    clearTimeout(timer)
  }
}

function validQuery(query) {
  if (!query || typeof query.number !== 'string') return false
  if (query.kind === 'warehouse_stock') return query.numberField === 'warehouseName' &&
    query.number.trim().length >= 2 && query.number.length <= 180 && !/[\x00-\x1f*%]/.test(query.number)
  const spec = Object.hasOwn(METHODS, query.kind) && METHODS[query.kind]
  return !!spec && Object.hasOwn(spec.identifiers, query.numberField) &&
    /^[A-Za-z0-9][A-Za-z0-9_./-]{2,99}$/.test(query.number) && /\d/.test(query.number)
}

async function query(query, cfg = config()) {
  if (!validQuery(query)) throw Error('不支持的吉客云单据或库存查询')
  if (query.kind === 'warehouse_stock') return warehouseStock(query, { ...config(), ...cfg }, request)
  const spec = METHODS[query.kind]
  const bizcontent = { ...spec.defaults, pageIndex: 0, pageSize: 20, [query.numberField]: query.number }
  const payload = await request(spec.method, bizcontent, cfg)
  const rows = records(payload, spec)
  if (rows.length >= 20) throw Error('吉客云单据查询达到分页上限，需人工核验')
  const matching = rows.filter(row => spec.identifiers[query.numberField]
    .some(key => String(row[key] ?? '').trim().toLowerCase() === query.number.toLowerCase()))
  if (rows.length && matching.length !== rows.length) throw Error('吉客云返回的单号与查询条件不一致，需人工核验')
  const documents = matching.map(row => project(row))
  if (JSON.stringify(documents).length > 24000) throw Error('吉客云单据明细过长，需人工核验')
  return {
    kind: query.kind, numberField: query.numberField, number: query.number,
    method: spec.method, status: documents.length ? 'found' : 'not_found', documents
  }
}

const DESCRIPTION = Object.entries(METHODS).map(([kind, spec]) => ({
  kind, label: spec.label, numberFields: Object.keys(spec.identifiers)
})).concat([{ kind: 'warehouse_stock', label: '按完整仓库名称核验实时存货（不是单号，不需要截图）', numberFields: ['warehouseName'] }])

module.exports = { VERSION, DESCRIPTION, config, sign, signedParams, validQuery, query }
