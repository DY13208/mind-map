<template>
  <div class="kb-parse">
    <div class="kb-card kb-parse-head">
      <KbFilePicker :value="fileId" :current="file" placeholder="选择要查看的文件" @input="selectFile" />
      <template v-if="file">
        <KbStatusTag :status="file.status" :detail="file.error || file.statusDetail || ''" />
        <span class="kb-muted">{{ size(file.size != null ? file.size : file.byteSize) }} · 更新于 {{ time(file.updatedAt || file.createdAt) }}</span>
        <span v-if="file.parseVersion || file.parse_version" class="kb-muted">解析版本 {{ file.parseVersion || file.parse_version }}</span>
        <span class="kb-spacer" />
        <el-button size="small" icon="el-icon-refresh-right" :loading="reparsing" @click="reparse">重新解析</el-button>
        <el-button size="small" icon="el-icon-download" @click="openRaw">原文件</el-button>
      </template>
    </div>
    <div v-if="file && file.error" class="kb-parse-error"><i class="el-icon-warning" aria-hidden="true" />{{ file.error }}</div>
    <KbHeaderMap v-if="file && file.ext === 'xlsx'" :file-id="fileId" :file-size="Number(file.size) || 0" :active="active" @submitted="refreshFile" @done="refreshFile" />
    <KbStateBlock
      :loading="loadingFile"
      :error="fileError"
      :empty="!fileId"
      empty-title="未选择文件"
      empty-description="从上方选择文件，或在文件管理中点击「解析」"
      empty-icon="el-icon-document"
      @retry="loadFile"
    >
      <div v-if="file" class="kb-parse-panes">
        <div class="kb-card kb-pane">
          <div class="kb-pane-title">原文预览</div>
          <KbSourcePreview :file="file" :block="previewBlock" @markdown-source="markdownSource = $event" />
        </div>
        <div class="kb-card kb-pane">
          <div class="kb-pane-title">
            解析结果<span v-if="blocks.length" class="kb-muted">（{{ blocks.length }} 块，点击定位原文）</span>
          </div>
          <KbStateBlock
            :loading="loadingBlocks"
            :error="blocksError"
            :empty="!blocks.length"
            :empty-title="active ? '正在解析' : '暂无解析结果'"
            :empty-description="active ? '解析完成后自动刷新' : '该文件尚未产生解析块'"
            @retry="loadBlocks"
          >
            <div class="kb-block-scroll">
              <KbBlockList :blocks="locatedBlocks" :active-id="activeId" @select="onSelect" />
              <div v-if="blocksCursor" class="kb-more">
                <el-button size="small" :loading="loadingMore" @click="loadMoreBlocks">加载更多解析块</el-button>
              </div>
            </div>
          </KbStateBlock>
        </div>
      </div>
    </KbStateBlock>
  </div>
</template>
<script>
import { locateMarkdownBlocks } from '../utils/markdown'
import kbApi from '../services/kbApi'
import { createPoller } from '../services/kbPolling'
import { ACTIVE_STATUSES } from '../constants/status'
import { formatSize, formatTime } from '../utils/format'
import KbFilePicker from '../components/KbFilePicker.vue'
import KbStatusTag from '../components/KbStatusTag.vue'
import KbStateBlock from '../components/KbStateBlock.vue'
import KbSourcePreview from '../components/KbSourcePreview.vue'
import KbBlockList from '../components/KbBlockList.vue'
import KbHeaderMap from '../components/KbHeaderMap.vue'
export default {
  name: 'KbParseDetailTab',
  components: { KbFilePicker, KbStatusTag, KbStateBlock, KbSourcePreview, KbBlockList, KbHeaderMap },
  data() {
    return { markdownSource: null, file: null, fileError: null, loadingFile: false, blocks: [], blocksCursor: null, loadingMore: false, blocksError: null, loadingBlocks: false, activeId: null, activeBlock: null, reparsing: false }
  },
  computed: {
    locatedBlocks() { return locateMarkdownBlocks(this.blocks, this.markdownSource) },
    previewBlock() { return this.locatedBlocks.find(b => this.activeBlock && b.id === this.activeBlock.id) || this.activeBlock },
    fileId() { return String(this.$route.query.file || '') },
    active() { return !!this.file && ACTIVE_STATUSES.includes(this.file.status) }
  },
  watch: {
    fileId: { immediate: true, handler() { this.loadFile() } },
    active(v) { if (v) this.poller.start(); else this.poller.stop() }
  },
  created() {
    this.poller = createPoller(async () => {
      const before = this.file && this.file.status
      this.file = await kbApi.getFile(this.fileId)
      if (before !== this.file.status) { this.loadBlocks(); return 'changed' }
      return this.active
    }, { min: 3000 })
  },
  activated() { if (this.active) this.poller.start() },
  deactivated() { this.poller.stop() },
  beforeDestroy() { this.poller.stop() },
  methods: {
    size: formatSize,
    time: formatTime,
    selectFile(id) {
      this.$router.replace({ name: 'FileKb', params: { tab: 'parse' }, query: id ? { file: id } : {} }).catch(() => {})
    },
    async loadFile() {
      this.markdownSource = null
      this.file = null
      this.blocks = []
      this.blocksCursor = null
      this.activeId = null
      this.activeBlock = null
      if (!this.fileId) return
      this.loadingFile = true
      this.fileError = null
      try {
        this.file = await kbApi.getFile(this.fileId)
        this.loadBlocks()
      } catch (e) {
        this.fileError = e
      } finally {
        this.loadingFile = false
      }
    },
    // 表头映射提交/完成后刷新：不清空 file，避免卸载映射组件丢掉提交状态
    async refreshFile() {
      if (!this.fileId) return
      try {
        this.file = await kbApi.getFile(this.fileId)
        this.loadBlocks()
      } catch (e) {
        this.fileError = e
      }
    },
    async loadBlocks() {
      this.loadingBlocks = true
      this.blocksError = null
      try {
        const res = await kbApi.getBlocks(this.fileId, { limit: 200 })
        this.blocks = res.items
        this.blocksCursor = res.nextCursor
        const want = this.$route.query.block
        if (want) {
          const i = this.blocks.findIndex(b => String(b.id) === String(want))
          if (i >= 0) this.onSelect({ block: this.blocks[i], id: this.blocks[i].id })
        } else if (this.$route.query.page || this.$route.query.row || this.$route.query.sheet) {
          const q = this.$route.query
          this.activeBlock = {
            page: q.page != null && q.page !== '' ? Number(q.page) : null,
            sheet: q.sheet || null,
            row: q.row != null && q.row !== '' ? Number(q.row) : null
          }
        }
      } catch (e) {
        this.blocksError = e
        this.blocks = []
        this.blocksCursor = null
      } finally {
        this.loadingBlocks = false
      }
    },
    // 解析块按 200 条一批向后追加（只增不重排）
    async loadMoreBlocks() {
      this.loadingMore = true
      try {
        const res = await kbApi.getBlocks(this.fileId, { limit: 200, cursor: this.blocksCursor })
        this.blocks = this.blocks.concat(res.items)
        this.blocksCursor = res.nextCursor
      } catch (e) {
        this.$message.error(e.message)
      } finally {
        this.loadingMore = false
      }
    },
    onSelect({ block, id }) {
      this.activeId = id
      this.activeBlock = block
    },
    async reparse() {
      this.reparsing = true
      try {
        await kbApi.reparseFile(this.fileId)
        this.$message.success('已提交重新解析')
        this.file = await kbApi.getFile(this.fileId)
      } catch (e) {
        this.$message.error(e.message)
      } finally {
        this.reparsing = false
      }
    },
    openRaw() { window.open(kbApi.rawUrl(this.fileId), '_blank', 'noopener') }
  }
}
</script>
<style scoped lang="less">
.kb-parse-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 12px;
}
.kb-spacer { flex: 1; }
.kb-more { text-align: center; padding: 8px 0; }
.kb-muted { font-size: 12px; color: var(--ui-text-muted); }
.kb-parse-error {
  margin-bottom: 12px;
  padding: 8px 12px;
  border-radius: var(--ui-radius-md);
  background: var(--ui-danger-soft);
  border: 1px solid var(--ui-danger-border);
  color: var(--ui-danger);
  font-size: 13px;
  i { margin-right: 6px; font-weight: 700; }
}
.kb-parse-panes {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
  gap: 16px;
}
.kb-pane {
  display: flex;
  flex-direction: column;
  min-height: 520px;
  max-height: calc(100vh - 240px);
}
.kb-pane-title {
  font-weight: 600;
  margin-bottom: 10px;
}
.kb-block-scroll {
  flex: 1;
  overflow: auto;
  max-height: calc(100vh - 320px);
  padding-right: 4px;
}
@media (max-width: 1100px) {
  .kb-parse-panes { grid-template-columns: 1fr; }
}
</style>
