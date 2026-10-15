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
    this._counts = new Map()
    this.$bus.$on('data_change', this.onDataChange)
    this.$bus.$on('toggle_mini_map', this.onMiniMapToggle)
    if (this.mindMap) {
      this.onDataChange(this.mindMap.renderer.renderTree)
    }
  },
  beforeDestroy() {
    this.$bus.$off('data_change', this.onDataChange)
    this.$bus.$off('toggle_mini_map', this.onMiniMapToggle)
    this._counts.clear()
  },
  methods: {
    onMiniMapToggle(show) {
      this.openMiniMap = !!show
    },

    toggleMiniMap() {
      this.$bus.$emit('toggle_mini_map', !this.openMiniMap)
    },

    // 监听数据变化
    onDataChange(data, change) {
      if (change && change.incremental && this._counts) {
        const remove = tree => {
          if (!tree || !tree.data) return
          const old = this._counts.get(tree.data.uid)
          if (old != null) { this.num--; this.words -= old; this._counts.delete(tree.data.uid) }
          (tree.children || []).forEach(remove)
        }
        change.removed.forEach(entry => remove(entry.tree))
        change.added.forEach(entry => { if (entry.countable) this.walk(entry.tree) })
        change.nodes.forEach(entry => { if (entry.countable && this._counts.has(entry.tree.data.uid)) this.updateCount(entry.tree) })
        return
      }
      this.textStr = ''
      this.words = 0
      this.num = 0
      this._counts = new Map()
      this.walk(data)
    },

    updateCount(data) {
      if (!data || !data.data) return
      const uid = data.data.uid
      const text = String(data.data.text) || ''
      let words = text.length
      if (text.includes('<') || text.includes('&')) {
        countEl.innerHTML = text
        words = countEl.textContent.length
      }
      const old = this._counts.get(uid)
      if (old == null) this.num++
      else this.words -= old
      this.words += words
      this._counts.set(uid, words)
    },

    // 遍历
    walk(data) {
      if (!data) return
      this.updateCount(data)
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
