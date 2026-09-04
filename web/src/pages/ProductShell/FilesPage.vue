<template>
  <section class="productPage">
    <div class="productHeader">
      <div>
        <FolderBreadcrumb v-if="folder" :folder="folder" />
        <h1>{{ pageTitle }}</h1>
        <p>{{ pageDescription }}</p>
      </div>
    </div>
    <FileToolbar
      :search.sync="search"
      :role-filter.sync="roleFilter"
      :sort.sync="sort"
      :view.sync="view"
      :show-create="mode === 'files' || mode === 'folder'"
      :show-create-folder="mode === 'files'"
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
      <template v-if="showFolders && filteredFolders.length"
        ><h2 class="sectionTitle">文件夹</h2>
        <div class="folderGrid">
          <FolderCard
            v-for="item in filteredFolders"
            :key="item.id"
            :folder="item"
            @open="openFolder"
            @rename="renameFolder"
            @delete="deleteFolder"
          /></div
      ></template>
      <h2 class="sectionTitle" v-if="visibleRooms.length">
        {{ mode === 'trash' ? '已删除' : '脑图' }}
        <span>{{ visibleRooms.length }}</span>
      </h2>
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
      <div
        v-if="mode !== 'trash' && view === 'card' && visibleRooms.length"
        class="roomGrid"
      >
        <RoomCard
          v-for="room in visibleRooms"
          :key="room.roomKey || room.id"
          :room="room"
          :allow-delete="false"
          @open="openRoom"
          @favorite="favorite"
          @rename="renameRoom"
          @move="moveRoom"
          @share="shareRoom"
          @history="historyRoom"
          @delete="deleteRoom"
        />
      </div>
      <RoomList
        v-if="mode !== 'trash' && view === 'list' && visibleRooms.length"
        :rooms="visibleRooms"
        :allow-delete="false"
        @open="openRoom"
        @favorite="favorite"
        @rename="renameRoom"
        @move="moveRoom"
        @share="shareRoom"
        @history="historyRoom"
        @delete="deleteRoom"
      />
      <div v-if="hasMore" class="pager">
        <el-button size="small" :loading="busy" @click="loadMore">加载更多</el-button>
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
    <ShareRoomDialog
      :visible.sync="shareVisible"
      :room="activeRoom"
      @changed="load"
    />
    <HistoryPanel
      :visible.sync="historyVisible"
      :room="activeRoom"
      @restored="load"
    />
  </section>
</template>

<script>
import { userMessageFromError } from '@/services/apiError'
import roomService from '@/services/roomService'
import folderService from '@/services/folderService'
import EmptyState from './components/EmptyState.vue'
import FileToolbar from './components/FileToolbar.vue'
import FolderBreadcrumb from './components/FolderBreadcrumb.vue'
import FolderCard from './components/FolderCard.vue'
import HistoryPanel from './components/HistoryPanel.vue'
import MoveToFolderDialog from './components/MoveToFolderDialog.vue'
import RenameDialog from './components/RenameDialog.vue'
import RoomCard from './components/RoomCard.vue'
import RoomList from './components/RoomList.vue'
import ShareRoomDialog from './components/ShareRoomDialog.vue'
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
export default {
  name: 'FilesPage',
  components: {
    EmptyState,
    FileToolbar,
    FolderBreadcrumb,
    FolderCard,
    HistoryPanel,
    MoveToFolderDialog,
    RenameDialog,
    RoomCard,
    RoomList,
    ShareRoomDialog
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
      shareVisible: false,
      historyVisible: false,
      limit: 50,
      offset: 0,
      total: 0,
      nextCursor: '',
      searchTimer: null
    }
  },
  computed: {
    isRealFilesMode() {
      return this.mode === 'files' || this.mode === 'folder' || this.mode === 'shared'
    },
    hasMore() {
      if (!this.isRealFilesMode) return false
      if (this.nextCursor) return true
      return this.rooms.length < Number(this.total || 0)
    },
    folder() {
      return this.mode === 'folder'
        ? this.folders.find(item => item.id === this.$route.params.id)
        : null
    },
    pageTitle() {
      return this.folder ? this.folder.name : copy[this.mode][0]
    },
    pageDescription() {
      return this.folder
        ? this.folder.roomCount + ' 个脑图'
        : copy[this.mode][1]
    },
    showFolders() {
      return this.mode === 'files'
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
      return this.rooms.filter(room => {
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
    },
    emptyTitle() {
      if (this.search || this.roleFilter) return '没有搜索结果'
      return (
        {
          favorites: '没有收藏',
          shared: '暂无共享脑图',
          trash: '回收站为空',
          folder: '这个文件夹暂无内容'
        }[this.mode] || '还没有脑图'
      )
    },
    emptyDescription() {
      return (
        {
          favorites: '点击脑图上的星标即可收藏',
          shared: '收到的共享脑图会显示在这里',
          trash: '删除的脑图会暂存在这里',
          folder: '移动或新建脑图到这个文件夹'
        }[this.mode] || '创建第一张脑图开始工作'
      )
    }
  },
  watch: {
    '$route.fullPath': 'resetPage',
    search() {
      if (!this.isRealFilesMode) return
      clearTimeout(this.searchTimer)
      this.searchTimer = setTimeout(() => this.load({ reset: true }), 300)
    },
    sort() {
      if (this.isRealFilesMode) this.load({ reset: true })
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
      this.offset = 0
      this.nextCursor = ''
      this.load({ reset: true })
    },
    async load(options = {}) {
      const reset = options.reset !== false
      const request = ++this.requestId
      const mode = this.mode
      const folderId = this.$route.params.id
      if (reset) {
        this.offset = 0
        this.nextCursor = ''
      }
      this.loading = reset
      this.error = ''
      try {
        const folders = await folderService.listFolders()
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
        if (mode === 'folder') filters.folderId = folderId
        if (this.isRealFilesMode) {
          filters.q = this.search.trim()
          filters.sort = this.sort === 'lastOpenedAt' ? 'updatedAt' : this.sort
          filters.order = this.sort === 'title' ? 'asc' : 'desc'
          filters.limit = this.limit
          filters.offset = reset ? 0 : this.offset
          if (!reset && this.nextCursor) filters.cursor = this.nextCursor
        }
        const rooms = await roomService.listRooms(filters)
        if (request !== this.requestId) return
        const list = rooms.list || rooms
        this.total = Number(rooms.total || list.length)
        this.nextCursor = rooms.nextCursor || ''
        this.offset = Number(rooms.offset || 0) + list.length
        this.rooms = reset ? list : this.rooms.concat(list)
      } catch (error) {
        if (request === this.requestId)
          this.error = userMessageFromError(error)
      } finally {
        if (request === this.requestId) this.loading = false
      }
    },
    loadMore() {
      return this.load({ reset: false })
    },
    async perform(action, message) {
      if (this.busy) return
      this.busy = true
      try {
        await action()
        if (message) this.$message.success(message)
        await this.load()
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
        await this.$router.push({
          path: '/',
          query: { room: room.roomKey }
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
        const created = await roomService.createRoom(
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
    shareRoom(room) {
      this.activeRoom = room
      this.shareVisible = true
    },
    historyRoom(room) {
      this.activeRoom = room
      this.historyVisible = true
    },
    favorite(room) {
      return this.perform(
        () => roomService.toggleFavorite(room.roomKey || room.id),
        room.favorite ? '已取消收藏（仅本机会话）' : '已收藏（仅本机会话）'
      )
    },
    async deleteRoom() {
      this.$message.warning('回收站尚未接入，暂不可删除真实脑图')
    },
    restore(room) {
      return this.perform(
        () => roomService.restoreRoom(room.id),
        '已恢复（Mock）'
      )
    },
    async permanentDelete(room) {
      const confirmed = await this.$confirm(
        '永久删除「' + room.title + '」？此 Mock 操作不可恢复。',
        '永久删除',
        { type: 'warning' }
      )
        .then(() => true)
        .catch(() => false)
      if (confirmed)
        await this.perform(
          () => roomService.permanentDelete(room.id),
          '已永久删除（Mock）'
        )
    },
    formatDate(value) {
      return new Date(value).toLocaleString('zh-CN')
    }
  }
}
</script>

<style lang="less" scoped>
.contentArea {
  min-height: 320px;
}
.folderGrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 12px;
}
.roomGrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 14px;
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
</style>
