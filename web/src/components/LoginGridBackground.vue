<template>
  <div class="loginGridBackground" aria-hidden="true" :data-grid-state="gridState">
    <canvas ref="source" class="loginGridSource"></canvas>
    <div ref="content" class="loginGridContent"></div>
    <canvas ref="output" class="loginGridOutput"></canvas>
  </div>
</template>

<script>
// Decoration only: authentication controls never enter HTML-in-Canvas.
export default {
  name: 'LoginGridBackground',
  data: () => ({ gridState: 'static' }),
  mounted() {
    this.gridDisposed = false
    this.gridGeneration = 0
    this.gridMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    this.gridPointer = window.matchMedia('(pointer: coarse)')
    this.gridSync = () => this.syncGrid()
    for (const query of [this.gridMotion, this.gridPointer]) {
      if (query.addEventListener) query.addEventListener('change', this.gridSync)
      else query.addListener(this.gridSync)
    }
    document.addEventListener('visibilitychange', this.gridSync)
    this.$refs.output.addEventListener('webglcontextlost', this.onContextLost)
    this.gridTimer = setTimeout(this.gridSync, 0)
  },
  beforeDestroy() {
    this.gridDisposed = true
    clearTimeout(this.gridTimer)
    this.stopGrid()
    for (const query of [this.gridMotion, this.gridPointer]) {
      if (query.removeEventListener) query.removeEventListener('change', this.gridSync)
      else query.removeListener(this.gridSync)
    }
    document.removeEventListener('visibilitychange', this.gridSync)
    this.$refs.output.removeEventListener('webglcontextlost', this.onContextLost)
  },
  methods: {
    stopGrid() {
      this.gridGeneration++
      if (this.gridInstance) this.gridInstance.destroy()
      this.gridInstance = null
      this.gridState = 'static'
    },
    onContextLost() {
      this.gridFailed = true
      this.stopGrid()
    },
    async syncGrid() {
      if (this.gridDisposed) return
      if (document.hidden || this.gridMotion.matches || this.gridPointer.matches || this.gridFailed ||
        !window.ResizeObserver || !window.IntersectionObserver) {
        this.stopGrid()
        return
      }
      if (this.gridInstance || this.gridState === 'loading') return
      const generation = ++this.gridGeneration
      this.gridState = 'loading'
      try {
        const { createGrid } = await import(/* webpackChunkName: "login-grid" */ './canvasui/grid')
        if (this.gridDisposed || generation !== this.gridGeneration) return
        this.gridInstance = createGrid({
          source: this.$refs.source,
          content: this.$refs.content,
          output: this.$refs.output,
          listenTarget: this.$el.parentElement
        }, {
          captureHtml: false,
          tileSize: 72,
          gap: 1,
          cornerRadius: 3,
          amplitude: 0.85,
          waveWidth: 0.08,
          fadeTime: 0.32,
          liftHeight: 22,
          tilt: 0.12,
          shading: 0.13,
          tint: [0.04, 0.42, 0.30],
          tintStrength: 0.16,
          idleRipples: 0
        })
        if (!this.gridInstance) this.gridFailed = true
        this.gridState = this.gridInstance ? 'active' : 'static'
      } catch (err) {
        // An unavailable GPU/chunk must never prevent QR refresh or SSO.
        this.gridFailed = true
        this.stopGrid()
      }
    }
  }
}
</script>

<style scoped>
.loginGridBackground {
  position: fixed;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
  background-image:
    linear-gradient(rgba(10, 90, 65, 0.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(10, 90, 65, 0.035) 1px, transparent 1px);
  background-size: 72px 72px;
  mask-image: radial-gradient(ellipse at center, transparent 15%, #000 85%);
}
.loginGridSource { display: none; }
.loginGridContent,
.loginGridOutput { position: absolute; inset: 0; width: 100%; height: 100%; }
.loginGridOutput { opacity: 0.65; }
.loginGridBackground[data-grid-state="static"] .loginGridOutput { visibility: hidden; }
@media (prefers-color-scheme: dark) {
  .loginGridBackground {
    background-image:
      linear-gradient(rgba(100, 180, 150, 0.07) 1px, transparent 1px),
      linear-gradient(90deg, rgba(100, 180, 150, 0.07) 1px, transparent 1px);
  }
}
@media (prefers-reduced-motion: reduce), (pointer: coarse) {
  .loginGridOutput { display: none; }
}
</style>
