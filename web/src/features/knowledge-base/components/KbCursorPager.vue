<template>
  <div v-if="hasPrev || hasNext" class="kb-pager">
    <span class="kb-pager-info">
      第 {{ page }} 页 · 本页 {{ count }} 条<template v-if="total != null"> · 共 {{ total }} 条</template>
    </span>
    <el-button size="mini" icon="el-icon-arrow-left" :disabled="!hasPrev || loading" @click="$emit('prev')">上一页</el-button>
    <el-button size="mini" :disabled="!hasNext || loading" @click="$emit('next')">下一页<i class="el-icon-arrow-right el-icon--right" /></el-button>
  </div>
</template>
<script>
// keyset 游标分页：只保存已访问页的游标栈，DOM 中始终只有一页数据
export default {
  name: 'KbCursorPager',
  props: { page: Number, count: Number, total: { type: Number, default: null }, hasPrev: Boolean, hasNext: Boolean, loading: Boolean }
}
</script>
<style scoped lang="less">
.kb-pager {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
.kb-pager-info { font-size: 12px; color: var(--ui-text-muted); margin-right: 4px; }
</style>
