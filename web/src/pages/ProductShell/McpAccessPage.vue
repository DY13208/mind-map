<template>
  <section class="productPage mcpAccessPage">
    <div class="productHeader">
      <div>
        <h1>MCP 接入</h1>
        <p>将你的 AI 客户端连接到 WCPD，按当前账号权限访问脑图与知识库。</p>
      </div>
    </div>
    <div v-loading="loading" class="mcpAccessContent" :aria-busy="loading">
      <el-alert
        v-if="error"
        type="error"
        :title="error"
        :closable="false"
        show-icon
      >
        <el-button size="small" @click="loadConfig">重试</el-button>
      </el-alert>
      <template v-else>
        <section class="mcpPanel" aria-labelledby="quick-setup-title">
          <div class="mcpSectionHead">
            <div>
              <h2 id="quick-setup-title">快捷接入</h2>
              <p>选择你使用的客户端，完成个人授权与配置。</p>
            </div>
            <div class="mcpMethodSwitch" role="group" aria-label="接入方式">
              <button
                type="button"
                :aria-pressed="setupMethod === 'workbuddy'"
                @click="setupMethod = 'workbuddy'"
              >
                WorkBuddy
              </button>
              <button
                type="button"
                :aria-pressed="setupMethod === 'generic'"
                @click="setupMethod = 'generic'"
              >
                通用 MCP
              </button>
            </div>
          </div>
          <div v-if="setupMethod === 'workbuddy'" class="mcpSetupBody">
            <div>
              <h3>发送指令，扫码授权即可接入</h3>
              <ol class="mcpSteps">
                <li>复制接入指令，发送给本机 WorkBuddy。</li>
                <li>
                  打开它提供的授权链接，核对确认码，使用企业微信扫码并确认。
                </li>
                <li>
                  等待 WorkBuddy
                  写入配置并检查连接；如提示重新加载，按提示操作。
                </li>
              </ol>
              <p class="mcpHint">
                指令不含个人密钥。授权后新增或更新 mind-map，并保留其他 MCP
                配置。
              </p>
            </div>
            <el-button
              type="primary"
              size="small"
              :disabled="loading || !token"
              :icon="
                copied === 'workbuddy'
                  ? 'el-icon-check'
                  : 'el-icon-document-copy'
              "
              @click="copyText(workbuddySetupText, 'workbuddy')"
              >{{
                copied === 'workbuddy' ? '已复制' : '复制接入指令'
              }}</el-button
            >
          </div>
          <div v-else class="mcpSetupBody">
            <div>
              <h3>在支持 HTTP MCP 的客户端中手动配置</h3>
              <ol class="mcpSteps">
                <li>打开客户端的 MCP 配置文件或服务器设置。</li>
                <li>
                  复制完整配置，按客户端格式合并服务器条目，保留已有配置。
                </li>
                <li>保存后重新加载，并在客户端检查连接。</li>
              </ol>
              <p class="mcpHint">
                配置包含 mind-map，以及已就绪时的 mind-map-wiki。若客户端要求
                mcpServers 根字段，请将条目放入该字段。可在高级配置中预览。
                <template v-if="kbIncluded"
                  >已在本页创建文件知识库令牌，配置还包含 file-kb。</template
                >
              </p>
            </div>
            <el-button
              type="primary"
              size="small"
              :disabled="loading || !token"
              :icon="
                copied === 'config' ? 'el-icon-check' : 'el-icon-document-copy'
              "
              @click="copyText(configText, 'config')"
              >{{ copied === 'config' ? '已复制' : '复制完整配置' }}</el-button
            >
          </div>
        </section>

        <section class="mcpPanel" aria-labelledby="services-title">
          <div class="mcpSectionHead">
            <div>
              <h2 id="services-title">服务连接</h2>
              <p>服务地址使用当前访问域名；实际连接结果请在客户端中检查。</p>
            </div>
          </div>
          <div class="mcpServices">
            <div class="mcpService">
              <div class="mcpServiceLabel">
                <h3>脑图 MCP</h3>
                <code>mind-map</code>
              </div>
              <div class="mcpAddress">
                <code :title="mcpUrl">{{ mcpUrl }}</code
                ><el-button
                  size="small"
                  :disabled="loading || !token"
                  @click="copyText(mcpUrl, 'url')"
                  >{{ copied === 'url' ? '已复制' : '复制地址' }}</el-button
                >
              </div>
            </div>
            <div class="mcpService">
              <div class="mcpServiceLabel">
                <h3>知识库 MCP</h3>
                <code>mind-map-wiki</code
                ><span v-if="token && !wikiConfigured" class="mcpUnavailable"
                  >未就绪</span
                >
              </div>
              <div class="mcpAddress">
                <code :title="wikiMcpUrl">{{ wikiMcpUrl }}</code
                ><el-button
                  size="small"
                  :disabled="!wikiConfigured"
                  @click="copyText(wikiMcpUrl, 'wikiUrl')"
                  >{{ copied === 'wikiUrl' ? '已复制' : '复制地址' }}</el-button
                >
              </div>
            </div>
            <div v-if="kbVisible" class="mcpService">
              <div class="mcpServiceLabel">
                <h3>文件知识库 MCP</h3>
                <code>file-kb</code
                ><span v-if="!kbAvailable" class="mcpUnavailable"
                  >暂不可用</span
                ><span v-else-if="!kbPlainToken" class="mcpUnavailable"
                  >需创建令牌</span
                >
              </div>
              <div class="mcpAddress mcpAddressKb">
                <code :title="kbMcpUrl">{{ kbMcpUrl }}</code
                ><el-button
                  size="small"
                  :disabled="!kbAvailable"
                  @click="copyText(kbMcpUrl, 'kbUrl')"
                  >{{ copied === 'kbUrl' ? '已复制' : '复制地址' }}</el-button
                ><template v-if="kbAvailable"
                  ><el-button
                    v-if="kbPlainToken"
                    type="primary"
                    size="small"
                    @click="copyText(kbConfigText, 'kbConfig')"
                    >{{ copied === 'kbConfig' ? '已复制' : '复制配置' }}</el-button
                  ><el-button
                    :type="kbPlainToken ? 'default' : 'primary'"
                    size="small"
                    :loading="kbIssuing"
                    @click="createKbToken"
                    >{{ kbPlainToken ? '重新创建令牌' : '创建访问令牌' }}</el-button
                  ><el-button
                    size="small"
                    title="使用环境变量写法（不含令牌明文）"
                    @click="copyText(kbEnvTemplateText, 'kbTemplate')"
                    >{{ copied === 'kbTemplate' ? '已复制' : '模板' }}</el-button
                  ></template
                >
              </div>
              <div v-if="kbAvailable" class="mcpKbPanel">
                <div class="mcpKbActions">
                  <el-checkbox v-model="kbAllowGeekcloud" size="small"
                    >允许吉客云只读查询</el-checkbox
                  ><el-button
                    v-if="kbTokenState === 'error'"
                    size="small"
                    @click="loadKbTokens"
                    >重新检查</el-button
                  >
                </div>
                <p class="mcpHint">
                  <template v-if="kbPlainToken"
                    >已创建只读令牌（前缀 {{ kbIssuedPrefix }}），「复制配置」和「复制完整配置」都包含真实
                    Authorization，可直接粘贴使用。令牌只保存在本页内存中，刷新或离开后无法再次显示，需重新创建。</template
                  ><template v-else-if="kbTokenState === 'ready'"
                    >你已有 {{ kbTokenCount }} 个可用令牌，但令牌明文创建后无法再次显示。要复制可直接使用的配置，请新建一个访问令牌；「复制完整配置」在此之前不包含
                    file-kb。</template
                  ><template v-else-if="kbTokenState === 'none'"
                    >尚未创建文件知识库令牌，「复制完整配置」暂不包含
                    file-kb。点击「创建访问令牌」后即可直接复制。</template
                  ><template v-else-if="kbTokenState === 'error'"
                    >无法确认已有令牌（{{ kbTokenError }}）。可重新检查，或直接「创建访问令牌」；在此之前「复制完整配置」不包含
                    file-kb。</template
                  ><template v-else>正在检查文件知识库令牌…</template>
                  勾选「允许吉客云只读查询」后新建的令牌会带 geekcloud:read，仍需管理员为你配置吉客云范围。
                  令牌为只读 kb:read，永久有效，可随时撤销，与脑图 MCP 密钥不通用，可在「文件知识库 → MCP
                  接入」中查看和撤销。复制配置不代表已连接，请在客户端检查。
                </p>
                <div v-if="kbPlainToken" class="mcpKbIssued">
                  <el-button size="small" @click="clearKbIssued"
                    >清除本页令牌</el-button
                  >
                </div>
                <details class="mcpKbGuide">
                  <summary>使用环境变量写法与安全提示</summary>
                  <ol class="mcpSteps">
                    <li>
                      「复制配置」包含真实令牌，粘贴后即可使用；请只写入本机客户端配置，不要提交到
                      Git，也不要发送给他人。
                    </li>
                    <li>
                      「模板」复制的是环境变量写法，配置为
                      <code>Bearer {{ kbPlaceholder }}</code>（Cursor 写法），需在本机设置环境变量
                      {{ kbTokenEnv }} 后完全退出 Cursor 再打开。
                    </li>
                    <li>
                      使用其它变量写法的客户端（例如 Claude Code 为
                      <code>{{ kbClaudePlaceholder }}</code>）：按该客户端文档改写占位符。
                    </li>
                    <li>
                      支持密钥或凭据存储的客户端，可把令牌存在其中，配置里只引用。
                    </li>
                    <li>
                      令牌泄露或不再使用时，在「文件知识库 → MCP
                      接入」中撤销，下一次请求即失效。
                    </li>
                  </ol>
                </details>
              </div>
              <p v-else class="mcpHint">
                服务端未开启 FILE_KB_ENABLED，文件知识库 MCP 暂不可用，也不会加入「复制完整配置」。
              </p>
            </div>
          </div>
          <el-alert
            v-if="token && !wikiConfigured"
            class="mcpWikiWarn"
            type="warning"
            :closable="false"
            show-icon
            title="知识库 MCP 未就绪"
          >
            未配置 KNOWLEDGE_MCP_JWT_SECRET 或签发失败。脑图 MCP
            配置仍可使用；知识库工具需配置密钥并确保 knowledge-mcp 容器运行。
          </el-alert>
        </section>

        <section class="mcpPanel mcpAdvanced" aria-labelledby="advanced-title">
          <button
            id="advanced-title"
            type="button"
            class="mcpDisclosure"
            :aria-expanded="advancedOpen"
            aria-controls="mcp-advanced-content"
            @click="
              advancedOpen = !advancedOpen
              showAuthorization = false
            "
          >
            <span
              ><strong>高级配置</strong
              ><span class="mcpDisclosureHint"
                >完整 JSON · 个人 Authorization</span
              ></span
            >
            <span class="mcpDisclosureAction"
              >{{ advancedOpen ? '收起' : '展开' }}
              <i
                :class="
                  advancedOpen ? 'el-icon-arrow-up' : 'el-icon-arrow-down'
                "
                aria-hidden="true"
              ></i
            ></span>
          </button>
          <div
            v-if="advancedOpen"
            id="mcp-advanced-content"
            class="mcpAdvancedContent"
          >
            <div class="mcpConfigToolbar">
              <span>HTTP MCP 配置</span>
              <div>
                <el-button
                  size="small"
                  :aria-pressed="showAuthorization"
                  @click="showAuthorization = !showAuthorization"
                  >{{
                    showAuthorization
                      ? '隐藏 Authorization'
                      : '显示 Authorization'
                  }}</el-button
                ><el-button
                  size="small"
                  :disabled="loading || !token"
                  :icon="
                    copied === 'config'
                      ? 'el-icon-check'
                      : 'el-icon-document-copy'
                  "
                  @click="copyText(configText, 'config')"
                  >{{
                    copied === 'config' ? '已复制' : '复制完整配置'
                  }}</el-button
                >
              </div>
            </div>
            <pre
              tabindex="0"
              aria-label="完整 MCP JSON 配置"
            ><code v-html="highlightedConfig"></code></pre>
            <p class="mcpHint">
              Authorization
              默认遮挡；复制将包含完整密钥，与当前账号绑定，访问遵循你的脑图、团队与知识库权限。
            </p>
          </div>
        </section>
        <p class="mcpSecurityNote">
          <i class="el-icon-lock" aria-hidden="true"></i> 请妥善保管
          Authorization，不要发送给他人；系统密钥轮换后请重新复制配置。
        </p>
      </template>
    </div>
  </section>
</template>

<script>
import hljs from 'highlight.js/lib/core'
import json from 'highlight.js/lib/languages/json'
import { userMessageFromError } from '@/services/apiError'
import productService from '@/services/productService'
import { getRuntimeConfig } from '@/utils/runtimeConfig'
import kbApi from '@/features/knowledge-base/services/kbApi'
import {
  KB_TOKEN_ENV,
  KB_TOKEN_PLACEHOLDER,
  fileKbAccessConfig,
  kbEnabled,
  kbPageEnabled,
  mcpEndpoint,
  usableKbTokenCount,
  withFileKbServer
} from '@/features/knowledge-base/utils/format'

hljs.registerLanguage('json', json)

export default {
  name: 'McpAccessPage',
  data() {
    return {
      mcpUrl: getRuntimeConfig().mcpUrl,
      token: '',
      wikiToken: '',
      wikiMcpPath: '/knowledge-mcp/mcp',
      wikiConfigured: false,
      loading: false,
      error: '',
      copied: '',
      setupMethod: 'workbuddy',
      advancedOpen: false,
      showAuthorization: false,
      copyTimer: null,
      kbVisible: kbPageEnabled(),
      kbAvailable: kbEnabled(),
      kbPlaceholder: KB_TOKEN_PLACEHOLDER,
      kbTokenEnv: KB_TOKEN_ENV,
      kbClaudePlaceholder: '${' + KB_TOKEN_ENV + '}',
      kbTokenState: 'unknown',
      kbTokenCount: 0,
      kbTokenError: '',
      kbIssuing: false,
      kbAllowGeekcloud: false,
      kbPlainToken: '',
      kbIssuedPrefix: ''
    }
  },
  computed: {
    highlightedConfig() {
      const preview = this.showAuthorization
        ? this.configText
        : JSON.stringify(
            JSON.parse(this.configText),
            (key, value) =>
              key === 'Authorization' ? 'Bearer ••••••••••••' : value,
            2
          )
      return hljs.highlight('json', preview, true).value
    },
    workbuddySetupText() {
      const origin = new URL(this.mcpUrl).origin
      return [
        '请在当前这台电脑的 WorkBuddy 中新增一个名为 mind-map 的 MCP，直接完成配置。',
        `先 POST ${origin}/api/mcp-config/device 创建授权请求，无需登录，返回 device_code、user_code、verification_uri、poll_uri、expires_in 和 interval。`,
        '把 verification_uri 授权链接和 user_code 确认码展示给我，让我打开链接、企业微信扫码登录并确认授权。不要替我确认，也不要展示 device_code。',
        '按 interval（至少 3 秒）POST poll_uri，JSON 请求体为 {"device_code":"创建请求返回的领取凭证"}。202 authorization_pending 表示继续等待；429 slow_down 时降低频率；400 invalid_or_expired_code 时停止并重新创建请求。最多等待 expires_in 秒。',
        '授权后返回 200 和 mcpServers，其中 mind-map 包含个人 Authorization。只领取一次，立即写入本机配置；不要将返回的密钥展示在回复、日志、命令行参数或 Git 中。',
        '先确认本机 WorkBuddy 实际使用的 MCP 配置文件和格式，不要猜测路径，也不要修改其他客户端的配置。',
        '读取并备份现有文件，按客户端格式合并领取到的服务器配置，保留所有其他 MCP 和配置字段。若已有 mind-map，只更新该项。',
        '写入后检查 JSON 格式并验证 MCP 连接，使用只读工具确认可用，不要修改脑图数据。如需要重新加载客户端，告诉我操作步骤；不要在验证前宣称接入成功。',
        '如果无法访问本机配置，请明确说明原因和手动添加方法。'
      ].join('\n\n')
    },
    wikiMcpUrl() {
      if (typeof window === 'undefined' || !window.location) {
        return this.wikiMcpPath
      }
      return `${window.location.origin}${this.wikiMcpPath}`
    },
    kbMcpUrl() {
      if (typeof window === 'undefined' || !window.location) {
        return mcpEndpoint({ origin: '' })
      }
      return mcpEndpoint(window.location)
    },
    kbConfigText() {
      return fileKbAccessConfig(this.kbMcpUrl, this.kbPlainToken)
    },
    kbEnvTemplateText() {
      return fileKbAccessConfig(this.kbMcpUrl)
    },
    // 只有服务开启、条目可见、且本页刚创建了令牌（明文在内存里）时才并入完整配置。
    kbIncluded() {
      return Boolean(this.kbVisible && this.kbAvailable && this.kbPlainToken)
    },
    configText() {
      const servers = {
        'mind-map': {
          type: 'http',
          url: this.mcpUrl,
          disabled: false,
          headers: {
            Authorization: `Bearer ${this.token}`
          }
        }
      }
      if (this.wikiConfigured && this.wikiToken) {
        servers['mind-map-wiki'] = {
          type: 'http',
          url: this.wikiMcpUrl,
          disabled: false,
          headers: {
            Authorization: `Bearer ${this.wikiToken}`
          }
        }
      }
      return JSON.stringify(
        withFileKbServer(
          servers,
          this.kbIncluded ? this.kbMcpUrl : '',
          this.kbPlainToken
        ),
        null,
        2
      )
    }
  },
  created() {
    this.loadConfig()
    this.loadKbTokens()
  },
  beforeDestroy() {
    clearTimeout(this.copyTimer)
    this.clearKbIssued()
  },
  methods: {
    async loadConfig() {
      if (this.loading) return
      this.loading = true
      this.error = ''
      try {
        const data = await productService.getMcpConfig()
        this.token = String((data && data.token) || '')
        this.wikiToken = String((data && data.wikiToken) || '')
        this.wikiMcpPath = String(
          (data && data.wikiMcpPath) || '/knowledge-mcp/mcp'
        )
        this.wikiConfigured = Boolean(
          data && data.wikiConfigured && this.wikiToken
        )
        if (!this.token) throw new Error('MCP 服务未返回可用密钥')
      } catch (error) {
        this.token = ''
        this.wikiToken = ''
        this.wikiConfigured = false
        this.error = userMessageFromError(error)
      } finally {
        this.loading = false
      }
    },
    // 只读取令牌列表判断是否已有可用令牌；页面加载和复制都不会签发令牌。
    async loadKbTokens() {
      if (!this.kbVisible || !this.kbAvailable) return
      this.kbTokenState = 'loading'
      this.kbTokenError = ''
      try {
        const list = await kbApi.listMcpTokens()
        this.kbTokenCount = usableKbTokenCount(list && list.items)
        this.kbTokenState = this.kbTokenCount > 0 ? 'ready' : 'none'
      } catch (error) {
        this.kbTokenCount = 0
        this.kbTokenState = 'error'
        this.kbTokenError = (error && error.message) || '请求失败'
      }
    },
    // 只有用户点击「创建访问令牌」才签发。明文只留在本组件内存里，用于生成可直接粘贴的配置；
    // 不做本地持久化、不打日志；清除或离开页面即丢弃。
    async createKbToken() {
      if (this.kbIssuing || !this.kbAvailable) return
      this.kbIssuing = true
      try {
        const created = await kbApi.createMcpToken({
          name: 'MCP 接入页',
          scopes: this.kbAllowGeekcloud
            ? ['kb:read', 'geekcloud:read']
            : ['kb:read']
        })
        const token = String((created && created.token) || '')
        if (!token) throw new Error('服务没有返回令牌')
        this.kbIssuedPrefix = String(created.tokenPrefix || token.slice(0, 8))
        this.kbPlainToken = token
      } catch (error) {
        this.$message.error((error && error.message) || '创建令牌失败')
      } finally {
        this.kbIssuing = false
      }
      if (this.kbPlainToken) await this.loadKbTokens()
    },
    clearKbIssued() {
      this.kbPlainToken = ''
      this.kbIssuedPrefix = ''
    },
    async copyText(text, kind) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text)
        } else {
          const input = document.createElement('textarea')
          input.value = text
          input.setAttribute('readonly', '')
          input.style.position = 'fixed'
          input.style.opacity = '0'
          document.body.appendChild(input)
          input.select()
          const copied = document.execCommand('copy')
          document.body.removeChild(input)
          if (!copied) throw new Error('copy failed')
        }
        this.copied = kind
        const msg =
          kind === 'workbuddy'
            ? '接入指令已复制，请发送给自己的 WorkBuddy'
            : kind === 'config'
            ? 'MCP 配置已复制'
            : kind === 'wikiUrl'
            ? 'Wiki MCP 地址已复制'
            : kind === 'kbUrl'
            ? '文件知识库 MCP 地址已复制'
            : kind === 'kbConfig'
            ? '文件知识库 MCP 配置已复制（含令牌，请妥善保管）'
            : kind === 'kbTemplate'
            ? `环境变量写法已复制，请在本机设置 ${KB_TOKEN_ENV}`
            : 'MCP 地址已复制'
        this.$message.success(msg)
        clearTimeout(this.copyTimer)
        this.copyTimer = setTimeout(() => {
          this.copied = ''
        }, 1800)
      } catch (error) {
        this.$message.error('复制失败，请选中文本后手动复制')
      }
    }
  }
}
</script>

<style lang="less" scoped>
.productPage.mcpAccessPage {
  max-width: 1200px;
  margin: 0 auto;
  color: var(--ui-text);
  .productHeader {
    margin-bottom: 20px;
  }
}
.mcpAccessContent {
  min-height: 240px;
}
.mcpPanel {
  padding: 20px 24px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-lg);
  background: var(--ui-surface);
  & + & {
    margin-top: 16px;
  }
}
.mcpSectionHead {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-bottom: 18px;
  h2 {
    margin: 0;
    font-size: 16px;
    line-height: 1.5;
  }
  p {
    margin: 4px 0 0;
    color: var(--ui-text-secondary);
    font-size: 13px;
    line-height: 1.6;
  }
}
h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.6;
}
.mcpMethodSwitch {
  display: flex;
  flex-shrink: 0;
  padding: 3px;
  gap: 3px;
  background: var(--ui-surface-muted);
  border-radius: var(--ui-radius-md);
  button {
    padding: 8px 14px;
    border: 1px solid transparent;
    border-radius: 5px;
    background: transparent;
    color: var(--ui-text-secondary);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    &[aria-pressed='true'] {
      background: var(--ui-surface);
      color: var(--ui-primary);
      border-color: var(--ui-border);
      font-weight: 600;
    }
    &:hover {
      color: var(--ui-primary);
    }
  }
}
button:focus-visible,
pre:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 3px;
}
.mcpSetupBody {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  > div {
    min-width: 0;
  }
  > .el-button {
    flex-shrink: 0;
  }
}
.mcpSteps {
  margin: 10px 0;
  padding-left: 20px;
  font-size: 13px;
  line-height: 1.9;
  li {
    padding-left: 3px;
  }
}
.mcpHint {
  max-width: 75ch;
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--ui-text-secondary);
}
.mcpServices {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 24px;
}
.mcpService {
  min-width: 0;
}
.mcpServiceLabel {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
  > code {
    font-size: 12px;
    color: var(--ui-text-secondary);
  }
}
.mcpAddress {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 6px 6px 12px;
  background: var(--ui-surface-muted);
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-md);
  > code {
    min-width: 0;
    flex: 1;
    overflow: auto;
    white-space: nowrap;
    font: 12px/1.6 Consolas, monospace;
  }
  .el-button {
    flex-shrink: 0;
  }
}
.mcpUnavailable {
  font-size: 12px;
  color: #865b14;
}
.mcpWikiWarn {
  margin-top: 16px;
}
.mcpAddressKb {
  flex-wrap: wrap;
  > code {
    flex: 1 1 180px;
  }
  .el-button {
    margin: 0;
  }
}
.mcpKbPanel {
  margin: 8px 0 0 6px;
  padding: 2px 0 2px 12px;
  border-left: 2px solid var(--ui-border);
}
.mcpKbActions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
  .el-button {
    margin: 0;
  }
}
.mcpKbIssued {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  margin-top: 12px;
  .el-alert {
    width: 100%;
  }
}
.mcpKbGuide {
  margin-top: 12px;
  font-size: 12px;
  color: var(--ui-text-secondary);
  summary {
    cursor: pointer;
    color: var(--ui-text);
  }
  .mcpSteps {
    font-size: 12px;
  }
}
.mcpAdvanced {
  padding: 0;
}
.mcpDisclosure {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 24px;
  border: 0;
  border-radius: inherit;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  strong {
    font-size: 16px;
  }
  &:hover {
    background: var(--ui-surface-muted);
  }
}
.mcpDisclosureHint {
  margin-left: 16px;
  font-size: 12px;
  color: var(--ui-text-secondary);
}
.mcpDisclosureAction {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--ui-text-secondary);
  i {
    margin-left: 6px;
  }
}
.mcpAdvancedContent {
  padding: 0 24px 20px;
}
.mcpConfigToolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin: 6px 0 12px;
  font-size: 12px;
  color: var(--ui-text-secondary);
  > div {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .el-button {
    margin: 0;
  }
}
pre {
  max-height: 320px;
  overflow: auto;
  margin: 0;
  padding: 16px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-md);
  background: var(--ui-surface-muted);
  color: #20372d;
  font: 12px/1.75 Consolas, 'SFMono-Regular', monospace;
  white-space: pre;
  /deep/ .hljs-attr {
    color: #205e48;
  }
  /deep/ .hljs-string {
    color: #775022;
  }
  /deep/ .hljs-literal,
  /deep/ .hljs-number {
    color: #465fa1;
  }
}
.mcpSecurityNote {
  display: flex;
  align-items: baseline;
  gap: 7px;
  margin: 14px 0 0;
  color: var(--ui-text-secondary);
  font-size: 12px;
  line-height: 1.7;
}
@media (max-width: 900px) {
  .mcpServices {
    grid-template-columns: minmax(0, 1fr);
    gap: 20px;
  }
}
@media (max-width: 680px) {
  .mcpPanel {
    padding: 18px 16px;
  }
  .mcpSectionHead,
  .mcpSetupBody {
    flex-direction: column;
    align-items: flex-start;
    gap: 16px;
  }
  .mcpAdvanced {
    padding: 0;
  }
  .mcpDisclosure {
    padding: 18px 16px;
  }
  .mcpDisclosureHint {
    display: block;
    margin: 4px 0 0;
  }
  .mcpAdvancedContent {
    padding: 0 16px 18px;
  }
}
</style>
