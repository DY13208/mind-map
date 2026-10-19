'use strict'
// Hard upper bound of JackYun tools File KB may ever call. Verified by tools/list on 2026-10-19
// against https://mcp.open.jackyun.com/mcp/messages (server open-platform-mcp v1.0.0).
// FILE_KB_GEEKCLOUD_ALLOWED_TOOLS can only narrow this set. Every entry is a query (get*).
// Orders, purchase, settlement, returns, allocation and sales-analysis tools are deliberately absent.

const PRICE_COLS = 'skuBarcode,skuName,goodsNo,goodsName,currencyCode,currencyName,minPrice,price1,price2,price3,price4,price5'

const CATALOG = {
  getGoodsListInfoByGoodsNo: {
    label: '商品资料',
    description: '按货品编号查询商品名称、条码、单位、分类、品牌',
    // goodsNo is a prefix match on JackYun's side; callers must compare exactly.
    requiredProps: ['goodsNo', 'pageIndex', 'pageSize'],
    rowKey: 'goods',
    fields: { goodsNo: 'text', goodsName: 'text', skuName: 'text', skuBarcode: 'text', skuCode: 'text', unitName: 'text', cateName: 'text', brandName: 'text', ownerName: 'text' },
    args: ({ sku, pageIndex = 0, pageSize = 20 }) => ({ goodsNo: sku, pageIndex: String(pageIndex), pageSize: String(pageSize) })
  },
  getGoodsStockQuantityListInfo: {
    label: '实时库存',
    description: '按货品编号查询各仓库实时库存（结果按用户仓库范围过滤）',
    requiredProps: ['goodsNos', 'pageIndex', 'pageSize', 'isChannelReserve', 'warehouseCode'],
    rowKey: 'goodsStockQuantity',
    fields: { goodsNo: 'text', goodsName: 'text', skuName: 'text', skuBarcode: 'text', unitName: 'text', warehouseCode: 'text', warehouseName: 'text', currentQuantity: 'number', useQuantity: 'number' },
    args: ({ sku, warehouseCode, pageIndex = 0, pageSize = 10 }) => {
      const out = { goodsNos: sku, pageIndex: String(pageIndex), pageSize: String(pageSize), isChannelReserve: '0' }
      if (warehouseCode) out.warehouseCode = warehouseCode
      return out
    }
  },
  getGoodsPriceListInfo: {
    label: '价目信息',
    description: '按货品编号查询价目（minPrice、price1~price5）',
    requiredProps: ['goodsNos', 'pageIndex', 'pageSize', 'cols'],
    rowKey: null,
    fields: { goodsNo: 'text', goodsName: 'text', skuName: 'text', skuBarcode: 'text', currencyCode: 'text', currencyName: 'text', minPrice: 'number', price1: 'number', price2: 'number', price3: 'number', price4: 'number', price5: 'number' },
    args: ({ sku, pageIndex = 0, pageSize = 20 }) => ({ goodsNos: sku, pageIndex: String(pageIndex), pageSize: String(pageSize), cols: PRICE_COLS })
  },
  getWarehouseListInfo: {
    label: '仓库信息',
    description: '按仓库编号查询仓库名称与地址（只查用户范围内的仓库）',
    requiredProps: ['code', 'pageIndex', 'pageSize'],
    rowKey: 'warehouseInfo',
    fields: { warehouseCode: 'text', warehouseName: 'text', address: 'text' },
    args: ({ code }) => ({ code, pageIndex: '0', pageSize: '10' })
  }
}

module.exports = { CATALOG }
