<template>
  <el-dialog title="分享此节点" :visible.sync="visible" width="540px" append-to-body>
    <p class="nodeShareHint">接收人将看到整张思维导图，打开时自动定位到 <span class="nodeShareTarget" :title="title">{{ title }}</span>。</p>
    <el-form label-width="88px" size="small">
      <el-form-item label="权限">
        <el-radio-group v-model="role">
          <el-radio label="viewer">可查看</el-radio>
          <el-radio label="editor">可编辑</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="接收账号">
        <div class="nodeShareRecipientPicker">
          <div class="nodeShareRecipientBox">
            <div v-if="selectedRecipients.length" class="nodeShareRecipients">
              <div v-for="user in selectedRecipients" :key="user.id" class="nodeShareRecipientItem" :title="`${user.name || user.id} · ${user.id}`">
                <span class="nodeShareRecipientAvatar" aria-hidden="true">{{ (user.name || user.id).slice(0, 1) }}</span>
                <span class="nodeShareRecipientName">{{ user.name || user.id }}</span>
                <button type="button" class="nodeShareRecipientRemove" :aria-label="`移除 ${user.name || user.id}`" @click="removeRecipient(user.id)">×</button>
              </div>
            </div>
            <div class="nodeShareRecipientInput">
              <i class="el-icon-search" aria-hidden="true"></i>
              <input v-model.trim="recipientQuery" type="text" aria-label="搜索接收账号" placeholder="搜索姓名或输入用户 ID"
                @input="searchRecipient" @keydown.enter.prevent="addRecipientFromInput" />
              <button v-if="recipientQuery" type="button" @click="addRecipientFromInput">添加 ID</button>
            </div>
          </div>
          <div v-if="userHits.length" class="nodeShareHits">
            <button v-for="user in userHits" :key="user.user_id" type="button" @click="selectRecipient(user)">
              <span class="nodeShareRecipientAvatar" aria-hidden="true">{{ (user.name || user.user_id).slice(0, 1) }}</span>
              <span class="nodeShareRecipientText"><strong>{{ user.name || user.user_id }}</strong><small>{{ user.user_id }}</small></span>
            </button>
          </div>
        </div>
        <p class="nodeShareRecipientHint">支持添加多人。权限作用于整张脑图；可编辑分享须指定接收账号，查看分享留空则登录用户均可访问。</p>
      </el-form-item>
      <el-form-item label="有效期">
        <div class="nodeShareExpiryOptions" role="group" aria-label="分享链接有效期">
          <button
            v-for="option in expiryOptions"
            :key="option.value"
            type="button"
            class="nodeShareExpiryOption"
            :class="{ isSelected: expiryOption === option.value }"
            :aria-pressed="expiryOption === option.value"
            @click="selectExpiryOption(option.value)"
          >{{ option.label }}</button>
        </div>
        <div v-if="expiryOption === 'custom'" class="nodeShareExpiryPicker">
          <el-popover v-model="calendarOpen" placement="bottom-start" width="286" trigger="click" popper-class="nodeShareExpiryPopover">
            <div class="nodeShareCustomExpiry">
              <div class="nodeShareCalendarHeader">
                <strong>{{ calendarTitle }}</strong>
                <div>
                  <button type="button" aria-label="上个月" :disabled="!canPrevMonth" @click="changeCalendarMonth(-1)">‹</button>
                  <button type="button" aria-label="下个月" @click="changeCalendarMonth(1)">›</button>
                </div>
              </div>
              <div class="nodeShareCalendarGrid" role="group" aria-label="选择到期日期">
                <span v-for="weekday in weekdays" :key="weekday" class="nodeShareWeekday">{{ weekday }}</span>
                <template v-for="day in calendarDays">
                  <span v-if="!day.date" :key="day.key" aria-hidden="true"></span>
                  <button v-else :key="day.key" type="button" class="nodeShareCalendarDay"
                    :class="{ isSelected: day.date === customDate, isToday: day.isToday }"
                    :disabled="day.isPast" :aria-label="day.date" :aria-pressed="day.date === customDate"
                    @click="selectCalendarDay(day.date)">{{ day.day }}</button>
                </template>
              </div>
              <div class="nodeShareCalendarFooter">
                <span>到期时间</span>
                <div class="nodeShareTimeControls">
                  <label class="nodeShareSrOnly" for="nodeShareExpiryHour">小时</label>
                  <select id="nodeShareExpiryHour" v-model="customHour" @change="expiryError = ''">
                    <option v-for="hour in hours" :key="hour" :value="hour">{{ hour }}</option>
                  </select>
                  <span>:</span>
                  <label class="nodeShareSrOnly" for="nodeShareExpiryMinute">分钟</label>
                  <select id="nodeShareExpiryMinute" v-model="customMinute" @change="expiryError = ''">
                    <option v-for="minute in minutes" :key="minute" :value="minute">{{ minute }}</option>
                  </select>
                </div>
              </div>
              <button type="button" class="nodeShareCalendarDone" @click="calendarOpen = false">完成</button>
            </div>
            <button slot="reference" type="button" class="nodeShareExpiryTrigger" :aria-expanded="calendarOpen">
              <span>{{ customDate }} {{ customHour }}:{{ customMinute }}</span>
              <span class="nodeShareExpiryChevron" aria-hidden="true">⌄</span>
            </button>
          </el-popover>
        </div>
        <p v-if="expiryError" class="nodeShareExpiryError" role="alert">{{ expiryError }}</p>
        <p id="nodeShareExpiryHint" class="nodeShareExpiryHint">{{ expiryHint }}</p>
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="busy" @click="create">创建分享并复制链接</el-button>
      </el-form-item>
    </el-form>
    <div v-if="createdLink" class="nodeShareLink">
      <el-input :value="createdLink" readonly size="small" />
      <el-button size="small" @click="copy(createdLink)">复制</el-button>
    </div>
    <div class="nodeShareExisting">
      <strong>已有分享</strong>
      <span v-if="!shares.length" class="nodeShareMuted">暂无</span>
      <div v-for="item in shares" :key="item.id" class="nodeShareRow">
        <span>{{ recipientLabel(item) }} · {{ item.role === 'editor' ? '可编辑' : '可查看' }}</span>
        <span v-if="item.revokedAt" class="nodeShareMuted">已撤销</span>
        <span v-else>
          <el-button type="text" @click="rotate(item)">重新生成链接</el-button>
          <el-button type="text" @click="changeRole(item)">改为{{ item.role === 'editor' ? '查看' : '编辑' }}</el-button>
          <el-button type="text" class="nodeShareDanger" @click="revoke(item)">撤销</el-button>
        </span>
      </div>
    </div>
  </el-dialog>
</template>

<script>
import nodeShareService from '@/services/nodeShareService'
import { searchUsers } from '@/utils/fileApi'

function localParts(date) {
  const pad = value => String(value).padStart(2, '0')
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`
  }
}

function parseCustomExpiry(dateText, timeText) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText)
  const timeMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(timeText)
  if (!dateMatch || !timeMatch) return null
  const year = Number(dateMatch[1])
  const month = Number(dateMatch[2])
  const day = Number(dateMatch[3])
  const hour = Number(timeMatch[1])
  const minute = Number(timeMatch[2])
  const value = new Date(year, month - 1, day, hour, minute)
  if (value.getFullYear() !== year || value.getMonth() !== month - 1 || value.getDate() !== day ||
      value.getHours() !== hour || value.getMinutes() !== minute) return null
  return value
}

function shareLink(id, token) {
  const url = new URL(window.location.href)
  const runtime = window.__MIND_MAP_RUNTIME__ || {}
  const loopback = ['localhost', '127.0.0.1', '::1']
  if (loopback.includes(url.hostname) && runtime.host && !loopback.includes(runtime.host)) {
    url.hostname = runtime.host
    if (runtime.webPort) url.port = String(runtime.webPort)
  }
  url.pathname = `/node-share/${encodeURIComponent(id)}`
  url.search = `?token=${encodeURIComponent(token)}`
  url.hash = ''
  return url.toString()
}

export default {
  name: 'NodeShareDialog',
  data() {
    return {
      visible: false,
      roomKey: '',
      rootUid: '',
      title: '',
      role: 'viewer',
      recipientQuery: '',
      selectedRecipients: [],
      expiryOption: 'never',
      customDate: '',
      customHour: '12',
      customMinute: '00',
      calendarOpen: false,
      calendarMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
      weekdays: ['日', '一', '二', '三', '四', '五', '六'],
      hours: Array.from({ length: 24 }, (_, index) => String(index).padStart(2, '0')),
      minutes: Array.from({ length: 60 }, (_, index) => String(index).padStart(2, '0')),
      expiryError: '',
      expiryOptions: [
        { value: 'never', label: '不限期' },
        { value: '1d', label: '1 天' },
        { value: '7d', label: '7 天' },
        { value: '30d', label: '30 天' },
        { value: 'custom', label: '自定义' }
      ],
      busy: false,
      shares: [],
      userHits: [],
      searchTimer: null,
      createdLink: ''
    }
  },
  computed: {
    calendarTitle() {
      return `${this.calendarMonth.getFullYear()} 年 ${this.calendarMonth.getMonth() + 1} 月`
    },
    canPrevMonth() {
      const now = new Date()
      return this.calendarMonth.getFullYear() > now.getFullYear() ||
        (this.calendarMonth.getFullYear() === now.getFullYear() && this.calendarMonth.getMonth() > now.getMonth())
    },
    calendarDays() {
      const year = this.calendarMonth.getFullYear()
      const month = this.calendarMonth.getMonth()
      const offset = new Date(year, month, 1).getDay()
      const count = new Date(year, month + 1, 0).getDate()
      const today = localParts(new Date()).date
      const cells = Array.from({ length: offset }, (_, index) => ({ key: `empty-${index}`, date: '' }))
      for (let day = 1; day <= count; day += 1) {
        const date = localParts(new Date(year, month, day)).date
        cells.push({ key: date, date, day, isToday: date === today, isPast: date < today })
      }
      return cells
    },
    expiryHint() {
      if (this.expiryOption === 'never') return '链接长期有效，创建后仍可随时撤销。'
      if (this.expiryOption === 'custom') return '使用本地时间；到期后链接自动失效。'
      return '从创建时开始计算，到期后链接自动失效。'
    }
  },
  created() { this.$bus.$on('showNodeShare', this.open) },
  beforeDestroy() { this.$bus.$off('showNodeShare', this.open); clearTimeout(this.searchTimer) },
  methods: {
    changeCalendarMonth(delta) {
      if (delta < 0 && !this.canPrevMonth) return
      this.calendarMonth = new Date(this.calendarMonth.getFullYear(), this.calendarMonth.getMonth() + delta, 1)
    },
    selectCalendarDay(date) {
      this.customDate = date
      this.expiryError = ''
    },
    selectExpiryOption(option) {
      this.expiryOption = option
      this.expiryError = ''
      this.calendarOpen = false
      if (option === 'custom' && !this.customDate) {
        const initial = localParts(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000))
        this.customDate = initial.date
        this.customHour = initial.time.slice(0, 2)
        this.customMinute = initial.time.slice(3, 5)
        const chosen = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        this.calendarMonth = new Date(chosen.getFullYear(), chosen.getMonth(), 1)
      }
    },
    async open(node) {
      const roomKey = String(this.$route.query.room || '')
      const rootUid = node && node.getData && node.getData('uid')
      if (!roomKey || !rootUid) return this.$message.warning('请先打开已保存的脑图')
      this.roomKey = roomKey
      this.rootUid = String(rootUid)
      this.title = String(node.getData('text') || '未命名节点').replace(/<[^>]+>/g, '').slice(0, 70)
      this.createdLink = ''
      this.recipientQuery = ''
      this.selectedRecipients = []
      this.userHits = []
      this.expiryOption = 'never'
      this.customDate = ''
      this.customHour = '12'
      this.customMinute = '00'
      this.calendarOpen = false
      this.calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
      this.expiryError = ''
      this.visible = true
      await this.load()
    },
    async load() {
      try { this.shares = await nodeShareService.list(this.roomKey, this.rootUid) }
      catch (err) { this.$message.error(err.message || '无法加载分享列表') }
    },
    searchRecipient() {
      clearTimeout(this.searchTimer)
      const q = this.recipientQuery
      if (!q) { this.userHits = []; return }
      this.searchTimer = setTimeout(async () => {
        try {
          const result = await searchUsers(q, 6)
          if (this.recipientQuery === q) {
            const chosen = new Set(this.selectedRecipients.map(user => user.id))
            this.userHits = (result.list || []).filter(user => !chosen.has(user.user_id))
          }
        } catch (err) { this.userHits = [] }
      }, 250)
    },
    selectRecipient(user) {
      const id = String(user.user_id || '').trim()
      if (id && !this.selectedRecipients.some(item => item.id === id)) {
        if (this.selectedRecipients.length >= 50) {
          this.$message.warning('最多添加 50 个接收账号')
          return false
        }
        this.selectedRecipients.push({ id, name: String(user.name || id) })
      }
      this.recipientQuery = ''
      this.userHits = []
      return true
    },
    addRecipientFromInput() {
      const input = this.recipientQuery.trim()
      if (!input) return true
      const exact = this.userHits.find(user => user.user_id === input)
      if (exact) return this.selectRecipient(exact)
      if (/\s/.test(input) || input.length > 160) {
        this.$message.warning('请选择搜索结果，或输入完整的用户 ID')
        return false
      }
      return this.selectRecipient({ user_id: input, name: input })
    },
    removeRecipient(id) {
      this.selectedRecipients = this.selectedRecipients.filter(user => user.id !== id)
    },
    recipientLabel(item) {
      const ids = item.recipientUserIds || (item.recipientUserId ? [item.recipientUserId] : [])
      return ids.length ? `${ids.slice(0, 2).join('、')}${ids.length > 2 ? ` 等 ${ids.length} 人` : ''}` : '持链接的登录用户'
    },
    async copy(value) {
      try {
        await navigator.clipboard.writeText(value)
        this.$message.success('链接已复制')
      } catch (err) { this.$message.warning('请手动复制链接') }
    },
    async create() {
      if (this.recipientQuery) return this.$message.warning('请先选择搜索结果，或点击“添加”接收账号')
      if (this.role === 'editor' && !this.selectedRecipients.length) return this.$message.warning('编辑分享必须指定接收账号')
      let expiresAt = null
      if (this.expiryOption === 'custom') {
        expiresAt = parseCustomExpiry(this.customDate, `${this.customHour}:${this.customMinute}`)
        if (!expiresAt || expiresAt <= new Date()) {
          this.expiryError = '请选择晚于当前时间的到期日期和时间'
          return
        }
      } else if (this.expiryOption !== 'never') {
        const days = { '1d': 1, '7d': 7, '30d': 30 }[this.expiryOption]
        expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
      }
      this.busy = true
      try {
        const share = await nodeShareService.create({
          roomKey: this.roomKey,
          rootUid: this.rootUid,
          role: this.role,
          recipientUserIds: this.selectedRecipients.map(user => user.id),
          expiresAt: expiresAt ? expiresAt.toISOString() : null
        })
        this.createdLink = shareLink(share.id, share.token)
        await this.copy(this.createdLink)
        await this.load()
      } catch (err) { this.$message.error(err.message || '创建分享失败') }
      finally { this.busy = false }
    },
    async changeRole(item) {
      const role = item.role === 'editor' ? 'viewer' : 'editor'
      const recipients = item.recipientUserIds || (item.recipientUserId ? [item.recipientUserId] : [])
      if (role === 'editor' && !recipients.length) return this.$message.warning('请先撤销此链接，再为指定账号创建编辑分享')
      try {
        await nodeShareService.update(item.id, { role })
        await this.load()
      } catch (err) { this.$message.error(err.message || '修改权限失败') }
    },
    async rotate(item) {
      try {
        const share = await nodeShareService.rotate(item.id)
        this.createdLink = shareLink(share.id, share.token)
        await this.copy(this.createdLink)
        this.$message.info('旧链接已失效，请发送新链接')
      } catch (err) { this.$message.error(err.message || '生成链接失败') }
    },
    async revoke(item) {
      try {
        await nodeShareService.revoke(item.id)
        await this.load()
      } catch (err) { this.$message.error(err.message || '撤销分享失败') }
    }
  }
}
</script>

<style scoped>
.nodeShareHint { color: #637083; line-height: 1.5; margin: 0 0 18px; }
.nodeShareTarget { display: inline; padding: 2px 6px; border-radius: 5px; background: #ecf5ff; color: #2176d7; font-weight: 600; overflow-wrap: anywhere; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
.nodeShareLink { display: flex; gap: 8px; margin: 10px 0 18px; }
.nodeShareExisting { border-top: 1px solid #e7eaf0; padding-top: 15px; }
.nodeShareRow { display: flex; align-items: center; justify-content: space-between; min-height: 40px; border-bottom: 1px solid #f1f2f4; }
.nodeShareMuted { color: #909399; margin-left: 10px; }
.nodeShareDanger { color: #f56c6c; }
.nodeShareRecipientPicker { position: relative; }
.nodeShareRecipientBox { overflow: hidden; border: 1px solid #dce4ee; border-radius: 8px; background: #fff; transition: border-color .18s, box-shadow .18s; }
.nodeShareRecipientBox:focus-within { border-color: #409eff; box-shadow: 0 0 0 2px #e7f2ff; }
.nodeShareRecipients { display: flex; flex-wrap: wrap; gap: 6px; max-height: 92px; padding: 8px 9px; overflow-y: auto; }
.nodeShareRecipientItem { display: inline-flex; align-items: center; gap: 5px; box-sizing: border-box; max-width: 100%; min-height: 30px; padding: 3px 5px 3px 4px; border: 1px solid #d5e8ff; border-radius: 999px; background: #f0f7ff; color: #285b91; }
.nodeShareRecipientAvatar { display: inline-flex; flex: 0 0 20px; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 50%; background: #d9ebff; color: #317bd0; font-size: 11px; font-weight: 600; }
.nodeShareRecipientName { overflow: hidden; max-width: 120px; color: #285b91; font-size: 12px; font-weight: 500; line-height: 20px; text-overflow: ellipsis; white-space: nowrap; }
.nodeShareRecipientText { display: flex; flex: 1; flex-direction: column; justify-content: center; min-width: 0; line-height: 1.35; }
.nodeShareRecipientText strong, .nodeShareRecipientText small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nodeShareRecipientText strong { color: #34445a; font-size: 13px; font-weight: 500; }
.nodeShareRecipientText small { color: #8a98a9; font-size: 11px; }
.nodeShareRecipientRemove { flex: 0 0 20px; width: 20px; height: 20px; border: 0; border-radius: 50%; background: transparent; color: #738ba5; font-size: 16px; line-height: 18px; cursor: pointer; }
.nodeShareRecipientRemove:hover { background: #dcecff; color: #245f9e; }
.nodeShareRecipientRemove:focus-visible { outline: 2px solid #409eff; outline-offset: 2px; }
.nodeShareRecipientInput { display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 10px; }
.nodeShareRecipients + .nodeShareRecipientInput { border-top: 1px solid #edf1f6; }
.nodeShareRecipientInput i { color: #9ba9b9; font-size: 14px; }
.nodeShareRecipientInput input { flex: 1; min-width: 0; height: 100%; padding: 0; border: 0; outline: 0; background: transparent; color: #34445a; font: inherit; font-size: 13px; }
.nodeShareRecipientInput input::placeholder { color: #a3afbd; }
.nodeShareRecipientInput button { flex: 0 0 auto; padding: 3px 5px; border: 0; background: transparent; color: #2f80dc; font: inherit; font-size: 12px; cursor: pointer; }
.nodeShareRecipientInput button:hover { color: #1666c2; }
.nodeShareHits { position: absolute; z-index: 20; top: calc(100% + 5px); right: 0; left: 0; max-height: 220px; overflow-y: auto; border: 1px solid #e2e8f1; border-radius: 8px; background: #fff; box-shadow: 0 10px 24px #23456a24; }
.nodeShareHits button { display: flex; align-items: center; gap: 9px; box-sizing: border-box; width: 100%; min-height: 42px; padding: 5px 11px; border: 0; background: #fff; text-align: left; cursor: pointer; }
.nodeShareHits button:hover, .nodeShareHits button:focus-visible { background: #f3f8ff; outline: 0; }
.nodeShareRecipientHint { margin: 6px 0 0; color: #8190a2; font-size: 12px; line-height: 1.5; }
.nodeShareExpiryOptions { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 1px; }
.nodeShareExpiryOption { min-height: 34px; padding: 0 13px; border: 1px solid #dcdfe6; border-radius: 7px; background: #fff; color: #536174; font: inherit; line-height: 32px; cursor: pointer; transition: border-color .18s, background-color .18s, color .18s; }
.nodeShareExpiryOption:hover { border-color: #8cbdff; color: #2f80e7; }
.nodeShareExpiryOption:focus-visible { outline: 2px solid #409eff; outline-offset: 2px; }
.nodeShareExpiryOption.isSelected { border-color: #409eff; background: #ecf5ff; color: #2176d7; font-weight: 600; }
.nodeShareExpiryPicker { margin-top: 10px; }
.nodeShareExpiryTrigger { display: flex; align-items: center; justify-content: space-between; box-sizing: border-box; width: 100%; height: 36px; padding: 0 12px; border: 1px solid #d6e0ed; border-radius: 7px; background: #fff; color: #34445a; font: inherit; text-align: left; font-variant-numeric: tabular-nums; cursor: pointer; }
.nodeShareExpiryTrigger:hover, .nodeShareExpiryTrigger[aria-expanded="true"] { border-color: #409eff; }
.nodeShareExpiryTrigger:focus-visible { outline: 2px solid #409eff; outline-offset: 2px; }
.nodeShareExpiryChevron { color: #73849b; font-size: 19px; line-height: 1; }
.nodeShareCustomExpiry { color: #34445a; }
.nodeShareCalendarHeader { display: flex; align-items: center; justify-content: space-between; height: 30px; margin-bottom: 4px; }
.nodeShareCalendarHeader strong { color: #26364c; font-size: 14px; font-weight: 600; }
.nodeShareCalendarHeader div { display: flex; gap: 5px; }
.nodeShareCalendarHeader button { width: 27px; height: 27px; border: 0; border-radius: 6px; background: transparent; color: #586b83; font-size: 21px; line-height: 24px; cursor: pointer; }
.nodeShareCalendarHeader button:hover:not(:disabled) { background: #e9f3ff; color: #287fe2; }
.nodeShareCalendarHeader button:disabled { color: #bcc6d2; cursor: default; }
.nodeShareCalendarGrid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 1px; text-align: center; }
.nodeShareWeekday { height: 23px; color: #8290a2; font-size: 11px; line-height: 23px; }
.nodeShareCalendarDay { height: 28px; border: 0; border-radius: 6px; background: transparent; color: #34445a; font: inherit; font-size: 12px; cursor: pointer; }
.nodeShareCalendarDay:hover:not(:disabled) { background: #e8f3ff; color: #287fe2; }
.nodeShareCalendarDay.isToday:not(.isSelected) { box-shadow: inset 0 0 0 1px #9ac7ff; }
.nodeShareCalendarDay.isSelected { background: #409eff; color: #fff; font-weight: 600; }
.nodeShareCalendarDay:disabled { color: #bdc7d3; cursor: default; }
.nodeShareCalendarDay:focus-visible, .nodeShareCalendarHeader button:focus-visible { outline: 2px solid #409eff; outline-offset: 2px; }
.nodeShareCalendarFooter { display: flex; align-items: center; justify-content: space-between; margin-top: 7px; padding-top: 8px; border-top: 1px solid #e9eef5; color: #53647a; font-size: 12px; }
.nodeShareTimeControls { display: flex; align-items: center; gap: 5px; color: #53647a; font-weight: 600; }
.nodeShareTimeControls select { height: 28px; padding: 0 4px; border: 1px solid #d6e0ed; border-radius: 6px; background: #fff; color: #26364c; font: inherit; font-variant-numeric: tabular-nums; cursor: pointer; }
.nodeShareTimeControls select:focus-visible { outline: 2px solid #409eff; outline-offset: 1px; }
.nodeShareCalendarDone { display: block; margin: 8px 0 0 auto; padding: 3px 8px; border: 0; border-radius: 5px; background: #ecf5ff; color: #287fe2; font: inherit; font-size: 12px; cursor: pointer; }
.nodeShareCalendarDone:hover { background: #dbeeff; }
.nodeShareSrOnly { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
.nodeShareExpiryError { margin: 6px 0 0; color: #e45454; font-size: 12px; line-height: 1.5; }
.nodeShareExpiryHint { margin: 5px 0 0; color: #7b8798; font-size: 12px; line-height: 1.5; }
</style>
