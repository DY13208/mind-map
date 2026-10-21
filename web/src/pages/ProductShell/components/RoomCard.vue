<template>
  <article
    class="roomCard gf-root"
    :class="{ selected, selectable, 'is-return-highlighted': highlighted }"
    tabindex="0"
    :aria-label="`打开 ${room.title}`"
    :data-room-key="room.roomKey || room.id"
    :data-tone="tone"
    :data-open="opening || undefined"
    :style="{ height: rootHeight + 'px' }"
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
        @change="$emit('toggle-select', room)"
      />
    </label>
    <div class="gf-stage" :style="stageStyle">
      <div class="gf-tilt">
        <div class="gf-shadow" aria-hidden="true" />

        <div class="gf-back" aria-hidden="true">
          <div class="gf-back-sheen" />
        </div>

        <div
          ref="preview"
          class="gf-sheet"
          :class="{ 'gf-sheet--image': hasImageCover }"
          :style="previewStyle"
        >
          <div v-if="!hasImageCover" class="gf-sheet-map">
            <MindMapPreview v-if="sketch" :sketch="sketch" />
            <div v-else class="previewMap" aria-hidden="true">
              <span></span><i></i><i></i><i></i>
            </div>
          </div>
        </div>

        <div class="gf-front">
          <div class="gf-tint" aria-hidden="true" />
          <div class="gf-spec" aria-hidden="true" />
          <div class="gf-label">
            <strong class="gf-title"
              ><InlineTitle
                :value="room.title"
                :editable="!selectable"
                @open="activate"
                @rename="$emit('rename-inline', room, $event)"
            /></strong>
            <span class="gf-meta">{{ ownerName }} · {{ dateText }}</span>
          </div>
        </div>

        <div class="gf-ring" aria-hidden="true" />

        <el-dropdown
          class="gf-keyWrap"
          trigger="click"
          @command="$emit($event, room)"
          @click.native.stop
        >
          <button type="button" class="gf-key" :aria-label="`${room.title} 更多操作`">
            <svg class="gf-glyph" viewBox="0 0 30 8" aria-hidden="true">
              <circle cx="4" cy="4" r="3" />
              <circle cx="15" cy="4" r="3" />
              <circle cx="26" cy="4" r="3" />
            </svg>
          </button>
          <el-dropdown-menu slot="dropdown"
            ><el-dropdown-item v-if="room.canManage !== false" command="rename">重命名</el-dropdown-item
            ><el-dropdown-item command="duplicate">创建副本</el-dropdown-item
            ><el-dropdown-item command="move">移动到文件夹</el-dropdown-item
            ><el-dropdown-item command="favorite">{{
              room.favorite ? '取消收藏' : '收藏'
            }}</el-dropdown-item
            ><el-dropdown-item command="share">分享</el-dropdown-item
            ><el-dropdown-item v-if="allowDelete" command="delete" divided
              >删除</el-dropdown-item
            ></el-dropdown-menu
          >
        </el-dropdown>
      </div>
    </div>
  </article>
</template>
<script>
import roomService from '@/services/roomService'
import MindMapPreview from './MindMapPreview.vue'
import InlineTitle from './InlineTitle.vue'
import glassCard, { reducedMotion } from './glassCard'

import { cachedCardPreview, subscribeCardPreview } from '@/services/cardPreviewQueue'

const OPEN_DELAY = 240

export default {
  name: 'RoomCard',
  components: { MindMapPreview, InlineTitle },
  mixins: [glassCard],
  props: {
    room: Object,
    allowDelete: { type: Boolean, default: false },
    selectable: { type: Boolean, default: false },
    selected: { type: Boolean, default: false },
    highlighted: { type: Boolean, default: false },
    canSelect: { type: Boolean, default: true }
  },
  data() {
    return {
      sketch: null,
      observer: null,
      loadingPreview: false,
      previewSubscription: null,
      previewSequence: 0,
      opening: false
    }
  },
  computed: {
    previewStyle() {
      if (this.room.canView === false) return {}
      const url = this.room.previewUrl || this.room.thumbnailUrl || this.room.coverUrl
      return url ? { backgroundImage: `url(${url})` } : {}
    },
    dateText() {
      return new Date(this.room.updatedAt).toLocaleDateString('zh-CN')
    },
    ownerName() {
      const owner = this.room.owner || {}
      return owner.name || owner.userId || '—'
    },
    hasImageCover() {
      return !!(this.room.previewUrl || this.room.thumbnailUrl || this.room.coverUrl)
    }
  },
  watch: {
    room: {
      deep: false,
      handler() {
        this.cancelPreview()
        this.sketch = null
        this.hydrateFromCache()
        this.observePreview()
      }
    }
  },
  mounted() {
    this.hydrateFromCache()
    this.observePreview()
  },
  beforeDestroy() {
    this.cancelPreview()
    this.disconnectObserver()
    clearTimeout(this.openTimer)
  },
  methods: {
    activate() {
      if (this.opening) return
      if (this.selectable || reducedMotion()) {
        this.$emit('open', this.room)
        return
      }
      // 纸张先从玻璃后面抽出来，再进入脑图
      this.opening = true
      this.openTimer = setTimeout(() => {
        this.opening = false
        this.$emit('open', this.room)
      }, OPEN_DELAY)
    },
    cancelPreview() {
      this.previewSequence++
      if (this.previewSubscription) this.previewSubscription.cancel()
      this.previewSubscription = null
      this.loadingPreview = false
    },
    hydrateFromCache() {
      if (this.room.canView === false || this.hasImageCover) return
      const cached = cachedCardPreview(this.room)
      if (cached) this.sketch = cached
    },
    disconnectObserver() {
      if (this.observer) {
        this.observer.disconnect()
        this.observer = null
      }
    },
    observePreview() {
      this.disconnectObserver()
      if (this.hasImageCover || this.sketch || typeof IntersectionObserver === 'undefined') {
        if (!this.hasImageCover && !this.sketch) this.loadPreview()
        return
      }
      this.observer = new IntersectionObserver(
        entries => {
          if (entries.some(entry => entry.isIntersecting)) {
            this.disconnectObserver()
            this.loadPreview()
          }
        },
        { rootMargin: '120px' }
      )
      if (this.$refs.preview) this.observer.observe(this.$refs.preview)
    },
    async loadPreview() {
      if (this.loadingPreview && this.previewSubscription) {
        return this.previewSubscription.promise.catch(() => {})
      }
      if (this.room.canView === false || this.hasImageCover || this.sketch) return
      const requested = { ...this.room }
      const key = requested.roomKey || requested.id
      if (!key) return
      const sequence = ++this.previewSequence
      this.loadingPreview = true
      const subscription = subscribeCardPreview(requested, roomService.getCardPreview)
      this.previewSubscription = subscription
      try {
        const preview = await subscription.promise
        if (sequence !== this.previewSequence) return
        if (Number(preview.revision || 0) !== Number(requested.revision || 0)) return
        if (requested.generation != null && String(preview.generation) !== String(requested.generation)) return
        this.sketch = preview.sketch
      } catch (error) {
        // Cancellation and failures remain retryable; title artwork stays visible.
      } finally {
        if (sequence === this.previewSequence) {
          this.loadingPreview = false
          this.previewSubscription = null
        }
      }
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
  --gf-sheet-y: 0px;
  --gf-sheet-r: 0deg;
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

.roomCard.gf-root:focus-visible {
  outline: none;
}

.roomCard.gf-root.is-return-highlighted .gf-stage::after {
  content: '';
  position: absolute;
  inset: 1px;
  z-index: 20;
  box-sizing: border-box;
  border: 3px solid var(--ui-primary);
  border-radius: 21px;
  pointer-events: none;
  animation: returnRoomHighlight 2.4s ease-out both;
}

@keyframes returnRoomHighlight {
  0%, 100% { opacity: 0; }
  15%, 65% { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .roomCard.gf-root.is-return-highlighted .gf-stage::after {
    animation: none;
  }
}

.gf-root[data-tone='dark'] {
  --gf-ink: #f5f5f7;
  --gf-ink-soft: rgba(245, 245, 247, 0.78);
}

.gf-root:hover,
.gf-root:focus-within {
  --gf-hinge: -9deg;
  --gf-sheet-y: -8px;
  --gf-sheet-r: -0.6deg;
}

.gf-root[data-open] {
  --gf-hinge: -18deg;
  --gf-sheet-y: -30px;
  --gf-sheet-r: 0deg;
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
  background: rgba(16, 18, 24, 0.3);
  filter: blur(22px);
  transform: translateX(calc(var(--gf-px) * -8px));
  transition: transform 0.9s var(--gf-ease), opacity 0.9s var(--gf-ease);
}

.gf-root[data-tone='dark'] .gf-shadow {
  background: rgba(0, 0, 0, 0.62);
}

/* ---- 背板：白底点阵，和文件夹流体区分开 ---- */
.gf-back {
  position: absolute;
  inset: 0;
  overflow: hidden;
  border-radius: 22px;
  background-color: var(--ui-preview-bg);
  background-image: radial-gradient(circle, rgba(20, 60, 45, 0.14) 1.1px, transparent 1.6px),
    linear-gradient(180deg, var(--ui-surface) 0%, var(--ui-preview-bg) 100%);
  background-size: 16px 16px, 100% 100%;
  background-position: calc(var(--gf-px) * -6px) calc(var(--gf-py) * -5px), 0 0;
  transition: translate 1s var(--gf-ease), opacity 0.9s var(--gf-ease), background-position 1.1s var(--gf-ease);
}

.gf-root[data-tone='dark'] .gf-back {
  background-image: radial-gradient(circle, rgba(148, 196, 210, 0.14) 1.1px, transparent 1.6px),
    linear-gradient(180deg, var(--ui-surface-muted) 0%, var(--ui-preview-bg) 100%);
}

.gf-back-sheen {
  position: absolute;
  inset: 0;
  background: radial-gradient(120% 80% at 80% 0%, rgba(255, 255, 255, 0.45), rgba(255, 255, 255, 0) 60%);
  pointer-events: none;
}

.gf-root[data-tone='dark'] .gf-back-sheen {
  background: radial-gradient(120% 80% at 80% 0%, rgba(45, 212, 191, 0.1), rgba(56, 189, 248, 0) 60%);
}

/* ---- 纸张：脑图缩略图 ---- */
.gf-sheet {
  box-sizing: border-box;
  position: absolute;
  left: 18px;
  top: 18px;
  z-index: 5;
  width: 304px;
  height: 200px;
  border-radius: 14px;
  overflow: hidden;
  background-position: center;
  background-size: cover;
  transform-origin: 50% 100%;
  transform: translateY(var(--gf-sheet-y)) rotate(var(--gf-sheet-r));
  transition: transform 0.75s var(--gf-spring), translate 0.9s var(--gf-ease) 0.12s,
    opacity 0.9s var(--gf-ease) 0.12s;
}

.gf-sheet--image {
  box-shadow: 0 12px 28px -10px rgba(10, 12, 20, 0.35);
}

.gf-sheet-map {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  bottom: 44px;
  display: grid;
  place-items: center;

  /deep/ .mindMapPreview .mmBg {
    fill: transparent;
  }
}

.previewMap {
  position: relative;
  width: 120px;
  height: 56px;
  transform: scale(1.4);

  span,
  i {
    position: absolute;
    display: block;
    border: 1px solid var(--ui-preview-line);
    background: var(--ui-preview-node);
    border-radius: 4px;
  }

  span {
    width: 44px;
    height: 20px;
    left: 38px;
    top: 18px;
    background: var(--ui-preview-root);
    border-color: var(--ui-preview-root);
  }

  i {
    width: 27px;
    height: 14px;
  }

  i:nth-child(2) {
    left: 0;
    top: 0;
  }

  i:nth-child(3) {
    right: 0;
    top: 0;
  }

  i:nth-child(4) {
    right: 0;
    bottom: 0;
  }

  &::before,
  &::after {
    content: '';
    position: absolute;
    height: 1px;
    background: var(--ui-preview-line);
    width: 40px;
    top: 27px;
  }

  &::before {
    left: 8px;
    transform: rotate(25deg);
    transform-origin: right;
  }

  &::after {
    right: 8px;
    transform: rotate(-25deg);
    transform-origin: left;
  }
}

/* ---- 底部磨砂玻璃，底边为铰链 ---- */
.gf-front {
  position: absolute;
  left: 0;
  top: 166px;
  width: 340px;
  height: 106px;
  z-index: 10;
  overflow: hidden;
  border-radius: 0 0 22px 22px;
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
    rgba(255, 255, 255, 0.3) 0%,
    rgba(255, 255, 255, 0.62) 40%,
    rgba(252, 252, 252, 0.93) 100%
  );
}

.gf-root[data-tone='dark'] .gf-tint {
  background: linear-gradient(180deg, rgba(42, 53, 62, 0.35) 0%, rgba(35, 44, 52, 0.62) 46%, rgba(26, 34, 40, 0.88) 100%);
}

.gf-spec {
  position: absolute;
  inset: 0;
  background: radial-gradient(
    260px 160px at calc(50% + var(--gf-px) * 46%) calc(20% + var(--gf-py) * 40%),
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

.gf-label {
  position: absolute;
  left: 24px;
  right: 92px;
  bottom: 22px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 6px;
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

/* ---- 聚焦 / 选中描边 ---- */
.gf-ring {
  position: absolute;
  inset: 0;
  z-index: 11;
  border-radius: 22px;
  box-shadow: inset 0 0 0 4px var(--ui-primary);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.3s var(--gf-ease);
}

.gf-root:focus-visible .gf-ring,
.gf-root.selected .gf-ring {
  opacity: 1;
}

/* ---- 右下角 ··· 键 ---- */
.gf-keyWrap {
  position: absolute;
  right: 20px;
  bottom: 22px;
  z-index: 12;
  transition: opacity 0.6s var(--gf-ease) 0.6s, scale 0.7s var(--gf-spring) 0.6s;
}

.gf-key {
  box-sizing: border-box;
  width: 54px;
  height: 54px;
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

/* ---- 多选框 ---- */
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
