<template>
  <aside ref="rail" class="attachmentThumbnailRail" aria-label="页面缩略图">
    <button v-for="n in count" :key="n" type="button" :data-thumbnail="n" :class="{ active: n === active }" :aria-label="'跳转到第 ' + n + ' 页'" :aria-current="n === active ? 'page' : null" @click="$emit('select', n)">
      <span class="attachmentThumbnail" :data-thumbnail-content="n"></span><span class="attachmentThumbnailNumber">{{ n }}</span>
    </button>
  </aside>
</template>
<script>
export default {
  props: { count: Number, active: Number, renderThumbnail: Function },
  mounted() {
    this._handles = new Map()
    this._visible = new Set()
    this._observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        const n = Number(entry.target.dataset.thumbnail)
        if (entry.isIntersecting) this._visible.add(n)
        else { this._visible.delete(n); this.release(n) }
      })
      this.renderVisible()
    }, { root: this.$refs.rail, rootMargin: '100px' })
    this.$refs.rail.querySelectorAll('button').forEach(button => this._observer.observe(button))
  },
  watch: {
    active(n) {
      const button = this.$refs.rail.querySelector('[data-thumbnail="' + n + '"]')
      if (button) button.scrollIntoView({ block: 'nearest' })
    }
  },
  beforeDestroy() {
    this._disposed = true
    if (this._observer) this._observer.disconnect()
    for (const n of this._handles.keys()) this.release(n)
  },
  methods: {
    release(n) {
      const handle = this._handles.get(n)
      if (handle && handle.dispose) handle.dispose()
      this._handles.delete(n)
      const target = this.$refs.rail && this.$refs.rail.querySelector('[data-thumbnail-content="' + n + '"]')
      if (target) target.replaceChildren()
    },
    async renderVisible() {
      if (this._busy || this._disposed) return
      this._busy = true
      try {
        for (const n of this._visible) {
          if (this._disposed) break
          if (this._handles.has(n)) continue
          const target = this.$refs.rail.querySelector('[data-thumbnail-content="' + n + '"]')
          try {
            const handle = await this.renderThumbnail(n, target)
            if (this._disposed || !this._visible.has(n)) {
              if (handle && handle.dispose) handle.dispose()
              target.replaceChildren()
            } else this._handles.set(n, handle || {})
          } catch (error) { if (!this._disposed) { target.textContent = '预览不可用'; this._handles.set(n, {}) } }
        }
      } finally { this._busy = false }
    }
  }
}
</script>
