<template>
  <el-tooltip :content="content" :placement="placement" :disabled="!content" :value="focused" :manual="focused" :open-delay="320" :hide-after="0" :enterable="false" :visible-arrow="false" :offset="8" popper-class="wcpdActionTooltip" @focus.native="focused = true" @blur.native="focused = false" @keydown.native.esc="focused = false">
    <slot />
  </el-tooltip>
</template>
<script>
export default {
  name: 'ActionTooltip',
  data: () => ({ focused: false }),
  props: { content: { type: String, default: '' }, placement: { type: String, default: 'bottom' } }
}
</script>
