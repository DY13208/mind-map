<template>
  <section class="productPage mcpAccessPage">
    <div class="productHeader">
      <div>
        <h1>MCP 接入</h1>
        <p>复制个人配置，让支持 MCP 的 AI 客户端连接良策</p>
      </div>
    </div>

    <div v-loading="loading" class="mcpAccessContent">
      <el-alert
        v-if="error"
        class="mcpConfigError"
        type="error"
        :title="error"
        :closable="false"
        show-icon
      >
        <el-button size="small" @click="loadConfig">重试</el-button>
      </el-alert>

      <template v-else>
        <div class="mcpPageIntro">
          <i class="el-icon-connection" aria-hidden="true"></i>
          <div>
            <strong>你的个人 MCP 配置</strong>
            <p>
              Authorization 与当前账号绑定。AI
              通过此配置访问时，仍遵循你的脑图和团队权限。
            </p>
          </div>
        </div>

        <section aria-labelledby="mcp-config-title">
          <div class="mcpSectionHead">
            <div>
              <h2 id="mcp-config-title">完整配置</h2>
              <p>复制后粘贴到客户端的 MCP 配置文件中</p>
            </div>
            <el-button
              type="primary"
              :disabled="loading || !token"
              :icon="
                copied === 'config' ? 'el-icon-check' : 'el-icon-document-copy'
              "
              @click="copyText(configText, 'config')"
              >{{ copied === 'config' ? '已复制' : '复制完整配置' }}</el-button
            >
          </div>
          <pre tabindex="0"><code>{{ configText }}</code></pre>
        </section>

        <section aria-labelledby="mcp-address-title">
          <div class="mcpSectionHead mcpSectionHead--compact">
            <div>
              <h2 id="mcp-address-title">服务地址</h2>
              <p>地址会根据当前访问域名自动生成</p>
            </div>
            <el-button icon="el-icon-link" @click="copyText(mcpUrl, 'url')">
              {{ copied === 'url' ? '已复制' : '复制地址' }}
            </el-button>
          </div>
          <div class="mcpUrl" :title="mcpUrl">{{ mcpUrl }}</div>
        </section>

        <div class="mcpSecurityNote" role="note">
          <i class="el-icon-warning-outline" aria-hidden="true"></i>
          <div>
            <strong>请妥善保管 Authorization</strong>
            <span
              >它代表你的账号权限，不要发送给其他人；系统密钥轮换后请重新复制配置。</span
            >
          </div>
        </div>
      </template>
    </div>
  </section>
</template>

<script>
import { userMessageFromError } from '@/services/apiError'
import productService from '@/services/productService'
import { getRuntimeConfig } from '@/utils/runtimeConfig'

export default {
  name: 'McpAccessPage',
  data() {
    return {
      mcpUrl: getRuntimeConfig().mcpUrl,
      token: '',
      loading: false,
      error: '',
      copied: '',
      copyTimer: null
    }
  },
  computed: {
    configText() {
      return JSON.stringify(
        {
          'mind-map': {
            type: 'http',
            url: this.mcpUrl,
            disabled: false,
            headers: {
              Authorization: `Bearer ${this.token}`
            }
          }
        },
        null,
        2
      )
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
        if (!this.token) throw new Error('MCP 服务未返回可用密钥')
      } catch (error) {
        this.token = ''
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
        this.$message.success(
          kind === 'config' ? 'MCP 配置已复制' : 'MCP 地址已复制'
        )
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
.mcpAccessPage {
  max-width: 1120px;
}
.mcpAccessContent {
  min-height: 360px;
}
.mcpPageIntro {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  margin-bottom: 28px;
  padding: 16px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-lg);
  background: var(--ui-surface);
  > i {
    width: 36px;
    height: 36px;
    display: grid;
    flex: 0 0 auto;
    place-items: center;
    border-radius: var(--ui-radius-md);
    background: var(--ui-primary-soft);
    color: var(--ui-primary);
    font-size: 18px;
  }
  strong {
    font-size: 15px;
  }
  p {
    max-width: 68ch;
    margin: 5px 0 0;
    color: var(--ui-text-secondary);
    font-size: 13px;
    line-height: 1.55;
  }
}
.mcpAccessContent section {
  padding: 20px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-lg);
  background: var(--ui-surface);
  & + section {
    margin-top: 16px;
  }
}
.mcpSectionHead {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
  h2 {
    margin: 0;
    font-size: 16px;
    line-height: 1.4;
  }
  p {
    margin: 4px 0 0;
    color: var(--ui-text-secondary);
    font-size: 13px;
  }
}
pre {
  max-height: 360px;
  margin: 0;
  padding: 18px;
  overflow: auto;
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-md);
  background: #f4f7f5;
  color: #20372d;
  font: 13px/1.65 Consolas, 'SFMono-Regular', monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.mcpUrl {
  padding: 11px 13px;
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-md);
  background: var(--ui-surface-muted);
  color: var(--ui-text-secondary);
  font: 13px/1.5 Consolas, 'SFMono-Regular', monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mcpSecurityNote {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 16px;
  color: var(--ui-text-secondary);
  font-size: 13px;
  line-height: 1.55;
  i {
    margin-top: 3px;
    color: #9a6a19;
  }
  div {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  strong {
    color: var(--ui-text);
    font-size: 13px;
  }
}
.mcpConfigError {
  /deep/ .el-alert__content {
    width: 100%;
  }
  .el-button {
    margin-top: 10px;
  }
}

@media (max-width: 680px) {
  .mcpSectionHead {
    align-items: stretch;
    flex-direction: column;
  }
  .mcpSectionHead .el-button {
    align-self: flex-start;
  }
  .mcpAccessContent section {
    padding: 16px;
  }
}
</style>
