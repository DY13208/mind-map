<template>
  <div class="countContainer" :class="{ isDark: isDark }">
    <div class="item">
      <span class="name">{{ $t('count.words') }}</span>
      <span class="value">{{ words }}</span>
    </div>
    <div class="item">
      <span class="name">{{ $t('count.nodes') }}</span>
      <span class="value">{{ num }}</span>
    </div>
    <button
      type="button"
      class="miniMapBtn iconfont icondaohang1"
      :class="{ active: openMiniMap }"
      title="小地图"
      aria-label="小地图"
      @click="toggleMiniMap"
    ></button>
  </div>
</template>

<script>
import { mapState } from 'vuex'

// 字数及节点数量统计
let countEl = document.createElement('div')
export default {
  props: {
    mindMap: {
      type: Object
    }
  },
  data() {
    return {
      textStr: '',
      words: 0,
      num: 0,
      openMiniMap: false
    }
  },
  computed: {
    ...mapState({
      isDark: state => state.localConfig.isDark
    })
  },
  created() {
    this.$bus.$on('data_change', this.onDataChange)
    this.$bus.$on('toggle_mini_map', this.onMiniMapToggle)
    if (this.mindMap) {
      this.onDataChange(this.mindMap.getData())
    }
  },
  beforeDestroy() {
    this.$bus.$off('data_change', this.onDataChange)
    this.$bus.$off('toggle_mini_map', this.onMiniMapToggle)
  },
  methods: {
    // 监听数据变化
    onMiniMapToggle(show) {
      this.openMiniMap = !!show
    },

    toggleMiniMap() {
      this.$bus.$emit('toggle_mini_map', !this.openMiniMap)
    },

    onDataChange(data) {
      this.textStr = ''
      this.words = 0
      this.num = 0
      this.walk(data)
      countEl.innerHTML = this.textStr
      this.words = countEl.textContent.length
    },

    // 遍历
    walk(data) {
      if (!data) return
      this.num++
      this.textStr += String(data.data.text) || ''
      if (data.children && data.children.length > 0) {
        data.children.forEach(item => {
          this.walk(item)
        })
      }
    }
  }
}
</script>

<style lang="less" scoped>
.countContainer {
  padding: 0 8px 0 12px;
  position: fixed;
  left: 16px;
  bottom: 16px;
  background: #fff;
  border-radius: 12px;
  height: 36px;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid rgba(16, 24, 40, 0.08);
  box-shadow: 0 8px 24px rgba(16, 24, 40, 0.08);
  z-index: 3;

  &.isDark {
    background: #262a2e;
    border-color: hsla(0, 0%, 100%, 0.1);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);

    .item {
      color: hsla(0, 0%, 100%, 0.6);
    }

    .miniMapBtn {
      color: hsla(0, 0%, 100%, 0.8);

      &.active,
      &:hover {
        color: #79bbff;
        background: hsla(0, 0%, 100%, 0.08);
      }
    }
  }

  .miniMapBtn {
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: #344054;
    cursor: pointer;

    &.active,
    &:hover {
      color: #409eff;
      background: #f2f4f7;
    }
  }

  .item {
    color: #555;
    margin-right: 15px;

    &:last-of-type {
      margin-right: 0;
    }

    .name {
      margin-right: 5px;
    }
  }
}

@media screen and (max-width: 900px) {
  .countContainer {
    display: none;
  }
}
</style>
