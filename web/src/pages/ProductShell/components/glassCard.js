import { shellTheme } from '@/utils/shellTheme'

// 玻璃卡片共用的舞台尺寸：按 340×272 设计，整体按卡片实际宽度缩放
export const STAGE_W = 340
export const STAGE_H = 272

// transform: scale() 会把舞台先按 340 宽栅格化再缩小，文字和细线发糊；zoom 直接按实际尺寸排版绘制
const SUPPORTS_ZOOM =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('zoom', '0.5')

export function reducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
}

// 测量宽度、首次进入视口时的入场、指针视差（写 --gf-px / --gf-py，不触发重渲染）
export default {
  data() {
    return {
      width: 260,
      entered: false
    }
  },
  computed: {
    k() {
      return this.width / STAGE_W
    },
    rootHeight() {
      return Math.round(STAGE_H * this.k)
    },
    stageStyle() {
      return SUPPORTS_ZOOM ? { zoom: this.k } : { transform: `scale(${this.k})` }
    },
    tone() {
      return shellTheme.theme === 'dark' ? 'dark' : 'light'
    },
    // 按 0.25 取整，窗口微调时命中同一份缓存，不会每次都重绘
    density() {
      const dpr = Math.min(1.5, Math.max(1, window.devicePixelRatio || 1))
      return Math.max(0.5, Math.ceil(dpr * this.k * 4) / 4)
    }
  },
  mounted() {
    this.measure()
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.measure())
      this.resizeObserver.observe(this.$el)
    }
    this.observeEntrance()
  },
  beforeDestroy() {
    if (this.resizeObserver) this.resizeObserver.disconnect()
    if (this.entranceObserver) this.entranceObserver.disconnect()
    clearTimeout(this.entranceTimer)
    cancelAnimationFrame(this.pointerFrame)
  },
  methods: {
    measure() {
      const w = this.$el.clientWidth
      if (w > 0 && Math.abs(w - this.width) > 0.5) this.width = w
    },
    observeEntrance() {
      if (typeof IntersectionObserver === 'undefined' || reducedMotion()) {
        this.entered = true
        return
      }
      const index = Number(getComputedStyle(this.$el).getPropertyValue('--i')) || 0
      this.entranceObserver = new IntersectionObserver(
        entries => {
          if (!entries.some(entry => entry.isIntersecting)) return
          this.entranceObserver.disconnect()
          this.entranceTimer = setTimeout(() => {
            this.entered = true
          }, Math.min(index, 12) * 60)
        },
        { threshold: 0.2 }
      )
      this.entranceObserver.observe(this.$el)
    },
    onPointerMove(event) {
      if (event.pointerType === 'touch') return
      const rect = this.$el.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      this.pointer = {
        x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
        y: ((event.clientY - rect.top) / rect.height) * 2 - 1
      }
      this.schedulePointer()
    },
    onPointerLeave() {
      this.pointer = { x: 0, y: 0 }
      this.schedulePointer()
    },
    schedulePointer() {
      if (this.pointerFrame) return
      this.pointerFrame = requestAnimationFrame(() => {
        this.pointerFrame = 0
        const { x, y } = this.pointer || { x: 0, y: 0 }
        this.$el.style.setProperty('--gf-px', x.toFixed(3))
        this.$el.style.setProperty('--gf-py', y.toFixed(3))
      })
    }
  }
}
