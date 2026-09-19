<template>
  <el-dropdown
    class="fileSort"
    trigger="click"
    @command="onCommand"
  >
    <button
      type="button"
      class="filterTrigger"
      :title="currentLabel"
      :aria-label="'排序：' + currentLabel"
    >
      <i class="el-icon-sort" aria-hidden="true" />
    </button>
    <el-dropdown-menu slot="dropdown">
      <el-dropdown-item
        v-for="item in options"
        :key="item.value"
        :command="item.value"
        :class="{ isActive: item.value === value }"
      >
        <i
          class="checkIcon"
          :class="item.value === value ? 'el-icon-check' : ''"
          aria-hidden="true"
        />
        {{ item.label }}
      </el-dropdown-item>
    </el-dropdown-menu>
  </el-dropdown>
</template>
<script>
export default {
  name: 'FileSort',
  props: {
    value: { type: String, default: 'updatedAt' },
    hideOpenedSort: { type: Boolean, default: false }
  },
  computed: {
    options() {
      const all = [
        { label: '最近更新', value: 'updatedAt' },
        { label: '最近打开', value: 'lastOpenedAt' },
        { label: '名称', value: 'title' },
        { label: '创建时间', value: 'createdAt' }
      ]
      return this.hideOpenedSort
        ? all.filter(item => item.value !== 'lastOpenedAt')
        : all
    },
    currentLabel() {
      const hit = this.options.find(item => item.value === this.value)
      return (hit && hit.label) || '排序'
    }
  },
  methods: {
    onCommand(command) {
      this.$emit('input', command)
    }
  }
}
</script>
<style lang="less" scoped>
.filterTrigger {
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

.checkIcon {
  display: inline-block;
  width: 14px;
  margin-right: 6px;
  font-size: 12px;
  color: var(--ui-primary);
}
</style>
<style lang="less">
.fileSort .el-dropdown-menu__item.isActive {
  color: var(--ui-primary);
  font-weight: 600;
  background: var(--ui-primary-soft);
}
</style>
