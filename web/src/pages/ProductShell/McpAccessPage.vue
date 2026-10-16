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
      copyTimer: null
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
      return JSON.stringify(servers, null, 2)
    }
  },
  created() {
    this.loadConfig()
  },
  beforeDestroy() {
    clearTimeout(this.copyTimer)
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
