<template>
  <el-tag class="kb-status-tag" :class="{ 'is-brand': !meta.type }" :type="meta.type || 'info'" size="small" effect="light" disable-transitions :title="detail || meta.label">
    <i :class="meta.icon" class="kb-status-icon" aria-hidden="true" />{{ meta.label }}
  </el-tag>
</template>
<script>
import { FILE_STATUS } from '../constants/status'
export default {
  name: 'KbStatusTag',
  props: { status: { type: String, default: '' }, detail: { type: String, default: '' } },
  computed: {
    meta() {
      return FILE_STATUS[this.status] || { label: this.status || '未知', type: 'info', icon: 'el-icon-question' }
    }
  }
}
</script>
<style scoped lang="less">
.kb-status-tag {
  font-weight: 600;
  border-radius: var(--ui-radius-sm);
}
.kb-status-tag.is-brand {
  background: var(--ui-primary-soft);
  border-color: var(--ui-border-strong);
  color: var(--ui-primary);
}
.kb-status-icon {
  margin-right: 4px;
  font-weight: 700;
}
</style>
