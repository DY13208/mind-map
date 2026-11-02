<template>
  <main class="shortLinkPage">
    <div role="status">
      <p v-if="loading">正在打开节点…</p>
      <template v-else>
        <p>{{ error }}</p>
        <el-button @click="open">重试</el-button>
        <router-link to="/files">返回脑图列表</router-link>
      </template>
    </div>
  </main>
</template>
<script>
import { resolveShortNodeLink } from '@/utils/shortNodeLink'
import { resolveNavigationShell } from '@/utils/shellMode'
export default {
  name: 'ShortNodeLink',
  data: () => ({ loading: true, error: '' }),
  mounted() { this.open() },
  watch: { '$route.params.code': 'open' },
  methods: {
    async open() {
      this.loading = true
      const code = String(this.$route.params.code || '')
      try {
        const target = await resolveShortNodeLink(code)
        if (this._isDestroyed || code !== this.$route.params.code) return
        const query = { room: target.roomKey, focus: target.uid }
        query.shell = resolveNavigationShell({ path: '/', query }, this.$route, false)
        await this.$router.replace({ path: '/', query })
      } catch (error) {
        if (this._isDestroyed || code !== this.$route.params.code) return
        this.loading = false
        this.error = error.statusCode === 403 ? '你没有这张脑图的访问权限，请联系拥有者。' : error.message || '无法打开节点链接'
      }
    }
  }
}
</script>
<style scoped>
.shortLinkPage { min-height: 100vh; display: grid; place-items: center; padding: 24px; box-sizing: border-box; background: #f6f8fb; color: #243248; }
.shortLinkPage a { margin-left: 16px; }
</style>
