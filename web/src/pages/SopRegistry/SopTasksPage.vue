<template>
  <div class="sopTasksPage">
    <SopTaskBoard
      :jobs="allJobs"
      :selected-id="selectedId"
      title="多任务管理"
      @select="selectedId = $event"
      @cancel="cancelJob"
      @cancel-all="cancelAll"
      @resume="resumeJob"
      @fill-data="onFillData"
    />
  </div>
</template>

<script>
import SopTaskBoard from './components/SopTaskBoard.vue'
import { getSharedSopRunQueue } from '@/utils/sopRunQueue'

export default {
  name: 'SopTasksPage',
  components: { SopTaskBoard },
  data() {
    return {
      queue: null,
      snap: { pending: [], running: [], waiting: [], recent: [] },
      selectedId: '',
      unsub: null
    }
  },
  computed: {
    allJobs() {
      const s = this.snap || {}
      const list = []
        .concat(s.running || [])
        .concat(s.waiting || [])
        .concat(s.pending || [])
        .concat(s.recent || [])
      const seen = new Set()
      return list.filter(j => {
        if (!j || !j.id || seen.has(j.id)) return false
        seen.add(j.id)
        return true
      })
    }
  },
  watch: {
    allJobs: {
      immediate: true,
      handler(list) {
        if (!list.length) {
          this.selectedId = ''
          return
        }
        if (!list.some(j => j.id === this.selectedId)) {
          this.selectedId = list[0].id
        }
      }
    }
  },
  mounted() {
    this.queue = getSharedSopRunQueue()
    this.snap = this.queue.getSnapshot()
    this.unsub = this.queue.subscribe(snap => {
      this.snap = snap
    })
  },
  beforeDestroy() {
    if (this.unsub) this.unsub()
  },
  methods: {
    cancelJob(id) {
      if (this.queue) this.queue.cancel(id)
    },
    cancelAll() {
      if (this.queue) this.queue.cancelAll()
    },
    resumeJob(id) {
      if (this.queue) this.queue.resumeWaiting(id)
    },
    onFillData(id) {
      this.$message.info('请到 SOP 台账该任务详情中补数')
      this.$router.push({ path: '/sop', query: { job: id } })
    }
  }
}
</script>

<style lang="less" scoped>
.sopTasksPage {
  height: calc(100vh - 56px);
  min-height: 480px;
  padding: 12px 16px 16px;
  box-sizing: border-box;
  background: #f5f5f5;
}
</style>
