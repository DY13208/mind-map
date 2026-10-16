<template>
  <input
    v-if="editing"
    ref="input"
    v-model="draft"
    class="inlineTitleInput"
    maxlength="60"
    @click.stop
    @dblclick.stop
    @keydown.enter.prevent="commit"
    @keydown.esc.prevent="cancel"
    @blur="commit"
  />
  <span
    v-else
    class="inlineTitle"
    :title="editable ? value + '（双击重命名）' : value"
    @click.stop="onClick"
    @dblclick.stop="startEdit"
    >{{ value }}</span
  >
</template>
<script>
// 单击要等双击判定窗口过去再打开，否则双击的第一下就已经跳走了
const DBLCLICK_WINDOW = 250

export default {
  name: 'InlineTitle',
  props: {
    value: { type: String, default: '' },
    editable: { type: Boolean, default: true }
  },
  data: () => ({ editing: false, draft: '' }),
  beforeDestroy() {
    clearTimeout(this.openTimer)
  },
  methods: {
    onClick() {
      if (!this.editable) {
        this.$emit('open')
        return
      }
      clearTimeout(this.openTimer)
      this.openTimer = setTimeout(() => this.$emit('open'), DBLCLICK_WINDOW)
    },
    startEdit() {
      clearTimeout(this.openTimer)
      if (!this.editable) return
      this.draft = this.value
      this.editing = true
      this.$nextTick(() => {
        const input = this.$refs.input
        if (!input) return
        input.focus()
        input.select()
      })
    },
    commit() {
      if (!this.editing) return
      this.editing = false
      const name = this.draft.trim()
      if (name && name !== this.value) this.$emit('rename', name)
    },
    cancel() {
      this.editing = false
    }
  }
}
</script>
<style lang="less" scoped>
.inlineTitle {
  cursor: pointer;
}

.inlineTitleInput {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  margin: -3px 0;
  padding: 2px 6px;
  font: inherit;
  color: inherit;
  border: 1px solid var(--ui-primary);
  border-radius: 6px;
  outline: none;
  background: var(--ui-surface);
}
</style>
