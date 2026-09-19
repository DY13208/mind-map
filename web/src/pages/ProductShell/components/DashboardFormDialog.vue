<template>
  <el-dialog
    :visible="visible"
    width="680px"
    custom-class="dashboardModal"
    append-to-body
    @update:visible="$emit('update:visible', $event)"
    @closed="reset"
  >
    <div slot="title" class="modalTitleWrap">
      <div class="titleIcon" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <rect x="3.5" y="4" width="17" height="16" rx="2.5" stroke="currentColor" stroke-width="1.8" />
          <path d="M8 8.5h8M8 12h5M8 15.5h7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </svg>
      </div>
      <div>
        <h1 class="modalTitle">{{ isEdit ? '编辑看板' : '新建看板' }}</h1>
        <p class="modalSubtitle">
          {{ isEdit ? '修改看板信息并更换数据看板来源' : '填写基础信息并添加数据看板来源' }}
        </p>
      </div>
    </div>
    <div class="modalBody">
      <div class="field">
        <div class="labelRow">
          <span class="label">看板名称</span>
          <span class="required">*</span>
        </div>
        <el-input v-model="title" placeholder="例如：市场增长看板" />
      </div>
      <div class="field">
        <div class="labelRow">
          <span class="label">所属层级</span>
          <span class="required">*</span>
        </div>
        <el-select v-model="level" style="width: 100%">
          <el-option label="集团级" value="group" />
          <el-option label="部门级" value="department" />
          <el-option label="项目级" value="project" />
        </el-select>
      </div>
      <div class="field">
        <div class="labelRow">
          <span class="label">看板来源</span>
        </div>
        <div class="sourceTabs">
          <button
            type="button"
            class="sourceTab"
            :class="{ 'is-on': sourceType === 'html' }"
            @click="sourceType = 'html'"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M12 16V5m0 0L8 9m4-4 4 4M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            上传 HTML 文件
          </button>
          <button
            type="button"
            class="sourceTab"
            :class="{ 'is-on': sourceType === 'url' }"
            @click="sourceType = 'url'"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M10 13a5 5 0 0 0 7.07.07l2-2A5 5 0 0 0 12 4M14 11a5 5 0 0 0-7.07-.07l-2 2A5 5 0 0 0 12 20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            </svg>
            在线链接
          </button>
        </div>
      </div>
      <div v-if="sourceType === 'html'" class="field">
        <div class="labelRow">
          <span class="label">数据看板 HTML</span>
          <span v-if="!isEdit" class="required">*</span>
        </div>
        <div
          class="uploadBox"
          :class="{ 'is-drag': dragging }"
          @click="pickFile"
          @dragenter.prevent="dragging = true"
          @dragover.prevent="dragging = true"
          @dragleave.prevent="dragging = false"
          @drop.prevent="onDrop"
        >
          <input
            ref="fileInput"
            type="file"
            accept=".html,.htm,text/html"
            hidden
            @click.stop
            @change="onFileInput"
          />
          <div class="uploadContent">
            <div class="uploadIcon">
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
                <path d="M7 18a4 4 0 0 1-.7-7.94A6 6 0 0 1 17.7 8.7 4.5 4.5 0 0 1 17.5 18H7Z" stroke="currentColor" stroke-width="1.6" />
                <path d="M12 15V8m0 0-2.5 2.5M12 8l2.5 2.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </div>
            <div class="uploadTitle">
              将 HTML 文件拖到此处，或 <span class="link">点击选择</span>
            </div>
            <div class="uploadDesc">支持单个 .html 文件，建议文件大小不超过 20 MB</div>
            <div v-if="file" class="fileName">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M7 3.5h7l3 3V20.5H7V3.5Z" stroke="currentColor" stroke-width="1.6" />
                <path d="M14 3.5v3h3" stroke="currentColor" stroke-width="1.6" />
              </svg>
              <span>{{ file.name }}</span>
            </div>
          </div>
        </div>
        <div class="hint">
          {{
            isEdit
              ? '重新选择单个 .html 文件将替换当前内容；不选择则保留现有 HTML。'
              : '上传后会在数据看板中直接展示该 HTML 内容。'
          }}
        </div>
      </div>
      <div v-else class="field">
        <div class="labelRow">
          <span class="label">看板链接</span>
          <span class="required">*</span>
        </div>
        <el-input
          v-model="sourceUrl"
          clearable
          placeholder="https://example.com/dashboard"
        />
        <div class="hint">请输入可公开访问或当前系统有权限访问的完整地址。</div>
      </div>
    </div>
    <div slot="footer" class="modalFooter">
      <el-button @click="$emit('update:visible', false)">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="submit">
        {{ isEdit ? '保存' : '创建' }}
      </el-button>
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

function isHtmlFile(file) {
  return (
    !!file &&
    (file.type === 'text/html' || /\.html?$/i.test(file.name || ''))
  )
}

export default {
  name: 'DashboardFormDialog',
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
      dragging: false,
      submitting: false
    }
  },
  computed: {
    isEdit() {
      return !!this.dashboard
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
    pickFile() {
      this.$refs.fileInput.click()
    },
    onFileInput(event) {
      const picked = event.target.files && event.target.files[0]
      event.target.value = ''
      this.acceptFile(picked)
    },
    onDrop(event) {
      this.dragging = false
      this.acceptFile(event.dataTransfer.files && event.dataTransfer.files[0])
    },
    acceptFile(picked) {
      if (!picked) return
      if (!isHtmlFile(picked)) {
        if (this.$message) this.$message.warning('请选择 HTML 文件')
        return
      }
      this.file = picked
    },
    async submit() {
      const title = this.title.trim()
      if (!title) {
        if (this.$message) this.$message.warning('请填写看板名称')
        return
      }
      let payload = null
      if (this.sourceType === 'url') {
        const sourceUrl = this.sourceUrl.trim()
        if (!/^https?:\/\//i.test(sourceUrl)) {
          if (this.$message) {
            this.$message.warning('请填写以 http(s):// 开头的看板链接')
          }
          return
        }
        payload = { title, level: this.level, sourceUrl }
      } else if (this.file) {
        payload = {
          title,
          level: this.level,
          fileName: this.file.name,
          contentBase64: await readAsBase64(this.file)
        }
      } else if (this.isEdit && this.dashboard.sourceType === 'html') {
        payload = { title, level: this.level }
      } else {
        if (this.$message) this.$message.warning('请上传数据看板 HTML 文件')
        return
      }
      this.submitting = true
      try {
        if (this.isEdit) {
          await brandDashboardService.updateDashboard(this.dashboard.id, payload)
          if (this.$message) this.$message.success(`已更新看板「${title}」`)
        } else {
          await brandDashboardService.createDashboard(payload)
          if (this.$message) this.$message.success(`已创建看板「${title}」`)
        }
        this.$emit('update:visible', false)
        this.$emit('done')
      } catch (error) {
        if (this.$message) {
          this.$message.error(userMessageFromError(error) || '操作失败')
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
      this.dragging = false
      this.submitting = false
    }
  }
}
</script>

<style lang="less" scoped>
::v-deep .dashboardModal {
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 48px);
  margin-top: 8vh !important;
  border: 1px solid rgba(255, 255, 255, .75);
  border-radius: 18px;
  overflow: hidden;
  box-shadow: 0 24px 70px rgba(17, 24, 39, .2);
  .el-dialog__header { padding: 26px 30px 18px; background: rgba(255, 255, 255, .96); }
  .el-dialog__headerbtn { top: 26px; right: 26px; width: 36px; height: 36px; border-radius: 9px;
    &:hover, &:focus { background: #f3f4f6; }
    .el-dialog__close { color: #8b95a5; font-size: 19px; }
  }
  .el-dialog__body { padding: 6px 30px 10px; overflow: auto; }
  .el-dialog__footer { padding: 20px 30px 26px; border-top: 1px solid #f1f3f5; background: linear-gradient(to top, rgba(255, 255, 255, 1) 74%, rgba(255, 255, 255, .92)); }
  .el-input__inner { height: 46px; line-height: 46px; border: 1px solid #d7dde7; border-radius: 10px; font-size: 14px; color: #1f2937;
    &::placeholder { color: #b4bcc8; }
    &:hover { border-color: #b8c3d1; }
    &:focus { border-color: #4096ff; box-shadow: 0 0 0 3px rgba(64, 150, 255, .12); }
  }
  .el-input__icon { line-height: 46px; }
  .el-button { min-width: 92px; height: 42px; padding: 0 20px; border: 1px solid #d7dde7; border-radius: 9px; background: #fff; color: #4b5563; font-size: 14px; font-weight: 600;
    &:hover { border-color: #b8c3d1; background: #f9fafb; }
  }
  .el-button--primary { border-color: #4096ff; background: #4096ff; color: #fff; box-shadow: 0 6px 14px rgba(64, 150, 255, .2);
    &:hover, &:focus { border-color: #1677ff; background: #1677ff; box-shadow: 0 8px 18px rgba(22, 119, 255, .24); }
  }
}
.modalTitleWrap { display: flex; align-items: center; gap: 12px; }
.titleIcon { width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; background: #eaf3ff; color: #4096ff; flex: 0 0 auto; }
.modalTitle { margin: 0; font-size: 22px; line-height: 1.25; font-weight: 650; letter-spacing: .2px; color: #1f2937; }
.modalSubtitle { margin: 4px 0 0; font-size: 13px; color: #9ca3af; }
.field { margin-bottom: 24px; }
.labelRow { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; }
.label { font-size: 14px; font-weight: 600; color: #374151; }
.required { color: #ff4d4f; font-size: 12px; }
.sourceTabs { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 4px; background: #f4f6f8; border-radius: 12px; }
.sourceTab { height: 42px; display: flex; align-items: center; justify-content: center; gap: 8px; border: 0; border-radius: 9px; background: transparent; font-size: 14px; color: #667085; cursor: pointer; transition: .18s ease; user-select: none;
  svg { flex: 0 0 auto; display: block; }
  &:hover { color: #4b5563; }
  &.is-on { background: #fff; color: #1677ff; box-shadow: 0 1px 6px rgba(24, 39, 75, .08); font-weight: 600; }
}
.uploadBox { min-height: 190px; border: 1.5px dashed #cfd6df; border-radius: 14px; display: flex; align-items: center; justify-content: center; padding: 26px; text-align: center; background: #fbfcfe; cursor: pointer; transition: .2s ease;
  &:hover, &.is-drag { border-color: #4096ff; background: #f7fbff; box-shadow: inset 0 0 0 1px rgba(64, 150, 255, .04); }
}
.uploadContent { display: flex; flex-direction: column; align-items: center; gap: 12px; }
.uploadIcon { width: 58px; height: 58px; border-radius: 16px; display: grid; place-items: center; background: #eaf3ff; color: #4096ff; }
.uploadTitle { font-size: 15px; color: #4b5563;
  .link { color: #1677ff; font-weight: 600; }
}
.uploadDesc { font-size: 12px; color: #9ca3af; line-height: 1.6; }
.fileName { margin-top: 4px; display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-radius: 8px; background: #eef6ff; color: #2563eb; font-size: 13px; max-width: 100%;
  svg { flex: 0 0 auto; }
  span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
}
.hint { margin-top: 10px; font-size: 12px; color: #8b95a5; line-height: 1.6; }
.modalFooter { display: flex; justify-content: flex-end; gap: 12px; }
</style>
