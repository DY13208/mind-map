<template>
  <el-popover ref="popover" :value="visible && showMenu" placement="bottom-end" width="280" trigger="manual" @hide="close">
    <div class="parentMapPicker" @mousedown.stop @click.stop>
      <div class="heading">请选择需要返回的脑图 <el-button type="text" @click="close">关闭</el-button></div>
      <el-input v-model="search" size="small" placeholder="搜索脑图名称" prefix-icon="el-icon-search" @input="searchChanged" />
      <div class="parents" @scroll="onScroll">
        <button v-for="item in items" :key="item.roomKey" class="parent" :disabled="busy || loading" @click="select(item)">
          <i class="el-icon-document"></i> {{ item.title }}
        </button>
        <div v-if="loading" class="status"><i class="el-icon-loading"></i> 加载中...</div>
        <div v-else-if="error" class="status">父脑图查询失败 <el-button type="text" @click="load(false)">重试</el-button></div>
        <div v-else-if="!items.length && !hasMore" class="status">{{ search ? '未找到匹配的脑图' : '当前脑图暂无关联的主脑图' }}</div>
        <el-button v-if="hasMore && !loading && !error" type="text" @click="load(false)">加载更多...</el-button>
      </div>
    </div>
    <slot slot="reference"></slot>
  </el-popover>
</template>
<script>
import { listParentMaps } from '@/utils/fileApi'
export default {
  props: { visible: Boolean, room: String, busy: Boolean },
  data() {
    return { showMenu: false, search: '', items: [], cursor: '', hasMore: false, loading: false, error: false }
  },
  watch: {
    visible(value) { if (value) this.reset(); else this.cancel() },
    room() { this.close() }
  },
  mounted() {
    document.addEventListener('click', this.outsideClick)
    document.addEventListener('keydown', this.onKeydown)
  },
  beforeDestroy() {
    this.cancel()
    document.removeEventListener('click', this.outsideClick)
    document.removeEventListener('keydown', this.onKeydown)
  },
  methods: {
    outsideClick(event) {
      const popover = this.$refs.popover
      if (this.visible && !this.$el.contains(event.target) && !(popover && popover.$refs.popper && popover.$refs.popper.contains(event.target))) this.close()
    },
    onKeydown(event) { if (this.visible && event.key === 'Escape') this.close() },
    cancel() {
      this.generation = (this.generation || 0) + 1
      clearTimeout(this.searchTimer)
      if (this.controller) this.controller.abort()
      this.loading = false
      this.$emit('loading', false)
    },
    close() { this.cancel(); this.$emit('close') },
    reset() { this.showMenu = false; this.search = ''; this.items = []; this.cursor = ''; this.hasMore = false; this.load(true) },
    searchChanged() {
      this.cancel()
      this.items = []; this.cursor = ''; this.hasMore = false; this.error = false
      this.loading = true
      this.$emit('loading', true)
      this.searchTimer = setTimeout(() => { this.loading = false; this.load(true) }, 250)
    },
    async load(first) {
      if (this.loading || !this.visible) return
      this.cancel()
      const generation = this.generation
      const room = this.room
      const q = this.search.trim()
      const initial = !this.cursor && !this.items.length
      this.controller = new AbortController()
      this.loading = true; this.error = false
      this.$emit('loading', true)
      try {
        const result = await listParentMaps(room, { q, cursor: first ? '' : this.cursor, signal: this.controller.signal })
        if (generation !== this.generation || !this.visible || room !== this.room) return
        const byRoom = new Map(this.items.map(item => [item.roomKey, item]))
        result.list.forEach(item => byRoom.set(item.roomKey, item))
        this.items = Array.from(byRoom.values())
        this.cursor = result.nextCursor || ''; this.hasMore = !!result.hasMore
        // Only the unfiltered initial result can determine an automatic target.
        // A single visible row with another page is not proof of uniqueness.
        if (initial && !q && !this.hasMore && this.items.length === 1) this.select(this.items[0])
        else this.showMenu = true
      } catch (err) {
        if (generation === this.generation && err.name !== 'AbortError') { this.error = true; this.showMenu = true }
      } finally {
        if (generation === this.generation) { this.loading = false; this.$emit('loading', false) }
      }
    },
    select(item) { this.$emit('select', { ...item, fromRoom: this.room }); this.close() },
    onScroll(event) {
      const el = event.target
      if (this.hasMore && !this.error && el.scrollTop + el.clientHeight >= el.scrollHeight - 24) this.load(false)
    }
  }
}
</script>
<style scoped>
.heading { display: flex; align-items: center; justify-content: space-between; font-size: 13px; }
.parents { max-height: 240px; overflow-y: auto; margin-top: 8px; }
.parent { display: block; width: 100%; border: 0; background: transparent; color: inherit; text-align: left; padding: 10px 8px; cursor: pointer; overflow-wrap: anywhere; }
.parent:hover { background: rgba(64,158,255,.1); }
.status { padding: 16px 8px; font-size: 13px; color: #909399; }
</style>
