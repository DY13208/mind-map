<template>
  <el-dialog :title="file ? (file.name || file.fileName) : '文件解析信息'" :visible="visible" append-to-body width="920px" custom-class="node-knowledge-details" @close="$emit('close')">
    <div v-loading="loading">
      <p v-if="error" role="alert">{{ error }} <el-button type="text" @click="load">重试</el-button></p>
      <template v-if="current">
        <p class="details-meta">{{ current.status }} · {{ size(current.size) }}<span v-if="current.parseVersion"> · 解析版本 {{ current.parseVersion }}</span></p>
        <el-tabs v-model="tab">
          <el-tab-pane label="原文预览" name="source" lazy><KnowledgeSourcePreview v-if="visible && tab === 'source'" :key="current.id" :file="current" /></el-tab-pane>
          <el-tab-pane label="解析内容" name="parsed">
            <p v-if="parsedError" role="alert">{{ parsedError }} <el-button type="text" @click="loadParsed(request)">重试</el-button></p>
            <p v-if="!parsedLoading && !parsedError && !blocks.length">暂无解析结果，请在文件知识库中检查解析状态。</p>
            <div v-loading="parsedLoading" class="details-blocks" tabindex="0" aria-label="文件解析内容">
              <section v-for="(block, index) in blocks" :key="block.id || index"><small>{{ block.type }}<span v-if="block.page"> · 第 {{ block.page }} 页</span><span v-if="block.sheet"> · {{ block.sheet }}</span></small><pre>{{ block.text || (block.data ? json(block.data) : '') }}</pre></section>
              <el-button v-if="nextCursor" :loading="moreLoading" @click="more">加载更多解析内容</el-button>
            </div>
          </el-tab-pane>
        </el-tabs>
      </template>
    </div>
  </el-dialog>
</template>
<script>
import kbApi from '@/features/knowledge-base/services/kbApi'
import { formatSize } from '@/features/knowledge-base/utils/format'
import KnowledgeSourcePreview from './KnowledgeSourcePreview.vue'
export default {
  name: 'KnowledgeFileDetails', components: { KnowledgeSourcePreview },
  props: { file: { type: Object, default: null }, visible: Boolean, initialTab: { type: String, default: 'source' } },
  data: () => ({ current: null, blocks: [], nextCursor: '', loading: false, moreLoading: false, error: '', parsedError: '', parsedLoading: false, tab: 'source', request: 0 }),
  watch: { visible(value) { this.request++; if (value) this.load() }, file(value, old) { if (this.visible && value !== old) this.load() } },
  beforeDestroy() { this.request++ },
  methods: {
    size: formatSize, json: value => JSON.stringify(value, null, 2),
    async load() {
      if (!this.file) return
      const request = ++this.request
      this.loading = true; this.error = ''; this.current = null; this.blocks = []; this.nextCursor = ''; this.tab = this.initialTab; this.parsedError = ''; this.parsedLoading = false; this.moreLoading = false
      try {
        const file = await kbApi.getFile(this.file.id)
        if (request !== this.request) return
        this.current = file; this.loadParsed(request)
      } catch (error) { if (request === this.request) this.error = error.message || '读取解析信息失败' }
      finally { if (request === this.request) this.loading = false }
    },
    async loadParsed(request) {
      this.parsedLoading = true; this.parsedError = ''
      try {
        const parsed = await kbApi.getBlocks(this.file.id, { limit: 100 })
        if (request !== this.request) return
        this.blocks = parsed.items; this.nextCursor = parsed.nextCursor || ''
      } catch (error) { if (request === this.request) this.parsedError = error.message || '读取解析内容失败' }
      finally { if (request === this.request) this.parsedLoading = false }
    },
    async more() {
      const request = this.request
      this.moreLoading = true
      try {
        const parsed = await kbApi.getBlocks(this.file.id, { cursor: this.nextCursor, limit: 100 })
        if (request !== this.request) return
        this.blocks = this.blocks.concat(parsed.items); this.nextCursor = parsed.nextCursor || ''
      } catch (error) { if (request === this.request) this.$message.error(error.message) }
      finally { if (request === this.request) this.moreLoading = false }
    }
  }
}
</script>
<style lang="less">
.node-knowledge-details { max-width: calc(100vw - 24px); border-radius: 12px;
  .details-meta { color: var(--ui-text-secondary); font-size: 13px; }
  .details-blocks { max-height: 55vh; overflow: auto; section { padding: 12px 0; border-bottom: 1px solid var(--ui-border); } small { color: var(--ui-text-secondary); } pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.7; } }
}
</style>
