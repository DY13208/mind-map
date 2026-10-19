<template>
  <div class="kb-file-table">
    <div v-if="selection.length" class="kb-batch">
      <BatchActionBar
        :count="selection.length"
        :all-selected="selection.length === files.length && files.length > 0"
        :indeterminate="selection.length > 0 && selection.length < files.length"
        show-delete
        :can-delete="true"
        @select-all="toggleAll"
        @clear="clearSelection"
        @exit="clearSelection"
        @delete="$emit('batch-delete', selection.slice())"
      />
      <span class="kb-batch-scope">仅限当前页</span>
      <el-button size="small" icon="el-icon-refresh-right" class="kb-batch-reparse" @click="$emit('batch-reparse', selection.slice())">批量重新解析</el-button>
    </div>
    <el-table
      ref="table"
      :data="files"
      row-key="id"
      size="small"
      class="kb-table"
      empty-text="暂无文件"
      @selection-change="s => (selection = s)"
    >
      <el-table-column type="selection" width="44" />
      <el-table-column label="文件名" min-width="240" show-overflow-tooltip>
        <template slot-scope="{ row }">
          <span class="kb-file-name" @click="$emit('open', row)">
            <i :class="iconOf(row)" aria-hidden="true" />{{ row.name || row.fileName }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="140">
        <template slot-scope="{ row }"><KbStatusTag :status="row.status" :detail="row.error || row.statusDetail || ''" /></template>
      </el-table-column>
      <el-table-column label="大小" width="100">
        <template slot-scope="{ row }">{{ size(row.size != null ? row.size : row.byteSize) }}</template>
      </el-table-column>
      <el-table-column label="更新时间" width="150">
        <template slot-scope="{ row }">{{ time(row.updatedAt || row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="210" fixed="right">
        <template slot-scope="{ row }">
          <el-button type="text" size="mini" icon="el-icon-document" @click="$emit('open', row)">解析</el-button>
          <el-button type="text" size="mini" icon="el-icon-s-grid" @click="$emit('data', row)">数据</el-button>
          <el-dropdown trigger="click" size="small" @command="c => $emit(c, row)">
            <el-button type="text" size="mini" icon="el-icon-more" aria-label="更多" />
            <el-dropdown-menu slot="dropdown" :visible-arrow="false">
              <el-dropdown-item command="reparse" icon="el-icon-refresh-right">重新解析</el-dropdown-item>
              <el-dropdown-item command="acl" icon="el-icon-lock">权限设置</el-dropdown-item>
              <el-dropdown-item command="delete" icon="el-icon-delete">删除</el-dropdown-item>
            </el-dropdown-menu>
          </el-dropdown>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>
<script>
import BatchActionBar from '@/pages/ProductShell/components/BatchActionBar.vue'
import KbStatusTag from './KbStatusTag.vue'
import { formatSize, formatTime, fileKind } from '../utils/format'
export default {
  name: 'KbFileTable',
  components: { BatchActionBar, KbStatusTag },
  props: { files: { type: Array, default: () => [] } },
  data() {
    return { selection: [] }
  },
  methods: {
    size: formatSize,
    time: formatTime,
    iconOf(row) {
      return { pdf: 'el-icon-document', image: 'el-icon-picture-outline', sheet: 'el-icon-s-grid' }[fileKind(row)] || 'el-icon-tickets'
    },
    toggleAll(v) {
      this.$refs.table.clearSelection()
      if (v) this.files.forEach(r => this.$refs.table.toggleRowSelection(r, true))
    },
    clearSelection() {
      this.$refs.table.clearSelection()
    }
  }
}
</script>
<style scoped lang="less">
.kb-batch {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  > :first-child { flex: 1; }
}
.kb-batch-reparse { margin-top: 10px; }
.kb-batch-scope { margin-top: 16px; font-size: 12px; color: var(--ui-text-muted); white-space: nowrap; }
.kb-file-name {
  cursor: pointer;
  color: var(--ui-text);
  font-weight: 500;
  i { margin-right: 6px; font-weight: 700; color: var(--ui-primary); }
  &:hover { color: var(--ui-primary); }
}
</style>
