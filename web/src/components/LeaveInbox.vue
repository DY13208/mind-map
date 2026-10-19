<template>
  <section class="leaveInbox" aria-label="业务审批">
    <div class="leaveInboxHeader">
      <div>
        <h3>业务审批</h3>
        <p>按流程办理，保留每轮审核依据</p>
      </div>
      <el-button
        size="small"
        icon="el-icon-refresh"
        :loading="loading"
        @click="load"
        >刷新</el-button
      >
    </div>
    <el-radio-group v-model="scope" size="small" @change="change"
      ><el-radio-button label="todo">待我审批</el-radio-button
      ><el-radio-button label="mine">我发起的</el-radio-button
      ><el-radio-button label="history">我已审批</el-radio-button
      ><el-radio-button label="cc">抄送我的</el-radio-button></el-radio-group
    >
    <p v-if="error" class="leaveInboxError" role="alert">{{ error }}</p>
    <div v-loading="loading" class="leaveInboxItems">
      <article v-for="item in items" :key="item.id" class="leaveInboxItem">
        <span class="leaveInboxGlyph"><i class="el-icon-date"/></span>
        <div>
          <strong>{{ item.requester_name }}的请假申请</strong>
          <p>
            第{{ item.round }}轮 · {{ status(item.status)
            }}<span v-if="item.status === 'pending'">
              · {{ item.steps[item.current_step].role }}</span
            >
          </p>
          <small>{{ time(item.updated_at) }}</small>
        </div>
        <el-button size="small" @click="open(item.id)">{{
          scope === 'todo' ? '前往审核' : '查看记录'
        }}</el-button>
      </article>
      <div v-if="!loading && !items.length" class="leaveInboxEmpty">
        暂无此类申请
      </div>
    </div>
    <el-pagination
      v-if="total > 20"
      :current-page="page"
      :total="total"
      :page-size="20"
      layout="prev, pager, next"
      @current-change="turn"
    />
    <div v-if="notices.length" class="leaveResultNotices">
      <strong>最近通知</strong
      ><button
        v-for="notice in notices"
        :key="notice.id"
        @click="open(notice.request_id)"
      >
        {{ noticeText(notice.kind) }}
        <small>{{ time(notice.created_at) }}</small
        ><i class="el-icon-arrow-right" />
      </button>
    </div>
  </section>
</template>
<script>
import service, { openLeaveRequest } from '@/services/leaveService'
export default {
  name: 'LeaveInbox',
  data: () => ({
    scope: 'todo',
    items: [],
    notices: [],
    page: 1,
    total: 0,
    loading: false,
    error: '',
    sequence: 0
  }),
  mounted() {
    this.load()
    window.addEventListener('mindmap:leave-changed', this.load)
    window.addEventListener('mindmap:leave-refresh', this.load)
  },
  beforeDestroy() {
    this.sequence++
    window.removeEventListener('mindmap:leave-changed', this.load)
    window.removeEventListener('mindmap:leave-refresh', this.load)
  },
  methods: {
    status(s) {
      return (
        {
          draft: '待填写',
          pending: '审批中',
          returned: '退回修改',
          approved: '已通过',
          rejected: '未通过',
          withdrawn: '已撤回'
        }[s] || s
      )
    },
    noticeText(s) {
      return (
        {
          todo: '有请假待办需要你审核',
          approved: '请假申请已通过',
          returned: '请假申请被退回补充',
          rejected: '请假申请未通过',
          withdrawn: '请假申请已撤回'
        }[s] || s
      )
    },
    time(s) {
      return new Date(s).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    },
    async load() {
      const seq = ++this.sequence
      this.loading = true
      try {
        const [data, messages] = await Promise.all([
          service.list({ scope: this.scope, offset: (this.page - 1) * 20 }),
          service.notices()
        ])
        if (seq !== this.sequence) return
        this.items = data.list
        this.total = data.total
        this.notices = messages.list
        this.error = ''
        await service.seen(messages.list.map(n => n.id))
        window.dispatchEvent(new CustomEvent('mindmap:leave-seen'))
      } catch (e) {
        if (seq === this.sequence) this.error = e.message
      } finally {
        if (seq === this.sequence) this.loading = false
      }
    },
    change() {
      this.page = 1
      this.load()
    },
    turn(page) {
      this.page = page
      this.load()
    },
    open(id) {
      this.$emit('open')
      openLeaveRequest({ requestId: id })
    }
  }
}
</script>
<style lang="less" scoped>
.leaveInbox {
  padding: 22px 26px;
  overflow: auto;
  height: 100%;
  box-sizing: border-box;
}
.leaveInboxHeader {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 18px;
  h3 {
    margin: 0;
    color: #243247;
  }
  p {
    font-size: 12px;
    color: #8290a2;
    margin-bottom: 0;
  }
}
.leaveInboxItems {
  min-height: 160px;
  margin-top: 16px;
}
.leaveInboxItem {
  display: flex;
  align-items: center;
  gap: 14px;
  border: 1px solid #e8edf3;
  border-radius: 10px;
  padding: 16px;
  margin-bottom: 10px;
  > div {
    flex: 1;
  }
  strong {
    font-size: 14px;
    color: #243247;
  }
  p {
    font-size: 12px;
    color: #65758a;
    margin: 6px 0;
  }
  small {
    color: #8a97a8;
    font-size: 11px;
  }
}
.leaveInboxGlyph {
  background: #eef4ff;
  color: #4972b4;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 9px;
}
.leaveInboxError {
  color: #bd4d48;
  font-size: 13px;
}
.leaveInboxEmpty {
  text-align: center;
  padding: 48px 10px;
  color: #93a0b0;
}
.leaveResultNotices {
  margin-top: 24px;
  border-top: 1px solid #e9edf3;
  padding-top: 18px;
  font-size: 13px;
  button {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    width: 100%;
    border: 0;
    background: white;
    border-bottom: 1px solid #f0f3f6;
    text-align: left;
    padding: 14px 0;
    cursor: pointer;
    color: #42536b;
  }
  small {
    color: #8a97a8;
  }
}
@media (max-width: 600px) {
  .leaveInbox {
    padding: 16px 12px;
  }
  .leaveInboxItem {
    gap: 8px;
    padding: 12px;
  }
  .leaveInboxGlyph {
    display: none;
  }
}
</style>
