<template>
  <section class="productPage">
    <div class="productHeader">
      <div>
        <h1>团队空间</h1>
        <p>当前企业：{{ corpName || '企业微信企业' }} · 在企业内部协作</p>
      </div>
      <el-button type="primary" icon="el-icon-plus" @click="createTeam"
        >新建团队</el-button
      >
    </div>
    <div class="personal">
      <i class="el-icon-user-solid" />
      <div>
        <strong>个人空间</strong>
        <p>你的个人脑图与文件夹</p>
      </div>
      <el-button type="text" @click="$router.push('/files')">进入</el-button>
    </div>
    <h2 class="sectionTitle">团队空间</h2>
    <div v-if="error">
      <el-alert :title="error" type="error" :closable="false" /><el-button
        @click="load"
        >重试</el-button
      >
    </div>
    <div v-else v-loading="loading" class="teamGrid">
      <TeamCard
        v-for="team in teams"
        :key="team.id"
        :team="team"
        @open="open"
      />
    </div>
    <EmptyState
      v-if="!loading && !error && !teams.length"
      title="暂无团队空间"
      description="加入团队后会显示在这里"
      icon="el-icon-office-building"
    />
  </section>
</template>
<script>
import teamService from '@/services/teamService'
import { getCurrentUser } from '@/utils/auth'
import TeamCard from './components/TeamCard.vue'
import EmptyState from './components/EmptyState.vue'

function currentCorpName() {
  const user = getCurrentUser()
  return (user && (user.corpName || user.corpId)) || ''
}

export default {
  name: 'SpacesPage',
  components: { TeamCard, EmptyState },
  data: () => ({
    loading: false,
    teams: [],
    error: '',
    corpName: currentCorpName()
  }),
  created() {
    this.load()
  },
  methods: {
    async load() {
      this.loading = true
      this.error = ''
      try {
        this.teams = await teamService.listSpaces()
        this.corpName =
          (this.teams[0] && this.teams[0].corpName) || this.corpName
      } catch (error) {
        this.error = error.message
      } finally {
        this.loading = false
      }
    },
    open(team) {
      this.$router.push('/spaces/' + team.id)
    },
    async createTeam() {
      try {
        const result = await this.$prompt('请输入团队名称', '新建自定义团队', {
          inputValue: '',
          inputPlaceholder: '例如：产品研发组',
          confirmButtonText: '创建',
          cancelButtonText: '取消',
          inputValidator: value => (value && value.trim() ? true : '请输入团队名称')
        })
        const team = await teamService.createSpace(result.value)
        this.teams = [team, ...this.teams]
        this.corpName = team.corpName || this.corpName
        this.$message.success('团队已创建')
      } catch (error) {
        if (error !== 'cancel' && error !== 'close') this.$message.error(error.message || '创建团队失败')
      }
    }
  }
}
</script>
<style lang="less" scoped>
.personal {
  max-width: 520px;
  display: flex;
  align-items: center;
  gap: 14px;
  background: white;
  border: 1px solid #e2e9e6;
  padding: 18px;
  border-radius: 13px;
  > i {
    width: 44px;
    height: 44px;
    border-radius: 12px;
    display: grid;
    place-items: center;
    background: #173b30;
    color: white;
  }
  div {
    flex: 1;
  }
  p {
    margin: 5px 0 0;
    color: #83918c;
    font-size: 12px;
  }
}
.teamGrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, 300px);
  gap: 14px;
  min-height: 120px;
}
</style>
