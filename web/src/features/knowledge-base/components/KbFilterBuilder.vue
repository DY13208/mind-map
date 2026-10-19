<template>
  <div class="kb-filter">
    <div v-for="(f, i) in rows" :key="i" class="kb-filter-row">
      <el-select v-model="f.field" size="small" placeholder="选择字段" filterable class="kb-filter-field" popper-class="kb-popper" @change="onField(f)">
        <el-option v-for="fd in fields" :key="keyOf(fd)" :label="labelOf(fd)" :value="keyOf(fd)">
          <span>{{ labelOf(fd) }}</span><span class="kb-filter-type">{{ typeName(kindOf(fd)) }}</span>
        </el-option>
      </el-select>
      <template v-if="f.kind === 'exact'">
        <span class="kb-filter-op">等于</span>
        <el-input v-model.trim="f.value" size="small" placeholder="精确匹配，如 SKU 编码" clearable class="kb-filter-val" />
      </template>
      <template v-else-if="f.kind === 'range'">
        <span class="kb-filter-op">介于</span>
        <el-input-number v-model="f.min" size="small" :controls="false" placeholder="最小值" class="kb-filter-num" />
        <span class="kb-filter-op">至</span>
        <el-input-number v-model="f.max" size="small" :controls="false" placeholder="最大值" class="kb-filter-num" />
      </template>
      <template v-else-if="f.kind === 'date'">
        <el-date-picker v-model="f.range" type="daterange" size="small" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" value-format="yyyy-MM-dd" popper-class="kb-popper" class="kb-filter-val" />
      </template>
      <template v-else>
        <span class="kb-filter-op">包含</span>
        <el-input v-model.trim="f.value" size="small" placeholder="关键词" clearable class="kb-filter-val" />
      </template>
      <el-button type="text" icon="el-icon-delete" class="kb-filter-del" aria-label="删除条件" @click="rows.splice(i, 1)" />
    </div>
    <div class="kb-filter-actions">
      <el-button size="small" icon="el-icon-plus" :disabled="!fields.length" @click="add">添加条件</el-button>
      <el-button size="small" type="primary" icon="el-icon-search" @click="apply">查询</el-button>
      <el-button size="small" @click="reset">重置</el-button>
    </div>
  </div>
</template>
<script>
// 字段类型感知：sku/id/code => 精确；number/price/stock/integer => 区间；date/datetime => 日期区间；其余 => 包含
export function fieldKind(type, key) {
  const t = String(type || '').toLowerCase()
  const k = String(key || '').toLowerCase()
  if (t === 'sku' || t === 'id' || t === 'code' || /(^|_)(sku|code|id)$/.test(k)) return 'exact'
  if (/^(number|numeric|integer|int|float|decimal|price|money|currency|stock|quantity)$/.test(t)) return 'range'
  if (/^(date|datetime|timestamp|time)$/.test(t)) return 'date'
  return 'contains'
}
export default {
  name: 'KbFilterBuilder',
  props: { fields: { type: Array, default: () => [] } },
  data() {
    return { rows: [] }
  },
  methods: {
    keyOf(fd) { return fd.key || fd.name || fd.id },
    labelOf(fd) { return fd.label || fd.displayName || fd.name || fd.key },
    kindOf(fd) { return fieldKind(fd.type || fd.dataType, this.keyOf(fd)) },
    typeName(k) { return { exact: '精确', range: '区间', date: '日期', contains: '文本' }[k] },
    add() { this.rows.push({ field: '', kind: 'contains', value: '', min: undefined, max: undefined, range: null }) },
    onField(f) {
      const fd = this.fields.find(x => this.keyOf(x) === f.field)
      f.kind = fd ? this.kindOf(fd) : 'contains'
      f.value = ''
      f.min = f.max = undefined
      f.range = null
    },
    build() {
      const out = []
      this.rows.forEach(f => {
        if (!f.field) return
        const fd = this.fields.find(x => this.keyOf(x) === f.field)
        const field = (fd && fd.column) || f.field
        if (f.kind === 'exact' && f.value) out.push({ field, op: 'eq', value: f.value })
        else if (f.kind === 'contains' && f.value) out.push({ field, op: 'contains', value: f.value })
        else if (f.kind === 'range' && (f.min != null || f.max != null)) out.push({ field, op: 'range', min: f.min != null ? f.min : null, max: f.max != null ? f.max : null })
        else if (f.kind === 'date' && f.range) out.push({ field, op: 'range', min: f.range[0], max: f.range[1] })
      })
      return out
    },
    apply() { this.$emit('apply', this.build()) },
    reset() { this.rows = []; this.$emit('apply', []) }
  }
}
</script>
<style scoped lang="less">
.kb-filter-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}
.kb-filter-field { width: 180px; }
.kb-filter-val { width: 260px; }
.kb-filter-num { width: 120px; }
.kb-filter-op { font-size: 13px; color: var(--ui-text-secondary); }
.kb-filter-type { float: right; margin-left: 12px; font-size: 12px; color: var(--ui-text-muted); }
.kb-filter-del { font-size: 16px; font-weight: 700; color: var(--ui-text-muted); &:hover { color: var(--ui-danger); } }
.kb-filter-actions { display: flex; gap: 8px; }
</style>
