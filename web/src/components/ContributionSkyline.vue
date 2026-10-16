<template>
  <section
    ref="card"
    class="skylineCard"
    :class="{ isDark: dark }"
    aria-label="过去一年的编辑活动"
  >
    <header class="skyHeader">
      <h3 class="skyTitle">
        过去一年共编辑 <strong>{{ stats.total.toLocaleString('zh-CN') }}</strong> 次
      </h3>
      <div class="skyToggle" role="radiogroup" aria-label="视图切换">
        <span class="skyThumb" :class="{ right: mode === '3d' }"></span>
        <button
          type="button"
          role="radio"
          :aria-checked="mode === '2d' ? 'true' : 'false'"
          title="平面热力图"
          aria-label="平面热力图"
          :class="{ active: mode === '2d' }"
          @click="setMode('2d')"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.2" />
            <rect x="9" y="1.5" width="5.5" height="5.5" rx="1.2" />
            <rect x="1.5" y="9" width="5.5" height="5.5" rx="1.2" />
            <rect x="9" y="9" width="5.5" height="5.5" rx="1.2" />
          </svg>
        </button>
        <button
          type="button"
          role="radio"
          :aria-checked="mode === '3d' ? 'true' : 'false'"
          title="3D 天际线"
          aria-label="3D 天际线"
          :class="{ active: mode === '3d' }"
          @click="setMode('3d')"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M8 1.5 14 4.8v6.4L8 14.5 2 11.2V4.8z" fill="none" stroke-width="1.4" stroke-linejoin="round" />
            <path d="M2 4.8 8 8l6-3.2M8 8v6.5" fill="none" stroke-width="1.4" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
    </header>

    <div ref="stage" class="skyStage" :style="{ height: stageHeight + 'px' }">
      <canvas
        ref="canvas"
        class="skyCanvas"
        tabindex="0"
        role="img"
        :aria-label="canvasLabel"
        :class="{ grab: progress > 0.5, dragging: dragging }"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @pointerleave="onPointerLeave"
        @dblclick="resetView"
        @keydown="onKeydown"
        @blur="onBlur"
      ></canvas>

      <template v-if="floatStats">
        <div class="floatStats top" :style="{ opacity: topStatAlpha }">
          <div class="statItem">
            <span class="statLabel">一年总计</span>
            <span class="statValue">{{ stats.total.toLocaleString('zh-CN') }}<small>次</small></span>
            <span class="statSub">{{ rangeText }}</span>
          </div>
          <div class="statItem">
            <span class="statLabel">最忙的一天</span>
            <span class="statValue">{{ stats.busiest.count }}<small>次</small></span>
            <span class="statSub">{{ shortDate(stats.busiest.date) }}</span>
          </div>
        </div>
        <div class="floatStats bottom" :style="{ opacity: bottomStatAlpha }">
          <div class="statItem">
            <span class="statLabel">最长连续</span>
            <span class="statValue">{{ stats.longest.days }}<small>天</small></span>
            <span class="statSub">{{ streakText(stats.longest) }}</span>
          </div>
          <div class="statItem">
            <span class="statLabel">当前连续</span>
            <span class="statValue">{{ stats.current.days }}<small>天</small></span>
            <span class="statSub">{{ streakText(stats.current) }}</span>
          </div>
        </div>
      </template>

      <div
        v-show="tooltip.visible"
        ref="tooltip"
        class="skyTooltip"
        role="status"
        :style="{ left: tooltip.x + 'px', top: tooltip.y + 'px' }"
        :class="{ below: tooltip.below }"
      >
        {{ tooltip.text }}
        <span class="skyArrow" :style="{ left: tooltip.arrow + 'px' }"></span>
      </div>
    </div>

    <div class="statsRow" :class="{ collapsed: floatStats }" :aria-hidden="floatStats ? 'true' : 'false'">
      <div class="statItem">
        <span class="statLabel">一年总计</span>
        <span class="statValue">{{ stats.total.toLocaleString('zh-CN') }}<small>次</small></span>
        <span class="statSub">{{ rangeText }}</span>
      </div>
      <div class="statItem">
        <span class="statLabel">最忙的一天</span>
        <span class="statValue">{{ stats.busiest.count }}<small>次</small></span>
        <span class="statSub">{{ shortDate(stats.busiest.date) }}</span>
      </div>
      <div class="statItem">
        <span class="statLabel">最长连续</span>
        <span class="statValue">{{ stats.longest.days }}<small>天</small></span>
        <span class="statSub">{{ streakText(stats.longest) }}</span>
      </div>
      <div class="statItem">
        <span class="statLabel">当前连续</span>
        <span class="statValue">{{ stats.current.days }}<small>天</small></span>
        <span class="statSub">{{ streakText(stats.current) }}</span>
      </div>
    </div>

    <footer class="skyFooter">
      <div class="skyHints">
        <span :style="{ opacity: 1 - progress }">悬停查看当天详情 · 方向键浏览</span>
        <span :style="{ opacity: progress }">拖动旋转视角 · 双击重置</span>
      </div>
      <div class="skyLegend" aria-label="图例">
        <span class="legendText">少</span>
        <button
          v-for="lv in 5"
          :key="lv"
          type="button"
          class="legendSwatch"
          :class="{ active: isolate === lv - 1 }"
          :title="levelNames[lv - 1]"
          :aria-label="'只看：' + levelNames[lv - 1]"
          :aria-pressed="pinnedIsolate === lv - 1 ? 'true' : 'false'"
          :style="{ background: swatchCss(lv - 1) }"
          @mouseenter="hoverIsolate = lv - 1"
          @mouseleave="hoverIsolate = null"
          @focus="hoverIsolate = lv - 1"
          @blur="hoverIsolate = null"
          @click="togglePinnedIsolate(lv - 1)"
        ></button>
        <span class="legendText">多</span>
      </div>
    </footer>
    <p v-if="note" class="skyNote">{{ note }}</p>
  </section>
</template>

<script>
import {
  PALETTES,
  LEVEL_NAMES,
  buildGrid,
  computeStats,
  monthLabels,
  barHeight,
  riseAt,
  camera,
  project,
  depthOf,
  lerp,
  clamp,
  easeInOutCubic,
  smoothstep,
  hexToRgb,
  rgbToCss,
  mixRgb,
  shadeRgb,
  emptyColor,
  formatShortDate,
  formatLongDate,
  formatTooltip,
  todayMs
} from '@/utils/contributionSkyline'

const DURATION = 1300
const THEMES = {
  light: { bg: '#ffffff', fg: '#1f2328' },
  dark: { bg: '#1f2329', fg: '#e6e8eb' }
}
const WEEKDAY_ROWS = { 0: '一', 2: '三', 4: '五' }

function pointInPoly(px, py, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0]
    const yi = poly[i][1]
    const xj = poly[j][0]
    const yj = poly[j][1]
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export default {
  name: 'ContributionSkyline',
  props: {
    data: { type: Array, default: () => [] },
    endDate: { type: [Number, String], default: null },
    weekStart: { type: Number, default: 1 },
    palette: { type: String, default: 'github' },
    note: { type: String, default: '' }
  },
  data() {
    return {
      mode: '3d',
      progress: 0,
      width: 0,
      stageHeight: 200,
      dark: false,
      dYaw: 0,
      dElev: 0,
      dragging: false,
      activeIndex: -1,
      pinned: false,
      hoverIsolate: null,
      pinnedIsolate: null,
      tooltip: { visible: false, x: 0, y: 0, arrow: 0, text: '', below: false },
      levelNames: LEVEL_NAMES,
      colors: null
    }
  },
  computed: {
    endMs() {
      return this.endDate == null ? todayMs() : this.endDate
    },
    grid() {
      return buildGrid(this.data, this.endMs, this.weekStart)
    },
    stats() {
      return computeStats(this.grid.cells, this.endMs)
    },
    months() {
      return monthLabels(this.grid.cells)
    },
    isolate() {
      return this.hoverIsolate != null ? this.hoverIsolate : this.pinnedIsolate
    },
    floatStats() {
      return this.mode === '3d' && this.width >= 560
    },
    topStatAlpha() {
      return smoothstep(0.55, 0.8, this.progress)
    },
    bottomStatAlpha() {
      return smoothstep(0.65, 0.9, this.progress)
    },
    rangeText() {
      const cells = this.grid.cells
      if (!cells.length) return ''
      return `${formatLongDate(cells[0].date)} — ${formatLongDate(cells[cells.length - 1].date)}`
    },
    canvasLabel() {
      return `编辑活动${this.mode === '3d' ? '三维天际线' : '平面热力图'}，过去一年共编辑 ${this.stats.total} 次，最长连续 ${this.stats.longest.days} 天，当前连续 ${this.stats.current.days} 天。使用方向键逐日浏览。`
    }
  },
  watch: {
    grid() {
      this.activeIndex = Math.min(this.activeIndex, this.grid.cells.length - 1)
      this.requestDraw()
    },
    isolate() {
      this.requestDraw()
    },
    palette() {
      this.retheme()
    }
  },
  mounted() {
    this.reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    this.dark = this.detectDark()
    this.colors = this.targetColors()
    this.anim = null
    this.raf = 0
    this.polys = []
    this.risen = false
    this.layout()
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.layout())
      this.resizeObserver.observe(this.$refs.card)
    } else {
      this.onWinResize = () => this.layout()
      window.addEventListener('resize', this.onWinResize)
    }
    this.themeObserver = new MutationObserver(() => {
      const next = this.detectDark()
      if (next !== this.dark) {
        this.dark = next
        this.retheme()
      }
    })
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
    this.themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    if (this.reduced) {
      this.risen = true
      this.progress = 1
      this.layout()
    } else if (typeof IntersectionObserver !== 'undefined') {
      this.io = new IntersectionObserver(
        entries => {
          if (!this.risen && entries.some(e => e.isIntersecting && e.intersectionRatio >= 0.35)) {
            this.risen = true
            this.animateTo(this.mode === '3d' ? 1 : 0)
            this.io.disconnect()
          }
        },
        { threshold: [0, 0.35, 0.6] }
      )
      this.io.observe(this.$refs.card)
    } else {
      this.risen = true
      this.animateTo(1)
    }
  },
  beforeDestroy() {
    cancelAnimationFrame(this.raf)
    if (this.resizeObserver) this.resizeObserver.disconnect()
    if (this.onWinResize) window.removeEventListener('resize', this.onWinResize)
    if (this.themeObserver) this.themeObserver.disconnect()
    if (this.io) this.io.disconnect()
  },
  methods: {
    shortDate: formatShortDate,
    streakText(s) {
      if (!s || !s.days) return '—'
      return s.start === s.end ? formatShortDate(s.start) : `${formatShortDate(s.start)} — ${formatShortDate(s.end)}`
    },
    detectDark() {
      const b = document.body.classList
      const h = document.documentElement.classList
      return b.contains('isDark') || h.contains('dark') || h.contains('isDark') || document.documentElement.getAttribute('data-theme') === 'dark'
    },
    targetColors() {
      const theme = this.dark ? THEMES.dark : THEMES.light
      const pal = PALETTES[this.palette] || PALETTES.github
      const levels = (this.dark ? pal.dark : pal.light).map(hexToRgb)
      return {
        bg: hexToRgb(theme.bg),
        fg: hexToRgb(theme.fg),
        levels: [emptyColor(theme.bg, theme.fg, this.dark)].concat(levels)
      }
    },
    retheme() {
      const from = this.colors || this.targetColors()
      const to = this.targetColors()
      if (this.reduced) {
        this.colors = to
        this.requestDraw()
        return
      }
      this.colorAnim = { from, to, start: performance.now(), dur: 420 }
      this.kick()
    },
    swatchCss(level) {
      if (!this.colors) return 'transparent'
      return rgbToCss(this.colors.levels[level])
    },
    setMode(mode) {
      if (mode === this.mode) return
      this.mode = mode
      this.risen = true
      this.animateTo(mode === '3d' ? 1 : 0)
    },
    animateTo(target) {
      if (this.reduced) {
        this.progress = target
        this.anim = null
        this.layout()
        return
      }
      this.anim = { from: this.progress, to: target, start: performance.now(), dur: DURATION * Math.max(0.25, Math.abs(target - this.progress)) }
      this.kick()
    },
    kick() {
      if (this.raf) return
      const step = now => {
        this.raf = 0
        let more = false
        if (this.anim) {
          const k = clamp((now - this.anim.start) / this.anim.dur, 0, 1)
          this.progress = lerp(this.anim.from, this.anim.to, k)
          if (k >= 1) this.anim = null
          else more = true
        }
        if (this.colorAnim) {
          const k = easeInOutCubic((now - this.colorAnim.start) / this.colorAnim.dur)
          const a = this.colorAnim.from
          const b = this.colorAnim.to
          this.colors = { bg: mixRgb(a.bg, b.bg, k), fg: mixRgb(a.fg, b.fg, k), levels: a.levels.map((c, i) => mixRgb(c, b.levels[i], k)) }
          if (k >= 1) this.colorAnim = null
          else more = true
        }
        this.updateStageHeight()
        this.draw()
        if (more) this.raf = requestAnimationFrame(step)
      }
      this.raf = requestAnimationFrame(step)
    },
    requestDraw() {
      if (this.raf) return
      this.$nextTick(() => this.draw())
    },
    layout() {
      const card = this.$refs.card
      if (!card) return
      this.width = this.$refs.stage.clientWidth || card.clientWidth
      this.updateStageHeight()
      this.$nextTick(() => this.draw())
    },
    heights() {
      const W = Math.max(1, this.width)
      const weeks = Math.max(1, this.grid.weeks)
      const cell = Math.min(18, (W - 34) / weeks)
      const h2 = Math.round(cell * 7 + 30)
      const natural = W * 0.56
      const h3 = Math.round(Math.max(240, Math.min(natural, W * 0.72, 620)))
      return { h2, h3 }
    },
    updateStageHeight() {
      const { h2, h3 } = this.heights()
      this.stageHeight = Math.round(lerp(h2, h3, easeInOutCubic(this.progress)))
    },
    // 单帧绘制：一个相机在 2D（俯视）与 3D（等距）之间插值。
    draw() {
      const canvas = this.$refs.canvas
      if (!canvas || !this.colors) return
      const W = Math.max(1, this.width)
      const H = Math.max(1, this.stageHeight)
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr)
        canvas.height = Math.round(H * dpr)
        canvas.style.width = W + 'px'
        canvas.style.height = H + 'px'
      }
      const ctx = canvas.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)
      const p = this.progress
      const e = easeInOutCubic(p)
      const cam = camera(e, this.dYaw, this.dElev)
      const { cells, weeks, max } = this.grid
      if (!cells.length) return
      const halfW = weeks / 2
      const ox = -halfW
      const oy = -3.5
      const maxH = barHeight(max, max, 1)
      // 适配舞台：投影网格外包围盒
      const corners = []
      ;[ox, ox + weeks].forEach(x => [oy, oy + 7].forEach(y => {
        corners.push(project(cam, x, y, 0))
        corners.push(project(cam, x, y, maxH * e + 0.7 * e))
      }))
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      corners.forEach(([x, y]) => {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x)
        minY = Math.min(minY, y); maxY = Math.max(maxY, y)
      })
      const padL = lerp(30, 16, e)
      const padR = lerp(4, 16, e)
      const padT = lerp(22, this.floatStats ? 70 : 16, e)
      const padB = lerp(4, this.floatStats ? 70 : 30, e)
      let scale = Math.min((W - padL - padR) / (maxX - minX), (H - padT - padB) / (maxY - minY))
      if (e < 0.02) scale = Math.min(scale, 18)
      const cx = padL + (W - padL - padR - (maxX - minX) * scale) / 2 - minX * scale
      const cy = padT + (H - padT - padB - (maxY - minY) * scale) / 2 - minY * scale
      const toScreen = (x, y, z) => {
        const q = project(cam, x, y, z)
        return [cx + q[0] * scale, cy + q[1] * scale]
      }
      const colors = this.colors
      const empty = colors.levels[0]
      const isolate = this.isolate
      const bw = lerp(0.78, 0.9, e)
      const inset = (1 - bw) / 2
      const radius = lerp(0.17, 0.03, e) * scale
      const order = cells.map((c, i) => i)
      order.sort((a, b) => {
        const ca = cells[a]
        const cb = cells[b]
        return depthOf(cam, ca.week + 0.5, ca.day + 0.5) - depthOf(cam, cb.week + 0.5, cb.day + 0.5)
      })
      const polys = new Array(cells.length)
      const fg = colors.fg
      order.forEach(i => {
        const c = cells[i]
        const active = i === this.activeIndex
        const rise = this.reduced ? e : riseAt(p, c.week, weeks, c.day)
        const h = Math.max(0.0001, barHeight(c.count, max, 1) * rise * (e > 0 ? 1 : 0))
        const lift = active ? 0.7 * e : 0
        const x0 = ox + c.week + inset
        const x1 = x0 + bw
        const y0 = oy + c.day + inset
        const y1 = y0 + bw
        let base = colors.levels[c.level]
        if (isolate != null && c.level !== isolate) base = mixRgb(base, empty, 0.72)
        if (active) base = mixRgb(base, fg, 0.16)
        const z0 = lift
        const z1 = lift + h
        const top = [toScreen(x0, y0, z1), toScreen(x1, y0, z1), toScreen(x1, y1, z1), toScreen(x0, y1, z1)]
        const list = [top]
        if (e > 0.01) {
          const left = [toScreen(x0, y1, z0), toScreen(x1, y1, z0), toScreen(x1, y1, z1), toScreen(x0, y1, z1)]
          const right = [toScreen(x1, y0, z0), toScreen(x1, y1, z0), toScreen(x1, y1, z1), toScreen(x1, y0, z1)]
          this.fillPoly(ctx, left, rgbToCss(shadeRgb(base, 0.84)))
          this.fillPoly(ctx, right, rgbToCss(shadeRgb(base, 0.68)))
          list.push(left, right)
        }
        this.roundPoly(ctx, top, radius)
        ctx.fillStyle = rgbToCss(base)
        ctx.fill()
        if (1 - e > 0.01) {
          ctx.strokeStyle = rgbToCss(fg, (1 - e) * 0.07)
          ctx.lineWidth = 1
          ctx.stroke()
        }
        if (active) {
          ctx.strokeStyle = rgbToCss(fg, 0.85)
          ctx.lineWidth = 1.5
          ctx.stroke()
        }
        polys[i] = list
      })
      this.polys = polys
      this.order = order
      this.drawLabels(ctx, e, toScreen, ox, oy, weeks)
      this.updateTooltip(toScreen, ox, oy, bw, inset, e, p)
    },
    fillPoly(ctx, pts, color) {
      ctx.beginPath()
      ctx.moveTo(pts[0][0], pts[0][1])
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1])
      ctx.closePath()
      ctx.fillStyle = color
      ctx.fill()
    },
    roundPoly(ctx, pts, r) {
      const n = pts.length
      ctx.beginPath()
      const mid = [(pts[n - 1][0] + pts[0][0]) / 2, (pts[n - 1][1] + pts[0][1]) / 2]
      ctx.moveTo(mid[0], mid[1])
      for (let i = 0; i < n; i++) {
        const a = pts[i]
        const b = pts[(i + 1) % n]
        const edge = Math.hypot(b[0] - a[0], b[1] - a[1])
        ctx.arcTo(a[0], a[1], b[0], b[1], Math.max(0, Math.min(r, edge / 2)))
      }
      ctx.closePath()
    },
    drawLabels(ctx, e, toScreen, ox, oy, weeks) {
      const fg = this.colors.fg
      ctx.font = '11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
      const a2 = clamp(1 - e * 2.2, 0, 1)
      if (a2 > 0.01) {
        ctx.fillStyle = rgbToCss(fg, 0.6 * a2)
        ctx.textBaseline = 'bottom'
        ctx.textAlign = 'left'
        this.months.forEach(m => {
          const [x, y] = toScreen(ox + m.week, oy, 0)
          ctx.fillText(m.label, x, y - 5)
        })
        ctx.textBaseline = 'middle'
        ctx.textAlign = 'right'
        Object.keys(WEEKDAY_ROWS).forEach(d => {
          const [x, y] = toScreen(ox, oy + Number(d) + 0.5, 0)
          ctx.fillText(WEEKDAY_ROWS[d], x - 6, y)
        })
      }
      const a3 = smoothstep(0.6, 1, e)
      if (a3 > 0.01) {
        ctx.fillStyle = rgbToCss(fg, 0.55 * a3)
        ctx.textBaseline = 'top'
        ctx.textAlign = 'center'
        this.months.forEach(m => {
          if (m.week > weeks - 2) return
          const [x, y] = toScreen(ox + m.week + 0.5, oy + 7.7, 0)
          ctx.fillText(m.label, x, y + 2)
        })
      }
    },
    updateTooltip(toScreen, ox, oy, bw, inset, e, p) {
      const i = this.activeIndex
      const cell = this.grid.cells[i]
      if (!cell) {
        this.tooltip.visible = false
        return
      }
      const rise = this.reduced ? e : riseAt(p, cell.week, this.grid.weeks, cell.day)
      const h = barHeight(cell.count, this.grid.max, 1) * rise * (e > 0 ? 1 : 0) + 0.7 * e
      const cxp = ox + cell.week + inset + bw / 2
      const cyp = oy + cell.day + inset + bw / 2
      const [sx, sy] = toScreen(cxp, cyp, h)
      const text = formatTooltip(cell)
      const canvas = this.$refs.canvas
      const offX = canvas ? canvas.offsetLeft : 0
      const offY = canvas ? canvas.offsetTop : 0
      const below = sy < 46
      const place = w => {
        const parent = this.$refs.tooltip && this.$refs.tooltip.offsetParent
        const W = parent ? parent.clientWidth : this.width + offX
        const ax = sx + offX
        const x = clamp(ax - w / 2, 4, Math.max(4, W - w - 4))
        this.tooltip = {
          visible: true,
          text,
          x,
          y: (below ? sy + 14 : sy - 40) + offY,
          below,
          arrow: clamp(ax - x, 10, w - 10)
        }
      }
      const el = this.$refs.tooltip
      place(el && el.offsetWidth ? el.offsetWidth : Math.max(90, text.length * 13 + 20))
      this.$nextTick(() => {
        const t = this.$refs.tooltip
        if (t && t.offsetWidth && this.activeIndex === i) place(t.offsetWidth)
      })
    },
    hitTest(px, py) {
      if (!this.order) return -1
      for (let k = this.order.length - 1; k >= 0; k--) {
        const i = this.order[k]
        const list = this.polys[i]
        if (list && list.some(poly => pointInPoly(px, py, poly))) return i
      }
      return -1
    },
    localPoint(ev) {
      const r = this.$refs.canvas.getBoundingClientRect()
      return [ev.clientX - r.left, ev.clientY - r.top]
    },
    setActive(i) {
      if (i === this.activeIndex) return
      this.activeIndex = i
      this.requestDraw()
    },
    onPointerDown(ev) {
      this.drag = { x: ev.clientX, y: ev.clientY, moved: false, yaw: this.dYaw, elev: this.dElev, type: ev.pointerType }
      if (this.progress > 0.5 && ev.target.setPointerCapture) ev.target.setPointerCapture(ev.pointerId)
    },
    onPointerMove(ev) {
      const d = this.drag
      if (d && this.progress > 0.5) {
        const dx = ev.clientX - d.x
        const dy = ev.clientY - d.y
        if (!d.moved && Math.hypot(dx, dy) > 4) d.moved = true
        if (d.moved) {
          this.dragging = true
          const DEG = Math.PI / 180
          this.dYaw = clamp(d.yaw - dx * 0.008, -45 * DEG, 37 * DEG)
          if (d.type === 'mouse') this.dElev = clamp(d.elev + dy * 0.006, -16 * DEG, 28 * DEG)
          this.requestDraw()
          return
        }
      }
      if (this.pinned) return
      const [x, y] = this.localPoint(ev)
      this.setActive(this.hitTest(x, y))
    },
    onPointerUp(ev) {
      const d = this.drag
      this.drag = null
      this.dragging = false
      if (d && !d.moved) {
        const [x, y] = this.localPoint(ev)
        const i = this.hitTest(x, y)
        if (i >= 0 && (i !== this.activeIndex || !this.pinned)) {
          this.pinned = true
          this.setActive(i)
        } else {
          this.pinned = false
          this.setActive(i)
        }
      }
    },
    onPointerLeave() {
      if (this.drag && this.drag.moved) return
      if (!this.pinned) this.setActive(-1)
    },
    onBlur() {
      if (!this.pinned) this.setActive(-1)
    },
    resetView() {
      this.dYaw = 0
      this.dElev = 0
      this.requestDraw()
    },
    togglePinnedIsolate(level) {
      this.pinnedIsolate = this.pinnedIsolate === level ? null : level
    },
    onKeydown(ev) {
      const n = this.grid.cells.length
      let i = this.activeIndex < 0 ? n - 1 : this.activeIndex
      switch (ev.key) {
        case 'ArrowLeft': i -= 7; break
        case 'ArrowRight': i += 7; break
        case 'ArrowUp': i -= 1; break
        case 'ArrowDown': i += 1; break
        case 'Home': i = 0; break
        case 'End': i = n - 1; break
        case 'Escape':
          this.pinned = false
          this.setActive(-1)
          return
        case 'Enter':
          this.pinned = !this.pinned
          if (this.activeIndex < 0) this.setActive(n - 1)
          ev.preventDefault()
          return
        default:
          return
      }
      ev.preventDefault()
      this.pinned = true
      this.setActive(clamp(i, 0, n - 1))
    }
  }
}
</script>

<style lang="less" scoped>
.skylineCard {
  --sky-bg: #ffffff;
  --sky-fg: #1f2328;
  --sky-muted: #6b7280;
  --sky-border: #e5e7eb;
  --sky-accent: #239a3b;
  --sky-soft: #f3f4f6;
  position: relative;
  background: var(--sky-bg);
  color: var(--sky-fg);
  border: 1px solid var(--sky-border);
  border-radius: 14px;
  padding: 18px 20px 14px;
  transition: background 0.4s, color 0.4s, border-color 0.4s;
  &.isDark {
    --sky-bg: #1f2329;
    --sky-fg: #e6e8eb;
    --sky-muted: #9aa0a6;
    --sky-border: #3a3d42;
    --sky-accent: #39d353;
    --sky-soft: #2a2e34;
  }
}
.skyHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.skyTitle {
  margin: 0;
  font-size: 15px;
  font-weight: 500;
  strong {
    font-weight: 700;
  }
}
.skyToggle {
  position: relative;
  display: inline-flex;
  padding: 3px;
  border-radius: 9px;
  background: var(--sky-soft);
  border: 1px solid var(--sky-border);
  button {
    position: relative;
    z-index: 1;
    width: 34px;
    height: 26px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--sky-muted);
    cursor: pointer;
    transition: color 0.2s;
    svg {
      fill: currentColor;
      stroke: currentColor;
    }
    svg path {
      fill: none;
    }
    &.active {
      color: var(--sky-fg);
    }
    &:focus-visible {
      outline: 2px solid var(--sky-accent);
      outline-offset: 1px;
    }
  }
}
.skyThumb {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 34px;
  height: 26px;
  border-radius: 6px;
  background: var(--sky-bg);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.14);
  transition: transform 0.28s cubic-bezier(0.65, 0, 0.35, 1);
  &.right {
    transform: translateX(34px);
  }
}
.skyStage {
  position: relative;
  width: 100%;
  overflow: hidden;
}
.skyCanvas {
  display: block;
  outline: none;
  touch-action: pan-y;
  &.grab {
    cursor: grab;
  }
  &.dragging {
    cursor: grabbing;
  }
  &:focus-visible {
    box-shadow: inset 0 0 0 2px var(--sky-accent);
    border-radius: 8px;
  }
}
.floatStats {
  position: absolute;
  display: flex;
  gap: 28px;
  pointer-events: none;
  &.top {
    top: 4px;
    right: 6px;
    text-align: right;
  }
  &.bottom {
    bottom: 4px;
    left: 6px;
  }
}
.statItem {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.statLabel {
  font-size: 12px;
  color: var(--sky-muted);
}
.statValue {
  font-size: 24px;
  font-weight: 700;
  line-height: 1.15;
  color: var(--sky-accent);
  font-variant-numeric: tabular-nums;
  small {
    font-size: 12px;
    font-weight: 500;
    margin-left: 2px;
    color: var(--sky-muted);
  }
}
.statSub {
  font-size: 11px;
  color: var(--sky-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.statsRow {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  max-height: 90px;
  overflow: hidden;
  margin-top: 10px;
  padding-top: 12px;
  border-top: 1px solid var(--sky-border);
  transition: max-height 0.35s ease, opacity 0.3s ease, margin 0.35s, padding 0.35s;
  .statValue {
    font-size: 20px;
  }
  &.collapsed {
    max-height: 0;
    opacity: 0;
    margin-top: 0;
    padding-top: 0;
    border-top-color: transparent;
  }
}
@media (max-width: 520px) {
  .statsRow {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    max-height: 170px;
  }
}
.skyTooltip {
  position: absolute;
  z-index: 3;
  white-space: nowrap;
  pointer-events: none;
  padding: 6px 10px;
  border-radius: 999px;
  font-size: 12px;
  color: #fff;
  background: rgba(24, 27, 31, 0.94);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2);
  .isDark & {
    background: rgba(246, 247, 248, 0.96);
    color: #1f2328;
  }
}
.skyArrow {
  position: absolute;
  bottom: -5px;
  width: 10px;
  height: 10px;
  margin-left: -5px;
  background: inherit;
  transform: rotate(45deg);
  border-radius: 2px;
  .below & {
    bottom: auto;
    top: -5px;
  }
}
.skyFooter {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
  font-size: 12px;
  color: var(--sky-muted);
}
.skyHints {
  position: relative;
  flex: 1;
  min-height: 18px;
  span {
    position: absolute;
    left: 0;
    top: 0;
    white-space: nowrap;
  }
}
.skyLegend {
  display: flex;
  align-items: center;
  gap: 4px;
}
.legendText {
  margin: 0 3px;
}
.legendSwatch {
  width: 12px;
  height: 12px;
  padding: 0;
  border: 0;
  border-radius: 3px;
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s;
  &.active,
  &:hover {
    transform: scale(1.25);
    box-shadow: 0 0 0 1.5px var(--sky-fg);
  }
  &:focus-visible {
    outline: 2px solid var(--sky-accent);
    outline-offset: 1px;
  }
}
.skyNote {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--sky-muted);
}
</style>
