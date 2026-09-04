<template
  ><article class="teamCard" @click="$emit('open', team)">
    <div class="teamIcon"><i class="el-icon-office-building" /></div>
    <div>
      <h3>{{ team.name }}</h3>
      <p>{{ team.description }}</p>
      <span>{{ team.memberCount }} 位成员 · {{ team.roomCount }} 个脑图</span>
      <p>
        Owner {{ team.owner }} ·
        {{ new Date(team.updatedAt).toLocaleDateString('zh-CN') }}
      </p>
    </div>
    <i class="el-icon-arrow-right arrow" /></article
></template>
<script>
export default { name: 'TeamCard', props: { team: Object } }
</script>
<style lang="less" scoped>
.teamCard {
  display: flex;
  align-items: center;
  gap: 16px;
  background: #fff;
  border: 1px solid #e2e9e6;
  border-radius: 13px;
  padding: 20px;
  cursor: pointer;
  &:hover {
    border-color: #b6d6c9;
    box-shadow: 0 8px 24px rgba(25, 70, 54, 0.07);
  }
  .teamIcon {
    width: 48px;
    height: 48px;
    border-radius: 12px;
    background: #eaf5f0;
    color: #0c9065;
    display: grid;
    place-items: center;
    font-size: 22px;
  }
  div:nth-child(2) {
    flex: 1;
  }
  h3 {
    margin: 0;
    font-size: 16px;
  }
  p {
    margin: 6px 0;
    color: #71827b;
    font-size: 13px;
  }
  span {
    color: #98a39f;
    font-size: 12px;
  }
  .arrow {
    color: #9aa7a2;
  }
}
</style>
