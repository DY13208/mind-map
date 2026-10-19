<template>
  <el-dialog :visible="visible" :title="'权限设置' + (target && target.name ? ' · ' + target.name : '')" width="720px" append-to-body custom-class="kb-perm-dialog" class="kb-perm" @close="$emit('update:visible', false)">
    <div v-if="loading" v-loading="true" class="kb-perm-loading" element-loading-background="transparent" />
    <div v-else-if="error" class="kb-perm-error">
      <i class="el-icon-warning-outline" aria-hidden="true" />
      {{ error.kind === 'not_ready' ? '后端未就绪：权限接口尚未实现' : error.message }}
      <el-button type="text" @click="load">重试</el-button>
    </div>
    <template v-else-if="acl">
      <div class="kb-perm-summary">
        <span>我的有效权限：<strong>{{ roleLabel(acl.effectiveRole || acl.actorRole) }}</strong></span>
        <span v-if="acl.ownerName || acl.ownerUserId">所有者：{{ acl.ownerName || acl.ownerUserId }}</span>
        <span v-if="acl.inherit != null">{{ acl.inherit ? '继承上级文件夹权限' : '不继承上级权限' }}</span>
      </div>

      <div class="kb-perm-add">
        <el-select v-model="form.subjectType" size="small" class="kb-perm-type" popper-class="kb-popper">
          <el-option label="用户" value="user" />
          <el-option label="团队" value="team" />
        </el-select>
        <el-input v-model.trim="form.subjectId" size="small" :placeholder="form.subjectType === 'team' ? '团队 ID' : '用户 ID'" class="kb-perm-subject" />
        <el-select v-model="form.role" size="small" class="kb-perm-role" popper-class="kb-popper">
          <el-option v-for="r in grantRoles" :key="r.value" :label="r.label" :value="r.value" />
        </el-select>
        <el-button size="small" type="primary" icon="el-icon-plus" :disabled="!can('grant') || !form.subjectId" :loading="saving" @click="grant(form)">添加授权</el-button>
      </div>
      <div v-if="can('transfer')" class="kb-perm-transfer">
        <div class="kb-perm-tip">转移所有权只作用于当前{{ target && target.type === 'folder' ? '文件夹' : '文件' }}，不会自动转移子文件夹或子文件。转移后你将变为管理者。</div>
        <div class="kb-perm-add">
          <el-input v-model.trim="transferUserId" size="small" placeholder="新所有者的用户 ID" class="kb-perm-subject" />
          <el-button size="small" :disabled="!transferUserId" :loading="transferring" @click="transfer">转移所有权</el-button>
        </div>
      </div>
      <div v-if="!can('grant')" class="kb-perm-tip">后端未授予你修改此资源权限的能力，以下内容仅供查看。</div>

      <el-table :data="grants" size="small" class="kb-table" empty-text="暂无授权">
        <el-table-column label="对象" min-width="170">
          <template slot-scope="{ row }">
            <i :class="row.subjectType === 'team' ? 'el-icon-office-building' : 'el-icon-user'" class="kb-perm-icon" aria-hidden="true" />
            {{ row.subjectName || row.subjectId }}
            <span class="kb-perm-muted">{{ row.subjectType === 'team' ? '团队' : '用户' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="角色" width="140">
          <template slot-scope="{ row }">
            <el-select
              v-if="row.source === 'direct' && row.role !== 'owner'"
              :value="row.role"
              size="mini"
              :disabled="!can('grant')"
              popper-class="kb-popper"
              @change="r => grant({ subjectType: row.subjectType, subjectId: row.subjectId, role: r })"
            >
              <el-option v-for="r in grantRoles" :key="r.value" :label="r.label" :value="r.value" />
            </el-select>
            <span v-else>{{ roleLabel(row.role) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="来源" min-width="170">
          <template slot-scope="{ row }">
            <span>{{ sourceLabel(row) }}</span>
            <el-tag v-if="row.applied === false" size="mini" type="info" effect="plain" class="kb-perm-overridden">已被直接授权覆盖</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="" width="70" align="right">
          <template slot-scope="{ row }">
            <el-button
              v-if="row.source === 'direct' && row.role !== 'owner'"
              type="text"
              size="mini"
              icon="el-icon-delete"
              :disabled="!can('revoke')"
              @click="revoke(row)"
            >移除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </template>
    <span slot="footer"><el-button size="small" @click="$emit('update:visible', false)">关闭</el-button></span>
  </el-dialog>
</template>
<script>
import kbApi from '../services/kbApi'
import { GRANT_ROLES, roleLabel } from '../constants/status'
// 按钮可用性只由后端返回的 capabilities 决定，前端不根据角色推断
export default {
  name: 'KbPermissionDialog',
  props: { visible: Boolean, target: { type: Object, default: null } },
  data() {
    return {
      acl: null, loading: false, saving: false, transferring: false, error: null,
      grantRoles: GRANT_ROLES, transferUserId: '',
      form: { subjectType: 'user', subjectId: '', role: 'viewer' }
    }
  },
  computed: {
    grants() {
      const a = this.acl || {}
      return a.grants || a.entries || []
    },
    capabilities() {
      return Array.isArray(this.acl && this.acl.capabilities) ? this.acl.capabilities : []
    }
  },
  watch: {
    visible(v) { if (v) this.load() }
  },
  methods: {
    roleLabel,
    can(cap) { return this.capabilities.includes(cap) },
    sourceLabel(row) {
      if (row.source === 'owner') return '所有者'
      if (row.source === 'inherited') {
        const f = row.inheritedFrom || {}
        return '继承自 ' + (f.name || (f.id ? '文件夹 ' + f.id : '无权查看的上级文件夹'))
      }
      return '直接授权'
    },
    async load() {
      if (!this.target) return
      this.loading = true
      this.error = null
      try {
        this.acl = await kbApi.getAcl(this.target.type, this.target.id)
      } catch (e) {
        this.error = e
        this.acl = null
      } finally {
        this.loading = false
      }
    },
    async grant(g) {
      if (!this.can('grant') || g.role === 'owner') return
      this.saving = true
      try {
        this.acl = (await kbApi.putGrant(this.target.type, this.target.id, { subjectType: g.subjectType, subjectId: g.subjectId, role: g.role })) || this.acl
        this.form.subjectId = ''
        this.$message.success('已保存授权')
        await this.load()
      } catch (e) {
        this.$message.error(e.message)
      } finally {
        this.saving = false
      }
    },
    async revoke(row) {
      try {
        await this.$confirm(`确定移除「${row.subjectName || row.subjectId}」的授权？`, '移除授权', { type: 'warning', confirmButtonText: '移除', cancelButtonText: '取消' })
        await kbApi.deleteGrant(this.target.type, this.target.id, { subjectType: row.subjectType, subjectId: row.subjectId })
        this.$message.success('已移除')
        this.load()
      } catch (e) {
        if (e && e.__kb) this.$message.error(e.message)
      }
    },
    async transfer() {
      const userId = this.transferUserId
      if (!userId || !this.can('transfer') || !this.target) return
      const kind = this.target.type === 'folder' ? '文件夹' : '文件'
      const name = this.target.name || this.target.id
      try {
        await this.$confirm(
          `确定把「${name}」的所有权转移给 ${userId}？只转移当前${kind}，不会自动转移子文件夹或子文件。转移后你将变为该资源的管理者。`,
          '转移所有权',
          { type: 'warning', confirmButtonText: '确认转移', cancelButtonText: '取消' }
        )
      } catch (_) {
        return
      }
      this.transferring = true
      try {
        this.acl = await kbApi.transferOwner(this.target.type, this.target.id, { userId })
        this.transferUserId = ''
        this.$message.success('已转移所有权')
      } catch (e) {
        this.$message.error(e.message)
      } finally {
        this.transferring = false
      }
    }
  }
}
</script>
<style scoped lang="less">
.kb-perm {
  ::v-deep .el-dialog { background: var(--ui-surface); border-radius: var(--ui-radius-lg); }
  ::v-deep .el-dialog__title { color: var(--ui-text); font-weight: 600; }
  ::v-deep .el-dialog__headerbtn:hover .el-dialog__close { color: var(--ui-primary); }
  ::v-deep .el-button--text { color: var(--ui-primary); font-weight: 600; &:hover, &:focus { color: var(--ui-primary-hover); } &.is-disabled { color: var(--ui-text-muted); } }
  ::v-deep .el-button--primary { background: var(--ui-primary); border-color: var(--ui-primary); color: var(--ui-on-primary); &:hover, &:focus { background: var(--ui-primary-hover); border-color: var(--ui-primary-hover); } }
  ::v-deep .el-input__inner:focus, ::v-deep .el-select .el-input.is-focus .el-input__inner { border-color: var(--ui-primary); }
  ::v-deep .el-loading-spinner .path { stroke: var(--ui-primary); }
  ::v-deep .kb-table th { background: var(--ui-surface-muted); color: var(--ui-text-secondary); }
  ::v-deep .kb-table, ::v-deep .kb-table tr { background: var(--ui-surface); color: var(--ui-text); }
}
.kb-perm-loading { min-height: 160px; }
.kb-perm-error { padding: 20px 0; color: var(--ui-danger); i { font-weight: 700; } }
.kb-perm-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  font-size: 13px;
  color: var(--ui-text-secondary);
  padding: 10px 12px;
  background: var(--ui-surface-muted);
  border-radius: var(--ui-radius-md);
  margin-bottom: 12px;
  strong { color: var(--ui-primary); }
}
.kb-perm-add { display: flex; gap: 8px; margin-bottom: 8px; }
.kb-perm-type { width: 90px; }
.kb-perm-role { width: 110px; }
.kb-perm-subject { flex: 1; }
.kb-perm-tip { font-size: 12px; color: var(--ui-text-muted); margin-bottom: 8px; }
.kb-perm-icon { font-weight: 700; color: var(--ui-primary); margin-right: 4px; }
.kb-perm-muted { margin-left: 6px; font-size: 12px; color: var(--ui-text-muted); }
.kb-perm-overridden { margin-left: 6px; }
</style>
