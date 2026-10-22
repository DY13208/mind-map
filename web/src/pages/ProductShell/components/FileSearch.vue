<template>
  <div
    class="fileSearch"
    :class="{
      alwaysExpanded,
      expanded: alwaysExpanded || expanded || !!value
    }"
  >
    <button
      v-if="!alwaysExpanded && !expanded && !value"
      type="button"
      class="searchTrigger"
      title="搜索"
      aria-label="搜索"
      @click="open"
    >
      <i class="el-icon-search" aria-hidden="true" />
    </button>
    <el-input
      v-else
      ref="input"
      class="searchInput"
      :value="value"
      clearable
      prefix-icon="el-icon-search"
      :placeholder="placeholder"
      @input="$emit('input', $event)"
      @focus="$emit('focus')"
      @blur="onBlur"
      @clear="onClear"
    />
  </div>
</template>
<script>
export default {
  name: 'FileSearch',
  props: {
    value: { type: String, default: '' },
    alwaysExpanded: { type: Boolean, default: false },
    placeholder: { type: String, default: '搜索脑图、所有者或文件夹' }
  },
  data() {
    return { expanded: false }
  },
  methods: {
    open() {
      this.expanded = true
      this.$nextTick(() => {
        const input = this.$refs.input
        if (input && input.focus) input.focus()
      })
    },
    blur() {
      const input = this.$refs.input
      if (input && input.blur) input.blur()
    },
    onBlur() {
      if (!this.alwaysExpanded && !this.value) this.expanded = false
    },
    onClear() {
      this.$emit('input', '')
      if (!this.alwaysExpanded) this.expanded = false
    }
  }
}
</script>
<style lang="less" scoped>
.fileSearch {
  display: inline-flex;
  align-items: center;
  min-width: 36px;

  &.expanded {
    flex: 1 1 200px;
    min-width: 160px;
    max-width: 360px;
  }

  &.alwaysExpanded {
    flex: 1 1 auto;
    width: 100%;
    min-width: 0;
    max-width: none;
  }
}

.searchTrigger {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--ui-text-secondary);
  cursor: pointer;
  font-size: 18px;
  padding: 0;
  transition: background 0.15s ease, color 0.15s ease;

  &:hover,
  &:focus-visible {
    background: var(--ui-surface-muted);
    color: var(--ui-primary);
    outline: none;
  }
}

.searchInput {
  width: 100%;

  /deep/ .el-input__inner {
    border: 0;
    background: var(--ui-input-bg);
    color: var(--ui-text);
    border-radius: 8px;
    height: 36px;
    line-height: 36px;
    box-shadow: none;

    &:focus {
      background: var(--ui-input-focus-bg);
    }
  }
}
</style>
