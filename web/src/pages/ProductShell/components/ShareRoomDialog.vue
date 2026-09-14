<template>
  <ShareFolderDialog
    :visible.sync="shown"
    resource-type="room"
    :room="room"
    @changed="$emit('changed')"
  />
</template>

<script>
import ShareFolderDialog from './ShareFolderDialog.vue'

export default {
  name: 'ShareRoomDialog',
  components: { ShareFolderDialog },
  props: { visible: Boolean, room: Object },
  computed: {
    shown: {
      get() {
        return this.visible
      },
      set(value) {
        this.$emit('update:visible', value)
      }
    }
  }
}
</script>
