<template>
  <section class="productPage">
    <div v-if="folder" class="productHeader productHeader--breadcrumb">
      <FolderBreadcrumb
        :path="folderPath"
        :team-id="selectedTeamId"
        :base-path="filesBasePath"
        :root-label="isTeamView && selectedTeam ? selectedTeam.name : '脑图'"
      />
    </div>
    <FileToolbar
      :search.sync="search"
      :role-filter.sync="roleFilter"
      :sort.sync="sort"
      :view.sync="view"
      :show-create="mode === 'files' || mode === 'folder'"
      :show-create-folder="
        (mode === 'files' || mode === 'folder') &&
          (!isTeamView || canManageTeam)
      "
      :show-import="mode === 'files' || mode === 'folder'"
      :show-batch="supportsBatchSelect"
      :select-mode="selectMode"
      :hide-opened-sort="isRealFilesMode"
      @create-room="createRoom"
      @create-folder="createFolder"
      @import="openImport"
      @toggle-select-mode="toggleSelectMode"
    />
    <BatchActionBar
      v-if="selectMode"
      :count="batchSelectionCount"
      :all-selected="batchAllSelected"
      :indeterminate="batchIndeterminate"
      :show-move="batchShowMove"
      :show-move-to-team="batchShowMoveToTeam"
      :show-favorite="batchShowFavorite"
      :show-delete="batchShowDelete"
      :can-move="eligibleMoveRooms.length > 0"
      :can-move-to-team="eligibleMoveToTeamRooms.length > 0"
      :can-favorite="eligibleFavoriteRooms.length > 0"
      :can-delete="eligibleDeleteRooms.length + eligibleDeleteFolders.length > 0"
      :favorite-label="batchFavoriteLabel"
      @select-all="selectAllVisible"
      @clear="clearSelection"
      @exit="exitSelectMode"
      @move="openBatchMove"
      @move-to-team="openBatchMoveToTeam"
      @favorite="batchFavorite"
      @delete="batchDelete"
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
      <div v-if="mode !== 'trash' && view === 'card' && itemCount" class="itemGrid">
        <template v-if="showFolders">
          <FolderCard
            v-for="item in filteredFolders"
            :key="item.id"
            :folder="item"
            :editable="!selectMode && (isTeamView ? canManageTeam : item.canManage !== false)"
            :allow-share="!isTeamView"
            :allow-move-to-team="!isTeamView"
            :selectable="selectMode"
            :selected="isFolderSelected(item)"
            :can-select="canSelectFolder(item)"
            @open="openFolder"
            @rename="renameFolder"
            @share="shareFolder"
            @move-to-team="moveFolderToTeam"
            @delete="deleteFolder"
            @toggle-select="toggleFolderSelect"
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
          :selectable="selectMode"
          :selected="isRoomSelected(room)"
          :can-select="canSelectRoom(room)"
          @open="openRoom"
          @favorite="favorite"
          @rename="renameRoom"
          @move="moveRoom"
          @move-to-team="moveToTeam"
          @share="shareRoom"
          @history="historyRoom"
          @delete="deleteRoom"
          @toggle-select="toggleRoomSelect"
        />
      </div>
      <RoomList
        v-if="mode !== 'trash' && view === 'list' && itemCount"
        ref="roomList"
        :rooms="visibleRooms"
        :folders="showFolders ? filteredFolders : []"
        :allow-delete="true"
        :allow-share="!isTeamView"
        :allow-move-to-team="!isTeamView"
        :select-mode="selectMode"
        :selected-room-keys="selectedRoomKeys"
        :selected-folder-ids="selectedFolderIds"
        :can-select-folder="canSelectFolder"
        :can-select-room="canSelectRoom"
        @open="openRoom"
        @open-folder="openFolder"
        @share-folder="shareFolder"
        @rename-folder="renameFolder"
        @move-folder-to-team="moveFolderToTeam"
        @delete-folder="deleteFolder"
        @favorite="favorite"
        @rename="renameRoom"
        @move="moveRoom"
        @move-to-team="moveToTeam"
        @share="shareRoom"
        @history="historyRoom"
        @delete="deleteRoom"
        @selection-change="onListSelectionChange"
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
      :batch-count="batchAction === 'move' ? eligibleMoveRooms.length : 0"
      @confirm="confirmMove"
    />
    <MoveToTeamDialog
      :visible.sync="moveToTeamVisible"
      :room="activeRoom"
      :batch-count="batchAction === 'moveToTeam' ? eligibleMoveToTeamRooms.length : 0"
      :is-folder="!batchAction && !!activeFolder"
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
    <HomeImportDialog
      :visible.sync="importVisible"
      :folder-id="folder ? folder.id : null"
      :team-id="selectedTeamId || null"
      @imported="onImported"
    />
  </section>
</template>

<script>
import { userMessageFromError } from '@/services/apiError'
import { isNavigationFailure, NavigationFailureType } from 'vue-router'
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
import HomeImportDialog from './components/HomeImportDialog.vue'
import BatchActionBar from './components/BatchActionBar.vue'
const copy = {
  files: ['脑图', '管理你的文件夹与脑图'],
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
    ShareFolderDialog,
    HomeImportDialog,
    BatchActionBar
  },
  props: { mode: { type: String, default: 'files' } },
  data() {
    return {
      loading: false,
      busy: false,
      openingRoom: false,
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
      importVisible: false,
      pageSizes: PAGE_SIZES,
      limit: savedPageSize(),
      page: 1,
      total: 0,
      searchTimer: null,
      teams: [],
      teamsLoading: false,
      selectMode: false,
      selectedRoomKeys: [],
      selectedFolderIds: [],
      batchAction: null
    }
  },
  computed: {
    supportsBatchSelect() {
      return this.mode === 'files' || this.mode === 'folder'
    },
    batchSelectionCount() {
      return this.selectedRoomKeys.length + this.selectedFolderIds.length
    },
    selectedRoomsList() {
      const keys = new Set(this.selectedRoomKeys.map(String))
      return this.visibleRooms.filter(room =>
        keys.has(String(room.roomKey || room.id))
      )
    },
    selectedFoldersList() {
      const ids = new Set(this.selectedFolderIds.map(String))
      return this.filteredFolders.filter(folder => ids.has(String(folder.id)))
    },
    batchHasOnlyRooms() {
      return (
        this.selectedRoomKeys.length > 0 && this.selectedFolderIds.length === 0
      )
    },
    batchHasOnlyFolders() {
      return (
        this.selectedFolderIds.length > 0 && this.selectedRoomKeys.length === 0
      )
    },
    batchHasMixed() {
      return this.selectedRoomKeys.length > 0 && this.selectedFolderIds.length > 0
    },
    eligibleMoveRooms() {
      return this.selectedRoomsList.filter(room => room.canEdit !== false)
    },
    eligibleDeleteRooms() {
      return this.selectedRoomsList.filter(room => room.canManage)
    },
    eligibleMoveToTeamRooms() {
      if (this.isTeamView) return []
      return this.selectedRoomsList.filter(room => room.canManage)
    },
    eligibleDeleteFolders() {
      return this.selectedFoldersList.filter(folder =>
        this.canSelectFolder(folder)
      )
    },
    eligibleFavoriteRooms() {
      return this.selectedRoomsList
    },
    batchShowMove() {
      return this.batchHasOnlyRooms
    },
    batchShowMoveToTeam() {
      return this.batchHasOnlyRooms && !this.isTeamView
    },
    batchShowFavorite() {
      return this.batchHasOnlyRooms
    },
    batchShowDelete() {
      return this.batchSelectionCount > 0
    },
    batchFavoriteLabel() {
      const rooms = this.selectedRoomsList
      if (!rooms.length) return '收藏'
      const favoriteCount = rooms.filter(room => room.favorite).length
      return favoriteCount > rooms.length / 2 ? '取消收藏' : '收藏'
    },
    selectableVisibleCount() {
      let count = this.visibleRooms.filter(room => this.canSelectRoom(room)).length
      if (this.showFolders) {
        count += this.filteredFolders.filter(folder =>
          this.canSelectFolder(folder)
        ).length
      }
      return count
    },
    batchAllSelected() {
      return (
        this.selectableVisibleCount > 0 &&
        this.batchSelectionCount === this.selectableVisibleCount
      )
    },
    batchIndeterminate() {
      return (
        this.batchSelectionCount > 0 &&
        this.batchSelectionCount < this.selectableVisibleCount
      )
    },
    selectedTeamId() {
      return this.mode === 'files' || this.mode === 'folder'
        ? String((this.$route.query && this.$route.query.team) || '')
        : ''
    },
    selectedTeam() {
      return this.teams.find(team => team.id === this.selectedTeamId) || null
    },
    isTeamView() {
      return (
        !!this.selectedTeamId &&
        (this.mode === 'files' || this.mode === 'folder')
      )
    },
    filesBasePath() {
      return this.$route.path.startsWith('/my-maps') ? '/my-maps' : '/files'
    },
    canManageTeam() {
      return !!(
        this.selectedTeam &&
        ['owner', 'admin'].includes(this.selectedTeam.role)
      )
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
        return Number(this.total) + this.filteredFolders.length
      }
      return this.itemCount
    },
    showFolders() {
      return this.mode === 'files' || this.mode === 'folder'
    },
    folderMap() {
      return Object.fromEntries(this.folders.map(folder => [folder.id, folder]))
    },
    folderPath() {
      const path = []
      const visited = new Set()
      let current = this.folder
      while (current && !visited.has(current.id)) {
        path.unshift(current)
        visited.add(current.id)
        current = current.parentId ? this.folderMap[current.parentId] : null
      }
      return path
    },
    currentParentId() {
      return this.folder ? this.folder.id : null
    },
    childFolders() {
      return this.folders
        .filter(folder => (folder.parentId || null) === this.currentParentId)
        .map(folder => ({
          ...folder,
          itemCount:
            Number(folder.roomCount || 0) +
            this.folders.filter(child => child.parentId === folder.id).length
        }))
    },
    filteredFolders() {
      const q = this.search.trim().toLowerCase()
      return this.showFolders && !this.roleFilter
        ? this.childFolders.filter(
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
      this.clearSelection()
      this.selectMode = false
      this.search = ''
      this.roleFilter = ''
      this.sort = this.mode === 'recent' ? 'lastOpenedAt' : 'updatedAt'
      this.page = 1
      this.load({ reset: true, keepPage: true })
    },
    roomKey(room) {
      return String((room && (room.roomKey || room.id)) || '')
    },
    canSelectRoom() {
      return true
    },
    canSelectFolder(folder) {
      return this.isTeamView
        ? this.canManageTeam
        : folder.canManage !== false
    },
    isRoomSelected(room) {
      return this.selectedRoomKeys.includes(this.roomKey(room))
    },
    isFolderSelected(folder) {
      return this.selectedFolderIds.includes(String(folder.id))
    },
    toggleSelectMode() {
      if (this.selectMode) {
        this.exitSelectMode()
        return
      }
      this.selectMode = true
    },
    exitSelectMode() {
      this.selectMode = false
      this.clearSelection()
      this.batchAction = null
    },
    clearSelection() {
      this.selectedRoomKeys = []
      this.selectedFolderIds = []
      this.batchAction = null
    },
    toggleRoomSelect(room) {
      const key = this.roomKey(room)
      if (!key || !this.canSelectRoom(room)) return
      if (this.isRoomSelected(room)) {
        this.selectedRoomKeys = this.selectedRoomKeys.filter(item => item !== key)
      } else {
        this.selectedRoomKeys = this.selectedRoomKeys.concat(key)
      }
    },
    toggleFolderSelect(folder) {
      const id = String(folder.id)
      if (!this.canSelectFolder(folder)) return
      if (this.isFolderSelected(folder)) {
        this.selectedFolderIds = this.selectedFolderIds.filter(item => item !== id)
      } else {
        this.selectedFolderIds = this.selectedFolderIds.concat(id)
      }
    },
    onListSelectionChange({ roomKeys, folderIds }) {
      this.selectedRoomKeys = roomKeys.map(String)
      this.selectedFolderIds = folderIds.map(String)
    },
    selectAllVisible(checked) {
      if (!checked) {
        this.clearSelection()
        return
      }
      this.selectedRoomKeys = this.visibleRooms
        .filter(room => this.canSelectRoom(room))
        .map(room => this.roomKey(room))
      this.selectedFolderIds = this.showFolders
        ? this.filteredFolders
            .filter(folder => this.canSelectFolder(folder))
            .map(folder => String(folder.id))
        : []
    },
    async runBatchSerial(items, action) {
      let ok = 0
      let fail = 0
      for (const item of items) {
        try {
          await action(item)
          ok += 1
        } catch (error) {
          fail += 1
        }
      }
      return { ok, fail }
    },
    summarizeBatchResult(ok, fail, verb) {
      if (fail) {
        this.$message.warning(`${verb} ${ok} 项，${fail} 项失败`)
      } else {
        this.$message.success(`${verb} ${ok} 项`)
      }
    },
    openBatchMove() {
      if (!this.eligibleMoveRooms.length) {
        this.$message.warning('所选脑图均无法移动')
        return
      }
      this.batchAction = 'move'
      this.activeRoom = {
        title: `已选 ${this.eligibleMoveRooms.length} 个脑图`,
        folderName: '—'
      }
      this.moveVisible = true
    },
    openBatchMoveToTeam() {
      if (!this.eligibleMoveToTeamRooms.length) {
        this.$message.warning('所选脑图均无法移入团队（需为所有者）')
        return
      }
      this.batchAction = 'moveToTeam'
      this.activeRoom = {
        title: `已选 ${this.eligibleMoveToTeamRooms.length} 个脑图`
      }
      this.moveToTeamVisible = true
    },
    async batchFavorite() {
      const rooms = this.eligibleFavoriteRooms
      if (!rooms.length) return
      const unfavorite = this.batchFavoriteLabel === '取消收藏'
      if (this.busy) return
      this.busy = true
      try {
        const { ok, fail } = await this.runBatchSerial(rooms, room => {
          const key = this.roomKey(room)
          const shouldToggle =
            unfavorite ? room.favorite : !room.favorite
          return shouldToggle
            ? roomService.toggleFavorite(key)
            : Promise.resolve()
        })
        this.clearSelection()
        await this.load({ reset: true, keepPage: true })
        this.summarizeBatchResult(ok, fail, '已完成收藏')
      } catch (error) {
        this.$message.error(userMessageFromError(error))
      } finally {
        this.busy = false
      }
    },
    async batchDelete() {
      const rooms = this.eligibleDeleteRooms
      const folders = this.eligibleDeleteFolders
      const total = rooms.length + folders.length
      if (!total) {
        this.$message.warning('所选项目均无法删除')
        return
      }
      const confirmed = await this.$confirm(
        `删除 ${total} 个项目？脑图将移入回收站，空文件夹才会被删除。`,
        '批量删除',
        { type: 'warning' }
      )
        .then(() => true)
        .catch(() => false)
      if (!confirmed) return
      if (this.busy) return
      this.busy = true
      try {
        let ok = 0
        let fail = 0
        for (const room of rooms) {
          try {
            await roomService.deleteRoom(this.roomKey(room))
            ok += 1
          } catch (error) {
            fail += 1
          }
        }
        for (const folder of folders) {
          try {
            if (this.isTeamView) {
              await teamService.deleteFolder(this.selectedTeamId, folder.id)
            } else {
              await folderService.deleteFolder(folder.id)
            }
            ok += 1
          } catch (error) {
            fail += 1
          }
        }
        this.clearSelection()
        await this.load({ reset: true, keepPage: true })
        this.summarizeBatchResult(ok, fail, '已删除')
      } catch (error) {
        this.$message.error(userMessageFromError(error))
      } finally {
        this.busy = false
      }
    },
    changeWorkspace(teamId) {
      this.exitSelectMode()
      const team = String(teamId || '')
      this.$router.push({
        path: this.filesBasePath,
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
        if (mode === 'files' || (mode === 'folder' && this.selectedTeamId)) {
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
          ? await teamService.listFolders(this.selectedTeamId)
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
        let rooms = this.isTeamView
          ? await teamService.listRooms(this.selectedTeamId)
          : await roomService.listRooms(filters)
        if (request !== this.requestId) return
        if (this.isTeamView) {
          const list = rooms.list || rooms
          const q = this.search.trim().toLowerCase()
          rooms = list.filter(room => {
            if (mode === 'folder') {
              if (String(room.folderId || '') !== String(folderId || '')) {
                return false
              }
            } else if (!q && room.folderId) {
              return false
            }
            return true
          })
        }
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
        this.rooms = list.map(room => {
          if (!this.isTeamView || room.folderName) return room
          const folder = room.folderId ? this.folderMap[room.folderId] : null
          return {
            ...room,
            folderName: folder ? folder.name : room.folderId ? '' : '根目录'
          }
        })
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
      const route = { path: `${this.filesBasePath}/folder/` + folder.id }
      if (this.selectedTeamId) {
        route.query = { team: this.selectedTeamId }
      }
      this.$router.push(route)
    },
    async openRoom(room) {
      if (this.openingRoom) return
      this.openingRoom = true
      const sourceRoute = this.$route
      try {
        const roomKey = room.roomKey || room.id
        await roomService.markOpened(roomKey)
        // A slow recent-open request must not undo the user's later navigation.
        if (this._isDestroyed || this.$route !== sourceRoute) return
        await this.$router.push({
          path: '/',
          query: { room: roomKey }
        })
      } catch (error) {
        if (
          isNavigationFailure(error, NavigationFailureType.cancelled) ||
          isNavigationFailure(error, NavigationFailureType.duplicated)
        ) return
        this.$message.error(userMessageFromError(error))
      } finally {
        this.openingRoom = false
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
        const folderId = this.folder ? this.folder.id : null
        const created = this.isTeamView
          ? await teamService.createRoom(
              this.selectedTeamId,
              result.value.trim(),
              folderId
            )
          : await roomService.createRoom(result.value.trim(), folderId)
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
      if (this.isTeamView && !this.canManageTeam) {
        this.$message.error('只有团队所有者或管理员可以创建文件夹')
        return
      }
      const result = await this.$prompt(
        this.folder
          ? `将在「${this.folder.name}」中创建子文件夹`
          : this.isTeamView
            ? '将在当前团队根目录创建文件夹'
            : '将在“脑图”根目录创建文件夹',
        '新建文件夹',
        {
          inputValidator: value =>
            (!!value && !!value.trim() && value.length <= 60) ||
            '请输入 1 至 60 个字符'
        }
      ).catch(() => null)
      if (result)
        await this.perform(
          () =>
            this.isTeamView
              ? teamService.createFolder(
                  this.selectedTeamId,
                  result.value.trim(),
                  this.folder ? this.folder.id : null
                )
              : folderService.createFolder(
                  result.value.trim(),
                  this.folder ? this.folder.id : null
                ),
          '文件夹已创建'
        )
    },
    openImport() {
      this.importVisible = true
    },
    async onImported(result) {
      await this.load({ reset: true, keepPage: true })
      if (result && result.mode === 'folder' && result.folderId) {
        const route = { path: `${this.filesBasePath}/folder/` + result.folderId }
        if (this.selectedTeamId) route.query = { team: this.selectedTeamId }
        this.$router.push(route)
        return
      }
      if (result && result.mode === 'single' && result.room) {
        const roomKey = result.room.roomKey || result.room.id
        if (roomKey) {
          await this.$router.push({ path: '/', query: { room: roomKey } })
        }
      }
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
            ? this.isTeamView
              ? teamService.renameFolder(
                  this.selectedTeamId,
                  this.activeItem.id,
                  name
                )
              : folderService.renameFolder(this.activeItem.id, name)
            : roomService.renameRoom(
                this.activeItem.roomKey || this.activeItem.id,
                name
              ),
        '重命名成功'
      )
    },
    async deleteFolder(folder) {
      if (this.isTeamView && !this.canManageTeam) {
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
      if (confirmed)
        await this.perform(
          () =>
            this.isTeamView
              ? teamService.deleteFolder(this.selectedTeamId, folder.id)
              : folderService.deleteFolder(folder.id),
          '文件夹已删除'
        )
    },
    moveRoom(room) {
      this.batchAction = null
      this.activeRoom = room
      this.moveVisible = true
    },
    async confirmMove(folderId) {
      if (this.batchAction === 'move') {
        const rooms = this.eligibleMoveRooms
        if (!rooms.length) return
        if (this.busy) return
        this.busy = true
        try {
          const { ok, fail } = await this.runBatchSerial(rooms, room =>
            roomService.moveRoom(this.roomKey(room), folderId)
          )
          this.batchAction = null
          this.clearSelection()
          await this.load({ reset: true, keepPage: true })
          this.summarizeBatchResult(ok, fail, '已移动')
        } catch (error) {
          this.$message.error(userMessageFromError(error))
        } finally {
          this.busy = false
        }
        return
      }
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
      this.batchAction = null
      this.activeFolder = null
      this.activeRoom = room
      this.moveToTeamVisible = true
    },
    moveFolderToTeam(folder) {
      this.batchAction = null
      this.activeFolder = folder
      this.activeRoom = { title: folder.name }
      this.moveToTeamVisible = true
    },
    async confirmMoveToTeam(teamId) {
      if (!this.batchAction && this.activeFolder) {
        const folder = this.activeFolder
        return this.perform(() => teamService.assignFolder(teamId, folder.id), '文件夹及内容已移入团队空间')
      }
      if (this.batchAction === 'moveToTeam') {
        const rooms = this.eligibleMoveToTeamRooms
        if (!rooms.length || !teamId) return
        if (this.busy) return
        this.busy = true
        try {
          const { ok, fail } = await this.runBatchSerial(rooms, room =>
            teamService.assignRoom(teamId, this.roomKey(room))
          )
          this.batchAction = null
          this.clearSelection()
          await this.load({ reset: true, keepPage: true })
          this.summarizeBatchResult(ok, fail, '已移入团队')
        } catch (error) {
          this.$message.error(userMessageFromError(error))
        } finally {
          this.busy = false
        }
        return
      }
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
      if (this.isTeamView) return
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
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
  max-width: 100%;
  color: var(--ui-text-secondary);
  font-size: 13px;

  .el-select {
    width: 200px;
    max-width: 100%;
  }

  .workspaceIconBtn {
    padding: 8px;
    margin: 0;
    font-size: 18px;
    color: var(--ui-text-secondary);
    &:hover {
      color: var(--ui-primary);
    }
  }
}
.contentArea {
  min-height: 320px;
}
.itemGrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px;
  width: 100%;
  max-width: 100%;
  min-width: 0;
}
@media (max-width: 560px) {
  .itemGrid {
    grid-template-columns: 1fr;
  }
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
