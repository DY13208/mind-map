<template>
  <section class="productPage spaceDetailPage">
    <el-button
      type="text"
      icon="el-icon-arrow-left"
      @click="$router.push('/spaces')"
      >返回团队空间</el-button
    >
    <div v-if="error">
      <el-alert :title="error" type="error" :closable="false" /><el-button
        @click="load"
        >重试</el-button
      >
    </div>
    <div v-else v-loading="loading || busy" class="teamBody">
      <div v-if="team" class="teamOverview">
      <div class="teamHero">
        <div class="teamMark"><i class="el-icon-office-building" /></div>
        <div class="teamHeroText">
          <div class="heroTitleLine"><h1>{{ team.name }}</h1><span v-if="team.role === 'owner'" class="detailOwnerBadge">我创建的</span></div>
          <p v-if="team.description">{{ team.description }}</p>
          <span class="desktopHeroMeta"
            >{{ team.memberCount }} 位成员 · {{ team.roomCount }} 个脑图 ·
            创建者 {{ team.owner || '—' }} · {{ roleLabel }} · 更新于
            {{ format(team.updatedAt) }}</span
          >
          <div class="mobileHeroMeta"><span><i class="el-icon-user" /> {{ team.memberCount }} 位成员</span><span><i class="el-icon-files" /> {{ team.roomCount }} 个脑图</span><span><i class="el-icon-lock" /> {{ roleLabel }}</span></div>
        </div>
        <div class="mobileHeroFooter"><span>创建者 <strong>{{ team.owner || '—' }}</strong></span><span>最近更新 <strong>{{ team.updatedAt ? format(team.updatedAt) : '—' }}</strong></span></div>
      </div>
        <div class="teamActions">
          <el-button
            class="detailViewAction"
            icon="el-icon-files"
            @click="openInFiles"
            >在脑图查看</el-button
          >
          <el-button
            class="detailFolderAction"
            v-if="canManage"
            icon="el-icon-folder-add"
            @click="createFolder"
            >新建文件夹</el-button
          >
          <el-button class="detailCreateAction" type="primary" icon="el-icon-plus" @click="createRoom"
            >新建脑图</el-button
          >
          <el-button
            class="detailShareAction"
            icon="el-icon-share"
            :disabled="!canManage"
            @click="openShare"
            >分享 / 权限</el-button
          >
          <el-button
            class="detailSettingsAction"
            icon="el-icon-setting"
            :disabled="!canManage"
            @click="openSettings"
            >团队设置</el-button
          >
        </div>
      </div>
      <div class="detailContentHeading"><h2>团队内容</h2></div>
      <el-tabs v-model="tab">
        <el-tab-pane label="脑图" name="rooms">
          <nav v-if="folderId" class="folderNav">
            <el-button type="text" @click="folderId = null"
              >全部团队脑图</el-button
            >
            <template v-for="(item, index) in folderPath">
              <span :key="'sep-' + item.id" class="folderSep">/</span>
              <el-button
                :key="item.id"
                type="text"
                :disabled="index === folderPath.length - 1"
                @click="openFolder(item)"
                >{{ item.name }}</el-button
              >
            </template>
          </nav>
          <div v-if="childFolders.length" class="folderGrid">
            <FolderCard
              v-for="folder in childFolders"
              :key="folder.id"
              :folder="folder"
              :editable="canManage"
              :allow-share="false"
              v-on="folderListeners"
            />
          </div>
          <div v-if="visibleRooms.length" class="roomGrid">
            <RoomCard
              v-for="room in visibleRooms"
              :key="room.id"
              :room="room"
              v-on="roomListeners"
            />
          </div>
          <el-pagination v-if="total > limit" :current-page="page" :page-size="limit"
            :total="total" layout="prev, next" @current-change="onRoomPage" />
          <EmptyState
            v-if="!loading && !childFolders.length && !visibleRooms.length"
            title="暂无内容"
            description="此团队或文件夹中暂无脑图与文件夹"
          />
        </el-tab-pane>
        <el-tab-pane label="成员" name="members" lazy
          ><div class="memberPanel">
            <TeamMemberList
              :members="members"
              @role="role"
              @remove="remove"
            /><EmptyState
              v-if="!members.length && !loading"
              title="暂无成员"
            /></div
        ></el-tab-pane>
      </el-tabs>
    </div>
    <RoomActionDialogs ref="actions" :team-id="$route.params.id" @changed="load" />
    <ShareTeamDialog
      :visible.sync="shareVisible"
      :team="team"
      @changed="load"
    />
    <el-dialog title="团队设置" :visible.sync="settingsVisible" width="520px">
      <el-form label-width="80px" @submit.native.prevent="saveSettings">
        <el-form-item label="团队名称"><el-input v-model="settingsForm.name" maxlength="60" /></el-form-item>
        <el-form-item label="团队描述"><el-input v-model="settingsForm.description" type="textarea" :rows="3" maxlength="200" /></el-form-item>
      </el-form>
      <span slot="footer">
        <el-button @click="settingsVisible = false">取消</el-button>
        <el-button type="primary" @click="saveSettings">保存</el-button>
      </span>
    </el-dialog>
    <DeleteFolderDialog
      :visible.sync="deleteFolderVisible"
      :folder="folderToDelete"
      :folders="folders"
      :team-id="$route.params.id"
      @deleted="onFolderDeleted"
    />
  </section>
</template>
<script>
import teamService from '@/services/teamService'
import RoomCard from './components/RoomCard.vue'
import FolderCard from './components/FolderCard.vue'
import DeleteFolderDialog from './components/DeleteFolderDialog.vue'
import TeamMemberList from './components/TeamMemberList.vue'
import EmptyState from './components/EmptyState.vue'
import RoomActionDialogs from './components/RoomActionDialogs.vue'
import ShareTeamDialog from './components/ShareTeamDialog.vue'
export default {
  name: 'SpaceDetailPage',
  components: {
    RoomCard,
    FolderCard,
    DeleteFolderDialog,
    TeamMemberList,
    EmptyState,
    RoomActionDialogs,
    ShareTeamDialog
  },
  data: () => ({
    team: null,
    rooms: [],
    page: 1,
    limit: 20,
    total: 0,
    members: [],
    folders: [],
    tab: 'rooms',
    folderId: null,
    loading: false,
    busy: false,
    error: '',
    requestId: 0,
    shareVisible: false,
    settingsVisible: false,
    deleteFolderVisible: false,
    folderToDelete: null,
    settingsForm: { name: '', description: '' }
  }),
  computed: {
    canManage() {
      return this.team && ['owner', 'admin'].includes(this.team.role)
    },
    roleLabel() {
      const role = this.team && this.team.role
      if (role === 'owner') return '我是所有者'
      if (role === 'admin') return '我是管理员'
      return '我是成员'
    },
    visibleRooms() { return this.rooms },
    folderMap() {
      return Object.fromEntries(this.folders.map(folder => [folder.id, folder]))
    },
    folderPath() {
      const path = []
      const visited = new Set()
      let current = this.folderId ? this.folderMap[this.folderId] : null
      while (current && !visited.has(current.id)) {
        path.unshift(current)
        visited.add(current.id)
        current = current.parentId ? this.folderMap[current.parentId] : null
      }
      return path
    },
    childFolders() {
      const counts = new Map()
      this.folders.forEach(folder => counts.set(folder.parentId, (counts.get(folder.parentId) || 0) + 1))
      return this.folders.filter(folder => (folder.parentId || null) === (this.folderId || null))
        .map(folder => ({ ...folder, itemCount: Number(folder.roomCount || 0) + (counts.get(folder.id) || 0) }))
    },
    folderListeners() {
      return {
        open: this.openFolder,
        'rename-inline': this.renameFolder,
        delete: this.deleteFolder
      }
    },
    roomListeners() {
      return {
        ...Object.fromEntries(
          ['open', 'favorite', 'move', 'share', 'delete'].map(action => [
            action,
            room => this.$refs.actions.handle(action, room)
          ])
        ),
        'rename-inline': (room, name) => this.$refs.actions.renameDirect(room, name)
      }
    }
  },
  watch: {
    folderId() { this.page = 1; this.loadRooms() },
    '$route.params.id'() {
      this.folderId = null
      this.page = 1
      this.tab = 'rooms'
      this.load()
    }
  },
  created() {
    this.load()
  },
  beforeDestroy() {
    this.requestId++
  },
  methods: {
    openInFiles() {
      this.$router.push({
        path: '/files',
        query: { team: this.$route.params.id }
      })
    },
    openShare() {
      if (!this.canManage) return
      this.shareVisible = true
    },
    async load() {
      const request = ++this.requestId
      const id = this.$route.params.id
      this.loading = true
      this.error = ''
      try {
        const [team, rooms, members, folders] = await Promise.all([
          teamService.getSpace(id),
          teamService.listRoomsPage(id, { folderId: this.folderId, limit: this.limit, offset: (this.page - 1) * this.limit }),
          teamService.listMembers(id),
          teamService.listFolders(id)
        ])
        if (request === this.requestId) {
          Object.assign(this, { team, rooms: rooms.list, total: rooms.total, members, folders })
          const maxPage = Math.max(1, Math.ceil(rooms.total / this.limit))
          if (this.page > maxPage) { this.page = maxPage; await this.loadRooms() }
        }
      } catch (error) {
        if (request === this.requestId) this.error = error.message
      } finally {
        if (request === this.requestId) this.loading = false
      }
    },
    async loadRooms() {
      const request = ++this.requestId
      this.loading = true
      try {
        const result = await teamService.listRoomsPage(this.$route.params.id,
          { folderId: this.folderId, limit: this.limit, offset: (this.page - 1) * this.limit })
        if (request === this.requestId) {
          this.rooms = result.list
          this.total = result.total
          const maxPage = Math.max(1, Math.ceil(result.total / this.limit))
          if (this.page > maxPage) { this.page = maxPage; await this.loadRooms() }
        }
      } catch (error) { if (request === this.requestId) this.error = error.message }
      finally { if (request === this.requestId) this.loading = false }
    },
    onRoomPage(page) { this.page = page; this.loadRooms() },
    openFolder(folder) {
      this.folderId = folder.id
      this.tab = 'rooms'
    },
    async createRoom() {
      try {
        const result = await this.$prompt('请输入脑图名称', '新建团队脑图', {
          inputValue: '未命名脑图',
          confirmButtonText: '创建',
          cancelButtonText: '取消'
        })
        await teamService.createRoom(this.$route.params.id, result.value, this.folderId)
        await this.load()
        this.$message.success('脑图已创建')
      } catch (error) {
        if (error !== 'cancel' && error !== 'close') this.$message.error(error.message || '创建脑图失败')
      }
    },
    async createFolder() {
      if (!this.canManage) {
        this.$message.error('只有团队所有者或管理员可以创建文件夹')
        return
      }
      try {
        const currentFolder = this.folderId ? this.folderMap[this.folderId] : null
        const result = await this.$prompt(
          currentFolder
            ? `将在「${currentFolder.name}」中创建子文件夹`
            : '将在当前团队根目录创建文件夹',
          '新建文件夹',
          {
            inputValidator: value =>
              (!!value && !!value.trim() && value.length <= 60) ||
              '请输入 1 至 60 个字符'
          }
        )
        this.busy = true
        await teamService.createFolder(
          this.$route.params.id,
          result.value.trim(),
          this.folderId
        )
        await this.load()
        this.$message.success('文件夹已创建')
      } catch (error) {
        if (error !== 'cancel' && error !== 'close')
          this.$message.error(error.message || '创建文件夹失败')
      } finally {
        this.busy = false
      }
    },
    async renameFolder(folder, name) {
      if (!this.canManage) {
        this.$message.error('只有团队所有者或管理员可以重命名文件夹')
        return
      }
      if (this.busy) return
      try {
        this.busy = true
        await teamService.renameFolder(this.$route.params.id, folder.id, name)
        await this.load()
        this.$message.success('文件夹已重命名')
      } catch (error) {
        this.$message.error(error.message || '重命名失败')
      } finally {
        this.busy = false
      }
    },
    deleteFolder(folder) {
      if (!this.canManage) {
        this.$message.error('只有团队所有者或管理员可以删除文件夹')
        return
      }
      this.folderToDelete = folder
      this.deleteFolderVisible = true
    },
    async onFolderDeleted(result) {
      if (result.deletedFolderIds.includes(this.folderId)) this.folderId = null
      await this.load()
    },
    openSettings() {
      this.settingsForm = { name: this.team.name, description: this.team.description || '' }
      this.settingsVisible = true
    },
    async saveSettings() {
      this.busy = true
      try {
        this.team = await teamService.updateSpace(this.$route.params.id, this.settingsForm)
        this.settingsVisible = false
        this.$message.success('团队设置已保存')
      } catch (error) {
        this.$message.error(error.message)
      } finally {
        this.busy = false
      }
    },
    format(value) {
      return new Date(value).toLocaleDateString('zh-CN')
    },
    async role(member, role) {
      await this.perform(() =>
        teamService.updateMemberRole(this.$route.params.id, member.id, role)
      )
    },
    async remove(member) {
      const confirmed = await this.$confirm(
        '移除团队成员「' + member.name + '」？',
        '移除成员'
      )
        .then(() => true)
        .catch(() => false)
      if (confirmed)
        await this.perform(() =>
          teamService.removeMember(this.$route.params.id, member.id)
        )
    },
    async perform(action) {
      if (this.busy) return
      this.busy = true
      try {
        await action()
        await this.load()
        this.$message.success('团队成员已更新')
      } catch (error) {
        this.$message.error(error.message)
      } finally {
        this.busy = false
      }
    }
  }
}
</script>
<style lang="less" scoped>
.detailOwnerBadge, .mobileHeroMeta, .mobileHeroFooter, .detailContentHeading { display: none; }
.teamOverview { display: flex; align-items: center; gap: 16px; margin: 18px 0 28px; }
.teamOverview .teamHero { flex: 1; min-width: 0; margin: 0; }
.teamActions { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.teamBody {
  min-height: 240px;
}
.teamHero {
  display: flex;
  gap: 16px;
  align-items: center;
  margin: 18px 0 28px;
  .teamMark {
    width: 58px;
    height: 58px;
    border-radius: 15px;
    display: grid;
    place-items: center;
    background: var(--ui-primary);
    color: var(--ui-on-primary);
    font-size: 25px;
  }
  h1 {
    margin: 0;
    font-size: 25px;
    color: var(--ui-text);
  }
  p {
    margin: 6px 0;
    color: var(--ui-text-secondary);
  }
  span {
    color: var(--ui-text-muted);
    font-size: 12px;
  }
  .teamActions {
    margin-left: auto;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
}
.folderNav {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  margin: 0 0 12px;
  .folderSep {
    color: var(--ui-text-muted);
  }
}
.roomGrid,
.folderGrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 28px 20px;
}
.folderGrid {
  margin-bottom: 28px;
}
.memberPanel {
  max-width: 720px;
  background: var(--ui-surface);
  border: 1px solid var(--ui-border);
  padding: 12px 20px;
  border-radius: 12px;
}
@media (max-width: 760px) {
  .teamHero { align-items: flex-start; flex-wrap: wrap; }
  .teamHero .teamActions { margin-left: 0; width: 100%; justify-content: flex-start; }
}
</style>
<style lang="less" scoped>
@media (max-width: 767px) {
  .spaceDetailPage {
    > .el-button { padding: 0; margin-bottom: 17px; color: #52877a; font-size: 13px; }
    .teamOverview { display: block; margin: 0; }
    .teamHero { position: relative; display: flex; flex-wrap: wrap; align-items: flex-start; gap: 15px; padding: 22px 20px; border: 1px solid #e2eae6; border-radius: 18px; background: linear-gradient(112deg,#fff 3%,#fcfffd 70%,#edf7f0 130%); box-shadow: 0 9px 30px rgba(21,66,50,.045); overflow: hidden; }
    .teamHero::after { content: ''; position: absolute; right: -70px; top: -130px; width: 310px; height: 310px; border-radius: 50%; border: 65px solid rgba(9,133,97,.035); pointer-events: none; }
    .teamMark { width: 61px; height: 61px; flex: 0 0 61px; border-radius: 17px; font-size: 31px; color: white; background: linear-gradient(145deg,#07906b,#076a52); box-shadow: 0 12px 26px rgba(6,116,86,.14); }
    .teamHeroText { flex: 1; min-width: 0; position: relative; z-index: 1; }
    .heroTitleLine { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; padding-top: 2px; }
    .teamHero h1 { font-size: 26px; line-height: 1.25; letter-spacing: -.7px; overflow-wrap: anywhere; }
    .teamHero .detailOwnerBadge { display: inline-block; padding: 3px 9px; border-radius: 99px; border: 1px solid #cce9db; background: #ecf8f1; font-size: 12px; color: #087658; white-space: nowrap; }
    .desktopHeroMeta { display: none; }
    .mobileHeroMeta { display: flex; flex-wrap: wrap; gap: 6px 11px; margin-top: 8px; span { display: inline-flex; align-items: center; gap: 5px; color: #7c8e88; font-size: 12px; } i { color: #9aae9e; } }
    .mobileHeroFooter { position: relative; z-index: 1; display: flex; flex-wrap: wrap; gap: 7px 10px; width: 100%; margin-top: 2px; padding-top: 14px; border-top: 1px solid #edf1ee; span { font-size: 12px; color: #647d72; overflow-wrap: anywhere; } strong { font-weight: 650; color: #42665a; } }
    .teamActions { display: grid; grid-template-columns: repeat(6,minmax(0,1fr)); gap: 11px 7px; margin: 14px 0 0; padding: 13px; border: 1px solid #e2eae6; border-radius: 16px; background: white; box-shadow: 0 9px 30px rgba(21,66,50,.045); }
    .teamActions .el-button { margin: 0; min-width: 0; border-radius: 12px; padding: 0 8px; font-size: 14px; height: 46px; display: flex; align-items: center; justify-content: center; gap: 5px; }
    .detailCreateAction { order: 0; grid-column: span 3; background: #08785d; border-color: #08785d; }
    .detailFolderAction { order: 1; grid-column: span 3; }
    .teamActions .detailViewAction, .teamActions .detailShareAction, .teamActions .detailSettingsAction { order: 2; grid-column: span 2; height: 56px; padding: 9px 0 0; border: 0; border-top: 1px solid #edf1ed; border-radius: 0; background: transparent; flex-direction: column; gap: 5px; font-size: 11px; color: #72867b; }
    .teamActions /deep/ .el-button i { font-size: 19px; }
    .teamActions /deep/ .el-button span { margin: 0; }
    .teamActions .is-disabled { opacity: .45; }
    .detailContentHeading { display: block; margin-top: 27px; h2 { margin: 0; font-size: 19px; font-weight: 800; color: #182d29; } p { margin: 4px 0 0; font-size: 12px; color: #92a199; } }
    /deep/ .el-tabs__header { margin: 11px 0 14px; }
    /deep/ .el-tabs__item { color: #7e9187; padding-bottom: 15px; font-size: 15px; font-weight: 620; &.is-active { color: #086e55; } }
    /deep/ .el-tabs__active-bar { height: 3px; background: #098162; }
    .roomGrid, .folderGrid { grid-template-columns: minmax(0,1fr); gap: 13px; }
    .memberPanel { padding: 16px; border-radius: 17px; }
    /deep/ .roomCard.gf-root { height: 251px !important; border-radius: 17px; border: 1px solid #e2eae6; box-shadow: 0 9px 30px rgba(21,66,50,.045); }
    /deep/ .roomCard .gf-sheet { top: 0; left: 0; width: 100%; height: 176px; border-radius: 0; background-color: #fbfdfb; background-image: radial-gradient(#d9e7df 1.18px,transparent 1.18px); background-size: 21px 21px; }
    /deep/ .roomCard .gf-front { height: 75px; }
    /deep/ .roomCard .gf-label { left: 16px; right: 44px; top: 14px; }
    /deep/ .roomCard .gf-title { font-size: 15px; padding-right: 0; }
    /deep/ .roomCard .gf-meta { font-size: 12px; color: #91a099; }
    /deep/ .roomCard .gf-keyWrap { right: 6px; bottom: 13px; }
    /deep/ .roomCard .gf-glyph { width: 19px; }
  }
}
@media (max-width: 370px) { .spaceDetailPage { .teamHero { padding: 20px 16px; gap: 12px; } .teamMark { width: 55px; height: 55px; flex-basis: 55px; } .teamHero h1 { font-size: 24px; } .teamActions .el-button { font-size: 13px; } .teamActions .detailViewAction, .teamActions .detailShareAction, .teamActions .detailSettingsAction { font-size: 11px; } } }
</style>
