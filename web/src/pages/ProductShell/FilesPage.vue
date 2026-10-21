<template>
  <section class="productPage">
    <MobileFilesHeader
      v-if="useMobileFilesHeader"
      :mode="mode"
      :title="pageTitle"
      :search.sync="search"
      :kind="mobileKind"
      :folder-path="folderPath"
      :is-folder="mode === 'folder'"
      :is-team-view="isTeamView"
      :loading="loading"
      :root-label="mobileRootLabel"
      @update:kind="mobileKind = $event"
      @navigate-view="navigateMobileView"
      @navigate-folder="navigateMobileFolder"
      @navigate-root="navigateMobileRoot"
      @navigate-parent="navigateMobileParent"
    />
    <FileToolbar
      v-else
      :search.sync="search"
      :show-favorites="!isTeamView && ['files', 'folder', 'favorites'].includes(mode)"
      :favorites-active="mode === 'favorites'"
      :show-create="!isMobileViewport && (mode === 'files' || mode === 'folder')"
      :show-create-folder="
        !isMobileViewport && (mode === 'files' || mode === 'folder') &&
          (!isTeamView || canManageTeam)
      "
      :show-import="mode === 'files' || mode === 'folder'"
      @create-room="createRoom"
      @create-folder="createFolder"
      @import="openImport"
      @toggle-favorites="toggleFavorites"
    >
      <FolderBreadcrumb
        slot="title"
        :path="folder ? folderPath : mode === 'favorites' ? favoritesCrumb : []"
        :team-id="selectedTeamId"
        :base-path="filesBasePath"
        :root-label="isTeamView && selectedTeam ? selectedTeam.name : '脑图'"
      />
    </FileToolbar>
    <MobileCreateMenu :visible="mobileCreateOpen" :can-create-folder="!isTeamView || canManageTeam" @close="mobileCreateOpen = false" @select="selectMobileCreate" />
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
      /><el-button @click="load({ reset: true, keepPage: true })">重试</el-button>
    </div>
    <div v-else v-loading="loading || busy" class="contentArea">
      <div v-if="mode !== 'trash' && (view === 'card' || isMobileViewport) && itemCount" class="itemGrid">
        <template v-if="showFolders">
          <FolderCard
            v-for="item in filteredFolders"
            :key="item.id"
            :folder="item"
            :editable="!selectMode && (isTeamView ? canManageTeam : item.canManage !== false)"
            :allow-share="!isTeamView"
            :selectable="selectMode"
            :selected="isFolderSelected(item)"
            :can-select="canSelectFolder(item)"
            @open="openFolder"
            @rename-inline="renameFolderInline"
            @rename-request="renameFolderFromMenu"
            @share="shareFolder"
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
          :selectable="selectMode"
          :selected="isRoomSelected(room)"
          :can-select="canSelectRoom(room)"
          :highlighted="highlightRoomKey === String(room.roomKey || room.id)"
          @open="openRoom"
          @favorite="favorite"
          @duplicate="duplicateRoom"
          @rename-inline="renameRoomInline"
          @move="moveRoom"
          @rename="renameRoom"
          @share="shareRoom"
          @delete="deleteRoom"
          @toggle-select="toggleRoomSelect"
        />
      </div>
      <RoomList
        v-if="mode !== 'trash' && (view === 'list' && !isMobileViewport) && itemCount"
        ref="roomList"
        :rooms="visibleRooms"
        :folders="showFolders ? filteredFolders : []"
        :allow-delete="true"
        :allow-share="!isTeamView"
        :select-mode="selectMode"
        :selected-room-keys="selectedRoomKeys"
        :selected-folder-ids="selectedFolderIds"
        :highlight-room-key="highlightRoomKey"
        :can-select-folder="canSelectFolder"
        :can-select-room="canSelectRoom"
        @open="openRoom"
        @open-folder="openFolder"
        @share-folder="shareFolder"
        @rename-folder-inline="renameFolderInline"
        @delete-folder="deleteFolder"
        @favorite="favorite"
        @duplicate="duplicateRoom"
        @rename-inline="renameRoomInline"
        @move="moveRoom"
        @rename="renameRoom"
        @share="shareRoom"
        @delete="deleteRoom"
        @selection-change="onListSelectionChange"
      />
      <div v-if="showPager" class="pager">
        <el-pagination
          background
          layout="prev, next"
          :current-page="page"
          :page-size="limit"
          :total="total"
          :disabled="loading || busy"
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
      :value="activeItem ? activeItem.title || '' : ''"
      @confirm="renameRoomFromDialog"
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
    <HomeImportDialog
      :visible.sync="importVisible"
      :folder-id="folder ? folder.id : null"
      :team-id="selectedTeamId || null"
      @imported="onImported"
    />
    <DeleteFolderDialog
      :visible.sync="deleteFolderVisible"
      :folder="folderToDelete"
      :folders="folders"
      :team-id="selectedTeamId || ''"
      @deleted="onFolderDeleted"
    />
  </section>
</template>

<script>
import mobileViewport from '@/utils/mobileViewport'
import './creation-dialogs.less'
import MobileCreateMenu from './components/MobileCreateMenu.vue'
import { userMessageFromError } from '@/services/apiError'
import { isNavigationFailure, NavigationFailureType } from 'vue-router'
import roomService from '@/services/roomService'
import folderService from '@/services/folderService'
import teamService from '@/services/teamService'
import { getCurrentUser } from '@/utils/auth'
import { getFileExport, replaceFileTree } from '@/utils/fileApi'
import {
  captureListState,
  captureScrollPosition,
  clampListPage,
  createEditorLocation,
  isShellOnlyRouteChange,
  readReturnContext,
  restoreListState,
  restoreScrollPosition
} from '@/utils/fileNavigation'
import { armSkipMyMapsRedirect } from '@/utils/roomLocation'
import { resolveShellMode, withShell } from '@/utils/shellMode'
import EmptyState from './components/EmptyState.vue'
import FileToolbar from './components/FileToolbar.vue'
import MobileFilesHeader from './components/MobileFilesHeader.vue'
import FolderBreadcrumb from './components/FolderBreadcrumb.vue'
import FolderCard from './components/FolderCard.vue'
import DeleteFolderDialog from './components/DeleteFolderDialog.vue'
import MoveToFolderDialog from './components/MoveToFolderDialog.vue'
import RenameDialog from './components/RenameDialog.vue'
import MoveToTeamDialog from './components/MoveToTeamDialog.vue'
import RoomCard from './components/RoomCard.vue'
import RoomList from './components/RoomList.vue'
import ShareRoomDialog from './components/ShareRoomDialog.vue'
import ShareFolderDialog from './components/ShareFolderDialog.vue'
import HomeImportDialog from './components/HomeImportDialog.vue'
import BatchActionBar from './components/BatchActionBar.vue'
import {
  mobileFolderTarget,
  mobileParentTarget,
  mobileRootTarget,
  mobileViewTarget,
  shouldNavigateMobile
} from './components/mobileFilesNavigation'
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
  mixins: [mobileViewport],
  name: 'FilesPage',
  components: {
    MobileCreateMenu,
    EmptyState,
    FileToolbar,
    MobileFilesHeader,
    FolderBreadcrumb,
    FolderCard,
    DeleteFolderDialog,
    MoveToFolderDialog,
    RenameDialog,
    MoveToTeamDialog,
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
      mobileKind: 'all',
      mobileCreateOpen: false,
      view: savedView(),
      activeRoom: null,
      activeItem: null,
      renameKind: 'room',
      deleteFolderVisible: false,
      folderToDelete: null,
      moveVisible: false,
      renameVisible: false,
      moveToTeamVisible: false,
      shareVisible: false,
      folderShareVisible: false,
      activeFolder: null,
      importVisible: false,
      limit: savedPageSize(),
      page: 1,
      total: 0,
      searchTimer: null,
      teams: [],
      teamsLoading: false,
      metadataKey: '',
      metadataAt: 0,
      selectMode: false,
      selectedRoomKeys: [],
      selectedFolderIds: [],
      batchAction: null,
      returnContext: null,
      highlightRoomKey: '',
      highlightTimer: null,
      restoringListState: false,
      returnStatePending: false
    }
  },
  computed: {
    useMobileFilesHeader() {
      return this.isMobileViewport && this.mode !== 'trash'
    },
    mobileRootLabel() {
      return this.isTeamView && this.selectedTeam ? this.selectedTeam.name : '脑图'
    },
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
    favoritesCrumb() {
      return [{ id: 'favorites', name: '收藏' }]
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
        (this.mode === 'files' ||
          this.mode === 'folder' ||
          this.mode === 'shared')
      )
    },
    showPager() {
      return this.isRealFilesMode && !this.loading && Number(this.total || 0) > this.limit
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
      const counts = new Map()
      this.folders.forEach(folder => counts.set(folder.parentId, (counts.get(folder.parentId) || 0) + 1))
      return this.folders.filter(folder => (folder.parentId || null) === this.currentParentId)
        .map(folder => ({ ...folder, itemCount: Number(folder.roomCount || 0) + (counts.get(folder.id) || 0) }))
    },
    filteredFolders() {
      if (this.isMobileViewport && this.mobileKind === 'rooms') return []
      const q = this.search.trim().toLowerCase()
      return this.showFolders && !this.roleFilter
        ? this.childFolders.filter(
            folder => !q || folder.name.toLowerCase().includes(q)
          )
        : []
    },
    visibleRooms() {
      if (this.isMobileViewport && this.mobileKind === 'folders') return []
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
      return rooms
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
    mobileCreateOpen(open) { this.$bus.$emit('mobile-create-state', open) },
    '$route'(to, from) {
      if (to.path !== from.path) this.mobileCreateOpen = false
      if (isShellOnlyRouteChange(to, from)) return
      this.restoreNavigationState()
    },
    search() {
      if (this.restoringListState) return
      if (!this.isRealFilesMode) return
      clearTimeout(this.searchTimer)
      this.searchTimer = setTimeout(() => {
        this.page = 1
        this.load({ reset: true, keepPage: true })
      }, 300)
    },
    roleFilter() {
      if (this.restoringListState) return
      if (!this.isTeamView) return
      this.page = 1
      this.load({ reset: true, keepPage: true })
    },
    sort() {
      if (this.restoringListState) return
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
    this.$bus.$on('mobile-create-file', this.openMobileCreate)
    this.restoreNavigationState()
    if (this.$route.query.mobileCreate === '1') {
      this.openMobileCreate()
      this.$nextTick(() => {
        const query = { ...this.$route.query }
        delete query.mobileCreate
        this.$router.replace({ path: this.$route.path, query, hash: this.$route.hash })
      })
    }
  },
  beforeDestroy() {
    this.$bus.$emit('mobile-create-state', false)
    this.$bus.$off('mobile-create-file', this.openMobileCreate)
    clearTimeout(this.searchTimer)
    clearTimeout(this.highlightTimer)
    this.requestId++
  },
  methods: {
    renameFolderFromMenu(folder) { this.activeItem = { ...folder, title: folder.name }; this.renameKind = 'folder'; this.renameVisible = true },
    openMobileCreate() { this.mobileCreateOpen = !this.mobileCreateOpen },
    selectMobileCreate(action) {
      this.mobileCreateOpen = false
      if (action === 'room') return this.createRoom()
      if (action === 'folder') return this.createFolder()
      if (action === 'import') return this.openImport()
    },
    resetPage() {
      clearTimeout(this.highlightTimer)
      this.returnContext = null
      this.returnStatePending = false
      this.restoringListState = false
      this.highlightRoomKey = ''
      this.metadataAt = 0
      this.clearSelection()
      this.selectMode = false
      this.search = ''
      this.roleFilter = ''
      this.sort = this.mode === 'recent' ? 'lastOpenedAt' : 'updatedAt'
      this.page = 1
      this.load({ reset: true, keepPage: true })
    },
    restoreNavigationState() {
      const context = readReturnContext(this.$route)
      const state = context && restoreListState(context)
      if (!context || !state) {
        this.resetPage()
        return
      }
      this.returnContext = context
      this.returnStatePending = true
      this.restoringListState = true
      this.search = state.search
      this.roleFilter = state.roleFilter
      this.sort = state.sort
      this.page = state.page
      this.limit = state.limit
      this.view = state.view
      this.$nextTick(() => {
        if (this._isDestroyed) return
        this.restoringListState = false
        this.load({ reset: true, keepPage: true })
      })
    },
    captureCurrentListState() {
      return captureListState({
        search: this.search,
        roleFilter: this.roleFilter,
        sort: this.sort,
        page: this.page,
        limit: this.limit,
        view: this.view,
        scroll: captureScrollPosition(this.$el)
      })
    },
    sourceFolderName() {
      if (this.folder) return this.folder.name
      if (this.mode === 'files' && this.isTeamView)
        return this.selectedTeam ? this.selectedTeam.name : ''
      return ''
    },
    editorLocation(room, state, route = this.$route) {
      return createEditorLocation({
        route,
        room,
        state: state || this.captureCurrentListState(),
        folderName: this.sourceFolderName()
      })
    },
    async navigateToEditor(room, state, sourceRoute = this.$route) {
      const location = this.editorLocation(room, state, sourceRoute)
      const nav = location.query && location.query.nav
      if (nav) {
        const listLocation = {
          path: sourceRoute.path,
          query: { ...(sourceRoute.query || {}), nav }
        }
        await this.$router.replace(listLocation)
        if (
          this._isDestroyed ||
          this.$route.path !== sourceRoute.path ||
          String(this.$route.query.nav || '') !== String(nav)
        ) return
      }
      return this.$router.push(location)
    },
    async restoreReturnPosition() {
      if (!this.returnStatePending || !this.returnContext) return
      this.returnStatePending = false
      const context = this.returnContext
      await this.$nextTick()
      if (this._isDestroyed) return
      restoreScrollPosition(context.state && context.state.scroll, this.$el)
      const roomKey = String(context.roomKey || '')
      if (roomKey && this.visibleRooms.some(room => this.roomKey(room) === roomKey)) {
        clearTimeout(this.highlightTimer)
        this.highlightRoomKey = roomKey
        this.highlightTimer = setTimeout(() => {
          this.highlightRoomKey = ''
        }, 2400)
      }
    },
    async returnToEntryRoot() {
      this.returnStatePending = false
      this.returnContext = null
      this.$message.warning('原目录已不可访问，已返回脑图列表')
      const query = this.selectedTeamId ? { team: this.selectedTeamId } : {}
      const shell = resolveShellMode(this.$route)
      const target = withShell(
        { path: this.filesBasePath, query },
        { path: this.filesBasePath, query: { shell } }
      )
      if (target.path === '/my-maps') armSkipMyMapsRedirect()
      await this.$router.push(target).catch(() => {})
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
        this.metadataAt = 0
        await this.load({ reset: true, keepPage: true })
        this.summarizeBatchResult(ok, fail, '已删除')
      } catch (error) {
        this.$message.error(userMessageFromError(error))
      } finally {
        this.busy = false
      }
    },
    toggleFavorites() {
      this.exitSelectMode()
      this.$router.push(withShell({
        path: this.mode === 'favorites'
          ? this.filesBasePath
          : this.filesBasePath + '/favorites'
      }, this.$route))
    },
    changeWorkspace(teamId) {
      this.exitSelectMode()
      const team = String(teamId || '')
      this.$router.push(withShell({
        path: this.filesBasePath,
        query: team ? { team } : {}
      }, this.$route))
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
        const user = getCurrentUser()
        const metadataKey = JSON.stringify([user && user.id, user && user.corpId, this.selectedTeamId || 'personal'])
        const refreshMetadata = metadataKey !== this.metadataKey || Date.now() - this.metadataAt > 30000
        if (refreshMetadata && (mode === 'files' || (mode === 'folder' && this.selectedTeamId))) {
          this.teamsLoading = true
          try {
            const teams = await teamService.listSpaces()
            if (request !== this.requestId) return
            this.teams = teams
          } catch (error) {
            if (request !== this.requestId) return
            this.teams = []
            // 团队接口异常不能阻断个人文件；但用户正在访问某个团队时需要明确报错。
            if (this.selectedTeamId) throw error
          } finally {
            if (request === this.requestId) this.teamsLoading = false
          }
          if (
            this.selectedTeamId &&
            !this.teams.some(team => team.id === this.selectedTeamId)
          ) {
            throw new Error('团队不存在、已删除或你已无权访问')
          }
        }
        const folders = refreshMetadata ? (this.isTeamView
          ? await teamService.listFolders(this.selectedTeamId)
          : await folderService.listFolders()) : this.folders
        if (request !== this.requestId) return
        this.folders = folders
        this.metadataKey = metadataKey
        this.metadataAt = Date.now()
        if (
          mode === 'folder' &&
          !this.folders.some(folder => String(folder.id) === String(folderId))
        ) {
          await this.returnToEntryRoot()
          return
        }
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
          filters.role = this.roleFilter
          filters.sort = this.sort === 'lastOpenedAt' && !this.isTeamView ? 'updatedAt' : this.sort
          filters.order = this.sort === 'title' ? 'asc' : 'desc'
          filters.limit = this.limit
          filters.offset = Math.max(0, (this.page - 1) * this.limit)
        }
        let rooms = this.isTeamView
          ? await teamService.listRoomsPage(this.selectedTeamId, filters)
          : await roomService.listRooms(filters)
        if (request !== this.requestId) return
        const list = rooms.list || rooms
        const total = Number(rooms.total != null ? rooms.total : list.length)
        this.total = total
        // 删到最后一页为空时，自动回到有效页。
        const maxPage = Math.max(1, Math.ceil(total / this.limit) || 1)
        if (this.isRealFilesMode && this.page > maxPage) {
          this.page = clampListPage(this.page, total, this.limit)
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
        if (request === this.requestId) {
          this.loading = false
          if (!this.error) this.restoreReturnPosition()
        }
      }
    },
    onPageChange(page) {
      this.page = Math.max(1, Number(page) || 1)
      this.load({ reset: true, keepPage: true })
    },
    async perform(action, message) {
      if (this.busy) return
      this.busy = true
      try {
        await action()
        this.metadataAt = 0
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
      this.$router.push(withShell(route, this.$route))
    },
    navigateMobileView(view) {
      return this.pushMobileTarget(
        mobileViewTarget(this.filesBasePath, view)
      )
    },
    navigateMobileFolder(folderId) {
      return this.pushMobileTarget(
        mobileFolderTarget(this.filesBasePath, folderId, {
          team: this.selectedTeamId
        })
      )
    },
    navigateMobileRoot() {
      return this.pushMobileTarget(
        mobileRootTarget(this.filesBasePath, { team: this.selectedTeamId })
      )
    },
    navigateMobileParent() {
      return this.pushMobileTarget(
        mobileParentTarget(this.filesBasePath, this.folderPath, {
          team: this.selectedTeamId
        })
      )
    },
    pushMobileTarget(target) {
      const location = withShell(target, this.$route)
      if (!shouldNavigateMobile(location, this.$route)) return
      return this.$router.push(location).catch(error => {
        if (
          isNavigationFailure(error, NavigationFailureType.cancelled) ||
          isNavigationFailure(error, NavigationFailureType.duplicated)
        ) return
        this.$message.error(userMessageFromError(error))
      })
    },
    async openRoom(room) {
      if (this.openingRoom) return
      this.openingRoom = true
      const sourceRoute = this.$route
      try {
        const state = this.captureCurrentListState()
        const roomKey = room.roomKey || room.id
        await roomService.markOpened(roomKey)
        // A slow recent-open request must not undo the user's later navigation.
        if (this._isDestroyed || this.$route !== sourceRoute) return
        await this.navigateToEditor(room, state, sourceRoute)
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
        customClass: 'wcpdCreateDialog wcpdCreateDialog--room',
        confirmButtonText: '创建脑图',
        cancelButtonText: '取消',
        inputPlaceholder: '为你的想法起个名字',
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
        await this.navigateToEditor(created)
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
          customClass: 'wcpdCreateDialog wcpdCreateDialog--folder',
          confirmButtonText: '创建文件夹',
          cancelButtonText: '取消',
          inputPlaceholder: '输入文件夹名称',
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
      this.metadataAt = 0
      await this.load({ reset: true, keepPage: true })
      if (result && result.mode === 'folder' && result.folderId) {
        const route = { path: `${this.filesBasePath}/folder/` + result.folderId }
        if (this.selectedTeamId) route.query = { team: this.selectedTeamId }
        this.$router.push(withShell(route, this.$route))
        return
      }
      if (result && result.mode === 'single' && result.room) {
        const roomKey = result.room.roomKey || result.room.id
        if (roomKey) {
          await this.navigateToEditor(result.room)
        }
      }
    },
    renameRoomInline(room, name) {
      this.activeItem = room
      this.renameKind = 'room'
      return this.confirmRename(name)
    },
    renameFolderInline(folder, name) {
      if (this.isTeamView && !this.canManageTeam) {
        this.$message.error('只有团队所有者或管理员可以重命名文件夹')
        return
      }
      this.activeItem = folder
      this.renameKind = 'folder'
      return this.confirmRename(name)
    },
    renameRoom(room) {
      this.activeItem = room
      this.renameKind = 'room'
      this.renameVisible = true
    },
    async renameRoomFromDialog(name) {
      const title = String(name || '').trim()
      if (!title || !this.activeItem || title === this.activeItem.title) return
      this.renameKind = 'room'
      await this.confirmRename(title)
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
    deleteFolder(folder) {
      if (this.isTeamView && !this.canManageTeam) {
        this.$message.error('只有团队所有者或管理员可以删除文件夹')
        return
      }
      this.folderToDelete = folder
      this.deleteFolderVisible = true
    },
    async onFolderDeleted(result) {
      this.metadataAt = 0
      this.clearSelection()
      if (this.mode === 'folder' && result.deletedFolderIds.includes(this.$route.params.id)) {
        const query = this.selectedTeamId ? { team: this.selectedTeamId } : {}
        await this.$router.push(withShell({ path: this.filesBasePath, query }, this.$route))
      } else await this.load({ reset: true, keepPage: true })
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
          this.metadataAt = 0
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
          this.metadataAt = 0
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
    favorite(room) {
      return this.perform(
        () => roomService.toggleFavorite(room.roomKey || room.id),
        room.favorite ? '已取消收藏' : '已收藏'
      )
    },
    async duplicateRoom(room) {
      if (this.busy) return
      const sourceRoomKey = this.roomKey(room)
      if (!sourceRoomKey) {
        this.$message.error('缺少脑图标识，无法创建副本')
        return
      }
      const sourceTitle = String(room.title || '未命名脑图').trim() || '未命名脑图'
      const title = `${sourceTitle}--副本`
      this.busy = true
      try {
        const source = await getFileExport(sourceRoomKey, 10000)
        if (!source || source.truncated || !source.tree) {
          throw new Error('脑图内容过大，暂不支持创建完整副本')
        }
        const folderId = this.folder ? this.folder.id : null
        const created = this.isTeamView
          ? await teamService.createRoom(this.selectedTeamId, title, folderId)
          : await roomService.createRoom(title, folderId)
        const createdRoomKey = this.roomKey(created)
        if (!createdRoomKey) throw new Error('创建副本未返回脑图标识')
        try {
          await replaceFileTree(createdRoomKey, source.tree, {
            allowFullTree: true,
            source: 'duplicate'
          })
        } catch (error) {
          await roomService.deleteRoom(createdRoomKey).catch(() => {})
          throw error
        }
        this.metadataAt = 0
        await this.load({ reset: true, keepPage: true })
        this.$message.success(`已创建副本「${title}」`)
      } catch (error) {
        this.$message.error(userMessageFromError(error))
      } finally {
        this.busy = false
      }
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
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 28px 20px;
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
  color: var(--ui-text-muted);
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
  background: var(--ui-surface);
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  overflow: hidden;
}
.trashRow {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 16px;
  border-bottom: 1px solid var(--ui-border);
  &:last-child {
    border-bottom: 0;
  }
  .trashIcon {
    width: 38px;
    height: 38px;
    border-radius: 9px;
    background: var(--ui-surface-muted);
    display: grid;
    place-items: center;
    color: var(--ui-text-muted);
  }
  div:nth-child(2) {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  span {
    color: var(--ui-text-muted);
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
