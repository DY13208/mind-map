<template
  ><div class="memberList">
    <div v-for="member in members" :key="member.id" class="memberRow">
      <el-avatar :size="36">{{ member.avatar }}</el-avatar>
      <div class="identity">
        <strong>{{ member.name }}</strong
        ><span>{{ member.email }}</span
        ><span>加入于 {{ member.joinedAt || '—' }}</span>
      </div>
      <el-select
        size="mini"
        :value="member.role"
        :disabled="member.role === 'Owner'"
        @change="$emit('role', member, $event)"
        ><el-option
          v-for="role in member.role === 'Owner' ? ['Owner'] : roles"
          :key="role"
          :value="role"
          :label="role"/></el-select
      ><el-button
        v-if="member.role !== 'Owner'"
        type="text"
        class="remove"
        @click="$emit('remove', member)"
        >移除</el-button
      >
    </div>
  </div></template
>
<script>
export default {
  name: 'TeamMemberList',
  props: { members: Array },
  data: () => ({ roles: ['Editor', 'Viewer'] })
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
  /deep/ .el-avatar {
    background: #158f68;
  }
}
</style>
