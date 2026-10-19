<template>
  <svg
    class="notchWing"
    :class="['is-' + side, 'is-' + position, 'is-' + variant]"
    width="22"
    height="22"
    viewBox="0 0 22 22"
    aria-hidden="true"
    focusable="false"
  >
    <g :transform="transform">
      <path
        class="notchWingFill"
        d="M 0 0 C 12.15 0 22 9.85 22 22 H 22 V 0 Z"
      />
      <!-- optional outline on the curve only; no overhang so nothing protrudes past the wing -->
      <path class="notchWingStroke" :d="strokePath" />
    </g>
  </svg>
</template>

<script>
// 刘海与外框交界处的「反向圆角」翼片。
// 基础形状对应右上角刘海：填充位于方块的上沿 + 右沿，内凹弧线朝左下。
// side=left 水平镜像，position=bottom 垂直镜像。
// variant=edge：贴着水平外框（刘海左/右侧）；variant=side：贴着竖直外框（刘海上/下方）。
export default {
  name: 'NotchWing',
  props: {
    side: {
      type: String,
      default: 'left',
      validator: v => v === 'left' || v === 'right'
    },
    position: {
      type: String,
      default: 'top',
      validator: v => v === 'top' || v === 'bottom'
    },
    variant: {
      type: String,
      default: 'edge',
      validator: v => v === 'edge' || v === 'side'
    }
  },
  computed: {
    strokePath() {
      return this.variant === 'edge'
        ? 'M 0 0 C 12.15 0 22 9.85 22 22'
        : 'M 0 0 C 12.15 0 22 9.85 22 22'
    },
    transform() {
      const fx = this.side === 'left'
      const fy = this.position === 'bottom'
      if (!fx && !fy) return null
      return `translate(${fx ? 22 : 0} ${fy ? 22 : 0}) scale(${fx ? -1 : 1} ${
        fy ? -1 : 1
      })`
    }
  }
}
</script>

<style lang="less" scoped>
.notchWing {
  position: absolute;
  display: var(--mm-notch-wing-display, block);
  width: 22px;
  height: 22px;
  overflow: visible;
  pointer-events: none;
  color: var(--mm-notch-frame, #e4e4e7);
  z-index: 1;

  .notchWingFill {
    fill: var(--mm-notch-wing-fill, var(--mm-notch-frame, #e4e4e7));
  }

  .notchWingStroke {
    fill: none;
    stroke: var(--mm-notch-wing-stroke, none);
    stroke-width: 1px;
  }

  // 贴水平外框：位于刘海的左/右外侧
  &.is-edge {
    &.is-top { top: 0; }
    &.is-bottom { bottom: 0; }
    &.is-left { left: 100%; }
    &.is-right { right: 100%; }
  }

  // 贴竖直外框：位于刘海的下/上外侧
  &.is-side {
    &.is-top { top: 100%; }
    &.is-bottom { bottom: 100%; }
    &.is-left { left: 0; }
    &.is-right { right: 0; }
  }
}
</style>
