<template>
  <div class="kb-state">
    <div v-if="loading" class="kb-state-loading" v-loading="true" element-loading-background="transparent" />
    <EmptyState
      v-else-if="error"
      :icon="error.kind === 'not_ready' || error.kind === 'not_implemented' ? 'el-icon-time' : 'el-icon-warning-outline'"
      :title="view.title"
      :description="view.description"
      action="重试"
      @action="$emit('retry')"
    />
    <EmptyState v-else-if="empty" :icon="emptyIcon" :title="emptyTitle" :description="emptyDescription" />
    <slot v-else />
  </div>
</template>
<script>
import EmptyState from '@/pages/ProductShell/components/EmptyState.vue'
import { errorPresentation } from '../services/kbErrors'
export default {
  name: 'KbStateBlock',
  components: { EmptyState },
  computed: {
    view() { return errorPresentation(this.error) }
  },
  props: {
    loading: Boolean,
    error: { type: Error, default: null },
    empty: Boolean,
    emptyTitle: { type: String, default: '暂无数据' },
    emptyDescription: { type: String, default: '' },
    emptyIcon: { type: String, default: 'el-icon-document' }
  }
}
</script>
<style scoped lang="less">
.kb-state ::v-deep .el-button--primary {
  background: var(--ui-primary);
  border-color: var(--ui-primary);
  color: var(--ui-on-primary);
}
.kb-state-loading {
  min-height: 160px;
}
</style>
