<template>
  <section class="dashboardPage">
    <template v-if="isDetail">
      <div class="dashboardHeader dashboardHeader--detail">
        <div>
          <el-button icon="el-icon-arrow-left" @click="backToList"
            >返回数据看板</el-button
          >
        </div>
      </div>
      <div v-if="error" class="statePanel">
        <el-alert type="error" :title="error" :closable="false" show-icon />
        <el-button @click="load">重试</el-button>
      </div>
      <div v-else v-loading="loading" class="dashboardDetail">
        <iframe
          v-if="activeDashboard"
          :key="activeDashboard.id"
          :src="contentUrl(activeDashboard)"
          :title="activeDashboard.title"
          :sandbox="iframeSandbox(activeDashboard, 'allow-scripts allow-forms allow-popups allow-downloads')"
        />
        <div v-else-if="!loading" class="dashboardMissing">
          <i class="el-icon-warning-outline" />
          <strong>数据看板不存在或已被删除</strong>
          <span>请返回数据看板列表重新选择。</span>
        </div>
      </div>
    </template>
    <template v-else>
      <div class="dashboardHeader">
        <div>
          <h1>数据看板</h1>
          <p>按公司层级查看数据看板与健康评分</p>
        </div>
        <div class="dashboardToolbar">
          <el-input
            v-model="searchInput"
            class="toolbarSearch"
            size="small"
            clearable
            prefix-icon="el-icon-search"
            placeholder="搜索看板名称或关键词"
          />
          <el-select v-model="levelFilter" class="toolbarControl" size="small">
            <el-option
              v-for="option in levelOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
          <el-select v-model="sortBy" class="toolbarControl" size="small">
            <el-option label="最近更新" value="updated" />
            <el-option label="健康度最高" value="health" />
            <el-option label="名称排序" value="name" />
          </el-select>
          <el-button-group>
            <el-button
              size="small"
              icon="el-icon-s-grid"
              title="网络视图"
              :class="{ 'is-active': view === 'grid' }"
              @click="view = 'grid'"
            />
            <el-button
              size="small"
              icon="el-icon-menu"
              title="列表视图"
              :class="{ 'is-active': view === 'list' }"
              @click="view = 'list'"
            />
          </el-button-group>
          <el-button
            size="small"
            type="primary"
            icon="el-icon-plus"
            @click="openCreate"
            >新建看板</el-button
          >
        </div>
      </div>
      <div v-if="error" class="statePanel">
        <el-alert type="error" :title="error" :closable="false" show-icon />
        <el-button @click="load">重试</el-button>
      </div>
      <div v-else v-loading="loading" class="dashboardContent">
        <template v-if="visibleSections.length">
          <section
            v-for="group in visibleSections"
            :key="group.level"
            class="dashboardSection"
          >
            <div
              class="sectionTitle"
              :class="{ 'is-collapsed': isCollapsed(group.level) }"
              role="button"
              tabindex="0"
              :aria-expanded="!isCollapsed(group.level)"
              :aria-label="`${isCollapsed(group.level) ? '展开' : '收起'}${group.label}`"
              @click="toggleCollapse(group.level)"
              @keydown.enter="toggleCollapse(group.level)"
            >
              <span class="sectionEmoji">{{ group.emoji }}</span>
              <h2>{{ group.label }}</h2>
              <p>{{ group.desc }}</p>
              <span class="sectionCount">共 {{ group.total }} 个看板</span>
              <i
                class="sectionCaret"
                :class="isCollapsed(group.level) ? 'el-icon-arrow-right' : 'el-icon-arrow-down'"
              />
            </div>
            <div v-show="!isCollapsed(group.level)" class="sectionBody">
            <div v-if="view === 'grid'" class="dashboardGrid">
              <article
                v-for="item in group.items"
                :key="item.id"
                class="dashboardCard"
                tabindex="0"
                :aria-label="`查看 ${item.title}`"
                @click="onCardClick(item)"
                @keydown.enter="onCardClick(item)"
              >
                <div class="hoverActions">
                  <button
                    v-if="item.canDelete"
                    type="button"
                    class="hoverBtn"
                    title="编辑"
                    aria-label="编辑"
                    @click.stop="openEdit(item)"
                  >
                    <i class="el-icon-edit" />
                  </button>
                  <button
                    type="button"
                    class="hoverBtn"
                    title="下载"
                    aria-label="下载"
                    :disabled="downloading"
                    @click.stop="downloadDashboard(item)"
                  >
                    <i class="el-icon-download" />
                  </button>
                  <button
                    type="button"
                    class="hoverBtn"
                    title="在新页面打开"
                    aria-label="在新页面打开"
                    @click.stop="openInNewTab(item)"
                  >
                    <i class="el-icon-top-right" />
                  </button>
                  <button
                    v-if="item.canDelete"
                    type="button"
                    class="hoverBtn hoverBtn--danger"
                    title="删除"
                    aria-label="删除"
                    @click.stop="askDelete(item)"
                  >
                    <i class="el-icon-delete" />
                  </button>
                </div>
                <div class="dashboardPreview">
                  <iframe
                    :src="contentUrl(item)"
                    :title="`${item.title} 缩略预览`"
                    loading="lazy"
                    tabindex="-1"
                    :sandbox="iframeSandbox(item, 'allow-scripts allow-forms')"
                  />
                </div>
                <div class="dashboardBody">
                  <div class="dashboardTitleRow">
                    <h2 :title="item.title">{{ item.title }}</h2>
                    <span class="levelBadge" :class="`levelBadge--${item.level}`">{{
                      levelLabel(item.level)
                    }}</span>
                  </div>
                </div>
              </article>
            </div>
            <div v-else class="dashboardList">
              <article
                v-for="item in group.items"
                :key="item.id"
                class="listCard"
                tabindex="0"
                :aria-label="`查看 ${item.title}`"
                @click="onCardClick(item)"
                @keydown.enter="onCardClick(item)"
              >
                <div class="hoverActions">
                  <button
                    v-if="item.canDelete"
                    type="button"
                    class="hoverBtn"
                    title="编辑"
                    aria-label="编辑"
                    @click.stop="openEdit(item)"
                  >
                    <i class="el-icon-edit" />
                  </button>
                  <button
                    type="button"
                    class="hoverBtn"
                    title="下载"
                    aria-label="下载"
                    :disabled="downloading"
                    @click.stop="downloadDashboard(item)"
                  >
                    <i class="el-icon-download" />
                  </button>
                  <button
                    type="button"
                    class="hoverBtn"
                    title="在新页面打开"
                    aria-label="在新页面打开"
                    @click.stop="openInNewTab(item)"
                  >
                    <i class="el-icon-top-right" />
                  </button>
                  <button
                    v-if="item.canDelete"
                    type="button"
                    class="hoverBtn hoverBtn--danger"
                    title="删除"
                    aria-label="删除"
                    @click.stop="askDelete(item)"
                  >
                    <i class="el-icon-delete" />
                  </button>
                </div>
                <div class="listMain">
                  <div class="listId">
                    <h2 :title="item.title">{{ item.title }}</h2>
                    <span class="levelBadge" :class="`levelBadge--${item.level}`">{{
                      levelLabel(item.level)
                    }}</span>
                    <span class="listStatus"
                      ><i class="rowDot" :class="dotClass(item)" />{{
                        statusLabel(item)
                      }}</span
                    >
                  </div>
                  <div v-if="item.healthSummary" class="healthChip">
                    <i class="el-icon-data-line" />
                    <span>{{ summaryChip(item) }}</span>
                  </div>
                </div>
                <div class="listMetrics">
                  <div class="metric">
                    <div class="metricLabel">品牌健康分</div>
                    <div class="metricValue">{{ scorePart(item, 'health') }}</div>
                  </div>
                  <div class="metric">
                    <div class="metricLabel">财务分</div>
                    <div class="metricValue">{{ scorePart(item, 'fin') }}</div>
                  </div>
                  <div class="metric">
                    <div class="metricLabel">运营分</div>
                    <div class="metricValue">{{ scorePart(item, 'ops') }}</div>
                  </div>
                  <div class="metric">
                    <div class="metricLabel">层级</div>
                    <div class="metricValue metricValue--text">
                      {{ levelLabel(item.level) }}
                    </div>
                  </div>
                </div>
                <div class="listPreviewCard">
                  <div class="miniTitle">看板预览</div>
                  <div class="listPreview">
                    <iframe
                      :src="contentUrl(item)"
                      :title="`${item.title} 预览`"
                      loading="lazy"
                      tabindex="-1"
                      :sandbox="iframeSandbox(item, 'allow-scripts allow-forms')"
                    />
                  </div>
                </div>
                <div class="listInfoCard">
                  <div class="miniTitle">看板信息</div>
                  <div class="infoRow">
                    <span class="infoKey">层级</span>
                    <span class="infoVal">{{ levelLabel(item.level) }}</span>
                  </div>
                  <div class="infoRow">
                    <span class="infoKey">状态</span>
                    <span class="infoVal">{{ statusLabel(item) }}</span>
                  </div>
                  <div class="infoRow">
                    <span class="infoKey">文件</span>
                    <span class="infoVal" :title="item.fileName">{{
                      item.fileName
                    }}</span>
                  </div>
                  <div class="infoRow">
                    <span class="infoKey">更新</span>
                    <span class="infoVal">{{ formatDate(item.updatedAt) }}</span>
                  </div>
                </div>
              </article>
            </div>
            <div v-if="group.total > pageSize" class="sectionPager">
              <el-pagination
                small
                background
                layout="total, prev, pager, next"
                :current-page="group.page"
                :page-size="pageSize"
                :total="group.total"
                @current-change="p => setPage(group.level, p)"
              />
            </div>
            </div>
          </section>
        </template>
        <EmptyState
          v-else-if="!loading"
          icon="el-icon-data-analysis"
          :title="dashboards.length ? '没有找到匹配的看板' : '还没有品牌数据看板'"
          :description="
            dashboards.length
              ? '试试调整搜索关键词或层级筛选。'
              : '点击右上角“新建看板”，填写名称、选择层级并上传数据看板 HTML。'
          "
          :action="dashboards.length ? '' : '新建看板'"
          @action="openCreate"
        />
      </div>
      <DashboardFormDialog
        :visible.sync="createDialogVisible"
        @done="load"
      />
      <DashboardFormDialog
        :visible.sync="editDialogVisible"
        :dashboard="editTarget"
        @done="load"
      />
    </template>
  </section>
</template>

<script>
import { userMessageFromError } from '@/services/apiError'
import brandDashboardService from '@/services/brandDashboardService'
import EmptyState from './components/EmptyState.vue'
import DashboardFormDialog from './components/DashboardFormDialog.vue'

const LEVEL_META = [
  {
    level: 'group',
    emoji: '👑',
    label: '集团级看板',
    desc: '从集团视角把握整体战略、业务布局与关键指标'
  },
  {
    level: 'department',
    emoji: '🏢',
    label: '部门级看板',
    desc: '按部门查看业务进展、团队目标与执行情况'
  },
  {
    level: 'project',
    emoji: '🎯',
    label: '项目级看板',
    desc: '按项目跟管理程碑、任务进度与项目成果'
  }
]

export default {
  name: 'BrandDashboardsPage',
  components: { EmptyState, DashboardFormDialog },
  data() {
    return {
      loading: false,
      error: '',
      dashboards: [],
      controller: null,
      searchInput: '',
      search: '',
      searchTimer: null,
      levelFilter: 'all',
      sortBy: 'updated',
      view: 'grid',
      createDialogVisible: false,
      deleting: false,
      downloading: false,
      editDialogVisible: false,
      editTarget: null,
      pageSize: 9,
      pageByLevel: {},
      collapsedLevels: [],
      levelOptions: [
        { label: '全部层级', value: 'all' },
        { label: '集团级', value: 'group' },
        { label: '部门级', value: 'department' },
        { label: '项目级', value: 'project' }
      ]
    }
  },
  computed: {
    isDetail() {
      return !!this.$route.params.id
    },
    activeDashboard() {
      const id = String(this.$route.params.id || '')
      return this.dashboards.find(item => String(item.id) === id) || null
    },
    matchedSorted() {
      const keyword = this.search.trim().toLowerCase()
      const matched = this.dashboards.filter(item => {
        if (this.levelFilter !== 'all' && item.level !== this.levelFilter) {
          return false
        }
        if (!keyword) return true
        return [item.title, item.fileName, item.healthSummary].some(value =>
          String(value || '').toLowerCase().includes(keyword)
        )
      })
      const sorters = {
        updated: (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
        health: (a, b) =>
          this.healthScore(b) - this.healthScore(a) ||
          String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
        name: (a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN')
      }
      return matched.slice().sort(sorters[this.sortBy] || sorters.updated)
    },
    visibleSections() {
      return LEVEL_META.map(meta => {
        const all = this.matchedSorted.filter(
          item => (item.level || 'group') === meta.level
        )
        const maxPage = Math.max(1, Math.ceil(all.length / this.pageSize))
        const page = Math.min(Math.max(1, this.pageByLevel[meta.level] || 1), maxPage)
        return {
          ...meta,
          total: all.length,
          page,
          items: all.slice((page - 1) * this.pageSize, page * this.pageSize)
        }
      }).filter(group => group.total > 0)
    }
  },
  watch: {
    '$route.fullPath'() {
      if (!this.dashboards.length) this.load()
    },
    searchInput(value) {
      if (this.searchTimer) clearTimeout(this.searchTimer)
      this.searchTimer = setTimeout(() => {
        this.search = value
      }, 250)
    },
    search() {
      this.pageByLevel = {}
    },
    levelFilter() {
      this.pageByLevel = {}
    },
    sortBy() {
      this.pageByLevel = {}
    }
  },
  created() {
    this.load()
  },
  beforeDestroy() {
    if (this.controller) this.controller.abort()
    if (this.searchTimer) clearTimeout(this.searchTimer)
  },
  methods: {
    async load() {
      if (this.controller) this.controller.abort()
      this.controller = typeof AbortController !== 'undefined' ? new AbortController() : null
      this.loading = true
      this.error = ''
      try {
        const result = await brandDashboardService.listBrandDashboards({
          signal: this.controller && this.controller.signal
        })
        this.dashboards = result.list
      } catch (error) {
        if (error && error.name === 'AbortError') return
        this.error = userMessageFromError(error) || '读取数据看板失败'
      } finally {
        this.loading = false
      }
    },
    contentUrl(item) {
      if (item && item.sourceType === 'url' && item.sourceUrl) {
        return item.sourceUrl
      }
      return brandDashboardService.dashboardContentUrl(item.id)
    },
    iframeSandbox(item, htmlSandbox) {
      return item && item.sourceType === 'url' && item.sourceUrl
        ? 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads'
        : htmlSandbox
    },
    openDashboard(item) {
      if (!item) return
      this.$router.push({
        name: 'BrandDashboardDetail',
        params: { id: item.id }
      })
    },
    openCreate() {
      this.createDialogVisible = true
    },
    openEdit(item) {
      this.editTarget = item
      this.editDialogVisible = true
    },
    async downloadDashboard(item) {
      if (!item || this.downloading) return
      this.downloading = true
      try {
        const response = await fetch(
          brandDashboardService.dashboardDownloadUrl(item.id),
          { credentials: 'include' }
        )
        if (!response.ok) {
          let message = '下载数据看板失败'
          try {
            const data = await response.json()
            if (data && data.error) message = data.error
          } catch (error) {
            // ignore parse failure
          }
          throw new Error(message)
        }
        const blob = await response.blob()
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = this.downloadFileName(item)
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        URL.revokeObjectURL(url)
        if (this.$message) this.$message.success(`已开始下载「${item.title}」`)
      } catch (error) {
        if (this.$message) {
          this.$message.error(
            userMessageFromError(error) || '下载数据看板失败'
          )
        }
      } finally {
        this.downloading = false
      }
    },
    downloadFileName(item) {
      let name = String((item && item.fileName) || '').trim()
      if (!name) name = `${(item && item.title) || '数据看板'}.html`
      if (!/\.html?$/i.test(name)) name += '.html'
      return name
    },
    onCardClick(item) {
      if (!item) return
      this.openDashboard(item)
    },
    openInNewTab(item) {
      if (!item) return
      window.open(this.contentUrl(item), '_blank', 'noopener')
    },
    async askDelete(item) {
      if (!item || this.deleting) return
      try {
        await this.$confirm(
          `确定删除看板「${item.title}」吗？删除后不可恢复。`,
          '删除看板',
          {
            type: 'warning',
            confirmButtonText: '删除',
            cancelButtonText: '取消',
            confirmButtonClass: 'el-button--danger'
          }
        )
      } catch (error) {
        return
      }
      this.deleting = true
      try {
        await brandDashboardService.deleteDashboard(item.id)
        if (this.$message) this.$message.success(`已删除看板「${item.title}」`)
        await this.load()
      } catch (error) {
        if (this.$message) {
          this.$message.error(userMessageFromError(error) || '删除失败')
        }
      } finally {
        this.deleting = false
      }
    },
    backToList() {
      this.$router.push({ name: 'BrandDashboards' })
    },
    setPage(level, page) {
      this.$set(this.pageByLevel, level, page)
    },
    isCollapsed(level) {
      return this.collapsedLevels.includes(level)
    },
    toggleCollapse(level) {
      const index = this.collapsedLevels.indexOf(level)
      if (index >= 0) this.collapsedLevels.splice(index, 1)
      else this.collapsedLevels.push(level)
    },
    levelLabel(level) {
      if (level === 'department') return '部门级'
      if (level === 'project') return '项目级'
      return '集团级'
    },
    healthScore(item) {
      const text = String((item && (item.healthSummary || item.title)) || '')
      const match = text.match(/品牌健康分[：:]\s*(\d+(?:\.\d+)?)/)
      return match ? Number(match[1]) : -1
    },
    scorePart(item, kind) {
      const text = String((item && item.healthSummary) || '')
      if (!text) return '--'
      const patterns = {
        health: /品牌健康分[：:]\s*([^\s=＝，,；;。]+)/,
        fin: /财务分\s*([^\s×xX*＋+=＝，,；;。]+)/,
        ops: /运营分\s*([^\s×xX*＋+=＝，,；;。]+)/
      }
      const match = text.match(patterns[kind] || patterns.health)
      return match ? match[1] : '--'
    },
    summaryChip(item) {
      return `品牌健康分：${this.scorePart(item, 'health')} · 财务分 ${this.scorePart(
        item,
        'fin'
      )} · 运营分 ${this.scorePart(item, 'ops')}`
    },
    dotClass() {
      return 'is-ok'
    },
    statusLabel() {
      return '正常'
    },
    formatDate(value) {
      if (!value) return ''
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN')
    }
  }
}
</script>

<style lang="less" scoped>
.dashboardPage { padding: 24px 28px 40px; min-height: 100vh; box-sizing: border-box; }
.dashboardHeader { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 22px; flex-wrap: wrap;
  h1 { margin: 0; font-size: 24px; color: var(--ui-text); }
  p { margin: 7px 0 0; color: var(--ui-text-secondary); font-size: 13px; }
  &--detail { flex-wrap: nowrap; p { display: none; } }
}
.dashboardToolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  .toolbarSearch { width: 240px; }
  .toolbarControl { width: 110px; }
  .el-button.is-active { background: var(--ui-primary); border-color: var(--ui-primary); color: #fff; }
}
.hoverActions { position: absolute; top: 10px; right: 12px; z-index: 3; display: flex; gap: 8px; opacity: 0; transform: translateY(-2px); transition: opacity .15s ease, transform .15s ease; pointer-events: none; }
.dashboardCard:hover .hoverActions, .dashboardCard:focus-within .hoverActions,
.listCard:hover .hoverActions, .listCard:focus-within .hoverActions { opacity: 1; transform: none; pointer-events: auto; }
.hoverBtn { width: 30px; height: 30px; border: 1px solid rgba(17,24,39,.08); border-radius: 8px; background: rgba(255,255,255,.94); color: #4b5563; display: grid; place-items: center; cursor: pointer; font-size: 14px; box-shadow: 0 2px 8px rgba(17,24,39,.12); transition: color .15s ease, border-color .15s ease;
  &:hover { color: #1677ff; border-color: #1677ff; }
  &--danger:hover { color: #ff4d4f; border-color: #ff4d4f; }
}
@media (hover: none) { .hoverActions { opacity: 1; transform: none; pointer-events: auto; } }
.statePanel { display: grid; gap: 12px; justify-items: start; }
.dashboardContent { min-height: 260px; }
.sectionPager { display: flex; justify-content: center; margin: 14px 0 2px; }
.dashboardSection { margin-bottom: 26px; }
.sectionTitle { display: flex; align-items: center; gap: 10px; margin: 0 4px 10px; cursor: pointer; user-select: none; border-radius: 8px; padding: 4px 8px;
  &:hover { background: var(--ui-surface-muted); }
  &:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 2px; }
  .sectionEmoji { font-size: 22px; }
  h2 { margin: 0; font-size: 18px; color: var(--ui-text); }
  p { margin: 0; color: var(--ui-text-secondary); font-size: 13px; }
  .sectionCount { margin-left: auto; color: var(--ui-text-secondary); font-size: 13px; }
  .sectionCaret { flex: 0 0 auto; color: var(--ui-text-secondary); font-size: 14px; }
  &.is-collapsed { margin-bottom: 4px;
    p { color: #a9b6b1; }
  }
}
.dashboardGrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 18px; }
.dashboardCard { position: relative; min-width: 0; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-lg); overflow: hidden; background: var(--ui-surface); cursor: pointer; transition: border-color .15s, box-shadow .15s, transform .15s;
  &:hover, &:focus-visible { border-color: var(--ui-border-strong); box-shadow: var(--ui-shadow-hover); transform: translateY(-1px); outline: none; }
}
.dashboardPreview { height: 220px; overflow: hidden; position: relative; background: var(--ui-surface-muted);
  iframe { width: 1600px; height: 900px; border: 0; transform: scale(.32); transform-origin: left top; pointer-events: none; background: #fff; }
}
.dashboardBody { padding: 16px; }
.dashboardTitleRow { display: flex; align-items: center; gap: 8px;
  h2 { flex: 1; min-width: 0; margin: 0; font-size: 13px; line-height: 1.5; color: var(--ui-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
}
.levelBadge { flex: 0 0 auto; font-size: 12px; line-height: 1; border-radius: 5px; padding: 4px 7px; background: #fff1dc; color: #d57b00;
  &--department { background: #e8f3ff; color: #1677ff; }
  &--project { background: #e8f8ef; color: #08955d; }
}
.dashboardList { display: grid; gap: 14px; }
.listCard { position: relative; display: grid; grid-template-columns: 210px minmax(350px, 1.1fr) 300px 250px; gap: 14px; padding: 14px; border: 1px solid #e6ece9; border-radius: 16px; background: #fff; box-shadow: 0 2px 10px rgba(20, 45, 35, .05); cursor: pointer; transition: .2s ease;
  &:hover, &:focus-visible { transform: translateY(-1px); box-shadow: 0 12px 32px rgba(20, 45, 35, .08); border-color: #dfe8e3; outline: none; }
}
.listMain { min-width: 0; display: flex; flex-direction: column; justify-content: flex-start; gap: 18px; min-height: 146px; padding: 8px 4px 4px 0; }
.listId { display: flex; align-items: center; gap: 9px; flex-wrap: wrap;
  h2 { margin: 0; font-size: 18px; font-weight: 800; color: var(--ui-text); }
  .levelBadge { height: 24px; display: inline-flex; align-items: center; padding: 0 9px; border-radius: 999px; font-size: 12px; font-weight: 700; }
}
.listStatus { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #607269; white-space: nowrap; }
.rowDot { width: 8px; height: 8px; border-radius: 50%; background: #13a77a; flex: 0 0 auto; }
.healthChip { margin-top: auto; display: inline-flex; align-items: center; gap: 7px; padding: 8px 10px; border-radius: 9px; background: #f4fbf8; color: #417466; font-size: 12px; max-width: 100%;
  i { color: #0f8a63; font-size: 14px; flex: 0 0 auto; }
  span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
}
.listMetrics { min-width: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 9px; align-content: center; }
.metric { min-width: 0; background: linear-gradient(180deg, #f4faf7, #edf6f2); border: 1px solid #e4f0ea; border-radius: 11px; padding: 13px 12px; min-height: 82px;
  .metricLabel { font-size: 12px; color: #678078; margin-bottom: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .metricValue { font-size: 22px; line-height: 1; font-weight: 800; color: var(--ui-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    &--text { font-size: 16px; }
  }
}
.listPreviewCard, .listInfoCard { min-width: 0; border: 1px solid #e6ece9; border-radius: 12px; background: #fff; padding: 11px; min-height: 146px; display: flex; flex-direction: column; }
.miniTitle { font-size: 12px; font-weight: 800; color: #42564d; margin-bottom: 9px; }
.listPreview { height: 102px; border: 1px solid #e7eee9; border-radius: 9px; overflow: hidden; background: #f8fbf9;
  iframe { width: 1600px; height: 900px; border: 0; transform: scale(.1725); transform-origin: left top; pointer-events: none; background: #fff; }
}
.infoRow { display: grid; grid-template-columns: 48px 1fr; gap: 8px; margin: 7px 0; font-size: 12px; min-width: 0; }
.infoKey { color: #8b9a93; }
.infoVal { color: #43564e; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dashboardDetail { height: calc(100vh - 170px); min-height: 520px; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-lg); overflow: hidden; background: #fff;
  iframe { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
}
.dashboardMissing { min-height: 320px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--ui-text-secondary); text-align: center;
  i { font-size: 42px; color: #8db7a7; }
  strong { margin: 0; color: var(--ui-text); }
  span { margin: 0; }
}
@media (max-width: 1280px) {
  .listCard { grid-template-columns: 185px minmax(360px, 1fr) 280px; }
  .listInfoCard { display: none; }
  .listPreview iframe { transform: scale(.16); }
}
@media (max-width: 980px) {
  .listCard { grid-template-columns: 1fr; }
  .listPreviewCard { display: none; }
}
@media (max-width: 760px) {
  .dashboardPage { padding: 18px 14px 28px; }
  .dashboardHeader { align-items: stretch; flex-direction: column; }
  .dashboardToolbar { width: 100%; .toolbarSearch { width: 100%; } }
  .dashboardGrid { grid-template-columns: 1fr; }
  .dashboardPreview { height: 180px; }
  .dashboardDetail { height: calc(100vh - 220px); min-height: 420px; }
  .listCard { display: flex; flex-direction: column; gap: 10px; }
  .listMain { min-height: auto; padding: 0; }
  .listMetrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .sectionTitle p { display: none; }
}
</style>
