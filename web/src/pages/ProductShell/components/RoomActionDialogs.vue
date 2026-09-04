<template
  ><div>
    <RenameDialog
      :visible.sync="renameVisible"
      :value="room ? room.title : ''"
      @confirm="rename"
    />
    <MoveToFolderDialog
      :visible.sync="moveVisible"
      :room="room"
      :folders="folders"
      @confirm="move"
    />
    <ShareRoomDialog
      :visible.sync="shareVisible"
      :room="room"
      @changed="$emit('changed')"
    />
    <HistoryPanel :visible.sync="historyVisible" :room="room" /></div
></template>
<script>
import roomService from '@/services/roomService'
import folderService from '@/services/folderService'
import RenameDialog from './RenameDialog.vue'
import MoveToFolderDialog from './MoveToFolderDialog.vue'
import ShareRoomDialog from './ShareRoomDialog.vue'
import HistoryPanel from './HistoryPanel.vue'
export default {
  name: 'RoomActionDialogs',
  components: {
    RenameDialog,
    MoveToFolderDialog,
    ShareRoomDialog,
    HistoryPanel
  },
  data: () => ({
    room: null,
    folders: [],
    renameVisible: false,
    moveVisible: false,
    shareVisible: false,
    historyVisible: false,
    busy: false
  }),
  methods: {
    async handle(action, room) {
      this.room = room
      if (action === 'rename') this.renameVisible = true
      if (action === 'share') this.shareVisible = true
      if (action === 'history') this.historyVisible = true
      if (action === 'move') {
        try {
          this.folders = await folderService.listFolders()
          this.moveVisible = true
        } catch (error) {
          this.$message.error(error.message)
        }
      }
      if (action === 'favorite')
        await this.perform(() => roomService.toggleFavorite(room.id))
      if (action === 'delete') {
        const ok = await this.$confirm(
          '将「' + room.title + '」移入回收站？',
          '删除脑图'
        )
          .then(() => true)
          .catch(() => false)
        if (ok) await this.perform(() => roomService.deleteRoom(room.id))
      }
      if (action === 'open') {
        const ok = await this.$confirm(
          '将进入现有编辑器。Mock roomKey 不代表真实文件；编辑器仍使用现有认证与协同流程。',
          '打开现有编辑器'
        )
          .then(() => true)
          .catch(() => false)
        if (ok) {
          try {
            await roomService.markOpened(room.id)
            await this.$router.push({
              path: '/',
              query: { room: room.roomKey }
            })
          } catch (error) {
            this.$message.error(error.message)
          }
        }
      }
    },
    rename(name) {
      return this.perform(() => roomService.renameRoom(this.room.id, name))
    },
    move(id) {
      return this.perform(() => folderService.moveRoom(this.room.id, id))
    },
    async perform(action) {
      if (this.busy) return
      this.busy = true
      try {
        await action()
        this.$emit('changed')
        this.$message.success('操作成功（Mock）')
      } catch (error) {
        this.$message.error(error.message)
      } finally {
        this.busy = false
      }
    }
  }
}
</script>
