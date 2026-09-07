<template
  ><el-dialog
    :visible.sync="shown"
    :title="title"
    width="420px"
    @open="name = value"
    ><el-input
      v-model="name"
      maxlength="60"
      show-word-limit
      autofocus
      @keyup.enter.native="confirm"
    /><span slot="footer"
      ><el-button @click="shown = false">取消</el-button
      ><el-button type="primary" :disabled="!name.trim()" @click="confirm"
        >保存</el-button
      ></span
    ></el-dialog
  ></template
>
<script>
export default {
  name: 'RenameDialog',
  props: {
    visible: Boolean,
    value: String,
    title: { type: String, default: '重命名' }
  },
  data: () => ({ name: '' }),
  computed: {
    shown: {
      get() {
        return this.visible
      },
      set(value) {
        this.$emit('update:visible', value)
      }
    }
  },
  methods: {
    confirm() {
      if (!this.name.trim()) return
      this.$emit('confirm', this.name.trim())
      this.shown = false
    }
  }
}
</script>
