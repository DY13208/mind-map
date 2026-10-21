<template>
  <div class="mobileCreatePortal">
    <transition name="quickMask">
      <div v-if="visible" class="mobileCreateMask" aria-hidden="true" @click="close" />
    </transition>
    <transition name="quickMenu">
      <div v-if="visible" id="mobile-create-menu" ref="menu" class="mobileCreateMenu" :style="position" role="menu" aria-label="新建内容" @keydown="onKeydown">
        <button v-for="item in items" :key="item.action" type="button" role="menuitem" @click="select(item.action)">
          <span class="quickCreateIcon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="item.path" /></svg></span>
          <span class="quickCreateCopy"><strong>{{ item.title }}</strong><span>{{ item.description }}</span></span>
          <svg class="quickCreateArrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        </button>
      </div>
    </transition>
  </div>
</template>

<script>
export default {
  name: 'MobileCreateMenu',
  props: { visible: Boolean, canCreateFolder: { type: Boolean, default: true } },
  data: () => ({ position: {} }),
  computed: {
    items() {
      return [
        { action: 'room', title: '新建脑图', description: '从空白开始创作', path: 'M12 6v12M12 8H7M12 16H7M12 12h5M3 6h4v4H3zM3 14h4v4H3zM17 10h4v4h-4z' },
        { action: 'folder', title: '新建文件夹', description: '整理你的内容', path: 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z' },
        { action: 'import', title: '导入脑图', description: '沿用现有支持的文件格式', path: 'M12 3v12m-4-4 4 4 4-4M5 8H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-1' }
      ].filter(item => item.action !== 'folder' || this.canCreateFolder)
    }
  },
  watch: {
    visible(open) {
      if (open) {
        this.updatePosition()
        this.$nextTick(() => {
          if (this.visible && this.$refs.menu) this.$refs.menu.querySelector('button').focus({ preventScroll: true })
        })
      }
    }
  },
  mounted() {
    document.body.appendChild(this.$el)
    window.addEventListener('resize', this.updatePosition)
    window.addEventListener('scroll', this.updatePosition, true)
    if (window.visualViewport) window.visualViewport.addEventListener('resize', this.updatePosition)
    document.addEventListener('keydown', this.onEscape)
    document.addEventListener('pointerdown', this.onOutside)
    if (this.visible) this.updatePosition()
  },
  beforeDestroy() {
    window.removeEventListener('resize', this.updatePosition)
    window.removeEventListener('scroll', this.updatePosition, true)
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', this.updatePosition)
    document.removeEventListener('keydown', this.onEscape)
    document.removeEventListener('pointerdown', this.onOutside)
    if (this.$el.parentNode) this.$el.parentNode.removeChild(this.$el)
  },
  methods: {
    updatePosition() {
      if (!this.visible) return
      if (window.innerWidth > 767) return this.close()
      const anchor = document.querySelector('.mobileBottomNav .mobilePrimary')
      if (!anchor) return this.close()
      const rect = anchor.getBoundingClientRect()
      const width = Math.min(250, window.innerWidth - 32)
      const left = Math.max(16, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 16))
      this.position = { left: left + 'px', width: width + 'px', bottom: (window.innerHeight - rect.top + 18) + 'px', maxHeight: Math.max(0, rect.top - 34) + 'px' }
    },
    close() {
      this.$emit('close')
      const anchor = document.querySelector('.mobileBottomNav .mobilePrimary')
      if (anchor) anchor.focus({ preventScroll: true })
    },
    select(action) { this.close(); this.$emit('select', action) },
    onEscape(event) { if (this.visible && event.key === 'Escape') { event.preventDefault(); this.close() } },
    onOutside(event) {
      if (this.visible && !event.target.closest('#mobile-create-menu, .mobileBottomNav .mobilePrimary')) this.close()
    },
    onKeydown(event) {
      const buttons = Array.from(this.$refs.menu.querySelectorAll('button'))
      const index = buttons.indexOf(document.activeElement)
      let next
      if (event.key === 'ArrowDown') next = (index + 1) % buttons.length
      if (event.key === 'ArrowUp') next = (index + buttons.length - 1) % buttons.length
      if (event.key === 'Home') next = 0
      if (event.key === 'End') next = buttons.length - 1
      if (next != null) { event.preventDefault(); buttons[next].focus() }
      if (event.key === 'Tab') this.$emit('close')
    }
  }
}
</script>

<style lang="less">
.mobileCreatePortal {
  position: fixed; inset: 0; z-index: 29; pointer-events: none;
  .mobileCreateMask { position: absolute; inset: 0; background: rgba(24, 45, 37, .10); pointer-events: auto; }
  .mobileCreateMenu {
    position: fixed; box-sizing: border-box; padding: 7px 12px; overflow-y: auto; pointer-events: auto;
    border: 1px solid var(--ui-border, #e7ece9); border-radius: 24px;
    background: var(--ui-surface, #fff); color: var(--ui-text, #17261f);
    box-shadow: 0 8px 32px rgba(21, 43, 32, .12); transform-origin: bottom center;
    button {
      display: flex; align-items: center; gap: 11px; width: 100%; min-height: 66px;
      padding: 10px 2px; border: 0; background: transparent; color: inherit; text-align: left;
      cursor: pointer; font-family: inherit; box-sizing: border-box;
      + button { border-top: 1px solid var(--ui-border, #e7ece9); }
      &:hover { background: var(--ui-surface-muted, #f1f5f3); }
      &:focus-visible { outline: 2px solid var(--ui-focus, #087854); outline-offset: -2px; border-radius: 12px; }
    }
    .quickCreateIcon { display: grid; place-items: center; flex: 0 0 34px; width: 34px; height: 38px; color: var(--ui-primary, #087854); svg { width: 25px; height: 25px; } }
    .quickCreateCopy { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 5px; strong { font-size: 14px; font-weight: 600; line-height: 20px; } > span { font-size: 11px; line-height: 16px; color: var(--ui-text-secondary, #66756e); white-space: nowrap; } }
    .quickCreateArrow { flex: 0 0 14px; width: 14px; height: 14px; color: var(--ui-text-secondary, #66756e); }
  }
  .quickMenu-enter-active, .quickMenu-leave-active { transition: opacity .22s ease-out, transform .22s ease-out; }
  .quickMenu-enter, .quickMenu-leave-to { opacity: 0; transform: translateY(10px); }
  .quickMenu-leave-active { pointer-events: none; }
  .quickMask-enter-active, .quickMask-leave-active { transition: opacity .22s ease-out; }
  .quickMask-enter, .quickMask-leave-to { opacity: 0; }
}
@media (min-width: 768px) { .mobileCreatePortal { display: none; } }
@media (prefers-reduced-motion: reduce) {
  .mobileCreatePortal .quickMenu-enter-active, .mobileCreatePortal .quickMenu-leave-active,
  .mobileCreatePortal .quickMask-enter-active, .mobileCreatePortal .quickMask-leave-active { transition: none; }
}
</style>
