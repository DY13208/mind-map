<template>
  <div v-if="serviceVisible || failedTotal" class="kb-banners">
    <div v-if="serviceVisible" class="kb-banner" :class="'kb-banner--' + level" role="status">
      <i :class="icon" class="kb-banner-icon" aria-hidden="true" />
      <div class="kb-banner-text">
        <strong>{{ title }}</strong>
        <span v-if="description">{{ description }}</span>
      </div>
      <el-button size="mini" icon="el-icon-refresh-right" :loading="loading" @click="$emit('recheck')">重新检测</el-button>
    </div>
    <div v-if="failedTotal" class="kb-banner kb-banner--task" role="status">
      <i class="el-icon-document-delete kb-banner-icon" aria-hidden="true" />
      <div class="kb-banner-text">
        <strong>{{ failedTotal }} 个文件处理失败</strong>
        <span>{{ failedSummary }}</span>
      </div>
      <el-button size="mini" type="primary" plain @click="$emit('show-failures')">查看原因</el-button>
    </div>
  </div>
</template>
<script>
import { errorPresentation, describeJobError } from '../services/kbErrors'
// 两类提示分开：服务本身不可用（/health 或接口错误）→ 重新检测；后台任务失败 → 查看原因并处理
export default {
  name: 'KbServiceBanner',
  props: {
    health: { type: Object, default: null },
    error: { type: Error, default: null },
    loading: { type: Boolean, default: false },
    failedJobs: { type: Array, default: () => [] },
    failedTotal: { type: Number, default: 0 }
  },
  computed: {
    issues() {
      const h = this.health
      if (!h) return []
      const out = []
      if (h.db && h.db.ok === false) out.push(h.db.error === 'schema_missing' ? '数据库结构未初始化' : '数据库不可用')
      if (h.docling && h.docling.ok === false) out.push('Docling 解析服务不可用，新文件将排队等待')
      return out
    },
    view() { return errorPresentation(this.error) },
    serviceVisible() {
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
    },
    failedSummary() {
      const first = this.failedJobs[0]
      if (!first) return ''
      const more = this.failedTotal > 1 ? ` 等 ${this.failedTotal} 个文件` : ''
      return `「${first.fileName}」${more}：${describeJobError(first.lastError)}`
    }
  }
}
</script>
<style scoped lang="less">
.kb-banners {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
}
.kb-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
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
  &--task {
    background: var(--ui-surface);
    border-left: 3px solid var(--ui-danger);
    .kb-banner-icon { color: var(--ui-danger); }
  }
}
.kb-banner-icon {
  font-size: 18px;
  font-weight: 700;
}
.kb-banner-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 13px;
  span { color: var(--ui-text-secondary); overflow-wrap: anywhere; }
}
</style>
