<template>
  <div class="kb-gc">
    <div class="kb-card kb-block">
      <div class="kb-section-title">
        吉客云数据源
        <span class="kb-gc-actions">
          <el-button type="text" icon="el-icon-refresh-right" @click="loadAll">刷新</el-button>
          <el-button type="text" icon="el-icon-connection" :loading="checking" :disabled="!canCheck" @click="check">检测连接</el-button>
        </span>
      </div>
      <KbStateBlock :loading="statusLoading" :error="statusError" @retry="loadAll">
        <div v-if="status" class="kb-gc-grid">
          <dl class="kb-kv">
            <dt>启用状态</dt>
            <dd><span class="kb-dot" :class="status.enabled ? 'is-ok' : 'is-off'" />{{ status.enabled ? '已启用' : '未启用' }}</dd>
            <dt>服务端密钥</dt>
            <dd>
              <template v-if="status.token && status.token.configured">已配置 · 指纹 <span class="kb-mono">{{ status.token.fingerprint }}</span></template>
              <template v-else>未配置</template>
            </dd>
            <dt>接入主机</dt>
            <dd class="kb-mono">{{ status.endpointHost || '—' }}</dd>
            <dt>MCP 连接</dt>
            <dd>
              <span class="kb-dot" :class="connClass" />{{ connText }}
              <span v-if="status.connection && status.connection.checkedAt" class="kb-gc-sub">{{ time(status.connection.checkedAt) }} · {{ status.connection.latencyMs }} ms</span>
            </dd>
            <dt>我的权限</dt>
            <dd>{{ accessText }}</dd>
            <dt>仓库范围</dt>
            <dd>
              <template v-if="status.access && status.access.warehouses && status.access.warehouses.length">
                <span v-for="w in status.access.warehouses" :key="w" class="kb-gc-chip kb-mono">{{ w }}</span>
              </template>
              <template v-else>未配置，库存查询不会返回任何仓库</template>
            </dd>
            <dt>调用限制</dt>
            <dd v-if="status.limits">超时 {{ status.limits.timeoutMs }} ms · 并发 {{ status.limits.maxConcurrency }} · 每人每分钟 {{ status.limits.perUserPerMinute }} 次</dd>
          </dl>
          <div>
            <div class="kb-gc-label">已允许的只读工具</div>
            <div v-if="!(status.allowedTools || []).length" class="kb-hint">没有可用工具</div>
            <div v-for="t in status.allowedTools || []" :key="t.name" class="kb-gc-tool">
              <div class="kb-gc-tool-head">
                <span class="kb-mono">{{ t.name }}</span>
                <span class="kb-gc-tag">{{ t.label }}</span>
                <span v-if="checkMap[t.name]" class="kb-gc-check" :class="checkMap[t.name].schemaOk ? 'is-ok' : 'is-bad'">
                  {{ checkMap[t.name].available ? (checkMap[t.name].schemaOk ? '结构一致' : '缺少参数 ' + checkMap[t.name].missingProps.join('、')) : '吉客云未提供' }}
                </span>
              </div>
              <div class="kb-gc-tool-desc">{{ t.description }}</div>
            </div>
            <p v-if="status.configErrors && status.configErrors.length" class="kb-gc-error">配置问题：{{ status.configErrors.join('；') }}</p>
          </div>
        </div>
        <p class="kb-hint">Key 由服务端密钥配置提供，页面只显示是否已配置和指纹，不能在这里填写或查看。订单、采购、结算等写入或敏感工具不会开放。</p>
      </KbStateBlock>
    </div>

    <div class="kb-card kb-block">
      <div class="kb-section-title">
        最近调用
        <el-button type="text" icon="el-icon-refresh-right" @click="loadCalls">刷新</el-button>
      </div>
      <p v-if="status && status.lastError" class="kb-gc-error">
        本服务最近一次错误：{{ status.lastError.message }}<template v-if="status.lastError.tool"> · {{ status.lastError.tool }}</template> · {{ time(status.lastError.at) }}
      </p>
      <KbStateBlock :loading="callsLoading" :error="callsError" :empty="!callsLoading && !calls.length" empty-title="还没有调用记录" @retry="loadCalls">
        <table class="kb-gc-table">
          <thead><tr><th>时间</th><th>工具</th><th>结果</th><th>耗时</th><th>来源</th><th>SKU</th></tr></thead>
          <tbody>
            <tr v-for="(c, i) in calls" :key="i" :class="{ 'is-bad': c.status !== 'ok' }">
              <td>{{ time(c.at) }}</td>
              <td class="kb-mono">{{ c.tool }}</td>
              <td>{{ c.status === 'ok' ? '成功' : (c.code || '失败') }}</td>
              <td>{{ c.durationMs != null ? c.durationMs + ' ms' : '—' }}</td>
              <td>{{ c.via || '—' }}</td>
              <td class="kb-mono">{{ c.sku || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </KbStateBlock>
      <p class="kb-hint">只显示你自己的调用。记录里只有工具名、耗时、结果码和 SKU，不含密钥和返回数据。</p>
    </div>

    <div class="kb-card kb-block">
      <div class="kb-section-title">智能查询调试 · smart_knowledge_query</div>
      <div class="kb-gc-form">
        <el-input v-model="query" size="small" maxlength="500" placeholder="例如：SKU 887167562998 现在库存多少，有没有相关文件" class="kb-gc-query" @keyup.enter.native="run" />
        <el-select v-model="mode" size="small" class="kb-gc-mode" popper-class="kb-popper">
          <el-option value="auto" label="自动路由" />
          <el-option value="file_only" label="只查文件" />
          <el-option value="geekcloud_only" label="只查吉客云" />
          <el-option value="combined" label="联合查询" />
        </el-select>
        <el-checkbox v-model="includeFiles" :disabled="mode !== 'auto'">补充文件资料</el-checkbox>
        <el-input-number v-model="limit" size="small" :min="1" :max="50" controls-position="right" class="kb-gc-limit" />
        <el-button size="small" type="primary" icon="el-icon-search" :loading="running" :disabled="!query.trim()" @click="run">查询</el-button>
      </div>
      <div v-if="runError" class="kb-gc-error">{{ runError }}</div>

      <template v-if="result">
        <div class="kb-gc-route">
          <span class="kb-gc-tag is-strong">{{ decisionText }}</span>
          <span v-if="result.route.sku" class="kb-gc-tag kb-mono">SKU {{ result.route.sku }}</span>
          <span v-for="it in result.route.intents" :key="it" class="kb-gc-tag">{{ intentText(it) }}</span>
          <span class="kb-gc-tag" :class="result.route.geekcloudCalled ? 'is-live' : ''">{{ result.route.geekcloudCalled ? '已调用吉客云' : '未调用吉客云' }}</span>
          <span class="kb-gc-sub">{{ (result.route.reasons || []).join('；') }} · {{ elapsed }} ms</span>
        </div>
        <p v-if="result.route.clarification" class="kb-gc-warn">{{ result.route.clarification }}</p>

        <div class="kb-gc-sources">
          <section class="kb-gc-src is-live">
            <header>
              <strong>吉客云 · 实时数据</strong>
              <span class="kb-gc-sub">{{ srcStatus(geek) }}<template v-if="geek.queriedAt"> · {{ time(geek.queriedAt) }}</template></span>
            </header>
            <p v-if="geek.status === 'skipped'" class="kb-hint">本次没有查询吉客云。</p>
            <template v-else>
              <div v-for="g in (geek.goods && geek.goods.items) || []" :key="g.goodsNo + (g.skuName || '')" class="kb-gc-goods">
                <div class="kb-gc-goods-name">{{ g.goodsName || '（无名称）' }}</div>
                <div class="kb-gc-sub kb-mono">{{ g.goodsNo }}<template v-if="g.skuBarcode"> · 条码 {{ g.skuBarcode }}</template></div>
                <div class="kb-gc-sub">{{ [g.skuName, g.unitName, g.brandName, g.cateName, g.ownerName].filter(Boolean).join(' · ') }}</div>
              </div>
              <div v-if="geek.goods && geek.goods.candidates && geek.goods.candidates.length">
                <div class="kb-gc-label">候选（非精确匹配，需确认）</div>
                <div v-for="c in geek.goods.candidates" :key="c.goodsNo" class="kb-gc-sub kb-mono">{{ c.goodsNo }} · {{ c.goodsName }}</div>
              </div>
              <template v-if="geek.stock">
                <div class="kb-gc-label">库存<template v-if="geek.stock.totals"> · 合计现存 {{ geek.stock.totals.currentQuantity }} · 可用 {{ geek.stock.totals.useQuantity }}</template></div>
                <p v-if="geek.stock.status === 'no_warehouse_scope'" class="kb-hint">没有为你配置仓库范围，未查询库存。</p>
                <p v-else-if="geek.stock.status === 'ok' && !geek.stock.items.length" class="kb-hint">你的仓库范围内没有该 SKU 的库存行。</p>
                <table v-else-if="geek.stock.items.length" class="kb-gc-table">
                  <thead><tr><th>仓库</th><th>现存</th><th>可用</th></tr></thead>
                  <tbody>
                    <tr v-for="s in geek.stock.items" :key="s.warehouseCode">
                      <td>{{ s.warehouseName }} <span class="kb-mono kb-gc-sub">{{ s.warehouseCode }}</span></td>
                      <td>{{ s.currentQuantity }}</td>
                      <td>{{ s.useQuantity }}</td>
                    </tr>
                  </tbody>
                </table>
              </template>
              <template v-if="geek.price">
                <div class="kb-gc-label">价目</div>
                <p v-if="!geek.price.items.length" class="kb-hint">吉客云没有返回该 SKU 的价目。</p>
                <div v-for="(p, i) in geek.price.items" :key="i" class="kb-gc-sub">
                  {{ ['minPrice', 'price1', 'price2', 'price3', 'price4', 'price5'].filter(k => p[k] != null).map(k => k + ' ' + p[k]).join(' · ') }} {{ p.currencyName || '' }}
                </div>
              </template>
              <div v-if="geek.items && geek.items.length">
                <div class="kb-gc-label">可见仓库</div>
                <div v-for="w in geek.items" :key="w.warehouseCode" class="kb-gc-sub">{{ w.warehouseName || '—' }} <span class="kb-mono">{{ w.warehouseCode }}</span></div>
              </div>
              <p v-if="geek.missing && geek.missing.length" class="kb-hint">未开放的字段：{{ geek.missing.join('、') }}</p>
              <p v-for="(e, i) in geek.errors || []" :key="'e' + i" class="kb-gc-error">{{ e.part }}：{{ e.message }}（{{ e.code }}）</p>
            </template>
          </section>

          <section class="kb-gc-src is-file">
            <header>
              <strong>File KB · 历史文件数据</strong>
              <span class="kb-gc-sub">{{ srcStatus(file) }}<template v-if="file.queriedAt"> · {{ time(file.queriedAt) }}</template></span>
            </header>
            <p v-if="file.status === 'skipped'" class="kb-hint">本次没有查询文件知识库。</p>
            <p v-else-if="file.status === 'error'" class="kb-gc-error">{{ file.error && file.error.message }}</p>
            <template v-else>
              <template v-if="file.records && file.records.length">
                <div class="kb-gc-label">结构化记录（精确 SKU）· 共 {{ file.recordTotal }}</div>
                <div v-for="r in file.records" :key="r.recordId" class="kb-gc-hit">
                  <div>{{ r.fileName }} · {{ r.sheet }} 第 {{ r.row }} 行</div>
                  <div class="kb-gc-sub">
                    <template v-if="r.stock != null">库存 {{ r.stock }} · </template><template v-if="r.price != null">价格 {{ r.price }} · </template>
                    <span class="kb-mono">record {{ r.recordId }} · run {{ short(r.runId) }}</span>
                  </div>
                </div>
              </template>
              <template v-if="file.blocks && file.blocks.length">
                <div class="kb-gc-label">相关文件块</div>
                <div v-for="b in file.blocks" :key="b.blockId" class="kb-gc-hit">
                  <div>{{ b.fileName }}<template v-if="b.page"> · 第 {{ b.page }} 页</template><template v-if="b.sheet"> · {{ b.sheet }}</template></div>
                  <div class="kb-gc-sub">{{ b.snippet }}</div>
                  <div class="kb-gc-sub kb-mono">block {{ b.blockId }} · run {{ short(b.runId) }}</div>
                </div>
              </template>
              <template v-if="file.results && file.results.length">
                <div class="kb-gc-label">检索结果 · 共 {{ file.total }}</div>
                <div v-for="(h, i) in file.results" :key="i" class="kb-gc-hit">
                  <div>{{ h.fileName }}<template v-if="h.page"> · 第 {{ h.page }} 页</template><template v-if="h.sheet"> · {{ h.sheet }}</template><template v-if="h.row"> 第 {{ h.row }} 行</template></div>
                  <div class="kb-gc-sub">{{ h.snippet }}</div>
                </div>
              </template>
              <p v-if="file.status === 'empty'" class="kb-hint">没有找到匹配的文件资料。</p>
            </template>
          </section>
        </div>

        <div v-if="result.comparison" class="kb-gc-compare">
          <div class="kb-gc-label">两边原值对照（{{ result.comparison.rule }}）</div>
          <table class="kb-gc-table">
            <thead><tr><th>字段</th><th>吉客云（实时）</th><th>File KB（文件）</th><th>是否不同</th></tr></thead>
            <tbody>
              <tr v-for="f in result.comparison.fields" :key="f.field">
                <td>{{ f.field === 'stock' ? '库存' : '价格' }}</td>
                <td>
                  <template v-if="f.geekcloud.value != null">{{ f.geekcloud.value }} <span class="kb-gc-sub">{{ f.geekcloud.basis }}</span></template>
                  <template v-else>见价目</template>
                </td>
                <td><div v-for="v in f.fileKb" :key="v.recordId">{{ v.value }} <span class="kb-gc-sub">{{ v.fileName }} 第 {{ v.row }} 行</span></div></td>
                <td>{{ f.differs == null ? (f.note || '不判定') : (f.differs ? '不同' : '一致') }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <ul v-if="result.notes && result.notes.length" class="kb-gc-notes">
          <li v-for="(n, i) in result.notes" :key="i">{{ n }}</li>
        </ul>
        <el-button type="text" size="mini" @click="showRaw = !showRaw">{{ showRaw ? '收起原始 JSON' : '查看原始 JSON' }}</el-button>
        <KbJsonView v-if="showRaw" :value="result" title="smart_knowledge_query 返回" />
      </template>
    </div>
  </div>
</template>
<script>
import kbApi from '../services/kbApi'
import { formatTime } from '../utils/format'
import KbStateBlock from './KbStateBlock.vue'
import KbJsonView from './KbJsonView.vue'

const CONN = {
  unknown: '未检测', connected: '已连接', auth_failed: '认证失败', unreachable: '无法连接',
  schema_mismatch: '工具结构不一致', disabled: '未启用', not_configured: '未配置'
}
const REASON = {
  geekcloud_disabled: '数据源未启用',
  geekcloud_not_configured: '服务端配置不完整',
  geekcloud_forbidden: '当前账号不在吉客云授权名单中'
}
const DECISION = {
  file: '只查文件', geekcloud: '只查吉客云', combined: '联合查询', clarify: '需要明确 SKU', geekcloud_warehouses: '查询可见仓库'
}
const INTENT = { stock: '库存', price: '价格', goods: '商品资料', warehouse: '仓库' }
const STATUS = {
  ok: '成功', empty: '无匹配', partial: '部分成功', error: '失败', skipped: '未查询', forbidden: '无权限',
  unavailable: '不可用', not_found: '吉客云无此 SKU', needs_clarification: '需要确认', bad_request: 'SKU 格式无效'
}

export default {
  name: 'KbGeekcloudPanel',
  components: { KbStateBlock, KbJsonView },
  data() {
    return {
      status: null, statusLoading: false, statusError: null,
      checking: false, checkResult: null,
      calls: [], callsLoading: false, callsError: null,
      query: '', mode: 'auto', includeFiles: true, limit: 10,
      running: false, runError: '', result: null, elapsed: 0, showRaw: false
    }
  },
  computed: {
    canCheck() {
      return !!(this.status && this.status.enabled && this.status.configured && this.status.access && this.status.access.allowed)
    },
    connText() {
      const c = this.status && this.status.connection
      return CONN[(c && c.state) || 'unknown'] || c.state
    },
    connClass() {
      const s = this.status && this.status.connection && this.status.connection.state
      if (s === 'connected') return 'is-ok'
      if (s === 'auth_failed' || s === 'unreachable' || s === 'schema_mismatch') return 'is-bad'
      return 'is-off'
    },
    accessText() {
      const a = this.status && this.status.access
      if (!a) return '—'
      return a.allowed ? '可以查询吉客云' : (REASON[a.reason] || a.reason || '不可查询')
    },
    checkMap() {
      const out = {}
      for (const t of (this.checkResult && this.checkResult.tools) || []) out[t.name] = t
      return out
    },
    geek() { return (this.result && this.result.sources.geekcloud) || {} },
    file() { return (this.result && this.result.sources.fileKb) || {} },
    decisionText() { return DECISION[this.result && this.result.route.decision] || this.result.route.decision }
  },
  created() { this.loadAll() },
  methods: {
    time: formatTime,
    short(id) { return id ? String(id).slice(0, 8) : '—' },
    intentText(k) { return INTENT[k] || k },
    srcStatus(src) { return STATUS[src && src.status] || (src && src.status) || '—' },
    async loadAll() {
      await Promise.all([this.loadStatus(), this.loadCalls()])
    },
    async loadStatus() {
      this.statusLoading = true
      this.statusError = null
      try { this.status = await kbApi.geekcloudStatus() } catch (e) { this.statusError = e; this.status = null } finally { this.statusLoading = false }
    },
    async loadCalls() {
      this.callsLoading = true
      this.callsError = null
      try { this.calls = (await kbApi.geekcloudCalls()).items } catch (e) { this.callsError = e; this.calls = [] } finally { this.callsLoading = false }
    },
    async check() {
      this.checking = true
      try {
        this.checkResult = await kbApi.geekcloudCheck()
        if (this.checkResult.ok) this.$message.success(`连接正常 · ${this.checkResult.latencyMs} ms`)
        else this.$message.error((this.checkResult.error && this.checkResult.error.message) || '连接检测未通过')
      } catch (e) {
        this.$message.error(e.message || '检测失败')
      } finally {
        this.checking = false
        await this.loadAll()
      }
    },
    async run() {
      const q = this.query.trim()
      if (!q) return
      this.running = true
      this.runError = ''
      const started = Date.now()
      try {
        const body = { query: q, mode: this.mode, limit: this.limit }
        if (this.mode === 'auto') body.include_file_context = this.includeFiles
        this.result = await kbApi.smartQuery(body)
        this.elapsed = Date.now() - started
      } catch (e) {
        this.result = null
        this.runError = e.message || '查询失败'
      } finally {
        this.running = false
        if (this.result && this.result.route.geekcloudCalled) this.loadAll()
      }
    }
  }
}
</script>
<style scoped lang="less">
.kb-block { margin-bottom: 16px; }
.kb-section-title { font-weight: 600; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
.kb-gc-actions { display: flex; gap: 4px; }
.kb-gc-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; }
.kb-kv {
  display: grid; grid-template-columns: 90px 1fr; gap: 10px 12px; margin: 0; font-size: 13px;
  dt { color: var(--ui-text-muted); }
  dd { margin: 0; color: var(--ui-text); display: flex; align-items: center; flex-wrap: wrap; gap: 6px; word-break: break-all; }
}
.kb-mono { font-family: Consolas, Menlo, monospace; }
.kb-dot {
  width: 8px; height: 8px; border-radius: 50%; flex: none;
  &.is-ok { background: var(--ui-primary); }
  &.is-bad { background: var(--ui-danger); }
  &.is-off { background: var(--ui-border-strong); }
}
.kb-hint { margin: 10px 0 0; font-size: 12px; color: var(--ui-text-muted); line-height: 1.6; }
.kb-gc-sub { font-size: 12px; color: var(--ui-text-muted); }
.kb-gc-label { margin: 12px 0 6px; font-size: 12px; font-weight: 600; color: var(--ui-text-secondary); letter-spacing: 0.02em; }
.kb-gc-label:first-child { margin-top: 0; }
.kb-gc-chip, .kb-gc-tag {
  display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px;
  background: var(--ui-surface-muted); color: var(--ui-text-secondary); border: 1px solid var(--ui-border);
}
.kb-gc-tag.is-strong { background: var(--ui-primary-soft); color: var(--ui-primary); border-color: transparent; font-weight: 600; }
.kb-gc-tag.is-live { color: var(--ui-star); border-color: var(--ui-star); }
.kb-gc-tool { padding: 6px 0; border-top: 1px dashed var(--ui-border); font-size: 13px; &:first-of-type { border-top: 0; } }
.kb-gc-tool-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.kb-gc-tool-desc { font-size: 12px; color: var(--ui-text-muted); margin-top: 2px; }
.kb-gc-check { font-size: 12px; &.is-ok { color: var(--ui-primary); } &.is-bad { color: var(--ui-danger); } }
.kb-gc-error { color: var(--ui-danger); font-size: 12px; margin: 8px 0 0; }
.kb-gc-warn { color: var(--ui-star); font-size: 13px; margin: 8px 0 0; }
.kb-gc-table {
  width: 100%; border-collapse: collapse; font-size: 12px;
  th { text-align: left; font-weight: 500; color: var(--ui-text-muted); padding: 4px 8px; border-bottom: 1px solid var(--ui-border); }
  td { padding: 5px 8px; border-bottom: 1px solid var(--ui-border); color: var(--ui-text); }
  tr.is-bad td { color: var(--ui-danger); }
}
.kb-gc-form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.kb-gc-query { flex: 1; min-width: 280px; }
.kb-gc-mode { width: 130px; }
.kb-gc-limit { width: 96px; }
.kb-gc-route { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 14px; }
.kb-gc-sources { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; margin-top: 14px; }
.kb-gc-src {
  border: 1px solid var(--ui-border); border-radius: var(--ui-radius-md); padding: 12px 14px; position: relative; overflow: hidden;
  &::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; }
  &.is-live::before { background: var(--ui-star); }
  &.is-file::before { background: var(--ui-primary); }
  header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 10px; font-size: 13px; }
}
.kb-gc-goods { padding: 6px 0; }
.kb-gc-goods-name { font-weight: 600; font-size: 14px; color: var(--ui-text); }
.kb-gc-hit { padding: 6px 0; border-top: 1px dashed var(--ui-border); font-size: 13px; &:first-of-type { border-top: 0; } }
.kb-gc-compare { margin-top: 14px; }
.kb-gc-notes { margin: 12px 0 6px; padding-left: 18px; font-size: 12px; color: var(--ui-text-secondary); line-height: 1.7; }
@media (max-width: 1000px) {
  .kb-gc-grid, .kb-gc-sources { grid-template-columns: 1fr; }
}
</style>
