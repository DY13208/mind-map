<template>
  <div class="kb-records">
    <el-table :data="records" size="small" border class="kb-table" max-height="560" empty-text="没有符合条件的记录" @row-click="r => $emit('select', r)">
      <el-table-column v-for="c in columns" :key="c.key" :label="c.label" :prop="c.key" min-width="120" show-overflow-tooltip>
        <template slot-scope="{ row }">{{ cell(row, c.key) }}</template>
      </el-table-column>
      <el-table-column label="来源" width="200" show-overflow-tooltip>
        <template slot-scope="{ row }">
          <span class="kb-rec-src">{{ row.fileName || '' }} {{ loc(row) }}</span>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>
<script>
import { blockLocation, locationLabel } from '../utils/format'
export default {
  name: 'KbRecordTable',
  props: { records: { type: Array, default: () => [] }, fields: { type: Array, default: () => [] } },
  computed: {
    columns() {
      if (this.fields.length) return this.fields.map(f => ({ key: f.key || f.name, label: f.label || f.name || f.key }))
      const keys = new Set()
      this.records.slice(0, 50).forEach(r => Object.keys(this.dataOf(r)).forEach(k => keys.add(k)))
      return Array.from(keys).map(k => ({ key: k, label: k }))
    }
  },
  methods: {
    dataOf(r) { return (r && (r.data || r.values || r.fields)) || {} },
    cell(r, k) {
      const v = this.dataOf(r)[k]
      return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : v
    },
    loc(r) { const l = blockLocation(r); return l.known ? locationLabel(l) : '' }
  }
}
</script>
<style scoped lang="less">
.kb-records ::v-deep .el-table__row { cursor: pointer; }
.kb-rec-src { font-size: 12px; color: var(--ui-text-muted); }
</style>
