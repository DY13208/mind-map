<template>
  <section class="productPage">
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
      <div v-if="team" class="teamHero">
        <div class="teamMark"><i class="el-icon-office-building" /></div>
        <div>
          <h1>{{ team.name }}</h1>
          <p v-if="team.description">{{ team.description }}</p>
          <span
            >{{ team.memberCount }} 位成员 · {{ team.roomCount }} 个脑图 ·
            创建者 {{ team.owner || '—' }} · {{ roleLabel }} · 更新于
            {{ format(team.updatedAt) }}</span
          >
        </div>
        <div class="teamActions">
          <el-button
            icon="el-icon-files"
            @click="openInFiles"
            >在脑图查看</el-button
          >
          <el-button
            v-if="canManage"
            icon="el-icon-folder-add"
            @click="createFolder"
            >新建文件夹</el-button
          >
          <el-button type="primary" icon="el-icon-plus" @click="createRoom"
            >新建脑图</el-button
          >
          <el-button
            icon="el-icon-share"
            :disabled="!canManage"
            @click="openShare"
            >分享 / 权限</el-button
          >
          <el-button
            icon="el-icon-setting"
            :disabled="!canManage"
            @click="openSettings"
            >团队设置</el-button
          >
        </div>
      </div>
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
              :allow-move-to-team="false"
              v-on="roomListeners"
            />
          </div>
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
  </section>
</template>
<script>
import teamService from '@/services/teamService'
import RoomCard from './components/RoomCard.vue'
import FolderCard from './components/FolderCard.vue'
import TeamMemberList from './components/TeamMemberList.vue'
import EmptyState from './components/EmptyState.vue'
import RoomActionDialogs from './components/RoomActionDialogs.vue'
import ShareTeamDialog from './components/ShareTeamDialog.vue'
export default {
  name: 'SpaceDetailPage',
  components: {
    RoomCard,
    FolderCard,
    TeamMemberList,
    EmptyState,
    RoomActionDialogs,
    ShareTeamDialog
  },
  data: () => ({
    team: null,
    rooms: [],
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
    visibleRooms() {
      return this.rooms.filter(room =>
        this.folderId
          ? room.folderId === this.folderId
          : !room.folderId
      )
    },
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
      return this.folders
        .filter(folder => (folder.parentId || null) === (this.folderId || null))
        .map(folder => ({
          ...folder,
          itemCount:
            Number(folder.roomCount || 0) +
            this.folders.filter(child => child.parentId === folder.id).length
        }))
    },
    folderListeners() {
      return {
        open: this.openFolder,
        rename: this.renameFolder,
        delete: this.deleteFolder
      }
    },
    roomListeners() {
      return Object.fromEntries(
        [
          'open',
          'favorite',
          'rename',
          'move',
          'share',
          'history',
          'delete'
        ].map(action => [
          action,
          room => this.$refs.actions.handle(action, room)
        ])
      )
    }
  },
  watch: {
    '$route.params.id'() {
      this.folderId = null
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
          teamService.listRooms(id),
          teamService.listMembers(id),
          teamService.listFolders(id)
        ])
        if (request === this.requestId)
          Object.assign(this, { team, rooms, members, folders })
      } catch (error) {
        if (request === this.requestId) this.error = error.message
      } finally {
        if (request === this.requestId) this.loading = false
      }
    },
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
    async renameFolder(folder) {
      if (!this.canManage) {
        this.$message.error('只有团队所有者或管理员可以重命名文件夹')
        return
      }
      try {
        const result = await this.$prompt('请输入新的文件夹名称', '重命名文件夹', {
          inputValue: folder.name,
          inputValidator: value =>
            (!!value && !!value.trim() && value.length <= 60) ||
            '请输入 1 至 60 个字符'
        })
        this.busy = true
        await teamService.renameFolder(
          this.$route.params.id,
          folder.id,
          result.value.trim()
        )
        await this.load()
        this.$message.success('文件夹已重命名')
      } catch (error) {
        if (error !== 'cancel' && error !== 'close')
          this.$message.error(error.message || '重命名失败')
      } finally {
        this.busy = false
      }
    },
    async deleteFolder(folder) {
      if (!this.canManage) {
        this.$message.error('只有团队所有者或管理员可以删除文件夹')
        return
      }
      const confirmed = await this.$confirm(
        '删除文件夹「' +
          folder.name +
          '」？若其中还有脑图或子文件夹，需要先将内容移出后再删除。',
        '删除文件夹'
      )
        .then(() => true)
        .catch(() => false)
      if (!confirmed) return
      this.busy = true
      try {
        await teamService.deleteFolder(this.$route.params.id, folder.id)
        if (this.folderId === folder.id) this.folderId = null
        await this.load()
        this.$message.success('文件夹已删除')
      } catch (error) {
        this.$message.error(error.message || '删除文件夹失败')
      } finally {
        this.busy = false
      }
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
    background: #0d9066;
    color: white;
    font-size: 25px;
  }
  h1 {
    margin: 0;
    font-size: 25px;
  }
  p {
    margin: 6px 0;
    color: #63776f;
  }
  span {
    color: #76897f;
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
    color: #83918c;
  }
}
.roomGrid,
.folderGrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 14px;
}
.folderGrid {
  margin-bottom: 14px;
}
.memberPanel {
  max-width: 720px;
  background: white;
  border: 1px solid #e3e9e6;
  padding: 12px 20px;
  border-radius: 12px;
}
@media (max-width: 760px) {
  .teamHero { align-items: flex-start; flex-wrap: wrap; }
  .teamHero .teamActions { margin-left: 0; width: 100%; justify-content: flex-start; }
}
</style>
