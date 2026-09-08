<template>
  <el-dialog :visible.sync="shown" :title="`文件夹权限「${folder ? folder.name : ''}」`" width="560px">
    <div v-loading="loading || busy">
      <p class="inheritTip">添加后，成员将获得此文件夹内现有及后续脑图的对应权限。</p>
      <div class="folderInvite">
        <el-input v-model.trim="query" prefix-icon="el-icon-search" placeholder="搜索同事姓名或账号" @input="search" />
        <el-select v-model="role"><el-option label="可查看" value="Viewer" /><el-option label="可编辑" value="Editor" /></el-select>
      </div>
      <div v-if="hits.length" class="folderHits">
        <button v-for="user in hits" :key="user.user_id" type="button" @click="add(user)">
          <span>{{ user.name || user.user_id }}</span><em>添加</em>
        </button>
      </div>
      <p v-else-if="query && !searching" class="emptyHits">未找到匹配同事</p>
      <h4>已有权限成员</h4>
      <TeamMemberList variant="room" :members="members" @role="updateRole" @remove="remove" />
      <p v-if="!members.length && !loading" class="emptyMembers">暂未添加成员</p>
    </div>
    <span slot="footer"><el-button @click="shown = false">完成</el-button></span>
  </el-dialog>
</template>

<script>
import folderService from '@/services/folderService'
import { productRequest } from '@/services/productHttp'
import TeamMemberList from './TeamMemberList.vue'
export default {
  name: 'ShareFolderDialog', components: { TeamMemberList },
  props: { visible: Boolean, folder: Object },
  data: () => ({ members: [], query: '', role: 'Viewer', hits: [], loading: false, busy: false, searching: false, timer: null }),
  computed: {
    shown: { get() { return this.visible }, set(value) { this.$emit('update:visible', value) } },
    folderId() { return (this.folder && this.folder.id) || '' }
  },
  watch: { visible(value) { if (value) { this.query = ''; this.hits = []; this.searching = false; this.load() } } },
  beforeDestroy() { clearTimeout(this.timer) },
  methods: {
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
h4 { margin: 20px 0 8px; }.emptyMembers { color: #7b8982; font-size: 13px; padding: 14px 0; }
</style>
