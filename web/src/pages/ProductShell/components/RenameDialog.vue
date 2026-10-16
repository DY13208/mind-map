<template>
  <el-dialog
    :visible.sync="shown"
    width="400px"
    custom-class="renameDialog"
    :show-close="false"
    append-to-body
    @open="name = value || ''"
    @opened="focusInput"
  >
    <div slot="title" class="renameDialog__header">
      <div class="renameDialog__titleRow">
        <span class="renameDialog__title">{{ title }}</span>
        <button
          type="button"
          class="renameDialog__close"
          aria-label="关闭"
          @click="shown = false"
        >
          <i class="el-icon-close"></i>
        </button>
      </div>
      <p class="renameDialog__desc">{{ helperText }}</p>
    </div>
    <div class="renameDialog__labelRow">
      <label class="renameDialog__label">{{ labelText }}</label>
      <span class="renameDialog__count">{{ name.length }}/{{ maxLength }}</span>
    </div>
    <el-input
      ref="input"
      v-model="name"
      class="renameDialog__input"
      :maxlength="maxLength"
      autofocus
      @keyup.enter.native="confirm"
    />
    <span slot="footer" class="renameDialog__footer">
      <el-button class="renameDialog__btn" round @click="shown = false"
        >取消</el-button
      >
      <el-button
        class="renameDialog__btn"
        type="primary"
        round
        :disabled="!name.trim()"
        @click="confirm"
        >保存修改</el-button
      >
    </span>
  </el-dialog>
</template>
<script>
export default {
  name: 'RenameDialog',
  props: {
    visible: Boolean,
    value: String,
    title: { type: String, default: '重命名脑图' }
  },
  data: () => ({ name: '', maxLength: 60 }),
  computed: {
    shown: {
      get() {
        return this.visible
      },
      set(value) {
        this.$emit('update:visible', value)
      }
    },
    isFolder() {
      return /文件夹/.test(this.title || '')
    },
    labelText() {
      return this.isFolder ? '文件夹名称' : '脑图名称'
    },
    helperText() {
      return this.isFolder
        ? '修改文件夹名称，方便查找和管理'
        : '修改脑图名称，方便查找和管理'
    }
  },
  methods: {
    focusInput() {
      const input = this.$refs.input
      if (!input) return
      input.focus()
      if (input.$refs && input.$refs.input) input.$refs.input.select()
    },
    confirm() {
      if (!this.name.trim()) return
      this.$emit('confirm', this.name.trim())
      this.shown = false
    }
  }
}
</script>
<style lang="less">
.el-dialog.renameDialog {
  max-width: calc(100vw - 32px);
  margin-bottom: 0;
  border-radius: var(--ui-radius-lg, 12px);
  overflow: hidden;
  .el-dialog__header {
    padding: 22px 22px 0;
  }
  .el-dialog__body {
    padding: 18px 22px 0;
  }
  .el-dialog__footer {
    padding: 20px 22px 22px;
  }
  .renameDialog__titleRow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .renameDialog__title {
    font-size: 16px;
    font-weight: 600;
    line-height: 24px;
    color: var(--ui-text, #1f2329);
  }
  .renameDialog__close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    margin-right: -6px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--ui-text-secondary, #8a8f99);
    font-size: 16px;
    cursor: pointer;
    &:hover {
      background: var(--ui-surface-muted, #f2f3f5);
      color: var(--ui-text, #1f2329);
    }
    &:focus-visible {
      outline: 2px solid var(--ui-primary, #0f8a3a);
      outline-offset: 2px;
    }
  }
  .renameDialog__desc {
    margin: 4px 0 0;
    font-size: 13px;
    line-height: 20px;
    color: var(--ui-text-secondary, #8a8f99);
  }
  .renameDialog__labelRow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    font-size: 13px;
    line-height: 20px;
  }
  .renameDialog__label {
    font-weight: 500;
    color: var(--ui-text, #1f2329);
  }
  .renameDialog__count {
    color: var(--ui-text-muted, #a0a5ad);
    font-variant-numeric: tabular-nums;
  }
  .renameDialog__input .el-input__inner {
    height: 40px;
    border-radius: var(--ui-radius-md, 8px);
    &:focus {
      border-color: var(--ui-primary, #0f8a3a);
    }
  }
  .renameDialog__footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
  .renameDialog__btn {
    min-width: 84px;
    margin-left: 0 !important;
  }
  .renameDialog__btn.el-button--primary:not(.is-disabled) {
    background: var(--ui-primary, #0f8a3a);
    border-color: var(--ui-primary, #0f8a3a);
    &:hover,
    &:focus {
      background: var(--ui-primary-hover, #0c7531);
      border-color: var(--ui-primary-hover, #0c7531);
    }
  }
}
body.isDark .el-dialog.renameDialog {
  background: #262a2e;
  .renameDialog__title,
  .renameDialog__label {
    color: hsla(0, 0%, 100%, 0.9);
  }
  .renameDialog__desc,
  .renameDialog__count,
  .renameDialog__close {
    color: hsla(0, 0%, 100%, 0.55);
  }
  .renameDialog__close:hover {
    background: hsla(0, 0%, 100%, 0.08);
  }
  .renameDialog__input .el-input__inner {
    background: #363b3f;
    border-color: hsla(0, 0%, 100%, 0.12);
    color: hsla(0, 0%, 100%, 0.9);
  }
}
</style>