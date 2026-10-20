<template>
  <nav id="product-navigation" class="productNavigation" aria-label="产品导航">
    <p class="navLabel">文件</p>
    <router-link
      v-for="item in fileNav"
      :key="item.path"
      :to="navigationTarget(item.path)"
      :title="item.label"
      :aria-label="item.label"
      @click.native="notifyNavigation"
    ><i :class="item.icon" aria-hidden="true"></i>{{ item.label }}</router-link>
    <p class="navLabel navLabel--space">空间</p>
    <router-link :to="navigationTarget('/spaces')" title="我的团队" aria-label="我的团队" @click.native="notifyNavigation">
      <i class="el-icon-office-building" aria-hidden="true"></i>我的团队
    </router-link>
    <router-link :to="navigationTarget('/sop')" title="SOP台账" aria-label="SOP台账" @click.native="notifyNavigation">
      <i class="el-icon-notebook-2" aria-hidden="true"></i>SOP台账
    </router-link>
    <router-link :to="navigationTarget('/assistant')" title="助理" aria-label="助理" @click.native="notifyNavigation">
      <i class="el-icon-chat-dot-round" aria-hidden="true"></i>助理
    </router-link>
    <router-link
      v-if="kbEnabled"
      :to="navigationTarget('/kb')"
      title="文件知识库"
      aria-label="文件知识库"
      @click.native="notifyNavigation"
    ><i class="el-icon-collection" aria-hidden="true"></i>文件知识库</router-link>
    <p class="navLabel navLabel--space">工具</p>
    <router-link :to="navigationTarget('/mcp-access')" title="获取 MCP 配置" aria-label="获取 MCP 配置" @click.native="notifyNavigation">
      <i class="el-icon-connection" aria-hidden="true"></i><span>MCP 接入</span>
    </router-link>
    <a
      href="https://xx.stillgroup.net:3030/dashboard"
      target="_blank"
      rel="noopener noreferrer"
      title="Cognee 知识图谱（新标签页打开）"
      aria-label="Cognee 知识图谱（新标签页打开）"
      @click="notifyNavigation"
    ><i class="el-icon-search" aria-hidden="true"></i><span>Cognee</span></a>
    <router-link
      :to="navigationTarget('/graph')"
      title="wiki-compiler"
      aria-label="wiki-compiler"
      data-testid="nav-wiki-compiler"
      @click.native="notifyNavigation"
    ><i class="el-icon-share" aria-hidden="true"></i><span>wiki-compiler</span></router-link>
  </nav>
</template>

<script>
import { withShell } from '@/utils/shellMode'

export default {
  name: 'ProductNavigation',
  props: {
    fileNav: { type: Array, default: () => [] },
    kbEnabled: { type: Boolean, default: true }
  },
  methods: {
    navigationTarget(location) {
      return withShell(location, this.$route)
    },
    notifyNavigation() {
      this.$emit('navigate')
    }
  }
}
</script>
