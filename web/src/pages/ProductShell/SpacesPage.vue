<template>
  <section class="productPage spacesPage">
    <div class="productHeader">
      <div>
        <h1>团队空间</h1>
        <p>在企业内部创建团队、共享脑图与协作权限</p>
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
    <div class="teamsHeading">
      <h2 class="sectionTitle"><span class="desktopTeamTitle">团队空间</span><span class="mobileTeamTitle">我的团队</span></h2>
      <el-button class="mobileTeamCreate" type="primary" icon="el-icon-plus" @click="createTeam">新建团队</el-button>
    </div>
    <el-dialog title="搜索团队" :visible.sync="searchOpen" width="420px" @opened="focusSearch" @closed="search = ''">
      <el-input ref="teamSearch" v-model="search" placeholder="输入团队名称" prefix-icon="el-icon-search" clearable label="搜索团队" />
      <div v-if="search.trim()" class="teamSearchResults">
        <button v-for="team in matchingTeams" :key="team.id" type="button" @click="open(team)">{{ team.name }}<i class="el-icon-arrow-right" /></button>
        <p v-if="!matchingTeams.length">{{ loading ? '正在加载团队…' : error ? '团队加载失败，请关闭后重试' : '没有找到匹配的团队' }}</p>
      </div>
    </el-dialog>
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
    <p v-if="!loading && !error && teams.length" class="mobileTeamTotal">共 {{ teams.length }} 个团队</p>
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
    searchOpen: false,
    search: '',
    teams: [],
    error: '',
    corpName: currentCorpName()
  }),
  created() {
    this.load()
    this.$bus.$on('mobile-search-teams', this.openSearch)
  },
  beforeDestroy() {
    this.$bus.$off('mobile-search-teams', this.openSearch)
  },
  computed: {
    matchingTeams() {
      const query = this.search.trim().toLocaleLowerCase()
      if (!query) return []
      return this.teams.filter(team => team.name.toLocaleLowerCase().includes(query))
    }
  },
  methods: {
    openSearch() {
      this.search = ''
      this.searchOpen = true
    },
    focusSearch() {
      this.$refs.teamSearch.focus()
    },
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
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
  min-height: 120px;
}
</style>
<style lang="less" scoped>
.mobileTeamTitle, .mobileTeamCreate, .mobileTeamTotal { display: none; }
.teamSearchResults {
  margin-top: 12px;
  button { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; min-height: 48px; padding: 12px; border: 0; border-radius: 8px; background: transparent; color: inherit; text-align: left; overflow-wrap: anywhere; cursor: pointer; }
  button:hover { background: #eaf5f0; }
  p { color: #71827b; text-align: center; }
}
@media (max-width: 767px) {
  .spacesPage {
    .productHeader { display: none; }
    .personal { max-width: none; padding: 16px; min-height: 76px; box-sizing: border-box; gap: 14px; border-radius: 14px; }
    .personal > i { background: #eaf5f0; color: #087854; flex: 0 0 44px; font-size: 22px; }
    .personal > div { min-width: 0; }
    .personal strong { font-size: 17px; }
    .personal p { font-size: 12px; }
    .personal .el-button { min-width: 44px; min-height: 44px; padding: 0; font-size: 0; color: #71827b; &::after { content: '\e6e0'; font-family: element-icons; font-size: 18px; } }
    .teamsHeading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 24px 0 12px; }
    .sectionTitle { display: flex; align-items: center; min-height: 44px; margin: 0; font-size: 16px; line-height: 22px; color: var(--ui-text); }
    .desktopTeamTitle { display: none; }
    .mobileTeamTitle { display: inline; }
    .mobileTeamCreate {
      position: relative; isolation: isolate; display: inline-flex; align-items: center; justify-content: center;
      box-sizing: border-box; height: 44px; min-height: 44px; padding: 0 6px; border: 0; border-radius: 4px;
      background: transparent; font-size: 12px; line-height: 22px;
      &::before { content: ''; position: absolute; z-index: -1; inset: 11px 0; border-radius: 4px; background: #087854; }
      &:hover, &:focus, &:active { background: transparent; }
      &:hover::before, &:focus::before { background: #066647; }
    }
    .teamGrid { grid-template-columns: minmax(0, 1fr); gap: 12px; }
    .mobileTeamTotal { display: block; text-align: center; color: #83918c; font-size: 12px; margin: 16px 0 0; }
  }
}
</style>
<style lang="less" scoped>
@media (max-width: 767px) {
  .spacesPage {
    .personal { min-height: 117px; padding: 18px 22px; gap: 18px; border-color: #e0e9e3; border-radius: 22px; background: rgba(255,255,255,.91); box-shadow: 0 8px 28px rgba(34,70,55,.035); }
    .personal > i { width: 65px; height: 65px; flex-basis: 65px; border-radius: 18px; background: #e9f5ef; color: #087e60; font-size: 32px; }
    .personal strong { display: block; font-size: 22px; font-weight: 750; letter-spacing: -.3px; }
    .personal p { margin-top: 6px; color: #8b9a92; font-size: 15px; }
    .teamsHeading { position: relative; margin: 32px 0 15px; padding: 17px 21px; border: 1px solid #d8eadf; border-radius: 22px; background: linear-gradient(112deg,#e6f5ed 0%,#f0f9f3 60%,#edf6f1 100%); overflow: hidden; }
    .teamsHeading::before, .teamsHeading::after { content: ''; position: absolute; border-radius: 50%; pointer-events: none; }
    .teamsHeading::before { right: -1px; top: -89px; width: 210px; height: 180px; border: 1px solid rgba(53,142,105,.07); }
    .teamsHeading::after { right: -48px; bottom: -115px; width: 260px; height: 200px; border: 1px solid rgba(53,142,105,.11); }
    .sectionTitle { position: relative; z-index: 1; font-size: 23px; font-weight: 770; letter-spacing: -.35px; color: #152925; }
    .mobileTeamCreate { z-index: 1; flex: none; height: 44px; min-height: 44px; padding: 0 16px 0 13px; gap: 8px; border: 1px solid rgba(0,90,65,.05); border-radius: 12px; background: linear-gradient(135deg,#0c8768,#066a50); font-size: 15px; font-weight: 650; line-height: 22px; box-shadow: 0 6px 14px rgba(0,104,71,.15); }
    .mobileTeamCreate::before { content: none; }
    .mobileTeamCreate:hover, .mobileTeamCreate:focus { background: #05644e; }
    .mobileTeamCreate /deep/ .el-icon-plus { font-size: 19px; }
    .mobileTeamTotal { font-size: 0; padding: 14px 0 8px; margin: 0; color: #a4b1a7; &::after { content: '— 已展示全部团队 —'; font-size: 12px; } }
  }
}
@media (max-width: 470px) {
  .spacesPage {
    .personal { min-height: 104px; gap: 13px; padding: 16px; border-radius: 19px; }
    .personal > i { width: 57px; height: 57px; flex-basis: 57px; border-radius: 15px; }
    .personal strong { font-size: 20px; }
    .personal p { font-size: 13px; }
    .teamsHeading { margin-top: 28px; padding: 15px; border-radius: 19px; }
    .sectionTitle { font-size: 21px; }
    .mobileTeamCreate { height: 42px; min-height: 42px; padding: 0 12px; gap: 5px; font-size: 14px; }
  }
}
@media (max-width: 355px) {
  .spacesPage {
    .teamsHeading { gap: 5px; padding: 14px 12px; }
    .mobileTeamCreate { font-size: 13px; padding: 0 9px; }
  }
}
</style>
