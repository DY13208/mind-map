<template>
  <section class="productPage">
    <div class="productHeader">
      <div>
        <FolderBreadcrumb v-if="folder" :folder="folder" />
        <h1>{{ pageTitle }}</h1>
        <p>{{ pageDescription }}</p>
      </div>
      <div v-if="mode === 'files'" class="workspaceSwitcher">
        <span>当前空间</span>
        <el-select
          :value="selectedTeamId"
          :loading="teamsLoading"
          aria-label="切换个人或团队脑图"
          @change="changeWorkspace"
        >
          <el-option label="个人空间" value="" />
          <el-option
            v-for="team in teams"
            :key="team.id"
            :label="team.name"
            :value="team.id"
          />
        </el-select>
        <el-button
          v-if="selectedTeam"
          type="text"
          @click="$router.push('/spaces/' + selectedTeam.id)"
          >管理团队</el-button
        >
        <el-button v-else type="text" @click="$router.push('/spaces')"
          >我的团队</el-button
        >
      </div>
    </div>
    <FileToolbar
      :search.sync="search"
      :role-filter.sync="roleFilter"
      :sort.sync="sort"
      :view.sync="view"
      :show-create="mode === 'files' || mode === 'folder'"
      :show-create-folder="mode === 'files' && !isTeamView"
      :hide-opened-sort="isRealFilesMode"
      @create-room="createRoom"
      @create-folder="createFolder"
    />
    <div v-if="error" class="statePanel">
      <el-alert
        type="error"
        :title="error"
        :closable="false"
        show-icon
      /><el-button @click="load">重试</el-button>
    </div>
    <div v-else v-loading="loading || busy" class="contentArea">
      <h2 class="sectionTitle" v-if="mode !== 'trash' && itemCount">
        {{ folder ? '当前目录' : pageTitle }} <span>{{ displayCount }}</span>
      </h2>
      <div v-if="mode !== 'trash' && view === 'card' && itemCount" class="itemGrid">
        <template v-if="showFolders">
          <FolderCard
            v-for="item in filteredFolders"
            :key="item.id"
            :folder="item"
            :editable="item.canManage !== false"
            @open="openFolder"
            @rename="renameFolder"
            @share="shareFolder"
            @delete="deleteFolder"
          />
        </template>
      <template v-if="mode === 'trash' && visibleRooms.length"
        ><div class="trashList">
          <div v-for="room in visibleRooms" :key="room.id" class="trashRow">
            <div class="trashIcon"><i class="el-icon-document" /></div>
            <div>
              <strong>{{ room.title }}</strong
              ><span
                >删除于 {{ formatDate(room.deletedAt) }} · 原位置
                {{ room.folderName }}</span
              >
            </div>
            <el-button size="small" @click="restore(room)">恢复</el-button
            ><el-button
              size="small"
              type="danger"
              plain
              @click="permanentDelete(room)"
              >永久删除</el-button
            >
          </div>
        </div></template
      >
        <RoomCard
          v-for="room in visibleRooms"
          :key="room.roomKey || room.id"
          :room="room"
          :allow-delete="!!room.canManage"
          :allow-move-to-team="!isTeamView"
          @open="openRoom"
          @favorite="favorite"
          @rename="renameRoom"
          @move="moveRoom"
          @move-to-team="moveToTeam"
          @share="shareRoom"
          @history="historyRoom"
          @delete="deleteRoom"
        />
      </div>
      <RoomList
        v-if="mode !== 'trash' && view === 'list' && itemCount"
        :rooms="visibleRooms"
        :folders="showFolders ? filteredFolders : []"
        :allow-delete="true"
        :allow-move-to-team="!isTeamView"
        @open="openRoom"
        @open-folder="openFolder"
        @favorite="favorite"
        @rename="renameRoom"
        @move="moveRoom"
        @move-to-team="moveToTeam"
        @share="shareRoom"
        @history="historyRoom"
        @delete="deleteRoom"
      />
      <div v-if="showPager" class="pager">
        <el-pagination
          background
          layout="total, sizes, prev, pager, next, jumper"
          :current-page="page"
          :page-size="limit"
          :page-sizes="pageSizes"
          :total="total"
          :disabled="loading || busy"
          @size-change="onPageSizeChange"
          @current-change="onPageChange"
        />
      </div>
      <EmptyState
        v-if="!loading && !visibleRooms.length && !filteredFolders.length"
        :title="emptyTitle"
        :description="search ? '换个关键词再试试' : emptyDescription"
        :icon="mode === 'trash' ? 'el-icon-delete' : 'el-icon-document'"
        :action="mode === 'files' && !search ? '新建脑图' : ''"
        @action="createRoom"
      />
    </div>
    <RenameDialog
      :visible.sync="renameVisible"
      :value="activeItem ? activeItem.title || activeItem.name : ''"
      :title="renameKind === 'folder' ? '重命名文件夹' : '重命名脑图'"
      @confirm="confirmRename"
    />
    <MoveToFolderDialog
      :visible.sync="moveVisible"
      :room="activeRoom"
      :folders="folders"
      @confirm="confirmMove"
    />
    <MoveToTeamDialog
      :visible.sync="moveToTeamVisible"
      :room="activeRoom"
      @confirm="confirmMoveToTeam"
    />
    <ShareRoomDialog
      :visible.sync="shareVisible"
      :room="activeRoom"
      @changed="() => load({ reset: true, keepPage: true })"
    />
    <ShareFolderDialog
      :visible.sync="folderShareVisible"
      :folder="activeFolder"
      @changed="() => load({ reset: true, keepPage: true })"
    />
    <HistoryPanel
      :visible.sync="historyVisible"
      :room="activeRoom"
      @restored="() => load({ reset: true, keepPage: true })"
    />
  </section>
</template>

<script>
import { userMessageFromError } from '@/services/apiError'
import roomService from '@/services/roomService'
import folderService from '@/services/folderService'
import teamService from '@/services/teamService'
import EmptyState from './components/EmptyState.vue'
import FileToolbar from './components/FileToolbar.vue'
import FolderBreadcrumb from './components/FolderBreadcrumb.vue'
import FolderCard from './components/FolderCard.vue'
import HistoryPanel from './components/HistoryPanel.vue'
import MoveToFolderDialog from './components/MoveToFolderDialog.vue'
import MoveToTeamDialog from './components/MoveToTeamDialog.vue'
import RenameDialog from './components/RenameDialog.vue'
import RoomCard from './components/RoomCard.vue'
import RoomList from './components/RoomList.vue'
import ShareRoomDialog from './components/ShareRoomDialog.vue'
import ShareFolderDialog from './components/ShareFolderDialog.vue'
const copy = {
  files: ['我的脑图', '管理你的文件夹与脑图'],
  recent: ['最近', '快速回到最近打开的脑图'],
  favorites: ['收藏', '集中查看重要脑图'],
  shared: ['与我共享', '根据成员角色展示与你共享的脑图'],
  trash: ['回收站', '已删除内容将在这里暂存'],
  folder: ['文件夹', '查看文件夹中的脑图']
}
const savedView = () => {
  try {
    return localStorage.getItem('product-shell-view') === 'list'
      ? 'list'
      : 'card'
  } catch (error) {
    return 'card'
  }
}
const PAGE_SIZES = [10, 20, 50, 100]
const PAGE_SIZE_KEY = 'product-shell-page-size'
const savedPageSize = () => {
  try {
    const value = Number(localStorage.getItem(PAGE_SIZE_KEY))
    return PAGE_SIZES.includes(value) ? value : 20
  } catch (error) {
    return 20
  }
}
export default {
  name: 'FilesPage',
  components: {
    EmptyState,
    FileToolbar,
    FolderBreadcrumb,
    FolderCard,
    HistoryPanel,
    MoveToFolderDialog,
    MoveToTeamDialog,
    RenameDialog,
    RoomCard,
    RoomList,
    ShareRoomDialog,
    ShareFolderDialog
  },
  props: { mode: { type: String, default: 'files' } },
  data() {
    return {
      loading: false,
      busy: false,
      requestId: 0,
      error: '',
      rooms: [],
      folders: [],
      search: '',
      roleFilter: '',
      sort: 'updatedAt',
      view: savedView(),
      activeRoom: null,
      activeItem: null,
      renameKind: 'room',
      renameVisible: false,
      moveVisible: false,
      moveToTeamVisible: false,
      shareVisible: false,
      folderShareVisible: false,
      activeFolder: null,
      historyVisible: false,
      pageSizes: PAGE_SIZES,
      limit: savedPageSize(),
      page: 1,
      total: 0,
      searchTimer: null,
      teams: [],
      teamsLoading: false
    }
  },
  computed: {
    selectedTeamId() {
      return this.mode === 'files'
        ? String((this.$route.query && this.$route.query.team) || '')
        : ''
    },
    selectedTeam() {
      return this.teams.find(team => team.id === this.selectedTeamId) || null
    },
    isTeamView() {
      return !!this.selectedTeamId && this.mode === 'files'
    },
    isRealFilesMode() {
      return (
        !this.isTeamView &&
        (this.mode === 'files' ||
          this.mode === 'folder' ||
          this.mode === 'shared')
      )
    },
    showPager() {
      // 无数据时不展示分页/加载更多；有数据时提供页码与每页数量调节。
      return this.isRealFilesMode && !this.loading && Number(this.total || 0) > 0
    },
    folder() {
      return this.mode === 'folder'
        ? this.folders.find(item => item.id === this.$route.params.id)
        : null
    },
    pageTitle() {
      if (this.isTeamView) {
        return this.selectedTeam ? this.selectedTeam.name : '团队脑图'
      }
      return this.folder ? this.folder.name : copy[this.mode][0]
    },
    pageDescription() {
      if (this.isTeamView) {
        return this.selectedTeam
          ? `团队空间 · ${this.visibleRooms.length} 个脑图`
          : '正在读取团队脑图'
      }
      return this.folder
        ? this.displayCount + ' 个项目'
        : copy[this.mode][1]
    },
    itemCount() {
      return this.visibleRooms.length + this.filteredFolders.length
    },
    displayCount() {
      if (this.isRealFilesMode && Number(this.total || 0) > 0) {
        return Number(this.total)
      }
      return this.itemCount
    },
    showFolders() {
      return this.mode === 'files' && !this.isTeamView
    },
    folderMap() {
      return Object.fromEntries(this.folders.map(folder => [folder.id, folder]))
    },
    filteredFolders() {
      const q = this.search.trim().toLowerCase()
      return this.showFolders && !this.roleFilter
        ? this.folders.filter(
            folder => !q || folder.name.toLowerCase().includes(q)
          )
        : []
    },
    visibleRooms() {
      const q = this.search.trim().toLowerCase()
      const rooms = this.rooms.filter(room => {
        if (this.roleFilter && room.role !== String(this.roleFilter).toLowerCase()) {
          return false
        }
        if (this.isRealFilesMode) return true
        if (!q) return true
        return [room.title, room.owner && room.owner.name, room.folderName].some(
          value =>
            String(value || '')
              .toLowerCase()
              .includes(q)
        )
      })
      if (!this.isTeamView) return rooms
      const direction = this.sort === 'title' ? 1 : -1
      return rooms.slice().sort((left, right) => {
        if (this.sort === 'title') {
          return String(left.title || '').localeCompare(
            String(right.title || ''),
            'zh-CN'
          )
        }
        return direction *
          (new Date(left.updatedAt || 0).getTime() -
            new Date(right.updatedAt || 0).getTime())
      })
    },
    emptyTitle() {
      if (this.search || this.roleFilter) return '没有搜索结果'
      return (
        {
          favorites: '没有收藏',
          shared: '暂无共享脑图',
          trash: '回收站为空',
          folder: '这个文件夹暂无内容'
        }[this.mode] || (this.isTeamView ? '团队暂无脑图' : '还没有脑图')
      )
    },
    emptyDescription() {
      return (
        {
          favorites: '点击脑图上的星标即可收藏',
          shared: '收到的共享脑图会显示在这里',
          trash: '删除的脑图会暂存在这里',
          folder: '移动或新建脑图到这个文件夹'
        }[this.mode] ||
        (this.isTeamView
          ? '在当前团队中创建第一张脑图'
          : '创建第一张脑图开始工作')
      )
    }
  },
  watch: {
    '$route.fullPath': 'resetPage',
    search() {
      if (!this.isRealFilesMode) return
      clearTimeout(this.searchTimer)
      this.searchTimer = setTimeout(() => {
        this.page = 1
        this.load({ reset: true, keepPage: true })
      }, 300)
    },
    sort() {
      if (!this.isRealFilesMode) return
      this.page = 1
      this.load({ reset: true, keepPage: true })
    },
    view(value) {
      try {
        localStorage.setItem('product-shell-view', value)
      } catch (error) {
        /* preference is optional */
      }
    }
  },
  created() {
    this.resetPage()
  },
  beforeDestroy() {
    this.requestId++
  },
  methods: {
    resetPage() {
      this.search = ''
      this.roleFilter = ''
      this.sort = this.mode === 'recent' ? 'lastOpenedAt' : 'updatedAt'
      this.page = 1
      this.load({ reset: true, keepPage: true })
    },
    changeWorkspace(teamId) {
      const team = String(teamId || '')
      this.$router.push({
        path: '/files',
        query: team ? { team } : {}
      })
    },
    async load(options = {}) {
      const reset = options.reset !== false
      const request = ++this.requestId
      const mode = this.mode
      const folderId = this.$route.params.id
      if (reset && !options.keepPage) {
        this.page = 1
      }
      this.loading = reset
      this.error = ''
      try {
        if (mode === 'files') {
          this.teamsLoading = true
          try {
            this.teams = await teamService.listSpaces()
          } catch (error) {
            this.teams = []
            // 团队接口异常不能阻断个人文件；但用户正在访问某个团队时需要明确报错。
            if (this.selectedTeamId) throw error
          } finally {
            this.teamsLoading = false
          }
          if (
            this.selectedTeamId &&
            !this.teams.some(team => team.id === this.selectedTeamId)
          ) {
            throw new Error('团队不存在、已删除或你已无权访问')
          }
        }
        const folders = this.isTeamView
          ? []
          : await folderService.listFolders()
        if (request !== this.requestId) return
        this.folders = folders
        if (
          mode === 'folder' &&
          !this.folders.some(folder => folder.id === folderId)
        )
          throw new Error('文件夹不存在或已删除')
        const filters = {
          favorite: mode === 'favorites',
          shared: mode === 'shared',
          trash: mode === 'trash',
          recent: mode === 'recent',
          foldersById: this.folderMap
        }
        if (mode === 'folder') {
          filters.folderId = folderId
        } else if (mode === 'files' && !this.search.trim()) {
          // Root of 我的脑图: only rooms not in a folder (folder contents stay inside).
          filters.folderId = null
        }
        if (this.isRealFilesMode) {
          filters.q = this.search.trim()
          filters.sort = this.sort === 'lastOpenedAt' ? 'updatedAt' : this.sort
          filters.order = this.sort === 'title' ? 'asc' : 'desc'
          filters.limit = this.limit
          filters.offset = Math.max(0, (this.page - 1) * this.limit)
        }
        const rooms = this.isTeamView
          ? await teamService.listRooms(this.selectedTeamId)
          : await roomService.listRooms(filters)
        if (request !== this.requestId) return
        const list = rooms.list || rooms
        const total = Number(rooms.total != null ? rooms.total : list.length)
        this.total = total
        // 删到最后一页为空时，自动回到有效页。
        const maxPage = Math.max(1, Math.ceil(total / this.limit) || 1)
        if (this.isRealFilesMode && total > 0 && this.page > maxPage) {
          this.page = maxPage
          await this.load({ reset: true, keepPage: true })
          return
        }
        this.rooms = list
      } catch (error) {
        if (request === this.requestId)
          this.error = userMessageFromError(error)
      } finally {
        if (request === this.requestId) this.loading = false
      }
    },
    onPageChange(page) {
      this.page = Math.max(1, Number(page) || 1)
      this.load({ reset: true, keepPage: true })
    },
    onPageSizeChange(size) {
      const next = PAGE_SIZES.includes(Number(size)) ? Number(size) : 20
      this.limit = next
      this.page = 1
      try {
        localStorage.setItem(PAGE_SIZE_KEY, String(next))
      } catch (error) {
        /* preference is optional */
      }
      this.load({ reset: true, keepPage: true })
    },
    async perform(action, message) {
      if (this.busy) return
      this.busy = true
      try {
        await action()
        if (message) this.$message.success(message)
        await this.load({ reset: true, keepPage: true })
      } catch (error) {
        this.$message.error(userMessageFromError(error))
      } finally {
        this.busy = false
      }
    },
    openFolder(folder) {
      this.$router.push('/files/folder/' + folder.id)
    },
    async openRoom(room) {
      try {
        const roomKey = room.roomKey || room.id
        await roomService.markOpened(roomKey)
        await this.$router.push({
          path: '/',
          query: { room: roomKey }
        })
      } catch (error) {
        this.$message.error(userMessageFromError(error))
      }
    },
    async createRoom() {
      const result = await this.$prompt('请输入脑图名称', '新建脑图', {
        inputValue: '未命名脑图',
        inputValidator: value =>
          (!!value && !!value.trim() && value.length <= 60) ||
          '请输入 1 至 60 个字符'
      }).catch(() => null)
      if (!result) return
      if (this.busy) return
      this.busy = true
      try {
        const created = this.isTeamView
          ? await teamService.createRoom(
              this.selectedTeamId,
              result.value.trim()
            )
          : await roomService.createRoom(
              result.value.trim(),
              this.folder ? this.folder.id : null
            )
        this.$message.success('脑图已创建')
        await this.$router.push({
          path: '/',
          query: { room: created.roomKey }
        })
      } catch (error) {
        this.$message.error(userMessageFromError(error))
      } finally {
        this.busy = false
      }
    },
    async createFolder() {
      const result = await this.$prompt(
        '当前仅支持一级文件夹，创建于根目录',
        '新建文件夹',
        {
          inputValidator: value =>
            (!!value && !!value.trim() && value.length <= 60) ||
            '请输入 1 至 60 个字符'
        }
      ).catch(() => null)
      if (result)
        await this.perform(
          () => folderService.createFolder(result.value.trim()),
          '文件夹已创建'
        )
    },
    renameRoom(room) {
      this.activeItem = room
      this.renameKind = 'room'
      this.renameVisible = true
    },
    renameFolder(folder) {
      this.activeItem = folder
      this.renameKind = 'folder'
      this.renameVisible = true
    },
    confirmRename(name) {
      return this.perform(
        () =>
          this.renameKind === 'folder'
            ? folderService.renameFolder(this.activeItem.id, name)
            : roomService.renameRoom(
                this.activeItem.roomKey || this.activeItem.id,
                name
              ),
        '重命名成功'
      )
    },
    async deleteFolder(folder) {
      const confirmed = await this.$confirm(
        '删除文件夹「' +
          folder.name +
          '」？若其中还有脑图，需要先把脑图移出后再删除。',
        '删除文件夹'
      )
        .then(() => true)
        .catch(() => false)
      if (confirmed)
        await this.perform(
          () => folderService.deleteFolder(folder.id),
          '文件夹已删除'
        )
    },
    moveRoom(room) {
      this.activeRoom = room
      this.moveVisible = true
    },
    confirmMove(folderId) {
      return this.perform(
        () =>
          roomService.moveRoom(
            this.activeRoom.roomKey || this.activeRoom.id,
            folderId
          ),
        '移动成功'
      )
    },
    moveToTeam(room) {
      this.activeRoom = room
      this.moveToTeamVisible = true
    },
    confirmMoveToTeam(teamId) {
      return this.perform(
        () =>
          teamService.assignRoom(
            teamId,
            this.activeRoom.roomKey || this.activeRoom.id
          ),
        '已移入团队空间'
      )
    },
    shareRoom(room) {
      this.activeRoom = room
      this.shareVisible = true
    },
    shareFolder(folder) {
      this.activeFolder = folder
      this.folderShareVisible = true
    },
    historyRoom(room) {
      this.activeRoom = room
      this.historyVisible = true
    },
    favorite(room) {
      return this.perform(
        () => roomService.toggleFavorite(room.roomKey || room.id),
        room.favorite ? '已取消收藏' : '已收藏'
      )
    },
    deleteRoom(room) {
      return this.perform(
        () => roomService.deleteRoom(room.roomKey || room.id),
        '已移入回收站'
      )
    },
    restore(room) {
      return this.perform(
        () => roomService.restoreRoom(room.roomKey || room.id),
        '已恢复'
      )
    },
    async permanentDelete(room) {
      const confirmed = await this.$confirm(
        '永久删除「' + room.title + '」？此操作不可恢复。',
        '永久删除',
        { type: 'warning' }
      )
        .then(() => true)
        .catch(() => false)
      if (confirmed)
        await this.perform(
          () => roomService.permanentDelete(room.roomKey || room.id),
          '已永久删除'
        )
    },
    formatDate(value) {
      return new Date(value).toLocaleString('zh-CN')
    }
  }
}
</script>

<style lang="less" scoped>
.workspaceSwitcher {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
  color: var(--ui-text-secondary);
  font-size: 13px;

  .el-select {
    width: 260px;
    max-width: 38vw;
  }
}
.contentArea {
  min-height: 320px;
}
.itemGrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px;
}
.sectionTitle span {
  color: #9aa7a2;
  font-weight: 400;
  margin-left: 4px;
}
.statePanel {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-top: 20px;
  .el-alert {
    flex: 1;
  }
}
.pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 20px;
  padding-top: 4px;
}
.trashList {
  background: white;
  border: 1px solid #e3e9e6;
  border-radius: 12px;
  overflow: hidden;
}
.trashRow {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 16px;
  border-bottom: 1px solid #eef1ef;
  &:last-child {
    border-bottom: 0;
  }
  .trashIcon {
    width: 38px;
    height: 38px;
    border-radius: 9px;
    background: #f1f5f3;
    display: grid;
    place-items: center;
    color: #7b8c85;
  }
  div:nth-child(2) {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  span {
    color: #8a9893;
    font-size: 12px;
  }
}

@media (max-width: 760px) {
  .workspaceSwitcher {
    width: 100%;
    justify-content: flex-start;

    .el-select {
      width: 240px;
      max-width: 70vw;
    }
  }
}
</style>
