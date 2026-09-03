<template>
  <div
    class="searchContainer"
    data-testid="search"
    :class="{ isDark: isDark, show: show }"
  >
    <div class="closeBtnBox">
      <span class="closeBtn el-icon-close" @click="close"></span>
    </div>
    <div class="searchInputBox">
      <el-input
        ref="searchInputRef"
        :placeholder="$t('search.searchPlaceholder')"
        size="small"
        v-model="searchText"
        @keyup.native.enter.stop="onSearchNext"
        @keydown.native.stop
        @focus="onFocus"
        @blur="onBlur"
      >
        <i slot="prefix" class="el-input__icon el-icon-search"></i>
        <el-button
          size="small"
          slot="append"
          data-testid="replace"
          v-if="!isUndef(searchText)"
          @click="showReplaceInput = true"
          >{{ $t('search.replace') }}</el-button
        >
      </el-input>
      <div class="searchInfo" v-if="showSearchInfo && !isUndef(searchText)">
        {{ currentIndex }} / {{ total }}
      </div>
    </div>
    <el-input
      v-if="showReplaceInput"
      ref="replaceInputRef"
      :placeholder="$t('search.replacePlaceholder')"
      size="small"
      v-model="replaceText"
      style="margin: 12px 0;"
      @keydown.native.stop
      @focus="onFocus"
      @blur="onBlur"
    >
      <i slot="prefix" class="el-input__icon el-icon-edit"></i>
      <el-button size="small" slot="append" @click="hideReplaceInput">{{
        $t('search.cancel')
      }}</el-button>
    </el-input>
    <div class="btnList" v-if="showReplaceInput">
      <el-button
        size="small"
        :disabled="replaceDisabled"
        :loading="searching"
        @click="replace"
        >{{ $t('search.replace') }}</el-button
      >
      <el-button
        size="small"
        :disabled="replaceDisabled"
        :loading="searching"
        @click="replaceAll"
        >{{ $t('search.replaceAll') }}</el-button
      >
    </div>
    <div
      class="searchResultList"
      :style="{ height: searchResultListHeight + 'px' }"
      v-if="showSearchResultList"
    >
      <div
        class="searchResultItem"
        v-for="(item, index) in searchResultList"
        :key="(item.uid || item.id || 'hit') + '-' + index"
        :title="item.name"
        v-html="item.text"
        @click.stop="onSearchResultItemClick(index)"
      ></div>
      <div class="empty" v-if="searchResultList.length <= 0">
        <span class="iconfont iconwushuju"></span>
        <span class="text">{{ $t('search.noResult') }}</span>
      </div>
    </div>
  </div>
</template>

<script>
import { mapState } from 'vuex'
import { isUndef, getTextFromHtml } from 'simple-mind-map/src/utils/index'
import { searchFile, searchFileAll } from '@/utils/fileApi'

// 搜索替换
export default {
  props: {
    mindMap: {
      type: Object
    }
  },
  data() {
    return {
      show: false,
      searchText: '',
      replaceText: '',
      showReplaceInput: false,
      currentIndex: 0,
      total: 0,
      showSearchInfo: false,
      searchResultListHeight: 0,
      searchResultList: [],
      showSearchResultList: false,
      searching: false,
      lastExecutedQuery: '',
      currentMatchUid: '',
      searchTimer: null,
      invalidateTimer: null,
      searchSeq: 0
    }
  },
  computed: {
    ...mapState({
      isReadonly: state => state.isReadonly,
      isDark: state => state.localConfig.isDark
    }),
    httpSearchActive() {
      const cooperate = this.mindMap && this.mindMap.cooperate
      return !!(cooperate && cooperate.httpCollabMode && cooperate.httpRoomKey)
    },
    replaceDisabled() {
      return this.isReadonly || isUndef(this.searchText) || !String(this.searchText).trim()
    }
  },
  watch: {
    searchText() {
      if (isUndef(this.searchText)) {
        this.currentIndex = 0
        this.total = 0
        this.showSearchInfo = false
        this.searchResultList = []
        this.lastExecutedQuery = ''
        this.currentMatchUid = ''
        this.clearSearchTimer()
        return
      }
      this.scheduleAutoSearch()
    }
  },
  created() {
    this.$bus.$on('show_search', this.showSearch)
    this.mindMap.on('search_info_change', this.handleSearchInfoChange)
    this.mindMap.on('node_click', this.blur)
    this.mindMap.on('draw_click', this.blur)
    this.mindMap.on('expand_btn_click', this.blur)
    this.mindMap.on(
      'search_match_node_list_change',
      this.onSearchMatchNodeListChange
    )
    this.mindMap.keyCommand.addShortcut('Control+f', this.showSearch)
    this.mindMap.on('collab_search_invalidate', this.onCollabSearchInvalidate)
    this.mindMap.on('collab_replace_all_done', this.onCollabReplaceAllDone)
    window.addEventListener('resize', this.setSearchResultListHeight)
    this.$bus.$on('setData', this.close)
  },
  mounted() {
    this.setSearchResultListHeight()
  },
  beforeDestroy() {
    this.$bus.$off('show_search', this.showSearch)
    this.mindMap.off('search_info_change', this.handleSearchInfoChange)
    this.mindMap.off('node_click', this.blur)
    this.mindMap.off('draw_click', this.blur)
    this.mindMap.off('expand_btn_click', this.blur)
    this.mindMap.off(
      'search_match_node_list_change',
      this.onSearchMatchNodeListChange
    )
    this.mindMap.keyCommand.removeShortcut('Control+f', this.showSearch)
    this.mindMap.off('collab_search_invalidate', this.onCollabSearchInvalidate)
    this.mindMap.off('collab_replace_all_done', this.onCollabReplaceAllDone)
    window.removeEventListener('resize', this.setSearchResultListHeight)
    this.$bus.$off('setData', this.close)
    this.clearSearchTimer()
    if (this.invalidateTimer) {
      clearTimeout(this.invalidateTimer)
      this.invalidateTimer = null
    }
  },
  methods: {
    isUndef,

    handleSearchInfoChange(data) {
      if (this.httpSearchActive) return
      this.currentIndex = data.currentIndex + 1
      this.total = data.total
      this.showSearchInfo = true
    },

    showSearch() {
      this.$bus.$emit('closeSideBar')
      this.show = true
      this.$refs.searchInputRef.focus()
    },

    hideReplaceInput() {
      this.showReplaceInput = false
      this.replaceText = ''
    },

    // 输入框聚焦时，禁止思维导图节点响应按键事件自动进入文本编辑
    onFocus() {
      this.mindMap.updateConfig({
        enableAutoEnterTextEditWhenKeydown: false
      })
    },

    // 输入框失焦时恢复
    onBlur() {
      this.mindMap.updateConfig({
        enableAutoEnterTextEditWhenKeydown: true
      })
    },

    // 画布，节点点击时让输入框失焦
    blur() {
      if (this.$refs.searchInputRef) {
        this.$refs.searchInputRef.blur()
      }
      if (this.$refs.replaceInputRef) {
        this.$refs.replaceInputRef.blur()
      }
    },

    clearSearchTimer() {
      if (this.searchTimer) {
        clearTimeout(this.searchTimer)
        this.searchTimer = null
      }
    },

    scheduleAutoSearch() {
      this.clearSearchTimer()
      this.searchTimer = setTimeout(() => {
        this.searchTimer = null
        this.runSearch({ reveal: false })
      }, 250)
    },

    onCollabSearchInvalidate() {
      if (!this.show || !this.searchText) return
      if (this.invalidateTimer) clearTimeout(this.invalidateTimer)
      this.invalidateTimer = setTimeout(() => {
        this.invalidateTimer = null
        this.lastExecutedQuery = ''
        this.runSearch({ reveal: false })
      }, 300)
    },

    onCollabReplaceAllDone(info) {
      if (!info || !info.skipped) return
      this.$message &&
        this.$message.warning(
          `已替换 ${info.replaced} 项，${info.skipped} 项因其他协作者已修改而跳过。`
        )
    },

    onSearchNext() {
      this.showSearchResultList = true
      this.clearSearchTimer()
      this.runSearch({ reveal: true, immediate: true })
    },

    mapSearchHits(matches, needle) {
      const q = String(needle || '').trim()
      return (matches || []).map(item => {
        const uid = item.uid || item.id
        const name = item.name || item.text || ''
        const text = q
          ? name.replace(
              new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
              a => `<span class="match">${a}</span>`
            )
          : name
        return {
          data: item,
          id: uid,
          text,
          name,
          uid
        }
      })
    },

    mergeLocalMatches(httpMatches, query) {
      const cooperate = this.mindMap && this.mindMap.cooperate
      const local =
        cooperate && typeof cooperate.collectLocalSearchMatches === 'function'
          ? cooperate.collectLocalSearchMatches(query)
          : []
      const seen = new Set()
      const out = []
      ;(httpMatches || []).concat(local || []).forEach(item => {
        const uid = item && (item.uid || item.id)
        if (!uid || seen.has(uid)) return
        seen.add(uid)
        out.push(item)
      })
      return out
    },

    applySearchHits(matches, query, opts = {}) {
      const keepUid = this.currentMatchUid
      const mapped = this.mapSearchHits(matches, query)
      this.searchResultList = mapped
      this.total = Number(opts.total != null ? opts.total : mapped.length)
      this.showSearchInfo = true
      this.showSearchResultList = true
      this.lastExecutedQuery = String(query || '').trim()
      let idx = mapped.findIndex(item => item.uid === keepUid)
      if (idx < 0) idx = 0
      this.currentIndex = mapped.length ? idx + 1 : 0
      this.currentMatchUid = mapped[idx] ? mapped[idx].uid : ''
      return mapped
    },

    async runSearch(opts = {}) {
      const query = String(this.searchText || '').trim()
      if (!query) {
        this.searchResultList = []
        this.total = 0
        this.showSearchInfo = false
        this.lastExecutedQuery = ''
        return []
      }
      const cooperate = this.mindMap && this.mindMap.cooperate
      if (this.httpSearchActive) {
        const seq = ++this.searchSeq
        this.searching = true
        try {
          const data = opts.all
            ? await searchFileAll(cooperate.httpRoomKey, query)
            : await searchFile(cooperate.httpRoomKey, query, 200)
          if (seq !== this.searchSeq) return this.searchResultList
          const merged = this.mergeLocalMatches(data.matches || [], query)
          const mapped = this.applySearchHits(merged, query, {
            total: Math.max(
              Number(data.total || 0),
              merged.length
            )
          })
          if (opts.reveal && this.currentMatchUid) {
            await cooperate.revealUid(this.currentMatchUid)
          }
          return mapped
        } catch (err) {
          if (seq !== this.searchSeq) return this.searchResultList
          const local = this.mergeLocalMatches([], query)
          return this.applySearchHits(local, query, { total: local.length })
        } finally {
          if (seq === this.searchSeq) this.searching = false
        }
      }
      this.mindMap.search.search(this.searchText)
      return this.searchResultList
    },

    async ensureSearchExecuted(opts = {}) {
      const query = String(this.searchText || '').trim()
      if (!query) return false
      if (
        !opts.force &&
        this.lastExecutedQuery === query &&
        (this.searchResultList.length > 0 || this.total === 0)
      ) {
        if (opts.all && this.httpSearchActive) {
          await this.runSearch({ all: true, reveal: false })
        }
        return true
      }
      await this.runSearch({
        reveal: !!opts.reveal,
        all: !!opts.all,
        immediate: true
      })
      return true
    },

    async searchLargeMap(cooperate, opts = {}) {
      return this.runSearch(opts)
    },

    async replace() {
      const query = String(this.searchText || '').trim()
      if (!query || this.isReadonly) return
      const cooperate = this.mindMap && this.mindMap.cooperate
      if (cooperate && cooperate.httpCollabMode && cooperate.collabV2Adapter) {
        await this.ensureSearchExecuted()
        const idx = Math.max(0, (this.currentIndex || 1) - 1)
        const item = this.searchResultList[idx]
        if (!item || !item.uid) return
        const replacedUid = item.uid
        try {
          await cooperate.replaceOneBySearchMatch(
            item,
            query,
            this.replaceText
          )
          this.currentMatchUid = replacedUid
          await this.runSearch({ reveal: false })
          if (this.currentMatchUid === replacedUid) {
            const still = this.searchResultList.find(hit => hit.uid === replacedUid)
            if (!still && this.searchResultList[0]) {
              this.currentMatchUid = this.searchResultList[0].uid
              this.currentIndex = 1
            }
          }
        } catch (err) {
          if (err && err.code === 'REPLACE_CONFLICT') {
            this.$message &&
              this.$message.warning('该项已被其他协作者修改，已跳过')
            await this.runSearch({ reveal: false })
            return
          }
          this.$message &&
            this.$message.error((err && (err.message || err.code)) || '替换失败')
        }
        return
      }
      if (this.lastExecutedQuery !== query) {
        this.mindMap.search.search(query)
      }
      this.mindMap.search.replace(this.replaceText, true)
    },

    async replaceAll() {
      const query = String(this.searchText || '').trim()
      if (!query || this.isReadonly) return
      const cooperate = this.mindMap && this.mindMap.cooperate
      if (cooperate && cooperate.httpCollabMode && cooperate.collabV2Adapter) {
        await this.ensureSearchExecuted({ all: true })
        const data = await searchFileAll(cooperate.httpRoomKey, query)
        const matches = this.mergeLocalMatches(data.matches || [], query)
        this.applySearchHits(matches, query, {
          total: Math.max(Number(data.total || 0), matches.length)
        })
        if (!matches.length) return
        try {
          await cooperate.replaceAllBySearchMatches(
            matches,
            query,
            this.replaceText
          )
          await this.runSearch({ reveal: false, all: true })
        } catch (err) {
          this.$message &&
            this.$message.error(
              (err && (err.message || err.code)) || '全部替换失败'
            )
        }
        return
      }
      if (this.lastExecutedQuery !== query) {
        this.mindMap.search.search(query)
      }
      this.mindMap.search.replaceAll(this.replaceText)
    },

    close() {
      this.show = false
      this.showSearchResultList = false
      this.showSearchInfo = false
      this.total = 0
      this.currentIndex = 0
      this.searchText = ''
      this.lastExecutedQuery = ''
      this.currentMatchUid = ''
      this.hideReplaceInput()
      this.clearSearchTimer()
      this.mindMap.search.endSearch()
    },

    onSearchMatchNodeListChange(list) {
      if (this.httpSearchActive) return
      this.searchResultList = list.map(item => {
        const data = item.data || item.nodeData.data
        let name = data.text
        const id = data.uid
        if (data.richText) {
          name = getTextFromHtml(name)
        }
        const reg = new RegExp(`${this.searchText.trim()}`, 'g')
        const text = name.replace(reg, a => {
          return `<span class="match">${a}</span>`
        })
        return {
          data: item,
          id,
          uid: id,
          text,
          name
        }
      })
    },

    setSearchResultListHeight() {
      this.searchResultListHeight = window.innerHeight - 267 - 24
    },

    onSearchResultItemClick(index) {
      const cooperate = this.mindMap && this.mindMap.cooperate
      const item = this.searchResultList[index]
      if (cooperate && cooperate.httpCollabMode && item && item.uid) {
        this.currentIndex = index + 1
        this.currentMatchUid = item.uid
        cooperate.revealUid(item.uid)
        return
      }
      this.mindMap.search.jump(index)
    }
  }
}
</script>

<style lang="less" scoped>
.searchContainer {
  position: relative;
  background-color: #fff;
  padding: 16px;
  width: 296px;
  border-radius: 12px;
  box-shadow: 0 4px 16px 0 rgba(0, 0, 0, 0.1);
  position: fixed;
  top: 110px;
  right: -296px;
  transition: all 0.3s;

  &.isDark {
    background-color: #363b3f;

    .closeBtnBox {
      color: #fff;
      background-color: #363b3f;
    }
  }

  &.show {
    right: 20px;
  }

  .btnList {
    display: flex;
    justify-content: flex-end;
  }

  .closeBtnBox {
    position: absolute;
    right: -5px;
    top: -5px;
    width: 20px;
    height: 20px;
    background-color: #fff;
    border-radius: 50%;
    display: flex;
    justify-content: center;
    align-items: center;
    cursor: pointer;
    box-shadow: 0 4px 16px 0 rgba(0, 0, 0, 0.1);

    .closeBtn {
      font-size: 16px;
    }
  }

  .searchInputBox {
    position: relative;

    .searchInfo {
      position: absolute;
      right: 70px;
      top: 50%;
      transform: translateY(-50%);
      color: #909090;
      font-size: 14px;
    }
  }

  .searchResultList {
    position: absolute;
    left: 0;
    top: 100%;
    width: 100%;
    background-color: #fff;
    box-shadow: 0 4px 16px 0 rgba(0, 0, 0, 0.1);
    border-radius: 12px;
    margin-top: 5px;
    overflow-y: auto;
    padding: 12px 0;

    .searchResultItem {
      height: 30px;
      line-height: 30px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      padding: 0 12px;
      font-size: 14px;
      cursor: pointer;
      position: relative;
      padding-left: 22px;

      &::before {
        content: '';
        position: absolute;
        left: 10px;
        top: 50%;
        transform: translateY(-50%);
        width: 5px;
        height: 5px;
        background-color: #606266;
        border-radius: 50%;
      }

      &:hover {
        background-color: #f2f4f7;
      }

      /deep/.match {
        color: #409eff;
        font-weight: bold;
      }
    }

    .empty {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;

      .iconfont {
        font-size: 50px;
        margin-bottom: 20px;
      }

      .text {
        font-size: 14px;
        color: rgba(26, 26, 26, 0.8);
      }
    }
  }
}
</style>
