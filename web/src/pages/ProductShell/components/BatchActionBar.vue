<template>
  <div class="batchBar" role="toolbar" aria-label="批量操作">
    <div class="batchMeta">
      <el-checkbox
        :indeterminate="indeterminate"
        :value="allSelected"
        @change="$emit('select-all', $event)"
        >全选</el-checkbox
      >
      <span>已选 {{ count }} 项</span>
      <el-button type="text" @click="$emit('clear')">清空</el-button>
      <el-button type="text" @click="$emit('exit')">退出多选</el-button>
    </div>
    <div class="batchActions">
      <el-button
        v-if="showMove"
        size="small"
        icon="el-icon-folder"
        :disabled="!canMove"
        @click="$emit('move')"
        >移动到文件夹</el-button
      >
      <el-button
        v-if="showMoveToTeam"
        size="small"
        icon="el-icon-office-building"
        :disabled="!canMoveToTeam"
        @click="$emit('move-to-team')"
        >移至团队空间</el-button
      >
      <el-button
        v-if="showFavorite"
        size="small"
        icon="el-icon-star-off"
        :disabled="!canFavorite"
        @click="$emit('favorite')"
        >{{ favoriteLabel }}</el-button
      >
      <el-button
        v-if="showDelete"
        size="small"
        type="danger"
        plain
        icon="el-icon-delete"
        :disabled="!canDelete"
        @click="$emit('delete')"
        >删除</el-button
      >
    </div>
  </div>
</template>
<script>
export default {
  name: 'BatchActionBar',
  props: {
    count: { type: Number, default: 0 },
    allSelected: { type: Boolean, default: false },
    indeterminate: { type: Boolean, default: false },
    showMove: { type: Boolean, default: false },
    showMoveToTeam: { type: Boolean, default: false },
    showFavorite: { type: Boolean, default: false },
    showDelete: { type: Boolean, default: false },
    canMove: { type: Boolean, default: false },
    canMoveToTeam: { type: Boolean, default: false },
    canFavorite: { type: Boolean, default: false },
    canDelete: { type: Boolean, default: false },
    favoriteLabel: { type: String, default: '收藏' }
  }
}
</script>
<style lang="less" scoped>
.batchBar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin: 0 0 16px;
  padding: 12px 14px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-lg);
  background: var(--ui-surface-muted);
}
.batchMeta {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--ui-text-secondary);
  font-size: 13px;
}
.batchActions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
