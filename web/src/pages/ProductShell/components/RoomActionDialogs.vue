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
    <HistoryPanel
      :visible.sync="historyVisible"
      :room="room"
      @restored="$emit('changed')"
    /></div
></template>
<script>
import { userMessageFromError } from '@/services/apiError'
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
    roomKey(room) {
      return (room && (room.roomKey || room.id)) || ''
    },
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
          this.$message.error(userMessageFromError(error))
        }
      }
      if (action === 'favorite')
        await this.perform(() =>
          roomService.toggleFavorite(this.roomKey(room)),
          '收藏仅保存在本机会话'
        )
      if (action === 'delete') {
        this.$message.warning('回收站尚未接入，暂不可删除真实脑图')
      }
      if (action === 'open') {
        try {
          await this.$router.push({
            path: '/',
            query: { room: this.roomKey(room) }
          })
        } catch (error) {
          this.$message.error(userMessageFromError(error))
        }
      }
    },
    rename(name) {
      return this.perform(
        () => roomService.renameRoom(this.roomKey(this.room), name),
        '重命名成功'
      )
    },
    move(id) {
      return this.perform(
        () => roomService.moveRoom(this.roomKey(this.room), id),
        '移动成功'
      )
    },
    async perform(action, message) {
      if (this.busy) return
      this.busy = true
      try {
        await action()
        this.$emit('changed')
        if (message) this.$message.success(message)
      } catch (error) {
        this.$message.error(userMessageFromError(error))
      } finally {
        this.busy = false
      }
    }
  }
}
</script>
