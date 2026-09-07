<template>
  <span class="userAvatar" :style="boxStyle" role="img" :aria-label="label">
    <img
      v-if="imageSrc"
      class="userAvatarImage"
      :src="imageSrc"
      alt=""
      referrerpolicy="no-referrer"
      @error="onError"
    />
    <span v-else class="userAvatarInitial">{{ resolved.initial }}</span>
  </span>
</template>

<script>
import { resolveAvatar } from '@/utils/avatar'

export default {
  name: 'UserAvatar',
  props: {
    person: { type: Object, default: () => ({}) },
    size: { type: [Number, String], default: 28 },
    fallback: { type: String, default: '用' }
  },
  data() {
    return { failed: false }
  },
  computed: {
    resolved() {
      return resolveAvatar(this.person || {}, this.fallback)
    },
    imageSrc() {
      return this.failed ? '' : this.resolved.src
    },
    label() {
      return (this.person && this.person.name) || this.resolved.initial
    },
    pixelSize() {
      const n = Number(this.size)
      if (Number.isFinite(n) && n > 0) return n
      if (this.size === 'small') return 28
      if (this.size === 'large') return 40
      return 36
    },
    boxStyle() {
      return {
        width: this.pixelSize + 'px',
        height: this.pixelSize + 'px',
        fontSize: Math.max(10, Math.round(this.pixelSize * 0.42)) + 'px'
      }
    }
  },
  watch: {
    'resolved.src'() {
      this.failed = false
    }
  },
  methods: {
    onError() {
      this.failed = true
    }
  }
}
</script>

<style lang="less" scoped>
.userAvatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 50%;
  background: #158f68;
  color: #fff;
  font-weight: 600;
  vertical-align: middle;
  flex-shrink: 0;
}
.userAvatarImage {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.userAvatarInitial {
  line-height: 1;
}
</style>
