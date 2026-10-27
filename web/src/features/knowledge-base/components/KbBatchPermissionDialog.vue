<template>
  <el-dialog title="批量设置权限" :visible="visible" width="840px" append-to-body custom-class="kb-batch-permission-dialog" :close-on-click-modal="false" :before-close="close" @open="open">
    <div v-loading="loading">
      <p>已选择 {{ prepared.length }} 个资源，可管理 {{ prepared.filter(t => t.ready).length }} 个。</p>
      <div class="kb-permission-targets">
        <div v-for="target in prepared" :key="target.type + target.id"><i :class="target.type === 'folder' ? 'el-icon-folder' : 'el-icon-document'" /> {{ target.name || target.id }}<span v-if="!target.ready" class="kb-permission-error"> · {{ target.message }}</span></div>
      </div>
      <p class="kb-permission-hint">文件夹授权向下继承；单独设置优先于继承。只修改所选成员的直接授权，所有者权限保留。</p>
      <el-form label-position="top" :disabled="busy || loading">
        <el-form-item label="操作">
          <el-radio-group v-model="mode"><el-radio label="grant">添加或调整授权</el-radio><el-radio label="revoke">移除直接授权</el-radio></el-radio-group>
        </el-form-item>
        <el-form-item label="按组织架构选择部门或成员">
          <KbOrganizationPicker v-if="visible" v-model="members" :disabled="busy || loading" @loading="selectionLoading = $event" @error="selectionError = $event" />
        </el-form-item>
        <el-form-item v-if="mode === 'grant'" label="统一设置为">
          <el-select v-model="role"><el-option label="可查看 · 查看与下载" value="viewer" /><el-option label="可编辑" value="editor" /><el-option label="可管理 · 管理成员权限" value="manager" /></el-select>
        </el-form-item>
        <p v-else class="kb-permission-hint">移除直接授权后，成员仍可能通过文件夹继承或团队授权访问。</p>
      </el-form>
      <div v-if="results.length" role="status">
        <p>成功 {{ count('success') }} 项，跳过 {{ count('skipped') }} 项，失败 {{ count('failed') }} 项。</p>
        <el-table :data="results" size="small" max-height="260">
          <el-table-column label="资源" min-width="150"><template slot-scope="{ row }">{{ row.target.name || row.target.id }}</template></el-table-column>
          <el-table-column label="成员" width="110"><template slot-scope="{ row }">{{ row.member.name || row.member.id }}</template></el-table-column>
          <el-table-column label="结果" min-width="200"><template slot-scope="{ row }"><span :class="{ 'kb-permission-error': row.status === 'failed' }">{{ row.message }}</span></template></el-table-column>
        </el-table>
      </div>
    </div>
    <p v-if="members.length" class="kb-permission-hint">本次将处理 {{ prepared.length }} 个资源 × {{ members.length }} 位成员；每次最多 500 人、5000 项授权操作。</p>
    <span slot="footer"><el-button :disabled="busy" @click="close">关闭</el-button><el-button type="primary" :loading="busy" :disabled="loading || selectionLoading || !!selectionError || !members.length || members.length > 500 || prepared.length * members.length > 5000 || !prepared.some(t => t.ready)" @click="submit">应用权限</el-button></span>
  </el-dialog>
</template>
<script>
import kbApi from '../services/kbApi'
import KbOrganizationPicker from './KbOrganizationPicker.vue'
import { prepareBatchTargets, applyBatchPermissions } from '../services/kbBatchPermissions'

export default {
  name: 'KbBatchPermissionDialog',
  components: { KbOrganizationPicker },
  props: { visible: Boolean, targets: { type: Array, default: () => [] } },
  data() { return { prepared: [], results: [], members: [], mode: 'grant', role: 'viewer', loading: false, busy: false, selectionLoading: true, selectionError: '', openSeq: 0 } },
  methods: {
    async open() {
      const seq = ++this.openSeq
      this.results = []; this.members = []; this.prepared = []; this.mode = 'grant'; this.role = 'viewer'
      this.loading = true
      try {
        const prepared = await prepareBatchTargets(kbApi, this.targets)
        if (seq === this.openSeq && this.visible) this.prepared = prepared
      } catch (e) { this.$message.error(e.message) }
      finally { if (seq === this.openSeq) this.loading = false }
    },
    close() {
      if (this.busy) return
      this.openSeq++
      this.$emit('update:visible', false)
    },
    async submit() {
      if (this.busy || this.loading || this.selectionLoading || this.selectionError || !this.members.length) return
      this.busy = true
      const members = this.members.slice()
      try {
        // Re-read capabilities and direct grants at apply time; backend checks
        // authorization again on each mutation, including concurrent changes.
        this.prepared = await prepareBatchTargets(kbApi, this.targets)
        this.results = await applyBatchPermissions(kbApi, this.prepared, members, { mode: this.mode, role: this.role })
        this.$emit('changed')
      } catch (e) { this.$message.error(e.message || '批量设置失败') }
      finally { this.busy = false }
    },
    count(status) { return this.results.filter(r => r.status === status).length }
  }
}
</script>
<style lang="less">
.kb-batch-permission-dialog {
  max-width: calc(100vw - 24px);
  .kb-permission-targets { max-height: 120px; overflow: auto; line-height: 1.8; overflow-wrap: anywhere; }
  .kb-permission-hint { color: var(--ui-text-muted, #666); font-size: 12px; line-height: 1.6; }
  .kb-permission-error { color: var(--ui-danger, #c43b3b); }
}
</style>
