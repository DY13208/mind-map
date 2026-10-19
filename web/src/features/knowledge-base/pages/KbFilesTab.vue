<template>
  <div class="kb-files">
    <aside class="kb-card kb-files-side">
      <KbFolderTree ref="tree" v-model="folderId" @path="p => (folderPath = p)" @acl="openAcl" />
    </aside>
    <section class="kb-files-main">
      <div class="kb-card">
        <div class="kb-toolbar">
          <div class="kb-crumb">
            <span class="kb-crumb-item" @click="$refs.tree.select('')">全部文件</span>
            <template v-for="p in folderPath">
              <span :key="'s' + p.id" class="kb-crumb-sep">/</span>
              <span :key="p.id" class="kb-crumb-item" @click="$refs.tree.select(p.id)">{{ p.name }}</span>
            </template>
          </div>
          <div class="kb-toolbar-actions">
            <el-input v-model="q" size="small" prefix-icon="el-icon-search" placeholder="搜索文件名" clearable class="kb-search" @input="debouncedLoad" />
            <el-select v-model="status" size="small" placeholder="全部状态" clearable popper-class="kb-popper" class="kb-status-filter" @change="reload">
              <el-option v-for="(m, k) in statuses" :key="k" :label="m.label" :value="k" />
            </el-select>
            <el-button size="small" icon="el-icon-refresh-right" @click="load">刷新</el-button>
            <el-button size="small" icon="el-icon-files" @click="openBatches('')">批次任务</el-button>
            <el-button size="small" type="primary" :icon="showUpload ? 'el-icon-close' : 'el-icon-upload2'" @click="showUpload = !showUpload">{{ showUpload ? '收起上传' : '上传文件' }}</el-button>
          </div>
        </div>
        <KbUploadPanel
          v-show="showUpload"
          ref="upload"
          :folder-id="folderId"
          :folder-label="folderPath.length ? folderPath[folderPath.length - 1].name : '全部文件（根目录）'"
          class="kb-upload-wrap"
          @folders-changed="id => $refs.tree && $refs.tree.refreshNode(id)"
          @uploaded="load"
          @open-batches="openBatches('')"
          @open-batch="openBatches"
          @batch-changed="onBatchChanged"
        />
        <KbStateBlock :loading="loading && !loaded" :error="error" :empty="loaded && !files.length" empty-title="暂无文件" empty-description="上传文件后会自动解析并结构化入库" empty-icon="el-icon-folder-opened" @retry="load">
          <KbFileTable
            ref="table"
            :files="files"
            @open="f => go('parse', f)"
            @data="f => go('data', f)"
            @reparse="reparse([$event])"
            @delete="remove([$event])"
            @acl="f => openAcl({ type: 'file', id: f.id, name: f.name || f.fileName })"
            @batch-reparse="reparse"
            @batch-delete="remove"
          />
          <KbCursorPager
            :page="cursor.index + 1"
            :count="files.length"
            :total="total"
            :has-prev="cursor.index > 0"
            :has-next="!!cursor.nextCursor"
            :loading="loading"
            @prev="prev"
            @next="next"
          />
        </KbStateBlock>
      </div>
    </section>
    <KbPermissionDialog :visible.sync="aclVisible" :target="aclTarget" />
    <KbBatchDrawer
      ref="drawer"
      :visible="batchesVisible"
      :batch-id="batchId"
      :local-active="localActiveBatches"
      @update:visible="v => (v ? openBatches(batchId) : closeBatches())"
      @update:batchId="openBatches"
      @closed="id => $refs.upload && $refs.upload.onBatchClosed(id)"
      @supplement="supplement"
      @navigate="e => { closeBatches(); $emit('navigate', e) }"
    />
  </div>
</template>
<script>
import kbApi, { DEFAULT_LIMIT } from '../services/kbApi'
import { createPoller } from '../services/kbPolling'
import { createCursorState, currentCursor, goNext, goPrev, resetCursor } from '../services/kbCursor'
import { FILE_STATUS, ACTIVE_STATUSES } from '../constants/status'
import KbFolderTree from '../components/KbFolderTree.vue'
import KbUploadPanel from '../components/KbUploadPanel.vue'
import KbFileTable from '../components/KbFileTable.vue'
import KbStateBlock from '../components/KbStateBlock.vue'
import KbCursorPager from '../components/KbCursorPager.vue'
import KbPermissionDialog from '../components/KbPermissionDialog.vue'
import KbBatchDrawer from '../components/KbBatchDrawer.vue'
// 大数据量策略：服务端 keyset 分页（每页固定 50 条，DOM 只渲染当前页）；
// 搜索 300ms 防抖后走服务端；轮询只针对当前页中处于进行中状态的行（ids=...）。
export default {
  name: 'KbFilesTab',
  components: { KbFolderTree, KbUploadPanel, KbFileTable, KbStateBlock, KbCursorPager, KbPermissionDialog, KbBatchDrawer },
  data() {
    return {
      folderId: '', folderPath: [], files: [], total: null, limit: DEFAULT_LIMIT, q: '', status: '',
      cursor: createCursorState(), loading: false, loaded: false, error: null, showUpload: false,
      aclVisible: false, aclTarget: null, statuses: FILE_STATUS, reqSeq: 0, localActiveBatches: []
    }
  },
  computed: {
    activeIds() { return this.files.filter(f => ACTIVE_STATUSES.includes(f.status)).map(f => f.id) },
    hasActive() { return this.activeIds.length > 0 },
    // 批次视图放在路由 query 里（batches=1、batch=<id>），刷新后从后端重新读取，不依赖内存
    batchesVisible() { return this.$route.query.batches === '1' || !!this.$route.query.batch },
    batchId() { const v = this.$route.query.batch; return typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : '' }
  },
  watch: {
    folderId() { this.reload() },
    hasActive(v) { if (v) this.poller.start(); else this.poller.stop() }
  },
  created() {
    this.poller = createPoller(() => this.refreshActive())
    this.load()
  },
  activated() { if (this.hasActive) this.poller.start() },
  deactivated() { this.poller.stop() },
  beforeDestroy() {
    this.poller.stop()
    clearTimeout(this.timer)
  },
  methods: {
    debouncedLoad() {
      clearTimeout(this.timer)
      this.timer = setTimeout(this.reload, 300)
    },
    reload() {
      resetCursor(this.cursor)
      this.load()
    },
    next() { if (goNext(this.cursor)) this.load() },
    prev() { if (goPrev(this.cursor)) this.load() },
    async load() {
      const seq = ++this.reqSeq
      this.loading = true
      try {
        const res = await kbApi.listFiles({ folderId: this.folderId, q: this.q, status: this.status, limit: this.limit, cursor: currentCursor(this.cursor) })
        if (seq !== this.reqSeq) return
        this.files = res.items
        this.total = res.total
        this.cursor.nextCursor = res.nextCursor
        this.error = null
        if (this.$refs.table) this.$refs.table.clearSelection()
      } catch (e) {
        if (seq !== this.reqSeq) return
        this.error = e
        this.files = []
      } finally {
        if (seq === this.reqSeq) {
          this.loading = false
          this.loaded = true
        }
      }
    },
    // 只刷新当前页进行中的行，按 id 合并，不重排、不清空选择
    async refreshActive() {
      const ids = this.activeIds
      if (!ids.length) return false
      const { items } = await kbApi.listFiles({ ids, limit: ids.length })
      let changed = false
      const byId = {}
      items.forEach(f => { byId[f.id] = f })
      this.files = this.files.map(f => {
        const n = byId[f.id]
        if (n && n.status !== f.status) changed = true
        return n ? { ...f, ...n } : f
      })
      if (!this.hasActive) return false
      return changed ? 'changed' : true
    },
    go(tab, f) { this.$emit('navigate', { tab, query: { file: f.id } }) },
    setBatchQuery(patch) {
      const query = { ...this.$route.query }
      delete query.batches
      delete query.batch
      Object.assign(query, patch)
      this.$router.replace({ name: 'FileKb', params: { tab: 'files' }, query }).catch(() => {})
    },
    openBatches(id) { this.setBatchQuery(id ? { batch: id } : { batches: '1' }) },
    closeBatches() { this.setBatchQuery({}) },
    onBatchChanged(status) {
      const up = this.$refs.upload
      this.localActiveBatches = up ? up.localBatches.filter(b => !b.sealed).map(b => b.id) : []
      if (status && status.id && this.$refs.drawer) this.$refs.drawer.refreshIf(status.id)
    },
    supplement({ batch, files }) {
      if (!this.$refs.upload) return
      this.showUpload = true
      this.$refs.upload.addToBatch(files, batch)
      this.onBatchChanged()
      this.$message.info(`已加入上传队列：${files.length} 个文件补传到「${batch.name || '批次'}」，上传到当前文件夹`)
    },
    openAcl(t) {
      this.aclTarget = t
      this.aclVisible = true
    },
    async reparse(list) {
      const results = await Promise.allSettled(list.map(f => kbApi.reparseFile(f.id)))
      this.report(results, '已提交重新解析')
      this.load()
    },
    async remove(list) {
      try {
        await this.$confirm(`确定删除当前页选中的 ${list.length} 个文件？`, '删除文件', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
      } catch (_) {
        return
      }
      const results = await Promise.allSettled(list.map(f => kbApi.deleteFile(f.id)))
      this.report(results, '已删除')
      this.load()
    },
    report(results, okText) {
      const failed = results.filter(r => r.status === 'rejected')
      if (!failed.length) this.$message.success(okText)
      else this.$message.error(`${failed.length} 项失败：${failed[0].reason.message}`)
    }
  }
}
</script>
<style scoped lang="less">
.kb-files {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}
.kb-files-side {
  width: 240px;
  flex: none;
  max-height: calc(100vh - 220px);
  overflow: auto;
}
.kb-files-main {
  flex: 1;
  min-width: 0;
}
.kb-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 12px;
}
.kb-crumb {
  font-size: 14px;
  font-weight: 600;
}
.kb-crumb-item {
  cursor: pointer;
  &:hover { color: var(--ui-primary); }
}
.kb-crumb-sep { margin: 0 6px; color: var(--ui-text-muted); }
.kb-toolbar-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.kb-search { width: 200px; }
.kb-status-filter { width: 130px; }
.kb-upload-wrap { margin-bottom: 14px; }
</style>
