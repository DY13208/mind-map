<template>
  <ShareFolderDialog
    v-if="adapter"
    :visible="shown"
    :folder="resource"
    :adapter="adapter"
    :read-only="readOnly"
    @update:visible="onVisible"
    @changed="$emit('changed')"
  />
</template>
<script>
// 文件知识库「权限设置」直接复用脑图的文件夹权限对话框，数据走 KB ACL 接口（kbAclAdapter）。
import ShareFolderDialog from '@/pages/ProductShell/components/ShareFolderDialog.vue'
import teamService from '@/services/teamService'
import { getCurrentUser } from '@/utils/auth'
import kbApi from '../services/kbApi'
import { createKbAclAdapter } from '../services/kbAclAdapter'

export default {
  name: 'KbPermissionDialog',
  components: { ShareFolderDialog },
  props: { visible: Boolean, target: { type: Object, default: null } },
  data() {
    return { adapter: null, shown: false, readOnly: true, openSeq: 0 }
  },
  computed: {
    resource() {
      const t = this.target || {}
      return { id: t.id, name: t.name || '' }
    }
  },
  watch: {
    visible: { immediate: true, handler(v) { if (v) this.open(); else this.shown = false } }
  },
  methods: {
    // 先读一次 ACL：只有后端给了 grant 能力才可编辑，否则只读查看
    async open() {
      const target = this.target
      if (!target || !target.id) return
      const seq = ++this.openSeq
      const user = getCurrentUser() || {}
      const adapter = createKbAclAdapter({
        api: kbApi,
        target,
        contacts: teamService,
        currentUser: { id: user.id || user.userId, name: user.name }
      })
      try {
        await adapter.prime()
      } catch (e) {
        if (seq !== this.openSeq) return
        this.$message.error((e && e.message) || '加载权限失败')
        this.$emit('update:visible', false)
        return
      }
      if (seq !== this.openSeq || !this.visible) return
      this.readOnly = !adapter.capabilities().includes('grant')
      this.adapter = adapter
      this.shown = true
    },
    onVisible(v) {
      this.shown = v
      if (!v) this.$emit('update:visible', false)
    }
  }
}
</script>
