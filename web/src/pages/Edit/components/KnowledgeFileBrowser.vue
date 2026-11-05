<template>
  <div>
    <el-dialog title="知识库文件预览" :visible="visible" append-to-body width="920px" custom-class="node-knowledge-browser" @close="$emit('close')">
      <nav class="knowledge-breadcrumb" aria-label="文件夹路径">
        <el-button type="text" @click="home">已挂载内容</el-button>
        <template v-for="(folder, index) in path"><span :key="folder.id + ':separator'">/</span><el-button :key="folder.id" type="text" @click="back(index)">{{ folder.name || folder.fileName }}</el-button></template>
      </nav>
      <p v-if="error" role="alert">{{ error }} <el-button type="text" @click="load(false)">重试</el-button></p>
      <div v-loading="loading" class="knowledge-browser-list">
        <p v-if="!loading && !error && !displayItems.length" class="knowledge-browser-empty">{{ path.length ? '此文件夹暂无可查看的内容' : '暂无挂载内容' }}</p>
        <button v-for="item in displayItems" :key="(item.kind || 'file') + ':' + item.id" type="button" class="knowledge-browser-row" @click="open(item)">
          <i :class="item.kind === 'folder' ? 'el-icon-folder' : 'el-icon-document'" />
          <span>{{ item.name || item.fileName }}</span><small>{{ item.kind === 'folder' ? '打开文件夹' : '预览文件' }}</small><i class="el-icon-arrow-right" />
        </button>
        <el-button v-if="path.length && (folderCursor || fileCursor)" :loading="loading" @click="load(true)">加载更多</el-button>
      </div>
      <span slot="footer"><el-button @click="$emit('close')">关闭</el-button></span>
    </el-dialog>
    <KnowledgeFileDetails :file="file" :visible="fileVisible" initial-tab="source" @close="fileVisible = false" />
  </div>
</template>
<script>
import kbApi from '@/features/knowledge-base/services/kbApi'
import KnowledgeFileDetails from './KnowledgeFileDetails.vue'
export default {
  name: 'KnowledgeFileBrowser',
  components: { KnowledgeFileDetails },
  props: { visible: Boolean, entries: { type: Array, default: () => [] } },
  data: () => ({ path: [], items: [], folderCursor: '', fileCursor: '', loading: false, error: '', request: 0, file: null, fileVisible: false }),
  computed: { displayItems() { return this.path.length ? this.items : this.entries } },
  watch: {
    visible(value) {
      this.home()
      if (value && this.entries.length === 1) this.open(this.entries[0])
    }
  },
  beforeDestroy() { this.request++ },
  methods: {
    home() { this.request++; this.path = []; this.items = []; this.folderCursor = ''; this.fileCursor = ''; this.error = ''; this.loading = false; this.fileVisible = false },
    open(item) {
      if (item.kind === 'folder') return this.enter(item)
      this.file = item; this.fileVisible = true
    },
    enter(folder) { this.path = this.path.concat(folder); return this.load(false) },
    back(index) { this.path = this.path.slice(0, index + 1); return this.load(false) },
    async load(append = false) {
      if (!this.path.length) return
      const request = ++this.request
      const folderId = this.path[this.path.length - 1].id
      this.loading = true; this.error = ''
      if (!append) { this.items = []; this.folderCursor = ''; this.fileCursor = '' }
      try {
        const [folders, files] = await Promise.all([
          append && !this.folderCursor ? { items: [] } : kbApi.listFolders({ parentId: folderId, cursor: append ? this.folderCursor : undefined, limit: 100 }),
          append && !this.fileCursor ? { items: [] } : kbApi.listFiles({ folderId, cursor: append ? this.fileCursor : undefined, limit: 50 })
        ])
        if (request !== this.request) return
        this.items = this.items.concat(folders.items.map(item => ({ ...item, kind: 'folder' })), files.items.map(item => ({ ...item, kind: 'file' })))
        this.folderCursor = folders.nextCursor || ''; this.fileCursor = files.nextCursor || ''
      } catch (error) { if (request === this.request) this.error = error.message || '读取文件夹失败' }
      finally { if (request === this.request) this.loading = false }
    }
  }
}
</script>
<style lang="less">
.node-knowledge-browser { max-width: calc(100vw - 24px); border-radius: 12px;
  .knowledge-breadcrumb { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
  .knowledge-browser-list { min-height: 180px; max-height: 58vh; overflow: auto; }
  .knowledge-browser-empty { padding: 40px 12px; text-align: center; color: var(--ui-text-secondary); }
  .knowledge-browser-row { display: flex; align-items: center; gap: 12px; width: 100%; padding: 14px 12px; border: 0; border-bottom: 1px solid var(--ui-border); background: transparent; color: var(--ui-text-primary); text-align: left; cursor: pointer; font: inherit;
    &:hover, &:focus-visible { background: var(--ui-primary-soft); }
    > span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    > small { color: var(--ui-text-secondary); white-space: nowrap; }
  }
}
</style>
