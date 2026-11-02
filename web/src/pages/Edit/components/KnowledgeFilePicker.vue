<template>
  <div>
    <el-dialog title="文件知识库" :visible="visible" append-to-body width="760px" custom-class="node-knowledge-picker" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" @close="$emit('close')">
      <p class="picker-hint">可勾选文件夹或单个文件，最多 {{ maxFiles }} 项。挂载文件夹会包含其子文件夹，后续新增文件会在读取知识时自动纳入；只读取当前有权限查看的文件。</p>
      <el-input v-model="query" clearable placeholder="搜索文件夹或文件名" prefix-icon="el-icon-search" :disabled="busy" @input="search" />
      <div v-if="error" class="picker-error" role="alert">{{ error }} <el-button type="text" @click="reload">重试</el-button></div>
      <div class="picker-tree" v-loading="loading">
        <el-tree v-if="visible" :key="treeKey" ref="tree" node-key="key" lazy show-checkbox check-strictly :load="loadNode" :props="treeProps" :default-checked-keys="selectedKeys" :expand-on-click-node="false" @check-change="checkFile" @node-click="clickNode">
          <span slot-scope="{ data, node }" class="picker-row" :class="{ 'picker-row-folder': data.kind !== 'file' }">
            <i :class="data.kind === 'folder' ? 'el-icon-folder' : data.kind === 'more' ? 'el-icon-more' : 'el-icon-document'" />
            <span class="picker-name" :title="data.name" @click="data.kind === 'folder' && (node.expanded ? node.collapse() : node.expand())">{{ data.name }}</span>
            <template v-if="data.kind === 'file'"><small>{{ size(data.size) }}</small><el-button type="text" size="mini" @click.stop="details = data; detailsVisible = true">查看解析</el-button></template>
          </span>
        </el-tree>
      </div>
      <div class="picker-selected"><strong>已选 {{ selectedFiles.length }} 项（文件夹 / 文件）</strong><div v-for="file in selectedFiles" :key="selectionKey(file)" class="picker-selected-file"><el-tag :closable="!busy && !readonly" @close="remove(file)"><span v-if="file.kind === 'folder'">文件夹：{{ file.name || file.fileName }}</span><a v-else :href="fileUrl(file)" target="_blank" rel="noopener" :aria-label="`打开文件 ${file.name || file.fileName}`">{{ file.name || file.fileName }}</a></el-tag><small v-if="file.kind === 'folder'">含子文件夹 · 自动纳入新增文件</small><el-button v-else type="text" size="mini" @click="details = file; detailsVisible = true">查看解析</el-button></div></div>
      <p v-if="saveError" class="picker-error" role="alert">{{ saveError }}</p>
      <span slot="footer"><el-button :disabled="busy" @click="$emit('close')">关闭</el-button><el-button v-if="!readonly" type="primary" :loading="busy" :disabled="selectedFiles.length > maxFiles" @click="$emit('choose', selectedFiles)">保存挂载（{{ selectedFiles.length }}）</el-button></span>
    </el-dialog>
    <KnowledgeFileDetails :file="details" :visible="detailsVisible" @close="detailsVisible = false" />
  </div>
</template>
<script>
import kbApi from '@/features/knowledge-base/services/kbApi'
import { formatSize } from '@/features/knowledge-base/utils/format'
import { MAX_KNOWLEDGE_FILES, knowledgeFileUrl } from '@/utils/knowledgeFiles'
import KnowledgeFileDetails from './KnowledgeFileDetails.vue'
export default {
  name: 'KnowledgeFilePicker', components: { KnowledgeFileDetails },
  props: { visible: Boolean, busy: Boolean, readonly: Boolean, attachedFiles: { type: Array, default: () => [] }, saveError: { type: String, default: '' } },
  data: () => ({ query: '', selected: {}, loading: false, error: '', treeKey: 0, request: 0, details: null, detailsVisible: false, maxFiles: MAX_KNOWLEDGE_FILES }),
  computed: {
    selectedFiles() { return Object.values(this.selected) },
    selectedKeys() { return this.selectedFiles.map(this.selectionKey) },
    treeProps() { return { label: 'name', isLeaf: data => data.kind !== 'folder', disabled: data => data.kind === 'more' || this.busy || this.readonly } }
  },
  watch: { visible(value) { clearTimeout(this.timer); this.request++; this.detailsVisible = false; if (value) { this.query = ''; this.selected = Object.fromEntries(this.attachedFiles.map(file => [this.selectionKey(file), file])); this.reload() } } },
  beforeDestroy() { clearTimeout(this.timer); this.request++ },
  methods: {
    fileUrl(file) { return knowledgeFileUrl(file) },
    selectionKey(file) { return `${file.kind === 'folder' ? 'folder' : 'file'}:${file.id}` },
    size: formatSize,
    search() { clearTimeout(this.timer); this.request++; this.timer = setTimeout(this.reload, 300) },
    reload() { this.request++; this.error = ''; this.treeKey++; },
    async fetchChildren(folderId, folderCursor, fileCursor, foldersDone = false, filesDone = false) {
      // 搜索根结果同时匹配文件夹和文件；展开命中的文件夹时展示其完整内容。
      const search = folderId ? '' : this.query.trim()
      const [folders, files] = await Promise.all([
        foldersDone ? { items: [] } : kbApi.listFolders({ parentId: folderId, q: search, cursor: folderCursor, limit: 100 }),
        filesDone ? { items: [] } : kbApi.listFiles({ folderId: folderId || undefined, q: search, cursor: fileCursor, limit: 50 })
      ])
      const visibleFiles = folderId || search ? files.items : files.items.filter(file => !file.folderId && !file.folder_id)
      const children = folders.items.map(folder => ({ ...folder, key: 'folder:' + folder.id, kind: 'folder' })).concat(visibleFiles.map(file => ({ ...file, name: file.name || file.fileName, key: 'file:' + file.id, kind: 'file' })))
      if (folders.nextCursor || files.nextCursor) children.push({ key: 'more:' + (++this.moreSequence), name: '加载更多…', kind: 'more', folderId, folderCursor: folders.nextCursor, fileCursor: files.nextCursor, foldersDone: !folders.nextCursor, filesDone: !files.nextCursor })
      return children
    },
    async loadNode(node, resolve) {
      const request = this.request
      if (!node.level) this.loading = true
      try {
        const children = await this.fetchChildren(node.level ? node.data.id : '')
        if (request !== this.request) return resolve([])
        resolve(children)
      } catch (error) { if (request === this.request) this.error = error.message || '读取文件夹失败'; resolve([]) }
      finally { if (request === this.request) this.loading = false }
    },
    async clickNode(data, node) {
      if (data.kind !== 'more' || data.loading) return
      const request = this.request
      data.loading = true
      try {
        const children = await this.fetchChildren(data.folderId, data.folderCursor, data.fileCursor, data.foldersDone, data.filesDone)
        if (request !== this.request) return
        children.forEach(child => this.$refs.tree.append(child, node.parent.level ? node.parent : null)); this.$refs.tree.remove(data)
      } catch (error) { this.error = error.message }
      finally { data.loading = false }
    },
    checkFile(file, checked) {
      if (!['file', 'folder'].includes(file.kind) || this.busy || this.readonly) return
      const key = this.selectionKey(file)
      if (checked) {
        if (!this.selected[key] && this.selectedFiles.length >= this.maxFiles) { this.$refs.tree.setChecked(key, false); this.$message.warning(`最多选择 ${this.maxFiles} 项`); return }
        this.$set(this.selected, key, file)
      } else this.$delete(this.selected, key)
    },
    remove(file) { const key = this.selectionKey(file); this.$delete(this.selected, key); if (this.$refs.tree) this.$refs.tree.setChecked(key, false) }
  },
  created() { this.moreSequence = 0 }
}
</script>
<style lang="less">
.node-knowledge-picker { max-width: calc(100vw - 24px); border-radius: 12px;
  .el-dialog__body { padding: 12px 20px; }
  .picker-hint { margin: 0 0 14px; color: var(--ui-text-secondary); line-height: 1.7; font-size: 13px; }
  .picker-tree { margin-top: 12px; min-height: 180px; max-height: 38vh; overflow: auto; .el-tree-node__content { height: auto; min-height: 42px; } }
  .picker-row { display: flex; gap: 8px; align-items: center; min-width: 0; flex: 1; padding-right: 8px; }
  .picker-name { flex: 1; min-width: 0; white-space: normal; overflow-wrap: anywhere; line-height: 1.5; }
  .picker-row small { color: var(--ui-text-secondary); white-space: nowrap; }
  .picker-error { color: var(--ui-danger, #e64b50); margin-top: 12px; }
  .picker-selected { margin-top: 14px; max-height: 130px; overflow: auto; strong { display: block; margin-bottom: 6px; font-size: 13px; } }
  .picker-selected-file { display: flex; gap: 8px; align-items: center; .el-tag { max-width: 80%; overflow: hidden; text-overflow: ellipsis; } }
  .picker-selected-file a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
}
</style>
