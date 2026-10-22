<template>
  <div class="mobileEditorMenu" :class="{ isDark }" @keydown.esc.stop.prevent="close">
    <button v-if="open" type="button" class="editorMenuBackdrop" tabindex="-1" aria-label="收起脑图菜单" @click="close"></button>
    <div v-if="open" class="editorMenuPanel" id="phone-map-menu">
      <div class="editorMenuHeading">脑图菜单</div>
      <nav class="editorMenuItems customScrollbar" aria-label="脑图菜单">
        <button v-for="item in items" :key="item.key" type="button" class="editorMenuItem" :class="{ separated: item.key === 'messages' }" :aria-label="item.label" @click="select(item.key)">
          <i class="editorMenuIcon" :class="item.icon" aria-hidden="true"></i><span>{{ item.label }}</span><i class="el-icon-arrow-right editorMenuArrow" aria-hidden="true"></i>
        </button>
      </nav>
    </div>
    <button ref="trigger" type="button" class="editorMenuTrigger" :aria-label="open ? '关闭脑图菜单' : '打开脑图菜单'" :aria-expanded="String(open)" aria-controls="phone-map-menu" @click="open = !open"><i :class="open ? 'el-icon-close' : 'el-icon-menu'" aria-hidden="true"></i></button>
  </div>
</template>
<script>
export default {
  props: { isDark: Boolean },
  data: () => ({ open: false }),
  watch: { open(value) { this.$emit('toggle', value) } },
  computed: {
    items() { return [
      { key: 'file', label: '导航', icon: 'el-icon-folder-opened' },
      { key: 'node', label: '节点', icon: 'el-icon-s-grid' },
      { key: 'canvas', label: '画布', icon: 'el-icon-full-screen' },
      { key: 'appearance', label: '外观', icon: 'el-icon-brush' },
      { key: 'more', label: '工具', icon: 'el-icon-setting' },
      { key: 'messages', label: '消息', icon: 'el-icon-bell' }
    ] }
  },
  methods: {
    close() { this.open = false; this.$nextTick(() => { if (this.$refs.trigger) this.$refs.trigger.focus({ preventScroll: true }) }) },
    select(key) { this.open = false; this.$emit('select', key) }
  }
}
</script>
