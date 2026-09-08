<template>
  <el-dialog
    :visible.sync="shown"
    :title="'分享「' + (room ? room.title : '') + '」'"
    width="560px"
  >
    <div v-loading="loading || busy">
      <div v-if="error">
        <el-alert :title="error" type="error" :closable="false" /><el-button
          @click="load"
          >重试</el-button
        >
      </div>
      <div class="invite">
        <el-input
          v-model.trim="query"
          maxlength="128"
          placeholder="搜索同事姓名或账号"
          prefix-icon="el-icon-search"
          @input="searchUsers"
        />
        <el-select v-model="newRole" aria-label="新成员权限">
          <el-option label="可查看" value="Viewer" />
          <el-option label="可编辑" value="Editor" />
        </el-select>
      </div>
      <div v-if="hits.length" class="userHits">
        <button v-for="user in hits" :key="user.user_id" type="button" @click="add(user)">
          <span><strong>{{ user.name || user.user_id }}</strong><small>{{ user.wecomUserId || user.user_id }}</small></span>
          <em>添加为{{ newRole === 'Editor' ? '可编辑' : '可查看' }}</em>
        </button>
      </div>
      <h4>已共享成员 <small>基于房间成员 ACL</small></h4>
      <TeamMemberList
        variant="room"
        :members="members"
        @role="updateRole"
        @remove="remove"
      />
    </div>
    <span slot="footer"
      ><el-button @click="shown = false">完成</el-button></span
    >
  </el-dialog>
</template>
<script>
import shareService from '@/services/shareService'
import { productRequest } from '@/services/productHttp'
import TeamMemberList from './TeamMemberList.vue'
export default {
  name: 'ShareRoomDialog',
  components: { TeamMemberList },
  props: { visible: Boolean, room: Object },
  data: () => ({
    query: '',
    newRole: 'Viewer',
    hits: [],
    searchTimer: null,
    members: [],
    loading: false,
    busy: false,
    error: ''
  }),
  computed: {
    shown: {
      get() {
        return this.visible
      },
      set(value) {
        this.$emit('update:visible', value)
      }
    },
    roomKey() {
      return (this.room && (this.room.roomKey || this.room.id)) || ''
    }
  },
  watch: {
    visible(value) {
      if (value) {
        this.query = ''
        this.hits = []
        this.members = []
        this.load()
      }
    }
  },
  beforeDestroy() {
    clearTimeout(this.searchTimer)
  },
  methods: {
    async load() {
      this.loading = true
      this.error = ''
      try {
        this.members = await shareService.getMembers(this.roomKey)
      } catch (error) {
        this.error = error.message
      } finally {
        this.loading = false
      }
    },
    async perform(action) {
      if (this.busy) return
      this.busy = true
      try {
        await action()
        await this.load()
        this.$emit('changed')
        this.$message.success('共享设置已更新')
      } catch (error) {
        this.$message.error(error.message)
      } finally {
        this.busy = false
      }
    },
    searchUsers() {
      clearTimeout(this.searchTimer)
      if (!this.query) { this.hits = []; return }
      const query = this.query
      this.searchTimer = setTimeout(async () => {
        try {
          const params = new URLSearchParams({ q: query, limit: '8' })
          const data = await productRequest(`/api/users?${params.toString()}`)
          if (this.query === query) this.hits = data.list || []
        } catch (error) {
          this.hits = []
        }
      }, 250)
    },
    add(user) {
      return this.perform(async () => {
        await shareService.addMember(this.roomKey, user.user_id, this.newRole)
        this.query = ''
        this.hits = []
      })
    },
    updateRole(member, role) {
      return this.perform(() =>
        shareService.updateMemberRole(this.roomKey, member.id, role)
      )
    },
    async remove(member) {
      const confirmed = await this.$confirm(
        '移除共享成员「' + member.name + '」？',
        '移除成员'
      )
        .then(() => true)
        .catch(() => false)
      if (confirmed)
        await this.perform(() =>
          shareService.removeMember(this.roomKey, member.id)
        )
    }
  }
}
</script>
<style lang="less" scoped>
.invite {
  display: flex;
  gap: 10px;
  margin: 12px 0 22px;
}
.invite .el-select { width: 112px; flex: 0 0 auto; }
.userHits {
  margin: -14px 0 20px;
  border: 1px solid #e3e9e6;
  border-radius: 8px;
  overflow: hidden;
  button {
    width: 100%; padding: 10px 12px; display: flex; align-items: center;
    justify-content: space-between; border: 0; border-bottom: 1px solid #edf1ef;
    background: #fff; color: #17261f; cursor: pointer; text-align: left;
    &:last-child { border-bottom: 0; }
    &:hover { background: #f1f5f3; }
  }
  span { display: flex; flex-direction: column; gap: 2px; }
  small { color: #7b8982; }
  em { color: #087854; font-size: 12px; font-style: normal; }
}
h4 {
  margin: 0 0 8px;
}
small {
  color: #80948a;
  font-weight: 400;
}
</style>
