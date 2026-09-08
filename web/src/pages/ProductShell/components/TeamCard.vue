<template>
  <article class="teamCard" @click="$emit('open', team)">
    <div class="teamIcon"><i class="el-icon-office-building" /></div>
    <div class="teamBody">
      <h3>{{ team.name }}</h3>
      <p v-if="team.description" class="desc">{{ team.description }}</p>
      <span class="stats">{{ team.memberCount }} 位成员 · {{ team.roomCount }} 个脑图</span>
      <p class="meta">
        {{ sourceLabel }} · 所有者 {{ team.owner || '—' }} · {{ updatedText }}
      </p>
    </div>
    <i class="el-icon-arrow-right arrow" />
  </article>
</template>
<script>
export default {
  name: 'TeamCard',
  props: { team: Object },
  computed: {
    sourceLabel() {
      return this.team && this.team.sourceType === 'WECOM_DEPARTMENT'
        ? '企微部门'
        : '自定义团队'
    },
    updatedText() {
      const value = this.team && this.team.updatedAt
      if (!value) return ''
      return new Date(value).toLocaleDateString('zh-CN')
    }
  }
}
</script>
<style lang="less" scoped>
.teamCard {
  display: flex;
  align-items: center;
  gap: 16px;
  width: 300px;
  box-sizing: border-box;
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
    flex: 0 0 48px;
    border-radius: 12px;
    background: #eaf5f0;
    color: #0c9065;
    display: grid;
    place-items: center;
    font-size: 22px;
  }
  .teamBody {
    flex: 1;
    min-width: 0;
  }
  h3 {
    margin: 0;
    font-size: 16px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .desc {
    margin: 6px 0 0;
    color: #71827b;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .stats {
    display: block;
    margin-top: 8px;
    color: #52665f;
    font-size: 13px;
  }
  .meta {
    margin: 6px 0 0;
    color: #98a39f;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .arrow {
    color: #9aa7a2;
    flex: 0 0 auto;
  }
}
</style>
