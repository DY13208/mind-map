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
          <p>{{ team.description }}</p>
          <span
            >Owner {{ team.owner }} · 更新于 {{ format(team.updatedAt) }}</span
          >
        </div>
      </div>
      <el-tabs v-model="tab">
        <el-tab-pane label="脑图" name="rooms">
          <p v-if="folderId">
            <el-button type="text" @click="folderId = null"
              >全部团队脑图</el-button
            >
            / {{ folderName }}
          </p>
          <div class="roomGrid">
            <RoomCard
              v-for="room in visibleRooms"
              :key="room.id"
              :room="room"
              v-on="roomListeners"
            />
          </div>
          <EmptyState
            v-if="!loading && !visibleRooms.length"
            title="暂无脑图"
            description="此团队或文件夹中暂无脑图"
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
        <el-tab-pane label="文件夹" name="folders" lazy>
          <el-input
            v-model="folderQuery"
            prefix-icon="el-icon-search"
            clearable
            placeholder="搜索团队文件夹"
          />
          <div class="folderGrid">
            <FolderCard
              v-for="folder in visibleFolders"
              :key="folder.id"
              :folder="folder"
              :editable="false"
              @open="openFolder"
            />
          </div>
          <EmptyState
            v-if="!loading && !visibleFolders.length"
            title="暂无匹配文件夹"
            description="换个关键词再试试"
            icon="el-icon-folder"
          />
        </el-tab-pane>
      </el-tabs>
    </div>
    <RoomActionDialogs ref="actions" @changed="load" />
  </section>
</template>
<script>
import teamService from '@/services/teamService'
import RoomCard from './components/RoomCard.vue'
import TeamMemberList from './components/TeamMemberList.vue'
import EmptyState from './components/EmptyState.vue'
import FolderCard from './components/FolderCard.vue'
import RoomActionDialogs from './components/RoomActionDialogs.vue'
export default {
  name: 'SpaceDetailPage',
  components: {
    RoomCard,
    TeamMemberList,
    EmptyState,
    FolderCard,
    RoomActionDialogs
  },
  data: () => ({
    team: null,
    rooms: [],
    members: [],
    folders: [],
    tab: 'rooms',
    folderId: null,
    folderQuery: '',
    loading: false,
    busy: false,
    error: '',
    requestId: 0
  }),
  computed: {
    visibleRooms() {
      return this.rooms.filter(
        room => !this.folderId || room.folderId === this.folderId
      )
    },
    visibleFolders() {
      return this.folders.filter(folder =>
        folder.name.includes(this.folderQuery.trim())
      )
    },
    folderName() {
      const folder = this.folders.find(item => item.id === this.folderId)
      return folder ? folder.name : '根目录'
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
        this.$message.success('团队成员已更新（Mock）')
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
}
.roomGrid,
.folderGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 14px;
}
.folderGrid {
  margin-top: 16px;
}
.memberPanel {
  max-width: 720px;
  background: white;
  border: 1px solid #e3e9e6;
  padding: 12px 20px;
  border-radius: 12px;
}
</style>
