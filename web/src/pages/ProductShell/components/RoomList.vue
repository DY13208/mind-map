<template
  ><el-table
    ref="table"
    :data="items"
    class="roomTable"
    row-key="__key"
    @row-click="openItem"
    @selection-change="onSelectionChange"
    ><el-table-column
      v-if="selectMode"
      type="selection"
      width="48"
      :selectable="rowSelectable"
    /><el-table-column label="名称" min-width="220"
      ><template slot-scope="scope"
        ><div class="roomName">
          <i :class="scope.row.__kind === 'folder' ? 'el-icon-folder' : 'el-icon-document'" /><strong>{{ scope.row.title || scope.row.name }}</strong>
        </div></template
      ></el-table-column
    ><el-table-column label="类型" width="90"><template slot-scope="scope">{{ scope.row.__kind === 'folder' ? '文件夹' : '脑图' }}</template></el-table-column><el-table-column
      prop="folderName"
      label="所属文件夹"
      min-width="120"
    /><el-table-column
      prop="owner.name"
      label="创建者"
      width="110"
    /><el-table-column
      prop="roleLabel"
      label="我的角色"
      width="100"
    /><el-table-column label="协作者" width="125"
      ><template slot-scope="scope"
        ><div v-if="scope.row.__kind !== 'folder'" class="avatars">
          <UserAvatar
            v-for="person in scope.row.collaborators.slice(0, 3)"
            :key="person.id"
            :person="person"
            :size="24"
          />
        </div></template
      ></el-table-column
    ><el-table-column label="更新时间" width="145"
      ><template slot-scope="scope">{{
        formatDate(scope.row.updatedAt)
      }}</template></el-table-column
    ><el-table-column width="65"
      ><template slot-scope="scope"
        ><el-button
          type="text"
          v-if="scope.row.__kind !== 'folder' && !selectMode"
          :icon="scope.row.favorite ? 'el-icon-star-on' : 'el-icon-star-off'"
          @click.stop="
            $emit('favorite', scope.row)
          "/></template></el-table-column
    ><el-table-column width="65"
      ><template slot-scope="scope"
        ><el-dropdown v-if="scope.row.__kind !== 'folder' && !selectMode"
          trigger="click"
          @command="$emit($event, scope.row)"
          @click.native.stop
          ><i class="el-icon-more" /><el-dropdown-menu slot="dropdown"
            ><el-dropdown-item command="open">打开</el-dropdown-item
            ><el-dropdown-item command="rename">重命名</el-dropdown-item
            ><el-dropdown-item command="move">移动到文件夹</el-dropdown-item
            ><el-dropdown-item v-if="allowMoveToTeam" command="moveToTeam"
              >移至团队空间</el-dropdown-item
            ><el-dropdown-item command="share">分享</el-dropdown-item
            ><el-dropdown-item command="history">历史版本</el-dropdown-item
            ><el-dropdown-item v-if="allowDelete && scope.row.canManage" command="delete" divided
              >删除</el-dropdown-item
            ></el-dropdown-menu
          ></el-dropdown
        ></template
      ></el-table-column
    ></el-table
  ></template
>
<script>
import UserAvatar from '@/components/UserAvatar.vue'

export default {
  name: 'RoomList',
  components: { UserAvatar },
  props: {
    rooms: Array,
    folders: { type: Array, default: () => [] },
    allowDelete: { type: Boolean, default: false },
    allowMoveToTeam: { type: Boolean, default: true },
    selectMode: { type: Boolean, default: false },
    selectedRoomKeys: { type: Array, default: () => [] },
    selectedFolderIds: { type: Array, default: () => [] },
    canSelectFolder: { type: Function, default: () => true },
    canSelectRoom: { type: Function, default: () => true }
  },
  computed: {
    items() {
      return this.folders
        .map(folder => ({
          ...folder,
          __kind: 'folder',
          __key: 'folder:' + folder.id,
          folderName: '—'
        }))
        .concat(
          this.rooms.map(room => ({
            ...room,
            __kind: 'room',
            __key: 'room:' + (room.roomKey || room.id)
          }))
        )
    }
  },
  watch: {
    selectMode(value) {
      if (!value) this.clearTableSelection()
      else this.syncTableSelection()
    },
    selectedRoomKeys: 'syncTableSelection',
    selectedFolderIds: 'syncTableSelection',
    items: 'syncTableSelection'
  },
  methods: {
    rowSelectable(row) {
      return row.__kind === 'folder'
        ? this.canSelectFolder(row)
        : this.canSelectRoom(row)
    },
    openItem(item) {
      if (this.selectMode) return
      this.$emit(item.__kind === 'folder' ? 'open-folder' : 'open', item)
    },
    onSelectionChange(rows) {
      if (!this.selectMode) return
      const roomKeys = []
      const folderIds = []
      ;(rows || []).forEach(row => {
        if (row.__kind === 'folder') folderIds.push(row.id)
        else roomKeys.push(row.roomKey || row.id)
      })
      this.$emit('selection-change', { roomKeys, folderIds })
    },
    syncTableSelection() {
      if (!this.selectMode || !this.$refs.table) return
      this.$nextTick(() => {
        const table = this.$refs.table
        if (!table) return
        table.clearSelection()
        const roomSet = new Set(this.selectedRoomKeys.map(String))
        const folderSet = new Set(this.selectedFolderIds.map(String))
        this.items.forEach(row => {
          const selected =
            row.__kind === 'folder'
              ? folderSet.has(String(row.id))
              : roomSet.has(String(row.roomKey || row.id))
          if (selected && this.rowSelectable(row)) {
            table.toggleRowSelection(row, true)
          }
        })
      })
    },
    clearTableSelection() {
      if (this.$refs.table) this.$refs.table.clearSelection()
    },
    formatDate(value) {
      return new Date(value).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
    }
  }
}
</script>
<style lang="less" scoped>
.roomTable {
  border: 1px solid #e3e9e6;
  border-radius: 12px;
  overflow: hidden;
  .roomName {
    display: flex;
    gap: 9px;
    align-items: center;
    color: #234238;
    i {
      color: #0b9366;
    }
  }
  .avatars {
    display: flex;
    /deep/ .userAvatar {
      margin-right: -5px;
      border: 2px solid white;
    }
  }
}
</style>
