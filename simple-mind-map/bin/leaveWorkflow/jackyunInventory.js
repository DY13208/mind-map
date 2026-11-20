// Inventory presence is a warehouse query, not a document-number lookup.
// A positive row proves presence; absence requires exhausting every page.
function normalize(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ')
}

function rows(payload, container) {
  const value = payload?.result?.data?.[container]
  if (!Array.isArray(value) || value.some(row => !row || typeof row !== 'object')) {
    throw Error('吉客云库存响应结构无法核验')
  }
  return value
}

async function warehouseStock(query, cfg, request) {
  const deadline = Date.now() + cfg.inventoryBudgetMs
  const pageSize = 50
  const read = (method, params) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw Error('吉客云库存查询超过核验时限，尚未完整查询，需人工核验')
    return request(method, params, { ...cfg, timeoutMs: Math.min(cfg.timeoutMs, remaining) })
  }
  const matches = new Map()
  let complete = false
  const seenWarehousePages = new Set()
  for (let pageIndex = 0; pageIndex < cfg.maxInventoryPages; pageIndex++) {
    const items = rows(await read('erp.warehouse.get', {
      name: query.number, pageIndex, pageSize
    }), 'warehouseInfo')
    const fingerprint = JSON.stringify(items)
    if (items.length && seenWarehousePages.has(fingerprint)) throw Error('吉客云仓库分页重复，无法确认唯一仓库')
    seenWarehousePages.add(fingerprint)
    for (const row of items) {
      if (normalize(row.warehouseName) !== normalize(query.number)) continue
      if (typeof row.warehouseCode !== 'string' || !row.warehouseCode.trim()) throw Error('吉客云仓库缺少有效编号')
      matches.set(row.warehouseCode, row)
    }
    if (items.length < pageSize) { complete = true; break }
  }
  if (!complete) throw Error('吉客云仓库查询未完成分页，需人工核验')
  const base = {
    ...query, method: 'erp.stockquantity.get',
    lookupMethod: 'erp.warehouse.get'
  }
  if (!matches.size) return {
    ...base, status: 'not_found', documents: [],
    reason: `吉客云未找到本次填写的仓库：${query.number}，本次核验不通过。`
  }
  if (matches.size !== 1) throw Error('吉客云存在同名仓库，不能唯一确定本次核验仓库')
  const warehouse = [...matches.values()][0]
  let checkedRows = 0
  const seen = new Set()
  for (let pageIndex = 0; pageIndex < cfg.maxInventoryPages; pageIndex++) {
    const items = rows(await read('erp.stockquantity.get', {
      warehouseCode: warehouse.warehouseCode, pageIndex, pageSize,
      isNotQueryBatchStock: 1
    }), 'goodsStockQuantity')
    for (const row of items) {
      if (row.warehouseCode !== warehouse.warehouseCode) throw Error('吉客云返回其他仓库的库存，无法核验')
      const raw = row.currentQuantity
      if ((typeof raw !== 'number' && typeof raw !== 'string') ||
          String(raw).trim() === '' || !Number.isFinite(Number(raw))) {
        throw Error('吉客云库存数量缺失或格式无效，不能当作零库存')
      }
      const quantity = Number(raw)
      if (quantity < 0) throw Error('吉客云库存存在负数，需人工核验实际存货情况')
      const identity = row.quantityId || `${row.goodsNo}|${row.skuId || row.skuBarcode || row.skuName}|${row.unitName}`
      if (seen.has(identity)) throw Error('吉客云库存分页存在重复记录，无法确认完整查询')
      seen.add(identity)
      checkedRows++
      if (quantity > 0) return {
        ...base, status: 'found', documents: [{
          warehouseName: warehouse.warehouseName, warehouseCode: warehouse.warehouseCode,
          queryScope: 'warehouse_has_any_positive_stock', verificationComplete: true,
          quantityBasis: 'currentQuantity', hasStock: true, scanComplete: false, checkedRows,
          proof: { goodsNo: row.goodsNo, skuName: row.skuName, currentQuantity: quantity }
        }]
      }
    }
    if (items.length < pageSize) return {
      ...base, status: 'found', documents: [{
        warehouseName: warehouse.warehouseName, warehouseCode: warehouse.warehouseCode,
        queryScope: 'warehouse_has_any_positive_stock', verificationComplete: true,
        quantityBasis: 'currentQuantity', hasStock: false, scanComplete: true, checkedRows
      }]
    }
  }
  throw Error('吉客云库存尚未完成全部分页，不能判定无库存，需人工核验')
}

module.exports = { warehouseStock }
