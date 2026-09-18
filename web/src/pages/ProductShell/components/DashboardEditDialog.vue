<template>
  <el-dialog
    title="编辑看板"
    :visible="visible"
    width="480px"
    append-to-body
    @update:visible="$emit('update:visible', $event)"
    @closed="reset"
  >
    <el-form label-position="top" @submit.native.prevent>
      <el-form-item label="看板名称">
        <el-input v-model="title" placeholder="例如：市场增长看板" />
      </el-form-item>
      <el-form-item label="所属层级">
        <el-select v-model="level" style="width: 100%">
          <el-option label="集团级" value="group" />
          <el-option label="部门级" value="department" />
          <el-option label="项目级" value="project" />
        </el-select>
      </el-form-item>
      <el-form-item label="看板来源">
        <el-radio-group v-model="sourceType">
          <el-radio label="html">上传 HTML 文件</el-radio>
          <el-radio label="url">在线链接</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item v-if="sourceType === 'html'" label="数据看板 HTML">
        <el-upload
          drag
          accept=".html,.htm"
          action="#"
          :auto-upload="false"
          :limit="1"
          :file-list="fileList"
          :on-change="onFileChange"
          :on-remove="onFileRemove"
          :on-exceed="onExceed"
        >
          <i class="el-icon-upload" />
          <div class="el-upload__text">
            将 HTML 文件拖到此处，或<em>点击选择</em>
          </div>
          <div slot="tip" class="uploadTip">
            重新选择单个 .html 文件将替换当前内容；不选择则保留现有 HTML。
          </div>
        </el-upload>
      </el-form-item>
      <el-form-item v-else label="看板链接">
        <el-input
          v-model="sourceUrl"
          clearable
          placeholder="https://example.com/dashboard"
        />
        <div class="uploadTip">
          支持 http/https 链接，保存后将嵌入显示该链接页面。
        </div>
      </el-form-item>
    </el-form>
    <div slot="footer">
      <el-button @click="$emit('update:visible', false)">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="submit"
        >保存</el-button
      >
    </div>
  </el-dialog>
</template>

<script>
import { userMessageFromError } from '@/services/apiError'
import brandDashboardService from '@/services/brandDashboardService'

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      const index = result.indexOf(',')
      resolve(index >= 0 ? result.slice(index + 1) : result)
    }
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

export default {
  name: 'DashboardEditDialog',
  props: {
    visible: { type: Boolean, default: false },
    dashboard: { type: Object, default: null }
  },
  data() {
    return {
      title: '',
      level: 'group',
      sourceType: 'html',
      sourceUrl: '',
      file: null,
      fileList: [],
      submitting: false
    }
  },
  watch: {
    visible(value) {
      if (!value || !this.dashboard) return
      this.title = this.dashboard.title || ''
      this.level = this.dashboard.level || 'group'
      this.sourceType = this.dashboard.sourceType === 'url' ? 'url' : 'html'
      this.sourceUrl = this.dashboard.sourceUrl || ''
    }
  },
  methods: {
    onFileChange(file, fileList) {
      this.file = (file && file.raw) || null
      this.fileList = fileList.slice(-1)
    },
    onFileRemove() {
      this.file = null
      this.fileList = []
    },
    onExceed(files) {
      const picked = files && files[0]
      if (!picked) return
      this.file = picked
      this.fileList = [{ name: picked.name, raw: picked }]
      if (this.$message) this.$message.warning('仅保留最后一个 HTML 文件')
    },
    async submit() {
      if (!this.dashboard) return
      const title = this.title.trim()
      if (!title) {
        if (this.$message) this.$message.warning('请填写看板名称')
        return
      }
      const payload = { title, level: this.level }
      if (this.sourceType === 'url') {
        const sourceUrl = this.sourceUrl.trim()
        if (!/^https?:\/\//i.test(sourceUrl)) {
          if (this.$message) {
            this.$message.warning('请填写以 http(s):// 开头的看板链接')
          }
          return
        }
        payload.sourceUrl = sourceUrl
      } else if (this.file) {
        payload.fileName = this.file.name
        payload.contentBase64 = await readAsBase64(this.file)
      } else if (this.dashboard.sourceType !== 'html') {
        if (this.$message) this.$message.warning('请上传数据看板 HTML 文件')
        return
      }
      this.submitting = true
      try {
        await brandDashboardService.updateDashboard(this.dashboard.id, payload)
        if (this.$message) this.$message.success(`已更新看板「${title}」`)
        this.$emit('update:visible', false)
        this.$emit('done')
      } catch (error) {
        if (this.$message) {
          this.$message.error(userMessageFromError(error) || '修改失败')
        }
      } finally {
        this.submitting = false
      }
    },
    reset() {
      this.title = ''
      this.level = 'group'
      this.sourceType = 'html'
      this.sourceUrl = ''
      this.file = null
      this.fileList = []
      this.submitting = false
    }
  }
}
</script>

<style lang="less" scoped>
.uploadTip { margin-top: 6px; color: var(--ui-text-secondary); font-size: 12px; line-height: 1.5; }
</style>
