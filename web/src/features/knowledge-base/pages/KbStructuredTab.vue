<template>
  <div class="kb-data">
    <div class="kb-card kb-data-head">
      <KbFilePicker :value="fileId" :current="null" placeholder="全部文件（可选择单个文件）" @input="selectFile" />
      <span class="kb-muted">字段 {{ fields.length }} 个<template v-if="total != null"> · 记录 {{ total }} 条</template></span>
    </div>
    <div class="kb-card kb-data-filter">
      <div class="kb-section-title">筛选条件</div>
      <div v-if="fieldsError" class="kb-muted">
        {{ fieldsError.kind === 'not_ready' ? '字段接口等待后端实现，暂无法构建筛选条件' : fieldsError.message }}
        <el-button type="text" @click="loadFields">重试</el-button>
      </div>
      <KbFilterBuilder v-else :fields="fields" @apply="applyFilters" />
    </div>
    <div class="kb-data-body">
      <div class="kb-card kb-data-table">
        <KbStateBlock :loading="loading && !loaded" :error="error" :empty="loaded && !records.length" empty-title="暂无结构化记录" empty-description="Excel 等表格文件解析完成后会在此出现" empty-icon="el-icon-s-grid" @retry="load">
          <KbRecordTable :records="records" :fields="fields" @select="r => (selected = r)" />
          <KbCursorPager :page="cursor.index + 1" :count="records.length" :total="total" :has-prev="cursor.index > 0" :has-next="!!cursor.nextCursor" :loading="loading" @prev="prev" @next="next" />
        </KbStateBlock>
      </div>
      <div v-if="selected" class="kb-data-json">
        <div class="kb-section-title">
          记录详情
          <el-button type="text" icon="el-icon-close" aria-label="关闭" @click="selected = null" />
        </div>
        <KbJsonView :value="selected" title="原始 JSON" />
        <el-button v-if="selected.fileId" size="small" icon="el-icon-aim" class="kb-locate" @click="locate">在原文中定位</el-button>
      </div>
    </div>
  </div>
</template>
<script>
import kbApi from '../services/kbApi'
import { blockLocation } from '../utils/format'
import KbFilePicker from '../components/KbFilePicker.vue'
import KbFilterBuilder from '../components/KbFilterBuilder.vue'
import KbRecordTable from '../components/KbRecordTable.vue'
import KbJsonView from '../components/KbJsonView.vue'
import KbStateBlock from '../components/KbStateBlock.vue'
import KbCursorPager from '../components/KbCursorPager.vue'
import { DEFAULT_LIMIT } from '../services/kbApi'
import { createCursorState, currentCursor, goNext, goPrev, resetCursor } from '../services/kbCursor'
import { structureStamp } from '../services/kbSignals'
export default {
  name: 'KbStructuredTab',
  components: { KbFilePicker, KbFilterBuilder, KbRecordTable, KbJsonView, KbStateBlock, KbCursorPager },
  data() {
    return { fields: [], fieldsError: null, records: [], total: null, limit: DEFAULT_LIMIT, cursor: createCursorState(), reqSeq: 0, filters: [], loading: false, loaded: false, error: null, selected: null }
  },
  computed: {
    fileId() { return String(this.$route.query.file || '') }
  },
  watch: {
    fileId: { immediate: true, handler() { resetCursor(this.cursor); this.filters = []; this.selected = null; this.stamp = structureStamp(this.fileId); this.loadFields(); this.load() } }
  },
  // keep-alive：表头映射重新结构化完成后（kbSignals），回到本页时按新版本重新拉取字段和记录
  activated() {
    if (!this.fileId || structureStamp(this.fileId) === this.stamp) return
    this.stamp = structureStamp(this.fileId)
    resetCursor(this.cursor)
    this.filters = []
    this.selected = null
    this.loadFields()
    this.load()
  },
  methods: {
    selectFile(id) {
      this.$router.replace({ name: 'FileKb', params: { tab: 'data' }, query: id ? { file: id } : {} }).catch(() => {})
    },
    async loadFields() {
      this.fieldsError = null
      if (!this.fileId) {
        this.fields = []
        return
      }
      try {
        this.fields = (await kbApi.listFields({ fileId: this.fileId })).items
      } catch (e) {
        this.fieldsError = e
        this.fields = []
      }
    },
    applyFilters(filters) {
      this.filters = filters
      resetCursor(this.cursor)
      this.load()
    },
    next() { if (goNext(this.cursor)) this.load() },
    prev() { if (goPrev(this.cursor)) this.load() },

    async load() {
      const seq = ++this.reqSeq
      this.loading = true
      try {
        const res = await kbApi.listRecords({ fileId: this.fileId || undefined, limit: this.limit, cursor: currentCursor(this.cursor) }, this.filters)
        if (seq !== this.reqSeq) return
        this.records = res.items
        this.total = res.total
        this.cursor.nextCursor = res.nextCursor
        this.error = null
      } catch (e) {
        if (seq !== this.reqSeq) return
        this.error = e
        this.records = []
        this.total = null
      } finally {
        if (seq === this.reqSeq) {
          this.loading = false
          this.loaded = true
        }
      }
    },
    locate() {
      const r = this.selected
      const loc = blockLocation(r)
      const query = { file: r.fileId }
      if (r.blockId) query.block = r.blockId
      if (loc.page != null) query.page = loc.page
      if (loc.sheet) query.sheet = loc.sheet
      if (loc.row != null) query.row = loc.row
      this.$emit('navigate', { tab: 'parse', query })
    }
  }
}
</script>
<style scoped lang="less">
.kb-data-head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.kb-data-filter { margin-bottom: 12px; }
.kb-muted { font-size: 12px; color: var(--ui-text-muted); }
.kb-section-title { font-weight: 600; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
.kb-data-body { display: flex; gap: 16px; align-items: flex-start; }
.kb-data-table { flex: 1; min-width: 0; }
.kb-data-json { width: 360px; flex: none; }
.kb-locate { margin-top: 10px; }
</style>
