<template>
  <article
    class="roomCard"
    tabindex="0"
    :aria-label="`打开 ${room.title}`"
    @keydown.enter.self="$emit('open', room)"
    @click="$emit('open', room)"
  >
    <div ref="preview" class="roomPreview" :style="previewStyle">
      <MindMapPreview v-if="sketch" :sketch="sketch" />
      <div v-else class="previewMap" aria-hidden="true">
        <span></span><i></i><i></i><i></i>
      </div>
      <button
        class="favorite"
        :aria-label="room.favorite ? '取消收藏' : '收藏'"
        :class="{ active: room.favorite }"
        @click.stop="$emit('favorite', room)"
      >
        <i :class="room.favorite ? 'el-icon-star-on' : 'el-icon-star-off'" />
      </button>
    </div>
    <div class="roomBody">
      <div class="titleRow">
        <h3 :title="room.title">{{ room.title }}</h3>
        <el-dropdown
          trigger="click"
          @command="$emit($event, room)"
          @click.native.stop
          ><span class="more"><i class="el-icon-more"/></span
          ><el-dropdown-menu slot="dropdown"
            ><el-dropdown-item command="open">打开</el-dropdown-item
            ><el-dropdown-item command="rename">重命名</el-dropdown-item
            ><el-dropdown-item command="move">移动到文件夹</el-dropdown-item
            ><el-dropdown-item v-if="allowMoveToTeam" command="moveToTeam"
              >移至团队空间</el-dropdown-item
            ><el-dropdown-item command="favorite">{{
              room.favorite ? '取消收藏' : '收藏'
            }}</el-dropdown-item
            ><el-dropdown-item command="share">分享</el-dropdown-item
            ><el-dropdown-item command="history">历史版本</el-dropdown-item
            ><el-dropdown-item v-if="allowDelete" command="delete" divided
              >删除</el-dropdown-item
            ></el-dropdown-menu
          ></el-dropdown
        >
      </div>
      <p><i class="el-icon-folder-opened"></i> {{ room.folderName }}</p>
      <p class="ownerLine">
        所有者 {{ room.owner.name }}
        <el-tag size="mini" type="info">{{ room.roleLabel || room.role }}</el-tag>
      </p>
      <div class="roomMeta">
        <div class="avatarStack">
          <UserAvatar :person="room.owner" :size="24" />
          <UserAvatar
            v-for="person in room.collaborators.slice(0, 2)"
            :key="person.id"
            :person="person"
            :size="24"
          />
        </div>
        <span>{{ dateText }}</span>
      </div>
    </div>
  </article>
</template>
<script>
import UserAvatar from '@/components/UserAvatar.vue'
import roomService from '@/services/roomService'
import MindMapPreview from './MindMapPreview.vue'

const previewCache = new Map()

function cacheKey(room) {
  return [
    room.roomKey || room.id || '',
    room.revision || 0,
    room.contentUpdatedAt || room.updatedAt || ''
  ].join('|')
}

export default {
  name: 'RoomCard',
  components: { UserAvatar, MindMapPreview },
  props: {
    room: Object,
    allowDelete: { type: Boolean, default: false },
    allowMoveToTeam: { type: Boolean, default: true }
  },
  data() {
    return {
      sketch: null,
      observer: null,
      loadingPreview: false
    }
  },
  computed: {
    previewStyle() {
      const url = this.room.previewUrl || this.room.thumbnailUrl || this.room.coverUrl
      return url ? { backgroundImage: `url(${url})` } : {}
    },
    dateText() {
      return new Date(this.room.updatedAt).toLocaleDateString('zh-CN')
    },
    hasImageCover() {
      return !!(this.room.previewUrl || this.room.thumbnailUrl || this.room.coverUrl)
    }
  },
  watch: {
    room: {
      deep: false,
      handler() {
        this.sketch = null
        this.hydrateFromCache()
        this.observePreview()
      }
    }
  },
  mounted() {
    this.hydrateFromCache()
    this.observePreview()
  },
  beforeDestroy() {
    this.disconnectObserver()
  },
  methods: {
    hydrateFromCache() {
      if (this.hasImageCover) return
      const cached = previewCache.get(cacheKey(this.room))
      if (cached) this.sketch = cached
    },
    disconnectObserver() {
      if (this.observer) {
        this.observer.disconnect()
        this.observer = null
      }
    },
    observePreview() {
      this.disconnectObserver()
      if (this.hasImageCover || this.sketch || typeof IntersectionObserver === 'undefined') {
        if (!this.hasImageCover && !this.sketch) this.loadPreview()
        return
      }
      this.observer = new IntersectionObserver(
        entries => {
          if (entries.some(entry => entry.isIntersecting)) {
            this.disconnectObserver()
            this.loadPreview()
          }
        },
        { rootMargin: '120px' }
      )
      if (this.$refs.preview) this.observer.observe(this.$refs.preview)
    },
    async loadPreview() {
      if (this.hasImageCover || this.loadingPreview || this.sketch) return
      const key = this.room.roomKey || this.room.id
      if (!key) return
      this.loadingPreview = true
      try {
        const preview = await roomService.getCardPreview(key)
        const sketch =
          (preview && preview.sketch) || {
            text: this.room.title || '未命名',
            children: []
          }
        previewCache.set(cacheKey(this.room), sketch)
        if ((this.room.roomKey || this.room.id) === key) {
          this.sketch = sketch
        }
      } catch (error) {
        this.sketch = {
          text: this.room.title || '未命名',
          children: []
        }
      } finally {
        this.loadingPreview = false
      }
    }
  }
}
</script>
<style lang="less" scoped>
.ownerLine {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.roomCard {
  background: white;
  border: 1px solid #e3e9e6;
  border-radius: var(--ui-radius-lg);
  overflow: hidden;
  cursor: pointer;
  transition: border-color var(--ui-duration) var(--ui-ease), box-shadow var(--ui-duration) var(--ui-ease), transform var(--ui-duration) var(--ui-ease);
  &:hover {
    transform: translateY(-1px);
    box-shadow: var(--ui-shadow-hover);
    border-color: var(--ui-border-strong);
  }
  .roomPreview {
    height: 126px;
    background: var(--ui-surface-muted);
    background-position: center;
    background-size: cover;
    display: grid;
    place-items: center;
    position: relative;
    overflow: hidden;
  }
  .previewMap {
    position: relative;
    width: 120px;
    height: 56px;
    span, i { position: absolute; display: block; border: 1px solid #9ac8b6; background: #fff; border-radius: 4px; }
    span { width: 44px; height: 20px; left: 38px; top: 18px; background: var(--ui-primary); border-color: var(--ui-primary); }
    i { width: 27px; height: 14px; }
    i:nth-child(2) { left: 0; top: 0; }
    i:nth-child(3) { right: 0; top: 0; }
    i:nth-child(4) { right: 0; bottom: 0; }
    &::before, &::after { content: ''; position: absolute; height: 1px; background: #9ac8b6; width: 40px; top: 27px; }
    &::before { left: 8px; transform: rotate(25deg); transform-origin: right; }
    &::after { right: 8px; transform: rotate(-25deg); transform-origin: left; }
  }
  .favorite {
    position: absolute;
    right: 11px;
    top: 11px;
    border: 0;
    background: white;
    width: 30px;
    height: 30px;
    border-radius: 8px;
    color: #93a19c;
    cursor: pointer;
    z-index: 1;
    &.active {
      color: #e6a23c;
    }
  }
  .roomBody {
    padding: 15px;
  }
  .titleRow {
    display: flex;
    align-items: center;
    h3 {
      flex: 1;
      margin: 0;
      font-size: 15px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .more {
      padding: 7px;
      color: #7f8d88;
    }
  }
  p {
    margin: 8px 0 14px;
    color: #83918c;
    font-size: 12px;
  }
  .roomMeta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: #8e9a96;
    font-size: 12px;
  }
  .avatarStack {
    display: flex;
    /deep/ .userAvatar {
      margin-right: -5px;
      border: 2px solid white;
    }
  }
}
</style>
