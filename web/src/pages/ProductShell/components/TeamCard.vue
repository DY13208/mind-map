<template>
  <article class="teamCard" @click="$emit('open', team)">
    <div class="teamIcon"><i class="el-icon-office-building" /></div>
    <div class="teamBody">
      <div class="teamTitle"><h3>{{ team.name }}</h3><span v-if="team.role === 'owner'" class="teamOwnerBadge">我创建的</span></div>
      <p v-if="team.description" class="desc">{{ team.description }}</p>
      <span class="stats"><span><i class="el-icon-user mobileStatIcon" />{{ team.memberCount }} 位成员</span><span class="statsDivider"> · </span><span><i class="el-icon-share mobileStatIcon" />{{ team.roomCount }} 个脑图</span></span>
      <p class="meta">
        {{ sourceLabel }} · 创建者 {{ team.owner || '—' }} · {{ updatedText }}
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
  width: 100%;
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
<style lang="less" scoped>
.teamTitle { min-width: 0; }
.teamOwnerBadge { display: none; }
.mobileStatIcon { display: none; }
@media (max-width: 767px) {
  .teamCard {
    min-height: 88px; padding: 16px; gap: 12px; border-radius: 14px;
    .teamIcon { width: 44px; height: 44px; flex-basis: 44px; }
    .teamTitle { display: flex; align-items: center; gap: 8px; }
    h3 { min-width: 0; font-size: 16px; }
    .teamOwnerBadge { display: inline-block; flex-shrink: 0; padding: 3px 7px; border-radius: 20px; background: #eaf5f0; color: #087854; font-size: 10px; white-space: nowrap; }
    .stats { margin-top: 8px; font-size: 12px; }
    .desc, .meta { display: none; }
  }
}
</style>
<style lang="less" scoped>
@media (max-width: 767px) {
  .teamCard {
    min-height: 111px; padding: 19px 20px; gap: 17px; border-color: #e4ece7; border-radius: 21px; box-shadow: 0 8px 28px rgba(34,70,55,.035);
    .teamIcon { width: 62px; height: 62px; flex-basis: 62px; font-size: 33px; border-radius: 17px; background: linear-gradient(140deg,#e6f4ed,#eef8f2); color: #0a9474; }
    .teamTitle { flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
    h3 { max-width: 100%; font-size: 20px; font-weight: 750; letter-spacing: -.35px; color: #152925; }
    .teamOwnerBadge { display: inline-flex; align-items: center; gap: 4px; padding: 4px 9px; color: #087959; background: #ebf7f1; font-size: 12px; font-weight: 550; &::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: #26a27c; } }
    .stats { display: flex; align-items: center; gap: 11px; margin: 0; font-size: 13px; color: #87978e; white-space: nowrap; }
    .stats > span:not(.statsDivider) { display: inline-flex; align-items: center; gap: 5px; }
    .mobileStatIcon { display: inline; color: #a4b2a8; font-size: 16px; }
    .statsDivider { width: 1px; height: 13px; background: #d8e3dc; font-size: 0; flex-shrink: 0; }
    .arrow { display: grid; place-items: center; width: 33px; height: 33px; box-sizing: border-box; border: 1px solid #edf2ee; border-radius: 50%; color: #9dad9f; font-size: 16px; }
  }
}
@media (max-width: 470px) {
  .teamCard { padding: 15px 14px; min-height: 99px; gap: 12px; border-radius: 18px;
    .teamIcon { width: 52px; height: 55px; flex-basis: 52px; border-radius: 15px; }
    h3 { font-size: 18px; }
    .teamTitle { gap: 6px; margin-bottom: 9px; }
    .teamOwnerBadge { font-size: 11px; padding: 4px 7px; }
    .stats { font-size: 12px; gap: 7px; }
    .arrow { width: 28px; height: 28px; }
  }
}
@media (max-width: 355px) {
  .teamCard { gap: 9px;
    .teamIcon { width: 45px; height: 49px; flex-basis: 45px; }
    h3 { font-size: 16px; }
    .mobileStatIcon { display: none; }
    .teamOwnerBadge { font-size: 10px; }
  }
}
</style>
