<template>
  <section class="productPage cogneeAccessPage">
    <div class="productHeader">
      <div>
        <h1>Cognee 接入</h1>
        <p>CPD知识图谱（Cognee）探活、数据集与语义检索</p>
      </div>
      <el-button
        size="small"
        icon="el-icon-refresh"
        :loading="checking"
        @click="refresh"
        >刷新状态</el-button
      >
    </div>

    <div class="cogneeGrid">
      <section class="card">
        <h2>连接状态</h2>
        <p class="hint">经网关 <code>/cognee-api</code> 代理，密钥不进浏览器</p>
        <div class="statusRow">
          <span
            class="dot"
            :class="health.ok ? 'ok' : health.checked ? 'bad' : ''"
          />
          <strong>{{
            !health.checked
              ? '未检查'
              : health.ok
                ? `已连接 · ${health.version || health.status || 'ready'}`
                : health.message || '未连接'
          }}</strong>
        </div>
        <p class="meta">数据集默认：{{ dataset }}</p>
        <ul v-if="datasets.length" class="datasetList">
          <li v-for="d in datasets" :key="d.id || d.name">
            {{ d.name || d.id }}
          </li>
        </ul>
        <p v-else-if="health.ok" class="meta">暂无数据集列表</p>
      </section>

      <section class="card">
        <h2>语义检索</h2>
        <p class="hint">search_type 默认 GRAPH_COMPLETION</p>
        <el-input
          v-model="query"
          type="textarea"
          :rows="3"
          placeholder="输入问题，例如：招聘流程里 HRBP 做什么？"
          @keydown.ctrl.enter.native="runSearch"
        />
        <div class="actions">
          <el-button
            type="primary"
            :loading="searching"
            :disabled="!query.trim()"
            @click="runSearch"
            >检索</el-button
          >
        </div>
        <div v-if="searchError" class="err">{{ searchError }}</div>
        <div v-for="(hit, i) in results" :key="i" class="hit">
          <div class="hitMeta">
            {{ hit.datasetName || hit.datasetId || 'result' }}
          </div>
          <pre>{{ hit.text || '(空结果)' }}</pre>
        </div>
      </section>
    </div>
  </section>
</template>

<script>
import {
  checkCogneeHealth,
  getCogneeConfig,
  listCogneeDatasets,
  searchCognee
} from '@/utils/cogneeApi'

export default {
  name: 'CogneeAccessPage',
  data() {
    return {
      dataset: getCogneeConfig().dataset,
      checking: false,
      searching: false,
      health: { checked: false, ok: false, message: '', version: '', status: '' },
      datasets: [],
      query: '',
      results: [],
      searchError: ''
    }
  },
  created() {
    this.refresh()
  },
  methods: {
    async refresh() {
      if (this.checking) return
      this.checking = true
      try {
        const h = await checkCogneeHealth()
        this.health = {
          checked: true,
          ok: !!h.ok,
          message: h.message || '',
          version: h.version || '',
          status: h.status || ''
        }
        if (h.ok) {
          try {
            this.datasets = await listCogneeDatasets()
          } catch (e) {
            this.datasets = []
          }
        } else {
          this.datasets = []
        }
      } finally {
        this.checking = false
      }
    },
    async runSearch() {
      const q = String(this.query || '').trim()
      if (!q || this.searching) return
      this.searching = true
      this.searchError = ''
      this.results = []
      try {
        this.results = await searchCognee({ query: q })
        if (!this.results.length) {
          this.searchError = '无命中结果'
        }
      } catch (err) {
        this.searchError = (err && err.message) || '检索失败'
      } finally {
        this.searching = false
      }
    }
  }
}
</script>

<style lang="less" scoped>
.cogneeAccessPage {
  max-width: 1120px;
}
.cogneeGrid {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 16px;
  align-items: start;
}
.card {
  padding: 18px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-lg);
  background: var(--ui-surface);
  h2 {
    margin: 0 0 6px;
    font-size: 16px;
  }
}
.hint {
  margin: 0 0 14px;
  color: var(--ui-text-secondary);
  font-size: 13px;
}
.statusRow {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #d1d5db;
  &.ok {
    background: #16a34a;
  }
  &.bad {
    background: #dc2626;
  }
}
.meta {
  margin: 0;
  color: var(--ui-text-secondary);
  font-size: 12px;
}
.datasetList {
  margin: 10px 0 0;
  padding-left: 18px;
  font-size: 13px;
}
.actions {
  margin-top: 10px;
}
.err {
  margin-top: 10px;
  color: #b91c1c;
  font-size: 13px;
}
.hit {
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-md);
  background: var(--ui-surface-muted);
  .hitMeta {
    margin-bottom: 6px;
    color: var(--ui-text-secondary);
    font-size: 12px;
  }
  pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font: 13px/1.55 Consolas, 'SFMono-Regular', monospace;
  }
}
@media (max-width: 860px) {
  .cogneeGrid {
    grid-template-columns: 1fr;
  }
}
</style>
