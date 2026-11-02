<template>
  <ActionTooltip :content="currentLabel">
  <button type="button" class="themeModeTrigger" :aria-label="`主题模式：${currentLabel}`" @click="cycle">
    <ThemeModeIcon :mode="currentMode" />
  </button>
  </ActionTooltip>
</template>
<script>
import ActionTooltip from '@/components/ActionTooltip.vue'
import ThemeModeIcon from './ThemeModeIcon.vue'
import { revealThemeChange } from '@/utils/themeReveal'
import { shellTheme, setShellThemeMode, resolveThemeMode } from '@/utils/shellTheme'
export default {
  name: 'ThemeModeToggle',
  components: { ThemeModeIcon, ActionTooltip },
  data: () => ({ requestedMode: null, cycleVersion: 0, modes: [
    { value: 'light', label: '浅色模式' },
    { value: 'dark', label: '深色模式' },
    { value: 'system', label: '跟随系统' }
  ] }),
  computed: {
    currentMode() { return this.requestedMode || shellTheme.mode },
    currentLabel() { return (this.modes.find(mode => mode.value === this.currentMode) || this.modes[2]).label },
    nextMode() { return this.modes[(this.modes.findIndex(mode => mode.value === this.currentMode) + 1) % this.modes.length] }
  },
  methods: {
    async cycle(event) {
      const mode = this.nextMode.value
      const version = ++this.cycleVersion
      this.requestedMode = mode
      const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      try {
        await revealThemeChange({
          element: event.currentTarget,
          onRepeat: nextEvent => this.cycle(nextEvent),
          animate: resolveThemeMode(mode, systemDark) !== shellTheme.theme,
          update: () => setShellThemeMode(mode),
          nextTick: () => this.$nextTick()
        })
      } finally {
        if (version === this.cycleVersion) this.requestedMode = null
      }
    }
  }
}
</script>
<style lang="less">
.themeModeTrigger {
  display: inline-grid; place-items: center; width: 36px; height: 36px;
  padding: 0; border: 0; border-radius: 8px;
  color: var(--ui-text-secondary, #66756e); background: transparent; cursor: pointer;
  svg { width: 18px; height: 18px; }
  &:hover { color: var(--ui-primary, #087854); background: var(--ui-surface-muted, #f1f5f3); }
  &:focus-visible { outline: 2px solid var(--ui-focus, #0a7e59); outline-offset: 2px; }
}
</style>
