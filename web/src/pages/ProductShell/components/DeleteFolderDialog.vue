<template>
  <el-dialog
    :visible.sync="shown"
    title="删除文件夹"
    width="520px"
    class="deleteFolderDialog"
    :close-on-click-modal="false"
    :close-on-press-escape="!busy"
    :show-close="!busy"
    append-to-body
  >
    <p class="folderName">{{ folder ? folder.name : '' }}</p>
    <p v-if="loading" role="status">正在检查文件夹内容…</p>
    <template v-else-if="preview">
      <template v-if="hasContents">
        <p class="description">此文件夹及其下级包含 {{ preview.roomCount }} 个脑图<span v-if="preview.folderCount">、{{ preview.folderCount }} 个子文件夹</span>。请选择如何处理内容。</p>
        <el-radio-group v-model="action" :disabled="busy" class="actions">
          <el-radio label="move" :disabled="!preview.canMove">移到其他文件夹，再删除原文件夹</el-radio>
          <el-radio label="trash" :disabled="!preview.canTrash">全部删除</el-radio>
        </el-radio-group>
        <template v-if="action === 'move'">
          <label class="targetLabel" for="delete-folder-target">移动到</label>
          <el-select id="delete-folder-target" v-model="target" placeholder="选择目标文件夹" filterable :disabled="busy" class="targetSelect">
            <el-option label="根目录" :value="''" />
            <el-option v-for="item in targetOptions" :key="item.id" :label="item.label" :value="item.id" />
          </el-select>
          <p class="description">脑图和子文件夹会一起移入目标位置，保留子文件夹层级。直接移入的脑图沿用目标文件夹权限，子文件夹权限保持不变。</p>
        </template>
        <p v-else class="description danger">所有脑图将移入回收站，原文件夹及其子文件夹会被删除。恢复脑图时不会恢复原文件夹结构。</p>
        <p v-if="!preview.canTrash || !preview.canMove" class="description">部分内容权限不足，无法使用的操作已禁用。</p>
      </template>
      <p v-else class="description">这是一个空文件夹，确认删除吗？</p>
    </template>
    <p v-if="error" class="danger" role="alert">{{ error }}</p>
    <span slot="footer">
      <el-button :disabled="busy" @click="shown = false">取消</el-button>
      <el-button v-if="!preview && !loading" :disabled="busy" @click="loadPreview">重试</el-button>
      <el-button :type="action === 'trash' || !hasContents ? 'danger' : 'primary'" :loading="busy" :disabled="!canConfirm" @click="confirm">{{ confirmLabel }}</el-button>
    </span>
  </el-dialog>
</template>
<script>
import folderService from '@/services/folderService'
import teamService from '@/services/teamService'
import { userMessageFromError } from '@/services/apiError'

export default {
  name: 'DeleteFolderDialog',
  props: {
    visible: Boolean,
    folder: Object,
    folders: { type: Array, default: () => [] },
    teamId: { type: String, default: '' }
  },
  data: () => ({ preview: null, loading: false, busy: false, error: '', action: 'move', target: '', requestId: 0 }),
  computed: {
    shown: {
      get() { return this.visible },
      set(value) { if (!this.busy) this.$emit('update:visible', value) }
    },
    hasContents() { return !!(this.preview && (this.preview.roomCount || this.preview.folderCount)) },
    canConfirm() {
      return !!this.preview && !this.loading && !this.busy && (!this.hasContents ||
        (this.action === 'move' ? this.preview.canMove : this.preview.canTrash))
    },
    confirmLabel() {
      return !this.hasContents ? '删除文件夹' : this.action === 'move' ? '移动内容并删除' : '全部删除'
    },
    targetOptions() {
      const excluded = new Set(this.preview ? this.preview.excludedFolderIds : [])
      const byId = Object.fromEntries(this.folders.map(f => [f.id, f]))
      return this.folders.filter(f => !excluded.has(f.id)).map(f => {
        const names = [f.name]
        const visited = new Set([f.id])
        let parent = byId[f.parentId]
        while (parent && !visited.has(parent.id)) {
          visited.add(parent.id)
          names.unshift(parent.name)
          parent = byId[parent.parentId]
        }
        return { id: f.id, label: names.join(' / ') }
      })
    }
  },
  watch: {
    visible(value) {
      if (value) {
        this.target = ''
        this.loadPreview()
      } else this.requestId++
    }
  },
  methods: {
    async loadPreview() {
      const request = ++this.requestId
      this.preview = null
      this.error = ''
      this.loading = true
      try {
        const preview = this.teamId
          ? await teamService.previewFolderDeletion(this.teamId, this.folder.id)
          : await folderService.previewDeletion(this.folder.id)
        if (request !== this.requestId) return
        this.preview = preview
        this.action = preview.canMove ? 'move' : 'trash'
      } catch (error) {
        if (request === this.requestId) this.error = userMessageFromError(error)
      } finally {
        if (request === this.requestId) this.loading = false
      }
    },
    async confirm() {
      if (!this.canConfirm) return
      this.busy = true
      this.error = ''
      try {
        const input = { action: this.hasContents ? this.action : 'empty', targetFolderId: this.target || null, revision: this.preview.revision }
        const result = this.teamId
          ? await teamService.deleteFolderContents(this.teamId, this.folder.id, input)
          : await folderService.deleteContents(this.folder.id, input)
        this.$message.success(result.action === 'move' ? '内容已移动，原文件夹已删除' : result.roomCount ? '脑图已移入回收站，文件夹已删除' : '文件夹已删除')
        this.busy = false
        this.shown = false
        this.$emit('deleted', result)
      } catch (error) {
        if (error.code === 'FOLDER_CONTENTS_CHANGED') await this.loadPreview()
        this.error = userMessageFromError(error)
      } finally { this.busy = false }
    }
  }
}
</script>
<style lang="less" scoped>
.folderName { margin: 0 0 12px; color: var(--ui-text, #17261f); font-weight: 600; overflow-wrap: anywhere; }
.description { color: #52635a; line-height: 1.6; margin: 12px 0; }
.actions { display: flex; flex-direction: column; gap: 18px; margin: 20px 0; }
.actions /deep/ .el-radio { margin: 0; white-space: normal; line-height: 1.6; }
.targetLabel { display: block; margin-bottom: 8px; color: #17261f; }
.targetSelect { width: 100%; }
.danger { color: #b8433a; line-height: 1.6; }
.deleteFolderDialog /deep/ .el-dialog { max-width: calc(100vw - 32px); }
.deleteFolderDialog /deep/ .el-dialog__body { max-height: 65vh; overflow-y: auto; }
</style>
