<template>
  <el-dialog title="批量设置权限" :visible="visible" width="680px" append-to-body custom-class="kb-batch-permission-dialog" :close-on-click-modal="false" :before-close="close" @open="open">
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
        <el-form-item label="选择成员（最多 20 人）">
          <el-select v-model="memberIds" multiple filterable remote reserve-keyword :remote-method="searchMembers" :loading="searching" :multiple-limit="20" placeholder="输入姓名或账号搜索" style="width: 100%">
            <el-option v-for="member in contacts" :key="member.id" :value="member.id" :label="member.name + '（' + member.id + '）'" />
          </el-select>
          <small v-if="searchError" class="kb-permission-error" role="alert">{{ searchError }}</small>
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
    <span slot="footer"><el-button :disabled="busy" @click="close">关闭</el-button><el-button type="primary" :loading="busy" :disabled="loading || !memberIds.length || !prepared.some(t => t.ready)" @click="submit">应用权限</el-button></span>
  </el-dialog>
</template>
<script>
import kbApi from '../services/kbApi'
import teamService from '@/services/teamService'
import { prepareBatchTargets, applyBatchPermissions } from '../services/kbBatchPermissions'

export default {
  name: 'KbBatchPermissionDialog',
  props: { visible: Boolean, targets: { type: Array, default: () => [] } },
  data() { return { prepared: [], results: [], memberIds: [], contacts: [], mode: 'grant', role: 'viewer', loading: false, busy: false, searching: false, searchError: '', searchSeq: 0, openSeq: 0 } },
  methods: {
    async open() {
      const seq = ++this.openSeq
      this.results = []; this.memberIds = []; this.contacts = []; this.prepared = []; this.mode = 'grant'; this.role = 'viewer'; this.searchError = ''; this.searching = false; this.searchSeq++
      this.loading = true
      try {
        const prepared = await prepareBatchTargets(kbApi, this.targets)
        if (seq === this.openSeq && this.visible) this.prepared = prepared
      } catch (e) { this.$message.error(e.message) }
      finally { if (seq === this.openSeq) this.loading = false }
    },
    close() {
      if (this.busy) return
      this.openSeq++; this.searchSeq++
      this.$emit('update:visible', false)
    },
    async searchMembers(query) {
      const seq = ++this.searchSeq
      this.searchError = ''
      if (!String(query || '').trim()) { this.searching = false; return }
      this.searching = true
      try {
        const result = await teamService.listContacts({ search: query.trim(), limit: 30 })
        if (seq !== this.searchSeq || !this.visible) return
        const selected = this.contacts.filter(c => this.memberIds.includes(c.id))
        const found = (result.list || []).map(c => ({ id: String(c.userId || c.id), name: c.name || c.userId || c.id }))
        this.contacts = Array.from(new Map(selected.concat(found).map(c => [c.id, c])).values())
      } catch (e) { if (seq === this.searchSeq) this.searchError = e.message || '搜索成员失败，请重试' }
      finally { if (seq === this.searchSeq) this.searching = false }
    },
    async submit() {
      if (this.busy || this.loading || !this.memberIds.length) return
      this.busy = true
      try {
        // Re-read capabilities and direct grants at apply time; backend checks
        // authorization again on each mutation, including concurrent changes.
        this.prepared = await prepareBatchTargets(kbApi, this.targets)
        const members = this.memberIds.map(id => this.contacts.find(c => c.id === id) || { id })
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
