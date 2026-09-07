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
          v-model="email"
          maxlength="128"
          placeholder="输入成员邮箱或 userid"
        /><el-button
          type="primary"
          :disabled="!email.trim() || busy"
          @click="add"
          >添加成员</el-button
        >
      </div>
      <h4>已共享成员 <small>基于房间成员 ACL</small></h4>
      <TeamMemberList :members="members" @role="updateRole" @remove="remove" />
    </div>
    <span slot="footer"
      ><el-button @click="shown = false">完成</el-button></span
    >
  </el-dialog>
</template>
<script>
import shareService from '@/services/shareService'
import TeamMemberList from './TeamMemberList.vue'
export default {
  name: 'ShareRoomDialog',
  components: { TeamMemberList },
  props: { visible: Boolean, room: Object },
  data: () => ({
    email: '',
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
        this.email = ''
        this.members = []
        this.load()
      }
    }
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
    add() {
      return this.perform(async () => {
        await shareService.addMember(this.roomKey, this.email.trim())
        this.email = ''
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
h4 {
  margin: 0 0 8px;
}
small {
  color: #80948a;
  font-weight: 400;
}
</style>
