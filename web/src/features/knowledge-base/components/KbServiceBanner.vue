<template>
  <div v-if="visible" class="kb-banner" :class="'kb-banner--' + level" role="status">
    <i :class="icon" class="kb-banner-icon" aria-hidden="true" />
    <div class="kb-banner-text">
      <strong>{{ title }}</strong>
      <span v-if="description">{{ description }}</span>
    </div>
    <el-button size="mini" icon="el-icon-refresh-right" :loading="loading" @click="$emit('retry')">重试</el-button>
  </div>
</template>
<script>
import { errorPresentation } from '../services/kbErrors'
// 展示 /api/kb/health 结果或接口错误（未启用 / 未登录 / 未实现 / 不可用）
export default {
  name: 'KbServiceBanner',
  props: {
    health: { type: Object, default: null },
    error: { type: Error, default: null },
    loading: { type: Boolean, default: false }
  },
  computed: {
    issues() {
      const h = this.health
      if (!h) return []
      const out = []
      if (h.db && h.db.ok === false) out.push(h.db.error === 'schema_missing' ? '数据库结构未初始化' : '数据库不可用')
      if (h.docling && h.docling.ok === false) out.push('Docling 解析服务不可用，新文件将排队等待')
      if (h.queue && h.queue.failed) out.push(`队列中有 ${h.queue.failed} 个失败任务`)
      return out
    },
    view() { return errorPresentation(this.error) },
    visible() {
      return !!this.error || this.issues.length > 0
    },
    level() {
      if (this.error) {
        const k = this.error.kind
        if (k === 'not_ready' || k === 'not_implemented' || k === 'disabled') return 'info'
        if (k === 'unauthorized') return 'warning'
        return 'danger'
      }
      return 'warning'
    },
    icon() {
      return this.level === 'info' ? 'el-icon-info' : 'el-icon-warning'
    },
    title() {
      if (this.error) return this.view.title
      return '部分服务异常'
    },
    description() {
      if (this.error) return this.error.message
      return this.issues.join('；')
    }
  }
}
</script>
<style scoped lang="less">
.kb-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  margin-bottom: 14px;
  border-radius: var(--ui-radius-md);
  border: 1px solid var(--ui-border);
  background: var(--ui-surface-muted);
  color: var(--ui-text);
  &--danger {
    border-color: var(--ui-danger-border);
    background: var(--ui-danger-soft);
    .kb-banner-icon { color: var(--ui-danger); }
  }
  &--warning .kb-banner-icon { color: var(--ui-star); }
  &--info .kb-banner-icon { color: var(--ui-primary); }
}
.kb-banner-icon {
  font-size: 18px;
  font-weight: 700;
}
.kb-banner-text {
  flex: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 13px;
  span { color: var(--ui-text-secondary); }
}
</style>
