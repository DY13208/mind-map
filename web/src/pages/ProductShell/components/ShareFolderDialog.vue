<template>
  <el-dialog :visible.sync="shown" custom-class="folderPermissionDialog" width="960px" :close-on-click-modal="false" :show-close="false">
    <div v-loading="loading || busy">
      <header class="permissionHeader">
        <div class="folderIcon"><i class="el-icon-folder" /></div>
        <div><h2>文件夹权限「{{ folder ? folder.name : '' }}」</h2><p>添加后，成员将获得此文件夹内现有及后续脑图的对应权限。</p></div>
        <button class="closeBtn" type="button" aria-label="关闭" @click="shown = false">×</button>
      </header>
      <section class="permissionSection"><div class="sectionTitle"><i class="el-icon-user" /><div><strong>添加成员</strong><span>搜索同事并设置权限</span></div></div><div class="folderInvite">
        <el-input v-model.trim="query" prefix-icon="el-icon-search" placeholder="搜索同事姓名或账号" @input="search" />
        <el-select v-model="role"><el-option label="可查看" value="Viewer" /><el-option label="可编辑" value="Editor" /><el-option label="可管理" value="Manager" /></el-select>
        <el-button type="primary" :disabled="!hits.length" @click="add(hits[0])">＋ 添加成员</el-button></div></section>
      <section class="permissionSection"><div class="sectionTitle"><i class="el-icon-office-building" /><div><strong>选择部门</strong><span>按部门批量添加权限</span></div></div><div class="folderBulkInvite">
        <el-autocomplete v-model="departmentName" :fetch-suggestions="filterDepartments" value-key="name" placeholder="搜索或选择部门" @select="selectDepartment" />
        <el-button :loading="bulkLoading" @click="bulkAdd(departmentId)">添加部门</el-button>
        <el-button :loading="bulkLoading" @click="bulkAdd('')">添加全公司</el-button>
      </div><div class="includeChildren"><el-checkbox v-model="includeChildren">包含下属部门</el-checkbox></div></section>
      <div v-if="hits.length" class="folderHits">
        <button v-for="user in hits" :key="user.user_id" type="button" @click="add(user)">
          <span>{{ user.name || user.user_id }}</span><em>添加</em>
        </button>
      </div>
      <p v-else-if="query && !searching" class="emptyHits">未找到匹配同事</p>
      <div class="summaryBar">已有权限成员 <strong>{{ members.length }}</strong></div>
      <div class="memberPane">
        <div v-for="member in pagedMembers" :key="member.id" class="permissionMemberRow"><div class="memberIdentity"><strong>{{ member.name || member.id }}</strong><small>{{ member.department || '成员' }}</small></div><span class="joinedAt">{{ member.joinedAt || '—' }}</span><el-select size="small" :value="member.role" :disabled="String(member.role).toLowerCase() === 'owner'" @change="updateRole(member, $event)"><el-option label="可查看" value="Viewer" /><el-option label="可编辑" value="Editor" /><el-option label="可管理" value="Manager" /></el-select><el-button v-if="String(member.role).toLowerCase() !== 'owner'" type="text" class="remove" @click="remove(member)">移除</el-button></div>
        <p v-if="!members.length && !loading" class="emptyMembers">暂未添加成员</p>
      </div>
      <el-pagination
        v-if="members.length > pageSize"
        class="memberPager"
        small
        layout="prev, pager, next, total"
        :current-page.sync="page"
        :page-size="pageSize"
        :total="members.length"
      />
    </div>
    <span slot="footer"><el-button @click="shown = false">完成</el-button></span>
  </el-dialog>
</template>

<script>
import folderService from '@/services/folderService'
import { productRequest } from '@/services/productHttp'
import teamService from '@/services/teamService'
import TeamMemberList from './TeamMemberList.vue'
export default {
  name: 'ShareFolderDialog', components: { TeamMemberList },
  props: { visible: Boolean, folder: Object },
  data: () => ({
    members: [],
    query: '',
    role: 'Viewer',
    hits: [],
    loading: false,
    busy: false,
    searching: false,
    timer: null,
    page: 1,
    pageSize: 5
    ,departmentId: '', departmentName: '', departmentOptions: [], selectedDepartment: null, includeChildren: true, bulkLoading: false
  }),
  computed: {
    shown: { get() { return this.visible }, set(value) { this.$emit('update:visible', value) } },
    folderId() { return (this.folder && this.folder.id) || '' },
    pagedMembers() {
      const start = (this.page - 1) * this.pageSize
      return this.members.slice(start, start + this.pageSize)
    }
  },
  watch: {
    visible(value) {
      if (value) {
        this.query = ''
        this.hits = []
        this.searching = false
        this.page = 1
        this.departmentName = ''; this.selectedDepartment = null; this.loadDepartments()
        this.load()
      }
    },
    members() {
      const maxPage = Math.max(1, Math.ceil(this.members.length / this.pageSize) || 1)
      if (this.page > maxPage) this.page = maxPage
    }
  },
  beforeDestroy() { clearTimeout(this.timer) },
  methods: {
    async loadDepartments() { try { this.departmentOptions = await teamService.listDepartments(); if (!this.departmentOptions.length) this.$message.info('当前通讯录没有可用部门') } catch (e) { this.departmentOptions = []; this.$message.error(e.message || '加载部门失败') } },
    filterDepartments(value, cb) { const q = String(value || '').toLowerCase(); cb(this.departmentOptions.filter(d => d.name.toLowerCase().includes(q))) },
    selectDepartment(item) { this.selectedDepartment = item; this.departmentId = item.id; this.departmentName = item.name },
    async load() {
      this.loading = true
      try { this.members = (await folderService.getMembers(this.folderId)).list }
      catch (error) { this.$message.error(error.message || '加载权限失败') }
      finally { this.loading = false }
    },
    search() {
      clearTimeout(this.timer)
      if (!this.query) { this.hits = []; this.searching = false; return }
      const q = this.query
      this.searching = true
      this.timer = setTimeout(async () => {
        try {
          const data = await productRequest(`/api/users?${new URLSearchParams({ q, limit: '8' })}`)
          if (this.query === q) this.hits = data.list || []
        } catch (error) {
          if (this.query === q) {
            this.hits = []
            this.$message.error(error.message || '搜索同事失败')
          }
        } finally {
          if (this.query === q) this.searching = false
        }
      }, 250)
    },
    async run(action) {
      this.busy = true
      try { await action(); await this.load(); this.$emit('changed'); this.$message.success('文件夹权限已更新') }
      catch (error) { this.$message.error(error.message || '更新权限失败') }
      finally { this.busy = false }
    },
    add(user) { return this.run(async () => { await folderService.setMember(this.folderId, user.user_id, this.role); this.query = ''; this.hits = [] }) },
    async bulkAdd(departmentId) {
      this.bulkLoading = true
      try { await folderService.bulkSetMembers(this.folderId, { departmentId: departmentId || undefined, includeChildren: this.includeChildren, role: this.role.toLowerCase() }); await this.load(); this.$message.success('批量权限已更新') }
      catch (error) { this.$message.error(error.message || '批量添加失败') }
      finally { this.bulkLoading = false }
    },
    updateRole(member, role) { return this.run(() => folderService.updateMember(this.folderId, member.id, role)) },
    remove(member) { return this.run(() => folderService.removeMember(this.folderId, member.id)) }
  }
}
</script>

<style lang="less" scoped>
.inheritTip { margin: 0 0 14px; padding: 10px 12px; border-radius: 8px; background: #f1f5f3; color: #52665f; font-size: 13px; }
.folderInvite { display: flex; gap: 10px; .el-select { width: 112px; } }
.folderHits { margin-top: 8px; border: 1px solid #e3e9e6; border-radius: 8px; overflow: hidden;
  button { width: 100%; padding: 10px 12px; border: 0; border-bottom: 1px solid #edf1ef; background: white; display: flex; justify-content: space-between; cursor: pointer; }
  button:hover { background: #f1f5f3; } button:last-child { border-bottom: 0; } em { color: #087854; font-style: normal; }
}
.emptyHits { margin: 8px 0 0; color: #7b8982; font-size: 13px; }
h4 {
  margin: 20px 0 8px;
  small { margin-left: 8px; color: #7b8982; font-weight: normal; font-size: 12px; }
}
.memberPane {
  max-height: 320px;
  overflow-y: auto;
}
.memberPager {
  margin-top: 12px;
  text-align: right;
}
.emptyMembers { color: #7b8982; font-size: 13px; padding: 14px 0; }
.permissionSection { margin-top: 16px; padding: 16px; border: 1px solid #e7eaf0; border-radius: 12px; background: #fbfcfc; }
.sectionTitle { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; color: #10966f; }
.sectionTitle i { font-size: 18px; }.sectionTitle div { display:flex; flex-direction:column; }.sectionTitle strong { color:#172033; font-size:14px; }.sectionTitle span { color:#667085; font-size:12px; margin-top:3px; }
.folderInvite, .folderBulkInvite { display:flex; gap:10px; align-items:center; }.folderInvite > .el-input, .folderBulkInvite > .el-input { flex:1; }.folderInvite .el-select { width:112px; }.includeChildren { margin-top:10px; }
.summaryBar { padding: 20px 2px 12px; color:#667085; font-size:13px; border-bottom:1px solid #e7eaf0; }.summaryBar strong { margin-left:6px; color:#172033; font-size:18px; }
.memberPane { max-height:~'min(380px, 40vh)'; overflow-y:auto; }.memberPane::-webkit-scrollbar { width:6px; }.memberPane::-webkit-scrollbar-thumb { background:#d8dfdc; border-radius:6px; }
.permissionMemberRow { display:grid; grid-template-columns:minmax(240px,1fr) 180px 120px 60px; gap:14px; align-items:center; padding:12px 8px; border-bottom:1px solid #eef1ef; }.permissionMemberRow:hover { background:#f8faf9; }.memberIdentity { display:flex; flex-direction:column; }.memberIdentity strong { font-weight:600; }.memberIdentity small,.joinedAt { color:#98a2b3; font-size:12px; margin-top:3px; }
.permissionHeader { display:flex; align-items:flex-start; gap:12px; padding-bottom:20px; border-bottom:1px solid #e7eaf0; }.folderIcon { width:40px;height:40px;border-radius:10px;background:#f1faf6;color:#10966f;display:grid;place-items:center;font-size:20px; }.permissionHeader h2 { margin:0;font-size:20px;color:#172033; }.permissionHeader p { margin:6px 0 0;color:#667085;font-size:13px; }.closeBtn { margin-left:auto;border:0;background:transparent;color:#98a2b3;font-size:26px;cursor:pointer; }
</style>
