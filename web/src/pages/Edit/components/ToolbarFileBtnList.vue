<template>
  <div class="toolbarFileBtnList" :class="[dir, { isDark }]" @mousedown.prevent>
    <div
      v-for="item in list"
      :key="item.key"
      class="toolbarBtn"
      :class="{ disabled: item.disabled }"
      :data-testid="item.testId"
      :title="item.title || item.label"
      @click="!item.disabled && $emit('select', item.key)"
    >
      <span class="icon" :class="item.icon"></span>
      <span class="text">{{ item.label }}</span>
    </div>
  </div>
</template>

<script>
export default {
  props: {
    list: { type: Array, default: () => [] },
    dir: { type: String, default: 'h' },
    isDark: { type: Boolean, default: false }
  }
}
</script>

<style lang="less" scoped>
.toolbarFileBtnList {
  display: flex;

  .toolbarBtn {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    flex: 0 0 auto;
    cursor: pointer;
    margin-right: 20px;

    &:last-child { margin-right: 0; }
    &:hover:not(.disabled) .icon { background: #f5f5f5; }
    &.disabled { color: #bcbcbc; cursor: not-allowed; }

    .icon {
      display: flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      width: 28px;
      min-width: 28px;
      height: 26px;
      padding: 0;
      background: #fff;
      border: 1px solid #e9e9e9;
      border-radius: 4px;
      font-size: 18px;
    }

    .text {
      width: 100%;
      margin-top: 3px;
      text-align: center;
      white-space: nowrap;
    }
  }

  &.v {
    display: block;
    width: 120px;

    .toolbarBtn {
      flex: none;
      flex-direction: row;
      justify-content: flex-start;
      width: 100%;
      margin: 0 0 10px;

      &:last-child { margin-bottom: 0; }
      .icon { margin-right: 10px; }
      .text { width: auto; text-align: left; overflow: hidden; text-overflow: ellipsis; }
    }
  }

  &.isDark .toolbarBtn {
    color: hsla(0, 0%, 100%, 0.9);
    .icon { background: transparent; border-color: transparent; }
    &:hover:not(.disabled) .icon { background: hsla(0, 0%, 100%, 0.05); }
    &.disabled { color: #54595f; }
  }
}
</style>
