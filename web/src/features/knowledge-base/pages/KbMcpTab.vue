<template>
  <div class="kb-mcp">
    <div class="kb-mcp-grid">
      <div class="kb-card">
        <div class="kb-section-title">
          服务状态
          <el-button type="text" icon="el-icon-refresh-right" @click="loadStatus">刷新</el-button>
        </div>
        <KbStateBlock :loading="statusLoading" :error="statusError" @retry="loadStatus">
          <dl v-if="status" class="kb-kv">
            <dt>运行状态</dt>
            <dd><span class="kb-dot" :class="status.ok || status.online ? 'is-ok' : 'is-bad'" />{{ status.ok || status.online ? '在线' : '离线' }}</dd>
            <dt>接入地址</dt>
            <dd class="kb-mono">
              {{ endpoint }}
              <el-button type="text" size="mini" icon="el-icon-document-copy" @click="copy(endpoint, '地址已复制')">复制</el-button>
            </dd>
            <dt>传输方式</dt>
            <dd>Streamable HTTP</dd>
            <dt>协议</dt>
            <dd>与脑图 MCP 相同，type 为 http</dd>
          </dl>
        </KbStateBlock>
        <div class="kb-hint">{{ accessNote }}</div>
      </div>
      <div class="kb-card">
        <div class="kb-section-title">工具列表</div>
        <KbStateBlock :loading="toolsLoading" :error="toolsError" :empty="!toolsLoading && !tools.length" empty-title="暂无工具" @retry="loadTools">
          <div v-for="t in tools" :key="t.name" class="kb-tool" :class="{ active: tool === t.name }" @click="pickTool(t)">
            <div class="kb-tool-name"><i class="el-icon-s-tools" aria-hidden="true" />{{ t.name }}</div>
            <div class="kb-tool-desc">{{ t.description || t.title || '' }}</div>
          </div>
        </KbStateBlock>
      </div>
    </div>

    <div class="kb-card kb-block">
      <div class="kb-section-title">
        访问令牌
        <el-button type="text" icon="el-icon-refresh-right" @click="loadTokens">刷新</el-button>
      </div>
      <div class="kb-token-form">
        <el-input v-model="tokenName" size="small" maxlength="80" placeholder="名称，例如 Cursor" class="kb-token-name" />
        <el-select v-model="ttlDays" size="small" class="kb-token-ttl" popper-class="kb-popper">
          <el-option :value="0" label="永久" />
          <el-option :value="7" label="7 天" />
          <el-option :value="30" label="30 天" />
          <el-option :value="90" label="90 天" />
          <el-option :value="365" label="365 天" />
        </el-select>
        <el-select v-model="scopeFolderIds" size="small" multiple collapse-tags clearable placeholder="全部可见文件夹" class="kb-token-folders" popper-class="kb-popper">
          <el-option v-for="f in folders" :key="f.id" :label="f.name" :value="f.id" />
        </el-select>
        <el-checkbox v-model="allowGeekcloud" :disabled="scopeFolderIds.length > 0" size="small">允许吉客云只读查询</el-checkbox>
        <el-button size="small" type="primary" :loading="creating" @click="createToken">创建只读令牌</el-button>
      </div>
      <p class="kb-hint">默认永久有效，可随时撤销。默认只有 kb:read。不选文件夹时，范围是这个账号当前能看的文件。勾选「允许吉客云只读查询」会加上 geekcloud:read，仍需管理员为你配置吉客云货主和仓库范围；限定文件夹的令牌不能勾选。明文只在创建后出现一次，不写入浏览器存储。</p>
      <KbStateBlock :loading="tokensLoading" :error="tokensError" :empty="!tokensLoading && !tokens.length" empty-title="还没有令牌" @retry="loadTokens">
        <div v-for="item in tokens" :key="item.id" class="kb-token-row">
          <div>
            <strong>{{ item.name || '未命名' }}</strong>
            <span class="kb-mono">{{ item.tokenPrefix }}••••••••</span>
            <span v-if="item.revokedAt" class="kb-token-state is-off">已撤销</span>
            <span v-else class="kb-token-state">有效</span>
          </div>
          <div class="kb-token-meta">
            {{ scopeText(item) }} · {{ scopeLabel(item) }} · {{ item.expiresAt ? '到期 ' + time(item.expiresAt) : '永久有效' }}
            <template v-if="item.lastUsedAt"> · 最近使用 {{ time(item.lastUsedAt) }}</template>
          </div>
          <el-button v-if="!item.revokedAt" type="text" size="mini" @click="revoke(item)">撤销</el-button>
        </div>
      </KbStateBlock>
    </div>

    <div v-if="plainToken" class="kb-card kb-block">
      <div class="kb-section-title">令牌已创建，请立即复制</div>
      <p class="kb-hint">关闭或离开后无法再查看。下面的预览只含环境变量。复制含令牌的配置才会带上明文，请粘贴到客户端，不要提交到 Git。</p>
      <pre class="kb-config">{{ maskedConfig }}</pre>
      <div class="kb-actions">
        <el-button size="small" @click="copy(plainToken, '令牌已复制')">复制令牌</el-button>
        <el-button size="small" type="primary" @click="copy(secretConfig, '配置已复制')">复制含令牌的配置</el-button>
        <el-button size="small" :loading="probing" @click="probe(plainToken)">用此令牌测试连接</el-button>
        <el-button size="small" type="text" @click="dismissToken">我已保存</el-button>
      </div>
    </div>

    <div class="kb-card kb-block">
      <div class="kb-section-title">接入 AI 客户端</div>
      <div class="kb-method" role="group" aria-label="客户端">
        <button type="button" :class="{ on: method === 'cursor' }" @click="method = 'cursor'">Cursor</button>
        <button type="button" :class="{ on: method === 'codex' }" @click="method = 'codex'">Codex</button>
        <button type="button" :class="{ on: method === 'workbuddy' }" @click="method = 'workbuddy'">WorkBuddy</button>
        <button type="button" :class="{ on: method === 'generic' }" @click="method = 'generic'">通用 HTTP</button>
      </div>
      <p class="kb-hint">{{ methodNote }}</p>
      <pre class="kb-config">{{ methodText }}</pre>
      <div class="kb-actions">
        <el-button size="small" type="primary" icon="el-icon-document-copy" @click="copy(methodText, '已复制')">复制</el-button>
      </div>
      <div class="kb-probe">
        <el-input v-model="probeToken" size="small" type="password" show-password autocomplete="off" placeholder="粘贴令牌做一次连接测试，不会保存" class="kb-probe-input" />
        <el-button size="small" :loading="probing" :disabled="!probeToken" @click="probe(probeToken, true)">测试连接</el-button>
      </div>
      <ul v-if="probeSteps.length" class="kb-probe-steps">
        <li v-for="step in probeSteps" :key="step.name" :class="step.ok ? 'is-ok' : 'is-bad'">
          {{ step.ok ? '通过' : '失败' }} · {{ step.name }}<template v-if="step.detail"> · {{ step.detail }}</template>
        </li>
      </ul>
    </div>

    <div class="kb-card kb-debug">
      <div class="kb-section-title">调试调用</div>
      <div class="kb-debug-row">
        <el-select v-model="tool" size="small" placeholder="选择工具" filterable popper-class="kb-popper" class="kb-debug-tool" @change="t => pickTool(tools.find(x => x.name === t))">
          <el-option v-for="t in tools" :key="t.name" :label="t.name" :value="t.name" />
        </el-select>
        <el-button size="small" type="primary" icon="el-icon-video-play" :loading="calling" :disabled="!tool" @click="call">调用</el-button>
      </div>
      <el-input v-model="argsText" type="textarea" :rows="6" placeholder='参数 JSON。get_knowledge_source 的 row 填表格行号，从 1 开始' class="kb-debug-args" />
      <div v-if="argsError" class="kb-debug-error">{{ argsError }}</div>
      <div v-if="rowNote" class="kb-hint">{{ rowNote }}</div>
      <KbJsonView v-if="result !== null" :value="result" :title="resultTitle" class="kb-debug-result" />
    </div>

    <KbGeekcloudPanel class="kb-geekcloud" />
  </div>
</template>
<script>
import kbApi from '../services/kbApi'
import { presentToolResult, prepareToolArguments, READ_ONLY_TOOLS, formatTime, mcpEndpoint, mcpAccessKind, cursorMcpConfig, codexMcpConfig, fileKbServerEntry } from '../utils/format'
import KbStateBlock from '../components/KbStateBlock.vue'
import KbJsonView from '../components/KbJsonView.vue'
import KbGeekcloudPanel from '../components/KbGeekcloudPanel.vue'

const EXPECTED = [...READ_ONLY_TOOLS]

export default {
  name: 'KbMcpTab',
  components: { KbStateBlock, KbJsonView, KbGeekcloudPanel },
  data() {
    return {
      status: null, statusError: null, statusLoading: false,
      tools: [], toolsError: null, toolsLoading: false,
      tool: '', argsText: '{}', argsError: '', calling: false, result: null, resultTitle: '',
      tokens: [], tokensError: null, tokensLoading: false,
      folders: [], tokenName: 'Cursor', ttlDays: 0, scopeFolderIds: [], allowGeekcloud: false, creating: false,
      plainToken: '', plainTokenId: '',
      method: 'cursor', probeToken: '', probing: false, probeSteps: []
    }
  },
  computed: {
    endpoint() {
      return mcpEndpoint(window.location)
    },
    accessKind() {
      return mcpAccessKind(window.location)
    },
    accessNote() {
      if (this.accessKind === 'local') return '当前是本机地址。这台电脑上的 Cursor、Codex 和 WorkBuddy 可以用它，其他电脑访问不到。'
      if (this.accessKind === 'lan') return '当前是局域网地址。同一网络里的客户端用这个地址。令牌经过 HTTP，不要把这个地址公开到公网。'
      if (this.accessKind === 'public-https') return '当前是公网 HTTPS，远程客户端可以连接。'
      return '当前不是本机，也不是 HTTPS。远程客户端可能连不上，令牌会以明文经过网络。'
    },
    maskedConfig() {
      return cursorMcpConfig(this.endpoint)
    },
    secretConfig() {
      return cursorMcpConfig(this.endpoint, this.plainToken)
    },
    methodText() {
      if (this.method === 'codex') return codexMcpConfig(this.endpoint)
      if (this.method === 'workbuddy') return this.workbuddyText
      if (this.method === 'generic') return JSON.stringify(fileKbServerEntry(this.endpoint), null, 2)
      return cursorMcpConfig(this.endpoint)
    },
    methodNote() {
      if (this.method === 'cursor') return '写入项目或用户的 mcp.json。令牌放在环境变量 FILE_KB_MCP_TOKEN，不要写进文件。从开始菜单打开 Cursor 时，需要系统环境变量，改完后完全退出再打开。'
      if (this.method === 'codex') return '写入 ~/.codex/config.toml 或项目 .codex/config.toml。bearer_token_env_var 只写变量名。启动 Codex 前先导出 FILE_KB_MCP_TOKEN。'
      if (this.method === 'workbuddy') return 'WorkBuddy 公开文档给出的是本地 stdio 示例，用户级文件是 ~/.workbuddy/mcp.json，项目级是 .workbuddy/mcp.json。下面的指令要求它先确认自己的配置格式，再合并 file-kb。不要把脑图那套设备码授权套到这里。'
      return '配置形状与脑图 MCP 相同：type 为 http，用 Authorization Bearer。若客户端要求 mcpServers 根字段，把这条放进去。模板里的令牌是环境变量。'
    },
    workbuddyText() {
      return [
        '请在当前这台电脑的 WorkBuddy 中新增名为 file-kb 的 MCP，直接完成配置。',
        '先确认 WorkBuddy 实际使用的 MCP 配置文件和格式，不要猜测路径，也不要修改其他客户端或其他 MCP。',
        'File KB 与脑图 MCP 使用同一种 Streamable HTTP。服务器条目是 type=http，url=' + this.endpoint + '，headers.Authorization 为 Bearer 令牌。',
        '令牌只从我单独提供的配置或环境变量 FILE_KB_MCP_TOKEN 读取，默认权限是 kb:read。不要把令牌写进回复、日志、命令行参数或 Git。',
        '读取并备份现有文件，按它实际的格式合并 file-kb。若文件使用 mcpServers，就把条目放进该字段。已有 file-kb 时只更新这一项。',
        '写入后检查配置格式，并用 list_knowledge_files 做只读查询。七个工具都能被发现、而且返回了真实文件数据之后，才算接入成功。',
        '如果这个 WorkBuddy 版本只有本地 stdio、没有远程 HTTP 或请求头，请直接说明，不要改成别的协议。'
      ].join('\n\n')
    },
    rowNote() {
      if (this.tool !== 'query_knowledge_records' && this.tool !== 'get_knowledge_source') return ''
      if (this.result == null || (this.result && this.result.error)) return ''
      return '结果里的 row 是表格行号（从 1 开始），不是数据库里的 row_index。'
    }
  },
  created() {
    this.loadStatus()
    this.loadTools()
    this.loadTokens()
    this.loadFolders()
  },
  beforeDestroy() {
    this.plainToken = ''
    this.probeToken = ''
  },
  methods: {
    time: formatTime,
    async loadStatus() {
      this.statusLoading = true
      this.statusError = null
      try { this.status = await kbApi.mcpStatus() } catch (e) { this.statusError = e; this.status = null } finally { this.statusLoading = false }
    },
    async loadTools() {
      this.toolsLoading = true
      this.toolsError = null
      try { this.tools = (await kbApi.mcpTools()).items.filter(t => t && READ_ONLY_TOOLS.has(t.name)) } catch (e) { this.toolsError = e; this.tools = [] } finally { this.toolsLoading = false }
    },
    async loadTokens() {
      this.tokensLoading = true
      this.tokensError = null
      try { this.tokens = (await kbApi.listMcpTokens()).items } catch (e) { this.tokensError = e; this.tokens = [] } finally { this.tokensLoading = false }
    },
    async loadFolders() {
      try {
        const root = await kbApi.listFolders({ parentId: 'root', limit: 100 })
        const items = root.items || []
        const nested = []
        for (const folder of items.filter(item => item.hasChildren).slice(0, 20)) {
          const kids = await kbApi.listFolders({ parentId: folder.id, limit: 100 })
          nested.push(...(kids.items || []))
        }
        this.folders = items.concat(nested)
      } catch (_) { this.folders = [] }
    },
    scopeLabel(item) {
      const scopes = Array.isArray(item.scopes) ? item.scopes : []
      return scopes.includes('geekcloud:read') ? '文件只读 + 吉客云只读' : '文件只读'
    },
    scopeText(item) {
      const ids = item.scopeFolderIds || []
      if (!ids.length) return '全部可见文件夹'
      const names = ids.map(id => {
        const found = this.folders.find(folder => folder.id === id)
        return found ? found.name : id.slice(0, 8)
      })
      return '文件夹 ' + names.join('、')
    },
    async createToken() {
      this.creating = true
      try {
        const created = await kbApi.createMcpToken({
          name: this.tokenName || '外部客户端',
          // 0 = 永久：不传 ttlDays，后端不设到期
          ttlDays: this.ttlDays || undefined,
          // 后端规定：限定文件夹的令牌不能带 geekcloud:read
          scopes: this.allowGeekcloud && !this.scopeFolderIds.length ? ['kb:read', 'geekcloud:read'] : ['kb:read'],
          scopeFolderIds: this.scopeFolderIds
        })
        this.plainToken = String(created.token || '')
        this.plainTokenId = created.id || ''
        if (!this.plainToken) throw new Error('服务没有返回令牌')
        await this.loadTokens()
      } catch (e) {
        this.$message.error(e.message || '创建失败')
      } finally { this.creating = false }
    },
    dismissToken() {
      this.plainToken = ''
      this.plainTokenId = ''
    },
    async revoke(item) {
      try {
        await this.$confirm('撤销后，使用该令牌的客户端下一次请求会失败。', '撤销令牌', { type: 'warning' })
      } catch (_) { return }
      try {
        await kbApi.revokeMcpToken(item.id)
        const secret = item.id === this.plainTokenId ? this.plainToken : ''
        await this.loadTokens()
        if (secret) {
          await this.probe(secret)
          const failed = this.probeSteps.some(step => step.name === '认证' && step.ok === false)
          this.$message[failed ? 'success' : 'warning'](failed ? '已撤销，下一次请求被拒绝' : '已撤销，但连接测试仍通过')
          this.dismissToken()
        } else this.$message.success('已撤销')
      } catch (e) {
        this.$message.error(e.message || '撤销失败')
      }
    },
    pickTool(t) {
      if (!t) return
      this.tool = t.name
      const props = (t.inputSchema && t.inputSchema.properties) || {}
      const sample = {}
      Object.keys(props).forEach(k => {
        if (k === 'row') sample[k] = 1
        else sample[k] = props[k].type === 'number' || props[k].type === 'integer' ? 0 : props[k].type === 'boolean' ? false : ''
      })
      this.argsText = JSON.stringify(sample, null, 2)
    },
    async call() {
      let args
      try {
        args = this.argsText.trim() ? JSON.parse(this.argsText) : {}
        this.argsError = ''
      } catch (_) {
        this.argsError = '参数不是合法的 JSON'
        return
      }
      let payload
      try { payload = prepareToolArguments(this.tool, args) } catch (e) {
        this.argsError = e.message
        return
      }
      this.calling = true
      const started = Date.now()
      try {
        this.result = presentToolResult(this.tool, await kbApi.mcpCall(this.tool, payload))
        this.resultTitle = `调用成功 · ${Date.now() - started} ms`
      } catch (e) {
        this.result = { error: e.message, code: e.code, status: e.status }
        this.resultTitle = '调用失败'
      } finally { this.calling = false }
    },
    async probe(token, clearField) {
      const secret = String(token || '')
      if (!secret) return
      this.probing = true
      this.probeSteps = []
      const headers = {
        Authorization: 'Bearer ' + secret,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream'
      }
      const post = async (body, sessionId) => {
        const res = await fetch(this.endpoint, {
          method: 'POST',
          headers: sessionId ? { ...headers, 'mcp-session-id': sessionId } : headers,
          body: JSON.stringify(body)
        })
        const payload = await readMcpBody(res)
        return { status: res.status, sessionId: res.headers.get('mcp-session-id'), payload }
      }
      try {
        const init = await post({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'file-kb-page', version: '0.1.0' } }
        })
        const protocol = init.payload && init.payload.result && init.payload.result.protocolVersion
        this.probeSteps.push({ name: '认证', ok: init.status === 200 && !!protocol, detail: init.status === 200 ? 'initialize ' + protocol : 'HTTP ' + init.status })
        if (init.status !== 200) return
        await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, init.sessionId)
        const listed = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, init.sessionId)
        const names = ((listed.payload && listed.payload.result && listed.payload.result.tools) || []).map(item => item.name)
        this.probeSteps.push({ name: '工具发现', ok: EXPECTED.every(name => names.includes(name)), detail: names.length + ' 个工具' })
        const called = await post({
          jsonrpc: '2.0', id: 3, method: 'tools/call',
          params: { name: 'list_knowledge_files', arguments: {} }
        }, init.sessionId)
        const data = toolData(called.payload)
        const items = data && (data.items || data.files) || []
        const errored = called.payload && called.payload.result && called.payload.result.isError
        this.probeSteps.push({
          name: '知识库查询',
          ok: called.status === 200 && !errored && Array.isArray(items),
          detail: Array.isArray(items) ? (items.length ? items.map(item => item.name).filter(Boolean).slice(0, 3).join('、') : '没有可见文件') : '没有返回文件列表'
        })
      } catch (e) {
        this.probeSteps.push({ name: '连接', ok: false, detail: e.message || '请求失败' })
      } finally {
        this.probing = false
        if (clearField) this.probeToken = ''
      }
    },
    async copy(text, message) {
      try { await navigator.clipboard.writeText(text); this.$message.success(message || '已复制') } catch (_) { this.$message.error('复制失败') }
    }
  }
}

async function readMcpBody(res) {
  const type = res.headers.get('content-type') || ''
  const text = await res.text()
  if (!text) return null
  if (type.includes('text/event-stream')) {
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.startsWith('data:'))
    const last = lines.length ? lines[lines.length - 1].slice(5).trim() : ''
    return last ? JSON.parse(last) : null
  }
  try { return JSON.parse(text) } catch (_) { return { raw: text.slice(0, 200) } }
}

function toolData(payload) {
  const result = payload && payload.result
  if (!result) return null
  if (result.structuredContent) return result.structuredContent
  const text = result.content && result.content[0] && result.content[0].text
  if (!text) return null
  try { return JSON.parse(text) } catch (_) { return null }
}
</script>
<style scoped lang="less">
.kb-mcp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
.kb-block { margin-bottom: 16px; }
.kb-section-title { font-weight: 600; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
.kb-kv {
  display: grid;
  grid-template-columns: 90px 1fr;
  gap: 10px 12px;
  margin: 0;
  font-size: 13px;
  dt { color: var(--ui-text-muted); }
  dd { margin: 0; color: var(--ui-text); display: flex; align-items: center; gap: 6px; word-break: break-all; }
}
.kb-mono { font-family: Consolas, Menlo, monospace; }
.kb-dot {
  width: 8px; height: 8px; border-radius: 50%;
  &.is-ok { background: var(--ui-primary); }
  &.is-bad { background: var(--ui-danger); }
}
.kb-hint { margin-top: 12px; font-size: 12px; color: var(--ui-text-muted); line-height: 1.6; }
.kb-tool {
  padding: 8px 10px;
  border-radius: var(--ui-radius-md);
  cursor: pointer;
  &:hover { background: var(--ui-hover-overlay); }
  &.active { background: var(--ui-primary-soft); }
}
.kb-tool-name { font-weight: 600; font-size: 13px; font-family: Consolas, Menlo, monospace; i { margin-right: 6px; color: var(--ui-primary); font-weight: 700; } }
.kb-tool-desc { font-size: 12px; color: var(--ui-text-muted); margin-top: 2px; }
.kb-token-form, .kb-actions, .kb-probe { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.kb-token-name { width: 180px; }
.kb-token-ttl { width: 110px; }
.kb-token-folders { min-width: 220px; flex: 1; }
.kb-token-row { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; padding: 8px 0; border-top: 1px solid var(--ui-border); font-size: 13px; }
.kb-token-meta { grid-column: 1; color: var(--ui-text-muted); font-size: 12px; }
.kb-token-state { margin-left: 8px; font-size: 12px; color: var(--ui-primary); &.is-off { color: var(--ui-text-muted); } }
.kb-method { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.kb-method button {
  border: 1px solid var(--ui-border); background: transparent; color: var(--ui-text);
  border-radius: var(--ui-radius-md); padding: 4px 10px; cursor: pointer;
  &.on { background: var(--ui-primary-soft); border-color: transparent; color: var(--ui-primary); }
}
.kb-config {
  margin: 10px 0 0; padding: 12px; overflow: auto; max-height: 280px;
  background: var(--ui-input-bg); color: var(--ui-text); border-radius: var(--ui-radius-md);
  font-family: Consolas, Menlo, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word;
}
.kb-actions { margin-top: 10px; }
.kb-probe { margin-top: 12px; }
.kb-probe-input { max-width: 360px; }
.kb-probe-steps { margin: 10px 0 0; padding: 0; list-style: none; font-size: 13px; }
.kb-probe-steps .is-ok { color: var(--ui-primary); }
.kb-probe-steps .is-bad { color: var(--ui-danger); }
.kb-debug-row { display: flex; gap: 8px; margin-bottom: 10px; }
.kb-debug-tool { width: 260px; }
.kb-debug-args ::v-deep textarea { font-family: Consolas, Menlo, monospace; background: var(--ui-input-bg); color: var(--ui-text); border-color: var(--ui-border); }
.kb-debug-error { color: var(--ui-danger); font-size: 12px; margin-top: 6px; }
.kb-debug-result { margin-top: 12px; }
.kb-geekcloud { margin-top: 16px; }
@media (max-width: 1000px) { .kb-mcp-grid { grid-template-columns: 1fr; } }
</style>
