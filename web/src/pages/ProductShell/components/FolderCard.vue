<template
  ><article
    class="folderCard gf-root"
    :class="{ selected, selectable }"
    role="button"
    tabindex="0"
    :aria-label="`打开文件夹 ${folder.name}，${itemCountText}`"
    :data-tone="tone"
    :data-open="opening || undefined"
    :style="cardStyle"
    @keydown.enter.self="activate"
    @click="activate"
    @pointermove="onPointerMove"
    @pointerleave="onPointerLeave"
  >
    <label
      v-if="selectable"
      class="selectBox"
      @click.stop
    >
      <el-checkbox
        :value="selected"
        :disabled="!canSelect"
        @change="$emit('toggle-select', folder)"
      />
    </label>
    <div class="folderCardMedia">
      <div class="folderCardArtField" :style="mobileArtStyle">
        <div class="gf-stage" :style="stageStyle">
          <div class="gf-tilt">
            <div class="gf-shadow" aria-hidden="true" />

            <div class="gf-back" :style="{ clipPath: backClip }" aria-hidden="true">
              <canvas
                v-if="!plain"
                ref="art"
                class="gf-art"
                :data-ready="artReady || undefined"
                :style="{ width: artW + 'px', height: artH + 'px' }"
              />
              <div class="gf-back-sheen" />
            </div>

            <div class="gf-files" aria-hidden="true">
              <div
                v-for="sheet in sheets"
                :key="sheet.key"
                class="gf-sheet"
                :class="{ 'gf-sheet--art': sheet.art }"
                :style="sheet.style"
              >
                <canvas
                  v-if="sheet.art"
                  ref="sheetArt"
                  class="gf-sheet-art"
                  :data-ready="artReady || undefined"
                  :style="{ width: SHEET_W + 'px', height: SHEET_H + 'px' }"
                />
              </div>
            </div>

            <div class="gf-front" :style="{ clipPath: frontClip }">
              <div class="gf-tint" aria-hidden="true" />
              <div class="gf-spec" aria-hidden="true" />
              <svg class="gf-rim gf-front-rim" :viewBox="`0 0 ${W} ${FRONT_H}`" aria-hidden="true">
                <path :d="frontPath" />
              </svg>
              <div class="gf-label">
                <strong class="gf-title"
                  ><InlineTitle
                    :value="folder.name"
                    :editable="editable && !selectable"
                    @open="activate"
                    @rename="$emit('rename-inline', folder, $event)"
                /></strong>
                <span class="gf-meta">{{ itemCountText }} · {{ dateText }}</span>
              </div>
            </div>

            <el-dropdown
              v-if="allowShare || editable"
              class="gf-keyWrap"
              trigger="click"
              @command="$emit($event, folder)"
              @click.native.stop
            >
              <button type="button" class="gf-key" :aria-label="`${folder.name} 更多操作`">
                <svg class="gf-glyph" viewBox="0 0 30 8" aria-hidden="true">
                  <circle cx="4" cy="4" r="3" />
                  <circle cx="15" cy="4" r="3" />
                  <circle cx="26" cy="4" r="3" />
                </svg>
              </button>
              <el-dropdown-menu slot="dropdown"
                ><el-dropdown-item v-if="isMobileViewport && editable" command="rename-request">重命名</el-dropdown-item
                ><el-dropdown-item v-if="allowShare" command="share">分享 / 权限</el-dropdown-item
                ><el-dropdown-item v-if="editable" command="delete" divided
                  >删除</el-dropdown-item
                ></el-dropdown-menu
              >
            </el-dropdown>
          </div>
        </div>
      </div>
    </div>
    <div class="cardInfo folderCardInfo">
      <div class="cardInfoText">
        <strong class="cardInfoTitle"
          ><InlineTitle
            :value="folder.name"
            :editable="editable && !selectable"
            @open="activate"
            @rename="$emit('rename-inline', folder, $event)"
        /></strong>
        <span class="cardInfoMeta">{{ itemCountText }} · {{ dateText }}</span>
      </div>
      <el-dropdown
        v-if="allowShare || editable"
        class="cardInfoActions"
        trigger="click"
        @command="$emit($event, folder)"
        @click.native.stop
      >
        <button
          type="button"
          class="cardMoreButton"
          :aria-label="`${folder.name} 更多操作`"
        >
          <svg class="cardMoreGlyph" viewBox="0 0 30 8" aria-hidden="true">
            <circle cx="4" cy="4" r="3" />
            <circle cx="15" cy="4" r="3" />
            <circle cx="26" cy="4" r="3" />
          </svg>
        </button>
        <el-dropdown-menu slot="dropdown"
          ><el-dropdown-item v-if="editable" command="rename-request">重命名</el-dropdown-item
          ><el-dropdown-item v-if="allowShare" command="share">分享 / 权限</el-dropdown-item
          ><el-dropdown-item v-if="editable" command="delete" divided
            >删除</el-dropdown-item
          ></el-dropdown-menu
        >
      </el-dropdown>
    </div>
  </article></template
>
<script>
import InlineTitle from './InlineTitle.vue'
import mobileViewport from '@/utils/mobileViewport'
import glassCard, { STAGE_W as W, STAGE_H as H, reducedMotion } from './glassCard'
import { artForKey, hashString, paintArt, rng } from './glassFolderArt'
import { fitFolderStageToWidth } from './mobileFolderLayout'

const FRONT_H = H - 74
const ART_PAD = 24
const SHEET_W = 272
const SHEET_H = 184
const MAX_SHEETS = 3
const OPEN_DELAY = 320

const BACK_PATH =
  'M0 56A22 22 0 0 1 22 34L146 34C170 34 172 0 198 0L318 0A22 22 0 0 1 340 22L340 250A22 22 0 0 1 318 272L22 272A22 22 0 0 1 0 250Z'
const FRONT_PATH =
  'M0 22A22 22 0 0 1 22 0L118 0C144 0 146 32 172 32L318 32A22 22 0 0 1 340 54L340 ' +
  (FRONT_H - 22) +
  'A22 22 0 0 1 318 ' +
  FRONT_H +
  'L22 ' +
  FRONT_H +
  'A22 22 0 0 1 0 ' +
  (FRONT_H - 22) +
  'Z'

export default {
  name: 'FolderCard',
  components: { InlineTitle },
  mixins: [glassCard, mobileViewport],
  props: {
    folder: Object,
    editable: { type: Boolean, default: true },
    allowShare: { type: Boolean, default: true },
    selectable: { type: Boolean, default: false },
    selected: { type: Boolean, default: false },
    canSelect: { type: Boolean, default: true }
  },
  data() {
    return {
      W,
      H,
      FRONT_H,
      SHEET_W,
      SHEET_H,
      frontPath: FRONT_PATH,
      opening: false,
      artReady: false
    }
  },
  computed: {
    backClip() {
      return `path('${BACK_PATH}')`
    },
    frontClip() {
      return `path('${FRONT_PATH}')`
    },
    mobileCardLayout() {
      return fitFolderStageToWidth(this.width)
    },
    mobileArtLayout() {
      return fitFolderStageToWidth(this.width + 2)
    },
    cardStyle() {
      return {
        height:
          (this.isMobileViewport
            ? this.mobileCardLayout.height
            : this.rootHeight) + 'px'
      }
    },
    mobileArtStyle() {
      if (!this.isMobileViewport) return {}
      return {
        width: `${this.mobileArtLayout.width.toFixed(2)}px`,
        height: `${this.mobileArtLayout.height.toFixed(2)}px`
      }
    },
    stageStyle() {
      if (!this.isMobileViewport) {
        return glassCard.computed.stageStyle.call(this)
      }
      return {
        zoom: 1,
        width: `${W}px`,
        height: `${H}px`,
        transform: `scale(${this.mobileArtLayout.scale.toFixed(6)})`,
        transformOrigin: '0 0'
      }
    },
    artW() {
      return W + ART_PAD
    },
    artH() {
      return H + ART_PAD
    },
    artKey() {
      return String(this.folder.id || this.folder.name || '')
    },
    art() {
      return artForKey(this.artKey)
    },
    plain() {
      return this.art.plain && this.count > 0
    },
    count() {
      return (
        Number(this.folder.itemCount != null ? this.folder.itemCount : this.folder.roomCount) || 0
      )
    },
    itemCountText() {
      return this.count ? `${this.count} 个项目` : '空文件夹'
    },
    dateText() {
      return new Date(this.folder.updatedAt).toLocaleDateString('zh-CN')
    },
    sheets() {
      const n = Math.min(this.count, MAX_SHEETS)
      const base = hashString(this.artKey)
      return Array.from({ length: n }, (_, i) => {
        const jitter = rng(base + i * 101)
        return {
          key: i,
          style: {
            '--gf-slot': n <= 1 ? 0 : (i / (n - 1)) * 2 - 1,
            '--gf-depth': n - 1 - i,
            '--gf-jx': ((jitter() - 0.5) * 10).toFixed(2) + 'px',
            '--gf-jr': ((jitter() - 0.5) * 3.2).toFixed(2) + 'deg',
            zIndex: i + 1
          },
          art: this.plain && i === n - 1
        }
      })
    }
  },
  watch: {
    artKey() {
      this.artReady = false
      this.$nextTick(this.paint)
    },
    plain() {
      this.artReady = false
      this.$nextTick(this.paint)
    },
    density() {
      this.paint()
    }
  },
  mounted() {
    this.paint()
  },
  beforeDestroy() {
    clearTimeout(this.openTimer)
    this.paintSeq = (this.paintSeq || 0) + 1
  },
  methods: {
    measure() {
      const width = this.$el ? this.$el.getBoundingClientRect().width : 0
      if (width > 0 && Math.abs(width - this.width) > 0.5) this.width = width
    },
    paint() {
      const seq = (this.paintSeq = (this.paintSeq || 0) + 1)
      const { recipe, seed } = this.art
      const onSheet = this.plain
      const density = onSheet ? Math.min(this.density, 1.25) : this.density
      const pw = Math.round((onSheet ? SHEET_W : this.artW) * density)
      const ph = Math.round((onSheet ? SHEET_H : this.artH) * density)
      paintArt(recipe, seed, pw, ph).then(src => {
        const canvas = onSheet ? (this.$refs.sheetArt || [])[0] : this.$refs.art
        if (seq !== this.paintSeq || !canvas) return
        canvas.width = src.width
        canvas.height = src.height
        const ctx = canvas.getContext('2d')
        if (ctx) ctx.drawImage(src, 0, 0)
        this.artReady = true
      })
    },
    activate() {
      if (this.opening) return
      if (this.selectable || reducedMotion()) {
        this.$emit('open', this.folder)
        return
      }
      this.opening = true
      this.openTimer = setTimeout(() => {
        this.opening = false
        this.$emit('open', this.folder)
      }, OPEN_DELAY)
    }
  }
}
</script>
<style lang="less" scoped>
.gf-root {
  --gf-px: 0;
  --gf-py: 0;
  --gf-ease: cubic-bezier(0.2, 0.8, 0.2, 1);
  --gf-spring: cubic-bezier(0.34, 1.36, 0.5, 1);
  --gf-hinge: 0deg;
  --gf-lift: 42px;
  --gf-spread: 0px;
  --gf-fan: 0deg;
  --gf-stack: 15px;
  --gf-ink: #141416;
  --gf-ink-soft: rgba(20, 20, 22, 0.72);
  position: relative;
  display: block;
  min-width: 0;
  cursor: pointer;
  outline: none;
  isolation: isolate;
  -webkit-tap-highlight-color: transparent;
}

.folderCard.gf-root:focus-visible {
  outline: none;
}

.gf-root[data-tone='dark'] {
  --gf-ink: #f5f5f7;
  --gf-ink-soft: rgba(245, 245, 247, 0.78);
}

.gf-root:hover,
.gf-root:focus-within {
  --gf-hinge: -11deg;
  --gf-lift: -34px;
  --gf-spread: 8px;
  --gf-fan: 1.4deg;
  --gf-stack: 10px;
}

.gf-root[data-open] {
  --gf-hinge: -24deg;
  --gf-lift: -96px;
  --gf-spread: 40px;
  --gf-fan: 5deg;
  --gf-stack: 30px;
}

.gf-stage {
  position: absolute;
  left: 0;
  top: 0;
  width: 340px;
  height: 272px;
  transform-origin: 0 0;
}

.gf-tilt {
  position: absolute;
  inset: 0;
  transform: perspective(1400px) rotateX(calc(var(--gf-py) * -3deg)) rotateY(calc(var(--gf-px) * 4deg));
  transition: transform 0.9s var(--gf-ease);
}

.gf-root:not(:hover):not(:focus-within):not([data-open]) {
  .gf-tilt,
  .gf-front {
    transform: none;
  }
}

.gf-shadow {
  position: absolute;
  left: 18px;
  right: 18px;
  bottom: -6px;
  height: 60px;
  border-radius: 40px;
  background: rgba(16, 18, 24, 0.28);
  filter: blur(22px);
  transform: translateX(calc(var(--gf-px) * -8px));
  transition: transform 0.9s var(--gf-ease), opacity 0.9s var(--gf-ease);
}

.gf-root[data-tone='dark'] .gf-shadow {
  background: rgba(0, 0, 0, 0.55);
}

.gf-back {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: linear-gradient(180deg, #f3f3f4 0%, #e3e3e6 100%);
  transition: translate 1s var(--gf-ease), opacity 0.9s var(--gf-ease);
}

.gf-root[data-tone='dark'] .gf-back {
  background: linear-gradient(180deg, #2a353e 0%, #1f2932 100%);
}

.gf-art {
  position: absolute;
  left: -12px;
  top: -12px;
  max-width: none;
  opacity: 0;
  filter: blur(14px) saturate(0.6);
  transform: translate(calc(var(--gf-px) * -7px), calc(var(--gf-py) * -6px)) scale(1.02);
  transition: transform 1.1s var(--gf-ease), opacity 1.2s var(--gf-ease), filter 1.2s var(--gf-ease);

  &[data-ready] {
    opacity: 1;
    filter: none;
  }
}

.gf-back-sheen {
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.22) 0%, rgba(255, 255, 255, 0) 22%),
    radial-gradient(120% 80% at 80% 0%, rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0) 60%);
  pointer-events: none;
}

.gf-rim {
  position: absolute;
  left: 0;
  top: 0;
  max-width: none;
  overflow: visible;
  pointer-events: none;
  fill: none;
}

.gf-files {
  position: absolute;
  inset: 0;
  z-index: 5;
  pointer-events: none;
  clip-path: inset(-400px -400px 10px -400px);
}

.gf-sheet {
  box-sizing: border-box;
  position: absolute;
  left: 34px;
  top: 96px;
  width: 272px;
  height: 184px;
  border-radius: 16px;
  overflow: hidden;
  background: linear-gradient(180deg, #ffffff 0%, #f2f2f0 100%);
  box-shadow: 0 10px 26px -8px rgba(10, 12, 20, 0.28);
  transform-origin: 50% 100%;
  transform: translate(
      calc(var(--gf-jx) + var(--gf-slot) * var(--gf-spread)),
      calc(var(--gf-lift) + var(--gf-depth) * var(--gf-stack) * -1)
    )
    rotate(calc(var(--gf-jr) + var(--gf-slot) * var(--gf-fan)));
  transition: transform 0.75s var(--gf-spring) calc(var(--gf-depth) * 40ms), translate 0.9s var(--gf-ease),
    opacity 0.9s var(--gf-ease);
}

.gf-root[data-tone='dark'] .gf-sheet {
  background: linear-gradient(180deg, #3a4652 0%, #2b3640 100%);
  box-shadow: 0 12px 28px -8px rgba(12, 24, 36, 0.45);
}

.gf-root .gf-sheet--art {
  background: #1a1a1d;
}

.gf-sheet-art {
  position: absolute;
  left: 0;
  top: 0;
  max-width: none;
  opacity: 0;
  filter: blur(10px);
  transition: opacity 0.9s var(--gf-ease), filter 0.9s var(--gf-ease);

  &[data-ready] {
    opacity: 1;
    filter: none;
  }
}

.gf-front {
  position: absolute;
  left: 0;
  top: 74px;
  width: 340px;
  height: 198px;
  z-index: 10;
  -webkit-backdrop-filter: blur(22px) saturate(1.5);
  backdrop-filter: blur(22px) saturate(1.5);
  transform-origin: 50% 100%;
  transform: perspective(760px) rotateX(var(--gf-hinge));
  transition: transform 0.8s var(--gf-spring), translate 1s var(--gf-ease), opacity 1s var(--gf-ease);
}

.gf-tint {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    180deg,
    rgba(255, 255, 255, 0.2) 0%,
    rgba(255, 255, 255, 0.55) 40%,
    rgba(252, 252, 253, 0.94) 100%
  );
}

.gf-root[data-tone='dark'] .gf-tint {
  background: linear-gradient(180deg, rgba(42, 53, 62, 0.28) 0%, rgba(35, 44, 52, 0.55) 46%, rgba(26, 34, 40, 0.86) 100%);
}

.gf-spec {
  position: absolute;
  inset: 0;
  background: radial-gradient(
    260px 200px at calc(50% + var(--gf-px) * 46%) calc(30% + var(--gf-py) * 40%),
    rgba(255, 255, 255, 0.5),
    rgba(255, 255, 255, 0) 70%
  );
  mix-blend-mode: soft-light;
  opacity: 0.9;
  pointer-events: none;
}

.gf-root[data-tone='dark'] .gf-spec {
  mix-blend-mode: screen;
  opacity: 0.16;
}

.gf-front-rim {
  width: 340px;
  height: 198px;

  path {
    stroke: transparent;
    stroke-width: 5;
    transition: stroke 0.3s var(--gf-ease);
  }
}

.gf-root:focus-visible .gf-front-rim path,
.gf-root.selected .gf-front-rim path {
  stroke: var(--ui-primary);
}

.gf-label {
  position: absolute;
  left: 28px;
  bottom: 30px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 212px;
  color: var(--gf-ink);
  pointer-events: none;
}

.gf-title {
  display: block;
  min-width: 0;
  font-family: 'Microsoft YaHei', '微软雅黑', SimHei, '黑体', sans-serif;
  font-size: 22px;
  font-weight: 700;
  line-height: 1.35;
  letter-spacing: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: auto;
}

.gf-meta {
  font-family: 'Microsoft YaHei', '微软雅黑', SimHei, '黑体', sans-serif;
  font-size: 16px;
  font-weight: 400;
  letter-spacing: 0;
  color: var(--gf-ink-soft);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.gf-keyWrap {
  position: absolute;
  right: 22px;
  bottom: 22px;
  z-index: 12;
  transition: opacity 0.6s var(--gf-ease) 0.7s, scale 0.7s var(--gf-spring) 0.7s;
}

.gf-key {
  box-sizing: border-box;
  width: 58px;
  height: 58px;
  padding: 0;
  border: 0;
  border-radius: 14px;
  display: grid;
  place-items: center;
  cursor: pointer;
  color: var(--gf-ink-soft);
  background: transparent;
  transition: background 0.2s var(--gf-ease), color 0.2s var(--gf-ease), transform 0.35s var(--gf-spring);

  &:hover {
    color: var(--gf-ink);
    background: rgba(20, 20, 22, 0.06);
  }

  &:active {
    transform: scale(0.92);
    transition-duration: 0.12s;
  }

  &:focus-visible {
    outline: 3px solid var(--ui-focus);
    outline-offset: 2px;
  }
}

.gf-root[data-tone='dark'] .gf-key:hover {
  background: rgba(255, 255, 255, 0.08);
}

.gf-glyph {
  display: block;
  width: 30px;
  height: 8px;
  max-width: none;
  fill: currentColor;
}

.selectBox {
  position: absolute;
  left: 8px;
  top: 8px;
  z-index: 20;
  margin: 0;
  padding: 3px;
  line-height: 0;
  border-radius: 6px;
  background: var(--ui-surface);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
  cursor: pointer;

  /deep/ .el-checkbox {
    margin: 0;
  }

  /deep/ .el-checkbox__inner {
    width: 15px;
    height: 15px;
    background-color: transparent;
    border: 1.5px solid var(--ui-text-secondary);
    border-radius: 3px;
    box-shadow: none;
  }

  /deep/ .el-checkbox__inner::after {
    left: 4px;
    top: 1px;
  }

  /deep/ .el-checkbox__input.is-checked .el-checkbox__inner,
  /deep/ .el-checkbox__input.is-indeterminate .el-checkbox__inner {
    background-color: var(--ui-primary);
    border-color: var(--ui-primary);
  }
}

@media (prefers-reduced-motion: reduce) {
  .gf-root *,
  .gf-root *::before,
  .gf-root *::after {
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    animation: none !important;
  }

  .gf-tilt {
    transform: none;
  }
}
</style>