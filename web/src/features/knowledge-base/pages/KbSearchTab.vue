<template>
  <div class="kb-search-tab">
    <div class="kb-card kb-search-bar">
      <div class="kb-search-control">
        <el-input v-model.trim="q" prefix-icon="el-icon-search" placeholder="输入关键词，在有权限的文件中检索" clearable class="kb-search-input" @input="debouncedRun" @keyup.enter.native="run" />
        <el-button type="primary" class="kb-search-btn" :loading="loading" @click="run">检索</el-button>
      </div>
      <el-select v-model="mode" popper-class="kb-popper" class="kb-search-mode" @change="run">
        <el-option label="混合检索" value="hybrid" />
        <el-option label="关键词" value="keyword" />
        <el-option label="语义" value="semantic" />
      </el-select>
    </div>
    <KbStateBlock
      :loading="loading"
      :error="error"
      :empty="searched && !results.length"
      empty-title="没有找到相关内容"
      empty-description="换个关键词试试"
      empty-icon="el-icon-search"
      @retry="run"
    >
      <div v-if="!searched" class="kb-search-hint">检索结果仅包含你有权限查看的文件</div>
      <div v-else class="kb-search-meta">第 {{ cursor.index + 1 }} 页<template v-if="total != null"> · 共 {{ total }} 条结果</template></div>
      <div v-for="(r, i) in results" :key="r.id || i" class="kb-card kb-result">
        <div class="kb-result-head">
          <i class="el-icon-document" aria-hidden="true" />
          <span class="kb-result-name">{{ r.fileName || r.file_name || (r.file && r.file.name) || '未命名文件' }}</span>
          <span class="kb-result-loc">{{ locLabel(r) }}</span>
          <span v-if="r.score != null" class="kb-result-score">相关度 {{ Number(r.score).toFixed(3) }}</span>
          <span class="kb-spacer" />
          <el-button size="mini" icon="el-icon-aim" :disabled="!fileIdOf(r)" @click="locate(r)">定位</el-button>
        </div>
        <div class="kb-result-snippet">{{ r.snippet || r.text || '' }}</div>
        <div v-if="!loc(r).precise" class="kb-result-imprecise">解析器未提供精确位置</div>
      </div>
      <KbCursorPager :page="cursor.index + 1" :count="results.length" :total="total" :has-prev="cursor.index > 0" :has-next="!!cursor.nextCursor" :loading="loading" @prev="prev" @next="next" />
    </KbStateBlock>
  </div>
</template>
<script>
import kbApi from '../services/kbApi'
import { blockLocation, locationLabel } from '../utils/format'
import KbStateBlock from '../components/KbStateBlock.vue'
import KbCursorPager from '../components/KbCursorPager.vue'
import { createCursorState, currentCursor, goNext, goPrev, resetCursor } from '../services/kbCursor'
export default {
  name: 'KbSearchTab',
  components: { KbStateBlock, KbCursorPager },
  data() {
    return { q: String(this.$route.query.q || ''), mode: 'hybrid', results: [], total: null, cursor: createCursorState(), reqSeq: 0, loading: false, error: null, searched: false }
  },
  created() { if (this.q) this.run() },
  beforeDestroy() { clearTimeout(this.timer) },
  methods: {
    loc: blockLocation,
    locLabel(r) { return locationLabel(blockLocation(r)) },
    fileIdOf(r) { return r.fileId || r.file_id || (r.file && r.file.id) || '' },
    // 输入 400ms 防抖后服务端检索；回车/按钮立即检索
    debouncedRun() {
      clearTimeout(this.timer)
      this.timer = setTimeout(this.run, 400)
    },
    run() {
      clearTimeout(this.timer)
      resetCursor(this.cursor)
      if (!this.q) {
        this.reqSeq++
        this.results = []
        this.searched = false
        this.loading = false
        return
      }
      this.fetch()
    },
    next() { if (goNext(this.cursor)) this.fetch() },
    prev() { if (goPrev(this.cursor)) this.fetch() },
    async fetch() {
      const seq = ++this.reqSeq
      this.loading = true
      this.error = null
      try {
        const res = await kbApi.search({ q: this.q, mode: this.mode, limit: 20, cursor: currentCursor(this.cursor) })
        if (seq !== this.reqSeq) return
        this.results = res.items
        this.total = res.total
        this.cursor.nextCursor = res.nextCursor
      } catch (e) {
        if (seq !== this.reqSeq) return
        this.error = e
        this.results = []
      } finally {
        if (seq === this.reqSeq) {
          this.loading = false
          this.searched = true
        }
      }
    },
    locate(r) {
      const l = blockLocation(r)
      const query = { file: this.fileIdOf(r) }
      if (r.blockId || r.block_id) query.block = r.blockId || r.block_id
      if (l.page != null) query.page = l.page
      if (l.sheet) query.sheet = l.sheet
      if (l.row != null) query.row = l.row
      this.$emit('navigate', { tab: 'parse', query })
    }
  }
}
</script>
<style scoped lang="less">
.kb-search-bar { display: flex; gap: 10px; align-items: center; margin-bottom: 14px; }
/* 输入框 + 按钮拼成一个整体控件，统一 40px 高 */
.kb-search-control {
  flex: 1;
  max-width: 720px;
  display: flex;
  align-items: stretch;
  height: 40px;
}
.kb-search-input {
  flex: 1;
  ::v-deep .el-input__inner {
    height: 40px;
    line-height: 40px;
    border-radius: var(--ui-radius-md) 0 0 var(--ui-radius-md);
    border-right: 0;
    background: var(--ui-input-bg);
    border-color: var(--ui-border);
    color: var(--ui-text);
    &:focus { border-color: var(--ui-primary); background: var(--ui-input-focus-bg); }
  }
}
.kb-search-btn.el-button {
  height: 40px;
  padding: 0 22px;
  margin: 0;
  border-radius: 0 var(--ui-radius-md) var(--ui-radius-md) 0;
  background: var(--ui-primary);
  border-color: var(--ui-primary);
  color: var(--ui-on-primary);
  font-weight: 600;
  &:hover, &:focus { background: var(--ui-primary-hover); border-color: var(--ui-primary-hover); color: var(--ui-on-primary); }
}
.kb-search-mode {
  width: 120px;
  ::v-deep .el-input__inner {
    height: 40px;
    line-height: 40px;
    border-radius: var(--ui-radius-md);
    background: var(--ui-input-bg);
    border-color: var(--ui-border);
    color: var(--ui-text);
  }
}
.kb-search-hint, .kb-search-meta { font-size: 13px; color: var(--ui-text-muted); margin-bottom: 10px; }
.kb-result { margin-bottom: 10px; }
.kb-result-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  i { font-weight: 700; color: var(--ui-primary); }
}
.kb-result-name { font-weight: 600; color: var(--ui-text); }
.kb-result-loc, .kb-result-score { color: var(--ui-text-muted); font-size: 12px; }
.kb-spacer { flex: 1; }
.kb-result-snippet {
  margin-top: 8px;
  font-size: 13px;
  line-height: 1.65;
  color: var(--ui-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}
.kb-result-imprecise { margin-top: 4px; font-size: 12px; color: var(--ui-star); }
</style>
