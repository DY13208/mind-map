<template>
  <div class="mobileCircleMenu" :class="{ open, isDark }" @keydown.esc.stop="close">
    <button v-if="open" class="circleMenuBackdrop" aria-label="收起脑图菜单" @click="close"></button>
    <div class="circleMenuOrbit" id="phone-map-menu" role="group" aria-label="脑图菜单" :aria-hidden="String(!open)">
      <button v-for="(item, index) in items" :key="item.key" type="button" class="circleMenuItem" :style="position(index)" :disabled="!open" :tabindex="open ? 0 : -1" :aria-label="item.label" @click="select(item.key)">
        <i :class="item.icon" aria-hidden="true"></i><span>{{ item.label }}</span>
      </button>
    </div>
    <button ref="trigger" type="button" class="circleMenuTrigger" :aria-label="open ? '关闭脑图菜单' : '打开脑图菜单'" :aria-expanded="String(open)" aria-controls="phone-map-menu" @click="open = !open"><i :class="open ? 'el-icon-close' : 'el-icon-menu'" aria-hidden="true"></i></button>
  </div>
</template>
<script>
export default {
  props: { isDark: Boolean },
  data: () => ({ open: false }),
  watch: { open(value) { this.$emit('toggle', value) } },
  computed: {
    items() { return [
      { key: 'file', label: '文件', icon: 'el-icon-folder-opened' },
      { key: 'node', label: '节点', icon: 'el-icon-s-grid' },
      { key: 'canvas', label: '画布', icon: 'el-icon-full-screen' },
      { key: 'appearance', label: '外观', icon: 'el-icon-brush' },
      { key: 'more', label: '工具', icon: 'el-icon-setting' },
      { key: 'messages', label: '消息', icon: 'el-icon-bell' }
    ] }
  },
  methods: {
    position(index) { const angle = index * Math.PI / 3 - Math.PI / 2; return { '--circle-x': Math.round(Math.cos(angle) * 104) + 'px', '--circle-y': Math.round(Math.sin(angle) * 104) + 'px', '--circle-delay': index * 20 + 'ms' } },
    close() { this.open = false; this.$nextTick(() => { if (this.$refs.trigger) this.$refs.trigger.focus({ preventScroll: true }) }) },
    select(key) { this.open = false; this.$emit('select', key) }
  }
}
</script>
