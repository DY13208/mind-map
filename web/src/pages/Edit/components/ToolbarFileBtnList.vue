<template>
  <div class="toolbarFileBtnList" :class="[dir, { isDark }]" @mousedown.prevent>
    <div
      v-for="item in list"
      :key="item.key"
      class="toolbarBtn"
      :class="{ disabled: item.disabled, busy: item.busy }"
      :data-testid="item.testId"
      :title="item.title || item.label"
      @click="!item.disabled && $emit('select', item.key)"
    >
      <!-- 图标类挂在内层 <i> 上而不是 .icon 方块上：el-icon-loading 自带旋转动画，
           挂在外层会让整块（边框+白底）一起转。iconClass 是可选的稳定类名（如 runIcon）。 -->
      <span class="icon"><i :class="[item.iconClass, item.icon]"></i></span>
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
    // 派发中：图标方块亮成主题色，文字色也拉回来（.disabled 的 #bcbcbc 太淡），
    // 此刻按钮只是「暂时不可重复点」，不是真禁用。必须写在 .disabled 之后。
    &.busy {
      color: rgba(26, 26, 26, 0.8);

      .icon {
        border-color: #409eff;
        background: #ecf5ff;
      }
    }

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

      // 图标本体。转圈只转它，外层的方块（边框+白底）保持静止。
      // inline-block 是转圈动画生效的前提，别删。
      // font-size: inherit —— .iconfont 自带 16px，套进 <i> 后要继承方块的 18px，保持原尺寸。
      i {
        display: inline-block;
        line-height: 1;
        font-size: inherit;
      }
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
    // 深色主题的派发中配色（.isDark 多一层类，优先级高于浅色那条）
    &.busy {
      color: hsla(0, 0%, 100%, 0.9);

      .icon {
        border-color: rgba(64, 158, 255, 0.55);
        background: rgba(64, 158, 255, 0.16);
      }
    }
  }
}
</style>
