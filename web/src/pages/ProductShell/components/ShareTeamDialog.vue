<template>
  <ShareFolderDialog
    :visible.sync="shown"
    resource-type="team"
    :team="team"
    @changed="$emit('changed')"
  />
</template>

<script>
import ShareFolderDialog from './ShareFolderDialog.vue'

export default {
  name: 'ShareTeamDialog',
  components: { ShareFolderDialog },
  props: { visible: Boolean, team: Object },
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
