<template>
  <div class="kb-page">
    <header class="kb-header">
      <div>
        <h1 class="kb-title"><i class="el-icon-collection" aria-hidden="true" />{{ isMobileViewport ? '知识库' : '文件知识库' }}</h1>
        <p class="kb-subtitle">{{ isMobileViewport ? '沉淀企业知识，让经验创造更大价值' : '上传文件，自动解析与结构化入库，支持检索与 MCP 调用' }}</p>
      </div>
      <div v-if="isMobileViewport" class="kb-hero-actions">
        <AccessNotificationTrigger collapsed />
        <router-link to="/profile" aria-label="个人主页"><i class="el-icon-user-solid" /></router-link>
      </div>
      <div v-if="isMobileViewport" class="kb-hero-art" aria-hidden="true"><span /><span /><span><i /><i /><i /></span></div>
      <div class="kb-header-status">
        <span class="kb-dot" :class="healthClass" />{{ healthText }}
      </div>
    </header>
    <form v-if="isMobileViewport" class="kb-hero-search" role="search" @submit.prevent="searchKnowledge">
      <i class="el-icon-search" aria-hidden="true" />
      <input v-model.trim="mobileQuery" type="search" aria-label="搜索知识库" placeholder="搜索文档、知识点或关键词…" enterkeyhint="search" />
      <button type="submit" aria-label="开始搜索"><i class="el-icon-right" /></button>
    </form>
    <KbServiceBanner :health="health" :error="healthError" :loading="healthLoading" @retry="loadHealth" />
    <el-tabs :value="tab" class="kb-tabs" @input="onTab">
      <el-tab-pane v-for="t in tabs" :key="t.name" :name="t.name">
        <span slot="label"><i :class="t.icon" class="kb-tab-icon" aria-hidden="true" />{{ isMobileViewport ? mobileLabels[t.name] : t.label }}</span>
      </el-tab-pane>
    </el-tabs>
    <keep-alive>
      <component :is="tabComponent" :key="tab" :health="health" @navigate="navigate" />
    </keep-alive>
  </div>
</template>
<script>
import kbApi from '../services/kbApi'
import { errorPresentation } from '../services/kbErrors'
import { pendingUploads } from '../services/kbSignals'
import { KB_TABS } from '../constants/status'
import KbServiceBanner from '../components/KbServiceBanner.vue'
import KbFilesTab from './KbFilesTab.vue'
import KbParseDetailTab from './KbParseDetailTab.vue'
import KbStructuredTab from './KbStructuredTab.vue'
import KbSearchTab from './KbSearchTab.vue'
import KbMcpTab from './KbMcpTab.vue'
import mobileViewport from '@/utils/mobileViewport'
import AccessNotificationTrigger from '@/components/AccessNotificationTrigger.vue'
const COMPONENTS = { files: 'KbFilesTab', parse: 'KbParseDetailTab', data: 'KbStructuredTab', search: 'KbSearchTab', mcp: 'KbMcpTab' }
export default {
  name: 'KbIndexPage',
  mixins: [mobileViewport],
  components: { AccessNotificationTrigger, KbServiceBanner, KbFilesTab, KbParseDetailTab, KbStructuredTab, KbSearchTab, KbMcpTab },
  data() {
    return { tabs: KB_TABS, health: null, healthError: null, healthLoading: false, mobileQuery: '', mobileLabels: { files: '全部', parse: '文档', data: '数据', search: '检索', mcp: '接入' } }
  },
  computed: {
    tab() {
      const t = this.$route.params.tab
      return COMPONENTS[t] ? t : 'files'
    },
    tabComponent() { return COMPONENTS[this.tab] },
    healthClass() {
      if (this.healthLoading && !this.health) return 'is-pending'
      if (this.healthError) {
        const k = this.healthError.kind
        if (k === 'not_ready' || k === 'disabled' || k === 'not_implemented') return 'is-pending'
        return 'is-bad'
      }
      return this.health && this.health.ok ? 'is-ok' : 'is-bad'
    },
    healthText() {
      if (this.healthLoading && !this.health) return '检查服务中'
      if (this.healthError) return errorPresentation(this.healthError).title
      return this.health && this.health.ok ? '服务正常' : '部分异常'
    }
  },
  created() {
    this.loadHealth()
  },
  // 离开文件知识库时，本地上传队列会被销毁（进行中的请求中止）；已提交到后端的文件不受影响
  beforeRouteLeave(to, from, next) {
    const n = pendingUploads()
    if (!n) return next()
    this.$confirm(`还有 ${n} 个文件尚未提交到后端（排队或上传中）。离开后这些文件的上传会被中止；已提交的文件会继续在后台解析。`, '离开文件知识库', {
      type: 'warning', confirmButtonText: '离开', cancelButtonText: '留下'
    }).then(() => next()).catch(() => next(false))
  },
  methods: {
    searchKnowledge() {
      this.navigate({ tab: 'search', query: this.mobileQuery ? { q: this.mobileQuery } : {} })
    },
    async loadHealth() {
      this.healthLoading = true
      try {
        this.health = await kbApi.health()
        this.healthError = null
      } catch (e) {
        if (e.status === 503 && e.data && e.data.db) {
          this.health = e.data
          this.healthError = null
        } else {
          this.health = null
          this.healthError = e
        }
      } finally {
        this.healthLoading = false
      }
    },
    onTab(name) {
      if (name === this.tab) return
      this.$router.push({ name: 'FileKb', params: { tab: name }, query: name === 'files' ? { shell: this.$route.query.shell } : this.$route.query }).catch(() => {})
    },
    navigate({ tab, query }) {
      this.$router.push({ name: 'FileKb', params: { tab }, query: { shell: this.$route.query.shell, ...(query || {}) } }).catch(() => {})
    }
  }
}
</script>
<style scoped lang="less">
.kb-page {
  padding: 24px 28px 40px;
  min-height: 100%;
  color: var(--ui-text);
  background: var(--ui-bg);
  box-sizing: border-box;
  ::v-deep * {
    scrollbar-width: thin;
    scrollbar-color: var(--ui-border-strong) transparent;
  }
  ::v-deep *::-webkit-scrollbar { width: 6px; height: 6px; }
  ::v-deep *::-webkit-scrollbar-thumb { background: var(--ui-border-strong); border-radius: 3px; }
  ::v-deep *::-webkit-scrollbar-track { background: transparent; }

  /* 主题化：去掉 Element 默认亮蓝 */
  ::v-deep .el-button--text {
    color: var(--ui-primary);
    font-weight: 600;
    &:hover, &:focus { color: var(--ui-primary-hover); }
    &.is-disabled, &.is-disabled:hover { color: var(--ui-text-muted); }
  }
  ::v-deep a { color: var(--ui-primary); }
  ::v-deep .el-button--primary:not(.is-plain) {
    background: var(--ui-primary);
    border-color: var(--ui-primary);
    color: var(--ui-on-primary);
    &:hover, &:focus { background: var(--ui-primary-hover); border-color: var(--ui-primary-hover); }
    &.is-disabled { opacity: 0.5; }
  }
  ::v-deep .el-button--default:not(.el-button--primary):not(.el-button--danger) {
    &:hover, &:focus { color: var(--ui-primary); border-color: var(--ui-border-strong); background: var(--ui-primary-soft); }
  }
  ::v-deep .el-checkbox__input.is-checked .el-checkbox__inner,
  ::v-deep .el-checkbox__input.is-indeterminate .el-checkbox__inner { background: var(--ui-primary); border-color: var(--ui-primary); }
  ::v-deep .el-checkbox__input.is-checked + .el-checkbox__label { color: var(--ui-primary); }
  ::v-deep .el-checkbox__inner:hover, ::v-deep .el-input__inner:focus, ::v-deep .el-textarea__inner:focus, ::v-deep .el-select .el-input.is-focus .el-input__inner { border-color: var(--ui-primary); }
  ::v-deep .el-radio-button__orig-radio:checked + .el-radio-button__inner { background: var(--ui-primary); border-color: var(--ui-primary); box-shadow: -1px 0 0 0 var(--ui-primary); }
  ::v-deep .el-progress-bar__inner { background: var(--ui-primary); }
  ::v-deep .el-loading-spinner .path { stroke: var(--ui-primary); }
  ::v-deep .el-loading-spinner .el-loading-text, ::v-deep .el-loading-spinner i { color: var(--ui-primary); }
  ::v-deep .kb-table {
    background: var(--ui-surface);
    color: var(--ui-text);
    border-radius: var(--ui-radius-md);
    th, tr { background: var(--ui-surface); color: var(--ui-text); }
    th { color: var(--ui-text-secondary); font-weight: 600; background: var(--ui-surface-muted); }
    td, th.is-leaf { border-bottom-color: var(--ui-border); }
    .el-table__body tr:hover > td { background: var(--ui-hover-overlay); }
    &::before { background: var(--ui-border); }
  }
  ::v-deep .kb-card {
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: var(--ui-radius-lg);
    padding: 16px;
  }
}
.kb-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-bottom: 14px;
}
.kb-title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 8px;
  i { color: var(--ui-primary); font-weight: 700; }
}
.kb-subtitle {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--ui-text-secondary);
}
.kb-header-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--ui-text-secondary);
}
.kb-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ui-text-muted);
  &.is-ok { background: var(--ui-primary); }
  &.is-bad { background: var(--ui-danger); }
  &.is-pending { background: var(--ui-star); }
}
.kb-tab-icon { margin-right: 6px; font-weight: 700; }
.kb-tabs {
  ::v-deep .el-tabs__item { color: var(--ui-text-secondary); font-weight: 500; }
  ::v-deep .el-tabs__item.is-active, ::v-deep .el-tabs__item:hover { color: var(--ui-primary); }
  ::v-deep .el-tabs__active-bar { background: var(--ui-primary); }
  ::v-deep .el-tabs__nav-wrap::after { background: var(--ui-border); }
}
</style>
<style lang="less" src="../mobile.less"></style>
<style lang="less">
/* 下拉弹层挂载在 body 下，无法被 scoped 覆盖；只作用于 KB 自有 popper-class */
.kb-popper .popper__arrow { display: none !important; }
.kb-popper .el-select-dropdown__item.selected { color: var(--ui-primary); }
.kb-popper .el-date-table td.today span,
.kb-popper .el-date-table td.available:hover { color: var(--ui-primary); }
.kb-popper .el-date-table td.start-date span,
.kb-popper .el-date-table td.end-date span { background: var(--ui-primary); }
.kb-popper .el-date-table td.in-range div { background: var(--ui-primary-soft); }
</style>
