<template
  ><div class="memberList">
    <div v-for="member in members" :key="member.id" class="memberRow">
      <UserAvatar :person="member" :size="36" />
      <div class="identity">
        <strong>{{ member.name }}</strong
        ><template v-if="variant === 'team'">
          <span>{{ member.department || '未填写部门' }}</span>
          <span>{{ member.position || '未填写职位' }}</span>
        </template>
        <span v-else>加入于 {{ member.joinedAt || '—' }}</span>
      </div>
      <el-select
        size="mini"
        :value="variant === 'team' ? member.teamRole || member.role : member.role"
        :disabled="variant === 'team' ? member.teamRole === 'owner' : member.role === 'Owner'"
        @change="$emit('role', member, $event)"
        ><el-option
          v-for="role in availableRoles(member)"
          :key="role"
          :value="role"
          :label="roleLabel(role)"/></el-select
      ><el-button
        v-if="variant === 'team' ? member.teamRole !== 'owner' : member.role !== 'Owner'"
        type="text"
        class="remove"
        @click="$emit('remove', member)"
        >移除</el-button
      >
    </div>
  </div></template
>
<script>
import UserAvatar from '@/components/UserAvatar.vue'

export default {
  name: 'TeamMemberList',
  components: { UserAvatar },
  props: {
    members: { type: Array, default: () => [] },
    variant: { type: String, default: 'team' }
  },
  data: () => ({ teamRoles: ['owner', 'admin', 'member'], roomRoles: ['Editor', 'Viewer'] }),
  methods: {
    availableRoles(member) {
      if (this.variant === 'team') {
        return member.teamRole === 'owner' ? ['owner'] : this.teamRoles.slice(1)
      }
      return member.role === 'Owner' ? ['Owner'] : this.roomRoles
    },
    roleLabel(role) {
      return this.variant === 'team' ? role : role
    }
  }
}
</script>
<style lang="less" scoped>
.memberRow {
  flex-wrap: wrap;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 2px;
  border-bottom: 1px solid #eef1ef;
  .identity {
    min-width: 130px;
    overflow-wrap: anywhere;
    flex: 1;
    display: flex;
    flex-direction: column;
    font-size: 13px;
    span {
      color: #909b97;
      margin-top: 3px;
    }
  }
  .remove {
    color: #d65d52;
  }
  .el-select {
    width: 105px;
  }
}
</style>
